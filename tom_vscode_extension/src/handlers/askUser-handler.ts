/**
 * Live bridge for `tomAi_askUser` — wires the vscode-free tool impl
 * (`ask-user-tool.ts`) and registry (`askUserRegistry.ts`) into the editor:
 * the question in the user-input panel on its run's tab (userInteractionPanel.ts,
 * one open question per process run, vscimpb81), plus a Telegram notification
 * so the user can answer from their phone. When the ask resolves by *any*
 * source (vscode submit, Telegram reply, timeout, cancel — also the cancel
 * when the prompt that asked ends, services/askOwners.ts) the registry calls
 * {@link onResolve}, which takes it out of the panel.
 */

import * as vscode from 'vscode';
import { bridgeLog } from './handler_shared';
import { debugLog } from '../utils/debugLogger';
import { userInteractions } from '../services/userInteractions';
import { initUserInteractionPanel, SHOW_PENDING_QUESTION_COMMAND, showUserInteractions } from './userInteractionPanel';
import { AskUserRegistry, PendingAsk, AskAnswerSource } from '../services/askUserRegistry';
import { appendQuestionLogEntry } from '../services/questionsLog';
import { readChatQuestionsConfig } from './chatQuestions-config';
import { telegramNotifyTarget } from './telegram-config';
import {
    ASK_USER_TOOL as ASK_USER_DEF,
    AskUserInput,
    AskUserDeps,
    askUserImpl,
    choiceClickAnswerAsync,
} from '../tools/ask-user-tool';
import { NESTED_FOLLOW_UP_LABELS } from '../utils/processStack';
import { composeChoiceAnswers, questionText, type AskChoice, type ChoiceContext, type MoveOutcome, type QuestionAnswer, type StartOutcome } from '../utils/askChoices';
import { EMPTY_PROCESS_STATE, type ProcessChange } from '../utils/processDefinition';
import { SharedToolDefinition } from '../tools/shared-tool-registry';

// ===========================================================================
// The question in the user-input panel
// ===========================================================================

/** The questions shown in the user-input panel (tests, diagnostics). */
export function openQuestionIds(): string[] {
    return userInteractions.list().filter((i) => i.kind === 'question').map((i) => i.id);
}

/** Whether question `requestId` is still open. */
function isOpen(requestId: string): boolean {
    return AskUserRegistry.instance.pendingById(requestId) !== undefined;
}

/**
 * The panel's answer to question `pending`: its text (Submit), its answers
 * (Send answers: every question's selected answer choice and own words), or a
 * choice button (a move / branch / subprocess is carried out here, then it
 * answers; one that throws still answers, with the error).
 */
async function answerFromPanel(pending: PendingAsk, msg: Record<string, unknown>): Promise<void> {
    if (!isOpen(pending.requestId)) { return; }
    if (msg.type === 'submit') {
        AskUserRegistry.instance.submit(pending.requestId, typeof msg.text === 'string' ? msg.text : '', 'vscode');
        return;
    }
    if (msg.type === 'answers') {
        const answers = Array.isArray(msg.answers) ? (msg.answers as QuestionAnswer[]) : [];
        AskUserRegistry.instance.submit(
            pending.requestId,
            composeChoiceAnswers(pending.questions, pending.choices, answers, typeof msg.text === 'string' ? msg.text : ''),
            'vscode',
        );
        return;
    }
    let answer: string | undefined;
    try {
        answer = await choiceClickAnswerAsync(liveAskUserDeps, pending, String(msg.choiceId ?? ''));
    } catch (err) {
        answer = `The choice could not be carried out: ${(err as Error).message}`;
    }
    // The question may have closed meanwhile (its prompt ended while the user chose a follow-up).
    if (!isOpen(pending.requestId)) { return; }
    AskUserRegistry.instance.submit(pending.requestId, answer ?? `Unknown choice "${String(msg.choiceId ?? '')}".`, 'vscode');
}

