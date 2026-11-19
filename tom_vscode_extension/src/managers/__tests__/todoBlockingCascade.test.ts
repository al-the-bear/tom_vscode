/**
 * Blocked todos follow their blockers (vscimpb121, src/utils/todoBlockingCascade.ts).
 *
 *   BC-1 the rule, done: a blocked dependent whose conditions are all met becomes not-started, decision-needed with
 *        open decisions; one with another open blocker stays; an unknown id or a bare quest name is not met
 *   BC-2 the rule, reopened: not-started / decision-needed dependents go back to blocked; in-progress, completed,
 *        cancelled and waiting-for-repeat ones are left alone
 *   BC-3 blocked_until: met by pub.dev's version; an unknown version is fetched first (pendingVersions)
 *   BC-4 crossings: only a change between done and not done counts
 *   BC-5 through the todo manager: completing a todo in one quest unblocks its dependent in another quest (with a
 *        notes line) and leaves the `blocked_by` list of every dependent, whatever its status; reopened, it blocks
 *        only a dependent that still names it
 *   BC-7 the removals (pure): a done blocker's entry in every dependent; none for a blocker reopened
 *   BC-6 through the manager with blocked_until: the version is fetched, then the dependent is released
 */

/* eslint-disable @typescript-eslint/naming-convention -- `blocked_by` is the todo schema's YAML key */
import { describe, test, after } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'fs';
import * as path from 'path';

import { installVscodeStub } from '../../tools/__tests__/_vscode-stub.js';

const EXT_ROOT = path.resolve(__dirname, '..', '..', '..');
const tmpRoot = fs.realpathSync(fs.mkdtempSync(path.join(EXT_ROOT, '..', '..', '..', 'ztmp', 'vscode_extension_261116_vscimpb121_cascade-')));
installVscodeStub({ workspaceFolders: [tmpRoot] });

import { createTodo, findTodoById, updateTodo } from '../questTodoManager.js';
import {
    blockerRemovals, blockingCascadeSettled, cascadeDecisions, crossingsOfWrite, setVersionFetcherForTest,
    type DependentTodo, type StatusLookup,
} from '../../utils/todoBlockingCascade.js';

for (const q of ['qa', 'qb']) { fs.mkdirSync(path.join(tmpRoot, '_ai', 'quests', q), { recursive: true }); }
after(() => { setVersionFetcherForTest(undefined); fs.rmSync(tmpRoot, { recursive: true, force: true }); });

const dep = (id: string, status: string, blockedBy: string[], extra: Partial<DependentTodo> = {}): DependentTodo =>
    ({ quest: 'qb', id, status, blockedBy, blockedUntil: [], openDecisions: false, ...extra });
const statuses = (table: Record<string, string>): StatusLookup => (quest, id) => table[`${quest}/${id}`];
const QUESTS = new Set(['qa', 'qb']);
const noVersions = () => undefined;

describe('the cascade rule', () => {
    test('BC-1: a blocker done', () => {
        const done = [{ quest: 'qa', id: 'b1', status: 'completed' }];
        const look = statuses({ 'qa/b1': 'completed', 'qb/b2': 'cancelled', 'qb/open': 'in-progress' });
        const r = cascadeDecisions(done, [
            dep('d1', 'blocked', ['qa/b1']),
            dep('d2', 'blocked', ['qa/b1', 'b2'], { openDecisions: true }),
            dep('d3', 'blocked', ['qa/b1', 'open']),
            dep('d4', 'blocked', ['qa/b1', 'unknown_id']),
            dep('d5', 'blocked', ['qa/b1', 'qa']),
            dep('d6', 'not-started', ['qa/b1']),
        ], look, noVersions, QUESTS);
        assert.deepEqual(r.decisions.map((d) => [d.id, d.to, d.note]), [
            ['d1', 'not-started', 'unblocked by qa/b1'],
            ['d2', 'decision-needed', 'unblocked by qa/b1'],
        ], 'd3 has an open blocker, d4 an unknown id, d5 a bare quest name (prose); d6 is not blocked');
    });

    test('BC-2: a blocker reopened', () => {
        const reopened = [{ quest: 'qa', id: 'b1', status: 'in-progress' }];
        const r = cascadeDecisions(reopened, ['not-started', 'decision-needed', 'in-progress', 'completed', 'cancelled', 'waiting-for-repeat', 'blocked']
            .map((s, i) => dep(`d${i}`, s, ['qa/b1'])), statuses({}), noVersions, QUESTS);
        assert.deepEqual(r.decisions.map((d) => [d.id, d.from, d.to, d.note]), [
            ['d0', 'not-started', 'blocked', 'blocked again: qa/b1 is in-progress'],
            ['d1', 'decision-needed', 'blocked', 'blocked again: qa/b1 is in-progress'],
        ]);
    });

    test('BC-3: blocked_until', () => {
        const done = [{ quest: 'qb', id: 'b1', status: 'completed' }];
        const look = statuses({ 'qb/b1': 'completed' });
        const until = (c: string) => dep('d', 'blocked', ['b1'], { blockedUntil: [c] });
        assert.equal(cascadeDecisions(done, [until('tom_x >= 1.2.0')], look, () => '1.2.0', QUESTS).decisions.length, 1);
        assert.equal(cascadeDecisions(done, [until('tom_x > 1.2.0')], look, () => '1.2.0', QUESTS).decisions.length, 0);
        assert.equal(cascadeDecisions(done, [until('tom_x >= 1.10.0')], look, () => '1.9.3', QUESTS).decisions.length, 0, 'numeric, not lexical');
        const pending = cascadeDecisions(done, [until('tom_x >= 1.2.0')], look, noVersions, QUESTS);
        assert.deepEqual([pending.decisions.length, pending.pendingVersions], [0, ['tom_x']], 'unknown: fetch first, change nothing yet');
    });

    test('BC-4: only a crossing between done and not done', () => {
        const yaml = (s: string) => `todos:\n  - id: t1\n    status: ${s}\n`;
        assert.deepEqual(crossingsOfWrite('q', yaml('in-progress'), yaml('completed')), [{ quest: 'q', id: 't1', status: 'completed' }]);
        assert.deepEqual(crossingsOfWrite('q', yaml('completed'), yaml('not-started')), [{ quest: 'q', id: 't1', status: 'not-started' }]);
        assert.deepEqual(crossingsOfWrite('q', yaml('blocked'), yaml('not-started')), []);
        assert.deepEqual(crossingsOfWrite('q', yaml('completed'), yaml('cancelled')), []);
        assert.deepEqual(crossingsOfWrite('q', undefined, yaml('completed')), [], 'a new todo is no crossing');
    });
});

