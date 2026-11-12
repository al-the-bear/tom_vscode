/**
 * AskUserRegistry — the single pending "ask the user a set of questions" slot.
 *
 * The `tomAi_askUser` tool blocks the LLM round (and therefore the prompt queue)
 * by returning a Promise that does not resolve until the user answers — from the
 * VS Code webview OR from Telegram. Because the Anthropic round loop `await`s
 * the tool result, this Promise *is* the queue pause: no separate pause
 * machinery is needed.
 *
 * ## Waiting is open-ended by default
 *
 * An ask has **no deadline** unless the caller asks for one ({@link
 * BeginAskParams.timeoutMs}). A question the user has not read yet must not
 * answer itself: expiring into a fallback prompt turns "I asked and waited" into
 * "I asked, nobody saw it, and I proceeded on a guess". A timeout is therefore
 * something the model opts into per call, or the user configures as a ceiling.
 *
 * ## Singleton by construction
 *
 * Only one ask can ever be in flight: the round loop is blocked on it, so a
 * second `begin()` while one is pending is a programming error (rejected). This
 * lets Telegram routing stay trivial — the next free-text reply simply belongs
 * to the one pending ask; no requestId routing is required on the Telegram side.
 * The `requestId` exists only to let the webview correlate its submit and to
 * reject stale answers that arrive after the slot already resolved.
 *
 * ## Resolution race (first wins, single-shot)
 *
 *   - VS Code webview submit  → `submit(id, text, 'vscode')`
 *   - Telegram free-text reply → `submit(id, text, 'telegram')`
 *   - Timeout, when one was requested → resolves with the fallback prompt
 *   - Queue cancel / dispose   → `cancel()` resolves with a short cancel note
 *
 * The first resolver clears the timer, invokes `onResolve` (so the bridge can
 * dismiss the webview), and resolves the Promise. All later answers are ignored.
 *
 * The class is `vscode`-free and the timer/id/clock seams are injectable so the
 * race and timeout are unit-testable without real timers.
 */

import { registerAskCancel } from './askOwners';

import { currentQueueItemId, whileWaitingForUser } from './userWaits';
import { layoutChoices, type AskChoice, type QuestionLayout } from '../utils/askChoices';

/** The answer of a question whose prompt ended before the user answered. */
export const ASK_OWNER_ENDED_NOTE = 'The prompt that asked this question has ended; the question was closed unanswered.';

export type AskAnswerSource = 'vscode' | 'telegram' | 'timeout' | 'cancel';

/** Public snapshot of the currently-pending ask (read by the UI + Telegram bridge). */
export interface PendingAsk {
    /** Correlation id — guards stale webview/Telegram submits. */
    requestId: string;
    /** The questions to put to the user, in order (already numbered 1..n for display). */
    questions: string[];
    /** Optional title/context line shown above the questions. */
    title?: string;
    /** Epoch ms the ask was created. */
    createdAt: number;
    /**
     * Epoch ms the timeout will fire, or `undefined` when the ask waits
     * indefinitely — which is what tells the webview there is no countdown.
     */
    timeoutAt?: number;
    /** Buttons in the questions (utils/askChoices.ts); empty when the ask has none. */
    choices: AskChoice[];
    /** Where each question shows its choices: at a marker or under it. */
    layout: QuestionLayout[];
    /** The queue item whose turn asked (services/userWaits.ts), when a queue item's turn asked. */
    queueItemId?: string;
}

/** Parameters for {@link AskUserRegistry.begin}. */
export interface BeginAskParams {
    questions: string[];
    title?: string;
    /** Buttons in the questions, already checked (utils/askChoices.ts validateChoices). */
    choices?: AskChoice[];
    /**
     * How long to wait before resolving with `fallbackPrompt`. Omitted, zero or
     * negative means **wait indefinitely** — no timer is armed at all.
     */
    timeoutMs?: number;
    /** The tool reply used when the timeout fires (editable in settings). */
    fallbackPrompt: string;
    /** Called once, synchronously, when the ask opens (surface UI + Telegram). */
    onOpen: (pending: PendingAsk) => void;
    /** Called once when the ask resolves by any source (dismiss UI). */
    onResolve: (pending: PendingAsk, source: AskAnswerSource, answer: string) => void;
}

type TimerHandle = ReturnType<typeof setTimeout>;

/** Injectable seams (timers / id / clock) — defaulted to the globals in production. */
export interface AskUserRegistryOptions {
    setTimer?: (ms: number, cb: () => void) => TimerHandle;
    clearTimer?: (handle: TimerHandle) => void;
    genId?: () => string;
    now?: () => number;
}

interface ActiveAsk {
    pending: PendingAsk;
    resolve: (answer: string) => void;
    onResolve: BeginAskParams['onResolve'];
    timer: TimerHandle | undefined;
    fallbackPrompt: string;
    /** Unregisters the cancel from the send that asked (services/askOwners.ts). */
    unregisterOwner: () => void;
}

export class AskUserRegistry {
    private static _instance: AskUserRegistry | undefined;

    /** Process-wide singleton used by the live tool bridge, webview and Telegram. */
    static get instance(): AskUserRegistry {
        if (!AskUserRegistry._instance) {
            AskUserRegistry._instance = new AskUserRegistry();
        }
        return AskUserRegistry._instance;
    }

    private readonly setTimer: NonNullable<AskUserRegistryOptions['setTimer']>;
    private readonly clearTimer: NonNullable<AskUserRegistryOptions['clearTimer']>;
    private readonly genId: NonNullable<AskUserRegistryOptions['genId']>;
    private readonly now: NonNullable<AskUserRegistryOptions['now']>;

    private active: ActiveAsk | undefined;
    private readonly listeners = new Set<() => void>();

