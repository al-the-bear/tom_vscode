/**
 * `ai-trail`: the block-aware, timestamp-sorting merge of the trail files
 * (the port of ai_merge_trail.py, vscimpb142c). Two formats, detected per file
 * by the first header:
 *
 *   - summary files: `=== PROMPT|ANSWER <id> <iso-ts> <seq> ===`, deduplicated
 *     by (kind, id), sorted by the timestamp;
 *   - the live trail: `## 🚀 PROMPT <yyyymmdd_hhmmss> …` after a preamble,
 *     deduplicated and sorted by the compact timestamp.
 *
 * Union by key, the longer body wins a collision (an append log loses
 * nothing; a body-less header or a half-streamed answer heals), sorted oldest
 * first; the preamble from ours, else theirs. Unrecognised: fail (git's
 * conflict markers). An empty side gives the other.
 *
 * A header line inside fenced code (``` or ~~~, closed by a fence at least as
 * long) is no header: a tool result quoting another trail stays in the block
 * it belongs to, as the extension's trail writer counts them
 * (services/live-trail.ts `promptHeaderLines`). The Python driver split there
 * (al_the_bear todo trailfence1); this is the one difference to it.
 *
 * vscode-free and pure.
 */

import { isBlank, pyLen, sortByKey, stripNewlines, type MergeOutcome, type MergeSides } from './common';

const SUMMARY_HEADER = /^=== (PROMPT|ANSWER) (\S+) (\S+) (\d+) ===\s*$/u;
const LIVETRAIL_HEADER = /^## \u{1F680} PROMPT (\d{8}_\d{6})(?![\p{L}\p{N}_])/u;

type Format = 'summary' | 'livetrail';

interface Entry { sortKey: string; dedupKey: string; header: string; body: string }

/** The indices of the lines matching `re` outside fenced code. */
export function headerLinesOutsideFences(lines: readonly string[], re: RegExp): number[] {
    const out: number[] = [];
    let fence: { char: string; length: number } | undefined;
    for (let i = 0; i < lines.length; i++) {
        const line = lines[i];
        const m = /^ {0,3}(`{3,}|~{3,})(.*)$/.exec(line);
        if (fence) {
            if (m && m[1][0] === fence.char && m[1].length >= fence.length && m[2].trim() === '') { fence = undefined; }
            continue;
        }
        if (m && !(m[1][0] === '`' && m[2].includes('`'))) { fence = { char: m[1][0], length: m[1].length }; continue; }
        if (re.test(line)) { out.push(i); }
    }
    return out;
}

function detect(lines: string[]): Format | undefined {
    const summary = headerLinesOutsideFences(lines, SUMMARY_HEADER)[0];
    const live = headerLinesOutsideFences(lines, LIVETRAIL_HEADER)[0];
    if (summary === undefined && live === undefined) { return undefined; }
    if (live === undefined) { return 'summary'; }
    if (summary === undefined) { return 'livetrail'; }
    return summary < live ? 'summary' : 'livetrail';
}

function parse(text: string, fmt: Format): { preamble: string; entries: Entry[] } {
    const re = fmt === 'summary' ? SUMMARY_HEADER : LIVETRAIL_HEADER;
    const lines = text.split('\n');
    const idxs = headerLinesOutsideFences(lines, re);
    if (!idxs.length) { return { preamble: text, entries: [] }; }
    const preamble = stripNewlines(lines.slice(0, idxs[0]).join('\n'));
    const entries = idxs.map((start, n) => {
        const end = n + 1 < idxs.length ? idxs[n + 1] : lines.length;
        const header = lines[start];
        const body = stripNewlines(lines.slice(start + 1, end).join('\n'));
        const m = re.exec(header)!;
        return fmt === 'summary'
            ? { sortKey: m[3], dedupKey: `${m[1]}\u0000${m[2]}`, header, body }
            : { sortKey: m[1], dedupKey: m[1], header, body };
    });
    return { preamble, entries };
}

function serialise(preamble: string, entries: Entry[]): string {
    const body = entries.map((e) => (e.body ? `${e.header}\n\n${e.body}` : e.header)).join('\n\n');
    if (preamble) { return body ? `${preamble}\n\n${body}\n` : `${preamble}\n`; }
    return body ? `${body}\n` : '';
}

export function mergeTrail(sides: MergeSides): MergeOutcome {
    const ours = sides.ours ?? '';
    const theirs = sides.theirs ?? '';
    if (isBlank(ours) && isBlank(theirs)) { return { status: 'merged', text: '' }; }
    if (isBlank(ours)) { return { status: 'merged', text: theirs }; }
    if (isBlank(theirs)) { return { status: 'keep' }; }
    const fmt = detect(ours.split('\n')) ?? detect(theirs.split('\n'));
    if (!fmt) { return { status: 'fail', message: `ai-trail: unrecognised trail format at ${sides.display ?? ''}; falling back to conflict markers.` }; }
    const o = parse(ours, fmt);
    const t = parse(theirs, fmt);
    const byKey = new Map<string, Entry>();
    for (const e of [...o.entries, ...t.entries]) {
        const existing = byKey.get(e.dedupKey);
        if (!existing || pyLen(e.body) > pyLen(existing.body)) { byKey.set(e.dedupKey, e); }
    }
    return { status: 'merged', text: serialise(o.preamble || t.preamble, sortByKey([...byKey.values()], (e) => e.sortKey)) };
}
