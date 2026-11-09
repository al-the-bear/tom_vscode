/**
 * A unified diff of two texts, for dry runs: what a write would change,
 * shown before anything is written.
 *
 * Line-based, three lines of context, `--- a/<name>` / `+++ b/<name>` headers
 * and `@@ -l,n +l,n @@` hunks in the usual form.
 *
 * Bounded for large documents (a TomSpecs document can hold 300 000 lines):
 * the common prefix and suffix are trimmed; a changed middle is split at the
 * lines that occur exactly once on each side and in the same order (patience
 * diff), and only a piece small enough for a longest-common-subsequence table
 * ({@link LCS_CELLS} cells) is aligned line by line. A larger piece with no
 * such anchor is shown as removed, then added — a coarser diff, never an
 * allocation that grows with the product of the two lengths.
 *
 * Pure; no dependency.
 */

const CONTEXT = 3;

/** The largest LCS table (rows × columns) a piece is aligned with. */
export const LCS_CELLS = 4_000_000;

type Kind = ' ' | '-' | '+';
type Op = { kind: Kind; text: string };

function splitLines(text: string): string[] {
    if (text === '') { return []; }
    const parts = text.split('\n');
    // A trailing newline ends the last line rather than starting an empty one.
    if (parts[parts.length - 1] === '') { parts.pop(); }
    return parts;
}

/** Edit script of a[aLo..aHi) against b[bLo..bHi) by longest common subsequence. */
function lcsOps(a: string[], aLo: number, aHi: number, b: string[], bLo: number, bHi: number, ops: Op[]): void {
    const n = aHi - aLo;
    const m = bHi - bLo;
    // lcs[i][j] = LCS length of a[aLo+i..] and b[bLo+j..], kept as one flat array.
    const lcs = new Uint32Array((n + 1) * (m + 1));
    const at = (i: number, j: number): number => i * (m + 1) + j;
    for (let i = n - 1; i >= 0; i--) {
        for (let j = m - 1; j >= 0; j--) {
            lcs[at(i, j)] = a[aLo + i] === b[bLo + j]
                ? lcs[at(i + 1, j + 1)] + 1
                : Math.max(lcs[at(i + 1, j)], lcs[at(i, j + 1)]);
        }
    }
    let i = 0;
    let j = 0;
    while (i < n && j < m) {
        if (a[aLo + i] === b[bLo + j]) {
            ops.push({ kind: ' ', text: a[aLo + i] }); i++; j++;
        } else if (lcs[at(i + 1, j)] >= lcs[at(i, j + 1)]) {
            ops.push({ kind: '-', text: a[aLo + i] }); i++;
        } else {
            ops.push({ kind: '+', text: b[bLo + j] }); j++;
        }
    }
    while (i < n) { ops.push({ kind: '-', text: a[aLo + i++] }); }
    while (j < m) { ops.push({ kind: '+', text: b[bLo + j++] }); }
}

/**
 * Pairs (i, j) of lines unique in a[aLo..aHi) and in b[bLo..bHi) with
 * a[i] === b[j], the longest run increasing in both (patience anchors).
 */
function anchors(a: string[], aLo: number, aHi: number, b: string[], bLo: number, bHi: number): Array<[number, number]> {
    const seen = new Map<string, { ia: number; ca: number; ib: number; cb: number }>();
    for (let i = aLo; i < aHi; i++) {
        const s = seen.get(a[i]);
        if (s) { s.ca++; } else { seen.set(a[i], { ia: i, ca: 1, ib: -1, cb: 0 }); }
    }
    for (let j = bLo; j < bHi; j++) {
        const s = seen.get(b[j]);
        if (s) { s.cb++; s.ib = j; }
    }
    const pairs: Array<[number, number]> = [];
    for (const s of seen.values()) {
        if (s.ca === 1 && s.cb === 1) { pairs.push([s.ia, s.ib]); }
    }
    pairs.sort((x, y) => x[0] - y[0]);
    // Longest increasing subsequence of the b positions (patience sorting).
    const tails: number[] = [];
    const prev = new Int32Array(pairs.length).fill(-1);
    for (let k = 0; k < pairs.length; k++) {
        let lo = 0;
        let hi = tails.length;
        while (lo < hi) {
            const mid = (lo + hi) >> 1;
            if (pairs[tails[mid]][1] < pairs[k][1]) { lo = mid + 1; } else { hi = mid; }
        }
        if (lo > 0) { prev[k] = tails[lo - 1]; }
        tails[lo] = k;
    }
    const run: Array<[number, number]> = [];
    for (let k = tails.length ? tails[tails.length - 1] : -1; k >= 0; k = prev[k]) { run.push(pairs[k]); }
    return run.reverse();
}