    constructor(opts: AskUserRegistryOptions = {}) {
        this.setTimer = opts.setTimer ?? ((ms, cb) => setTimeout(cb, ms));
        this.clearTimer = opts.clearTimer ?? ((h) => clearTimeout(h));
        this.genId = opts.genId ?? (() => `ask_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`);
        this.now = opts.now ?? (() => Date.now());
    }

    /** Whether an ask is currently waiting for an answer. */
    hasPending(): boolean {
        return this.active !== undefined;
    }

    /** Snapshot of the pending ask, or `undefined` when nothing is pending. */
    getPending(): PendingAsk | undefined {
        return this.active?.pending;
    }

    /** The pending ask queue item `queueItemId`'s turn asked, if that is the pending one. */
    pendingForQueueItem(queueItemId: string): PendingAsk | undefined {
        const pending = this.active?.pending;
        return pending?.queueItemId === queueItemId ? pending : undefined;
    }

    /**
     * Be told when an ask opens or resolves (the status-bar entry, the queue
     * editor's waiting item); answers the unsubscribe.
     */
    onDidChange(listener: () => void): () => void {
        this.listeners.add(listener);
        return () => { this.listeners.delete(listener); };
    }

    private changed(): void {
        for (const listener of [...this.listeners]) {
            try { listener(); } catch { /* a listener must not break the ask */ }
        }
    }

    /**
     * Open a new ask and return a Promise that resolves to the answer text
     * (verbatim from VS Code or Telegram) or the timeout fallback prompt.
     *
     * Rejects when an ask is already pending — the caller (tool impl) turns that
     * into an error reply so the model knows it must not call again concurrently.
     */
    begin(params: BeginAskParams): Promise<string> {
        // Open as a wait for the user while the question stands (the queue editor shows the item waiting).
        return whileWaitingForUser('question', () => this.beginAsk(params));
    }

    private beginAsk(params: BeginAskParams): Promise<string> {
        if (this.active) {
            return Promise.reject(new Error('An askUser request is already pending — only one may be in flight at a time.'));
        }
        const createdAt = this.now();
        // A missing / non-positive timeout is the "wait indefinitely" default,
        // not a deadline that has already passed.
        const timeoutMs = typeof params.timeoutMs === 'number' && params.timeoutMs > 0
            ? params.timeoutMs
            : undefined;
        const pending: PendingAsk = {
            requestId: this.genId(),
            questions: params.questions.slice(),
            title: params.title,
            choices: params.choices?.slice() ?? [],
            layout: layoutChoices(params.questions, params.choices ?? []),
            createdAt,
            timeoutAt: timeoutMs === undefined ? undefined : createdAt + timeoutMs,
            ...(currentQueueItemId() ? { queueItemId: currentQueueItemId() } : {}),
        };
        return new Promise<string>((resolve) => {
            const timer = timeoutMs === undefined ? undefined : this.setTimer(timeoutMs, () => {
                this.finish('timeout', params.fallbackPrompt);
            });
            this.active = {
                pending,
                resolve,
                onResolve: params.onResolve,
                timer,
                fallbackPrompt: params.fallbackPrompt,
                // The prompt that asks owns the question: when it ends, the question ends with it.
                unregisterOwner: registerAskCancel(() => this.cancelRequest(pending.requestId, ASK_OWNER_ENDED_NOTE)),
            };
            // Surface UI + Telegram synchronously after state is in place so an
            // immediate submit (fast Telegram reply) always finds the slot.
            try {
                params.onOpen(pending);
            } catch (err) {
                // Nobody can see this ask, so nobody can answer it: free the slot
                // (and its timer) instead of refusing every later ask as pending.
                if (timer !== undefined) { this.clearTimer(timer); }
                this.active?.unregisterOwner();
                this.active = undefined;
                throw err;
            }
            this.changed();
        });
    }

    /**
     * Submit an answer from a channel. Returns `true` when accepted (the slot
     * matched and was open), `false` when there is nothing pending or the
     * `requestId` is stale (e.g. an answer that raced in after the timeout).
     */
    submit(requestId: string, answer: string, source: 'vscode' | 'telegram'): boolean {
        if (!this.active || this.active.pending.requestId !== requestId) {
            return false;
        }
        this.finish(source, answer);
        return true;
    }

    /**
     * Cancel the pending ask (queue Stop / window dispose). Resolves the Promise
     * with a short note so the awaiting round does not leak; the round itself is
     * usually being torn down by its own cancellation token at the same time.
     */
    cancel(note = 'The pending question was cancelled before the user answered.'): void {
        if (!this.active) { return; }
        this.finish('cancel', note);
    }

    /** Cancel the ask `requestId` if it is still the pending one (a later ask is left alone). */
    cancelRequest(requestId: string, note: string): void {
        if (this.active?.pending.requestId === requestId) { this.finish('cancel', note); }
    }

    /**
     * Close the question queue item `queueItemId`'s turn waits in, answering it
     * `note` (the user resent or skipped the stage); answers whether one was open.
     */
    cancelForQueueItem(queueItemId: string, note: string): boolean {
        const pending = this.pendingForQueueItem(queueItemId);
        if (!pending) { return false; }
        this.finish('cancel', note);
        return true;
    }

    /** Single-shot terminal transition shared by all resolution sources. */
    private finish(source: AskAnswerSource, answer: string): void {
        const active = this.active;
        if (!active) { return; }
        this.active = undefined;            // clear first → guards re-entrancy
        active.unregisterOwner();
        if (active.timer !== undefined) {
            this.clearTimer(active.timer);
        }
        try {
            active.onResolve(active.pending, source, answer);
        } finally {
            active.resolve(answer);
            this.changed();
        }
    }
}
