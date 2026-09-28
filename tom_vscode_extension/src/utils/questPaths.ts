/**
 * Pure helpers for turning a quest id into the path segment that names its
 * folder and its files under `_ai/quests/`.
 *
 * The same normalisation was open-coded in four places (the live-trail writer,
 * the extension-config store, the chat panel's trail opener, and the @WS Logs
 * viewer). They must agree exactly — a quest whose folder the writer calls
 * `my_quest` but the reader calls `my-quest` silently reads an empty file — so
 * the rule lives here once. No `vscode`, no `fs`: absolute-path resolution
 * stays with the callers, which each have their own fallback root.
 */

import * as path from 'path';

/**
 * Subfolder of a quest folder that holds its generated trail files — the
 * compacted history plus the `<quest>.<subsystem>.{prompts,answers}.md` summary
 * pair.
 *
 * These are machine-written, grow without bound, and are gitignored, so they do
 * not belong beside the hand-maintained quest documents. The writers resolve
 * the folder from the configured `trail.summary.*FilePattern`; every reader
 * that scans for the files instead of resolving one by name goes through
 * {@link questTrailFolder}, so both ends name the same segment.
 */
export const QUEST_TRAIL_SUBFOLDER = 'history';

/**
 * The trail folder of the quest whose folder is `questFolder`.
 *
 * An empty input is passed straight back: callers that could not resolve a
 * workspace root hand on `''`, and joining that would silently produce a
 * relative `history` rooted at the process's cwd.
 */
export function questTrailFolder(questFolder: string): string {
    if (!questFolder) { return ''; }
    return path.join(questFolder, QUEST_TRAIL_SUBFOLDER);
}

/**
 * Normalise a quest id into a file-name-safe segment.
 *
 * Anything outside `[A-Za-z0-9_.-]` becomes an underscore. That removes path
 * separators — so a hostile or malformed id can never escape the quest folder
 * — along with shell- and glob-significant characters. An id that is empty, or
 * consists only of stripped characters, falls back to `default`, matching the
 * `_ai/quests/default/` folder the writers use when no quest is active.
 */
export function sanitizeQuestSegment(questId: string | undefined | null): string {
    const cleaned = (questId ?? '').replace(/[^A-Za-z0-9_.-]/g, '_');
    return cleaned.length > 0 ? cleaned : 'default';
}
