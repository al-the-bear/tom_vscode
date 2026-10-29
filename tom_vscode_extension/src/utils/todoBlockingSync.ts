/**
 * Keeps `blocking` in step with `blocked_by` after a todo file is written
 * (the rules are in todoBlocking.ts).
 *
 * Every writer of todo files in the extension — the todo manager (the panel,
 * the todo tools, the scripting bridge's todo handlers) and the archive /
 * delete moves — calls `syncBlockingAfterWrite` with the file's text before
 * and after its write. The sync reads the live todo files of every quest (a
 * stat cache keeps unchanged files from being parsed again) and rewrites the
 * `blocking` of the todos the write can have changed, and nothing else: the
 * rest of the corpus is filled in by the format migration, not as a side
 * effect of an unrelated save.
 *
 * Pure fs + yaml, no vscode — unit-testable with a temporary folder.
 */

import * as fs from 'fs';
import * as path from 'path';
import { Document, isMap, isScalar, isSeq, parse, YAMLMap } from 'yaml';

import { isArchivedOrDeletedTodoFile } from './todoArchiveNames';
import {
    TodoAddress,
    TodoRelationRecord,
    addressKey,
    affectedByWrite,
    expectedBlocking,
    sameRefs,
    todoScopeOf,
} from './todoBlocking';
import { loadTodoYaml } from './todoYamlDocument';

interface CachedFile {
    mtimeMs: number;
    size: number;
    records: TodoRelationRecord[];
}

/** Parsed relations per live todo file, reused while the file is unchanged. */
const cache = new Map<string, CachedFile>();

function strings(value: unknown): string[] {
    return Array.isArray(value) ? value.filter((v): v is string => typeof v === 'string' && v.trim() !== '') : [];
}

/** The relation records of a todo file's text; unreadable text has none. */
export function relationsOfText(filePath: string, text: string | undefined, questsRoot: string): TodoRelationRecord[] {
    if (!text) { return []; }
    let data: unknown;
    try { data = parse(text); } catch { return []; }
    const todos = (data as { todos?: unknown } | null)?.todos;
    if (!Array.isArray(todos)) { return []; }
    const scope = todoScopeOf(filePath, questsRoot);
    const out: TodoRelationRecord[] = [];
    for (const t of todos) {
        const id = (t as { id?: unknown } | null)?.id;
        if (typeof id !== 'string' || !id) { continue; }
        out.push({
            ...scope,
            id,
            blockedBy: strings((t as Record<string, unknown>).blocked_by),
            blocking: strings((t as Record<string, unknown>).blocking),
        });
    }
    return out;
}

function recordsOfFile(filePath: string, questsRoot: string): TodoRelationRecord[] {
    let st: fs.Stats;
    try { st = fs.statSync(filePath); } catch { cache.delete(filePath); return []; }
    const hit = cache.get(filePath);
    if (hit && hit.mtimeMs === st.mtimeMs && hit.size === st.size) { return hit.records; }
    let text: string;
    try { text = fs.readFileSync(filePath, 'utf8'); } catch { return []; }
    const records = relationsOfText(filePath, text, questsRoot);
    cache.set(filePath, { mtimeMs: st.mtimeMs, size: st.size, records });
    return records;
}

/** Every live todo file of every quest under `questsRoot`. */
export function liveQuestTodoFiles(questsRoot: string): string[] {
    let quests: fs.Dirent[];
    try { quests = fs.readdirSync(questsRoot, { withFileTypes: true }); } catch { return []; }
    const files: string[] = [];
    for (const q of quests) {
        if (!q.isDirectory()) { continue; }
        const dir = path.join(questsRoot, q.name);
        let names: string[];
        try { names = fs.readdirSync(dir); } catch { continue; }
        for (const n of names) {
            if (n.endsWith('.todo.yaml') && !isArchivedOrDeletedTodoFile(n)) { files.push(path.join(dir, n)); }
        }
    }
    return files.sort();
}

/** Forget what the cache knows of `filePath` (its content was just written). */
export function forgetTodoFile(filePath: string): void {
    cache.delete(filePath);
}

/**
 * Write `blocking` onto a todo node (empty: remove it). A new key goes right
 * after `blocked_by` (else `blocked_until`), so the two ends of the relation
 * sit together; without either it goes last.
 */
