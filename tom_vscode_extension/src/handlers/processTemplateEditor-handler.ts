/**
 * Process template editor — the prompt template of the PROCESS view's Proceed
 * button, the only move that runs anything (the others only move the state).
 * It is global, kept in the extension config under
 * `processActionTemplates.proceed`; left at its default it is not written, so
 * it follows the built-in default.
 *
 * The variable list inserts a placeholder at the cursor: the action variables
 * (`${custom-instructions}`, `${action-prompt}`, …), the process variables of
 * the position being run, the chat variables (custom ones included) and a few
 * general placeholders. The preview resolves the template being edited for
 * the current position.
 *
 * Command: `tomAi.editor.processTemplates`. Assets: `media/processTemplateEditor/`.
 */

import * as vscode from 'vscode';

import { ChatVariablesStore } from '../managers/chatVariablesStore';
import { ProcessStateStore } from '../managers/processStateStore';
import { loadWebviewHtml } from '../utils/webviewLoader';
import {
    buildProcessActionPrompt,
    configuredProcessActionTemplates,
    saveProcessActionTemplates,
} from '../services/processActionService';
import {
    DEFAULT_PROCESS_ACTION_TEMPLATES,
    PROCESS_ACTION_TITLES,
    PROCESS_ACTION_VARIABLES,
    PROCESS_TEMPLATE_KINDS,
    processActionTemplate,
    type ProcessActionTemplates,
    type ProcessTemplateKind,
} from '../utils/processActionPrompt';
import { PROCESS_VARIABLE_KEYS } from '../utils/processDefinition';

const VIEW_TYPE = 'tomAi.processTemplateEditor';

let panel: vscode.WebviewPanel | undefined;
let selectedKind: ProcessTemplateKind = 'proceed';

/** General placeholders worth offering beside the chat and process variables. */
const GENERAL_PLACEHOLDERS: ReadonlyArray<{ name: string; description: string }> = [
    { name: 'date', description: 'Today' },
    { name: 'time', description: 'Now' },
    { name: 'workspace', description: 'Workspace name' },
    { name: 'quest-description', description: 'The quest overview file' },
    { name: 'memory', description: 'Memory facts' },
];

function webviewOptions(context: vscode.ExtensionContext): vscode.WebviewOptions {
    return {
        enableScripts: true,
        localResourceRoots: [
            vscode.Uri.joinPath(context.extensionUri, 'media'),
            vscode.Uri.joinPath(context.extensionUri, 'node_modules', '@vscode', 'codicons', 'dist'),
        ],
    };
}

/** Open the editor, on the template of `kind` when given. */
export function openProcessTemplateEditor(context: vscode.ExtensionContext, kind?: ProcessTemplateKind): void {
    if (kind && PROCESS_TEMPLATE_KINDS.includes(kind)) { selectedKind = kind; }
    if (panel) {
        panel.reveal();
        void panel.webview.postMessage({ type: 'select', kind: selectedKind });
        return;
    }
    bind(context, vscode.window.createWebviewPanel(VIEW_TYPE, 'Process Templates', vscode.ViewColumn.Active, {
        ...webviewOptions(context),
        retainContextWhenHidden: true,
    }));
}

function bind(context: vscode.ExtensionContext, p: vscode.WebviewPanel): void {
    panel = p;
    const codicons = p.webview.asWebviewUri(vscode.Uri.joinPath(context.extensionUri, 'node_modules', '@vscode', 'codicons', 'dist', 'codicon.css'));
    p.webview.html = loadWebviewHtml(p.webview, 'processTemplateEditor', { init: { codiconsUri: codicons.toString() } });
    p.webview.onDidReceiveMessage((msg) => void handle(msg), undefined, context.subscriptions);
    p.onDidDispose(() => { panel = undefined; });
}

function chatVariableNames(): string[] {
    try {
        const chat = ChatVariablesStore.instance;
        return ['quest', 'role', 'activeProjects', 'todo', 'todoFile', ...Object.keys(chat.custom).sort()];
    } catch {
        return ['quest', 'role', 'activeProjects', 'todo', 'todoFile'];
    }
}

function sendAll(): void {
    if (!panel) { return; }
    const configured = configuredProcessActionTemplates();
    void panel.webview.postMessage({
        type: 'load',
        selected: selectedKind,
        kinds: PROCESS_TEMPLATE_KINDS.map((kind) => ({
            kind,
            title: PROCESS_ACTION_TITLES[kind],
            text: processActionTemplate(kind, configured),
            defaultText: DEFAULT_PROCESS_ACTION_TEMPLATES[kind],
        })),
        variables: [
            { group: 'Action', items: PROCESS_ACTION_VARIABLES },
            { group: 'Process (the position being run)', items: PROCESS_VARIABLE_KEYS.map((name) => ({ name, description: '' })) },
            { group: 'Chat variables', items: chatVariableNames().map((name) => ({ name, description: '' })) },
            { group: 'General', items: GENERAL_PLACEHOLDERS },
        ],
    });
}

async function sendPreview(kind: ProcessTemplateKind, text: string): Promise<void> {
    if (!panel) { return; }
    const store = await ProcessStateStore.ready;
    const move = store.moves().find((m) => m.kind === kind);
    void panel.webview.postMessage({
        type: 'preview',
        kind,
        offered: !!move,
        label: move?.label ?? '',
        preview: move ? buildProcessActionPrompt(store, move, '(custom instructions)', text) : '',
    });
}

async function handle(msg: { type: string; kind?: ProcessTemplateKind; text?: string; templates?: ProcessActionTemplates }): Promise<void> {
    switch (msg.type) {
        case 'ready':
            sendAll();
            break;
        case 'select':
            if (msg.kind) { selectedKind = msg.kind; }
            break;
        case 'preview':
            if (msg.kind) { await sendPreview(msg.kind, msg.text ?? ''); }
            break;
        case 'save':
            if (msg.templates && saveProcessActionTemplates(msg.templates)) {
                void panel?.webview.postMessage({ type: 'saved' });
                sendAll();
            } else {
                void vscode.window.showWarningMessage('Process templates: the extension config could not be written.');
            }
            break;
        case 'revert':
            sendAll();
            break;
    }
}

/** Register `tomAi.editor.processTemplates` and restore the panel after a window reload. */
export function registerProcessTemplateEditor(context: vscode.ExtensionContext): void {
    context.subscriptions.push(
        vscode.commands.registerCommand('tomAi.editor.processTemplates', (kind?: string) =>
            openProcessTemplateEditor(context, typeof kind === 'string' ? kind as ProcessTemplateKind : undefined)),
        vscode.window.registerWebviewPanelSerializer(VIEW_TYPE, {
            async deserializeWebviewPanel(p: vscode.WebviewPanel): Promise<void> {
                if (panel) { p.dispose(); return; }
                p.webview.options = webviewOptions(context);
                bind(context, p);
            },
        }),
    );
}
