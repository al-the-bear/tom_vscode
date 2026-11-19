/**
 * The todo panel's dependency cleanup: the rules (src/utils/todoDependencyCleanup.ts) and the pass over real
 * todo files in a sandbox (src/services/todoDependencyCleanup.ts).
 *
 *   DC-1 a blocked_by entry naming a done todo (completed, cancelled) goes; one naming a todo that is no live
 *        todo (archived, deleted, gone) goes as completed; one naming an open todo stays; prose (a bare quest
 *        name) stays; another quest's todos by `<quest>/<id>`
 *   DC-2 a blocked todo whose blocked_by the pass empties is unblocked: not-started, group for a group todo,
 *        decision-needed with an open decision; not with a blocked_until left, not while an entry stays; a blocked
 *        todo without blocked_by is left alone (and counted)
 *   DC-3 blocking is what the others' blocked_by say after the removals: a wrong one is corrected, a missing one
 *        added, one naming a removed entry dropped; only todos in scope change
 *   DC-4 the notes line and the summary
 *   DC-5 the pass on files: the scope (todos / quests / all), one write per changed file, blocked_by, status,
 *        blocking, notes and updated written, the other keys and the YAML's form kept; the progress counts every
 *        todo in scope up to m
 */

import { describe, test, after } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'fs';
import * as path from 'path';
import { parse } from 'yaml';

import { cleanupNote, cleanupSummaryText, planDependencyCleanup, summarizeCleanup, unblockedStatus, type CleanupTodo } from '../todoDependencyCleanup.js';
import { runDependencyCleanup } from '../../services/todoDependencyCleanup.js';

const todo = (quest: string, id: string, over: Partial<CleanupTodo> = {}): CleanupTodo => ({
    quest, id, status: 'not-started', blockedBy: [], blocking: [], blockedUntil: [], group: false, openDecisions: false, ...over,
});
const QUESTS = new Set(['qa', 'qb']);
const all = (): boolean => true;
const byId = (changes: ReturnType<typeof planDependencyCleanup>, id: string) => changes.find((c) => c.id === id);

describe('todo dependency cleanup: the rules', () => {
    test('DC-1: which blocked_by entries go', () => {
        const todos = [
            todo('qa', 'done1', { status: 'completed' }),
            todo('qa', 'cancel1', { status: 'cancelled' }),
            todo('qa', 'open1', { status: 'in-progress' }),
            todo('qb', 'far1', { status: 'completed' }),
            todo('qa', 'w', { blockedBy: ['done1', 'cancel1', 'open1', 'gone1', 'qb/far1', 'qb/far2', 'qb'] }),
        ];
        const c = byId(planDependencyCleanup(todos, all, QUESTS), 'w')!;
        assert.deepEqual(c.removed, [
            { entry: 'done1', reason: 'done' }, { entry: 'cancel1', reason: 'done' }, { entry: 'gone1', reason: 'gone' },
            { entry: 'qb/far1', reason: 'done' }, { entry: 'qb/far2', reason: 'gone' },
        ]);
        assert.equal(c.status, undefined, 'not blocked: no status change');
    });

    test('DC-2: unblocked todos', () => {
        const todos = [
            todo('qa', 'done1', { status: 'completed' }),
            todo('qa', 'open1', { status: 'not-started' }),
            todo('qa', 'b1', { status: 'blocked', blockedBy: ['done1'] }),
            todo('qa', 'g1', { status: 'blocked', blockedBy: ['gone1'], group: true }),
            todo('qa', 'd1', { status: 'Blocked', blockedBy: ['done1'], openDecisions: true }),
            todo('qa', 'u1', { status: 'blocked', blockedBy: ['done1'], blockedUntil: ['tom_basics >= 9.0.0'] }),
            todo('qa', 's1', { status: 'blocked', blockedBy: ['done1', 'open1'] }),
            todo('qa', 'p1', { status: 'blocked' }),
        ];
        const changes = planDependencyCleanup(todos, all, QUESTS);
        assert.deepEqual(byId(changes, 'b1')!.status, { from: 'blocked', to: 'not-started' });
        assert.deepEqual(byId(changes, 'g1')!.status, { from: 'blocked', to: 'group' });
        assert.deepEqual(byId(changes, 'd1')!.status, { from: 'Blocked', to: 'decision-needed' });
        assert.equal(byId(changes, 'u1')!.status, undefined, 'a blocked_until condition stays');
        assert.equal(byId(changes, 's1')!.status, undefined, 'an open blocker stays');
        assert.equal(byId(changes, 'p1'), undefined, 'no blocked_by: left alone');
        assert.equal(summarizeCleanup(todos, changes, all).blockedWithoutBlockers, 1);
        assert.equal(unblockedStatus({ group: true, openDecisions: true }), 'group');
    });

    test('DC-3: blocking from the others\' blocked_by', () => {
        const todos = [
            todo('qa', 'a', { blocking: ['wrong'] }),
            todo('qa', 'b', { blockedBy: ['a', 'c'] }),
            todo('qa', 'c', { status: 'completed', blocking: ['b'] }),
            todo('qb', 'x', { blockedBy: ['qa/a'] }),
        ];
        const changes = planDependencyCleanup(todos, all, QUESTS);
        assert.deepEqual(byId(changes, 'a')!.blocking, { from: ['wrong'], to: ['b', 'qb/x'] });
        assert.deepEqual(byId(changes, 'c')!.blocking, { from: ['b'], to: [] }, 'b no longer names the done c');
        assert.deepEqual(byId(changes, 'b')!.removed, [{ entry: 'c', reason: 'done' }]);
        const onlyA = planDependencyCleanup(todos, (q, id) => q === 'qa' && id === 'a', QUESTS);
        assert.deepEqual(onlyA.map((c) => c.id), ['a'], 'only the todos in scope change');
        assert.deepEqual(byId(onlyA, 'a')!.blocking!.to, ['b', 'qb/x'], 'judged against every todo');
    });

    test('DC-4: the note and the summary', () => {
        assert.equal(cleanupNote({ quest: 'qa', id: 'w', removed: [{ entry: 'd', reason: 'done' }, { entry: 'g', reason: 'gone' }], status: { from: 'blocked', to: 'not-started' } }),
            'dependency cleanup: no longer blocked by d (done); no longer blocked by g (no longer a live todo, taken as completed); blocked → not-started: nothing blocks it any more');
        assert.equal(cleanupNote({ quest: 'qa', id: 'w', removed: [], blocking: { from: [], to: ['x'] } }), undefined, 'blocking alone: no note');
        assert.equal(cleanupSummaryText({ todos: 3, removedDone: 1, removedGone: 1, unblocked: 1, blockingFixed: 2, blockedWithoutBlockers: 1 }),
            'Todo dependencies: 3 todos checked, 2 blocked_by entries removed (1 done, 1 no longer a live todo), 1 unblocked, 2 blocking lists corrected. 1 blocked todo without blocked_by left as it is.');
    });
});

