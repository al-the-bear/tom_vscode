/**
 * sessionTodoNames — pure naming helpers for session todo files (TRA04).
 *
 * Session todos live in ONE stable file per host+quest inside the quest
 * folder: `session-todo.<host>.<quest>.todo.yaml`, where `<host>` is
 * `WsPaths.hostSlug()`. Because the `_ai` clone is shared/synced across the
 * fleet, the host slug keeps each machine's session todos separate while the
 * file itself is git-tracked and survives window reloads.
 *
 * The pre-TRA04 scheme created one file per window
 * (`{YYYYMMDD}_{HHMM}_win-{windowId}.todo.yaml`); those legacy files are
 * merged into the stable file on first access (see SessionTodoStore) but the
 * detection predicate still recognises them so leftover files from hosts
 * that have not migrated yet keep showing in the session view.
 *
 * Pure (no vscode imports) so it is testable under `npm run test:utils`.
 */

/** Fixed first dot-segment of the stable session todo file name. */
export const SESSION_TODO_PREFIX = 'session-todo';

/** Legacy per-window session file: `{YYYYMMDD}_{HHMM}_win-*.todo.yaml`. */
const LEGACY_SESSION_TODO_RE = /^\d{8}_\d{4}_win-.*\.todo\.yaml$/;

/** Stable per-host session file: `session-todo.<host>.<quest>.todo.yaml`. */
const SESSION_TODO_RE = /^session-todo\.[^.]+\..+\.todo\.yaml$/;

/**
 * Stable session todo file name for a host+quest pair.
 * `session-todo.<host>.<quest>.todo.yaml`
 */
export function sessionTodoFilename(hostSlug: string, questId: string): string {
    return `${SESSION_TODO_PREFIX}.${hostSlug}.${questId}.todo.yaml`;
}

/** True for a pre-TRA04 per-window session file name. */
export function isLegacySessionTodoFileName(name: string): boolean {
    return LEGACY_SESSION_TODO_RE.test(name);
}

/**
 * True when `name` is a session todo file (stable per-host form or the
 * legacy per-window form). Accepts bare file names, not paths.
 */
export function isSessionTodoFileName(name: string): boolean {
    return SESSION_TODO_RE.test(name) || LEGACY_SESSION_TODO_RE.test(name);
}
