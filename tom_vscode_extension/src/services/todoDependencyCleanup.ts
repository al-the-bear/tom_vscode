/**
 * The todo panel's dependency cleanup, carried out (the rules are in
 * utils/todoDependencyCleanup.ts): read every live todo file under the quests
 * folder, plan the pass for the todos in scope, and write each changed file
 * once — the `blocked_by` entries taken out, the new status and `blocking`, a
 * notes line and `updated` on each todo whose `blocked_by` or status changed.
 * Writes go through writeTodoFileText, so the blocking sync of every other
 * file follows as after any todo write.
 *
 * `onProgress(n, m)` counts the todos in scope as they are checked (n up to
 * m) and yields between files so a status bar can show it.
 *
 * vscode-free (fs + yaml).
 */

import * as path from 'path';
import * as fs from 'fs';
import { isMap, isSeq, parse, type YAMLMap } from 'yaml';

import { liveQuestTodoFiles, setBlocking, writeTodoFileText } from '../utils/todoBlockingSync';
import { hasOpenDecisions } from '../utils/todoBlockingCascade';
import { loadTodoYaml } from '../utils/todoYamlDocument';
import { emitNotifications } from './notificationLog';
import {
    cleanupNote, planDependencyCleanup, summarizeCleanup,
    type CleanupChange, type CleanupSummary, type CleanupTodo,
} from '../utils/todoDependencyCleanup';

/** Which todos the pass may change. */
export type CleanupScope =
    | { kind: 'todos'; todos: ReadonlyArray<{ quest: string; id: string }> }
    | { kind: 'quests'; quests: readonly string[] }
    | { kind: 'all' };

function strings(value: unknown): string[] {
    return Array.isArray(value) ? value.filter((v): v is string => typeof v === 'string' && v.trim() !== '').map((v) => v.trim()) : [];
}

/** Every live todo under `questsRoot`, with its file. */
export function readLiveTodos(questsRoot: string): Array<{ file: string; todo: CleanupTodo }> {
    const out: Array<{ file: string; todo: CleanupTodo }> = [];
    for (const file of liveQuestTodoFiles(questsRoot)) {
        const quest = path.basename(path.dirname(file));
        let data: unknown;
        try { data = parse(fs.readFileSync(file, 'utf8')); } catch { continue; }
        const todos = (data as { todos?: unknown } | null)?.todos;
        if (!Array.isArray(todos)) { continue; }
        for (const raw of todos as Array<Record<string, unknown>>) {
            if (!raw || typeof raw.id !== 'string' || !raw.id) { continue; }
            out.push({ file, todo: {
                quest, id: raw.id,
                status: typeof raw.status === 'string' ? raw.status : 'not-started',
                blockedBy: strings(raw.blocked_by),
                blocking: strings(raw.blocking),
                blockedUntil: strings(raw.blocked_until),
                group: strings(raw.comprised_of).length > 0,
                openDecisions: hasOpenDecisions(raw.decisions),
            } });
        }
    }
    return out;
}

/** The scope as a test. */
export function scopeTest(scope: CleanupScope): (quest: string, id: string) => boolean {
    if (scope.kind === 'all') { return () => true; }
    if (scope.kind === 'quests') { const set = new Set(scope.quests); return (quest) => set.has(quest); }
    const set = new Set(scope.todos.map((t) => `${t.quest}/${t.id}`));
    return (quest, id) => set.has(`${quest}/${id}`);
}

/** Apply `changes` to `file` (one write); answers whether it was written. */
function writeChanges(file: string, changes: readonly CleanupChange[], today: string): boolean {
    const doc = loadTodoYaml(file);
    const todos = doc.get('todos', true);
    if (!isSeq(todos)) { return false; }
    let touched = false;
    for (const node of todos.items) {
        if (!isMap(node)) { continue; }
        const map = node as YAMLMap;
        const c = changes.find((x) => x.id === map.get('id'));
        if (!c) { continue; }
        if (c.removed.length) {
            const gone = new Set(c.removed.map((r) => r.entry));
            const kept = strings((map.toJSON() as Record<string, unknown>).blocked_by).filter((e) => !gone.has(e));
            if (kept.length) { map.set('blocked_by', doc.createNode(kept)); } else { map.delete('blocked_by'); }
        }
        if (c.status) { map.set('status', c.status.to); }
        if (c.blocking) { setBlocking(doc, map, c.blocking.to); }
        const note = cleanupNote(c);
        if (note) {
            const notes = map.get('notes');
            const line = `${today}: ${note}.`;
            map.set('notes', typeof notes === 'string' && notes.trim() ? `${notes.replace(/\s+$/, '')}\n\n${line}` : line);
            map.set('updated', today);
        }
        touched = true;
    }
    if (touched) { writeTodoFileText(file, doc.toString()); }
    return touched;
}

/** A pass over the todos in `scope`. */
export async function runDependencyCleanup(
    questsRoot: string,
    scope: CleanupScope,
    onProgress: (checked: number, total: number) => void = () => undefined,
    today: string = new Date().toISOString().slice(0, 10),
): Promise<{ summary: CleanupSummary; changes: CleanupChange[]; files: string[] }> {
    const loaded = readLiveTodos(questsRoot);
    const inScope = scopeTest(scope);
    let quests: string[] = [];
    try { quests = fs.readdirSync(questsRoot, { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => d.name); } catch { /* none */ }
    const all = loaded.map((l) => l.todo);
    const changes = planDependencyCleanup(all, inScope, new Set(quests));
    const total = all.filter((t) => inScope(t.quest, t.id)).length;
    const written: string[] = [];
    let checked = 0;
    onProgress(0, total);
    const byFile = new Map<string, CleanupTodo[]>();
    for (const l of loaded) { if (inScope(l.todo.quest, l.todo.id)) { byFile.set(l.file, [...(byFile.get(l.file) ?? []), l.todo]); } }
    for (const [file, todos] of byFile) {
        const mine = changes.filter((c) => todos.some((t) => t.quest === c.quest && t.id === c.id));
        if (mine.length && writeChanges(file, mine, today)) { written.push(file); }
        // Count each todo of the file, a step at a time, so the progress moves even over a large file.
        for (let i = 0; i < todos.length; i++) {
            checked++;
            if (checked % 25 === 0 || checked === total) { onProgress(checked, total); await new Promise((r) => setImmediate(r)); }
        }
    }
    onProgress(total, total);
    const statusChanges = changes.filter((c) => c.status);
    if (statusChanges.length) {
        emitNotifications(statusChanges.map((c) => ({
            type: 'todoChanged' as const,
            todo: { id: c.id, quest: c.quest, fields: [{ field: 'status', old: c.status!.from, new: c.status!.to }] },
            who: { kind: 'extension' as const, label: 'todo dependency cleanup' },
        })));
    }
    const removals = changes.filter((c) => c.removed.length);
    if (removals.length) {
        emitNotifications(removals.map((c) => ({
            type: 'todoUpdated' as const,
            todo: { id: c.id, quest: c.quest, fields: [{ field: 'blocked_by', old: c.removed.map((r) => r.entry).join(', '), new: '(removed: done or no longer a todo)' }] },
            who: { kind: 'extension' as const, label: 'todo dependency cleanup' },
        })));
    }
    return { summary: summarizeCleanup(all, changes, inScope), changes, files: written };
}
