/**
 * `ai-yaml-smart`: the key-level merge of the `_ai` YAML files — todo files,
 * memory, extension configs (the port of ai_merge_yaml.py, vscimpb142c).
 *
 *   - a top-level mapping: the union of its keys; a collision goes to the
 *     side whose value has the larger `updated` (or `updated_at`), else ours;
 *     a key whose value is an `id`-keyed list on both sides (a todo file's
 *     `todos:`) is merged by item `id`;
 *   - a top-level list: merged by item `id` (the same `updated` rule); items
 *     without an `id` appended from both sides;
 *   - an empty side gives the other; an invalid YAML or mismatched top-level
 *     shapes fail (git's conflict markers).
 *
 * It merges the parsed YAML nodes, so every value keeps the form it was
 * written in — a date, a timestamp, a quoted string, `yes` / `no`, comments —
 * where the Python driver (PyYAML, YAML 1.1) rewrote them (a timestamp
 * `2026-10-27T10:00:00.000Z` as `2026-10-27 10:00:00+00:00`, comments
 * dropped). The values agree; the parity test compares them as YAML 1.1 reads
 * both. A document with aliases is merged by value instead. Written with the
 * extension's layout (lists indented under their key, no line folding).
 *
 * vscode-free and pure.
 */

import { isMap, isScalar, isSeq, parseDocument, stringify, visit, type Document, type YAMLMap, type YAMLSeq } from 'yaml';

import { isBlank, pyCompare, type MergeOutcome, type MergeSides } from './common';

type YMap = Map<unknown, unknown>;

function load(text: string | undefined): { value: unknown } | 'empty' | { error: string } {
    if (isBlank(text)) { return 'empty'; }
    const doc = parseDocument(text!, { uniqueKeys: false });
    if (doc.errors.length) { return { error: doc.errors[0].message }; }
    const value = doc.toJS({ mapAsMap: true });
    // A document holding only null (`~`) reads as empty, as PyYAML's None does.
    return value === null || value === undefined ? 'empty' : { value };
}

function isMapValue(v: unknown): v is YMap {
    return v instanceof Map;
}

function updatedOf(v: unknown): string {
    if (!isMapValue(v)) { return ''; }
    const u = v.get('updated') || v.get('updated_at') || '';
    return u ? String(u) : '';
}

function isIdList(v: unknown): v is unknown[] {
    return Array.isArray(v) && v.some((item) => isMapValue(item) && item.has('id'));
}

/** The newer of two values by their `updated`: theirs only when it has one and it is larger. */
function theirsWins(ours: unknown, theirs: unknown): boolean {
    const uo = updatedOf(ours);
    const ut = updatedOf(theirs);
    return !!ut && (!uo || pyCompare(ut, uo) > 0);
}

export function mergeIdLists(ours: unknown[], theirs: unknown[]): unknown[] {
    const noId: unknown[] = [];
    const byId = new Map<unknown, unknown>();
    const order: unknown[] = [];
    const absorb = (items: unknown[]): void => {
        for (const item of items) {
            const id = isMapValue(item) ? item.get('id') : undefined;
            if (id === undefined || id === null) { noId.push(item); continue; }
            const key = typeof id === 'object' ? JSON.stringify(id) : id;
            if (byId.has(key)) {
                if (theirsWins(byId.get(key), item)) { byId.set(key, item); }
            } else {
                byId.set(key, item);
                order.push(key);
            }
        }
    };
    absorb(ours);
    absorb(theirs);
    return [...order.map((k) => byId.get(k)), ...noId];
}

export function mergeMaps(ours: YMap, theirs: YMap): YMap {
    const out = new Map(ours);
    for (const [k, vt] of theirs) {
        if (!out.has(k)) { out.set(k, vt); continue; }
        const vo = out.get(k);
        if (isIdList(vo) && isIdList(vt)) { out.set(k, mergeIdLists(vo, vt)); continue; }
        if (theirsWins(vo, vt)) { out.set(k, vt); }
    }
    return out;
}

function typeName(v: unknown): string {
    if (isMapValue(v)) { return 'dict'; }
    if (Array.isArray(v)) { return 'list'; }
    return v === null ? 'NoneType' : typeof v;
}

/** The text a value merged by value (a document with aliases) is written as. */
export function dumpYaml(value: unknown): string {
    return stringify(value, { lineWidth: 0, aliasDuplicateObjects: false });
}

// ── merging the nodes (the default) ─────────────────────────────────────────

type Node = unknown;

