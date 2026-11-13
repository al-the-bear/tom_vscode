/**
 * tomAi_waitFor's rules (src/utils/waitFor.ts), its registry (src/services/waitForRegistry.ts) and the tool
 * (src/tools/wait-for-tool.ts) — vscimpb82.
 *
 *   WF-1 the end of a wait: `minutes`, an ISO instant, `HH:MM` today or tomorrow; refused: nothing given, a past or
 *        unreadable time, minutes not above 0, more than 48 h; `reason` required (its first line), `details` kept
 *   WF-2 the labels: `until 14:20 (1 h 5 min left)`, a weekday when not today, the item's line
 *   WF-3 the queue file's `waiting-for` round trip; something else reads as no wait
 *   WF-4 the registry: a wait ends by itself at its time, by the interrupt or by a cancel (each once), belongs to
 *        the queue item it ran in, is told to listeners on begin and end, and is cancelled when the send that
 *        opened it ends (askOwners)
 *   (the tool itself: src/tools/__tests__/wait-for-tool.test.ts)
 *   WF-6 Continue's choices and words on a waiting item (pendingQuestion.ts)
 */

import test, { describe } from 'node:test';
import assert from 'node:assert/strict';

import {
    clockLabel,
    durationLabel,
    MAX_WAIT_MINUTES,
    waitEnd,
    waitForFromYaml,
    waitForLine,
    waitForState,
    waitForToYaml,
    waitForUntilLabel,
    type WaitForState,
} from '../waitFor';
import { WaitForRegistry, type WaitForTimers } from '../../services/waitForRegistry';
import { runAsAskOwner } from '../../services/askOwners';
import { runAsQueueItem } from '../../services/userWaits';
import { continueOptions, continuePrompt } from '../pendingQuestion';

const NOW = new Date(2026, 10, 13, 12, 0, 0).getTime(); // Fri 2026-11-13 12:00 local

describe('tomAi_waitFor rules', () => {
    test('WF-1: the end of a wait', () => {
        assert.deepEqual(waitEnd({ minutes: 30 }, NOW), { at: NOW + 30 * 60_000 });
        assert.deepEqual(waitEnd({ minutes: '5' }, NOW), { at: NOW + 5 * 60_000 });
        const iso = new Date(NOW + 2 * 3600_000).toISOString();
        assert.deepEqual(waitEnd({ until: iso }, NOW), { at: NOW + 2 * 3600_000 });
        assert.deepEqual(waitEnd({ until: '14:20' }, NOW), { at: new Date(2026, 10, 13, 14, 20).getTime() }, 'today');
        assert.deepEqual(waitEnd({ until: '09:00' }, NOW), { at: new Date(2026, 10, 14, 9, 0).getTime() }, 'passed: tomorrow');
        for (const bad of [{}, { minutes: 0 }, { minutes: -3 }, { until: 'soon' }, { until: '25:00' }, { until: new Date(NOW - 1000).toISOString() }, { minutes: MAX_WAIT_MINUTES + 1 }]) {
            assert.ok('error' in waitEnd(bad, NOW), JSON.stringify(bad));
        }
        assert.ok('error' in waitForState({ minutes: 5 }, NOW), 'reason required');
        assert.ok('error' in waitForState({ reason: '  ', minutes: 5 }, NOW));
        const ok = waitForState({ reason: 'pub.dev limit\nmore text', minutes: 65, details: ' the 12th ' }, NOW);
        assert.ok('state' in ok);
        assert.deepEqual(ok.state, { reason: 'pub.dev limit', details: 'the 12th', since: new Date(NOW).toISOString(), until: new Date(NOW + 65 * 60_000).toISOString() });
    });

    test('WF-2: the labels', () => {
        const state: WaitForState = { reason: 'pub.dev limit', since: new Date(NOW).toISOString(), until: new Date(NOW + 65 * 60_000).toISOString() };
        assert.equal(waitForUntilLabel(state, NOW), 'until 13:05 (1 h 5 min left)');
        assert.equal(waitForLine(state, NOW), 'pub.dev limit — until 13:05 (1 h 5 min left)');
        assert.equal(clockLabel(new Date(2026, 10, 14, 9, 30).getTime(), NOW), 'Sat 09:30');
        assert.deepEqual([durationLabel(30_000), durationLabel(12 * 60_000), durationLabel(120 * 60_000)], ['under a minute', '12 min', '2 h']);
    });

    test('WF-3: the queue file', () => {
        const state: WaitForState = { reason: 'r', details: 'd', since: '2026-11-13T11:00:00.000Z', until: '2026-11-13T12:00:00.000Z' };
        assert.deepEqual(waitForFromYaml(waitForToYaml(state)), state);
        const plain: WaitForState = { reason: 'r', since: 's', until: 'u' };
        assert.deepEqual(waitForFromYaml(waitForToYaml(plain)), plain);
        assert.equal(waitForFromYaml({ reason: 'r' }), undefined);
        assert.equal(waitForFromYaml('x'), undefined);
    });
});

