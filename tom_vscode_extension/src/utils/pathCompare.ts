/**
 * Comparing file paths by the file they name, not by how they are spelled.
 *
 * `_ai` is one clone per machine; a workspace folder reaches it through a
 * symbolic link (`<workspace folder>/_ai` → `<root>/_ai`), so one quest file
 * has two spellings: through the link and through the root. Every comparison
 * of paths that may lie in `_ai` (watchers, "is this file in `_ai`", quest
 * folder detection, the MD Browser's and the todo files' matching) goes
 * through these helpers: both sides are resolved with `fs.realpathSync` (a
 * path that does not exist yet through its nearest existing folder), and on
 * Windows compared without case.
 *
 * vscode-free.
 */

import * as fs from 'fs';
import * as path from 'path';

/** The platform whose rules apply; tests pass another one. */
export type PathPlatform = NodeJS.Platform;

/**
 * The real path of `p`: absolute, symbolic links resolved. A path that does
 * not exist is resolved through its nearest existing folder, the rest
 * appended as written.
 */
export function realPathOf(p: string): string {
    const abs = path.resolve(p);
    try { return fs.realpathSync.native(abs); } catch { /* not there (yet) */ }
    const rest: string[] = [];
    let dir = abs;
    for (;;) {
        const parent = path.dirname(dir);
        if (parent === dir) { return abs; }
        rest.unshift(path.basename(dir));
        dir = parent;
        try { return path.join(fs.realpathSync.native(dir), ...rest); } catch { /* go up */ }
    }
}

/** The key two paths are compared by: the real path, lower case on Windows. */
export function pathKey(p: string, platform: PathPlatform = process.platform): string {
    const real = realPathOf(p);
    return platform === 'win32' ? real.toLowerCase() : real;
}

/** Whether `a` and `b` name the same file. */
export function samePath(a: string, b: string, platform: PathPlatform = process.platform): boolean {
    if (!a || !b) { return false; }
    return pathKey(a, platform) === pathKey(b, platform);
}

/**
 * The path of `child` below `parent` as segments (`[]` when they are the same),
 * read off the real path of `child` (its case kept); undefined when `child`
 * is not `parent` or below it.
 */
export function relativeInside(child: string, parent: string, platform: PathPlatform = process.platform): string[] | undefined {
    if (!child || !parent) { return undefined; }
    const realChild = realPathOf(child);
    const realParent = realPathOf(parent).replace(/[\\/]+$/, '');
    const fold = (s: string) => platform === 'win32' ? s.toLowerCase() : s;
    const c = fold(realChild);
    const p = fold(realParent);
    if (c === p) { return []; }
    const sep = c.charAt(p.length);
    if (!c.startsWith(p) || (sep !== '/' && sep !== '\\')) { return undefined; }
    return realChild.slice(realParent.length + 1).split(/[\\/]+/).filter((s) => s.length > 0);
}

/** Whether `child` is `parent` or lies below it. */
export function isInside(child: string, parent: string, platform: PathPlatform = process.platform): boolean {
    return relativeInside(child, parent, platform) !== undefined;
}
