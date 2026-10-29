/**
 * `blocking`, the reverse of `blocked_by` (src/utils/todoBlocking.ts) and the
 * sync that keeps it in step after a write (src/utils/todoBlockingSync.ts).
 *
 *   TB-1  scopes: a file directly in `<quests>/<quest>/` is that quest; any other file is its own scope
 *   TB-2  refs: a bare id names a todo of the same scope, `<quest>/<id>` one of that quest
 *   TB-3  expected blocking: bare ids in the same scope, `<quest>/<id>` across quests, sorted, no repeats;
 *         a workspace-file blocker is invisible outside its file
 *   TB-4  a write that adds a blocked_by writes the target's blocking (same quest and across quests),
 *         the new key right after blocked_by
 *   TB-5  a write that removes the ref removes the entry, and an empty list removes the key
 *   TB-6  archiving a blocker (it leaves the live file for the -archived sibling) drops it from the
 *         target's blocking; the terminal file is never rewritten
 *   TB-7  a blocked todo that is renamed appears under its new id in the blocker's blocking
 *   TB-8  a todo arriving in a file with a stale blocking is corrected; an untouched todo elsewhere is
 *         not rewritten (the corpus is migrated by the format migration, not by unrelated saves)
 */

/* eslint-disable @typescript-eslint/naming-convention -- `blocked_by` is the todo schema's YAML key */
import test, { describe } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { parse } from 'yaml';

import {
    TodoRelationRecord,
    expectedBlocking,
    resolveTodoRef,
    todoScopeOf,
} from '../todoBlocking';
import { syncBlockingAfterWrite } from '../todoBlockingSync';

function rec(scopeKey: string, id: string, blockedBy: string[] = [], quest?: string): TodoRelationRecord {
    return { scopeKey, quest: quest ?? (scopeKey.startsWith('quest:') ? scopeKey.slice(6) : undefined), id, blockedBy, blocking: [] };
}

describe('todoBlocking rules', () => {
    test('TB-1: scopes', () => {
        assert.deepEqual(todoScopeOf('/w/_ai/quests/qa/todos.qa.todo.yaml', '/w/_ai/quests'), { scopeKey: 'quest:qa', quest: 'qa' });
        assert.deepEqual(todoScopeOf('/w/_ai/quests/qa/sub/x.todo.yaml', '/w/_ai/quests'), { scopeKey: 'file:/w/_ai/quests/qa/sub/x.todo.yaml' });
        assert.deepEqual(todoScopeOf('/w/workspace.todo.yaml', '/w/_ai/quests'), { scopeKey: 'file:/w/workspace.todo.yaml' });
    });

    test('TB-2: refs', () => {
        const from = { scopeKey: 'quest:qa', quest: 'qa' };
        assert.deepEqual(resolveTodoRef('t1', from), { scopeKey: 'quest:qa', id: 't1' });
        assert.deepEqual(resolveTodoRef('qb/t2', from), { scopeKey: 'quest:qb', id: 't2' });
        assert.equal(resolveTodoRef('  ', from), undefined);
        assert.equal(resolveTodoRef('a/b/c', from), undefined);
    });

    test('TB-3: expected blocking', () => {
        const records = [
            rec('quest:qa', 'a2', ['b1']),
            rec('quest:qa', 'a1', ['b1', 'b1']),
            rec('quest:qb', 'x', ['qa/b1']),
            rec('file:/w/workspace.todo.yaml', 'w', ['qa/b1']),
            rec('quest:qa', 'other', ['zz']),
        ];
        assert.deepEqual(expectedBlocking({ scopeKey: 'quest:qa', id: 'b1' }, records), ['a1', 'a2', 'qb/x']);
        assert.deepEqual(expectedBlocking({ scopeKey: 'quest:qa', id: 'nobody' }, records), []);
    });
});

// --- the sync, over a temporary quests folder -------------------------------

function sandbox(): { root: string; quests: string } {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'todo-blocking-'));
    const quests = path.join(root, '_ai', 'quests');
    fs.mkdirSync(path.join(quests, 'qa'), { recursive: true });
    fs.mkdirSync(path.join(quests, 'qb'), { recursive: true });
    return { root, quests };
}

