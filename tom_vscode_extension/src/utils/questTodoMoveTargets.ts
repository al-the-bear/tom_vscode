/**
 * Pure helper for the "Move selected to other todo file" panel action.
 *
 * Given the list of a quest's `*.todo.yaml` files and the source file(s) of
 * the todos being moved, compute the set of files that make sense as move
 * targets:
 *
 *   - Terminal archive/delete siblings (`*-archived.*` / `*-deleted.*`) are
 *     never offered — they are write-once destinations owned by the
 *     archive/delete actions, not general move targets.
 *   - When every selected todo shares a single source file, that file is
 *     excluded (moving a todo into the file it already lives in is a no-op).
 *     When the selection spans multiple files, all non-terminal files are
 *     offered so a todo from file A can still be gathered into file B.
 *
 * Comparison is by basename, so callers may pass either bare names or paths.
 */

import * as path from 'path';
import { isArchivedOrDeletedTodoFile } from './todoArchiveNames';

function baseName(fileName: string): string {
    return path.basename(fileName);
}

export function computeMoveTargetFiles(
    allTodoFiles: readonly string[],
    sourceFiles: readonly string[],
): string[] {
    const distinctSources = Array.from(
        new Set(sourceFiles.map(baseName).filter(Boolean)),
    );
    const excludeSource = distinctSources.length === 1 ? distinctSources[0] : undefined;
    return allTodoFiles
        .map(baseName)
        .filter(f => f.endsWith('.todo.yaml'))
        .filter(f => !isArchivedOrDeletedTodoFile(f))
        .filter(f => f !== excludeSource);
}
