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

import { positionProcessLists, NESTED_FOLLOW_UP_LABELS } from '../utils/processStack';
import { ABORT_NESTED_COMMAND } from '../services/nestedProcessCommands';
import { openProcessBranchingEditor } from './processBranching-handler';
import { wireQuestHintMessages } from './questHint-handler';
import * as vscode from 'vscode';

import { ProcessStateStore } from '../managers/processStateStore';
import { ChatVariablesStore } from '../managers/chatVariablesStore';
import { loadWebviewHtml } from '../utils/webviewLoader';
import { conditionText, evaluateCondition, findPhase, findStep, phaseSteps, type ConditionLookup, type ProcessChange, type ProcessConditional, type ProcessDefinition, type ProcessLevel, type ProcessMoveKind, type ProcessState } from '../utils/processDefinition';
import { decisionDialog, positionText, userActionConfirmation } from '../utils/processActionPrompt';
import { openProcessAction } from './processAction-handler';
import { confirmProcessAction, dropHeldStep, moveOnFromHeldStep, decideInDialog } from '../services/processActionService';
import { PromptQueueManager } from '../managers/promptQueueManager';
import { openProcessTemplateEditor } from './processTemplateEditor-handler';
import { openMarkdownBrowser } from './markdownBrowser-handler';
import { openProcessEditor } from './processEditor-handler';
import { handleRunMessage, type RunActionResult, type RunStorePort, type RunUiPort } from '../services/processRunActions';

export const PROCESS_VIEW_ID = 'tomAi.process';

/** The prompt queue, once it is initialised. */
function queueManager(): PromptQueueManager | undefined {
    try { return PromptQueueManager.instance; } catch { return undefined; }
}

