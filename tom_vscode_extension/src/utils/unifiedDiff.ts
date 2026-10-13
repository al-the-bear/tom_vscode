/**
 * A unified diff of two texts, for dry runs: what a write would change,
 * shown before anything is written.
 *
 * Line-based, three lines of context, `--- a/<name>` / `+++ b/<name>` headers
 * and `@@ -l,n +l,n @@` hunks in the usual form. The common prefix and suffix
 * are trimmed before the longest-common-subsequence step, so a large document
 * with a few edits costs little: the LCS runs only over the changed middle.
 *
 * Pure; no dependency.
 */

const CONTEXT = 3;

type Op = { kind: ' ' | '-' | '+'; text: string };

function splitLines(text: string): string[] {
    if (text === '') { return []; }
    const parts = text.split('\n');
    // A trailing newline ends the last line rather than starting an empty one.
    if (parts[parts.length - 1] === '') { parts.pop(); }
    return parts;
}

/** Edit script for the changed middle, by longest common subsequence. */
function middleOps(a: string[], b: string[]): Op[] {
    const n = a.length;
    const m = b.length;
    // lcs[i][j] = LCS length of a[i..] and b[j..], kept as one flat array.
    const lcs = new Uint32Array((n + 1) * (m + 1));
    const at = (i: number, j: number): number => i * (m + 1) + j;
    for (let i = n - 1; i >= 0; i--) {
        for (let j = m - 1; j >= 0; j--) {
            lcs[at(i, j)] = a[i] === b[j]
                ? lcs[at(i + 1, j + 1)] + 1
                : Math.max(lcs[at(i + 1, j)], lcs[at(i, j + 1)]);
        }
    }
    const ops: Op[] = [];
    let i = 0;
    let j = 0;
    while (i < n && j < m) {
        if (a[i] === b[j]) {
            ops.push({ kind: ' ', text: a[i] }); i++; j++;
        } else if (lcs[at(i + 1, j)] >= lcs[at(i, j + 1)]) {
            ops.push({ kind: '-', text: a[i] }); i++;
        } else {
            ops.push({ kind: '+', text: b[j] }); j++;
        }
    }
    while (i < n) { ops.push({ kind: '-', text: a[i++] }); }
    while (j < m) { ops.push({ kind: '+', text: b[j++] }); }
    return ops;
}

/**
 * The unified diff turning `before` into `after`, or '' when they are equal.
 * `name` is used in both file headers.
 */
export function unifiedDiff(before: string, after: string, name: string): string {
    if (before === after) { return ''; }
    const a = splitLines(before);
    const b = splitLines(after);

    let prefix = 0;
    while (prefix < a.length && prefix < b.length && a[prefix] === b[prefix]) { prefix++; }
    let suffix = 0;
    while (suffix < a.length - prefix && suffix < b.length - prefix
        && a[a.length - 1 - suffix] === b[b.length - 1 - suffix]) { suffix++; }

    const ops: Op[] = [
        ...a.slice(0, prefix).map((text) => ({ kind: ' ' as const, text })),
        ...middleOps(a.slice(prefix, a.length - suffix), b.slice(prefix, b.length - suffix)),
        ...a.slice(a.length - suffix).map((text) => ({ kind: ' ' as const, text })),
    ];

    // Group changes into hunks: a change plus CONTEXT lines either side, with
    // hunks whose context would touch merged into one.
    const changed = ops.map((op, k) => (op.kind === ' ' ? -1 : k)).filter((k) => k >= 0);
    const out: string[] = [`--- a/${name}`, `+++ b/${name}`];
    let h = 0;
    while (h < changed.length) {
        let end = h;
        while (end + 1 < changed.length && changed[end + 1] - changed[end] <= 2 * CONTEXT) { end++; }
        const from = Math.max(0, changed[h] - CONTEXT);
        const to = Math.min(ops.length - 1, changed[end] + CONTEXT);

        // Line numbers of the hunk start in each file: count lines before it.
        let oldLine = 1;
        let newLine = 1;
        for (let k = 0; k < from; k++) {
            if (ops[k].kind !== '+') { oldLine++; }
            if (ops[k].kind !== '-') { newLine++; }
        }
        const body = ops.slice(from, to + 1);
        const oldCount = body.filter((op) => op.kind !== '+').length;
        const newCount = body.filter((op) => op.kind !== '-').length;
        out.push(`@@ -${oldCount === 0 ? oldLine - 1 : oldLine},${oldCount} +${newCount === 0 ? newLine - 1 : newLine},${newCount} @@`);
        for (const op of body) { out.push(`${op.kind}${op.text}`); }
        h = end + 1;
    }
    return `${out.join('\n')}\n`;
}
