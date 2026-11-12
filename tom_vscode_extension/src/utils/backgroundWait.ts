/**
 * A turn's own background work, waited for before the turn's answer counts.
 *
 * An agent that starts a long command at the end of a turn and says "I'm
 * waiting to get notified" has not finished: the queue used to send the next
 * item, and the result was lost. So a turn waits for the background work it
 * started:
 *
 *   - Agent SDK: the CLI's background tasks (`run_in_background` Bash,
 *     background agents) — alive while the CLI still lists them
 *     (`background_tasks_changed`), whether or not they print anything;
 *   - direct API and Local LLM queue turns: the `tomAi_runCommandStream`
 *     handles the send started — alive while their process group exists.
 *
 * The wait is bounded by a hard limit: the queue item's
 * `backgroundWaitLimitMinutes`, else the profile's, else 6 hours; 0 means do
 * not wait. At the limit the turn ends, and its answer names what was still
 * running (`stillRunningHint`).
 *
 * Pure: imports neither `vscode` nor the transports.
 */

/* eslint-disable @typescript-eslint/naming-convention -- the queue file's YAML keys */
/** The limit when neither the queue item nor the profile sets one: 6 hours. */
export const DEFAULT_BACKGROUND_WAIT_LIMIT_MINUTES = 360;

/** One piece of background work a turn waits for. */
export interface BackgroundWorkItem {
    /** The CLI's task id, or the command-stream handle. */
    id: string;
    /** `task`: an Agent SDK background task; `command`: a tomAi_runCommandStream handle. */
    kind: 'task' | 'command';
    /** What it is: the task's description, or the command. */
    description: string;
    /** The shell command, when known. */
    command?: string;
    /** Where its output goes, when known. */
    outputFile?: string;
}

/** What a turn is waiting for, while it waits (persisted on the queue item for the editor). */
export interface BackgroundWaitState {
    /** ISO instant the wait began. */
    since: string;
    /** The limit that bounds it, in minutes. */
    limitMinutes: number;
    /** ISO instant the limit counts from (Keep waiting restarts it); absent: `since`. */
    limitFrom?: string;
    /** The user chose Wait without limit: the limit no longer applies. */
    unlimited?: true;
    /** The work still running. */
    items: BackgroundWorkItem[];
}

/**
 * What the user can do with a running wait (the queue editor's and @CHAT's
 * buttons, Continue's choices); the transport that waits hands it to the
 * queue while it waits.
 */
export interface BackgroundWaitControl {
    /** Wait until the work ends, however long. */
    waitWithoutLimit(): void;
    /** Start the limit again from now (the configured limit). */
    keepWaiting(): void;
    /** End the wait now: the turn ends with the still-running hint, the queue goes on. */
    stop(): void;
}

/** Why a wait ended with work still running. */
export type StillRunningReason = 'limit' | 'stopped' | 'off';

/** `2 tasks, 1 h 20 min of 6 h` — what is waited for, how long so far, and the limit. */
export function backgroundWaitLine(state: BackgroundWaitState, now: number): string {
    const n = state.items.length;
    const since = Date.parse(state.since);
    const elapsed = formatLimit(Math.max(0, (now - (Number.isFinite(since) ? since : now)) / 60_000));
    const count = `${n} ${n === 1 ? 'task' : 'tasks'}`;
    if (state.unlimited) { return `${count}, ${elapsed}, no limit`; }
    if (state.limitFrom && state.limitFrom !== state.since) {
        const from = new Date(state.limitFrom);
        const two = (v: number): string => (v < 10 ? `0${v}` : String(v));
        return `${count}, ${elapsed}, limit ${formatLimit(state.limitMinutes)} from ${two(from.getHours())}:${two(from.getMinutes())}`;
    }
    return `${count}, ${elapsed} of ${formatLimit(state.limitMinutes)}`;
}

function positiveOrZero(n: unknown): number | undefined {
    return typeof n === 'number' && Number.isFinite(n) && n >= 0 ? n : undefined;
}

