/**
 * Send Now finishes as `sent`, and starts a `sent` item again.
 *
 *   SN-1 Send Now acts on pending, staged and sent items, not on sending / error / waiting ones
 *   SN-2 the pause gate holds only an item that has already sent a prompt, and only while auto-send is off
 *   SN-3 resetItemRunState puts a finished item (pre-prompts, repetitions, prefix todo, follow-ups) back
 *        to its first prompt, and leaves its prompts and settings alone
 *   SN-4 the manager checks the pause gate just before each further prompt (pre-prompt, main, follow-up),
 *        not on entry to the dispatcher — on entry it kept every item that had sent anything in `sending`,
 *        so an item sent with Send Now while auto-send was off never became `sent`
 *   SN-5 Send Now on a sent item resets its run first, and the editor offers the button on sent items
 */

import test, { describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { canSendNow, pausesBeforeNextDispatch, resetItemRunState, type RunStateItem } from '../queueSendNow.js';
import { itemHasInFlightProgress } from '../queueErrorTransitions.js';

/** out/utils/__tests__ -> project root is three levels up. */
function source(...parts: string[]): string {
    return readFileSync(join(__dirname, '..', '..', '..', ...parts), 'utf-8');
}

function finishedItem(): RunStateItem & { originalText: string; repeatCount: string } {
    return {
        originalText: 'do ${repeatTodoId}',
        repeatCount: 'dsa*',
        prePrompts: [{ status: 'sent', repeatIndex: 1, resolvedRepeatCount: 1 }],
        followUps: [{ repeatIndex: 2, resolvedRepeatCount: 2 }],
        repeatIndex: 7,
        resolvedRepeatCount: 9,
        repeatTodoId: 'dsa7_ajwe-x',
        requestId: 'r1',
        expectedRequestId: 'r2',
        followUpIndex: 1,
        reminderSentCount: 2,
        lastReminderAt: '2026-10-26T10:00:00Z',
        error: 'old',
        warning: 'old',
        lastDispatched: { kind: 'followUp' },
        inFlightRepetition: { stage: 'followUp' },
        awaitingAnswer: true,
    };
}

describe('queueSendNow', () => {
    test('SN-1: which statuses Send Now acts on', () => {
        for (const s of ['pending', 'staged', 'sent']) { assert.equal(canSendNow(s), true, s); }
        for (const s of ['sending', 'error', 'waiting', 'retry', 'decision-needed', 'interrupted']) {
            assert.equal(canSendNow(s), false, s);
        }
    });

    test('SN-2: the pause gate', () => {
        const fresh: RunStateItem = { repeatIndex: 0, followUpIndex: 0 };
        const started: RunStateItem = { repeatIndex: 1 };
        assert.equal(pausesBeforeNextDispatch(false, fresh), false, 'the first prompt always goes out');
        assert.equal(pausesBeforeNextDispatch(false, started), true);
        assert.equal(pausesBeforeNextDispatch(true, started), false);
    });

    test('SN-3: a finished item is reset to its first prompt', () => {
        const item = finishedItem();
        assert.equal(itemHasInFlightProgress(item), true);
        resetItemRunState(item);
        assert.equal(itemHasInFlightProgress(item), false, 'a fresh start, not a resume');
        assert.deepEqual(item.prePrompts, [{ status: 'pending', repeatIndex: 0, resolvedRepeatCount: undefined }]);
        assert.deepEqual(item.followUps, [{ repeatIndex: 0, resolvedRepeatCount: undefined }]);
        assert.equal(item.repeatTodoId, undefined, 'the todo walk starts over');
        assert.equal(item.resolvedRepeatCount, undefined);
        for (const k of ['requestId', 'expectedRequestId', 'lastReminderAt', 'error', 'warning', 'lastDispatched', 'inFlightRepetition'] as const) {
            assert.equal(item[k], undefined, k);
        }
        assert.equal(item.awaitingAnswer, false);
        assert.equal(item.originalText, 'do ${repeatTodoId}', 'the prompt is kept');
        assert.equal(item.repeatCount, 'dsa*', 'the repeat setting is kept');
    });

    test('SN-4: the pause gate sits before each further prompt, not on entry', () => {
        const src = source('src', 'managers', 'promptQueueManager.ts');
        const start = src.indexOf('private async dispatchNextStageForSendingItem(');
        const body = src.slice(start, src.indexOf('\n    }\n', start));
        const firstStage = body.indexOf('// Stage 1: Pre-prompts');
        assert.ok(firstStage > 0);
        assert.equal(/this\._pauseBeforeNextDispatch\(|this\._autoSendEnabled/.test(body.slice(0, firstStage)), false,
            'no gate before the stages');
        assert.equal((body.match(/this\._pauseBeforeNextDispatch\(item\)/g) ?? []).length, 3,
            'one gate per stage: pre-prompt, main, follow-up');
        assert.ok(body.indexOf('this._pauseBeforeNextDispatch(item)', body.indexOf('// Stage 2: Main prompt'))
            < body.indexOf('this.claimQuestTodo(item'), 'the main gate comes before a todo is claimed');
    });

    test('SN-5: Send Now restarts a sent item; the editor offers it', () => {
        const src = source('src', 'managers', 'promptQueueManager.ts');
        const start = src.indexOf('async sendNow(id: string)');
        const body = src.slice(start, src.indexOf('\n    }\n', start));
        assert.ok(body.includes('canSendNow(item.status)'));
        assert.ok(body.includes('resetItemRunState(item)'), 'a sent item is reset before it is sent again');
        const render = source('media', 'shared', 'queueEntryRenderFunctions.js');
        assert.match(render, /isSent[^\n]*onclick="sendNow\(/, 'a sent item has the Send Now button');
    });
});
