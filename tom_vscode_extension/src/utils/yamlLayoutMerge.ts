/**
 * Keep a YAML file's own layout where its values did not change.
 *
 * A TomSpecs document is saved by encoding the whole document again. The file
 * on disk may come from another writer (the Dart runtime, a project's own
 * tool, a hand edit) whose key order and scalar styles differ — `high` written
 * plain or as a `|2-` block, `specificationStatus` before or after
 * `specificationDate` — so the fresh encoding would rewrite the whole file for
 * an edit of one value. {@link mergeYamlLayout} takes the fresh encoding and the
 * original text and answers the encoding with every unchanged part written as
 * the original wrote it:
 *
 *   - a mapping keeps the original's key order, unless the edit reordered it:
 *     given `encodedBefore` (the document before the edit, by the same
 *     encoder), a mapping whose keys the two encodings order differently — a
 *     list item moved; list items are ordered — takes the encoding's order; a
 *     key only the encoding has is placed after its predecessor in the
 *     encoding's order (first when none); a key only the original has is
 *     dropped (its value was removed);
 *   - a value that reads the same in both (`yaml.parse` of the entry) keeps the
 *     original's text, style and trailing blank lines; a changed one takes the
 *     encoding's text;
 *   - comment lines stay with the entry they precede; the file's leading
 *     comments stay with the first entry.
 *
 * Only block mappings are walked. Anything else — a sequence, a flow
 * collection, a line that is not `key: …` — is one value, compared as a whole.
 * The caller checks the result (it must decode to the same document as the
 * encoding); this module only rearranges lines and never invents text.
 *
 * Pure; depends only on the `yaml` package.
 */

import { parse as parseYaml } from 'yaml';

interface Entry {
    /** The key as read (quotes removed). */
    key: string;
    /** First line of the entry, leading comment lines included. */
    start: number;
    /** The `key:` line. */
    keyLine: number;
    /** One past the last line, trailing blank lines included. */
    end: number;
    indent: number;
    /** The entries of the mapping this key holds; null for any other value. */
    children: Entry[] | null;
}

/**
 * A `key: rest` line at `indent`: the key as written and what follows the
 * colon; null for anything else (a sequence item, a flow collection, a scalar).
 */
function splitKeyLine(line: string, indent: number): { raw: string; rest: string } | null {
    const s = line.slice(indent);
    if (s === '' || s === '-' || s.startsWith('- ') || '?[{#|>'.includes(s[0])) { return null; }
    let colon: number;
    if (s[0] === '"' || s[0] === '\'') {
        const q = s[0];
        let k = 1;
        while (k < s.length) {
            if (q === '"' && s[k] === '\\') { k += 2; continue; }
            if (s[k] === q) {
                if (q === '\'' && s[k + 1] === '\'') { k += 2; continue; }
                break;
            }
            k++;
        }
        if (k >= s.length) { return null; }
        colon = k + 1;
        while (colon < s.length && s[colon] === ' ') { colon++; }
        if (s[colon] !== ':') { return null; }
    } else {
        colon = -1;
        for (let k = 0; k < s.length; k++) {
            if (s[k] === ':' && (k + 1 === s.length || s[k + 1] === ' ')) { colon = k; break; }
            if (s[k] === '#' && k > 0 && s[k - 1] === ' ') { return null; }
        }
        if (colon <= 0) { return null; }
    }
    if (colon + 1 < s.length && s[colon + 1] !== ' ') { return null; }
    return { raw: s.slice(0, colon).trimEnd(), rest: s.slice(colon + 1).trim() };
}

/** A text as lines, with each line's indent (-1 for a blank line) computed once. */
interface Text {
    lines: string[];
    ind: Int32Array;
    finalNewline: boolean;
}

function toText(text: string): Text {
    const lines = text.split('\n');
    const finalNewline = lines.length > 0 && lines[lines.length - 1] === '';
    if (finalNewline) { lines.pop(); }
    const ind = new Int32Array(lines.length);
    for (let k = 0; k < lines.length; k++) {
        const line = lines[k];
        let n = 0;
        while (n < line.length && line.charCodeAt(n) === 32) { n++; }
        ind[k] = n === line.length ? -1 : n;
    }
    return { lines, ind, finalNewline };
}

