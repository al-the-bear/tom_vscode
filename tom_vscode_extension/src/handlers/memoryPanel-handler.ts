/**
 * Memory Panel — webview that exposes the quest's memory folder
 * (`_ai/quests/<quest>/memory/`) for inline editing.
 *
 * Spec: anthropic_sdk_integration.md §11.2. The panel is opened via the
 * `tomAi.panel.memory` command, which the ANTHROPIC section's Memory
 * button invokes when the webview posts `{ type: 'openAnthropicMemory' }`.
 *
 * Layout (two-pane):
 *   ├── Header              [Quest: {quest}]
 *   ├── File list (left)    the folder's files: the curated ones first, then
 *                           the candidates files (`candidates.<host>.md`),
 *                           marked as such — this host's and other hosts'
 *   ├── Content view (right) editable markdown textarea
 *   └── Toolbar             [+ New file] [Save] [Delete] [Open in editor]
 */

import * as path from 'path';
import * as vscode from 'vscode';
import { TwoTierMemoryService, MemoryScope, currentMemoryHost } from '../services/memory-service';
import { memoryPanelRows } from '../services/questMemoryFiles';
import { loadWebviewHtml } from '../utils/webviewLoader';
import { wireCompletionMessages } from '../utils/completionWiring';

let _panel: vscode.WebviewPanel | undefined;
let _context: vscode.ExtensionContext | undefined;

/** The one memory scope: the quest's. */
const QUEST: MemoryScope = 'quest';

interface WebviewMessage {
    type: string;
    [key: string]: unknown;
}

export function registerMemoryPanelCommand(context: vscode.ExtensionContext): void {
    _context = context;
    context.subscriptions.push(
        vscode.commands.registerCommand('tomAi.panel.memory', () => {
            openMemoryPanel(context);
        }),
    );
    // Restore the panel after a window reload. Singleton that reloads all memory
    // entries from the store on open, so no per-panel state is persisted — the
    // deserialize path re-binds the recreated panel (or disposes a duplicate).
    // Without the serializer the tab silently vanishes on reload.
    context.subscriptions.push(
        vscode.window.registerWebviewPanelSerializer('tomAi.memoryPanel', {
            async deserializeWebviewPanel(panel: vscode.WebviewPanel): Promise<void> {
                if (_panel) { panel.dispose(); return; }
                const ctx = _context ?? context;
                panel.webview.options = getMemoryPanelWebviewOptions(ctx);
                bindMemoryPanel(ctx, panel);
            },
        }),
    );
}

/** Open (or reveal) the memory panel on the quest's memory folder. */
export function openMemoryPanel(context: vscode.ExtensionContext): void {
    _context = context;
    if (_panel) {
        _panel.reveal();
        _sendSnapshot();
        return;
    }
    const panel = vscode.window.createWebviewPanel(
        'tomAi.memoryPanel',
        'Memory',
        vscode.ViewColumn.Active,
        {
            ...getMemoryPanelWebviewOptions(context),
            retainContextWhenHidden: true,
        },
    );
    bindMemoryPanel(context, panel);
}

/** Webview options shared by the fresh-open and reload-restore paths. */
function getMemoryPanelWebviewOptions(context: vscode.ExtensionContext): vscode.WebviewOptions {
    return {
        enableScripts: true,
        localResourceRoots: [vscode.Uri.joinPath(context.extensionUri, 'media')],
    };
}

/**
 * Wire a (freshly-created or reload-restored) Memory panel: paint the HTML,
 * install completion + message handlers, and push the memory snapshot. Both
 * `openMemoryPanel` and the reload serializer call this so the wiring lives in
 * one place. Singleton that reloads all entries on open, so no per-panel state
 * is persisted.
 */
