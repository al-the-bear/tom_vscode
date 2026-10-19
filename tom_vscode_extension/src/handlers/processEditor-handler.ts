/**
 * Process editor — a webview panel listing every process under
 * `_ai/processes/` and editing one: name, summary, its Markdown description,
 * and the structure (phases, steps, sub-steps, the gate and post-gate step
 * with its todos), each with its role, repeat settings and description. New
 * processes start from a one-phase skeleton; Copy duplicates one under a new
 * id. The editor validates as you type and refuses to save an invalid
 * definition. The descriptions are edited only here; the PROCESS view shows
 * them.
 *
 * Command: `tomAi.editor.process`. Assets: `media/processEditor/`.
 */

import * as vscode from 'vscode';

import { ProcessStateStore } from '../managers/processStateStore';
import { loadWebviewHtml } from '../utils/webviewLoader';
import { listRoleNames } from '../utils/roleNames';
import { WsPaths } from '../utils/workspacePaths';
import { validateProcessDefinition, type ProcessDefinition } from '../utils/processDefinition';

const VIEW_TYPE = 'tomAi.processEditor';

let panel: vscode.WebviewPanel | undefined;
/** The process shown, so a reload or a reopen lands on it. */
let selectedId: string | undefined;

function webviewOptions(context: vscode.ExtensionContext): vscode.WebviewOptions {
    return {
        enableScripts: true,
        localResourceRoots: [
            vscode.Uri.joinPath(context.extensionUri, 'media'),
            vscode.Uri.joinPath(context.extensionUri, 'node_modules', '@vscode', 'codicons', 'dist'),
        ],
    };
}

/** Open the editor, on process `id` when given. */
export function openProcessEditor(context: vscode.ExtensionContext, id?: string): void {
    if (id) { selectedId = id; }
    if (panel) {
        panel.reveal();
        void sendList();
        return;
    }
    const created = vscode.window.createWebviewPanel(VIEW_TYPE, 'Processes', vscode.ViewColumn.Active, {
        ...webviewOptions(context),
        retainContextWhenHidden: true,
    });
    bind(context, created);
}

function bind(context: vscode.ExtensionContext, p: vscode.WebviewPanel): void {
    panel = p;
    p.webview.onDidReceiveMessage((msg) => void handle(msg), undefined, context.subscriptions);
    const codicons = p.webview.asWebviewUri(vscode.Uri.joinPath(context.extensionUri, 'node_modules', '@vscode', 'codicons', 'dist', 'codicon.css'));
    p.webview.html = loadWebviewHtml(p.webview, 'processEditor', { init: { codiconsUri: codicons.toString() } });
    let sub: vscode.Disposable | undefined;
    void ProcessStateStore.ready.then((store) => { sub = store.onDidChange(() => void sendList()); });
    p.onDidDispose(() => { sub?.dispose(); panel = undefined; });
}

async function store(): Promise<ProcessStateStore> {
    return ProcessStateStore.ready;
}

async function sendList(): Promise<void> {
    if (!panel) { return; }
    const s = await store();
    const list = s.list();
    if (selectedId && !list.some((e) => e.id === selectedId)) { selectedId = undefined; }
    if (!selectedId && list.length) { selectedId = s.state.process || list[0].id; }
    void panel.webview.postMessage({
        type: 'list',
        processes: list.map((e) => ({ id: e.id, name: e.definition?.name || e.id, valid: !!e.definition, errorCount: e.errors.length })),
        roles: listRoleNames(WsPaths.ai('roles')),
        currentProcess: s.state.process,
        selected: selectedId,
    });
}

async function sendProcess(id: string): Promise<void> {
    if (!panel) { return; }
    const entry = (await store()).entry(id);
    if (!entry) { return; }
    selectedId = id;
    void panel.webview.postMessage({
        type: 'load',
        id,
        // An invalid definition opens as parsed, so it can be repaired here.
        definition: entry.definition ?? entry.raw ?? null,
        description: entry.description,
        errors: entry.errors,
        files: { yaml: entry.yamlPath, description: entry.mdPath },
    });
}

