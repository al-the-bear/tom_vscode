/**
 * Todo groups, the rules (vscimpb125, src/utils/todoGroups.ts).
 *
 *   TG-1 part_of: the groups naming a todo — bare in the same quest, `<quest>/<id>` from another, sorted, no repeats
 *   TG-2 a group completes once every member is done (completed or cancelled, archived ones too); an open, unknown
 *        or malformed member keeps it open
 *   TG-3 a member reopened sets a completed group back to `group`; a group cancelled by hand, or one no crossed
 *        todo belongs to, is left alone
 *   TG-4 a `<prefix>*` walk passes group todos by
 */

import { describe, test } from 'node:test';
import assert from 'node:assert/strict';

import { groupDecisions, partOfRefs, type GroupRecord } from '../todoGroups.js';
import { pickNextTodoForIteration } from '../queueStep3Utils.js';

const group = (quest: string, id: string, status: string, comprisedOf: string[]): GroupRecord =>
    ({ scopeKey: `quest:${quest}`, quest, id, status, comprisedOf });
const statuses = (table: Record<string, string>) => (quest: string, id: string) => table[`${quest}/${id}`];

describe('todo groups', () => {
    test('TG-1: part_of', () => {
        const groups = [group('qa', 'g1', 'group', ['a1', 'qb/b1']), group('qb', 'g2', 'group', ['b1']), group('qa', 'g3', 'completed', ['a1', 'a1'])];
        assert.deepEqual(partOfRefs({ scopeKey: 'quest:qa', id: 'a1' }, groups), ['g1', 'g3']);
        assert.deepEqual(partOfRefs({ scopeKey: 'quest:qb', id: 'b1' }, groups), ['g2', 'qa/g1']);
        assert.deepEqual(partOfRefs({ scopeKey: 'quest:qa', id: 'nobody' }, groups), []);
    });

    test('TG-2: a group completes once every member is done', () => {
        const g = group('qa', 'g1', 'group', ['a1', 'a2', 'qb/b1']);
        const done = [{ quest: 'qa', id: 'a2', status: 'completed' }];
        assert.deepEqual(groupDecisions(done, [g], statuses({ 'qa/a1': 'cancelled', 'qa/a2': 'completed', 'qb/b1': 'completed' })),
            [{ quest: 'qa', id: 'g1', from: 'group', to: 'completed', note: 'group completed: every member is done' }]);
        assert.deepEqual(groupDecisions(done, [g], statuses({ 'qa/a1': 'in-progress', 'qa/a2': 'completed', 'qb/b1': 'completed' })), [], 'an open member');
        assert.deepEqual(groupDecisions(done, [g], statuses({ 'qa/a1': 'completed', 'qa/a2': 'completed' })), [], 'qb/b1 cannot be found: not done');
        assert.deepEqual(groupDecisions(done, [group('qa', 'g1', 'group', ['a2', 'qa/'])], statuses({ 'qa/a2': 'completed' })), [], 'a malformed member');
    });

    test('TG-3: a member reopened reopens a completed group', () => {
        const reopened = [{ quest: 'qb', id: 'b1', status: 'in-progress' }];
        assert.deepEqual(groupDecisions(reopened, [group('qa', 'g1', 'completed', ['a1', 'qb/b1'])], statuses({})),
            [{ quest: 'qa', id: 'g1', from: 'completed', to: 'group', note: 'group reopened: qb/b1 is in-progress' }]);
        assert.deepEqual(groupDecisions(reopened, [group('qa', 'g1', 'cancelled', ['qb/b1'])], statuses({})), [], 'cancelled by hand');
        assert.deepEqual(groupDecisions(reopened, [group('qa', 'g1', 'completed', ['a1'])], statuses({})), [], 'not a member');
        assert.deepEqual(groupDecisions(reopened, [group('qb', 'g2', 'completed', ['b1'])], statuses({})).map((d) => d.note), ['group reopened: b1 is in-progress'], 'named bare in its own quest');
    });

    test('TG-4: a walk passes group todos', () => {
        const todos = [{ id: 'gw1', status: 'group' }, { id: 'gw2', status: 'not-started' }];
        assert.equal(pickNextTodoForIteration('gw*', todos)?.id, 'gw2');
        assert.equal(pickNextTodoForIteration('gw*', [{ id: 'gw1', status: 'group' }]), undefined);
    });
});
