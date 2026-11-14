/**
 * Process actions — what happens when the user uses the PROCESS view's action
 * bar. Proceed: the Proceed template (processActionPrompt.ts) is resolved for
 * the CURRENT position and the prompt is added to the prompt queue carrying
 * that position and a fresh Proceed run id, followed by a process-move marker
 * (src/utils/processMoveMarker.ts). Everything the step's prompts queue goes
 * in before the marker; when the queue reaches it with all of them sent, the
 * state moves on — or, at a decision point, stays marked as run. Until then
 * the step is running. Every other move only moves the state (and removes an
 * open marker), and so does Proceed at a user action (confirmed by the user in
 * the PROCESS view).
 *
 * The preview on the action page and the queued text come from the same
 * {@link buildProcessActionPrompt}, so what the page shows is what is queued.
 */

import * as vscode from 'vscode';

import { ProcessStateStore } from '../managers/processStateStore';
import type { ProcessRun } from './processRunContext';
import { DEFAULT_RUN } from '../utils/processRuns';
import { PromptQueueManager } from '../managers/promptQueueManager';
import { loadSendToChatConfig, saveSendToChatConfig } from '../utils/sendToChatConfig';
import { resolveVariables } from '../utils/variableResolver';
import { ensureSession } from './agentSdkSessionStore';
import { lookupProfile, type ProfileSection } from '../utils/sessionSpecs';
import { normalizeSessionMode } from '../utils/agentSdkSessions';
import { TwoTierMemoryService } from './memory-service';
import * as fs from 'fs';
import { buildAssistPrompt } from '../utils/assistPrompts';
import { liveAssistDeps } from './assistLiveDeps';
import {
    DECISION_HELPER_LABELS, decisionDialogButtons, decisionText, interpretDecisionPick, runDecisionHelper,
    type DecisionHelperDeps, type DecisionHelperUse,
} from './decisionHelpers';
import { WsPaths } from '../utils/workspacePaths';
import { finishReviewRound, finishReviewUnavailable, type FinishReviewDeps, type FinishReviewOutcome } from './finishReviewRound';
import { gateDecisionOptions, gateDecisionUnavailable, takeGateDecision, type GateDecisionDeps, type GateDecisionOutcome } from './gateDecision';
import {
    actionSession,
    decisionDialog,
    DEFAULT_PROCESS_ACTION_TEMPLATES,
    PROCESS_TEMPLATE_KINDS,
    processActionTemplate,
    processActionValues,
    type ProcessActionTemplates,
} from '../utils/processActionPrompt';
import { decisionAt, samePosition, userActionAt, type ProcessLevel, type ProcessMove, type ProcessMoveKind } from '../utils/processDefinition';
import { positionText, reviewFileName } from '../utils/processActionPrompt';
import { markerText, newProceedId, type ProcessMoveSpec } from '../utils/processMoveMarker';
import type { QueuedPrompt } from '../managers/promptQueueManager';

const templatesChanged = new vscode.EventEmitter<void>();
/** Fires after the templates were saved, so an open action page refreshes its preview. */
export const onDidChangeProcessActionTemplates: vscode.Event<void> = templatesChanged.event;

/** The configured template (left out: the default). */
export function configuredProcessActionTemplates(): ProcessActionTemplates {
    const raw = (loadSendToChatConfig()?.processActionTemplates ?? {}) as Record<string, unknown>;
    return typeof raw.proceed === 'string' ? { proceed: raw.proceed } : {};
}

/** Store the template; one equal to its default is dropped, so it follows later default changes. */
export function saveProcessActionTemplates(templates: ProcessActionTemplates): boolean {
    const config = loadSendToChatConfig();
    if (!config) { return false; }
    const own: ProcessActionTemplates = {};
    for (const kind of PROCESS_TEMPLATE_KINDS) {
        const text = templates[kind];
        if (typeof text === 'string' && text !== DEFAULT_PROCESS_ACTION_TEMPLATES[kind]) { own[kind] = text; }
    }
    config.processActionTemplates = own;
    const saved = saveSendToChatConfig(config);
    if (saved) { templatesChanged.fire(); }
    return saved;
}

