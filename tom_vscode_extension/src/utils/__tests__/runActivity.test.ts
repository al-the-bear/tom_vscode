/**
 * What each run of a window is doing (vscimpb123, src/utils/runActivity.ts).
 *
 *   RA-1 each state alone: waiting for user (an interaction, a decision-needed item), waiting for event, waiting on
 *        task, running (sending; pending with auto-send on), paused, idle
 *   RA-2 the most specific wins: user > event > task > running > paused > idle
 *   RA-3 only the run's own items and interactions count; process-move markers are no pending work
 *   RA-4 the heartbeat entry: run, process, position (only with a process), subject, current; every run of the quest
 *   RA-5 tomAi_getQuestWindowStatus answers the window's `runs` as written
 *   RA-6 the RUNS view's grouping: this window first, then alive, then by quest; gone after 90 s, dropped after 10
 *        minutes; other hosts and windows without a heartbeat left out
 */

import { describe, test } from 'node:test';
import assert from 'node:assert/strict';

import {
    GONE_WINDOW_SHOWN_MS, RUN_STATE_PRECEDENCE, runActivity, runActivityEntries, runsOverviewWindows,
    type RunActivityItem,
} from '../runActivity.js';
import { buildQuestWindowStatus, type WindowStateInput } from '../questWindowStatus.js';

const item = (id: string, status: string, extra: Partial<RunActivityItem> = {}): RunActivityItem =>
    ({ id, status, run: 'r1', originalText: `prompt ${id}`, ...extra });
const ask = { run: 'r1', title: 'Which option?' };
const WAIT = { reason: 'pub.dev limit', until: '14:20' };
const TASKS = { items: [{ id: 't1', description: 'npm test' }] };

describe('the run state', () => {
    test('RA-1: each state alone', () => {
        assert.deepEqual(runActivity('r1', [], [ask], false), { state: 'waiting for user', detail: 'Which option?', pending: 0 });
        assert.equal(runActivity('r1', [item('a', 'decision-needed')], [], false).state, 'waiting for user');
        assert.match(runActivity('r1', [item('a', 'decision-needed')], [], false).detail!, /^todo decisions: prompt a/);
        assert.deepEqual(runActivity('r1', [item('a', 'sending', { waitingFor: WAIT })], [], false), { state: 'waiting for event', detail: 'pub.dev limit (until 14:20)', pending: 0 });
        assert.deepEqual(runActivity('r1', [item('a', 'sending', { backgroundWait: TASKS })], [], false), { state: 'waiting on task', detail: 'npm test', pending: 0 });
        assert.deepEqual(runActivity('r1', [item('a', 'sending'), item('b', 'pending')], [], false), { state: 'running', detail: 'prompt a', pending: 1 });
        assert.deepEqual(runActivity('r1', [item('b', 'pending')], [], false), { state: 'running', detail: '1 pending, about to be sent', pending: 1 });
        assert.deepEqual(runActivity('r1', [item('b', 'pending'), item('c', 'pending')], [], true), { state: 'paused', detail: '2 pending', pending: 2 });
        assert.deepEqual(runActivity('r1', [item('d', 'sent'), item('e', 'staged')], [], false), { state: 'idle', pending: 0 });
    });

    test('RA-2: the most specific wins', () => {
        assert.deepEqual([...RUN_STATE_PRECEDENCE], ['waiting for user', 'waiting for event', 'waiting on task', 'running', 'paused', 'idle']);
        const all = [item('a', 'sending', { waitingFor: WAIT, backgroundWait: TASKS }), item('b', 'pending')];
        assert.equal(runActivity('r1', all, [ask], true).state, 'waiting for user');
        assert.equal(runActivity('r1', all, [], true).state, 'waiting for event');
        assert.equal(runActivity('r1', [item('a', 'sending', { backgroundWait: TASKS })], [], true).state, 'waiting on task');
        assert.equal(runActivity('r1', [item('a', 'sending')], [], true).state, 'running', 'a sending item of a paused run runs');
        const many = runActivity('r1', [], [ask, { run: 'r1', title: 'Approve?' }, { run: 'r1', title: 'Plan' }], false);
        assert.equal(many.detail, 'Which option?; Approve? (+1 more)');
    });

    test('RA-3: only the run\'s own items count', () => {
        const items = [item('a', 'sending', { run: 'r2' }), item('b', 'pending', { run: undefined, processRun: { run: 'r1' } }), item('m', 'pending', { processMove: { to: 'x' } })];
        assert.deepEqual(runActivity('r1', items, [{ run: 'r2', title: 'not mine' }], false), { state: 'running', detail: '1 pending, about to be sent', pending: 1 });
        assert.equal(runActivity('default', [item('x', 'sending', { run: undefined })], [], false).state, 'running', 'an item without a run is default\'s');
    });

    test('RA-4: the heartbeat entry', () => {
        const entries = runActivityEntries([
            { run: 'default', process: '', position: '', current: false },
            { run: 'r1', process: 'tom_specs', position: 'phase2 › step3', subject: 'the SBP', current: true },
        ], [item('a', 'sending')], [], ['default']);
        assert.deepEqual(entries, [
            { run: 'default', state: 'paused', detail: '0 pending', pending: 0 },
            { run: 'r1', process: 'tom_specs', position: 'phase2 › step3', subject: 'the SBP', current: true, state: 'running', detail: 'prompt a', pending: 0 },
        ]);
    });

    test('RA-5: tomAi_getQuestWindowStatus answers the runs', () => {
        const runs = runActivityEntries([{ run: 'r1', process: 'p', position: 's', current: true }], [], [ask], []);
        const state: WindowStateInput = { windowId: 'w1_m1', workspace: 'q', activeQuest: 'q', host: 'h', heartbeat: new Date(1000).toISOString(), runs };
        const answer = buildQuestWindowStatus({ states: [state], sessionsOf: () => [], config: undefined, noApiKey: new Set(), thisHost: 'h', thisMachine: 'm1', thisWindowId: 'w1_m1', nowMs: 2000 });
        assert.deepEqual(answer.windows[0].runs, runs);
        assert.equal(answer.windows[0].runs![0].state, 'waiting for user');
    });
});

