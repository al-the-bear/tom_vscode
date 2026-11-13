/**
 * Which open question a free-text reply answers (Telegram; vscimpb81): with one
 * question open, that one; with several (one per process run), the run the
 * reply names first — `<run>: answer` — else none, and the user is told the
 * runs. Pure.
 */

export interface RoutableAsk {
    requestId: string;
    run: string;
}

export type ReplyRoute =
    | { kind: 'answer'; requestId: string; run: string; text: string }
    | { kind: 'ambiguous'; runs: string[] }
    | { kind: 'none' };

/** Route reply `text` to one of the open asks. */
export function routeReply(text: string, open: readonly RoutableAsk[]): ReplyRoute {
    if (open.length === 0) { return { kind: 'none' }; }
    const named = /^\s*([A-Za-z0-9_-]+)\s*:\s*([\s\S]*)$/.exec(text);
    if (named) {
        const ask = open.find((a) => a.run.toLowerCase() === named[1].toLowerCase());
        if (ask) { return { kind: 'answer', requestId: ask.requestId, run: ask.run, text: named[2].trim() }; }
    }
    if (open.length === 1) { return { kind: 'answer', requestId: open[0].requestId, run: open[0].run, text }; }
    return { kind: 'ambiguous', runs: open.map((a) => a.run) };
}
