/**
 * A turn that waits on something outside it (vscimpb82): an agent calls
 * `tomAi_waitFor` with what it waits for and until when — pub.dev's 12 new
 * versions of a package in 24 hours, a service's rate window, a build on
 * another machine — instead of ending its turn or sleeping in a shell.
 *
 * The tool blocks until the time comes (the turn and its conversation stay
 * open; its run sends nothing else meanwhile, other runs do). While it
 * waits, the queue item shows the reason and how long is left. Continue on
 * the item offers **Keep waiting** or **Interrupt the wait and move on**:
 * the tool then answers at once that the user interrupted it, the agent ends
 * its turn with a note of what is still to do, and the item steps back to
 * pending behind the next item of its lane; when it runs again its stage is
 * sent again with {@link WAIT_RESUME_NOTE}.
 *
 * Pure: imports neither `vscode` nor the queue.
 */

/* eslint-disable @typescript-eslint/naming-convention -- the queue file's YAML keys */

/** The longest wait the tool accepts: 48 hours. */
export const MAX_WAIT_MINUTES = 48 * 60;

/** What a turn waits for, while it waits (persisted on the queue item for the editor). */
export interface WaitForState {
    /** One line, shown to the user. */
    reason: string;
    /** More about it, when the agent gave some. */
    details?: string;
    /** ISO instant the wait began. */
    since: string;
    /** ISO instant the wait ends by itself. */
    until: string;
}

/** How a wait ended. */
export type WaitForOutcome = 'elapsed' | 'interrupted' | 'cancelled';

/** The tool's input. */
export interface WaitForInput {
    reason?: unknown;
    until?: unknown;
    minutes?: unknown;
    details?: unknown;
}

/**
 * The end of the wait from `until` (an ISO instant, or `HH:MM` local time —
 * today, else tomorrow when that time has passed) or `minutes`; an error
 * when neither reads, when the end is not in the future, or when it is
 * further than {@link MAX_WAIT_MINUTES} away.
 */
export function waitEnd(input: { until?: unknown; minutes?: unknown }, now: number): { at: number } | { error: string } {
    let at: number | undefined;
    if (typeof input.minutes === 'number' || (typeof input.minutes === 'string' && input.minutes.trim() !== '')) {
        const m = Number(input.minutes);
        if (!Number.isFinite(m) || m <= 0) { return { error: '`minutes` must be a number above 0.' }; }
        at = now + m * 60_000;
    } else if (typeof input.until === 'string' && input.until.trim() !== '') {
        const text = input.until.trim();
        const clock = /^(\d{1,2}):(\d{2})$/.exec(text);
        if (clock) {
            const h = Number(clock[1]);
            const min = Number(clock[2]);
            if (h > 23 || min > 59) { return { error: `\`until\` ${text} is not a time of day.` }; }
            const d = new Date(now);
            d.setHours(h, min, 0, 0);
            if (d.getTime() <= now) { d.setDate(d.getDate() + 1); }
            at = d.getTime();
        } else {
            const parsed = Date.parse(text);
            if (!Number.isFinite(parsed)) { return { error: `\`until\` ${text} is neither an ISO date-time nor HH:MM.` }; }
            at = parsed;
        }
    } else {
        return { error: 'Give `until` (an ISO date-time or HH:MM) or `minutes`.' };
    }
    if (at <= now) { return { error: 'The wait would already be over: `until` is not in the future.' }; }
    if (at - now > MAX_WAIT_MINUTES * 60_000) {
        return { error: `The wait is longer than ${MAX_WAIT_MINUTES / 60} h; end the turn with a note instead and let the user queue the work again.` };
    }
    return { at };
}

/** The waiting state for `input`, or an error saying what is wrong with it. */
export function waitForState(input: WaitForInput, now: number): { state: WaitForState } | { error: string } {
    const reason = typeof input.reason === 'string' ? input.reason.trim().split(/\r?\n/)[0].trim() : '';
    if (!reason) { return { error: '`reason` is required: one line saying what the turn waits for.' }; }
    const end = waitEnd(input, now);
    if ('error' in end) { return end; }
    const details = typeof input.details === 'string' && input.details.trim() !== '' ? input.details.trim() : undefined;
    return {
        state: {
            reason,
            ...(details ? { details } : {}),
            since: new Date(now).toISOString(),
            until: new Date(end.at).toISOString(),
        },
    };
}

