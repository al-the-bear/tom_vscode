/**
 * The sessions of a process run (vscimpb44): a run other than `default` uses
 * the sessions its process names with the run's name added, `<session>@<run>`,
 * so two runs of one process never continue each other's conversations. The
 * `default` run keeps the names as they are. Every run has its **default
 * session** `default@<run>` (vscimpb151): the queue's session for an item that
 * names none, the session a panel goes to when its run is switched, created
 * with the run. The `default` run's is `default@default`; the bare name
 * `default` an older build wrote is read as that ({@link canonicalSessionName}).
 * `chat` (the panel's own session) and temporary sessions (`tmp-…`) are
 * never renamed, nor a name that already names its run.
 *
 * Pure (no fs, no vscode).
 */

import { DEFAULT_RUN, normalizeRun } from './processRuns';

/** Between a session's name and its run's. */
export const RUN_SESSION_SEPARATOR = '@';

/** The base name of every run's default session. */
export const DEFAULT_SESSION_BASE = 'default';

/** The `default` run's default session (the queue's session there). */
export const DEFAULT_RUN_SESSION = `${DEFAULT_SESSION_BASE}${RUN_SESSION_SEPARATOR}${DEFAULT_RUN}`;

/** The name an older build gave the `default` run's default session. */
export const LEGACY_DEFAULT_SESSION = DEFAULT_SESSION_BASE;

const SHARED_SESSIONS: readonly string[] = ['chat'];

/** A session name as it is now: the bare `default` of older builds is `default@default`; anything else as it is. */
export function canonicalSessionName(name: string): string;
export function canonicalSessionName(name: string | undefined): string | undefined;
export function canonicalSessionName(name: string | undefined): string | undefined {
    return name === LEGACY_DEFAULT_SESSION ? DEFAULT_RUN_SESSION : name;
}

/** The default session of run `run`: `default@<run>` (`default@default` for the `default` run). */
export function runDefaultSession(run: string | undefined): string {
    return `${DEFAULT_SESSION_BASE}${RUN_SESSION_SEPARATOR}${normalizeRun(run)}`;
}

/** Whether `name` is some run's default session (`default@<run>`, or the bare legacy `default`). */
export function isRunDefaultSession(name: string | undefined): boolean {
    const n = canonicalSessionName(name);
    return !!n && sessionBaseName(n) === DEFAULT_SESSION_BASE && n.includes(RUN_SESSION_SEPARATOR);
}

/** The name of session `name` in run `run`: `<name>@<run>`, or `name` for the `default` run and the shared ones. */
export function runSessionName(name: string, run: string | undefined): string {
    const r = normalizeRun(run);
    const n = canonicalSessionName(name);
    if (!n || r === DEFAULT_RUN || n.includes(RUN_SESSION_SEPARATOR)) { return n; }
    if (SHARED_SESSIONS.includes(n) || n.startsWith('tmp-')) { return n; }
    return `${n}${RUN_SESSION_SEPARATOR}${r}`;
}

/**
 * The session a queue item of run `run` runs in when it names none: the
 * queue's default session (`queueDefault`, else the run's default session
 * `default@<run>`) in that run, so the runs never share, or wait for, one queue
 * conversation. In the `default` run the queue default as it is, else
 * `default@default`. A queue default naming the `default` run
 * (`default@default`, `work@default`) is taken by its base name in another run;
 * `chat`, temporary sessions and a name naming another run are kept.
 */
export function runQueueSession(queueDefault: string | undefined, run: string | undefined): string {
    const r = normalizeRun(run);
    const configured = canonicalSessionName(queueDefault || undefined);
    if (r === DEFAULT_RUN) { return configured || DEFAULT_RUN_SESSION; }
    let base = configured || DEFAULT_SESSION_BASE;
    if (base.includes(RUN_SESSION_SEPARATOR) && sessionRun(base) === DEFAULT_RUN) { base = sessionBaseName(base); }
    if (base.includes(RUN_SESSION_SEPARATOR) || base === 'chat' || base.startsWith('tmp-')) { return base; }
    return `${base}${RUN_SESSION_SEPARATOR}${r}`;
}

/** The run a session belongs to: the part after `@`, else `default`. */
export function sessionRun(name: string): string {
    const at = name.indexOf(RUN_SESSION_SEPARATOR);
    return at > 0 ? name.slice(at + 1) : DEFAULT_RUN;
}

/** A session's name without its run. */
export function sessionBaseName(name: string): string {
    const at = name.indexOf(RUN_SESSION_SEPARATOR);
    return at > 0 ? name.slice(0, at) : name;
}

/** The sessions among `names` that belong to one of `runs` (never a `default`-run session). */
export function sessionsOfRuns(names: readonly string[], runs: readonly string[]): string[] {
    const wanted = new Set(runs.map(normalizeRun).filter((r) => r !== DEFAULT_RUN));
    return names.filter((n) => n.includes(RUN_SESSION_SEPARATOR) && wanted.has(sessionRun(n)));
}