function bindMemoryPanel(context: vscode.ExtensionContext, panel: vscode.WebviewPanel): void {
    _context = context;
    _panel = panel;
    panel.webview.html = loadWebviewHtml(panel.webview, 'memoryPanel');
    // Shared textarea completion (Ctrl+Shift+Space → /skill + @file). Registered
    // as its own listener so it coexists with the panel's message handler below.
    wireCompletionMessages(panel.webview);
    panel.webview.onDidReceiveMessage(
        (msg: WebviewMessage) => { void _handleMessage(msg); },
        undefined,
        context.subscriptions,
    );
    panel.onDidDispose(() => { _panel = undefined; });
    // Initial data push once the webview has loaded.
    setTimeout(() => _sendSnapshot(), 50);
}

async function _handleMessage(msg: WebviewMessage): Promise<void> {
    try {
        switch (msg.type) {
            case 'ready':
                _sendSnapshot();
                return;
            case 'readFile':
                _sendFile(QUEST, String(msg.file ?? ''));
                return;
            case 'saveFile':
                _saveFile(QUEST, String(msg.file ?? ''), String(msg.content ?? ''));
                return;
            case 'deleteFile':
                _deleteFile(QUEST, String(msg.file ?? ''));
                return;
            case 'newFile':
                await _newFile(QUEST);
                return;
            case 'openInEditor':
                _openInEditor(QUEST, String(msg.file ?? ''));
                return;
        }
    } catch (e) {
        _panel?.webview.postMessage({
            type: 'error',
            message: e instanceof Error ? e.message : String(e),
        });
    }
}

function _sendSnapshot(): void {
    const svc = TwoTierMemoryService.instance;
    const quest = svc.currentQuest();
    // The folder's files, curated first; a candidates file carries its host.
    const questFiles = quest ? memoryPanelRows(svc.listWithMeta('quest'), currentMemoryHost()) : [];
    _panel?.webview.postMessage({
        type: 'snapshot',
        quest,
        folder: quest ? vscode.workspace.asRelativePath(svc.scopeFolder('quest'), false) : '',
        questFiles,
    });
}

function _sendFile(scope: MemoryScope, file: string): void {
    if (!file) return;
    const content = TwoTierMemoryService.instance.read(scope, file);
    _panel?.webview.postMessage({ type: 'fileContent', scope, file, content });
}

function _saveFile(scope: MemoryScope, file: string, content: string): void {
    if (!file) return;
    TwoTierMemoryService.instance.write(scope, file, content);
    vscode.window.setStatusBarMessage(`Memory: saved ${scope}/${file}`, 2000);
    _sendSnapshot();
    _sendFile(scope, file);
}

function _deleteFile(scope: MemoryScope, file: string): void {
    if (!file) return;
    TwoTierMemoryService.instance.delete(scope, file);
    vscode.window.setStatusBarMessage(`Memory: deleted ${scope}/${file}`, 2000);
    _sendSnapshot();
}

async function _newFile(scope: MemoryScope): Promise<void> {
    const name = await vscode.window.showInputBox({
        prompt: `New memory file (${scope}): a curated file of the quest's memory folder`,
        placeHolder: 'e.g. decisions.md',
        validateInput: (v) => (v && v.trim() && !v.includes('..') ? null : 'Invalid file name'),
    });
    if (!name) return;
    const file = name.trim().endsWith('.md') ? name.trim() : `${name.trim()}.md`;
    const svc = TwoTierMemoryService.instance;
    if (svc.read(scope, file)) {
        vscode.window.showWarningMessage(`Memory file already exists: ${scope}/${file}`);
        return;
    }
    svc.write(scope, file, '');
    _sendSnapshot();
    _sendFile(scope, file);
}

function _openInEditor(scope: MemoryScope, file: string): void {
    if (!file) return;
    const abs = TwoTierMemoryService.instance.filePath(scope, file);
    void vscode.commands.executeCommand('vscode.open', vscode.Uri.file(abs));
}

// The webview HTML/JS/CSS live in media/memoryPanel/{index.html,main.js,
// style.css} and are loaded via loadWebviewHtml. All panel data flows via
// postMessage (no first-paint init payload).

// Appease strict unused-import linting when the module-level `_context`
// is only read from within closures — retained for future API hooks.
void _context;
void path;
