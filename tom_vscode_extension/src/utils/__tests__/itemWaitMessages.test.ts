/**
 * The messages written to a queue item's waiting turn, as the item keeps them (vscimpb173; src/utils/itemWaitMessages.ts).
 *
 *   WM-1 added in order, cut to the last MAX_ITEM_WAIT_MESSAGES; an answer is kept trimmed and cut
 *   WM-2 the newest message into a wait that is not resumed yet; one already resumed is not it
 *   WM-3 the queue file's `wait-messages` round trip; something else reads as none
 *   WM-4 what the editor shows: the agent has it → answered → the wait goes on
 *   WM-5 an empty text cannot be sent
 */

import test, { describe } from 'node:test';
import assert from 'node:assert/strict';

import {
    MAX_ITEM_WAIT_MESSAGES, MAX_WAIT_MESSAGE_ANSWER, keptAnswer, lastOpenWaitMessage, waitMessageProblem, waitMessageViews, waitMessagesFromYaml,
    waitMessagesToYaml, withWaitMessage, type ItemWaitMessage,
} from '../itemWaitMessages.js';

const at = (n: number): string => new Date(Date.UTC(2026, 10, 19, 12, n)).toISOString();
const m = (n: number, into: ItemWaitMessage['into'] = 'waitFor', extra: Partial<ItemWaitMessage> = {}): ItemWaitMessage => ({ at: at(n), into, text: `m${n}`, ...extra });

describe('the messages written to a waiting turn', () => {
    test('WM-1: kept in order, bounded', () => {
        let list: ItemWaitMessage[] | undefined;
        for (let i = 0; i < MAX_ITEM_WAIT_MESSAGES + 5; i++) { list = withWaitMessage(list, m(i)); }
        assert.equal(list!.length, MAX_ITEM_WAIT_MESSAGES);
        assert.deepEqual([list![0].text, list![list!.length - 1].text], ['m5', `m${MAX_ITEM_WAIT_MESSAGES + 4}`], 'the oldest go first');
        assert.equal(keptAnswer('  yes  '), 'yes');
        const long = keptAnswer('x'.repeat(MAX_WAIT_MESSAGE_ANSWER + 50));
        assert.equal(long.length, MAX_WAIT_MESSAGE_ANSWER + 2);
        assert.ok(long.endsWith(' …'));
    });

    test('WM-2: the message a wait resumes', () => {
        const list = [m(1, 'waitFor', { resumed: true }), m(2, 'background'), m(3, 'waitFor')];
        assert.equal(lastOpenWaitMessage(list, 'waitFor')?.text, 'm3');
        assert.equal(lastOpenWaitMessage(list, 'background')?.text, 'm2');
        list[2].resumed = true;
        assert.equal(lastOpenWaitMessage(list, 'waitFor'), undefined, 'the newest is resumed: nothing is open');
        assert.equal(lastOpenWaitMessage(undefined, 'waitFor'), undefined);
    });

    test('WM-3: the queue file', () => {
        const list = [m(1, 'waitFor', { answer: 'ok', resumed: true }), m(2, 'background')];
        const yaml = waitMessagesToYaml(list);
        assert.deepEqual(yaml, [{ at: at(1), into: 'waitFor', text: 'm1', answer: 'ok', resumed: true }, { at: at(2), into: 'background', text: 'm2' }]);
        assert.deepEqual(waitMessagesFromYaml(yaml), list);
        assert.equal(waitMessagesFromYaml(undefined), undefined);
        assert.equal(waitMessagesFromYaml([]), undefined);
        assert.equal(waitMessagesFromYaml([{ text: 'no time' }, 'junk']), undefined);
        assert.deepEqual(waitMessagesFromYaml([{ at: at(1), text: 't', into: 'other' }]), [{ at: at(1), into: 'waitFor', text: 't' }]);
    });

    test('WM-4: what the editor shows', () => {
        const views = waitMessageViews([m(1), m(2, 'background', { answer: 'half way' }), m(3, 'waitFor', { resumed: true })]);
        assert.deepEqual(views.map((v) => [v.text, v.into, v.state, v.answer]), [
            ['m1', 'waitFor', 'the agent has it', undefined], ['m2', 'background', 'answered', 'half way'], ['m3', 'waitFor', 'the wait goes on', undefined],
        ]);
        assert.deepEqual(waitMessageViews(undefined), []);
    });

    test('WM-5: an empty text', () => {
        assert.equal(waitMessageProblem('  \n '), 'The message is empty.');
        assert.equal(waitMessageProblem(undefined), 'The message is empty.');
        assert.equal(waitMessageProblem(' x '), undefined);
    });
});
