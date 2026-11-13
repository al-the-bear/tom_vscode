/**
 * The waits opened by `tomAi_waitFor` (vscimpb82; rules in utils/waitFor.ts).
 *
 * Each wait records the queue item whose dispatch it runs in
 * (`currentQueueItemId`, services/userWaits.ts), so the prompt queue shows it
 * on that item and Continue can interrupt it. A wait ends by itself at its
 * `until`, by the user's interrupt, or by a cancel: the queue cancels it when
 * the item's turn is stopped, resent or skipped, and a send that ends cancels
 * the waits it left open (services/askOwners.ts), so no wait outlives the
 * prompt that opened it.
 *
 * vscode-free; the clock and timers are injectable for tests.
 */

import { registerAskCancel } from './askOwners';
import { currentQueueItemId } from './userWaits';
import type { WaitForOutcome, WaitForState } from '../utils/waitFor';

/** An open wait, as the queue and the UI see it. */
export interface OpenWait {
    id: number;
    state: WaitForState;
    queueItemId?: string;
}

interface WaitEntry extends OpenWait {
    finish(outcome: WaitForOutcome): void;
}

export interface WaitForTimers {
    now(): number;
    setTimeout(fn: () => void, ms: number): unknown;
    clearTimeout(handle: unknown): void;
}

const REAL_TIMERS: WaitForTimers = {
    now: () => Date.now(),
    setTimeout: (fn, ms) => setTimeout(fn, ms),
    clearTimeout: (h) => clearTimeout(h as ReturnType<typeof setTimeout>),
};

/** setTimeout holds at most ~24.8 days; longer waits are re-armed in steps. */
const MAX_TIMER_MS = 2_000_000_000;

export class WaitForRegistry {
    private static _instance: WaitForRegistry | undefined;
    static get instance(): WaitForRegistry {
        if (!WaitForRegistry._instance) { WaitForRegistry._instance = new WaitForRegistry(); }
        return WaitForRegistry._instance;
    }

    private readonly _waits = new Map<number, WaitEntry>();
    private readonly _listeners = new Set<(wait: OpenWait, phase: 'begin' | 'end', outcome?: WaitForOutcome) => void>();
    private _nextId = 1;

    constructor(private readonly timers: WaitForTimers = REAL_TIMERS) {}

    /**
     * Wait as `state` says: resolves with how it ended. The wait belongs to the
     * queue item whose dispatch this runs in (or `queueItemId`).
     */
    wait(state: WaitForState, queueItemId: string | undefined = currentQueueItemId()): Promise<WaitForOutcome> {
        return new Promise<WaitForOutcome>((resolve) => {
            const id = this._nextId++;
            let handle: unknown;
            let unregister: () => void = () => undefined;
            const arm = (): void => {
                const left = Date.parse(state.until) - this.timers.now();
                if (left <= 0) { entry.finish('elapsed'); return; }
                handle = this.timers.setTimeout(arm, Math.min(left, MAX_TIMER_MS));
            };
            const entry: WaitEntry = {
                id,
                state,
                ...(queueItemId ? { queueItemId } : {}),
                finish: (outcome) => {
                    if (!this._waits.delete(id)) { return; }
                    if (handle !== undefined) { this.timers.clearTimeout(handle); }
                    unregister();
                    this._emit(entry, 'end', outcome);
                    resolve(outcome);
                },
            };
            this._waits.set(id, entry);
            // The send that opened it cancels it when it ends (askOwners).
            unregister = registerAskCancel(() => entry.finish('cancelled'));
            this._emit(entry, 'begin');
            arm();
        });
    }

    /** The open wait of queue item `queueItemId`, if its turn waits. */
    waitOf(queueItemId: string): OpenWait | undefined {
        for (const w of this._waits.values()) {
            if (w.queueItemId === queueItemId) { return { id: w.id, state: w.state, queueItemId: w.queueItemId }; }
        }
        return undefined;
    }

    /** The open waits outside any queue item (a chat send's). */
    waitsOutsideQueue(): OpenWait[] {
        return [...this._waits.values()].filter((w) => !w.queueItemId).map((w) => ({ id: w.id, state: w.state }));
    }

    /** End the wait of queue item `queueItemId` as the user's interrupt. Answers whether one waited. */
    interrupt(queueItemId: string): boolean {
        return this._end((w) => w.queueItemId === queueItemId, 'interrupted');
    }

    /** End the wait `id` (a chat send's) as the user's interrupt. */
    interruptById(id: number): boolean {
        return this._end((w) => w.id === id, 'interrupted');
    }

    /** Cancel the wait of queue item `queueItemId`: its turn was stopped, resent or skipped. */
    cancelForQueueItem(queueItemId: string): boolean {
        return this._end((w) => w.queueItemId === queueItemId, 'cancelled');
    }

    /** Be told when a wait begins and ends; answers the unsubscribe. */
    onChange(listener: (wait: OpenWait, phase: 'begin' | 'end', outcome?: WaitForOutcome) => void): () => void {
        this._listeners.add(listener);
        return () => { this._listeners.delete(listener); };
    }

    private _end(match: (w: WaitEntry) => boolean, outcome: WaitForOutcome): boolean {
        const hits = [...this._waits.values()].filter(match);
        for (const w of hits) { w.finish(outcome); }
        return hits.length > 0;
    }

    private _emit(entry: WaitEntry, phase: 'begin' | 'end', outcome?: WaitForOutcome): void {
        const view: OpenWait = { id: entry.id, state: entry.state, ...(entry.queueItemId ? { queueItemId: entry.queueItemId } : {}) };
        for (const listener of [...this._listeners]) {
            try { listener(view, phase, outcome); } catch { /* a listener must not break the wait */ }
        }
    }
}