/** The prompt Proceed queues with these custom instructions; `''` for another move or a template that resolves to nothing. */
export function buildProcessActionPrompt(
    store: ProcessStateStore,
    move: ProcessMove,
    customInstructions: string,
    templateOverride?: string,
    sessionOverride?: string,
): string {
    const def = store.currentDefinition();
    if (!def || move.kind !== 'proceed') { return ''; }
    const template = templateOverride ?? processActionTemplate('proceed', configuredProcessActionTemplates());
    if (!template.trim()) { return ''; }
    const values = processActionValues(def, store.state, move, customInstructions, store.processDescription());
    // `${session}`: the session the prompt is queued in (picked on the page or named by the process).
    values.session = actionSession(def, store.state, sessionOverride, store.inheritedSession?.(), store.currentRun).name;
    // `${finish-review-round}`: the Assist prompt a closing item shows the results with
    // (tomAi_askInMdBrowser + Finish review round). The review is the position this move leads to.
    const review = userActionAt(def, move.target) ? move.target : store.state;
    values['finish-review-round'] = buildAssistPrompt(loadSendToChatConfig()?.assistPrompts, 'finishReviewRound', {
        process: def.id,
        step: positionText(def, review),
        resultsFile: 'the document this step produced',
        reviewFile: reviewFileName(review),
    });
    // `${gate-decision}`: the Assist prompt a gate's prompt ends with — its result shown with the
    // buttons of the decision after the gate (tomAi_askInMdBrowser + gateDecision).
    values['gate-decision'] = buildAssistPrompt(loadSendToChatConfig()?.assistPrompts, 'gateDecision', {
        process: def.id,
        step: positionText(def, store.state),
        resultsFile: 'the gate\'s result document',
    });
    return resolveVariables(template, { values }).trim();
}

/**
 * Make sure the session the process names exists: created from the
 * definition's spec when missing (its base first, plainly, when that is
 * missing too). A session picked on the page exists already.
 */
function ensureProcessSession(questId: string, spec: { name: string; basedOn?: string; mode?: string; profile?: string }): string | undefined {
    const folder = TwoTierMemoryService.instance.agentSdkSessionsFolder(questId || undefined);
    const section = loadSendToChatConfig()?.anthropic as ProfileSection | undefined;
    const made = ensureSession(
        folder,
        { name: spec.name, basedOn: spec.basedOn, mode: normalizeSessionMode(spec.mode), profile: spec.profile },
        (id) => lookupProfile(section, id),
    );
    return made.ok ? undefined : made.error;
}

export type ProcessActionResult =
    | { ok: true; queued: boolean; label: string }
    | { ok: false; error: string };

/**
 * Confirm a move. Proceed: build the prompt of the current position, queue it
 * (carrying that position and a fresh Proceed run id, so it runs as that step)
 * and after it the process-move marker that moves the state once the step's
 * queued items are done. A step that queues no prompt (a user action) moves at
 * once. Any other move removes an open marker of the quest and moves the
 * state. Nothing changes when the move is no longer possible, and Proceed is
 * refused while the step still runs.
 */
