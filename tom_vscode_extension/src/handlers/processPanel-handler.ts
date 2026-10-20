/**
 * PROCESS — the @TOM sidebar view showing where the active quest is in its
 * process: process, phase, step and sub-step (dropdowns), their iterations
 * (− / +), the role the step names, the post-gate todos, and each one's
 * description behind a `?` button. The action bar at the top offers the moves
 * the process allows from here. Proceed (the only one that runs anything)
 * opens the action page (processAction-handler.ts), which queues the prompt of
 * the current position and then moves on — or, at a decision point, stays
 * marked as run. At a decision position (after a gate, a phase's end or a
 * repeatable level) Proceed opens the decision's options in a dialog — go on,
 * repeat, gate passed / failed — and the one picked moves the state. At a user action (a step the user does) Proceed instead asks
 * the user to confirm it is done, and only moves the state; Finish …, Repeat …, Gate passed / failed, Finish process,
 * Skip and Back only move the state, at once. Usually the agent moves the state
 * (`tomAi_setProcessState`); the view lets the user see it at a glance and set
 * it by hand. Everything goes through ProcessStateStore, which keeps the
 * quest's state file.
 *
 * View: `tomAi.process` (between VS CODE NOTES and QUEST NOTES).
 * Assets: `media/processPanel/`.
 */

import * as vscode from 'vscode';

import { ProcessStateStore } from '../managers/processStateStore';
import { ChatVariablesStore } from '../managers/chatVariablesStore';
import { loadWebviewHtml } from '../utils/webviewLoader';
import type { ProcessChange, ProcessLevel, ProcessMoveKind } from '../utils/processDefinition';
import { decisionDialog, positionText, userActionConfirmation } from '../utils/processActionPrompt';
import { openProcessAction } from './processAction-handler';
import { confirmProcessAction } from '../services/processActionService';
import { openProcessTemplateEditor } from './processTemplateEditor-handler';
import { openMarkdownBrowser } from './markdownBrowser-handler';
import { openProcessEditor } from './processEditor-handler';

export const PROCESS_VIEW_ID = 'tomAi.process';

class ProcessViewProvider implements vscode.WebviewViewProvider {
    private view?: vscode.WebviewView;
    private subscription?: vscode.Disposable;

    constructor(private readonly context: vscode.ExtensionContext) {}

    resolveWebviewView(webviewView: vscode.WebviewView): void {
        this.view = webviewView;
        const extensionUri = this.context.extensionUri;
        webviewView.webview.options = {
            enableScripts: true,
            localResourceRoots: [
                vscode.Uri.joinPath(extensionUri, 'media'),
                vscode.Uri.joinPath(extensionUri, 'node_modules', '@vscode', 'codicons', 'dist'),
                vscode.Uri.joinPath(extensionUri, 'node_modules', 'marked', 'lib'),
            ],
        };
        const asUri = (...parts: string[]): string => webviewView.webview.asWebviewUri(vscode.Uri.joinPath(extensionUri, ...parts)).toString();
        webviewView.webview.html = loadWebviewHtml(webviewView.webview, 'processPanel', {
            init: {
                codiconsUri: asUri('node_modules', '@vscode', 'codicons', 'dist', 'codicon.css'),
                markedUri: asUri('node_modules', 'marked', 'lib', 'marked.umd.js'),
            },
        });
        webviewView.webview.onDidReceiveMessage((msg) => void this.handle(msg), undefined, this.context.subscriptions);
        webviewView.onDidChangeVisibility(() => { if (webviewView.visible) { this.send(); } });
        webviewView.onDidDispose(() => { this.subscription?.dispose(); this.view = undefined; });
        void ProcessStateStore.ready.then((store) => {
            this.subscription?.dispose();
            this.subscription = store.onDidChange(() => this.send());
            this.send();
        });
    }

    private send(): void {
        const store = ProcessStateStore.instance;
        if (!this.view || !store) { return; }
        let chatRole = '';
        try { chatRole = ChatVariablesStore.instance.role; } catch { /* not initialised */ }
        const state = store.state;
        const entry = store.entry(state.process);
        void this.view.webview.postMessage({
            type: 'state',
            quest: store.activeQuest,
            processes: store.list().map((e) => ({ id: e.id, name: e.definition?.name || e.id, valid: !!e.definition })),
            state,
            definition: entry?.definition ?? null,
            processInvalid: !!entry && !entry.definition,
            description: entry?.description ?? '',
            stepRole: store.currentRole(),
            chatRole,
            moves: entry?.definition
                ? store.moves().map((m) => ({
                    kind: m.kind, level: m.level ?? null, label: m.label, to: positionText(entry.definition!, m.target),
                    ...(m.branchOption ? { branchOption: true } : {}),
                }))
                : [],
        });
    }

    private report(result: { ok: boolean; error?: string }): void {
        if (!result.ok && result.error) { void vscode.window.showWarningMessage(`Process: ${result.error}`); }
        this.send();
    }

    private async handle(msg: { type: string; change?: ProcessChange; level?: ProcessLevel; delta?: number; id?: string; kind?: ProcessMoveKind }): Promise<void> {
        const store = await ProcessStateStore.ready;
        switch (msg.type) {
            case 'ready':
                this.send();
                break;
            case 'change':
                if (msg.change) { this.report(store.apply(msg.change, 'user')); }
                break;
            case 'iteration':
                if (msg.level && msg.delta) { this.report(store.stepIteration(msg.level, msg.delta, 'user')); }
                break;
            case 'action':
                if (msg.kind === 'proceed') {
                    const def = store.currentDefinition();
                    // A decision runs nothing: the user picks how the process goes on.
                    const decide = def ? decisionDialog(def, store.state) : null;
                    if (decide) {
                        const picked = await vscode.window.showInformationMessage(decide.message, { modal: true, detail: decide.detail }, ...decide.options.map((o) => o.label));
                        const option = decide.options.find((o) => o.label === picked);
                        if (option) {
                            const result = await confirmProcessAction(option.kind, option.level, '');
                            this.report(result.ok ? { ok: true } : result);
                        }
                        break;
                    }
                    // A user action runs no prompt: the user confirms it is done.
                    const ask = def ? userActionConfirmation(def, store.state) : null;
                    if (ask) {
                        const answer = await vscode.window.showWarningMessage(ask.message, { modal: true, detail: ask.detail }, ask.confirm);
                        if (answer === ask.confirm) {
                            const result = await confirmProcessAction(msg.kind, msg.level ?? undefined, '');
                            this.report(result.ok ? { ok: true } : result);
                        }
                        break;
                    }
                    openProcessAction(this.context, msg.kind, msg.level ?? undefined);
                } else if (msg.kind) {
                    const result = await confirmProcessAction(msg.kind, msg.level ?? undefined, '');
                    this.report(result.ok ? { ok: true } : result);
                }
                break;
            case 'openTemplates':
                openProcessTemplateEditor(this.context);
                break;
            case 'openEditor':
                openProcessEditor(this.context, msg.id || store.state.process || undefined);
                break;
            case 'openDescriptionFile': {
                const entry = store.entry(msg.id || store.state.process);
                if (entry) { openMarkdownBrowser(this.context, entry.mdPath); }
                break;
            }
        }
    }
}

/** Register the PROCESS view. The process editor is registered by processEditor-handler. */
export function registerProcessView(context: vscode.ExtensionContext): void {
    context.subscriptions.push(
        vscode.window.registerWebviewViewProvider(PROCESS_VIEW_ID, new ProcessViewProvider(context), {
            webviewOptions: { retainContextWhenHidden: true },
        }),
    );
}
