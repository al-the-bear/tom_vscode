/**
 * What Continue offers on a running queue item (vscimpb55), and the waiting label.
 *
 *   PQ-1 waiting for an answer: Answer now, Resend this stage, Skip — in that order
 *   PQ-2 not waiting: Resend and Skip only (an item can be stuck for reasons nobody sees)
 *   PQ-3 nothing dispatched yet: no Resend; a walk says "next todo", other items "next stage"
 *   PQ-4 the dialog text names the waiting time, and says Resend and Skip close the question
 *   PQ-5 the waiting label: local clock time and how long, in minutes or hours
 *   PQ-6 waiting for its background work: Wait without limit, Keep waiting up to <limit>, Stop waiting, then
 *        Resend and Skip (vscimpb57); the dialog text says what each does
 */

import test, { describe } from 'node:test';
import assert from 'node:assert/strict';

import { continueOptions, continuePrompt, waitingSinceLabel } from '../pendingQuestion.js';

describe('pending question and Continue', () => {
    test('PQ-1: waiting for an answer', () => {
        assert.deepEqual(continueOptions({ waitingForAnswer: true, canResend: true, walk: true }), [
            { action: 'answer', label: 'Answer now' },
            { action: 'resend', label: 'Resend this stage' },
            { action: 'skip', label: 'Skip to the next todo' },
        ]);
    });

    test('PQ-2: not waiting', () => {
        assert.deepEqual(continueOptions({ waitingForAnswer: false, canResend: true, walk: true }).map((o) => o.action), ['resend', 'skip']);
    });

    test('PQ-3: no dispatch to resend; a single item', () => {
        assert.deepEqual(continueOptions({ waitingForAnswer: false, canResend: false, walk: false }), [
            { action: 'skip', label: 'Skip to the next stage' },
        ]);
    });

    test('PQ-4: the dialog text', () => {
        const waiting = continuePrompt({ waitingSince: 'since 20:31 (9 h 25 min)', walk: true });
        assert.match(waiting.message, /waiting for your answer \(since 20:31 \(9 h 25 min\)\)/);
        assert.match(waiting.detail, /Resend and Skip close the question unanswered/);
        assert.match(waiting.detail, /next todo/);
        const running = continuePrompt({ walk: false });
        assert.equal(running.message, 'This item is still running.');
        assert.match(running.detail, /told it was interrupted/);
        assert.match(running.detail, /next stage/);
    });

    test('PQ-5: the waiting label', () => {
        const at = new Date(2026, 10, 10, 20, 31, 5).getTime();
        assert.equal(waitingSinceLabel(at, at + 20_000), 'since 20:31 (under a minute)');
        assert.equal(waitingSinceLabel(at, at + 7 * 60_000), 'since 20:31 (7 min)');
        assert.equal(waitingSinceLabel(at, at + (9 * 60 + 25) * 60_000), 'since 20:31 (9 h 25 min)');
        assert.equal(waitingSinceLabel(new Date(2026, 10, 11, 5, 4).getTime(), new Date(2026, 10, 11, 5, 4).getTime()), 'since 05:04 (under a minute)');
    });

    test('PQ-6: waiting for its background work', () => {
        assert.deepEqual(continueOptions({ waitingForAnswer: false, canResend: true, walk: true, backgroundLimit: '6 h' }), [
            { action: 'waitWithoutLimit', label: 'Wait without limit' },
            { action: 'keepWaiting', label: 'Keep waiting up to 6 h' },
            { action: 'stopWaiting', label: 'Stop waiting' },
            { action: 'resend', label: 'Resend this stage' },
            { action: 'skip', label: 'Skip to the next todo' },
        ]);
        const text = continuePrompt({ walk: true, backgroundWait: '2 tasks, 1 h 20 min of 6 h' });
        assert.match(text.message, /waiting for its background work \(2 tasks, 1 h 20 min of 6 h\)/);
        assert.match(text.detail, /Stop waiting ends the turn now/);
    });

    test('PQ-7: writing to the waiting turn, answering here (vscimpb173)', () => {
        const labels = (o: Parameters<typeof continueOptions>[0]): string[] => continueOptions(o).map((x) => x.label);
        // Message… after the wait's own choices, while a message can reach the turn.
        assert.deepEqual(labels({ waitingForAnswer: false, canResend: true, walk: false, waitingFor: true, canMessage: true }),
            ['Keep waiting', 'Interrupt the wait and move on', 'Message…', 'Resend this stage', 'Skip to the next stage']);
        assert.deepEqual(labels({ waitingForAnswer: false, canResend: true, walk: false, backgroundLimit: '6 h', canMessage: true }),
            ['Wait without limit', 'Keep waiting up to 6 h', 'Stop waiting', 'Message…', 'Resend this stage', 'Skip to the next stage']);
        assert.ok(!labels({ waitingForAnswer: false, canResend: true, walk: false, backgroundLimit: '6 h' }).includes('Message…'), 'a transport that takes none');
        assert.equal(continueOptions({ waitingForAnswer: false, canResend: false, walk: false, canMessage: true }).find((x) => x.label === 'Message…')?.action, 'message');
        // Type an answer… beside Answer now, in the ask state only.
        assert.deepEqual(labels({ waitingForAnswer: true, canResend: true, walk: false, canAnswerHere: true }), ['Answer now', 'Type an answer…', 'Resend this stage', 'Skip to the next stage']);
        assert.ok(!labels({ waitingForAnswer: false, canResend: true, walk: false, canAnswerHere: true }).includes('Type an answer…'));
        assert.equal(continueOptions({ waitingForAnswer: true, canResend: false, walk: false, canAnswerHere: true })[1].action, 'answerHere');
        assert.match(continuePrompt({ walk: false, waitingFor: 'r — until 14:20' }).detail, /Message… writes to the waiting turn: the agent reads it and waits on/);
        assert.match(continuePrompt({ walk: false, backgroundWait: '1 task' }).detail, /Message… writes to the waiting turn/);
        assert.match(continuePrompt({ walk: false, waitingSince: 'since 20:31' }).detail, /Type an answer… takes your answer right here/);
    });
});
