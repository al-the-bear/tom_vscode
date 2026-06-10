/**
 * Memory Panel — webview that exposes the two-tier memory store
 * (`_ai/memory/shared/` + `_ai/memory/{quest}/`) for inline editing.
 *
 * Spec: anthropic_sdk_integration.md §11.2. The panel is opened via the
 * `tomAi.panel.memory` command, which the ANTHROPIC section's Memory
 * button invokes when the webview posts `{ type: 'openAnthropicMemory' }`.
 *
 * Layout (two-pane):
 *   ├── Scope tabs          [Shared memory] [Quest: {quest}]
 *   ├── File list (left)    one entry per file in the selected scope
 *   ├── Content view (right) editable markdown textarea
 *   └── Toolbar             [+ New file] [Save] [Delete] [Open in editor]
 */

import * as path from 'path';
import * as vscode from 'vscode';
import { TwoTierMemoryService, MemoryScope } from '../services/memory-service';
import { loadWebviewHtml } from '../utils/webviewLoader';
import { wireCompletionMessages } from '../utils/completionWiring';

let _panel: vscode.WebviewPanel | undefined;
let _context: vscode.ExtensionContext | undefined;

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
                _sendFile(msg.scope as MemoryScope, String(msg.file ?? ''));
                return;
            case 'saveFile':
                _saveFile(msg.scope as MemoryScope, String(msg.file ?? ''), String(msg.content ?? ''));
                return;
            case 'deleteFile':
                _deleteFile(msg.scope as MemoryScope, String(msg.file ?? ''));
                return;
            case 'newFile':
                await _newFile(msg.scope as MemoryScope);
                return;
            case 'openInEditor':
                _openInEditor(msg.scope as MemoryScope, String(msg.file ?? ''));
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
    const shared = svc.listWithMeta('shared').sort((a, b) => a.file.localeCompare(b.file));
    const questFiles = quest
        ? svc.listWithMeta('quest').sort((a, b) => a.file.localeCompare(b.file))
        : [];
    _panel?.webview.postMessage({
        type: 'snapshot',
        quest,
        shared: shared.map((e) => ({ file: e.file, bytes: e.bytes })),
        questFiles: questFiles.map((e) => ({ file: e.file, bytes: e.bytes })),
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
        prompt: `New memory file (${scope})`,
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

// The webview HTML/JS/CSS now live in media/memoryPanel/{index.html,main.js,
// style.css} and are loaded via loadWebviewHtml; the former inline `_getHtml`
// template was removed in Phase B.3 of the webview restructuring. All panel data
// flows via postMessage (no first-paint init payload).

// Appease strict unused-import linting when the module-level `_context`
// is only read from within closures — retained for future API hooks.
void _context;
void path;