function nodeValue(n: Node): unknown {
    return isScalar(n) ? n.value : n;
}

function nodeUpdated(n: Node): string {
    if (!isMap(n)) { return ''; }
    const u = nodeValue(n.get('updated', true)) || nodeValue(n.get('updated_at', true)) || '';
    return u ? String(u) : '';
}

function nodeIsIdList(n: Node): n is YAMLSeq {
    return isSeq(n) && n.items.some((item) => isMap(item) && item.has('id'));
}

function nodeTheirsWins(ours: Node, theirs: Node): boolean {
    const uo = nodeUpdated(ours);
    const ut = nodeUpdated(theirs);
    return !!ut && (!uo || pyCompare(ut, uo) > 0);
}

function mergeIdSeqNodes(ours: YAMLSeq, theirs: YAMLSeq): void {
    const noId: unknown[] = [];
    const byId = new Map<unknown, unknown>();
    const order: unknown[] = [];
    for (const items of [ours.items, theirs.items]) {
        for (const item of items) {
            const id = isMap(item) ? nodeValue(item.get('id', true)) : undefined;
            if (id === undefined || id === null) { noId.push(item); continue; }
            if (byId.has(id)) {
                if (nodeTheirsWins(byId.get(id), item)) { byId.set(id, item); }
            } else {
                byId.set(id, item);
                order.push(id);
            }
        }
    }
    ours.items = [...order.map((k) => byId.get(k)), ...noId];
}

function mergeMapNodes(ours: YAMLMap, theirs: YAMLMap): void {
    for (const pair of theirs.items) {
        const key = nodeValue(pair.key);
        if (!ours.has(key)) { ours.items.push(pair); continue; }
        const vo = ours.get(key, true);
        const vt = pair.value;
        if (nodeIsIdList(vo) && nodeIsIdList(vt)) { mergeIdSeqNodes(vo, vt); continue; }
        if (nodeTheirsWins(vo, vt)) { ours.set(pair.key, vt); }
    }
}

function hasAlias(doc: Document): boolean {
    let found = false;
    visit(doc, { Alias: () => { found = true; return visit.BREAK; } });
    return found;
}

/** Merge on the documents; undefined when that cannot be done (aliases), the caller merges by value. */
function mergeDocuments(oursText: string, theirsText: string): MergeOutcome | undefined {
    const o = parseDocument(oursText, { uniqueKeys: false });
    const t = parseDocument(theirsText, { uniqueKeys: false });
    if (o.errors.length || t.errors.length || hasAlias(o) || hasAlias(t)) { return undefined; }
    const oc = o.contents;
    const tc = t.contents;
    if (isMap(oc) && isMap(tc)) {
        mergeMapNodes(oc, tc);
    } else if (isSeq(oc) && isSeq(tc)) {
        mergeIdSeqNodes(oc, tc);
    } else {
        return undefined;
    }
    return { status: 'merged', text: o.toString({ lineWidth: 0 }) };
}

export function mergeYamlSmart(sides: MergeSides): MergeOutcome {
    const ours = load(sides.ours);
    const theirs = load(sides.theirs);
    if (typeof ours === 'object' && 'error' in ours) { return { status: 'fail', message: `ai-yaml-smart: YAML parse error in ours: ${ours.error}` }; }
    if (typeof theirs === 'object' && 'error' in theirs) { return { status: 'fail', message: `ai-yaml-smart: YAML parse error in theirs: ${theirs.error}` }; }
    if (ours === 'empty' && theirs === 'empty') { return { status: 'merged', text: '' }; }
    if (ours === 'empty') { return { status: 'merged', text: sides.theirs ?? '' }; }
    if (theirs === 'empty') { return { status: 'keep' }; }
    const o = ours.value;
    const t = theirs.value;
    if ((isMapValue(o) && isMapValue(t)) || (Array.isArray(o) && Array.isArray(t))) {
        const byNode = mergeDocuments(sides.ours!, sides.theirs!);
        if (byNode) { return byNode; }
    }
    let merged: unknown;
    if (isMapValue(o) && isMapValue(t)) {
        merged = mergeMaps(o, t);
    } else if (Array.isArray(o) && Array.isArray(t)) {
        merged = mergeIdLists(o, t);
    } else {
        return { status: 'fail', message: `ai-yaml-smart: incompatible top-level types at ${sides.display ?? ''}; ours=${typeName(o)}, theirs=${typeName(t)}` };
    }
    return { status: 'merged', text: dumpYaml(merged) };
}
