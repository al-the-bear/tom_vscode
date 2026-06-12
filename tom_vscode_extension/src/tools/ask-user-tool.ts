/**
 * `tomAi_askUser` — pause the prompt queue and ask the user up to 15 questions.
 *
 * Unlike a normal tool, this one **blocks**: the executor returns a Promise
 * that does not resolve until the user answers — from the VS Code webview OR
 * from Telegram — or a configurable timeout fires. Because the Anthropic round
 * loop `await`s the tool result, that pending Promise *is* the queue pause; no
 * separate pause machinery is needed (see {@link AskUserRegistry}).
 *
 * ## Symmetric, verbatim answer
 *
 * The questions are numbered (1..n) for display only. Both channels collect a
 * single free-form blob — the VS Code textarea text or the Telegram message —
 * and that blob is handed back to the model **verbatim** as the tool reply (no
 * per-question assembly). The user structures their own answer against the
 * numbering. On timeout the reply is the configured `fallbackPrompt` instead.
 *
 * ## vscode-free impl
 *
 * The impl takes a narrow {@link AskUserDeps} (config + registry + the two UI
 * callbacks) so it is unit-testable without the editor. The live bridge
 * (`askUser-handler.ts`) wires the webview + Telegram into the callbacks and
 * installs the real `execute`.
 */

import { SharedToolDefinition } from './shared-tool-registry';
import { AskUserRegistry, PendingAsk, AskAnswerSource } from '../services/askUserRegistry';
import { ChatQuestionsConfig } from '../handlers/chatQuestions-config';

/** Hard cap on the number of questions a single ask may carry. */
export const MAX_ASK_USER_QUESTIONS = 15;

// ===========================================================================
// Narrow dep
// ===========================================================================

/** The seam between the pure impl and the live vscode/Telegram bridge. */
export interface AskUserDeps {
    /** The pending-ask registry (singleton in production, fake in tests). */
    registry: AskUserRegistry;
    /** Effective Chat questions config for the current quest/host. */
    loadConfig(): ChatQuestionsConfig;
    /** Surface the ask (open the webview + send the Telegram notification). */
    onOpen(pending: PendingAsk): void;
    /** Dismiss the ask UI once any channel (or the timeout) resolves it. */
    onResolve(pending: PendingAsk, source: AskAnswerSource, answer: string): void;
}

// ===========================================================================
// Impl
// ===========================================================================

export interface AskUserInput {
    /** 1–15 questions, put to the user in order. */
    questions: string[];
    /** Optional context line shown above the questions. */
    title?: string;
}

/**
 * Open an ask and resolve to the user's verbatim answer (or the timeout
 * fallback prompt). Returns a short error string when the input is invalid or
 * an ask is already pending — never throws.
 */
export async function askUserImpl(deps: AskUserDeps, input: AskUserInput): Promise<string> {
    const questions = Array.isArray(input.questions)
        ? input.questions.map((q) => String(q ?? '').trim()).filter((q) => q.length > 0)
        : [];
    if (questions.length === 0) {
        return 'askUser error: `questions` must contain at least one non-empty question.';
    }
    if (questions.length > MAX_ASK_USER_QUESTIONS) {
        return `askUser error: too many questions (${questions.length}); the maximum is ${MAX_ASK_USER_QUESTIONS}.`;
    }

    const cfg = deps.loadConfig();
    const timeoutMs = Math.max(1, Math.floor(cfg.maxWaitMinutes)) * 60_000;
    const title = input.title?.trim() ? input.title.trim() : undefined;

    try {
        return await deps.registry.begin({
            questions,
            title,
            timeoutMs,
            fallbackPrompt: cfg.fallbackPrompt,
            onOpen: deps.onOpen,
            onResolve: deps.onResolve,
        });
    } catch (e) {
        return `askUser error: ${(e as Error).message}`;
    }
}

// ===========================================================================
// Tool def (placeholder execute — the live bridge installs the real one)
// ===========================================================================

export const ASK_USER_DESCRIPTION =
    'THE way to ask the user something and actually receive an answer. ' +
    'Whenever you need a decision, clarification, missing information, or ' +
    'approval from the user, call this tool — do NOT just write the question ' +
    'in your text reply, because that reply is not surfaced to the user as a ' +
    'prompt and nothing will answer it (the run will stall or you will be ' +
    'forced to guess). ' +
    'Syntax: call `tomAi_askUser` with `questions` (an array of 1–15 strings) ' +
    'and an optional `title`. Example: ' +
    '`{ "questions": ["Which database should I target?", "Is a destructive ' +
    'migration acceptable?"], "title": "Migration plan" }`. ' +
    'It pauses the prompt queue and **waits**: **BLOCKING** — the call does ' +
    'not return until the user answers (from the VS Code question panel OR ' +
    'from Telegram) or a configurable timeout fires. The questions are ' +
    'numbered (1..n) for display; the user types a single free-form reply and ' +
    'that reply is returned to you **verbatim** as the tool result — structure ' +
    'your questions so a numbered, free-form answer makes sense. On timeout ' +
    'the result is the configured fallback prompt instead (default: ask the ' +
    'model to follow its own recommendations). Only **one** ask may be in ' +
    'flight at a time (the queue is blocked on it).';

export const ASK_USER_TOOL: SharedToolDefinition<AskUserInput> = {
    name: 'tomAi_askUser',
    displayName: 'Ask User',
    description: ASK_USER_DESCRIPTION,
    tags: ['user', 'interactive', 'telegram', 'tom-ai-chat'],
    readOnly: false,
    requiresApproval: false,
    inputSchema: {
        type: 'object',
        required: ['questions'],
        properties: {
            questions: {
                type: 'array',
                description: `1–${MAX_ASK_USER_QUESTIONS} questions to put to the user, in order.`,
                minItems: 1,
                maxItems: MAX_ASK_USER_QUESTIONS,
                items: { type: 'string' },
            },
            title: { type: 'string', description: 'Optional context line shown above the questions.' },
        },
    },
    execute: async () => 'askUser error: execute() must be installed by the live bridge (askUser-handler.ts).',
};
