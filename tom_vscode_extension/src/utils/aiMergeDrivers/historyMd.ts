/**
 * `ai-history-md`: the merge of a session's `history.md` (the port of
 * ai_merge_history_md.py, vscimpb142c). A file is in the new format when a
 * turn header `### [N] role — …` carries an ISO timestamp. Only one side new:
 * that side. Both old: ours. Both new: the turns' union by timestamp (the
 * longer body wins), sorted and renumbered, the `## Raw turns — N messages`
 * count updated; the compacted summary the non-empty one, both non-empty the
 * newer `_Saved at …._`'s; the header lines of the side saved last.
 *
 * vscode-free and pure.
 */

import { isBlank, pyCompare, pyLen, pySplitlines, sortByKey, type MergeOutcome, type MergeSides } from './common';

const SAVED_AT = /^_Saved at ([^.]+)\._/u;
const SUMMARY_HEADER = /^## Compacted summary/u;
const TURNS_HEADER = /^## Raw turns/u;
const TURN_HEADER = /^### \[(\d+)\] ([\p{L}\p{N}_]+) — (.+)$/u;
const ISO = /\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/u;

interface Turn { ts: string | undefined; header: string; body: string[] }

function isNew(text: string): boolean {
    return pySplitlines(text).some((line) => {
        const m = TURN_HEADER.exec(line);
        return !!m && ISO.test(m[3]);
    });
}

function savedAtOf(text: string): string {
    for (const line of pySplitlines(text)) {
        const m = SAVED_AT.exec(line);
        if (m) { return m[1]; }
    }
    return '';
}

function parse(text: string): { meta: string[]; summary: string[]; turns: Turn[] } {
    const lines = pySplitlines(text);
    let i = 0;
    const meta: string[] = [];
    const summary: string[] = [];
    const turns: Turn[] = [];
    let inSummary = false;
    while (i < lines.length) {
        if (SUMMARY_HEADER.test(lines[i])) { meta.push(lines[i]); i++; inSummary = true; break; }
        meta.push(lines[i]);
        i++;
    }
    if (!inSummary) { return { meta, summary: [], turns: [] }; }
    while (i < lines.length) {
        if (TURNS_HEADER.test(lines[i])) { meta.push(lines[i]); i++; break; }
        summary.push(lines[i]);
        i++;
    }
    let cur: Turn | undefined;
    for (; i < lines.length; i++) {
        const m = TURN_HEADER.exec(lines[i]);
        if (m) {
            if (cur) { turns.push(cur); }
            const ts = ISO.exec(m[3]);
            cur = { ts: ts ? ts[0] : undefined, header: lines[i], body: [] };
        } else if (cur) {
            cur.body.push(lines[i]);
        }
    }
    if (cur) { turns.push(cur); }
    return { meta, summary, turns };
}

function serialise(meta: string[], summary: string[], turns: Turn[]): string {
    const parts = meta.map((line) => (TURNS_HEADER.test(line) ? `## Raw turns — ${turns.length} messages` : line));
    parts.push(...summary);
    turns.forEach((t, n) => {
        parts.push(t.header.replace(/^### \[\d+\]/u, `### [${n + 1}]`));
        parts.push(...t.body);
    });
    return parts.join('\n') + '\n';
}

const bodyLen = (body: string[]): number => body.reduce((n, b) => n + pyLen(b), 0);

export function mergeHistoryMd(sides: MergeSides): MergeOutcome {
    const ours = sides.ours ?? '';
    const theirs = sides.theirs ?? '';
    if (isBlank(ours) && isBlank(theirs)) { return { status: 'merged', text: '' }; }
    if (isBlank(ours)) { return { status: 'merged', text: theirs }; }
    if (isBlank(theirs)) { return { status: 'keep' }; }
    const oursNew = isNew(ours);
    const theirsNew = isNew(theirs);
    if (!oursNew && !theirsNew) { return { status: 'keep' }; }
    if (oursNew && !theirsNew) { return { status: 'keep' }; }
    if (theirsNew && !oursNew) { return { status: 'merged', text: theirs }; }
    const o = parse(ours);
    const t = parse(theirs);
    const oursSaved = savedAtOf(ours);
    const theirsSaved = savedAtOf(theirs);
    const byTs = new Map<string, Turn>();
    for (const turn of [...o.turns, ...t.turns]) {
        if (!turn.ts) { continue; }
        const existing = byTs.get(turn.ts);
        if (!existing || bodyLen(turn.body) > bodyLen(existing.body)) { byTs.set(turn.ts, turn); }
    }
    const turns = sortByKey([...byTs.values()], (x) => x.ts!);
    const oursFirst = pyCompare(oursSaved, theirsSaved) >= 0;
    const summary = o.summary.length && t.summary.length ? (oursFirst ? o.summary : t.summary) : (o.summary.length ? o.summary : t.summary);
    return { status: 'merged', text: serialise(oursFirst ? o.meta : t.meta, summary, turns) };
}
