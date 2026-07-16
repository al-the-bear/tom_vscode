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

/**
 * True when the file is a terminal archive/delete file — i.e. the first
 * dot-separated segment of its basename ends in `-archived` or `-deleted`.
 */
export function isArchivedOrDeletedTodoFile(fileName: string): boolean {
    const seg = firstSegment(fileName);
    return seg.endsWith(ARCHIVED_SUFFIX) || seg.endsWith(DELETED_SUFFIX);
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
