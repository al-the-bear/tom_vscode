/**
 * The answers of a sent todo walk read back from the session trails (utils/repetitionAnswers.ts), for walks that
 * ran before the queue kept them — what the queue editor's backfill uses.
 *
 *   RT-1 walkPrefixOf: a `<prefix>*` repeat count gives the prefix; a number or a plain string none
 *   RT-2 every answer reporting a todo of the walk (TODO=<ref> in the quest), the latest per todo, in the walk's
 *        order; another quest, another group (`prefix` followed by no number) and prompts are left out
 *   RT-3 `until` leaves out later answers
 */

import test, { describe } from 'node:test';
import assert from 'node:assert/strict';

import { repetitionAnswersFromTrail, walkPrefixOf } from '../repetitionAnswers';
import { extractTodoRefsFromVariables, parseTodoRef } from '../todoLogRefs';

const ref = (quest: string, id: string): string => `_ai/quests/${quest}/todos.${quest}.todo.yaml/${id}`;
const answer = (ts: string, text: string, ...refs: string[]) => ({ type: 'ANSWER', timestamp: ts, content: text, variables: refs.map((r) => `- TODO = ${r}`).join('\n') });
const ENTRIES = [
    answer('2026-11-10T07:00:00.000Z', 'first of wb-2', ref('q1', 'wb-2_akds-two')),
    answer('2026-11-10T06:00:00.000Z', 'wb-1', ref('q1', 'wb-1_akds-one')),
    answer('2026-11-10T07:30:00.000Z', 'again wb-2', ref('q1', 'wb-2_akds-two')),
    answer('2026-11-10T08:00:00.000Z', 'wb-10', ref('q1', 'wb-10_akds-ten')),
    answer('2026-11-10T08:10:00.000Z', 'other quest', ref('q2', 'wb-3_akds-three')),
    answer('2026-11-10T08:20:00.000Z', 'other group', ref('q1', 'wb-x_akds-x'), ref('q1', 'wbz1_akds-z')),
    { type: 'PROMPT', timestamp: '2026-11-10T08:30:00.000Z', content: 'prompt', variables: `- TODO = ${ref('q1', 'wb-4_akds-four')}` },
    answer('2026-11-10T09:00:00.000Z', '', ref('q1', 'wb-5_akds-empty')),
];

describe('a walk\'s answers from the trail', () => {
    test('RT-1: the walk prefix', () => {
        assert.equal(walkPrefixOf({ repeatCount: 'ccparity_g_workbench-*' }), 'ccparity_g_workbench-');
        assert.equal(walkPrefixOf({ repeatCount: ' vscimpb* ' }), 'vscimpb');
        assert.equal(walkPrefixOf({ repeatCount: 3 }), undefined);
        assert.equal(walkPrefixOf({ repeatCount: 'count' }), undefined);
        assert.equal(walkPrefixOf({ repeatCount: '*' }), undefined);
    });

    test('RT-2: the answers of the walk', () => {
        const got = repetitionAnswersFromTrail(ENTRIES, 'q1', 'wb-', extractTodoRefsFromVariables, parseTodoRef);
        assert.deepEqual(got.map((a) => [a.key, a.text]), [
            ['wb-1_akds-one', 'wb-1'], ['wb-2_akds-two', 'again wb-2'], ['wb-10_akds-ten', 'wb-10'],
        ]);
        assert.equal(got[1].at, '2026-11-10T07:30:00.000Z');
    });

    test('RT-3: until', () => {
        const got = repetitionAnswersFromTrail(ENTRIES, 'q1', 'wb-', extractTodoRefsFromVariables, parseTodoRef, '2026-11-10T07:15:00.000Z');
        assert.deepEqual(got.map((a) => [a.key, a.text]), [['wb-1_akds-one', 'wb-1'], ['wb-2_akds-two', 'first of wb-2']]);
    });
});