function setBlocking(doc: Document, node: YAMLMap, blocking: string[]): void {
    if (!blocking.length) { node.delete('blocking'); return; }
    if (node.has('blocking')) { node.set('blocking', doc.createNode(blocking)); return; }
    const pair = doc.createPair('blocking', blocking);
    const keyOf = (p: { key: unknown }) => (isScalar(p.key) ? p.key.value : p.key);
    let at = node.items.findIndex((p) => keyOf(p) === 'blocked_by');
    if (at < 0) { at = node.items.findIndex((p) => keyOf(p) === 'blocked_until'); }
    if (at < 0) { node.items.push(pair); } else { node.items.splice(at + 1, 0, pair); }
}

/** The quests folder the writers' files are judged against; set by the todo manager. */
let configuredQuestsRoot: string | undefined;

/** Tell the sync where the quests are (`_ai/quests` of the workspace). */
export function setTodoQuestsRoot(questsRoot: string | undefined): void {
    configuredQuestsRoot = questsRoot;
}

/** The quests folder for `filePath`: the configured one, else the `_ai/quests` its path lies in. */
function questsRootFor(filePath: string): string | undefined {
    if (configuredQuestsRoot) { return configuredQuestsRoot; }
    const norm = filePath.replace(/\\/g, '/');
    const at = norm.lastIndexOf('/_ai/quests/');
    return at >= 0 ? norm.slice(0, at + '/_ai/quests'.length) : undefined;
}

/**
 * Write a todo file and keep `blocking` in step: the one write every todo
 * writer of the extension goes through. The file's own write is done first and
 * stands even if the sync fails (a broken todo file elsewhere in the corpus,
 * say); the failure is reported on the console, naming the file written.
 */
export function writeTodoFileText(filePath: string, text: string): BlockingChange[] {
    let before: string | undefined;
    try { before = fs.readFileSync(filePath, 'utf8'); } catch { before = undefined; }
    fs.writeFileSync(filePath, text, 'utf8');
    const root = questsRootFor(filePath);
    if (!root) { return []; }
    try {
        return syncBlockingAfterWrite(filePath, before, text, root);
    } catch (e) {
        console.warn(`[todo blocking] sync after writing ${filePath} failed: ${e instanceof Error ? e.message : String(e)}`);
        return [];
    }
}

/** One todo whose `blocking` the sync rewrote. */
export interface BlockingChange {
    file: string;
    id: string;
    blocking: string[];
}

/**
 * After `filePath` went from `beforeText` (undefined: it did not exist) to
 * `afterText`, rewrite the `blocking` of every live todo the write can have
 * changed. Answers what it rewrote.
 */
export function syncBlockingAfterWrite(
    filePath: string,
    beforeText: string | undefined,
    afterText: string | undefined,
    questsRoot: string,
): BlockingChange[] {
    forgetTodoFile(filePath);
    const terminal = isArchivedOrDeletedTodoFile(path.basename(filePath));
    const before = relationsOfText(filePath, beforeText, questsRoot);
    const after = relationsOfText(filePath, afterText, questsRoot);
    const targets = affectedByWrite(before, after, !terminal);
    if (!targets.length) { return []; }

    // The live corpus: every quest's live files, and the written file itself
    // when it is a live file outside the quests (a workspace todo file).
    const files = liveQuestTodoFiles(questsRoot);
    if (!terminal && !files.includes(filePath) && todoScopeOf(filePath, questsRoot).scopeKey.startsWith('file:')) {
        files.push(filePath);
    }
    const records: TodoRelationRecord[] = [];
    const where = new Map<string, { file: string; record: TodoRelationRecord }>();
    for (const f of files) {
        for (const r of recordsOfFile(f, questsRoot)) {
            records.push(r);
            where.set(addressKey(r), { file: f, record: r });
        }
    }

    const byFile = new Map<string, Map<string, string[]>>();
    for (const target of targets) {
        const found = where.get(addressKey(target));
        if (!found) { continue; }
        const expected = expectedBlocking(target as TodoAddress, records);
        if (sameRefs(found.record.blocking, expected)) { continue; }
        const perFile = byFile.get(found.file) ?? new Map<string, string[]>();
        perFile.set(target.id, expected);
        byFile.set(found.file, perFile);
    }

    const changes: BlockingChange[] = [];
    for (const [file, perId] of byFile) {
        const doc = loadTodoYaml(file);
        const todos = doc.get('todos', true);
        if (!isSeq(todos)) { continue; }
        for (const node of todos.items) {
            if (!isMap(node)) { continue; }
            const id = (node as YAMLMap).get('id');
            if (typeof id !== 'string' || !perId.has(id)) { continue; }
            const blocking = perId.get(id)!;
            setBlocking(doc, node as YAMLMap, blocking);
            changes.push({ file, id, blocking });
        }
        fs.writeFileSync(file, doc.toString(), 'utf8');
        forgetTodoFile(file);
    }
    return changes;
}