/** Show question `pending` in the user-input panel, on its run's tab (vscimpb81). */
function openQuestion(pending: PendingAsk): void {
    userInteractions.add({
        id: pending.requestId,
        kind: 'question',
        run: pending.run,
        ...(pending.queueItemId ? { queueItemId: pending.queueItemId } : {}),
        createdAt: pending.createdAt,
        title: pending.title ?? 'The assistant has some questions',
        data: {
            requestId: pending.requestId,
            questions: pending.questions,
            title: pending.title,
            timeoutAt: pending.timeoutAt,
            choices: pending.choices,
            layout: pending.layout,
        },
        respond: (msg) => { void answerFromPanel(pending, msg); },
    });
}

/** The question was answered, timed out or cancelled: it leaves the panel. */
function closeQuestion(pending: PendingAsk, source: AskAnswerSource): void {
    userInteractions.remove(pending.requestId);
    debugLog(`askUser ${pending.requestId} (run ${pending.run}) settled: ${source}`, 'INFO', 'askUser');
}

/**
 * The panel's questions follow the registry, whoever asked through it: every
 * pending question is shown, every resolved one leaves.
 */
function syncQuestions(): void {
    const pending = AskUserRegistry.instance.getAllPending();
    const ids = new Set(pending.map((p) => p.requestId));
    for (const p of pending) {
        if (!userInteractions.get(p.requestId)) { openQuestion(p); }
    }
    for (const i of userInteractions.list()) {
        if (i.kind === 'question' && !ids.has(i.id)) { userInteractions.remove(i.id); }
    }
}
AskUserRegistry.instance.onDidChange(syncQuestions);

// ===========================================================================
// Telegram notification
// ===========================================================================

/** Send the questions to the configured Telegram chat (best-effort, no-op when unconfigured). */
function sendAskTelegram(pending: PendingAsk): void {
    const tg = telegramNotifyTarget();
    if (!tg) { return; }

    const lines: string[] = [];
    lines.push('🙋 The assistant has some questions:');
    if (pending.title) { lines.push('', pending.title); }
    lines.push('');
    pending.questions.forEach((q, i) => lines.push(`${i + 1}. ${questionText(q, pending.choices)}`));
    if (pending.choices.length) {
        lines.push('', `Choices (buttons in VS Code; a move is made there on the click): ${pending.choices.map((c) => c.label).join(' · ')}`);
    }
    // Several runs may ask at once (vscimpb81): a question of another run than `default` names it, and the
    // reply names the run when more than one question is open.
    if (pending.run !== 'default') { lines.splice(1, 0, `(run ${pending.run})`); }
    lines.push('', AskUserRegistry.instance.getAllPending().length > 1
        ? `Reply with "${pending.run}: <your answer>" — questions of several runs are open.`
        : 'Reply with your answer (you can address the questions by number).');
    const text = lines.join('\n');

    void (async () => {
        try {
            const url = `https://api.telegram.org/bot${tg.token}/sendMessage`;
            const resp = await fetch(url, {
                method: 'POST',
                // eslint-disable-next-line @typescript-eslint/naming-convention
                headers: { 'Content-Type': 'application/json' },
                // eslint-disable-next-line @typescript-eslint/naming-convention -- Telegram's field
                body: JSON.stringify({ chat_id: tg.chatId, text }),
            });
            if (!resp.ok) {
                bridgeLog(`[askUser] Telegram notify failed: HTTP ${resp.status}`, 'ERROR');
            }
        } catch (err) {
            bridgeLog(`[askUser] Telegram notify error: ${(err as Error).message}`, 'ERROR');
        }
    })();
}

// ===========================================================================
// Live deps + tool
// ===========================================================================

/** The process store, required lazily (it pulls in the manager layer). */
function processStore(): { activeQuest: string; currentRun: string; state: ChoiceContext['state']; currentDefinition(): ChoiceContext['def']; apply(change: ProcessChange, source: 'user'): { ok: boolean; error?: string; state?: ChoiceContext['state'] } } | undefined {
    try {
        // eslint-disable-next-line @typescript-eslint/no-require-imports
        return require('../managers/processStateStore.js').ProcessStateStore.instance;
    } catch {
        return undefined;
    }
}

