/**
 * The queue settings per run (utils/runQueueSettings.ts, vscimpb60a).
 *
 *   RS-1 an empty or missing file: the built-in settings, the `default` run only
 *   RS-2 the old shape (top-level keys): the `default` run's settings and the start values; ill-typed values ignored
 *   RS-3 `runs:` over the start values, per run; `default` always there; run names normalised
 *   RS-4 written back: `runs:` with the file keys, `default` first, unset optional values left out
 */

import test, { describe } from 'node:test';
import assert from 'node:assert/strict';

import { BUILTIN_RUN_QUEUE_SETTINGS, readRunQueueSettings, runQueueSettingsToFile } from '../runQueueSettings.js';

describe('queue settings per run', () => {
    test('RS-1: nothing stored', () => {
        for (const file of [undefined, null, {}]) {
            const r = readRunQueueSettings(file);
            assert.deepEqual(r.start, { ...BUILTIN_RUN_QUEUE_SETTINGS });
            assert.deepEqual([...r.runs.keys()], ['default']);
            assert.deepEqual(r.runs.get('default'), { ...BUILTIN_RUN_QUEUE_SETTINGS });
        }
    });

    test('RS-2: the old shape', () => {
        const r = readRunQueueSettings({
            'auto-send-enabled': false, 'auto-pause-enabled': false, 'response-timeout-minutes': 2, 'walk-continuations': -1,
            'default-transport': 'anthropic', 'default-anthropic-profile-id': 'p', 'default-message-template-id': '', 'default-reminder-template-id': 7,
        });
        assert.equal(r.start.autoSend, false);
        assert.equal(r.start.autoPause, false);
        assert.equal(r.start.responseTimeoutMinutes, 5, 'at least 5 minutes');
        assert.equal(r.start.walkContinuations, BUILTIN_RUN_QUEUE_SETTINGS.walkContinuations, 'an invalid count is ignored');
        assert.equal(r.start.defaultTransport, 'anthropic');
        assert.equal(r.start.defaultAnthropicProfileId, 'p');
        assert.equal(r.start.defaultMessageTemplateId, undefined, '"" is unset');
        assert.equal(r.start.defaultReminderTemplateId, undefined, 'a number is no template id');
        assert.deepEqual(r.runs.get('default'), r.start);
    });

    test('RS-3: runs over the start values', () => {
        const r = readRunQueueSettings({
            'default-transport': 'anthropic',
            runs: { collab: { 'auto-send-enabled': false, 'default-agent-sdk-session': 'idea' }, ' Other ': { 'default-transport': 'copilot' }, '': { 'auto-send-enabled': false } },
        });
        assert.deepEqual([...r.runs.keys()].sort(), ['Other', 'collab', 'default'], 'names trimmed, an empty one skipped');
        assert.equal(r.runs.get('collab')!.autoSend, false);
        assert.equal(r.runs.get('collab')!.defaultTransport, 'anthropic', 'from the start values');
        assert.equal(r.runs.get('collab')!.defaultAgentSdkSession, 'idea');
        assert.equal(r.runs.get('default')!.autoSend, true);
    });

    test('RS-4: written back', () => {
        const r = readRunQueueSettings({ runs: { zeta: { 'auto-pause-enabled': false }, alpha: {} } });
        const file = runQueueSettingsToFile(r.runs);
        assert.deepEqual(Object.keys(file), ['default', 'alpha', 'zeta']);
        assert.equal(file.zeta['auto-pause-enabled'], false);
        assert.equal('default-anthropic-profile-id' in file.default, false, 'unset optional values left out');
        assert.deepEqual(readRunQueueSettings({ runs: file }).runs.get('zeta'), r.runs.get('zeta'), 'read back the same');
    });
});
