/**
 * AskUserRegistry — the single pending "ask the user a set of questions" slot.
 *
 * The `tomAi_askUser` tool blocks the LLM round (and therefore the prompt queue)
 * by returning a Promise that does not resolve until the user answers — from the
 * VS Code webview OR from Telegram — or a configurable timeout fires. Because the
 * Anthropic round loop `await`s the tool result, this Promise *is* the queue
 * pause: no separate pause machinery is needed.
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
 *   - Timeout                  → resolves with the configured fallback prompt
 *   - Queue cancel / dispose   → `cancel()` resolves with a short cancel note
 *
 * The first resolver clears the timer, invokes `onResolve` (so the bridge can
 * dismiss the webview), and resolves the Promise. All later answers are ignored.
 *
 * The class is `vscode`-free and the timer/id/clock seams are injectable so the
 * race and timeout are unit-testable without real timers.
 */

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
    /** Epoch ms the timeout will fire. */
    timeoutAt: number;
}

/** Parameters for {@link AskUserRegistry.begin}. */
export interface BeginAskParams {
    questions: string[];
    title?: string;
    /** How long to wait before resolving with `fallbackPrompt`. */
    timeoutMs: number;
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

    /**
     * Open a new ask and return a Promise that resolves to the answer text
     * (verbatim from VS Code or Telegram) or the timeout fallback prompt.
     *
     * Rejects when an ask is already pending — the caller (tool impl) turns that
     * into an error reply so the model knows it must not call again concurrently.
     */
    begin(params: BeginAskParams): Promise<string> {
        if (this.active) {
            return Promise.reject(new Error('An askUser request is already pending — only one may be in flight at a time.'));
        }
        const createdAt = this.now();
        const pending: PendingAsk = {
            requestId: this.genId(),
            questions: params.questions.slice(),
            title: params.title,
            createdAt,
            timeoutAt: createdAt + params.timeoutMs,
        };
        return new Promise<string>((resolve) => {
            const timer = this.setTimer(params.timeoutMs, () => {
                this.finish('timeout', params.fallbackPrompt);
            });
            this.active = {
                pending,
                resolve,
                onResolve: params.onResolve,
                timer,
                fallbackPrompt: params.fallbackPrompt,
            };
            // Surface UI + Telegram synchronously after state is in place so an
            // immediate submit (fast Telegram reply) always finds the slot.
            params.onOpen(pending);
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

    /** Single-shot terminal transition shared by all resolution sources. */
    private finish(source: AskAnswerSource, answer: string): void {
        const active = this.active;
        if (!active) { return; }
        this.active = undefined;            // clear first → guards re-entrancy
        if (active.timer !== undefined) {
            this.clearTimer(active.timer);
        }
        try {
            active.onResolve(active.pending, source, answer);
        } finally {
            active.resolve(answer);
        }
    }
}