/** Edit script of a[aLo..aHi) against b[bLo..bHi), appended to `ops`. */
function diffOps(a: string[], aLo: number, aHi: number, b: string[], bLo: number, bHi: number, ops: Op[]): void {
    while (aLo < aHi && bLo < bHi && a[aLo] === b[bLo]) { ops.push({ kind: ' ', text: a[aLo] }); aLo++; bLo++; }
    const tail: Op[] = [];
    while (aHi > aLo && bHi > bLo && a[aHi - 1] === b[bHi - 1]) { aHi--; bHi--; tail.push({ kind: ' ', text: a[aHi] }); }
    const n = aHi - aLo;
    const m = bHi - bLo;
    if (n === 0 || m === 0) {
        for (let i = aLo; i < aHi; i++) { ops.push({ kind: '-', text: a[i] }); }
        for (let j = bLo; j < bHi; j++) { ops.push({ kind: '+', text: b[j] }); }
    } else if ((n + 1) * (m + 1) <= LCS_CELLS) {
        lcsOps(a, aLo, aHi, b, bLo, bHi, ops);
    } else {
        const run = anchors(a, aLo, aHi, b, bLo, bHi);
        if (run.length === 0) {
            for (let i = aLo; i < aHi; i++) { ops.push({ kind: '-', text: a[i] }); }
            for (let j = bLo; j < bHi; j++) { ops.push({ kind: '+', text: b[j] }); }
        } else {
            let i = aLo;
            let j = bLo;
            for (const [ai, bj] of run) {
                diffOps(a, i, ai, b, j, bj, ops);
                ops.push({ kind: ' ', text: a[ai] });
                i = ai + 1;
                j = bj + 1;
            }
            diffOps(a, i, aHi, b, j, bHi, ops);
        }
    }
    for (let k = tail.length - 1; k >= 0; k--) { ops.push(tail[k]); }
}

/**
 * The unified diff turning `before` into `after`, or '' when they are equal.
 * `name` is used in both file headers.
 */
export function unifiedDiff(before: string, after: string, name: string): string {
    if (before === after) { return ''; }
    const a = splitLines(before);
    const b = splitLines(after);
    const ops: Op[] = [];
    diffOps(a, 0, a.length, b, 0, b.length, ops);

    // Group changes into hunks: a change plus CONTEXT lines either side, with
    // hunks whose context would touch merged into one.
    const changed: number[] = [];
    for (let k = 0; k < ops.length; k++) { if (ops[k].kind !== ' ') { changed.push(k); } }
    const out: string[] = [`--- a/${name}`, `+++ b/${name}`];
    // Line numbers before ops[cursor], advanced as the hunks move forward.
    let cursor = 0;
    let oldLine = 1;
    let newLine = 1;
    let h = 0;
    while (h < changed.length) {
        let end = h;
        while (end + 1 < changed.length && changed[end + 1] - changed[end] <= 2 * CONTEXT) { end++; }
        const from = Math.max(0, changed[h] - CONTEXT);
        const to = Math.min(ops.length - 1, changed[end] + CONTEXT);
        for (; cursor < from; cursor++) {
            if (ops[cursor].kind !== '+') { oldLine++; }
            if (ops[cursor].kind !== '-') { newLine++; }
        }
        let oldCount = 0;
        let newCount = 0;
        for (let k = from; k <= to; k++) {
            if (ops[k].kind !== '+') { oldCount++; }
            if (ops[k].kind !== '-') { newCount++; }
        }
        out.push(`@@ -${oldCount === 0 ? oldLine - 1 : oldLine},${oldCount} +${newCount === 0 ? newLine - 1 : newLine},${newCount} @@`);
        for (let k = from; k <= to; k++) { out.push(`${ops[k].kind}${ops[k].text}`); }
        h = end + 1;
    }
    return `${out.join('\n')}\n`;
}
