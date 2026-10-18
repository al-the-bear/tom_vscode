/**
 * Todo iteration and blocked todos: before a `prefix*` walk picks its next
 * todo, a `blocked` todo of the series whose blockers are all gone or done is
 * released back to `not-started`, so the walk can run it. A todo still waiting
 * on something stays blocked and is not run.
 *
 *   UB-1  every blocker completed (or cancelled) → released
 *   UB-2  a blocker that no longer exists (deleted, archived away) counts as done
 *   UB-3  one open blocker keeps the todo blocked
 *   UB-4  no `blocked_by` (a prose-only block) or a `blocked_until` condition → stays blocked
 *   UB-5  only the series' own blocked todos are considered
 *   UB-6  a chain: a todo blocked by an earlier one of the list is released once that one completes
 *   UB-7  `<quest>/<id>` blockers are looked up in their quest
 *   UB-8  releaseUnblockedTodos writes not-started, reads another quest once, reports a failed write
 */

import test, { describe } from 'node:test';
import assert from 'node:assert/strict';

import { pickNextTodoForIteration, releaseUnblockedTodos, todosToUnblock, type BlockerLookup, type BlockableTodo, type TodoUnblockPort } from '../queueStep3Utils.js';

const todo = (id: string, status: string, blockedBy?: string[], blockedUntil?: string[]): BlockableTodo =>
    ({ id, status, ...(blockedBy ? { blockedBy } : {}), ...(blockedUntil ? { blockedUntil } : {}) });

/** A lookup over a fixed table: id (or quest/id) → status; absent → the todo no longer exists. */
const lookupOf = (table: Record<string, string>): BlockerLookup => (ref) =>
    (ref in table ? { status: table[ref] } : undefined);

describe('todosToUnblock', () => {
    test('UB-1: every blocker completed or cancelled → released', () => {
        const todos = [todo('dsa1', 'completed'), todo('dsa2', 'cancelled'), todo('dsa3', 'blocked', ['dsa1', 'dsa2'])];
        const r = todosToUnblock('dsa*', todos, lookupOf({ dsa1: 'completed', dsa2: 'cancelled' }));
        assert.deepEqual(r, [{ id: 'dsa3', blockers: ['dsa1', 'dsa2'] }]);
    });

    test('UB-2: a blocker that no longer exists counts as done', () => {
        const r = todosToUnblock('dsa*', [todo('dsa3', 'blocked', ['gone_ajms-x'])], lookupOf({}));
        assert.deepEqual(r.map((u) => u.id), ['dsa3']);
    });

    test('UB-3: one open blocker keeps it blocked', () => {
        const todos = [todo('dsa3', 'blocked', ['dsa1', 'dsa2'])];
        for (const open of ['not-started', 'in-progress', 'blocked', 'decision-needed']) {
            assert.deepEqual(todosToUnblock('dsa*', todos, lookupOf({ dsa1: 'completed', dsa2: open })), [], open);
        }
    });

    test('UB-4: a prose-only block, or a blocked_until condition, stays blocked', () => {
        assert.deepEqual(todosToUnblock('dsa*', [todo('dsa3', 'blocked')], lookupOf({})), []);
        assert.deepEqual(todosToUnblock('dsa*', [todo('dsa3', 'blocked', [])], lookupOf({})), []);
        assert.deepEqual(
            todosToUnblock('dsa*', [todo('dsa3', 'blocked', ['dsa1'], ['tom_d4rt >= 1.0.0'])], lookupOf({ dsa1: 'completed' })),
            [],
            'a release condition this check cannot evaluate keeps the block',
        );
    });

    test('UB-5: only blocked todos of the series', () => {
        const todos = [
            todo('dsa3', 'not-started', ['x']),
            todo('xyz3', 'blocked', ['x']),
            todo('dsa4', 'blocked', ['x']),
        ];
        assert.deepEqual(todosToUnblock('dsa*', todos, lookupOf({})).map((u) => u.id), ['dsa4']);
        assert.deepEqual(todosToUnblock('7', todos, lookupOf({})), [], 'not a prefix* pattern');
    });

    test('UB-6: a chain in the list is released one link at a time', () => {
        const todos = [todo('dsa1', 'in-progress'), todo('dsa2', 'blocked', ['dsa1']), todo('dsa3', 'blocked', ['dsa2'])];
        assert.deepEqual(todosToUnblock('dsa*', todos, lookupOf({ dsa1: 'in-progress', dsa2: 'blocked' })), []);
        assert.deepEqual(
            todosToUnblock('dsa*', todos, lookupOf({ dsa1: 'completed', dsa2: 'blocked' })).map((u) => u.id),
            ['dsa2'],
            'dsa3 waits for dsa2, which is only released now',
        );
    });

    test('UB-7: a quest-qualified blocker is passed to the lookup as written', () => {
        const asked: string[] = [];
        const lookup: BlockerLookup = (ref) => { asked.push(ref); return { status: 'completed' }; };
        assert.equal(todosToUnblock('dsa*', [todo('dsa3', 'blocked', ['other_quest/abc1'])], lookup).length, 1);
        assert.deepEqual(asked, ['other_quest/abc1']);
    });

    test('UB-8: releaseUnblockedTodos over a port', () => {
        const quests: Record<string, BlockableTodo[]> = {
            q: [todo('dsa1', 'completed'), todo('dsa2', 'blocked', ['dsa1', 'other/x1']), todo('dsa3', 'blocked', ['dsa2']), todo('dsa4', 'blocked', ['nope9'])],
            other: [todo('x1', 'completed')],
        };
        const reads: string[] = [];
        const writes: string[] = [];
        const port: TodoUnblockPort = {
            readTodos: (quest) => { reads.push(quest); return quests[quest] ?? []; },
            writeStatus: (quest, id, status) => {
                writes.push(`${quest}/${id}=${status}`);
                if (id === 'dsa4') { return false; }
                quests[quest].find((x) => x.id === id)!.status = status;
                return true;
            },
        };
        const r = releaseUnblockedTodos('dsa*', 'q', port);
        assert.deepEqual(r.released.map((u) => u.id), ['dsa2']);
        assert.deepEqual(r.failed, ['dsa4'], 'a gone blocker releases it, but the write did not stick');
        assert.deepEqual(writes, ['q/dsa2=not-started', 'q/dsa4=not-started']);
        assert.deepEqual(reads, ['q', 'other'], 'each quest read once');
        assert.equal(pickNextTodoForIteration('dsa*', quests.q)?.id, 'dsa2', 'the walk now picks the released todo');
    });
});
