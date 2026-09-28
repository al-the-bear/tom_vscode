/**
 * Naming helpers for the todo archive/delete file rule (TRA01).
 *
 * The archive/delete sibling of a todo file is derived by suffixing the
 * FIRST dot-separated segment of the file name with `-archived` /
 * `-deleted`:
 *
 *   todos.vscode_extension.todo.yaml
 *     -> todos-archived.vscode_extension.todo.yaml   (archive)
 *     -> todos-deleted.vscode_extension.todo.yaml    (delete)
 *
 * A file whose first segment already ends in `-archived` or `-deleted`
 * is TERMINAL: it can never be the source of an archive/delete move, and
 * the editor shows no archive/delete buttons for it. The derivation
 * helpers throw when given a terminal name — callers are expected to
 * guard with `isArchivedOrDeletedTodoFile` first.
 *
 * All helpers accept either a bare file name or a full path; only the
 * basename is inspected/transformed.
 */

import * as path from 'path';

const ARCHIVED_SUFFIX = '-archived';
const DELETED_SUFFIX = '-deleted';

/** First dot-separated segment of the basename. */
function firstSegment(fileName: string): string {
    const base = path.basename(fileName);
    const dot = base.indexOf('.');
    return dot === -1 ? base : base.slice(0, dot);
}

/** True when the file is a terminal ARCHIVE file (`-archived` first segment). */
export function isArchivedTodoFile(fileName: string): boolean {
    return firstSegment(fileName).endsWith(ARCHIVED_SUFFIX);
}

/** True when the file is a terminal DELETE file (`-deleted` first segment). */
export function isDeletedTodoFile(fileName: string): boolean {
    return firstSegment(fileName).endsWith(DELETED_SUFFIX);
}

/**
 * True when the file is a terminal archive/delete file — i.e. the first
 * dot-separated segment of its basename ends in `-archived` or `-deleted`.
 */
export function isArchivedOrDeletedTodoFile(fileName: string): boolean {
    return isArchivedTodoFile(fileName) || isDeletedTodoFile(fileName);
}

/**
 * Which classes of todo file a listing should include (TRA13).
 *
 * A todo file is exactly one of three kinds, decided by its first
 * dot-segment: `-archived` (archive sibling), `-deleted` (delete sibling),
 * or otherwise NORMAL — which covers both the quest todo files and the
 * session todo files, since neither is terminal.
 *
 * The defaults answer the question "what does the caller mean by *the*
 * todos of this quest": the live ones. Archived and deleted todos are
 * deliberately retired, so counting or iterating over them is virtually
 * always a bug — see the `<prefix>*` repeat count, which used to inflate
 * its iteration count with todos the user had archived. Callers that
 * genuinely need the retired files (the file picker, find-by-id lookups
 * that must still resolve an archived todo) opt back in explicitly.
 */
export interface TodoFileScope {
    /** Include non-terminal files (quest + session todos). Default `true`. */
    showNormalFiles?: boolean;
    /** Include `-archived` siblings. Default `false`. */
    showArchiveFiles?: boolean;
    /** Include `-deleted` siblings. Default `false`. */
    showDeletedFiles?: boolean;
}

/** Scope that admits every todo file, for callers that must see retired ones. */
export const ALL_TODO_FILES: TodoFileScope = Object.freeze({
    showNormalFiles: true,
    showArchiveFiles: true,
    showDeletedFiles: true,
});

/** True when `fileName` belongs to the classes admitted by `scope`. */
export function matchesTodoFileScope(fileName: string, scope?: TodoFileScope): boolean {
    if (isArchivedTodoFile(fileName)) { return scope?.showArchiveFiles === true; }
    if (isDeletedTodoFile(fileName)) { return scope?.showDeletedFiles === true; }
    return scope?.showNormalFiles !== false;
}

function derivedName(fileName: string, suffix: string): string {
    if (isArchivedOrDeletedTodoFile(fileName)) {
        throw new Error(
            `Cannot derive an archive/delete sibling for terminal todo file: ${path.basename(fileName)}`,
        );
    }
    const dir = path.dirname(fileName);
    const base = path.basename(fileName);
    const dot = base.indexOf('.');
    const newBase = dot === -1
        ? base + suffix
        : base.slice(0, dot) + suffix + base.slice(dot);
    // path.dirname('name.yaml') === '.' — return the bare name in that case.
    return dir === '.' && !fileName.includes(path.sep) && !fileName.includes('/')
        ? newBase
        : path.join(dir, newBase);
}

/** Archive sibling name (first segment suffixed with `-archived`). */
export function archivedTodoFileName(fileName: string): string {
    return derivedName(fileName, ARCHIVED_SUFFIX);
}

/** Delete sibling name (first segment suffixed with `-deleted`). */
export function deletedTodoFileName(fileName: string): string {
    return derivedName(fileName, DELETED_SUFFIX);
}