export async function confirmProcessAction(
    kind: ProcessMoveKind,
    level: ProcessLevel | undefined,
    customInstructions: string,
    sessionOverride?: string,
    /** A `follow-up` option: which one (ProcessMove.followUp.key). */
    followUpKey?: string,
): Promise<ProcessActionResult> {
    const store = await ProcessStateStore.ready;
    const move = store.findMove(kind, level, followUpKey);
    const def = store.currentDefinition();
    if (!move || !def) { return { ok: false, error: 'this move is no longer possible at the current position' }; }
    const queue = PromptQueueManager.instance;
    if (move.kind !== 'proceed') {
        // A follow-up's call context is resolved by the placeholder engine as the decision sees it.
        const moved = store.move(kind, level, 'user', move.kind === 'follow-up' ? { key: move.followUp?.key, resolve: (text) => resolveVariables(text) } : undefined);
        if (moved.ok) { queue.dropProcessMoveMarkers(store.activeQuest, `${move.label} by hand`, store.currentRun); }
        return moved.ok ? { ok: true, queued: false, label: move.label } : moved;
    }
    // Only the running level's step counts: a step below a subprocess may still have items queued,
    // and this level's first prompt goes in behind them (one level feeds the queue at a time).
    const running = queue.stepRunProgress(store.activeQuest, store.levelIndex, store.currentRun);
    if (running) {
        return { ok: false, error: running.held
            ? 'an item of the running step failed: repeat the step or move on (Proceed in the PROCESS view)'
            : `the step is still running — ${running.left} item(s) left in the queue; the process moves to ${running.move.to} when they are done` };
    }
    const here = store.state;
    if (decisionAt(def, here, store.conditionOptions())) {
        return { ok: false, error: 'this is a decision: pick how the process goes on (repeat, go on, gate passed or failed) in the PROCESS view' };
    }
    const session = actionSession(def, here, sessionOverride, store.inheritedSession(), store.currentRun);
    // A user action is done by the user: confirming it queues nothing.
    const text = userActionAt(def, here) ? '' : buildProcessActionPrompt(store, move, customInstructions, undefined, sessionOverride);
    if (!text) {
        const moved = store.move(kind, level, 'user');
        return moved.ok ? { ok: true, queued: false, label: move.label } : moved;
    }
    if (session.spec) {
        const error = ensureProcessSession(store.activeQuest, session.spec);
        if (error) { return { ok: false, error: `the session "${session.name}" could not be created: ${error}` }; }
    }
    const run = { quest: store.activeQuest, state: here, proceedId: newProceedId(), level: store.levelIndex, ...(store.currentRun !== DEFAULT_RUN ? { run: store.currentRun } : {}) };
    const spec: ProcessMoveSpec = { kind: move.kind, ...(move.level ? { level: move.level } : {}), label: move.label, to: positionText(def, move.target) };
    try {
        // Both deferred, then one kick: the prompt's send must not hold this
        // call (and the marker must be in the queue before anything it queues).
        await queue.enqueue({ originalText: text, ...(session.name ? { session: session.name } : {}), processRun: run, deferSend: true });
        await queue.enqueue({ originalText: markerText(spec), processRun: run, processMove: spec, deferSend: true });
    } catch (e) {
        return { ok: false, error: `the prompt could not be queued, the state did not move: ${(e as Error).message}` };
    }
    // sendNext starts only the runs whose auto-send is on (queue settings per run).
    void queue.sendNext();
    return { ok: true, queued: true, label: move.label };
}

/**
 * What a process-move marker does when the queue reaches it with its step's
 * items done: make its move from the position it was queued at. When the
 * state has been moved elsewhere since, the marker has nothing left to do.
 */
export async function applyProcessMoveMarker(marker: QueuedPrompt): Promise<{ ok: true } | { ok: false; error: string }> {
    const store = await ProcessStateStore.ready;
    const run = marker.processRun;
    const spec = marker.processMove;
    if (!run || !spec) { return { ok: false, error: 'the marker names no move' }; }
    if (store.activeQuest !== run.quest) { return { ok: false, error: `the quest ${run.quest} is not this window's quest` }; }
    // The run it was queued for, whichever run the window works on now.
    return store.withRun(run.run, () => applyMarkerToRun(store, run, spec));
}

function applyMarkerToRun(store: ProcessStateStore, run: ProcessRun, spec: ProcessMoveSpec): { ok: true } | { ok: false; error: string } {
    const now = store.state;
    // Only the level it was queued for, while it is the running one: a step below a subprocess waits for it.
    if ((run.level ?? 0) !== store.levelIndex) { return { ok: true }; }
    if (now.decision || now.nestedEnded || !samePosition(now, run.state)) { return { ok: true }; }
    // The agent suggested processes at the end of the step (C-28): the move waits for the user's choice,
    // and the process branching editor opens now that the step's queue items are done.
    if (now.suggestions?.length) {
        const held = store.holdForSuggestions({ kind: spec.kind, ...(spec.level ? { level: spec.level } : {}), label: spec.label }, 'user');
        if (held.ok) { suggestionsDue(); }
        return held.ok ? { ok: true } : held;
    }
    const moved = store.move(spec.kind, spec.level, 'user');
    return moved.ok ? { ok: true } : moved;
}

let suggestionsDueHandler: () => void = () => undefined;

/** What happens when a step's suggestions are due: the extension opens the process branching editor. */
export function onSuggestionsDue(handler: () => void): void {
    suggestionsDueHandler = handler;
}

/** The running step's suggestions are due now (its run finished, or none was running when they came). */
export function suggestionsDue(): void {
    try { suggestionsDueHandler(); } catch { /* the page is a convenience: the view lists them too */ }
}

/** Let the queue's process-move markers move the process (called once at activation). */
export function installProcessMoveMarkers(): void {
    PromptQueueManager.instance.setProcessMoveHandler(applyProcessMoveMarker);
}

/** A held step: repeat it — the marker goes, and the action page queues the step again. */
export async function dropHeldStep(): Promise<void> {
    const store = await ProcessStateStore.ready;
    PromptQueueManager.instance.dropProcessMoveMarkers(store.activeQuest, 'step repeated', store.currentRun);
}