function isComment(t: Text, k: number): boolean {
    return t.ind[k] >= 0 && t.lines[k].charCodeAt(t.ind[k]) === 35; // '#'
}

function keyOf(raw: string): string {
    if (raw.startsWith('"') || raw.startsWith('\'')) {
        try {
            const parsed = parseYaml(`${raw}: 0`) as Record<string, unknown>;
            return Object.keys(parsed)[0] ?? raw;
        } catch {
            return raw;
        }
    }
    return raw.trimEnd();
}

/**
 * The entries of the block mapping on lines [from, to), all at one indent, or
 * null when the lines are not such a mapping.
 */
function parseMapping(t: Text, from: number, to: number): Entry[] | null {
    const { lines, ind } = t;
    let first = from;
    while (first < to && (ind[first] < 0 || isComment(t, first))) { first++; }
    if (first >= to) { return null; }
    const indent = ind[first];
    const entries: Entry[] = [];
    let i = from;
    while (i < to) {
        // Leading blank and comment lines belong to the entry that follows.
        const start = i;
        while (i < to && (ind[i] < 0 || (isComment(t, i) && ind[i] <= indent))) { i++; }
        if (i >= to) {
            // Trailing trivia: the last entry's.
            if (entries.length === 0) { return null; }
            entries[entries.length - 1].end = to;
            break;
        }
        const line = lines[i];
        if (ind[i] !== indent) { return null; }
        const m = splitKeyLine(line, indent);
        if (!m || m.raw === '') { return null; }
        const keyLine = i;
        i++;
        // The body: deeper lines and blank lines; blank lines after it end this entry.
        while (i < to && (ind[i] < 0 || ind[i] > indent)) { i++; }
        const rest = m.rest;
        const valueless = rest === '' || rest.startsWith('#');
        let bodyEnd = i;
        while (bodyEnd > keyLine + 1 && ind[bodyEnd - 1] < 0) { bodyEnd--; }
        const children = valueless && bodyEnd > keyLine + 1 ? parseMapping(t, keyLine + 1, bodyEnd) : null;
        entries.push({ key: keyOf(m.raw), start, keyLine, end: i, indent, children });
    }
    const keys = new Set(entries.map((e) => e.key));
    return keys.size === entries.length ? entries : null;
}

/**
 * `v` with every number and boolean as its text: a TomSpecs document stores
 * scalar values as strings, so `6` written plain and `6` written as a `|2-`
 * block are the same value.
 */
function asStored(v: unknown): unknown {
    if (typeof v === 'number' || typeof v === 'boolean') { return String(v); }
    if (Array.isArray(v)) { return v.map(asStored); }
    if (v !== null && typeof v === 'object') {
        return Object.fromEntries(Object.entries(v as Record<string, unknown>).map(([k, x]) => [k, asStored(x)]));
    }
    return v;
}

/**
 * An entry's value as the document stores it, as a comparable string; null
 * when it does not parse. A one-line `key: rest` that standard YAML rejects —
 * the SOM TypeScript runtime writes values such as `a: b` or `` `x` y`` plain,
 * which its own reader takes as the text after the colon — reads as that text.
 */
function valueOf(t: Text, e: Entry): string | null {
    const { lines, ind } = t;
    const text = lines.slice(e.keyLine, e.end).map((l, k) => (ind[e.keyLine + k] < 0 ? '' : l.slice(e.indent))).join('\n');
    try {
        return JSON.stringify(asStored(Object.values(parseYaml(text, { uniqueKeys: false }) as Record<string, unknown>)));
    } catch {
        let last = e.end;
        while (last > e.keyLine + 1 && ind[last - 1] < 0) { last--; }
        if (last !== e.keyLine + 1) { return null; }
        const rest = splitKeyLine(lines[e.keyLine], e.indent)?.rest ?? '';
        if (rest === '' || '"\'|>[{&*!%#'.includes(rest[0])) { return null; }
        return JSON.stringify([rest]);
    }
}