function liveProcessContext(): ChoiceContext {
    const store = processStore();
    return store ? { def: store.currentDefinition(), state: store.state } : { def: null, state: { ...EMPTY_PROCESS_STATE } };
}

/** A clicked move: the user's change, as the PROCESS view makes it — a running step's marker goes too. */
function liveMoveTo(change: ProcessChange): MoveOutcome {
    const store = processStore();
    if (!store) { return { ok: false, error: 'the process store is not initialised' }; }
    const result = store.apply(change, 'user');
    if (!result.ok) { return { ok: false, error: result.error }; }
    try {
        // eslint-disable-next-line @typescript-eslint/no-require-imports
        require('../managers/promptQueueManager.js').PromptQueueManager.instance?.dropProcessMoveMarkers(store.activeQuest, 'state set by a choice in a question', store.currentRun);
    } catch { /* no queue: nothing to drop */ }
    const def = store.currentDefinition();
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { positionText } = require('../utils/processActionPrompt.js') as typeof import('../utils/processActionPrompt');
    return { ok: true, where: def && result.state ? positionText(def, result.state) : undefined };
}

/** A clicked branch / subprocess: started as the PROCESS view starts one (startFromChoice). */
async function liveStartNested(kind: 'branch' | 'subprocess', process: string): Promise<StartOutcome> {
    const store = processStore();
    if (!store) { return { ok: false, error: 'the process store is not initialised' }; }
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const nested = require('../services/nestedProcessCommands.js') as typeof import('../services/nestedProcessCommands');
    const outcome = await nested.startFromChoice(store as unknown as import('../managers/processStateStore').ProcessStateStore, nested.liveNestedUi, kind, process);
    return outcome.ok
        ? { ok: true, started: outcome.started, followUp: NESTED_FOLLOW_UP_LABELS[outcome.followUp], inputs: outcome.inputs }
        : { ok: false, error: outcome.error, ...(outcome.cancelled ? { cancelled: true } : {}) };
}

const liveAskUserDeps: AskUserDeps = {
    registry: AskUserRegistry.instance,
    loadConfig: () => readChatQuestionsConfig(),
    onOpen: (pending) => {
        openQuestion(pending);
        sendAskTelegram(pending);
    },
    onResolve: (pending, source) => {
        closeQuestion(pending, source);
    },
    log: (entry) => appendQuestionLogEntry(entry),
    processContext: liveProcessContext,
    moveTo: liveMoveTo,
    startNested: liveStartNested,
};

/**
 * Ask through the question panel with choices — the route of the Agent SDK's
 * intercepted AskUserQuestion when it carries `choices`. Answers what
 * tomAi_askUser answers (an `askUser error: …` when refused).
 */
export function askUserWithChoices(input: { questions: string[]; title?: string; choices: AskChoice[] }): Promise<string> {
    return askUserImpl(liveAskUserDeps, input);
}

/** The live `tomAi_askUser` tool with its blocking executor wired in. */
export const ASK_USER_LIVE_TOOL: SharedToolDefinition<AskUserInput> = {
    ...ASK_USER_DEF,
    execute: (input) => askUserImpl(liveAskUserDeps, input),
};

/**
 * Show the newest pending question in the user-input panel, on its run's tab.
 * Answers false, with a note to the user, when no question is pending.
 */
export function showPendingQuestion(): boolean {
    const pending = AskUserRegistry.instance.getPending();
    if (!pending) {
        void vscode.window.showInformationMessage('No question is waiting for your answer.');
        return false;
    }
    showUserInteractions({ run: pending.run, focusId: pending.requestId });
    return true;
}

export { SHOW_PENDING_QUESTION_COMMAND };

/** At activation: the user-input panel, its commands and status-bar entry (userInteractionPanel.ts). */
export function initPendingQuestionUi(context: vscode.ExtensionContext): void {
    initUserInteractionPanel(context);
}

/**
 * Cancel any pending ask (e.g. on queue Stop / window dispose) so the awaiting
 * round does not leak. Safe to call when nothing is pending.
 */
export function cancelPendingAskUser(note?: string): void {
    AskUserRegistry.instance.cancel(note);
}
