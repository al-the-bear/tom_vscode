/**
 * PROCESS — the @TOM sidebar view showing where the active quest is in its
 * process: process, phase, step and sub-step (dropdowns), their iterations
 * (− / +), the role the step names, the post-gate todos, and each one's
 * description behind a `?` button. The action bar at the top offers the moves
 * the process allows from here. Proceed (the only one that runs anything)
 * opens the action page (processAction-handler.ts), which queues the prompt of
 * the current position and a process-move marker after it; the state moves
 * on — or, at a decision point, stays marked as run — when the queue reaches
 * the marker with the step's items done. Until then the view shows the step
 * running ("⏳ running — N items left", Proceed disabled); a failed item holds
 * the marker ("failed — see the queue"), and Proceed then offers to repeat the
 * step or move on. Setting the state by hand removes the marker. At a decision position (after a gate, a phase's end or a
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

import { wireQuestHintMessages } from './questHint-handler';
import * as vscode from 'vscode';

import { ProcessStateStore } from '../managers/processStateStore';
import { ChatVariablesStore } from '../managers/chatVariablesStore';
import { loadWebviewHtml } from '../utils/webviewLoader';
import type { ProcessChange, ProcessLevel, ProcessMoveKind } from '../utils/processDefinition';
import { decisionDialog, positionText, userActionConfirmation } from '../utils/processActionPrompt';
import { openProcessAction } from './processAction-handler';
import { confirmProcessAction, dropHeldStep, moveOnFromHeldStep, decideInDialog } from '../services/processActionService';
import { PromptQueueManager } from '../managers/promptQueueManager';
import { openProcessTemplateEditor } from './processTemplateEditor-handler';
import { openMarkdownBrowser } from './markdownBrowser-handler';
import { openProcessEditor } from './processEditor-handler';

export const PROCESS_VIEW_ID = 'tomAi.process';

/** The prompt queue, once it is initialised. */
function queueManager(): PromptQueueManager | undefined {
    try { return PromptQueueManager.instance; } catch { return undefined; }
}

class ProcessViewProvider implements vscode.WebviewViewProvider {
    private view?: vscode.WebviewView;
    private subscription?: vscode.Disposable;
    private queueSubscription?: vscode.Disposable;

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
        // The "no quest is open" banner (media/shared/questHint.js).
        this.context.subscriptions.push(wireQuestHintMessages(webviewView.webview));
        webviewView.onDidChangeVisibility(() => { if (webviewView.visible) { this.send(); } });
        webviewView.onDidDispose(() => { this.subscription?.dispose(); this.queueSubscription?.dispose(); this.view = undefined; });
        // A running step's progress follows the queue.
        this.queueSubscription = queueManager()?.onDidChange(() => this.send());
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
        const queue = queueManager();
        // The queue may start after the view: subscribe once it is there.
        if (queue && !this.queueSubscription) { this.queueSubscription = queue.onDidChange(() => this.send()); }
        const run = queue?.stepRunProgress(store.activeQuest, store.levelIndex);
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
            stepRun: run ? { left: run.left, held: run.held, to: run.move.to, label: run.move.label } : null,
            moves: entry?.definition
                ? store.moves().map((m) => ({
                    kind: m.kind, level: m.level ?? null, label: m.label, to: positionText(entry.definition!, m.target),
                    ...(m.branchOption ? { branchOption: true } : {}),
                }))
                : [],
        });
    }

    /** A state set by hand ends a running step: its process-move marker goes. */
    private byHand<T extends { ok: boolean }>(quest: string, result: T): T {
        if (result.ok) { queueManager()?.dropProcessMoveMarkers(quest, 'state set in the PROCESS view'); }
        return result;
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
                if (msg.change) { this.report(this.byHand(store.activeQuest, store.apply(msg.change, 'user'))); }
                break;
            case 'iteration':
                if (msg.level && msg.delta) { this.report(this.byHand(store.activeQuest, store.stepIteration(msg.level, msg.delta, 'user'))); }
                break;
            case 'action':
                if (msg.kind === 'proceed') {
                    // A step still running from the last Proceed: nothing to do yet,
                    // unless an item of it failed — then repeat it or move on.
                    const run = queueManager()?.stepRunProgress(store.activeQuest, store.levelIndex);
                    if (run && !run.held) {
                        void vscode.window.showInformationMessage(`The step is still running — ${run.left} item(s) left in the queue; the process moves to ${run.move.to} when they are done.`);
                        break;
                    }
                    if (run) {
                        const repeat = 'Repeat the step';
                        const moveOn = `Move on (${run.move.label})`;
                        const picked = await vscode.window.showWarningMessage(
                            'An item of this step failed — see the queue.',
                            { modal: true, detail: `Repeat the step queues its prompt again; Move on goes to ${run.move.to} as if the step had finished.` },
                            repeat, moveOn,
                        );
                        if (picked === moveOn) { this.report(await moveOnFromHeldStep()); break; }
                        if (picked !== repeat) { break; }
                        await dropHeldStep();
                    }
                    const def = store.currentDefinition();
                    // A decision runs nothing: the user picks how the process goes on.
                    if (def && decisionDialog(def, store.state)) {
                        const { result } = await decideInDialog(this.context);
                        if (result) { this.report(result.ok ? { ok: true } : result); }
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