function two(n: number): string {
    return n < 10 ? `0${n}` : String(n);
}

/** `14:20`, or `Fri 14:20` when the end is not today. */
export function clockLabel(at: number, now: number): string {
    const d = new Date(at);
    const today = new Date(now);
    const time = `${two(d.getHours())}:${two(d.getMinutes())}`;
    if (d.toDateString() === today.toDateString()) { return time; }
    return `${['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'][d.getDay()]} ${time}`;
}

/** `1 h 5 min`, `12 min`, `under a minute`. */
export function durationLabel(ms: number): string {
    const minutes = Math.floor(Math.max(0, ms) / 60_000);
    if (minutes < 1) { return 'under a minute'; }
    if (minutes < 60) { return `${minutes} min`; }
    const h = Math.floor(minutes / 60);
    return minutes % 60 === 0 ? `${h} h` : `${h} h ${minutes % 60} min`;
}

/** `until 14:20 (1 h 5 min left)` — when the wait ends and how long is left. */
export function waitForUntilLabel(state: WaitForState, now: number): string {
    const until = Date.parse(state.until);
    if (!Number.isFinite(until)) { return ''; }
    return `until ${clockLabel(until, now)} (${durationLabel(until - now)} left)`;
}

/** `pub.dev limit … — until 14:20 (1 h 5 min left)`: the item's line. */
export function waitForLine(state: WaitForState, now: number): string {
    return `${state.reason} — ${waitForUntilLabel(state, now)}`;
}

/** The waiting state as the queue file keeps it. */
export function waitForToYaml(state: WaitForState): Record<string, unknown> {
    return {
        reason: state.reason,
        ...(state.details ? { details: state.details } : {}),
        since: state.since,
        until: state.until,
    };
}

/** The waiting state read back from the queue file, or undefined when it is not one. */
export function waitForFromYaml(raw: unknown): WaitForState | undefined {
    if (typeof raw !== 'object' || raw === null) { return undefined; }
    const r = raw as Record<string, unknown>;
    if (typeof r.reason !== 'string' || typeof r.since !== 'string' || typeof r.until !== 'string') { return undefined; }
    return {
        reason: r.reason,
        ...(typeof r.details === 'string' ? { details: r.details } : {}),
        since: r.since,
        until: r.until,
    };
}

/** The tool's answer when the wait ran to its end. */
export function waitElapsedAnswer(state: WaitForState, waitedMs: number): string {
    return JSON.stringify({
        ok: true,
        outcome: 'elapsed',
        waited: durationLabel(waitedMs),
        message: `The wait for "${state.reason}" is over. Go on with the step you waited for.`,
    });
}

/** The tool's answer when the user interrupted the wait: end the turn with a note. */
export function waitInterruptedAnswer(state: WaitForState, waitedMs: number, inQueue: boolean): string {
    return JSON.stringify({
        ok: true,
        outcome: 'interrupted',
        waited: durationLabel(waitedMs),
        message: inQueue
            ? `The user interrupted the wait for "${state.reason}" and moved on. End your turn now: say what you did and what is `
            + 'still to do (the step you waited for, and anything after it). Do not do the awaited step now. The queue puts '
            + 'this item back behind the next item of its lane; when it runs again, you go on from your note.'
            : `The user interrupted the wait for "${state.reason}". Do not do the awaited step now: end your turn with what is still to do.`,
    });
}

/** The tool's answer when the turn that waited ended (Stop, Resend, Skip, a closed window). */
export function waitCancelledAnswer(state: WaitForState): string {
    return JSON.stringify({
        ok: false,
        outcome: 'cancelled',
        message: `The wait for "${state.reason}" was cancelled: the prompt that waited has ended.`,
    });
}

/** The note the stage sent again after an interrupted wait starts with. */
export const WAIT_RESUME_NOTE =
    '[Sent again after the user interrupted your wait (tomAi_waitFor) and moved on: your previous turn on this prompt ' +
    'ended with a note of what was still to do. Look at that note, your trail and the files, and go on from there; ' +
    'if what you waited for is still not possible, call tomAi_waitFor again.]';
