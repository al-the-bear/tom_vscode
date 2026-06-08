/**
 * Trailing-edge debounce (plan §7, todo #7).
 *
 * The MCP config file watcher fires `onDidChange` several times for a single
 * save; this collapses a burst into one invocation `delayMs` after the last
 * call, carrying the most recent arguments. `cancel()` drops any pending call
 * (used on disposal). The scheduler is injected — defaulting to the real
 * `setTimeout`/`clearTimeout` — so the timing logic is unit-testable without
 * real time, the same "inject the boundary" seam the MCP handler uses for
 * `vscode`/`process`.
 *
 * `vscode`-free by design, so it lives under `src/utils/` and is covered by the
 * `out/utils/__tests__/*.test.js` glob.
 */

/** The timer boundary `debounce` depends on (injectable for tests). */
export interface DebounceScheduler {
    /** Schedule `handler` after `delayMs`; returns an opaque handle. */
    set(handler: () => void, delayMs: number): number;
    /** Cancel a previously-scheduled handle. */
    clear(handle: number): void;
}

/** A debounced function plus a `cancel()` to drop any pending invocation. */
export interface Debounced<A extends unknown[]> {
    (...args: A): void;
    cancel(): void;
}

/** Production scheduler backed by Node's global timers. */
const realScheduler: DebounceScheduler = {
    set: (handler, delayMs) => setTimeout(handler, delayMs) as unknown as number,
    clear: (handle) => { clearTimeout(handle as unknown as ReturnType<typeof setTimeout>); },
};

/**
 * Wrap `fn` so rapid calls collapse into a single trailing invocation.
 *
 * @param fn        the function to debounce
 * @param delayMs   quiet period after the last call before `fn` runs
 * @param scheduler timer boundary (defaults to real `setTimeout`)
 */
export function debounce<A extends unknown[]>(
    fn: (...args: A) => void,
    delayMs: number,
    scheduler: DebounceScheduler = realScheduler,
): Debounced<A> {
    let handle: number | undefined;
    let lastArgs: A | undefined;

    const debounced = ((...args: A): void => {
        lastArgs = args;
        if (handle !== undefined) {
            scheduler.clear(handle);
        }
        handle = scheduler.set(() => {
            handle = undefined;
            const callArgs = lastArgs as A;
            lastArgs = undefined;
            fn(...callArgs);
        }, delayMs);
    }) as Debounced<A>;

    debounced.cancel = (): void => {
        if (handle !== undefined) {
            scheduler.clear(handle);
            handle = undefined;
        }
        lastArgs = undefined;
    };

    return debounced;
}