function todosYaml(todos: Array<Record<string, unknown>>): string {
    const lines = ['todos:'];
    for (const t of todos) {
        lines.push(`  - id: ${t.id}`);
        lines.push(`    description: ${t.id}`);
        lines.push(`    status: ${t.status ?? 'not-started'}`);
        for (const key of ['blocked_by', 'blocking'] as const) {
            const v = t[key] as string[] | undefined;
            if (v) { lines.push(`    ${key}:`); for (const x of v) { lines.push(`      - ${x}`); } }
        }
    }
    return lines.join('\n') + '\n';
}

/** Write a todo file the way a writer does: text before, write, then sync. */
function write(file: string, todos: Array<Record<string, unknown>>, quests: string) {
    const before = fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : undefined;
    const after = todosYaml(todos);
    fs.writeFileSync(file, after, 'utf8');
    return syncBlockingAfterWrite(file, before, after, quests);
}

function todoOf(file: string, id: string): Record<string, unknown> {
    const data = parse(fs.readFileSync(file, 'utf8')) as { todos: Array<Record<string, unknown>> };
    return data.todos.find((t) => t.id === id)!;
}

describe('todoBlocking sync', () => {
    test('TB-4: adding a blocked_by writes the blocking, same quest and across quests', () => {
        const { quests } = sandbox();
        const qa = path.join(quests, 'qa', 'todos.qa.todo.yaml');
        const qb = path.join(quests, 'qb', 'todos.qb.todo.yaml');
        write(qa, [{ id: 'blocker' }, { id: 'waits', blocked_by: ['blocker'] }], quests);
        assert.deepEqual(todoOf(qa, 'blocker').blocking, ['waits']);
        write(qb, [{ id: 'far', blocked_by: ['qa/blocker'] }], quests);
        assert.deepEqual(todoOf(qa, 'blocker').blocking, ['qb/far', 'waits']);
        const text = fs.readFileSync(qa, 'utf8');
        assert.ok(text.indexOf('blocking:') > text.indexOf('id: blocker'));
    });

    test('TB-5: removing the ref removes the entry, and the key when empty', () => {
        const { quests } = sandbox();
        const qa = path.join(quests, 'qa', 'todos.qa.todo.yaml');
        write(qa, [{ id: 'blocker' }, { id: 'waits', blocked_by: ['blocker'] }], quests);
        write(qa, [{ id: 'blocker', blocking: ['waits'] }, { id: 'waits' }], quests);
        assert.equal('blocking' in todoOf(qa, 'blocker'), false);
    });

    test('TB-6: archiving the blocked todo drops it; the terminal file is not rewritten', () => {
        const { quests } = sandbox();
        const qa = path.join(quests, 'qa', 'todos.qa.todo.yaml');
        const arch = path.join(quests, 'qa', 'todos-archived.qa.todo.yaml');
        write(qa, [{ id: 'blocker' }, { id: 'waits', blocked_by: ['blocker'] }], quests);
        // `waits` moves to the archive: target written first, then the source.
        write(arch, [{ id: 'waits', status: 'completed', blocked_by: ['blocker'] }], quests);
        const archText = fs.readFileSync(arch, 'utf8');
        write(qa, [{ id: 'blocker', blocking: ['waits'] }], quests);
        assert.equal('blocking' in todoOf(qa, 'blocker'), false);
        assert.equal(fs.readFileSync(arch, 'utf8'), archText);
    });

    test('TB-7: a renamed blocked todo is renamed in the blocking', () => {
        const { quests } = sandbox();
        const qa = path.join(quests, 'qa', 'todos.qa.todo.yaml');
        write(qa, [{ id: 'blocker' }, { id: 'old', blocked_by: ['blocker'] }], quests);
        write(qa, [{ id: 'blocker', blocking: ['old'] }, { id: 'new', blocked_by: ['blocker'] }], quests);
        assert.deepEqual(todoOf(qa, 'blocker').blocking, ['new']);
    });

    test('TB-8: an arriving todo is corrected; an untouched one elsewhere is not', () => {
        const { quests } = sandbox();
        const qa = path.join(quests, 'qa', 'todos.qa.todo.yaml');
        const qb = path.join(quests, 'qb', 'todos.qb.todo.yaml');
        // qb holds an unmigrated pair: blocked_by without the reverse side.
        fs.writeFileSync(qb, todosYaml([{ id: 'b0' }, { id: 'b1', blocked_by: ['b0'] }]), 'utf8');
        const qbText = fs.readFileSync(qb, 'utf8');
        write(qa, [{ id: 'moved', blocking: ['stale'] }], quests);
        assert.equal('blocking' in todoOf(qa, 'moved'), false);
        assert.equal(fs.readFileSync(qb, 'utf8'), qbText);
    });
});