describe('the RUNS view', () => {
    test('RA-6: windows grouped, gone ones shown then dropped', () => {
        const now = 100 * 60_000;
        const beat = (agoMs: number) => new Date(now - agoMs).toISOString();
        const runs = [{ run: 'default', state: 'idle' as const, pending: 0 }];
        const states = [
            { windowId: 'old_m1', activeQuest: 'a', heartbeat: beat(GONE_WINDOW_SHOWN_MS + 1000), runs },
            { windowId: 'gone_m1', activeQuest: 'a', heartbeat: beat(120_000), runs },
            { windowId: 'b_m1', activeQuest: 'b', heartbeat: beat(10_000), runs },
            { windowId: 'a_m1', activeQuest: 'a', heartbeat: beat(10_000), runs },
            { windowId: 'me_m1', activeQuest: 'z', heartbeat: beat(5_000), runs },
            { windowId: 'other_m2', activeQuest: 'a', heartbeat: beat(1_000), runs },
            { windowId: 'remote_m1', host: 'elsewhere', activeQuest: 'a', heartbeat: beat(1_000), runs },
            { windowId: 'nobeat_m1', activeQuest: 'a' },
        ];
        const windows = runsOverviewWindows(states, { nowMs: now, thisWindowId: 'me_m1', thisHost: 'here', thisMachine: 'm1', staleMs: 90_000 });
        assert.deepEqual(windows.map((w) => [w.windowId, w.quest, w.alive, w.isThisWindow]), [
            ['me_m1', 'z', true, true],
            ['a_m1', 'a', true, false],
            ['b_m1', 'b', true, false],
            ['gone_m1', 'a', false, false],
        ]);
        assert.equal(windows[3].heartbeatAgeSeconds, 120);
        assert.deepEqual(windows[0].runs, runs);
    });
});
