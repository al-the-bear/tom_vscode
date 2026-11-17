/**
 * `ai-history-json`: the merge of a session's `history.json` (the port of
 * ai_merge_history_json.py, vscimpb142c). A file is in the new format when a
 * raw turn carries a `timestamp`. Only one side new: that side. Both old: ours.
 * Both new: the turns' union by timestamp (the longer content wins), sorted;
 * the compacted summary the non-empty one, both non-empty the newer
 * `savedAt`'s; the newer `savedAt`. Written as Python's `json.dumps(indent=2,
 * ensure_ascii=False)` writes it.
 *
 * vscode-free and pure.
 */

import { pyCompare, pyLen, sortByKey, type MergeOutcome, type MergeSides } from './common';

type Json = Record<string, unknown>;

function read(text: string | undefined): unknown {
    if (text === undefined || text.length === 0) { return undefined; }
    try { return JSON.parse(text); } catch { return undefined; }
}

function isObject(v: unknown): v is Json {
    return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function extract(data: unknown): { savedAt: string; summary: unknown; turns: unknown[] } | 'bad' {
    if (data === undefined) { return { savedAt: '', summary: '', turns: [] }; }
    if (!isObject(data)) { return 'bad'; }
    const savedAt = (data.savedAt ?? '') as string;
    const msgs = data.messages ?? {};
    let summary: unknown = '';
    let turns: unknown = [];
    if (isObject(msgs)) {
        summary = msgs.compactedSummary ?? '';
        turns = msgs.rawTurns ?? [];
    }
    return { savedAt: typeof savedAt === 'string' ? savedAt : String(savedAt), summary, turns: Array.isArray(turns) ? turns : [] };
}

function isNew(turns: unknown[]): boolean {
    return turns.some((t) => isObject(t) && 'timestamp' in t);
}

/** Python's `len()` of a turn's content (a string's code points, a list's items). */
function contentLen(v: unknown): number {
    if (typeof v === 'string') { return pyLen(v); }
    if (Array.isArray(v)) { return v.length; }
    if (isObject(v)) { return Object.keys(v).length; }
    return 0;
}

function truthy(v: unknown): boolean {
    if (typeof v === 'string') { return v.length > 0; }
    if (Array.isArray(v)) { return v.length > 0; }
    if (isObject(v)) { return Object.keys(v).length > 0; }
    return !!v;
}

export function mergeHistoryJson(sides: MergeSides): MergeOutcome {
    const o = extract(read(sides.ours));
    const t = extract(read(sides.theirs));
    if (o === 'bad' || t === 'bad') { return { status: 'fail', message: 'ai-history-json: a side is not a JSON object.' }; }
    const oursNew = isNew(o.turns);
    const theirsNew = isNew(t.turns);
    if (!oursNew && !theirsNew) { return { status: 'keep' }; }
    if (oursNew && !theirsNew) { return { status: 'keep' }; }
    if (theirsNew && !oursNew) { return { status: 'merged', text: sides.theirs ?? '' }; }
    const byTs = new Map<string, Json>();
    for (const turn of [...o.turns, ...t.turns]) {
        if (!isObject(turn)) { continue; }
        const ts = turn.timestamp;
        if (!ts) { continue; }
        const key = String(ts);
        const existing = byTs.get(key);
        if (!existing || contentLen(turn.content ?? '') > contentLen(existing.content ?? '')) { byTs.set(key, turn); }
    }
    const turns = sortByKey([...byTs.values()], (x) => String(x.timestamp ?? ''));
    const summary = truthy(o.summary) && truthy(t.summary)
        ? (pyCompare(o.savedAt, t.savedAt) >= 0 ? o.summary : t.summary)
        : (truthy(o.summary) ? o.summary : t.summary);
    const savedAt = o.savedAt && t.savedAt ? (pyCompare(o.savedAt, t.savedAt) >= 0 ? o.savedAt : t.savedAt) : (o.savedAt || t.savedAt);
    return { status: 'merged', text: pythonJsonDumps({ savedAt, messages: { compactedSummary: summary, rawTurns: turns } }) + '\n' };
}

/**
 * `json.dumps(v, indent=2, ensure_ascii=False)`: the same layout as JSON.stringify with two spaces. (A float
 * such as `1.0` reads back as `1` in JavaScript; history files hold none.)
 */
export function pythonJsonDumps(v: unknown): string {
    return JSON.stringify(v, null, 2);
}
