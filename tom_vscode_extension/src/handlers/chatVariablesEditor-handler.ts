/**
 * Chat Variables Editor — §7
 *
 * A webview panel (opened via command) that displays all current chat
 * variables in a two-column editable table plus a scrollable change log.
 *
 * Command: `tomAi.editor.chatVariables`
 */

import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import { ChatVariablesStore } from '../managers/chatVariablesStore';
import { scanWorkspaceProjects } from '../managers/questTodoManager';
import { writePanelYaml, openPanelFile } from '../utils/panelYamlStore';
import { WsPaths } from '../utils/workspacePaths';
import { loadWebviewHtml } from '../utils/webviewLoader';
import { listRoleNames } from '../utils/roleNames';

// ============================================================================
// Panel management
// ============================================================================

let _panel: vscode.WebviewPanel | undefined;
/**
 * The run the editor shows (vscimpb60c): its custom chat variables (the run's
 * parameters) and its process position. Undefined: the window's run. Opened
 * from a Prompt Queue tab, the editor shows that tab's run.
 */
let _run: string | undefined;

/** The run the editor shows now. */
function shownRun(store: ChatVariablesStore): string {
    return _run ?? store.windowRun;
}

/** The editor's title: it names the run. */
export function chatVariablesEditorTitle(run: string): string {
    return `Chat Variables — run ${run}`;
}

export function openChatVariablesEditor(context: vscode.ExtensionContext, run?: string): void {
    _run = typeof run === 'string' && run.trim() ? run.trim() : undefined;
    if (_panel) {
        _panel.reveal();
        try { _panel.title = chatVariablesEditorTitle(shownRun(ChatVariablesStore.instance)); } catch { /* store not initialised */ }
        sendState(_panel);
        return;
    }

    let title = 'Chat Variables';
    try { title = chatVariablesEditorTitle(shownRun(ChatVariablesStore.instance)); } catch { /* store not initialised */ }
    const panel = vscode.window.createWebviewPanel(
        'chatVariablesEditor',
        title,
        vscode.ViewColumn.Active,
        {
            ...getChatVariablesEditorWebviewOptions(context),
            retainContextWhenHidden: true,
        },
    );
    bindChatVariablesEditorPanel(context, panel);
}

/** Webview options shared by the fresh-open and reload-restore paths. */
function getChatVariablesEditorWebviewOptions(context: vscode.ExtensionContext): vscode.WebviewOptions {
    return {
        enableScripts: true,
        localResourceRoots: [
            vscode.Uri.joinPath(context.extensionUri, 'media'),
        ],
    };
}

/**
 * Wire a (freshly-created or reload-restored) Chat Variables editor panel:
 * install the message handler, paint the HTML, re-subscribe to the store's
 * change events, and push the initial state. Both `openChatVariablesEditor` and
 * the reload serializer call this so the wiring lives in one place. Singleton
 * that reloads all variables from the store on open, so no per-panel state is
 * persisted.
 */
function bindChatVariablesEditorPanel(context: vscode.ExtensionContext, panel: vscode.WebviewPanel): void {
    _panel = panel;

    // Register message handler BEFORE setting html so no messages are lost
    panel.webview.onDidReceiveMessage(
        (msg) => handleMessage(msg),
        undefined,
        context.subscriptions,
    );

    panel.webview.html = loadWebviewHtml(panel.webview, 'chatVariablesEditor');

    // Listen for store changes → push to webview + persist YAML
    let storeListener: vscode.Disposable | undefined;
    try {
        const store = ChatVariablesStore.instance;
        storeListener = store.onDidChange(() => {
            sendState(panel);
            _persistYaml(store);
        });
    } catch { /* store not initialised */ }

    // Initial data push
    sendState(panel);

    panel.onDidDispose(() => {
        _panel = undefined;
        storeListener?.dispose();
    });
}

// ============================================================================
// Message handling
// ============================================================================

async function handleMessage(msg: any): Promise<void> {
    let store: ChatVariablesStore;
    try { store = ChatVariablesStore.instance; } catch { return; }

    switch (msg.type) {
        case 'setQuest':
            store.set('quest', msg.value, 'user');
            break;
        case 'setRole':
            store.set('role', msg.value, 'user');
            break;
        case 'setActiveProjects':
            store.setActiveProjects(msg.value, 'user');
            break;
        case 'setTodo':
            store.set('todo', msg.value, 'user');
            break;
        case 'setTodoFile':
            store.set('todoFile', msg.value, 'user');
            break;
        // The custom variables are the shown run's.
        case 'setCustom':
            store.withRun(shownRun(store), () => store.set(msg.key, msg.value, 'user'));
            break;
        case 'deleteCustom':
            store.withRun(shownRun(store), () => store.set(msg.key, '', 'user'));
            break;
        case 'getState':
            if (_panel) { sendState(_panel); }
            break;
        case 'pickProjects':
            await _pickProjects();
            break;
        case 'showFile': {
            // The shown run's file: the window's chat variables for `default`, else the run's own file.
            const run = shownRun(store);
            if (run === 'default') {
                openPanelFile('chatvars');
            } else {
                const file = store.runFilePath(run);
                if (fs.existsSync(file)) {
                    void vscode.window.showTextDocument(vscode.Uri.file(file), { preview: true });
                } else {
                    vscode.window.showInformationMessage(`Run ${run} has no chat variables of its own yet (${path.basename(file)}).`);
                }
            }
            break;
        }
    }
}

