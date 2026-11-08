/**
 * `tomAi_askUser` — pause the prompt queue and ask the user up to 15 questions.
 *
 * Unlike a normal tool, this one **blocks**: the executor returns a Promise
 * that does not resolve until the user answers — from the VS Code webview OR
 * from Telegram — or a timeout fires. Because the Anthropic round loop `await`s
 * the tool result, that pending Promise *is* the queue pause; no separate pause
 * machinery is needed (see {@link AskUserRegistry}). This holds for a prompt
 * running in the prompt queue exactly as it does for an interactive one.
 *
 * ## Waiting is open-ended by default
 *
 * By default there is **no** timeout: the ask waits until the user answers,
 * however long that takes. A deadline exists only when somebody asks for one —
 * the model per call (`timeoutMinutes`) or the user as a standing ceiling
 * (`maxWaitMinutes`); see {@link resolveAskTimeoutMs} for how the two combine.
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
import { resolveAskTimeoutMs } from '../utils/askTimeout';
import { QuestionLogEntry } from '../utils/questionsLogFormat';
import {
    ASK_CHOICE_KINDS, MAX_ASK_CHOICES, choiceAnswer, questionText, resolveMoveTarget, validateChoices,
    type AskChoice, type ChoiceContext, type MoveOutcome,
} from '../utils/askChoices';
import { EMPTY_PROCESS_STATE, type ProcessChange } from '../utils/processDefinition';

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
    /**
     * Append the resolved exchange to the quest's questions journal. Optional
     * so tests and any non-journalling caller can leave it off; failures are
     * swallowed — the log is diagnostics, never a reason to lose an answer.
     */
    log?(entry: QuestionLogEntry): void;
    /** Clock seam for the journal's `answeredAt`. Defaults to `Date.now`. */
    now?(): number;
    /** The quest's process and where it is — what move, branch and subprocess choices are checked against. */
    processContext?(): ChoiceContext;
    /** Make a move of the quest's process (a clicked move choice), as the PROCESS view makes one. */
    moveTo?(change: ProcessChange): MoveOutcome;
}

// ===========================================================================
// Impl
// ===========================================================================

export interface AskUserInput {
    /** 1–15 questions, put to the user in order. */
    questions: string[];
    /** Optional context line shown above the questions. */
    title?: string;
    /**
     * Optional deadline for *this* ask, in minutes. Omitted means wait
     * indefinitely; the user's configured ceiling still caps it.
     */
    timeoutMinutes?: number;
    /** Buttons in the questions (utils/askChoices.ts). */
    choices?: AskChoice[];
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

    const checked = validateChoices(input.choices, questions, () => deps.processContext?.() ?? { def: null, state: { ...EMPTY_PROCESS_STATE } });
    if (!checked.ok) {
        return `askUser error: ${checked.error}. Nothing was asked.`;
    }

    const cfg = deps.loadConfig();
    const timeoutMs = resolveAskTimeoutMs(cfg.maxWaitMinutes, input.timeoutMinutes);
    const title = input.title?.trim() ? input.title.trim() : undefined;
    const now = deps.now ?? (() => Date.now());

    try {
        return await deps.registry.begin({
            questions,
            title,
            choices: checked.choices,
            timeoutMs,
            fallbackPrompt: cfg.fallbackPrompt,
            onOpen: deps.onOpen,
            onResolve: (pending, source, answer) => {
                journal(deps, now, 'tomAi_askUser', pending, source, answer);
                deps.onResolve(pending, source, answer);
            },
        });
    } catch (e) {
        return `askUser error: ${(e as Error).message}`;
    }
}

/**
 * The answer for a click on choice `choiceId` of `pending`, after doing what
 * the click does: a move is made here, by the extension (its target resolved
 * again against where the process is now). Undefined for an unknown choice.
 */
