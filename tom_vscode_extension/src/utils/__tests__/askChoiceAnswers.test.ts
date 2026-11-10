/**
 * The reply of a question round whose answer choices select (vscimpb35, src/utils/askChoices.ts).
 *
 *   CA-1 composeChoiceAnswers: every question numbered as asked — the selected choice (label, id, a target that
 *        differs), the user's own words, both, or "(no answer)" — then the general text; an id that is no answer
 *        choice of that question is ignored
 *   CA-2 readSingleAnswer: a one-question reply read back as {choiceId, text} from a Send-answers reply, a click on
 *        a choice that acts at once, or text typed alone (Telegram, the panel without choices)
 */

import test, { describe } from 'node:test';
import assert from 'node:assert/strict';

import { choiceAnswer, choiceQuestionIndex, composeChoiceAnswers, readSingleAnswer, type AskChoice } from '../askChoices.js';

const QUESTIONS = ['Keep it? {{choice:yes}}', 'Why?', 'How often?'];
const CHOICES: AskChoice[] = [
    { id: 'yes', label: 'Yes', kind: 'answer' },
    { id: 'no', label: 'No', kind: 'answer', question: 1 },
    { id: 'w', label: 'Weekly', kind: 'answer', question: 3, target: 'every week' },
    { id: 'go', label: 'Go to review', kind: 'move', target: 'review', question: 3 },
];

describe('answers sent together', () => {
    test('CA-1: the composed reply', () => {
        assert.deepEqual([...choiceQuestionIndex(QUESTIONS, CHOICES)], [['yes', 0], ['no', 0], ['w', 2], ['go', 2]]);
        const reply = composeChoiceAnswers(QUESTIONS, CHOICES, [
            { choiceId: 'no' },
            { text: '  it costs too much ' },
            { choiceId: 'w', text: 'on Fridays' },
        ], ' Thanks. ');
        assert.equal(reply, [
            'The answers, numbered like the questions:',
            '1. chose "No" (id no)',
            '2. it costs too much',
            '3. chose "Weekly" (id w, answer: every week) and wrote: on Fridays',
            '',
            'Thanks.',
        ].join('\n'));
        // Nothing for a question; an id of another question, or a move, is no answer to it.
        assert.equal(composeChoiceAnswers(QUESTIONS, CHOICES, [{ choiceId: 'w' }, {}, { choiceId: 'go' }], ''), [
            'The answers, numbered like the questions:',
            '1. (no answer)',
            '2. (no answer)',
            '3. (no answer)',
        ].join('\n'));
    });

    test('CA-2: one question read back', () => {
        const one = ['What now?'];
        const choices: AskChoice[] = [{ id: 'complete', label: 'Mark it completed', kind: 'answer' }, { id: 'leave', label: 'Leave it', kind: 'answer' }];
        assert.deepEqual(readSingleAnswer(composeChoiceAnswers(one, choices, [{ choiceId: 'complete' }], '')), { choiceId: 'complete', text: '' });
        assert.deepEqual(readSingleAnswer(composeChoiceAnswers(one, choices, [{ choiceId: 'complete', text: 'done on bigbeast\nand mbp' }], 'and more')),
            { choiceId: 'complete', text: 'done on bigbeast\nand mbp\n\nand more' });
        assert.deepEqual(readSingleAnswer(composeChoiceAnswers(one, choices, [{ text: 'not yet' }], '')), { text: 'not yet' });
        assert.deepEqual(readSingleAnswer(composeChoiceAnswers(one, choices, [{}], '')), { text: '' });
        assert.deepEqual(readSingleAnswer(composeChoiceAnswers(one, choices, [{}], 'only the general box')), { text: 'only the general box' });
        assert.deepEqual(readSingleAnswer(choiceAnswer(choices[0])), { choiceId: 'complete', text: '' }, 'a click that acts at once');
        assert.deepEqual(readSingleAnswer('  typed on Telegram '), { text: 'typed on Telegram' });
    });
});