function sendState(panel: vscode.WebviewPanel): void {
    let store: ChatVariablesStore;
    try { store = ChatVariablesStore.instance; } catch { return; }

    // Scan available roles
    const roles = _scanRoles();

    const run = shownRun(store);
    const windowRun = store.windowRun;
    panel.title = chatVariablesEditorTitle(run);
    panel.webview.postMessage({
        type: 'state',
        // The run shown (vscimpb60c): its custom variables and its process position; the others are the window's.
        run,
        windowRun,
        quest: store.quest,
        role: store.role,
        roles: roles,
        activeProjects: store.activeProjects,
        todo: store.todo,
        todoFile: store.todoFile,
        custom: store.withRun(run, () => ({ ...store.custom })),
        changeLog: store.changeLog,
        // The run's process variables (derived, read-only here).
        process: run === windowRun ? store.derivedValues() : processVariablesOfRun(run),
    });
}

/** The process chat variables of another run than the window's, read from its state file. */
function processVariablesOfRun(run: string): Record<string, string> {
    try {
        // eslint-disable-next-line @typescript-eslint/no-require-imports
        const store = (require('../managers/processStateStore.js') as typeof import('../managers/processStateStore')).ProcessStateStore.instance;
        return store ? store.runOverview(run).variables : {};
    } catch {
        return {};
    }
}

// ============================================================================
// YAML persistence
// ============================================================================

function _persistYaml(store: ChatVariablesStore): void {
    const data: Record<string, any> = {
        quest: store.quest || '',
        role: store.role || '',
        activeProjects: store.activeProjects,
        todo: store.todo || '',
        todoFile: store.todoFile || '',
        custom: store.custom || {},
    };
    writePanelYaml('chatvars', data, '../../.tom/json-schema/panels/chatvars.schema.json').catch(() => { /* best effort */ });
}

// ============================================================================
// Project picker
// ============================================================================

async function _pickProjects(): Promise<void> {
    if (!_panel) return;

    const projects = scanWorkspaceProjects().map(p => p.name);

    let currentProjects: string[] = [];
    try {
        currentProjects = ChatVariablesStore.instance.activeProjects || [];
    } catch { /* */ }

    const items = projects.map(p => ({
        label: p,
        picked: currentProjects.includes(p),
    }));

    const picked = await vscode.window.showQuickPick(items, {
        canPickMany: true,
        placeHolder: 'Select active projects',
        title: 'Active Projects',
    });

    if (picked) {
        const selected = picked.map(p => p.label);
        try {
            ChatVariablesStore.instance.setActiveProjects(selected, 'user');
        } catch { /* */ }
    }
}

// ============================================================================
// Role picker
// ============================================================================

function _getWorkspaceRoot(): string | undefined {
    return vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
}

function _scanRoles(): string[] {
    const wsRoot = _getWorkspaceRoot();
    if (!wsRoot) { return []; }
    return listRoleNames(WsPaths.ai('roles') || path.join(wsRoot, '_ai', 'roles'));
}

// ============================================================================
// Registration
// ============================================================================

export function registerChatVariablesEditorCommand(context: vscode.ExtensionContext): void {
    context.subscriptions.push(
        // An argument names the run to show (a Prompt Queue tab's); none: the window's run.
        vscode.commands.registerCommand('tomAi.editor.chatVariables', (run?: unknown) => {
            openChatVariablesEditor(context, typeof run === 'string' ? run : undefined);
        }),
    );
    // Restore the panel after a window reload. Singleton that reloads all
    // variables from the store on open, so no per-panel state is persisted — the
    // deserialize path re-binds the recreated panel (or disposes a duplicate).
    // Without the serializer the tab silently vanishes on reload.
    context.subscriptions.push(
        vscode.window.registerWebviewPanelSerializer('chatVariablesEditor', {
            async deserializeWebviewPanel(panel: vscode.WebviewPanel): Promise<void> {
                if (_panel) { panel.dispose(); return; }
                panel.webview.options = getChatVariablesEditorWebviewOptions(context);
                bindChatVariablesEditorPanel(context, panel);
            },
        }),
    );
}
