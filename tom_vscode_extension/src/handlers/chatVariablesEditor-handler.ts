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
import { ChatVariablesStore, ChangeSource } from '../managers/chatVariablesStore';
import { scanWorkspaceProjects } from '../managers/questTodoManager';
import { readPanelYaml, writePanelYaml, openPanelFile } from '../utils/panelYamlStore';
import { WsPaths } from '../utils/workspacePaths';
import { updateChatResponseValues } from './handler_shared';
import { loadWebviewHtml } from '../utils/webviewLoader';

// ============================================================================
// Panel management
// ============================================================================

let _panel: vscode.WebviewPanel | undefined;

export function openChatVariablesEditor(context: vscode.ExtensionContext): void {
    if (_panel) {
        _panel.reveal();
        return;
    }

    _panel = vscode.window.createWebviewPanel(
        'chatVariablesEditor',
        'Chat Variables',
        vscode.ViewColumn.Active,
        {
            enableScripts: true,
            retainContextWhenHidden: true,
            localResourceRoots: [
                vscode.Uri.joinPath(context.extensionUri, 'media'),
            ],
        },
    );

    // Register message handler BEFORE setting html so no messages are lost
    _panel.webview.onDidReceiveMessage(
        (msg) => handleMessage(msg),
        undefined,
        context.subscriptions,
    );

    _panel.webview.html = loadWebviewHtml(_panel.webview, 'chatVariablesEditor');

    // Listen for store changes → push to webview + persist YAML
    let storeListener: vscode.Disposable | undefined;
    try {
        const store = ChatVariablesStore.instance;
        storeListener = store.onDidChange(() => {
            sendState(_panel!);
            _persistYaml(store);
        });
    } catch { /* store not initialised */ }

    // Initial data push
    sendState(_panel);

    _panel.onDidDispose(() => {
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
        case 'setCustom':
            store.set(msg.key, msg.value, 'user');
            break;
        case 'deleteCustom':
            store.set(msg.key, '', 'user');
            break;
        case 'getState':
            if (_panel) { sendState(_panel); }
            break;
        case 'pickProjects':
            await _pickProjects();
            break;
        case 'showFile':
            openPanelFile('chatvars');
            break;
    }
}

function sendState(panel: vscode.WebviewPanel): void {
    let store: ChatVariablesStore;
    try { store = ChatVariablesStore.instance; } catch { return; }

    // Scan available roles
    const roles = _scanRoles();

    panel.webview.postMessage({
        type: 'state',
        quest: store.quest,
        role: store.role,
        roles: roles,
        activeProjects: store.activeProjects,
        todo: store.todo,
        todoFile: store.todoFile,
        custom: store.custom,
        changeLog: store.changeLog,
    });
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
    if (!wsRoot) return [];
    
    const rolesDir = WsPaths.ai('roles') || path.join(wsRoot, '_ai', 'roles');
    if (!fs.existsSync(rolesDir)) return [];
    
    try {
        return fs.readdirSync(rolesDir, { withFileTypes: true })
            .filter(e => e.isDirectory() || e.name.endsWith('.md') || e.name.endsWith('.yaml'))
            .map(e => e.isDirectory() ? e.name : e.name.replace(/\.(md|yaml)$/, ''))
            .sort();
    } catch { return []; }
}

// ============================================================================
// Registration
// ============================================================================

export function registerChatVariablesEditorCommand(context: vscode.ExtensionContext): void {
    context.subscriptions.push(
        vscode.commands.registerCommand('tomAi.editor.chatVariables', () => {
            openChatVariablesEditor(context);
        }),
    );
}