function sameLines(a: Text, ea: Entry, b: Text, eb: Entry): boolean {
    if (ea.end - ea.keyLine !== eb.end - eb.keyLine) { return false; }
    for (let k = 0; k < ea.end - ea.keyLine; k++) {
        if (a.lines[ea.keyLine + k] !== b.lines[eb.keyLine + k]) { return false; }
    }
    return true;
}

class Merger {
    readonly out: string[] = [];

    constructor(private readonly orig: Text, private readonly enc: Text) {}

    private copy(t: Text, from: number, to: number): void {
        for (let k = from; k < to; k++) { this.out.push(t.lines[k]); }
    }

    /** The encoding's entries `n` written with the original's `o` wherever they agree. */
    mapping(o: Entry[], n: Entry[], b: Entry[] | null): void {
        const beforeByKey = new Map((b ?? []).map((e) => [e.key, e]));
        if (b && reordered(b, n)) {
            const origByKey = new Map(o.map((e) => [e.key, e]));
            for (const ne of n) {
                const oe = origByKey.get(ne.key);
                if (oe) { this.entry(oe, ne, beforeByKey.get(ne.key) ?? null); } else { this.copy(this.enc, ne.start, ne.end); }
            }
            return;
        }
        const byKey = new Map(n.map((e) => [e.key, e]));
        const origKeys = new Set(o.map((e) => e.key));
        // Keys only the encoding has, grouped under the common key before them.
        const after = new Map<string | null, Entry[]>();
        let previous: string | null = null;
        for (const e of n) {
            if (origKeys.has(e.key)) { previous = e.key; continue; }
            const list = after.get(previous) ?? [];
            list.push(e);
            after.set(previous, list);
        }
        for (const e of after.get(null) ?? []) { this.copy(this.enc, e.start, e.end); }
        for (const oe of o) {
            const ne = byKey.get(oe.key);
            if (!ne) { continue; }
            this.entry(oe, ne, beforeByKey.get(oe.key) ?? null);
            for (const e of after.get(oe.key) ?? []) { this.copy(this.enc, e.start, e.end); }
        }
    }

    private entry(o: Entry, n: Entry, b: Entry | null): void {
        if (o.children && n.children) {
            this.copy(this.orig, o.start, o.keyLine + 1);
            this.mapping(o.children, n.children, b?.children ?? null);
            // Blank lines after the last child that the child ranges did not take.
            const last = o.children[o.children.length - 1];
            this.copy(this.orig, last.end, o.end);
            return;
        }
        if (sameLines(this.orig, o, this.enc, n)) {
            this.copy(this.orig, o.start, o.end);
            return;
        }
        const ov = valueOf(this.orig, o);
        if (ov !== null && ov === valueOf(this.enc, n)) {
            this.copy(this.orig, o.start, o.end);
            return;
        }
        // Changed: the encoding's value, under the original's leading comments.
        this.copy(this.orig, o.start, o.keyLine);
        this.copy(this.enc, n.keyLine, n.end);
    }
}

/** Whether `n` orders the keys it shares with `b` differently. */
function reordered(b: Entry[], n: Entry[]): boolean {
    const inN = new Set(n.map((e) => e.key));
    const inB = new Set(b.map((e) => e.key));
    const fromB = b.filter((e) => inN.has(e.key));
    const fromN = n.filter((e) => inB.has(e.key));
    return fromB.some((e, k) => e.key !== fromN[k].key);
}

/**
 * `encoded` with every part whose value did not change written as `original`
 * writes it; `encoded` itself when either is not a block mapping at the top.
 */
export function mergeYamlLayout(original: string, encoded: string, encodedBefore?: string): string {
    if (original === encoded) { return encoded; }
    const o = toText(original);
    const n = toText(encoded);
    const om = parseMapping(o, 0, o.lines.length);
    const nm = parseMapping(n, 0, n.lines.length);
    if (!om || !nm) { return encoded; }
    const b = encodedBefore === undefined ? null : toText(encodedBefore);
    const bm = b ? parseMapping(b, 0, b.lines.length) : null;
    const merger = new Merger(o, n);
    merger.mapping(om, nm, bm);
    return merger.out.join('\n') + (n.finalNewline ? '\n' : '');
}
