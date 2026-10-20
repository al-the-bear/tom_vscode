/**
 * Process action page — opened by a button of the PROCESS view's action bar
 * (Next, Finish …, Repeat …, Gate passed / failed, Finish process, Skip,
 * Back). It shows where the move leads, the `prompt` fields of what it starts,
 * a field for custom instructions and a live preview of the prompt the move's
 * template (process template editor) builds from them.
 *
 * "Add to queue" moves the quest's process state and adds the prompt to the
 * prompt queue (src/services/processActionService.ts); a template that
 * resolves to nothing only moves the state. Cancel changes nothing. The page
 * follows the state: when the move is no longer possible from the current
 * position, it says so and offers only Cancel.
 *
 * Assets: `media/processAction/`.
 */

import * as vscode from 'vscode';

import { ProcessStateStore } from '../managers/processStateStore';
import { loadWebviewHtml } from '../utils/webviewLoader';
import { buildProcessActionPrompt, confirmProcessAction, onDidChangeProcessActionTemplates } from '../services/processActionService';
import { PROCESS_ACTION_TITLES, actionSession, positionText, startedPrompts } from '../utils/processActionPrompt';
import { pickAgentSdkSession } from './sessionPicker';
import type { ProcessDefinition, ProcessLevel, ProcessMove, ProcessMoveKind } from '../utils/processDefinition';
import { openProcessTemplateEditor } from './processTemplateEditor-handler';

const VIEW_TYPE = 'tomAi.processAction';

let panel: vscode.WebviewPanel | undefined;
let current: { kind: ProcessMoveKind; level?: ProcessLevel } | undefined;
let custom = '';
/** The session picked on the page for this move; undefined = as the process says. */
let sessionOverride: string | undefined;

/** Open the action page for a move (one page at a time: a new click replaces the move it shows). */
export function openProcessAction(context: vscode.ExtensionContext, kind: ProcessMoveKind, level?: ProcessLevel): void {
    if (!current || current.kind !== kind || current.level !== level) { custom = ''; sessionOverride = undefined; }
    current = { kind, level };
    if (panel) {
        panel.reveal();
        void send();
        return;
    }
    const p = vscode.window.createWebviewPanel(VIEW_TYPE, 'Process action', vscode.ViewColumn.Active, {
        enableScripts: true,
        retainContextWhenHidden: true,
        localResourceRoots: [
            vscode.Uri.joinPath(context.extensionUri, 'media'),
            vscode.Uri.joinPath(context.extensionUri, 'node_modules', '@vscode', 'codicons', 'dist'),
        ],
    });
    panel = p;
    const codicons = p.webview.asWebviewUri(vscode.Uri.joinPath(context.extensionUri, 'node_modules', '@vscode', 'codicons', 'dist', 'codicon.css'));
    p.webview.html = loadWebviewHtml(p.webview, 'processAction', { init: { codiconsUri: codicons.toString() } });
    p.webview.onDidReceiveMessage((msg) => void handle(context, msg), undefined, context.subscriptions);
    let sub: vscode.Disposable | undefined;
    void ProcessStateStore.ready.then((store) => { sub = store.onDidChange(() => void send()); });
    const templates = onDidChangeProcessActionTemplates(() => void send());
    p.onDidDispose(() => { sub?.dispose(); templates.dispose(); panel = undefined; current = undefined; custom = ''; sessionOverride = undefined; });
}

/** How the page shows the session: its name, where it comes from, and the definition's base and mode. */
function sessionView(def: ProcessDefinition, move: ProcessMove): Record<string, unknown> {
    const s = actionSession(def, move, sessionOverride);
    return { name: s.name, source: s.source, ...(s.spec?.basedOn ? { basedOn: s.spec.basedOn } : {}), ...(s.spec?.mode ? { mode: s.spec.mode } : {}) };
}

async function send(): Promise<void> {
    if (!panel || !current) { return; }
    const store = await ProcessStateStore.ready;
    const def = store.currentDefinition();
    const move = store.findMove(current.kind, current.level);
    panel.title = `Process: ${move?.label ?? current.kind}`;
    if (!def || !move) {
        void panel.webview.postMessage({ type: 'unavailable', kind: current.kind, quest: store.activeQuest });
        return;
    }
    void panel.webview.postMessage({
        type: 'move',
        kind: move.kind,
        level: move.level ?? null,
        label: move.label,
        title: PROCESS_ACTION_TITLES[move.kind],
        quest: store.activeQuest,
        process: def.name || def.id,
        from: positionText(def, store.state),
        to: positionText(def, move.target),
        startedPrompts: startedPrompts(def, store.state, move.target),
        custom,
        preview: buildProcessActionPrompt(store, move, custom, undefined, sessionOverride),
        session: sessionView(def, move),
    });
}

async function preview(): Promise<void> {
    if (!panel || !current) { return; }
    const store = await ProcessStateStore.ready;
    const move = store.findMove(current.kind, current.level);
    if (!move) { return; }
    void panel.webview.postMessage({ type: 'preview', preview: buildProcessActionPrompt(store, move, custom, undefined, sessionOverride) });
}

async function handle(context: vscode.ExtensionContext, msg: { type: string; custom?: string }): Promise<void> {
    if (typeof msg.custom === 'string') { custom = msg.custom; }
    switch (msg.type) {
        case 'ready':
            await send();
            break;
        case 'preview':
            await preview();
            break;
        case 'confirm': {
            if (!current) { return; }
            const result = await confirmProcessAction(current.kind, current.level, custom, sessionOverride);
            if (!result.ok) {
                void vscode.window.showWarningMessage(`Process: ${result.error}`);
                await send();
                return;
            }
            void vscode.window.showInformationMessage(result.queued
                ? `Process: ${result.label} — the prompt is in the queue.`
                : `Process: ${result.label} — the state moved; the template is empty, nothing was queued.`);
            panel?.dispose();
            break;
        }
        case 'cancel':
            panel?.dispose();
            break;
        case 'pickSession': {
            if (!current) { return; }
            const store = await ProcessStateStore.ready;
            const def = store.currentDefinition();
            const move = store.findMove(current.kind, current.level);
            if (!def || !move) { return; }
            const fromProcess = actionSession(def, move);
            const picked = await pickAgentSdkSession({
                questId: store.activeQuest,
                current: actionSession(def, move, sessionOverride).name || undefined,
                title: `Session for "${move.label}"`,
                defaultLabel: fromProcess.name ? `As the process says (${fromProcess.name})` : 'As the process says (the queue default)',
            });
            if (picked !== undefined) {
                // '' = back to the process's choice; a name = that session.
                sessionOverride = picked === '' ? undefined : picked;
            }
            await send();
            break;
        }
        case 'editTemplate':
            if (current) { openProcessTemplateEditor(context, current.kind); }
            break;
    }
}
