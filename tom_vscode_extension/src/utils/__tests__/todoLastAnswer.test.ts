/**
 * A todo walk's final answer kept on the todo (src/utils/todoLastAnswer.ts).
 *
 *   LA-1 a settled claim whose todo is completed writes the main prompt's answer onto it
 *   LA-2 a second run of the same todo replaces the answer (only the last is kept)
 *   LA-3 nothing is written when the todo is not completed, when there is no answer (or a blank one),
 *        when there is no claim (an item walking no todo) or the claim was released; a failed write is
 *        reported
 */

import test, { describe } from 'node:test';
import assert from 'node:assert/strict';

import { recordTodoAnswer, type TodoAnswerPort } from '../todoLastAnswer.js';
import type { TodoClaim } from '../queueTodoClaim.js';

function store(status: Record<string, string>): TodoAnswerPort & { answers: Record<string, string> } {
    const answers: Record<string, string> = {};
    return {
        answers,
        readStatus: (_q, id) => status[id],
        writeLastAnswer: (_q, id, answer) => { if (!(id in status)) { return false; } answers[id] = answer; return true; },
    };
}
const claim = (todoId: string, released = false): TodoClaim => ({ questId: 'q', todoId, priorStatus: 'not-started', claimedAt: '2026-11-05T22:00:00Z', ...(released ? { released } : {}) });

describe('todo last answer', () => {
    test('LA-1: written onto a completed todo', () => {
        const s = store({ t1: 'completed' });
        assert.equal(recordTodoAnswer(s, claim('t1'), '# Done\n\nAll green.'), 'written');
        assert.equal(s.answers.t1, '# Done\n\nAll green.');
    });

    test('LA-2: a second run replaces it', () => {
        const s = store({ t1: 'completed' });
        recordTodoAnswer(s, claim('t1'), 'first');
        recordTodoAnswer(s, claim('t1'), 'second');
        assert.equal(s.answers.t1, 'second');
    });

    test('LA-3: when nothing is written', () => {
        const s = store({ t1: 'in-progress', t2: 'completed' });
        assert.equal(recordTodoAnswer(s, claim('t1'), 'answer'), 'not-completed');
        assert.equal(recordTodoAnswer(s, claim('t2'), undefined), 'no-answer');
        assert.equal(recordTodoAnswer(s, claim('t2'), '   \n'), 'no-answer');
        assert.equal(recordTodoAnswer(s, undefined, 'answer'), 'no-claim', 'an item walking no todo');
        assert.equal(recordTodoAnswer(s, claim('t2', true), 'answer'), 'no-claim', 'a released claim');
        assert.deepEqual(s.answers, {});
        assert.equal(recordTodoAnswer(store({ gone: 'completed' }), claim('missing'), 'answer'), 'not-completed');
        const failing: TodoAnswerPort = { readStatus: () => 'completed', writeLastAnswer: () => false };
        assert.equal(recordTodoAnswer(failing, claim('t'), 'answer'), 'write-failed');
    });
});