/** A held step: move on — the marker goes and its move is made now. */
export async function moveOnFromHeldStep(): Promise<ProcessActionResult> {
    const store = await ProcessStateStore.ready;
    const queue = PromptQueueManager.instance;
    const running = queue.stepRunProgress(store.activeQuest, store.levelIndex, store.currentRun);
    if (!running) { return { ok: false, error: 'no step of this quest is running' }; }
    const marker = queue.items.find((i) => i.id === running.markerId);
    queue.dropProcessMoveMarkers(store.activeQuest, 'moved on past a failed step', store.currentRun);
    const result = marker ? await applyProcessMoveMarker(marker) : { ok: false as const, error: 'the marker is gone' };
    return result.ok ? { ok: true, queued: false, label: running.move.label } : result;
}

/**
 * The decision dialog of the PROCESS view: the options of the decision the
 * quest is at, one picked and made. Answers the label picked (undefined when
 * dismissed, or when the quest is at no decision) and what the move did.
 */
export async function decideInDialog(context?: vscode.ExtensionContext): Promise<{ picked?: string; result?: ProcessActionResult; helper?: DecisionHelperUse }> {
    const store = await ProcessStateStore.ready;
    const def = store.currentDefinition();
    const decide = def ? decisionDialog(def, store.state, store.conditionOptions()) : null;
    if (!decide) { return {}; }
    // With the extension's context the dialog also offers the helpers (Grill me, Explain a decision).
    const labels = decide.options.map((o) => o.label);
    const buttons = context ? decisionDialogButtons(labels) : labels;
    const detail = context ? `${decide.detail} Grill me and Explain a decision give advice in a note; the decision stays yours and opens again.` : decide.detail;
    // It decides for the run the PROCESS view works on (store.currentRun): named, so with several runs at a
    // decision the user sees whose it is (vscimpb81).
    const message = store.currentRun && store.currentRun !== 'default' ? `Run ${store.currentRun}: ${decide.message}` : decide.message;
    const picked = await vscode.window.showInformationMessage(message, { modal: true, detail }, ...buttons);
    const pick = interpretDecisionPick(picked, decide.options);
    if (pick.kind === 'helper' && context) {
        void runDecisionHelper(liveDecisionHelperDeps(context), pick.use).then((outcome) => {
            if (!outcome.ok) { void vscode.window.showWarningMessage(`${DECISION_HELPER_LABELS[pick.use]}: ${outcome.error}`); }
        });
        return { helper: pick.use };
    }
    if (pick.kind !== 'option') { return {}; }
    return { picked: pick.option.label, result: await confirmProcessAction(pick.option.kind, pick.option.level, '', undefined, pick.option.followUp?.key) };
}

/** Reopen the decision (the note's button, the end of a helper's turn); a failed move is reported. */
export async function reopenDecision(context: vscode.ExtensionContext): Promise<void> {
    const { result } = await decideInDialog(context);
    if (result && !result.ok) { void vscode.window.showWarningMessage(`Process: ${result.error}`); }
}

/** The decision helpers' live collaborators: the shared assist deps, the process store, the dialog. */
export function liveDecisionHelperDeps(context: vscode.ExtensionContext): DecisionHelperDeps {
    const store = (): ProcessStateStore | undefined => ProcessStateStore.instance;
    const dialog = () => {
        const s = store();
        const def = s?.currentDefinition();
        return s && def ? { s, def, decide: decisionDialog(def, s.state, s.conditionOptions()) } : undefined;
    };
    return {
        ...liveAssistDeps(context),
        context: () => {
            const d = dialog();
            if (!d?.decide) { return undefined; }
            return { quest: d.s.activeQuest, process: d.def.id, position: positionText(d.def, d.s.state), decision: decisionText(d.decide.message, d.decide.options) };
        },
        questFolder: (quest) => WsPaths.ai('quests', quest) ?? '',
        ensureDir: (abs) => { fs.mkdirSync(abs, { recursive: true }); },
        reopenDecision: () => reopenDecision(context),
        isAtDecision: () => !!dialog()?.decide,
    };
}

