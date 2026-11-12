/**
 * The background-wait limit, the still-running hint and the waiting state as the queue file keeps it (vscimpb56).
 *
 *   BW-1 the limit: the queue item's, else the profile's, else 6 hours; 0 is a limit (no wait), not "unset"
 *   BW-2 the hint names the limit and what still ran, or that waiting is off
 *   BW-3 the waiting state round-trips through the queue file; a malformed one reads as none
 *   BW-4 limits as given: whole minutes, 0 or more
 */

/* eslint-disable @typescript-eslint/naming-convention -- the queue file's YAML keys */
import test, { describe } from 'node:test';
import assert from 'node:assert/strict';

import {
    DEFAULT_BACKGROUND_WAIT_LIMIT_MINUTES,
    backgroundWaitFromYaml,
    backgroundWaitToYaml,
    formatLimit,
    resolveBackgroundWaitLimitMinutes,
    stillRunningHint,
    validLimit,
    type BackgroundWaitState,
} from '../backgroundWait.js';

describe('background wait', () => {
    test('BW-1: the limit', () => {
        assert.equal(DEFAULT_BACKGROUND_WAIT_LIMIT_MINUTES, 360);
        assert.equal(resolveBackgroundWaitLimitMinutes(undefined, undefined), 360);
        assert.equal(resolveBackgroundWaitLimitMinutes(undefined, 90), 90, 'the profile');
        assert.equal(resolveBackgroundWaitLimitMinutes(30, 90), 30, 'the item wins');
        assert.equal(resolveBackgroundWaitLimitMinutes(0, 90), 0, 'an item\'s 0 is "do not wait"');
        assert.equal(resolveBackgroundWaitLimitMinutes(undefined, 0), 0);
        assert.equal(resolveBackgroundWaitLimitMinutes(-5, 'x'), 360, 'nonsense is unset');
    });

    test('BW-2: the hint', () => {
        const items = [
            { id: 'b1', kind: 'task' as const, description: 'Wait for the corpus run', command: 'until [ -f done ]; do sleep 30; done' },
            { id: 'proc_1', kind: 'command' as const, description: 'npm test', command: 'npm test' },
        ];
        const hint = stillRunningHint(items, 360);
        assert.match(hint, /^\n\n_\(2 background tasks were still running when this turn ended — the queue stopped waiting after 6 h \(the background-wait limit\)/);
        assert.match(hint, /Wait for the corpus run \[b1\] — `until \[ -f done \]; do sleep 30; done`; npm test \[proc_1\]\.\)_$/);
        assert.match(stillRunningHint([items[1]], 0), /1 background task was still running.*waiting for background work is off \(limit 0\); its result/);
        assert.equal(formatLimit(90), '1 h 30 min');
        assert.equal(formatLimit(45), '45 min');
        assert.equal(formatLimit(0.5), '30 s');
    });

    test('BW-3: the queue file', () => {
        const state: BackgroundWaitState = {
            since: '2026-11-12T18:00:00.000Z',
            limitMinutes: 360,
            items: [
                { id: 'b1', kind: 'task', description: 'suites', command: 'npm test', outputFile: '/tmp/b1.out' },
                { id: 'proc_2', kind: 'command', description: 'sleep 600', command: 'sleep 600' },
            ],
        };
        const yaml = backgroundWaitToYaml(state);
        assert.equal(yaml['limit-minutes'], 360);
        assert.deepEqual(backgroundWaitFromYaml(JSON.parse(JSON.stringify(yaml))), state);
        assert.equal(backgroundWaitFromYaml(undefined), undefined);
        assert.equal(backgroundWaitFromYaml({ since: 1, 'limit-minutes': 5, items: [] }), undefined);
        assert.equal(backgroundWaitFromYaml({ since: 'x', items: [] }), undefined);
    });

    test('BW-4: limits as given', () => {
        assert.equal(validLimit(30), 30);
        assert.equal(validLimit('45'), 45);
        assert.equal(validLimit(0), 0);
        assert.equal(validLimit(12.6), 13);
        assert.equal(validLimit(-1), undefined);
        assert.equal(validLimit(''), undefined);
        assert.equal(validLimit('abc'), undefined);
    });
});
