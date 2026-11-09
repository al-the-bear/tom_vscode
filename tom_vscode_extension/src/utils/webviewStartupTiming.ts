/**
 * Start-up timings for the debug log: when each view was resolved, when the
 * extension first posted to it, when its page first posted back (its script
 * runs, so the view shows), and every stall of the extension host's event
 * loop while the window opens.
 *
 * Why: a view whose provider resolves in a millisecond can still appear
 * minutes later when the extension host's one thread is busy, and
 * resolveWebviewView timings alone do not show that. The stall lines name
 * when the thread was held; a CPU profile then names by what.
 *
 * vscode-free: it takes anything with `postMessage` / `onDidReceiveMessage`.
 */

/** What this needs of a VS Code webview. */
export interface TimedWebview {
    postMessage(message: unknown): Thenable<boolean>;
    onDidReceiveMessage(listener: (message: unknown) => unknown, thisArgs?: unknown, disposables?: unknown): unknown;
}

const TRACKED = Symbol.for('tomAi.webviewStartupTracked');

function typeOf(message: unknown): string {
    const type = typeof message === 'object' && message !== null ? (message as Record<string, unknown>).type : undefined;
    return typeof type === 'string' ? type : '?';
}

function round(ms: number): number {
    return Math.round(ms);
}

/**
 * Log `viewId`'s resolve time after activation, and its first post and first
 * received message after the resolve, each once. A second call on the same
 * webview does nothing (a view resolved again gets a new webview).
 */
export function trackWebviewStartup(
    webview: TimedWebview,
    viewId: string,
    activationStartedAt: number | undefined,
    log: (line: string) => void,
    now: () => number = () => performance.now(),
): void {
    const target = webview as TimedWebview & { [TRACKED]?: boolean };
    if (target[TRACKED]) { return; }
    target[TRACKED] = true;

    const resolvedAt = now();
    const sinceActivation = activationStartedAt === undefined ? '' : ` +${round(resolvedAt - activationStartedAt)}ms after activation began`;
    log(`startup ${viewId}: resolved${sinceActivation}`);

    const post = webview.postMessage.bind(webview);
    let posted = false;
    target.postMessage = (message: unknown) => {
        if (!posted) {
            posted = true;
            log(`startup ${viewId}: first post (${typeOf(message)}) +${round(now() - resolvedAt)}ms after resolve`);
        }
        return post(message);
    };

    let received = false;
    webview.onDidReceiveMessage((message: unknown) => {
        if (received) { return; }
        received = true;
        log(`startup ${viewId}: first message (${typeOf(message)}) +${round(now() - resolvedAt)}ms after resolve`);
    });
}

export interface StallMonitorOptions {
    /** How long to watch, from the call. */
    durationMs: number;
    /** The probe interval. */
    intervalMs: number;
    /** A probe late by at least this much is logged as a stall. */
    thresholdMs: number;
    log(line: string): void;
    now?: () => number;
    setInterval?: (fn: () => void, ms: number) => unknown;
    clearInterval?: (handle: unknown) => void;
}

/**
 * Log every stall of the event loop for `durationMs`: a probe that should run
 * every `intervalMs` and ran late by `thresholdMs` or more means the thread
 * was held that long. Ends with a summary line (count, longest, total).
 * Returns a function that stops it early.
 */
export function monitorStartupStalls(opts: StallMonitorOptions): () => void {
    const now = opts.now ?? (() => performance.now());
    const set = opts.setInterval ?? ((fn: () => void, ms: number) => setInterval(fn, ms));
    const clear = opts.clearInterval ?? ((handle: unknown) => clearInterval(handle as ReturnType<typeof setInterval>));
    const startedAt = now();
    let last = startedAt;
    let count = 0;
    let longest = 0;
    let total = 0;
    let stopped = false;

    const stop = (): void => {
        if (stopped) { return; }
        stopped = true;
        clear(handle);
        opts.log(`startup stalls: ${count} of >=${opts.thresholdMs}ms in ${round(now() - startedAt)}ms, longest ${round(longest)}ms, total ${round(total)}ms`);
    };

    const handle = set(() => {
        const t = now();
        const late = t - last - opts.intervalMs;
        last = t;
        if (late >= opts.thresholdMs) {
            count++;
            total += late;
            longest = Math.max(longest, late);
            opts.log(`startup stall: event loop held ${round(late)}ms (ending +${round(t - startedAt)}ms)`);
        }
        if (t - startedAt >= opts.durationMs) {
            stop();
        }
    }, opts.intervalMs);

    return stop;
}