/** Finish review round's live collaborators: the process store, the queue, the decision dialog. */
export function liveFinishReviewDeps(store: ProcessStateStore, context?: vscode.ExtensionContext): FinishReviewDeps {
    const queue = (): PromptQueueManager | undefined => { try { return PromptQueueManager.instance; } catch { return undefined; } };
    return {
        definition: () => store.currentDefinition(),
        state: () => store.state,
        runningStepTarget: () => {
            const run = queue()?.stepRunProgress(store.activeQuest, store.levelIndex, store.currentRun);
            const marker = run ? queue()?.items.find((i) => i.id === run.markerId) : undefined;
            const spec = marker?.processMove;
            return spec ? store.findMove(spec.kind, spec.level)?.target : undefined;
        },
        completeRunningStep: async () => moveOnFromHeldStep(),
        proceed: () => confirmProcessAction('proceed', undefined, ''),
        decide: async () => {
            const { picked, result } = await decideInDialog(context);
            if (result && !result.ok) { void vscode.window.showWarningMessage(`Process: ${result.error}`); }
            return picked;
        },
        where: (state) => { const def = store.currentDefinition(); return def ? positionText(def, state) : ''; },
    };
}

/** The gate decision's live collaborators (vscimpb85): the running step as Finish review round reads it, Decide…'s move. */
export function liveGateDecisionDeps(store: ProcessStateStore): GateDecisionDeps {
    const review = liveFinishReviewDeps(store);
    return {
        definition: () => store.currentDefinition(),
        state: () => store.state,
        conditions: () => store.conditionOptions(),
        runningStepTarget: review.runningStepTarget,
        completeRunningStep: review.completeRunningStep,
        take: async (label) => {
            const taken = await takeDecisionOption(label);
            return taken.ok ? { ok: true } : taken;
        },
        where: review.where,
    };
}

/** Why the gate decision cannot be offered now (undefined: it can). */
export function gateDecisionUnavailableNow(): string | undefined {
    const store = ProcessStateStore.instance;
    return store ? gateDecisionUnavailable(liveGateDecisionDeps(store)) : 'the process store is not initialised';
}

/** The choices of the decision after the running gate (or of the gate's decision), as Decide… shows them. */
export function gateDecisionOptionLabels(): string[] {
    const store = ProcessStateStore.instance;
    return store ? gateDecisionOptions(liveGateDecisionDeps(store)) : [];
}

/** A gate decision's click: end the gate's step, take the choice. */
export async function runGateDecision(label: string): Promise<GateDecisionOutcome> {
    return takeGateDecision(liveGateDecisionDeps(await ProcessStateStore.ready), label);
}

/** Why Finish review round cannot be offered now (undefined: it can). */
export function finishReviewUnavailableNow(): string | undefined {
    const store = ProcessStateStore.instance;
    return store ? finishReviewUnavailable(liveFinishReviewDeps(store)) : 'the process store is not initialised';
}

/** The Finish review round click. */
export async function runFinishReviewRound(context?: vscode.ExtensionContext): Promise<FinishReviewOutcome> {
    return finishReviewRound(liveFinishReviewDeps(await ProcessStateStore.ready, context));
}

/** The options of the decision the quest is at, as the Decide… dialog shows them ([] when at none). */
export function decisionOptionLabels(): string[] {
    const store = ProcessStateStore.instance;
    const def = store?.currentDefinition();
    const decide = store && def ? decisionDialog(def, store.state, store.conditionOptions()) : null;
    return decide ? decide.options.map((o) => o.label) : [];
}

/**
 * Take the decision's option `label` — what picking it in the Decide… dialog
 * does (an advice note's button). A decision that has moved on, or no longer
 * offers the option, is reported and nothing is moved.
 */
export async function takeDecisionOption(label: string): Promise<ProcessActionResult> {
    const store = await ProcessStateStore.ready;
    const def = store.currentDefinition();
    const decide = def ? decisionDialog(def, store.state, store.conditionOptions()) : null;
    const option = decide?.options.find((o) => o.label === label);
    const result: ProcessActionResult = option
        ? await confirmProcessAction(option.kind, option.level, '', undefined, option.followUp?.key)
        : { ok: false, error: decide ? `the decision no longer offers "${label}"` : 'the process is not at a decision any more' };
    if (!result.ok) { void vscode.window.showWarningMessage(`Process: ${result.error}`); }
    return result;
}

/** Why the decision cannot be reopened from a note now (undefined: it can). */
export function reopenDecisionUnavailableNow(): string | undefined {
    const store = ProcessStateStore.instance;
    const def = store?.currentDefinition();
    if (!store || !def) { return 'the quest has no process set'; }
    return decisionDialog(def, store.state, store.conditionOptions()) ? undefined : 'the process is not at a decision';
}

