/**
 * The running Grill me / Explain in detail turn, for its "thinking" overlay
 * (vscimpb65): while the agent works between two interactions with the user —
 * after an answer is sent, before the next question, the proposal or the end
 * — the MD Browser panel on the document and the chat panel show that it is
 * thinking about the question, with the time elapsed and **Cancel**.
 *
 * Phases of a run:
 * - `thinking`: the turn runs and asks nothing (the overlay shows);
 * - `waiting`: the turn waits for the user (a question, an MD Browser ask, an
 *   approval; the overlay hides — the user is looking at that);
 * - `failed`: the turn ended with an error (the overlay shows it until
 *   dismissed, or by itself after {@link FAILED_SHOWN_MS});
 * - ended (or cancelled): the run is gone and nothing shows.
 *
 * One run at a time (the chat send slot runs one turn). Cancel marks the run
 * cancelled and calls its cancel hook (the chat send's cancellation); the
 * assist then writes nothing — no closing answer — and the document stays as
 * the turn left it.
 *
 * vscode-free: the cancel hook and the timer come in.
 */

/** How long a failed run's error stays in the overlay unless dismissed. */
export const FAILED_SHOWN_MS = 15_000;

export type AssistPhase = 'thinking' | 'waiting' | 'failed';

/** What a run is about. */
export interface AssistRunInfo {
    /** `Grill me` / `Explain in detail`. */
    label: string;
    questionId: string;
    /** The document, absolute. */
    filePath: string;
    /** The document as shown, workspace-relative. */
    file: string;
}

/** A run as the webviews get it. */
export interface AssistRunView extends AssistRunInfo {
    id: string;
    phase: AssistPhase;
    /** Epoch ms the run started. */
    startedAt: number;
    /** Epoch ms the current phase started (the thinking time since the last answer). */
    phaseSince: number;
    error?: string;
}

interface AssistRun extends AssistRunView {
    chatItemId?: string;
    cancelled: boolean;
    cancel?: () => void;
}

export interface AssistProgressDeps {
    now?(): number;
    setTimer?(fn: () => void, ms: number): unknown;
    clearTimer?(handle: unknown): void;
}

export class AssistProgress {
    private run: AssistRun | undefined;
    private failTimer: unknown;
    /** The runs cancelled (asked by the assist once its send returned). */
    private readonly cancelledIds = new Set<string>();
    private nextId = 1;
    private readonly listeners = new Set<(view: AssistRunView | undefined) => void>();

    constructor(private readonly deps: AssistProgressDeps = {}) {}

    private now(): number { return this.deps.now?.() ?? Date.now(); }

    /** A turn starts (thinking); `cancel` stops its request. Answers its id. */
    start(info: AssistRunInfo, cancel?: () => void): string {
        this.clearFailTimer();
        const t = this.now();
        const id = `assist-${this.nextId++}`;
        this.run = { ...info, id, phase: 'thinking', startedAt: t, phaseSince: t, cancelled: false, ...(cancel ? { cancel } : {}) };
        this.changed();
        return id;
    }

    /** The prompt queue entry the turn is shown as (its waits are keyed by it). */
    setChatItem(id: string, chatItemId: string): void {
        if (this.run?.id === id) { this.run.chatItemId = chatItemId; }
    }

    /** The chat item of the running turn, if known. */
    chatItemOf(id: string): string | undefined {
        return this.run?.id === id ? this.run.chatItemId : undefined;
    }

    /** The turn waits for the user (`true`) or works again (`false`: the thinking time starts anew). */
    setWaiting(id: string, waiting: boolean): void {
        const r = this.run;
        if (!r || r.id !== id || r.phase === 'failed') { return; }
        const phase: AssistPhase = waiting ? 'waiting' : 'thinking';
        if (r.phase === phase) { return; }
        r.phase = phase;
        r.phaseSince = this.now();
        this.changed();
    }

    /** The turn failed: the overlay shows the error until dismissed or for {@link FAILED_SHOWN_MS}. */
    fail(id: string, error: string): void {
        const r = this.run;
        if (!r || r.id !== id) { return; }
        if (r.cancelled) { this.end(id); return; }
        r.phase = 'failed';
        r.error = error;
        r.phaseSince = this.now();
        this.changed();
        this.clearFailTimer();
        this.failTimer = this.deps.setTimer?.(() => { this.failTimer = undefined; this.end(id); }, FAILED_SHOWN_MS);
    }

    /** The turn is over (or the failed run's error dismissed): nothing shows. */
    end(id: string): void {
        if (this.run?.id !== id) { return; }
        this.clearFailTimer();
        this.run = undefined;
        this.changed();
    }

    /**
     * Cancel run `id`: marked cancelled, its request stopped, the overlay gone.
     * A failed run's Cancel only dismisses its error. Answers whether it ran.
     */
    cancel(id: string): boolean {
        const r = this.run;
        if (!r || r.id !== id) { return false; }
        if (r.phase === 'failed') { this.end(id); return true; }
        r.cancelled = true;
        this.cancelledIds.add(id);
        try { r.cancel?.(); } catch { /* the request may have ended already */ }
        this.end(id);
        return true;
    }

    /** Whether run `id` was cancelled (also after it ended). */
    wasCancelled(id: string): boolean {
        return this.cancelledIds.has(id);
    }

    /** The run the overlay shows: thinking or failed (waiting hides it). */
    shown(): AssistRunView | undefined {
        const r = this.run;
        if (!r || r.phase === 'waiting') { return undefined; }
        const { chatItemId: _c, cancelled: _x, cancel: _f, ...view } = r;
        return view;
    }

    /** The running turn, whatever its phase (for the waits listener). */
    active(): { id: string; chatItemId?: string } | undefined {
        return this.run ? { id: this.run.id, ...(this.run.chatItemId ? { chatItemId: this.run.chatItemId } : {}) } : undefined;
    }

    /** Be told when what shows changes; answers the unsubscribe. */
    onChange(listener: (view: AssistRunView | undefined) => void): () => void {
        this.listeners.add(listener);
        return () => { this.listeners.delete(listener); };
    }

    private changed(): void {
        const view = this.shown();
        for (const l of [...this.listeners]) {
            try { l(view); } catch { /* a listener must not break the run */ }
        }
    }

    private clearFailTimer(): void {
        if (this.failTimer !== undefined) { this.deps.clearTimer?.(this.failTimer); this.failTimer = undefined; }
    }
}

/** The window's running assist. */
export const assistProgress = new AssistProgress({
    setTimer: (fn, ms) => setTimeout(fn, ms),
    clearTimer: (h) => clearTimeout(h as ReturnType<typeof setTimeout>),
});
