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