export function choiceClickAnswer(
    deps: Pick<AskUserDeps, 'processContext' | 'moveTo'>,
    pending: PendingAsk,
    choiceId: string,
): string | undefined {
    const choice = pending.choices.find((c) => c.id === choiceId);
    if (!choice) { return undefined; }
    if (choice.kind !== 'move') { return choiceAnswer(choice); }
    const ctx = deps.processContext?.();
    if (!ctx?.def || !ctx.state.process || !deps.moveTo) {
        return choiceAnswer(choice, { ok: false, error: 'the quest has no process set any more' });
    }
    const change = resolveMoveTarget(ctx.def, ctx.state, choice.target ?? '');
    if (typeof change === 'string') { return choiceAnswer(choice, { ok: false, error: change }); }
    return choiceAnswer(choice, deps.moveTo(change));
}

/**
 * Append one resolved exchange to the questions journal, best-effort.
 *
 * Shared by both ask tools. It runs *before* the UI callback so a journal that
 * throws cannot be mistaken for a UI failure, and it swallows everything: the
 * journal is a record of what happened, not a participant in it.
 */
export function journal(
    deps: Pick<AskUserDeps, 'log'>,
    now: () => number,
    tool: string,
    pending: PendingAsk,
    source: AskAnswerSource,
    answer: string,
): void {
    if (!deps.log) { return; }
    try {
        deps.log({
            tool,
            title: pending.title,
            questions: pending.questions.map((q) => questionText(q, pending.choices ?? [])),
            answer,
            source,
            askedAt: pending.createdAt,
            answeredAt: now(),
        });
    } catch {
        // Diagnostics only — never cost the user their answer.
    }
}

// ===========================================================================
// Tool def (placeholder execute — the live bridge installs the real one)
// ===========================================================================

export const ASK_USER_DESCRIPTION =
    'THE way to ask the user something and get an answer — a question written in your reply reaches nobody and stalls the run. `questions`: 1–15 strings, shown numbered; the user\'s one free-form reply comes back verbatim. BLOCKING, from the VS Code panel or Telegram, and by default it waits indefinitely: set `timeoutMinutes` only when you have a sensible default (a timeout answers the configured fallback). One ask at a time; logged to the quest questions journal. ' +
    '`choices` adds buttons, each `{id, label, kind, target?, question?}`: placed at a `{{choice:<id>}}` marker in a question, else under question `question` (default the last). `kind` `answer` answers `target` (default the label); `move` moves the quest\'s current process to `target` (`step`, `phase/step` or `phase/step/substep`) — the extension makes the move on the click and the answer says so; do not move it yourself; `branch` / `subprocess` name an entry of the current step\'s `branches:` / `subprocesses:` list. Any other position or process is refused before anything is shown.';

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
            timeoutMinutes: {
                type: 'number',
                description:
                    'Optional. Give up waiting after this many minutes and receive the fallback ' +
                    'prompt instead. Omit it to wait indefinitely for the user (the default). ' +
                    "The user's configured maximum wait still caps this value.",
            },
            choices: {
                type: 'array',
                description: `Optional buttons (at most ${MAX_ASK_CHOICES}), at a \`{{choice:<id>}}\` marker or under their question.`,
                maxItems: MAX_ASK_CHOICES,
                items: {
                    type: 'object',
                    required: ['id', 'label', 'kind'],
                    properties: {
                        id: { type: 'string', description: 'Letters, digits, "_", "-"; what the marker names.' },
                        label: { type: 'string', description: 'The button text.' },
                        kind: { type: 'string', enum: [...ASK_CHOICE_KINDS] },
                        target: { type: 'string', description: 'answer: the text answered (default the label); move: `step`, `phase/step` or `phase/step/substep` of the current process; branch / subprocess: an entry of the step\'s list.' },
                        question: { type: 'number', description: 'The question (1-based) a choice without a marker goes under; default the last.' },
                    },
                },
            },
        },
    },
    execute: async () => 'askUser error: execute() must be installed by the live bridge (askUser-handler.ts).',
};