const EXT = path.resolve(__dirname, '..', '..', '..');
const SANDBOX = fs.realpathSync(fs.mkdtempSync(path.join(EXT, '..', '..', '..', 'ztmp', 'vscode_extension_261119_depcleanup-')));
after(() => fs.rmSync(SANDBOX, { recursive: true, force: true }));

describe('todo dependency cleanup: the pass on files', () => {
    test('DC-5: scope, writes, progress', async () => {
        const root = path.join(SANDBOX, 'quests');
        const put = (quest: string, text: string): string => {
            const f = path.join(root, quest, `todos.${quest}.todo.yaml`);
            fs.mkdirSync(path.dirname(f), { recursive: true });
            fs.writeFileSync(f, text);
            return f;
        };
        const fa = put('qa', [
            'todos:',
            '  # the first',
            '  - id: done1',
            '    status: completed',
            '    blocking:',
            '      - w1',
            '  - id: w1',
            '    title: waits',
            '    status: blocked',
            '    blocked_by:',
            '      - done1',
            '      - qb/gone',
            '    priority: high',
            '',
        ].join('\n'));
        const fb = put('qb', ['todos:', '  - id: x1', '    status: blocked', '    blocked_by:', '      - qa/done1', ''].join('\n'));
        fs.writeFileSync(path.join(root, 'qa', 'todos-archived.qa.todo.yaml'), 'todos:\n  - id: old\n    status: completed\n');
        const before = fs.readFileSync(fb, 'utf8');
        const progress: Array<[number, number]> = [];
        const run = await runDependencyCleanup(root, { kind: 'quests', quests: ['qa'] }, (n, m) => progress.push([n, m]), '2026-11-19');
        assert.deepEqual(run.files, [fa]);
        assert.equal(fs.readFileSync(fb, 'utf8').includes('qa/done1'), true, 'qb is out of scope');
        void before;
        const text = fs.readFileSync(fa, 'utf8');
        assert.match(text, /# the first/, 'the comment stays');
        assert.doesNotMatch(text, /blocked_by/);
        assert.match(text, /- id: w1\n    title: waits\n    status: not-started\n    priority: high/);
        const w1 = (parse(text) as { todos: Array<Record<string, string>> }).todos.find((t) => t.id === 'w1')!;
        assert.equal(w1.notes, '2026-11-19: dependency cleanup: no longer blocked by done1 (done); no longer blocked by qb/gone (no longer a live todo, taken as completed); blocked → not-started: nothing blocks it any more.');
        assert.match(text, /updated: 2026-11-19/);
        // done1's blocking: qb/x1 still names it (out of scope, unchanged), w1 no longer does.
        assert.match(text, /- id: done1\n    status: completed\n    blocking:\n      - qb\/x1/);
        assert.deepEqual(progress[0], [0, 2]);
        assert.deepEqual(progress.at(-1), [2, 2]);
        assert.ok(progress.every(([n, m], i) => m === 2 && (i === 0 || n >= progress[i - 1][0])), 'counting upwards');
        assert.equal(run.summary.unblocked, 1);
        // All quests: qb's entry goes too and x1 is unblocked; done1's blocking empties (the sync of qb's write, or the pass).
        const second = await runDependencyCleanup(root, { kind: 'all' }, () => undefined, '2026-11-19');
        assert.deepEqual(second.summary.unblocked, 1);
        assert.match(fs.readFileSync(fb, 'utf8'), /status: not-started/);
        assert.doesNotMatch(fs.readFileSync(fa, 'utf8'), /blocking:/);
        // A third pass finds nothing to do.
        const third = await runDependencyCleanup(root, { kind: 'todos', todos: [{ quest: 'qa', id: 'w1' }, { quest: 'qb', id: 'x1' }] }, () => undefined, '2026-11-19');
        assert.deepEqual(third.files, []);
        assert.equal(third.summary.todos, 2);
    });
});