/** Fake timers: `advance` runs what is due. */
function fakeTimers(): WaitForTimers & { advance(ms: number): void } {
    let now = NOW;
    const due: Array<{ at: number; fn: () => void; id: number }> = [];
    let next = 1;
    return {
        now: () => now,
        setTimeout: (fn, ms) => { const id = next++; due.push({ at: now + ms, fn, id }); return id; },
        clearTimeout: (h) => { const i = due.findIndex((d) => d.id === h); if (i >= 0) { due.splice(i, 1); } },
        advance(ms: number) {
            now += ms;
            for (const d of [...due].sort((a, b) => a.at - b.at)) {
                if (d.at <= now && due.includes(d)) { due.splice(due.indexOf(d), 1); d.fn(); }
            }
        },
    };
}
const STATE = (minutes: number, from = NOW): WaitForState => ({ reason: 'pub.dev limit', since: new Date(from).toISOString(), until: new Date(from + minutes * 60_000).toISOString() });

describe('the waits', () => {
    test('WF-4: the registry', async () => {
        const timers = fakeTimers();
        const reg = new WaitForRegistry(timers);
        const events: string[] = [];
        reg.onChange((w, phase, outcome) => events.push(`${w.queueItemId ?? '-'}:${phase}${outcome ? ':' + outcome : ''}`));
        const elapsed = reg.wait(STATE(10, timers.now()), 'q1');
        assert.equal(reg.waitOf('q1')?.state.reason, 'pub.dev limit');
        timers.advance(9 * 60_000);
        assert.ok(reg.waitOf('q1'), 'not yet');
        timers.advance(60_000);
        assert.equal(await elapsed, 'elapsed');
        assert.equal(reg.waitOf('q1'), undefined);
        const interrupted = reg.wait(STATE(10, timers.now()), 'q2');
        assert.equal(reg.interrupt('q2'), true);
        assert.equal(reg.interrupt('q2'), false, 'once');
        assert.equal(await interrupted, 'interrupted');
        const cancelled = reg.wait(STATE(10, timers.now()), 'q3');
        assert.equal(reg.cancelForQueueItem('q3'), true);
        assert.equal(await cancelled, 'cancelled');
        timers.advance(60 * 60_000); // a cleared timer does not fire again
        assert.deepEqual(events, ['q1:begin', 'q1:end:elapsed', 'q2:begin', 'q2:end:interrupted', 'q3:begin', 'q3:end:cancelled']);
        // The queue item it ran in, without naming it.
        const inItem = runAsQueueItem('q4', () => reg.wait(STATE(10, timers.now())));
        assert.ok(reg.waitOf('q4'));
        reg.interrupt('q4');
        assert.equal(await inItem, 'interrupted');
        // A chat send's wait: no item; the send ending cancels it.
        let chat: Promise<string> | undefined;
        await runAsAskOwner(async () => { chat = reg.wait(STATE(10, timers.now())); });
        assert.equal(await chat, 'cancelled', 'the send that opened it ended');
        assert.deepEqual(reg.waitsOutsideQueue(), []);
    });

    test('WF-6: Continue on a waiting item', () => {
        const options = continueOptions({ waitingForAnswer: false, canResend: true, walk: false, waitingFor: true });
        assert.deepEqual(options.map((o) => o.label), ['Keep waiting', 'Interrupt the wait and move on', 'Resend this stage', 'Skip to the next stage']);
        assert.deepEqual(options.slice(0, 2).map((o) => o.action), ['keepWaitingFor', 'interruptWaitFor']);
        const text = continuePrompt({ walk: false, waitingFor: 'pub.dev limit — until 13:05 (1 h 5 min left)' });
        assert.equal(text.message, 'This item\'s turn is waiting: pub.dev limit — until 13:05 (1 h 5 min left).');
        assert.match(text.detail, /steps back behind the next item of its run/);
        assert.equal(continueOptions({ waitingForAnswer: false, canResend: true, walk: false }).some((o) => o.action === 'interruptWaitFor'), false);
    });
});