interface EditorMessage {
    type: string;
    id?: string;
    dirty?: boolean;
    definition?: ProcessDefinition;
    description?: string;
}

async function handle(msg: EditorMessage): Promise<void> {
    const s = await store();
    switch (msg.type) {
        case 'ready':
            await sendList();
            if (selectedId) { await sendProcess(selectedId); }
            break;
        case 'select': {
            if (!msg.id) { break; }
            if (msg.dirty) {
                const choice = await vscode.window.showWarningMessage(
                    `"${selectedId}" has unsaved changes.`, { modal: true }, 'Save', 'Discard');
                if (!choice) { void panel?.webview.postMessage({ type: 'selectCancelled', id: selectedId }); break; }
                if (choice === 'Save' && msg.definition) {
                    const saved = s.save(msg.definition, msg.description ?? '');
                    if (!saved.ok) {
                        void vscode.window.showErrorMessage(`Not saved: ${saved.error}`);
                        void panel?.webview.postMessage({ type: 'selectCancelled', id: selectedId });
                        break;
                    }
                }
            }
            await sendList();
            await sendProcess(msg.id);
            break;
        }
        case 'validate':
            void panel?.webview.postMessage({ type: 'validation', errors: validateProcessDefinition(msg.definition).errors });
            break;
        case 'save': {
            if (!msg.definition) { break; }
            const result = s.save(msg.definition, msg.description ?? '');
            void panel?.webview.postMessage({ type: 'saved', ok: result.ok, error: result.ok ? undefined : result.error });
            if (result.ok && msg.definition.id) { await sendProcess(msg.definition.id); }
            break;
        }
        case 'revert':
            if (selectedId) { await sendProcess(selectedId); }
            break;
        case 'create': {
            const id = await askId('Id of the new process (also its folder name)', '');
            if (!id) { break; }
            const name = await vscode.window.showInputBox({ title: 'New process', prompt: 'Display name', value: id });
            const result = s.create(id, name || id);
            if (!result.ok) { void vscode.window.showErrorMessage(result.error); break; }
            selectedId = id;
            await sendList();
            await sendProcess(id);
            break;
        }
        case 'copy': {
            const from = msg.id || selectedId;
            if (!from) { break; }
            const id = await askId(`Id of the copy of "${from}"`, `${from}_copy`);
            if (!id) { break; }
            const result = s.copy(from, id);
            if (!result.ok) { void vscode.window.showErrorMessage(result.error); break; }
            selectedId = id;
            await sendList();
            await sendProcess(id);
            break;
        }
        case 'openYaml': {
            const entry = msg.id ? s.entry(msg.id) : undefined;
            if (entry) { await vscode.window.showTextDocument(vscode.Uri.file(entry.yamlPath), { viewColumn: vscode.ViewColumn.Beside }); }
            break;
        }
    }
}

async function askId(prompt: string, value: string): Promise<string | undefined> {
    return vscode.window.showInputBox({
        title: 'Process id',
        prompt,
        value,
        validateInput: (v) => (/^[A-Za-z0-9][A-Za-z0-9_-]*$/.test(v) ? undefined : 'letters, digits, "_" and "-" only, starting with a letter or digit'),
    });
}

/** Register `tomAi.editor.process` and restore the panel after a window reload. */
export function registerProcessEditor(context: vscode.ExtensionContext): void {
    context.subscriptions.push(
        vscode.commands.registerCommand('tomAi.editor.process', (id?: string) => openProcessEditor(context, typeof id === 'string' ? id : undefined)),
        vscode.window.registerWebviewPanelSerializer(VIEW_TYPE, {
            async deserializeWebviewPanel(p: vscode.WebviewPanel): Promise<void> {
                if (panel) { p.dispose(); return; }
                p.webview.options = webviewOptions(context);
                bind(context, p);
            },
        }),
    );
}
