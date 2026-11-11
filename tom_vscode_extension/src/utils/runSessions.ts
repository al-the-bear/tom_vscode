/**
 * The sessions of a process run (vscimpb44): a run other than `default` uses
 * the sessions its process names with the run's name added, `<session>@<run>`,
 * so two runs of one process never continue each other's conversations. The
 * `default` run keeps the names as they are. The shared sessions — `default`
 * (the queue's), `chat` (the panel's) — and temporary ones (`tmp-…`) are
 * never renamed, nor a name that already names its run.
 *
 * Pure (no fs, no vscode).
 */

import { DEFAULT_RUN, normalizeRun } from './processRuns';

/** Between a session's name and its run's. */
export const RUN_SESSION_SEPARATOR = '@';

const SHARED_SESSIONS: readonly string[] = ['default', 'chat'];

/** The name of session `name` in run `run`: `<name>@<run>`, or `name` for the `default` run and the shared ones. */
export function runSessionName(name: string, run: string | undefined): string {
    const r = normalizeRun(run);
    if (!name || r === DEFAULT_RUN || name.includes(RUN_SESSION_SEPARATOR)) { return name; }
    if (SHARED_SESSIONS.includes(name) || name.startsWith('tmp-')) { return name; }
    return `${name}${RUN_SESSION_SEPARATOR}${r}`;
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
