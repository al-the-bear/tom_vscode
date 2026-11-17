/**
 * What the five `_ai` merge drivers share (vscimpb142c): the outcome of a
 * merge, and the few Python string semantics the ports keep so that they give
 * the same bytes as the Python drivers they replace
 * (al_the_bear/.claude/skills/_lib/merge_drivers/*.py): a length counted in
 * code points, `str.splitlines()`, `str.strip('\n')`.
 *
 * vscode-free and pure.
 */

/**
 * A driver's answer for ours (%A) and theirs (%B):
 *   - `merged`: write `text` to %A (exit 0);
 *   - `keep`: ours stays as it is on disk (exit 0);
 *   - `fail`: git falls back to its conflict markers (exit 1); `message` goes to stderr.
 */
export type MergeOutcome =
    | { status: 'merged'; text: string }
    | { status: 'keep' }
    | { status: 'fail'; message: string };

/** The text of a side; `undefined` when the file is missing. */
export interface MergeSides {
    ancestor?: string;
    ours?: string;
    theirs?: string;
    /** %P: the path git shows (messages only). */
    display?: string;
}

/** Python's `len(str)`: code points, not UTF-16 units (an emoji counts once). */
export function pyLen(s: string): number {
    let n = 0;
    for (const _ of s) { n++; }
    return n;
}

/** Python's `str.strip('\n')`. */
export function stripNewlines(s: string): string {
    let a = 0;
    let b = s.length;
    while (a < b && s[a] === '\n') { a++; }
    while (b > a && s[b - 1] === '\n') { b--; }
    return s.slice(a, b);
}

/** Python's `str.strip()` (whitespace) emptiness test. */
export function isBlank(s: string | undefined): boolean {
    return !s || s.trim() === '';
}

/** The line boundaries of Python's `str.splitlines()`. */
const SPLITLINES = new RegExp('\\r\\n|[\\n\\r\\v\\f\\x1c\\x1d\\x1e\\x85\\u2028\\u2029]');

/** Python's `str.splitlines()`: no empty last element for a text ending in a line break. */
export function pySplitlines(s: string): string[] {
    if (s === '') { return []; }
    const parts = s.split(SPLITLINES);
    if (parts.length && parts[parts.length - 1] === '' && SPLITLINES.test(s.slice(-1))) { parts.pop(); }
    return parts;
}

/** Python's `max(a, b)` / `a >= b` on strings: compared by code point. */
export function pyCompare(a: string, b: string): number {
    const x = [...a];
    const y = [...b];
    for (let i = 0; i < Math.min(x.length, y.length); i++) {
        const d = x[i].codePointAt(0)! - y[i].codePointAt(0)!;
        if (d !== 0) { return d; }
    }
    return x.length - y.length;
}

/** A stable sort by a string key, compared as Python does. */
export function sortByKey<T>(items: T[], key: (t: T) => string): T[] {
    return items.map((item, i) => ({ item, i, k: key(item) }))
        .sort((p, q) => pyCompare(p.k, q.k) || p.i - q.i)
        .map((p) => p.item);
}
