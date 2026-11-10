/**
 * Live bridge for `tomAi_askUser` — wires the vscode-free tool impl
 * (`ask-user-tool.ts`) and registry (`askUserRegistry.ts`) into the editor: a
 * webview panel for answering in VS Code, plus a Telegram notification so the
 * user can answer from their phone. Either channel resolves the one pending ask.
 *
 * One panel per question (the registry allows only one ask in flight), kept by
 * request id: when the ask resolves by *any* source (vscode submit, Telegram
 * reply, timeout, cancel — also the cancel when the prompt that asked ends,
 * services/askOwners.ts) the registry calls {@link onResolve}, which dismisses
 * its panel and any stale one; a stale panel that posts an answer closes too.
 */

import * as vscode from 'vscode';
import * as path from 'path';
import { getExtensionPath, bridgeLog } from './handler_shared';
import { loadWebviewHtml } from '../utils/webviewLoader';
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
import { questionText, type AskChoice, type ChoiceContext, type MoveOutcome, type StartOutcome } from '../utils/askChoices';
import { EMPTY_PROCESS_STATE, type ProcessChange } from '../utils/processDefinition';
import { SharedToolDefinition } from '../tools/shared-tool-registry';

// ===========================================================================
// Singleton webview panel
// ===========================================================================

/**
 * The question panels by request id. Normally one (the registry allows one ask
 * at a time); a panel whose question is no longer the pending one is stale and
 * is closed whenever it is found — when a question resolves, when a new one
 * opens, when a stale panel posts its answer.
 */
const askPanels = new Map<string, vscode.WebviewPanel>();

/** The open question panels' request ids (tests, diagnostics). */
export function openAskPanelIds(): string[] {
    return [...askPanels.keys()];
}

function disposePanel(requestId: string): void {
    const panel = askPanels.get(requestId);
    askPanels.delete(requestId);
    if (panel) {
        try { panel.dispose(); } catch { /* already gone */ }
    }
}

/** Close every panel whose question is not the pending one (`keep`, when given, stays). */
function disposeStalePanels(keep?: string): void {
    const pending = AskUserRegistry.instance.getPending()?.requestId;
    for (const id of [...askPanels.keys()]) {
        if (id !== keep && id !== pending) { disposePanel(id); }
    }
}

/** Open the ask panel for a pending ask (stale panels go first). */
function openAskPanel(pending: PendingAsk): void {
    disposeStalePanels(pending.requestId);
    disposePanel(pending.requestId);

    const extPath = getExtensionPath();
    const localRoots = extPath ? [vscode.Uri.file(path.join(extPath, 'media'))] : undefined;

    const panel = vscode.window.createWebviewPanel(
        'tomAiAskUser',
        'Tom AI — Questions',
        { viewColumn: vscode.ViewColumn.Active, preserveFocus: false },
        {
            enableScripts: true,
            retainContextWhenHidden: true,
            localResourceRoots: localRoots,
        },
    );

    const isPending = (): boolean => AskUserRegistry.instance.getPending()?.requestId === pending.requestId;
    panel.webview.onDidReceiveMessage(async (msg: { type?: string; requestId?: string; text?: string; choiceId?: string }) => {
        if (msg?.requestId !== pending.requestId || (msg.type !== 'submit' && msg.type !== 'choice')) { return; }
        if (!isPending()) {
            // An answer to a question that is no longer open (answered elsewhere, timed out,
            // cancelled with its prompt): the panel goes instead of waiting forever.
            disposePanel(pending.requestId);
            void vscode.window.showInformationMessage('That question was already closed; your answer was not sent.');
            return;
        }
        if (msg.type === 'submit') {
            AskUserRegistry.instance.submit(pending.requestId, typeof msg.text === 'string' ? msg.text : '', 'vscode');
            return;
        }
        // A choice button: what it does (a move, a branch or subprocess started) is done here, then
        // it answers. One that throws still answers (with the error), so the panel never stays with its
        // buttons locked.
        let answer: string | undefined;
        try {
            answer = await choiceClickAnswerAsync(liveAskUserDeps, pending, String(msg.choiceId ?? ''));
        } catch (err) {
            answer = `The choice could not be carried out: ${(err as Error).message}`;
        }
        // The question may have closed meanwhile (its prompt ended while the user chose a follow-up).
        if (!isPending()) { disposePanel(pending.requestId); return; }
        AskUserRegistry.instance.submit(pending.requestId, answer ?? `Unknown choice "${String(msg.choiceId ?? '')}".`, 'vscode');
    });

    panel.onDidDispose(() => {
        // Manual close: forget the panel but leave the ask pending so the user
        // can still answer from Telegram / let the timeout fire.
        if (askPanels.get(pending.requestId) === panel) { askPanels.delete(pending.requestId); }
    });

    try {
        panel.webview.html = loadWebviewHtml(panel.webview, 'askUser', {
            init: {
                requestId: pending.requestId,
                questions: pending.questions,
                title: pending.title,
                timeoutAt: pending.timeoutAt,
                choices: pending.choices,
                layout: pending.layout,
            },
        });
    } catch (err) {
        bridgeLog(`[askUser] Failed to render panel: ${(err as Error).message}`, 'ERROR');
    }

    askPanels.set(pending.requestId, panel);
}

/** Dismiss the question's panel once the ask resolves by any source, and any stale one with it. */
function closeAskPanel(pending: PendingAsk, source: AskAnswerSource): void {
    const panel = askPanels.get(pending.requestId);
    // Let the webview reflect a non-vscode resolution before it goes away.
    if (panel && source !== 'vscode') {
        try {
            panel.webview.postMessage({ type: 'resolved', note: resolvedNote(source) });
        } catch { /* panel may already be disposing */ }
    }
    disposePanel(pending.requestId);
    disposeStalePanels();
}

function resolvedNote(source: AskAnswerSource): string {
    switch (source) {
        case 'telegram': return 'Answered from Telegram.';
        case 'timeout': return 'Timed out — the assistant will continue on its own.';
        case 'cancel': return 'The question was cancelled.';
        default: return 'Answered.';
    }
}

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
    lines.push('', 'Reply with your answer (you can address the questions by number).');
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
        openAskPanel(pending);
        sendAskTelegram(pending);
    },
    onResolve: (pending, source) => {
        closeAskPanel(pending, source);
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
 * Cancel any pending ask (e.g. on queue Stop / window dispose) so the awaiting
 * round does not leak. Safe to call when nothing is pending.
 */
export function cancelPendingAskUser(note?: string): void {
    AskUserRegistry.instance.cancel(note);
}