/** The limit in minutes: the queue item's, else the profile's, else 6 hours. */
export function resolveBackgroundWaitLimitMinutes(itemLimit: unknown, profileLimit: unknown): number {
    return positiveOrZero(itemLimit) ?? positiveOrZero(profileLimit) ?? DEFAULT_BACKGROUND_WAIT_LIMIT_MINUTES;
}

/** A limit as given (a whole number of minutes, 0 or more), else undefined. */
export function validLimit(raw: unknown): number | undefined {
    const n = typeof raw === 'string' && raw.trim() !== '' ? Number(raw) : raw;
    return typeof n === 'number' && Number.isFinite(n) && n >= 0 ? Math.round(n) : undefined;
}

/** The waiting state as the queue file keeps it. */
export function backgroundWaitToYaml(state: BackgroundWaitState): Record<string, unknown> {
    return {
        since: state.since,
        'limit-minutes': state.limitMinutes,
        ...(state.limitFrom ? { 'limit-from': state.limitFrom } : {}),
        ...(state.unlimited ? { unlimited: true } : {}),
        items: state.items.map((i) => ({
            id: i.id,
            kind: i.kind,
            description: i.description,
            ...(i.command ? { command: i.command } : {}),
            ...(i.outputFile ? { 'output-file': i.outputFile } : {}),
        })),
    };
}

/** The waiting state read back from the queue file, or undefined when it is not one. */
export function backgroundWaitFromYaml(raw: unknown): BackgroundWaitState | undefined {
    if (typeof raw !== 'object' || raw === null) { return undefined; }
    const r = raw as Record<string, unknown>;
    const limit = validLimit(r['limit-minutes']);
    if (typeof r.since !== 'string' || limit === undefined || !Array.isArray(r.items)) { return undefined; }
    const items: BackgroundWorkItem[] = [];
    for (const it of r.items) {
        const i = it as Record<string, unknown>;
        if (typeof i?.id !== 'string') { continue; }
        items.push({
            id: i.id,
            kind: i.kind === 'command' ? 'command' : 'task',
            description: typeof i.description === 'string' ? i.description : '',
            ...(typeof i.command === 'string' ? { command: i.command } : {}),
            ...(typeof i['output-file'] === 'string' ? { outputFile: i['output-file'] } : {}),
        });
    }
    return {
        since: r.since,
        limitMinutes: limit,
        ...(typeof r['limit-from'] === 'string' ? { limitFrom: r['limit-from'] } : {}),
        ...(r.unlimited === true ? { unlimited: true as const } : {}),
        items,
    };
}

/** `6 h`, `90 min`, `1 h 30 min`. */
export function formatLimit(minutes: number): string {
    if (minutes < 1) { return `${Math.max(1, Math.round(minutes * 60))} s`; }
    const m = Math.round(minutes);
    if (m < 60) { return `${m} min`; }
    const h = Math.floor(m / 60);
    return m % 60 === 0 ? `${h} h` : `${h} h ${m % 60} min`;
}

/** One line per item: `description [id]`, the command when it says more. */
export function listBackgroundWork(items: readonly BackgroundWorkItem[]): string {
    return items.map((i) => {
        const what = i.description || i.command || i.id;
        const command = i.command && i.command !== what ? ` — \`${i.command}\`` : '';
        return `${what} [${i.id}]${command}`;
    }).join('; ');
}

/**
 * The hint the turn's answer ends with when the wait ended with work still
 * running: the limit reached (or waiting off, limit 0).
 */
export function stillRunningHint(items: readonly BackgroundWorkItem[], limitMinutes: number, reason?: StillRunningReason): string {
    const n = items.length;
    const what = `${n} background ${n === 1 ? 'task was' : 'tasks were'} still running`;
    const why = reason === 'stopped'
        ? 'the user stopped waiting for it'
        : (reason ?? (limitMinutes > 0 ? 'limit' : 'off')) === 'limit'
            ? `the queue stopped waiting after ${formatLimit(limitMinutes)} (the background-wait limit)`
            : 'waiting for background work is off (limit 0)';
    return `\n\n_(${what} when this turn ended — ${why}; ${n === 1 ? 'its result' : 'their results'} did not reach this turn: ${listBackgroundWork(items)}.)_`;
}
