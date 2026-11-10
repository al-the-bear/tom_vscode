/**
 * Runs of a quest's processes — several positions in one quest (vscimpb29).
 *
 * A run is a named process position of its own: a state file beside the
 * quest's own, `process-state.<quest>.<run>.yaml`, holding a stack of levels
 * like the quest's file (any process; two runs may follow different ones).
 * The `default` run is the quest's file as it always was,
 * `process-state.<quest>.yaml`: it is always there, cannot be deleted, and a
 * quest without runs needs no migration.
 *
 * Pure name rules and file names, no fs (processRepository.ts reads and
 * writes the files).
 */

/** The run every quest has: its own state file. */
export const DEFAULT_RUN = 'default';

/** A run name: letters, digits, `_` and `-`, starting with a letter or digit; no dot (it is part of a file name). */
const RUN_NAME = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/;

/** Why `name` cannot name a new run, or null when it can. */
export function runNameError(name: string): string | null {
    if (!RUN_NAME.test(name)) {
        return `"${name}" is no run name: letters, digits, "_" and "-", starting with a letter or digit, at most 64 characters`;
    }
    if (name === DEFAULT_RUN) { return 'every quest has the run "default" already'; }
    return null;
}

/** `run` as a run to read or write: an empty one is `default`. */
export function normalizeRun(run: string | undefined | null): string {
    const r = (run ?? '').trim();
    return r ? r : DEFAULT_RUN;
}

/** The state file name of `run` of `quest`. */
export function runStateFileName(quest: string, run: string = DEFAULT_RUN): string {
    return run === DEFAULT_RUN ? `process-state.${quest}.yaml` : `process-state.${quest}.${run}.yaml`;
}

/** The run a file of the quest folder is the state of, or null when it is none. */
export function runOfStateFile(quest: string, fileName: string): string | null {
    if (fileName === runStateFileName(quest)) { return DEFAULT_RUN; }
    const prefix = `process-state.${quest}.`;
    if (!fileName.startsWith(prefix) || !fileName.endsWith('.yaml')) { return null; }
    const run = fileName.slice(prefix.length, -'.yaml'.length);
    return RUN_NAME.test(run) && run !== DEFAULT_RUN ? run : null;
}