describe('through the todo manager', () => {
    test('BC-5: completing unblocks across quests, reopening blocks again', () => {
        createTodo('qa', { id: 'blocker', description: 'b', status: 'in-progress' });
        createTodo('qb', { id: 'waits', description: 'w', status: 'blocked', blocked_by: ['qa/blocker'] });
        createTodo('qb', { id: 'busy', description: 'x', status: 'in-progress', blocked_by: ['qa/blocker'] });

        updateTodo('qa', 'blocker', { status: 'completed' });
        const released = findTodoById('qb', 'waits')!;
        assert.equal(released.status, 'not-started');
        assert.match(String(released.notes), /\d{4}-\d{2}-\d{2}: unblocked by qa\/blocker\./);
        // The done blocker left the `blocked_by` lists: of the released todo and of the in-progress one alike.
        assert.equal(released.blocked_by, undefined, 'the entry is gone');
        const busy = findTodoById('qb', 'busy')!;
        assert.equal(busy.status, 'in-progress', 'its status is left alone');
        assert.equal(busy.blocked_by, undefined);
        assert.match(String(busy.notes), /\d{4}-\d{2}-\d{2}: no longer blocked by qa\/blocker \(done\)\./);
        assert.equal(findTodoById('qa', 'blocker')!.blocking, undefined, 'and `blocking` follows');

        // Reopened: nothing names it any more, so nothing is blocked again.
        updateTodo('qa', 'blocker', { status: 'not-started' });
        assert.equal(findTodoById('qb', 'waits')!.status, 'not-started');
        // A dependent that names it (again) is blocked again.
        updateTodo('qb', 'waits', { blocked_by: ['qa/blocker'] });
        updateTodo('qa', 'blocker', { status: 'completed' });
        updateTodo('qb', 'waits', { blocked_by: ['qa/blocker'] });
        updateTodo('qa', 'blocker', { status: 'in-progress' });
        assert.equal(findTodoById('qb', 'waits')!.status, 'blocked', 'blocked again: it names the reopened todo');

        // Several blockers: only the done one leaves.
        createTodo('qa', { id: 'other', description: 'o', status: 'not-started' });
        createTodo('qb', { id: 'two', description: 't', status: 'blocked', blocked_by: ['qa/blocker', 'qa/other'] });
        updateTodo('qa', 'blocker', { status: 'cancelled' });
        const two = findTodoById('qb', 'two')!;
        assert.deepEqual(two.blocked_by, ['qa/other'], 'a cancelled blocker leaves too; the open one stays');
        assert.equal(two.status, 'blocked', 'still blocked by the other');
    });

    test('BC-7: the removals', () => {
        const quests = new Set(['qa', 'qb']);
        const deps = [dep('d1', 'blocked', ['qa/x', 'y']), dep('d2', 'in-progress', ['qa/x']), dep('d3', 'completed', ['qb/y']), dep('d4', 'not-started', ['qa/z'])];
        assert.deepEqual(blockerRemovals([{ quest: 'qa', id: 'x', status: 'completed' }, { quest: 'qb', id: 'y', status: 'cancelled' }], deps, quests), [
            { quest: 'qb', id: 'd1', entries: ['qa/x', 'y'] }, { quest: 'qb', id: 'd2', entries: ['qa/x'] }, { quest: 'qb', id: 'd3', entries: ['qb/y'] },
        ]);
        assert.deepEqual(blockerRemovals([{ quest: 'qa', id: 'x', status: 'in-progress' }], deps, quests), [], 'a reopened blocker removes nothing');
        assert.deepEqual(blockerRemovals([], deps, quests), []);
    });

    test('BC-6: blocked_until waits for the version', async () => {
        let asked = 0;
        setVersionFetcherForTest(async () => { asked++; return '2.0.0'; });
        createTodo('qa', { id: 'pub_blocker', description: 'b', status: 'in-progress' });
        createTodo('qa', { id: 'pub_waits', description: 'w', status: 'blocked', blocked_by: ['pub_blocker'], blocked_until: ['tom_x >= 2.0.0'] });
        updateTodo('qa', 'pub_blocker', { status: 'completed' });
        assert.equal(findTodoById('qa', 'pub_waits')!.status, 'blocked', 'not yet: the version is being fetched');
        await blockingCascadeSettled();
        assert.equal(asked, 1);
        assert.equal(findTodoById('qa', 'pub_waits')!.status, 'not-started', 'released once pub.dev has the version');
        assert.equal(findTodoById('qa', 'pub_waits')!.blocked_by, undefined, 'and the done blocker left its list then');
    });
});