class ProcessViewProvider implements vscode.WebviewViewProvider {
    private view?: vscode.WebviewView;
    private subscription?: vscode.Disposable;
    private queueSubscription?: vscode.Disposable;
    private chatSubscription?: vscode.Disposable;

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
        webviewView.onDidDispose(() => { this.subscription?.dispose(); this.queueSubscription?.dispose(); this.chatSubscription?.dispose(); this.view = undefined; });
        // `when:` conditions read chat variables: the moves change with them.
        try { this.chatSubscription = ChatVariablesStore.instance.onDidChange(() => this.send()); } catch { /* not initialised */ }
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
        const run = queue?.stepRunProgress(store.activeQuest, store.levelIndex, store.currentRun);
        const levels = store.levels;
        const lists = positionProcessLists(entry?.definition ?? null, state);
        void this.view.webview.postMessage({
            type: 'state',
            quest: store.activeQuest,
            // The run this window works on, and how many the quest has (vscimpb29): the view names it when there are several.
            run: store.currentRun,
            // The run list at the top: the last changed first, the current one marked (vscimpb42).
            runs: store.runs().map((r) => ({ run: r.run, process: r.process, position: r.position, changed: r.changed, current: r.current })),
            // Every level of the quest's process stack, bottom first (the running one is the last).
            levels: levels.map((l, i) => {
                const def = store.entry(l.process)?.definition ?? null;
                return {
                    index: i,
                    process: l.process,
                    name: def?.name || l.process,
                    kind: l.nested?.kind ?? 'process',
                    position: def ? positionText(def, l) : [l.phase, l.step].filter(Boolean).join(' › '),
                    followUp: l.nested ? NESTED_FOLLOW_UP_LABELS[l.nested.followUp] : '',
                    startedAt: l.nested?.startedAt ?? '',
                    inputs: l.inputs ?? {},
                    outputs: l.outputs ?? {},
                    subOutputs: l.subOutputs ?? {},
                    running: i === levels.length - 1,
                };
            }),
            // What the running step lists to start (the Your turn box's button).
            startable: lists.subprocesses.length + lists.branches.length,
            processes: store.list().map((e) => ({ id: e.id, name: e.definition?.name || e.id, valid: !!e.definition })),
            state,
            definition: entry?.definition ?? null,
            processInvalid: !!entry && !entry.definition,
            description: entry?.description ?? '',
            stepRole: store.currentRole(),
            conditions: entry?.definition ? conditionNotes(entry.definition, state, store.conditionOptions().lookup) : null,
            leftOut: (state.skipped ?? []).slice(-8).reverse().map((r) => ({
                where: entry?.definition ? leftOutWhere(entry.definition, r.phase, r.step) : [r.phase, r.step].filter(Boolean).join(' › '),
                phaseIteration: r.phaseIteration, reason: r.reason, by: r.by, at: r.at,
            })),
            // Where it came from by follow-up processes (vscimpb47), oldest first.
            origins: (state.origins ?? []).map((o) => {
                const from = store.entry(o.process)?.definition;
                return {
                    process: from?.name || o.process,
                    where: from ? leftOutWhere(from, o.phase, o.level === 'step' ? o.step : undefined) : [o.phase, o.level === 'step' ? o.step : ''].filter(Boolean).join(' › '),
                    level: o.level, at: o.at, carried: o.carried ?? {}, context: o.context ?? {},
                };
            }),
            chatRole,
            stepRun: run ? { left: run.left, held: run.held, to: run.move.to, label: run.move.label } : null,
            moves: entry?.definition
                ? store.moves().map((m) => ({
                    kind: m.kind, level: m.level ?? null, label: m.label,
                    // A follow-up leads into another process: its position there.
                    to: m.kind === 'follow-up'
                        ? `${m.target.process} › ${positionText(store.entry(m.target.process)?.definition ?? entry.definition!, m.target)}`
                        : positionText(entry.definition!, m.target),
                    ...(m.branchOption ? { branchOption: true } : {}),
                }))
                : [],
        });
    }

    /** A state set by hand ends a running step: its process-move marker goes. */
    private byHand<T extends { ok: boolean }>(quest: string, run: string, result: T): T {
        if (result.ok) { queueManager()?.dropProcessMoveMarkers(quest, 'state set in the PROCESS view', run); }
        return result;
    }

    private report(result: { ok: boolean; error?: string }): void {
        if (!result.ok && result.error) { void vscode.window.showWarningMessage(`Process: ${result.error}`); }
        this.send();
    }

    private async handle(msg: { type: string; change?: ProcessChange; level?: ProcessLevel; delta?: number; id?: string; kind?: ProcessMoveKind; run?: string }): Promise<void> {
        const store = await ProcessStateStore.ready;
        // The run list: select, create (+), delete (trash).
        const runs = await handleRunMessage(msg, liveRunStore(store), LIVE_RUN_UI);
        if (runs.handled) {
            if (runs.result && !runs.result.ok) { void vscode.window.showWarningMessage(`Process runs: ${runs.result.error}`); }
            this.send();
            return;
        }
        switch (msg.type) {
            case 'ready':
                this.send();
                break;
            case 'change':
                if (!msg.change) { break; }
                // Another process for the quest leaves every level of the stack: ask first.
                if (msg.change.process !== undefined && store.levels.length > 1 && msg.change.process !== store.levels[0].process) {
                    const leave = 'Switch and leave them';
                    const answer = await vscode.window.showWarningMessage(
                        `Switch the quest's process to ${msg.change.process || '— none —'}?`,
                        { modal: true, detail: `${store.levels.length - 1} subprocess / branch level(s) are running above ${store.levels[0].process}. Switching the quest's process leaves every level; nothing is handed back.` },
                        leave,
                    );
                    if (answer !== leave) { this.send(); break; }
                }
                this.report(this.byHand(store.activeQuest, store.currentRun, store.apply(msg.change, 'user')));
                break;
            case 'abortNested':
                await vscode.commands.executeCommand(ABORT_NESTED_COMMAND);
                this.send();
                break;
            case 'openBranching':
                await openProcessBranchingEditor(this.context);
                break;
            case 'dismissSuggestions':
                this.report(store.dismissSuggestions('user'));
                break;
            case 'iteration':
                if (msg.level && msg.delta) { this.report(this.byHand(store.activeQuest, store.currentRun, store.stepIteration(msg.level, msg.delta, 'user'))); }
                break;
            case 'action':
                if (msg.kind === 'proceed') {
                    // A step still running from the last Proceed: nothing to do yet,
                    // unless an item of it failed — then repeat it or move on.
                    const run = queueManager()?.stepRunProgress(store.activeQuest, store.levelIndex, store.currentRun);
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
                    if (def && decisionDialog(def, store.state, store.conditionOptions())) {
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

/** The run actions' store: the process store, a new run created and selected in this window. */
export function liveRunStore(store: ProcessStateStore): RunStorePort {
    const result = (r: { ok: boolean; error?: string }): RunActionResult => (r.ok ? { ok: true } : { ok: false, error: r.error ?? 'failed' });
    return {
        runs: () => store.runs(),
        processes: () => store.list().filter((e) => !!e.definition).map((e) => ({ id: e.id, name: e.definition?.name || e.id })),
        selectRun: (run) => result(store.selectRun(run)),
        createRun: (run, process) => result(store.createRun(run, process, 'user', true)),
        deleteRuns: (runs) => result(store.deleteRuns(runs)),
        runSessions: (runs) => store.runSessions(runs),
        deleteRunSessions: (runs) => store.deleteRunSessions(runs),
    };
}

/** The run actions' pickers. */
const LIVE_RUN_UI: RunUiPort = {
    inputRunName: (validate) => Promise.resolve(vscode.window.showInputBox({
        title: 'New process run',
        prompt: 'The run\'s name — a process position of its own in this quest (e.g. a change id). It becomes this window\'s run.',
        placeHolder: 'e.g. chg-42',
        validateInput: validate,
    })),
    pickProcess: async (items) => {
        const picked = await vscode.window.showQuickPick(items.map((i) => ({ label: i.label, description: i.description, id: i.id })), {
            title: 'The process the run follows', placeHolder: 'A process, or none yet',
        });
        return picked === undefined ? undefined : (picked.id || null);
    },
    pickRuns: async (items) => {
        const picked = await vscode.window.showQuickPick(items.map((i) => ({ label: i.label, description: i.description, run: i.run })), {
            title: 'Delete process runs', placeHolder: 'The runs to delete (default is never deleted)', canPickMany: true,
        });
        return picked?.map((p) => p.run);
    },
    confirm: async (message, detail, button) => (await vscode.window.showWarningMessage(message, { modal: true, detail }, button)) === button,
};

/** A phase's or step's conditional fields as the view shows them: optional, the condition, how it stands now. */
interface ConditionNote { optional: boolean; when: string; verdict: string }

function noteOf(node: ProcessConditional | undefined, lookup: ConditionLookup): ConditionNote | null {
    if (!node || (!node.optional && !node.when)) { return null; }
    const verdict = node.when ? evaluateCondition(node.when, lookup) : '';
    return {
        optional: node.optional === true,
        // Plain text: the view escapes it; the backticks of conditionText are dropped.
        when: node.when ? conditionText(node.when).replace(/`/g, '') : '',
        verdict: verdict === 'holds' ? 'holds now' : verdict === 'fails' ? 'does not hold now' : verdict === 'judge' ? 'the agent judges it at Proceed' : '',
    };
}

/** The notes of the current phase and of each of its steps (by id). */
export function conditionNotes(def: ProcessDefinition, state: ProcessState, lookup: ConditionLookup = () => undefined): { phase: ConditionNote | null; steps: Record<string, ConditionNote> } {
    const phase = findPhase(def, state.phase);
    const steps: Record<string, ConditionNote> = {};
    for (const e of phase ? phaseSteps(phase) : []) {
        const note = e.kind === 'gate' ? null : noteOf(e.step, lookup);
        if (note) { steps[e.step.id] = note; }
    }
    return { phase: noteOf(phase, lookup), steps };
}

function leftOutWhere(def: ProcessDefinition, phaseId: string, stepId?: string): string {
    const phase = findPhase(def, phaseId);
    const step = stepId ? findStep(phase, stepId) : undefined;
    return [phase?.name || phaseId, stepId ? step?.name || stepId : ''].filter(Boolean).join(' › ');
}

/** Register the PROCESS view. The process editor is registered by processEditor-handler. */
export function registerProcessView(context: vscode.ExtensionContext): void {
    context.subscriptions.push(
        vscode.window.registerWebviewViewProvider(PROCESS_VIEW_ID, new ProcessViewProvider(context), {
            webviewOptions: { retainContextWhenHidden: true },
        }),
    );
}
