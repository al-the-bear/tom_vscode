/**
 * The queue settings per run (utils/runQueueSettings.ts, vscimpb60a).
 *
 *   RS-1 an empty or missing file: the built-in settings, the `default` run only
 *   RS-2 the old shape (top-level keys): the `default` run's settings and the start values; ill-typed values ignored
 *   RS-3 `runs:` over the start values, per run; `default` always there; run names normalised
 *   RS-4 written back: `runs:` with the file keys, `default` first, each entry complete (an unset optional value is
 *        `""`), so a later top-level value does not reach a run with settings of its own; the transport (always
 *        `anthropic`) is not written
 *   RS-5 Make default (vscimpb60g): the shown settings (every per-run setting but the walk continuations) of a run
 *        over the start values; the fields that differ (unset equals `""`)
 */

import test, { describe } from 'node:test';
import assert from 'node:assert/strict';

import { BUILTIN_RUN_QUEUE_SETTINGS, DEFAULT_SETTING_FIELDS, defaultSettingsDiff, readRunQueueSettings, runQueueSettingsToFile, runQueueSettingsToKeys, startWithDefaultsFrom } from '../runQueueSettings.js';

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
            'auto-send-enabled': false, 'auto-pause-enabled': false, 'walk-continuations': -1,
            'default-anthropic-profile-id': 'p', 'default-message-template-id': '',
        });
        assert.equal(r.start.autoSend, false);
        assert.equal(r.start.autoPause, false);
        assert.equal(r.start.walkContinuations, BUILTIN_RUN_QUEUE_SETTINGS.walkContinuations, 'an invalid count is ignored');
        assert.equal(r.start.defaultTransport, 'anthropic', 'the one transport');
        assert.equal(r.start.defaultAnthropicProfileId, 'p');
        assert.equal(r.start.defaultMessageTemplateId, undefined, '"" is unset');
        assert.deepEqual(r.runs.get('default'), r.start);
    });

    test('RS-3: runs over the start values', () => {
        const r = readRunQueueSettings({
            'auto-pause-enabled': false,
            runs: { collab: { 'auto-send-enabled': false, 'default-agent-sdk-session': 'idea' }, ' Other ': { 'auto-pause-enabled': true }, '': { 'auto-send-enabled': false } },
        });
        assert.deepEqual([...r.runs.keys()].sort(), ['Other', 'collab', 'default'], 'names trimmed, an empty one skipped');
        assert.equal(r.runs.get('collab')!.autoSend, false);
        assert.equal(r.runs.get('collab')!.autoPause, false, 'from the start values');
        assert.equal(r.runs.get('Other')!.autoPause, true);
        assert.equal(r.runs.get('collab')!.defaultAgentSdkSession, 'idea');
        assert.equal(r.runs.get('default')!.autoSend, true);
    });

    test('RS-4: written back', () => {
        const r = readRunQueueSettings({ runs: { zeta: { 'auto-pause-enabled': false }, alpha: {} } });
        const file = runQueueSettingsToFile(r.runs);
        assert.deepEqual(Object.keys(file), ['default', 'alpha', 'zeta']);
        assert.equal(file.zeta['auto-pause-enabled'], false);
        assert.equal(file.default['default-anthropic-profile-id'], '', 'an unset optional value is written as ""');
        assert.equal('default-transport' in file.default, false, 'the transport (always anthropic) is not written');
        assert.deepEqual(readRunQueueSettings({ runs: file }).runs.get('zeta'), r.runs.get('zeta'), 'read back the same');
        const later = readRunQueueSettings({ 'default-anthropic-profile-id': 'pTop', runs: file });
        assert.equal(later.runs.get('zeta')!.defaultAnthropicProfileId, undefined, 'a later top-level value does not reach a run with its own entry');
        assert.equal(later.start.defaultAnthropicProfileId, 'pTop');
    });

    test('RS-5: Make default', () => {
        assert.deepEqual([...DEFAULT_SETTING_FIELDS].sort(), [
            'autoContinue', 'autoPause', 'autoSend', 'autoStart', 'defaultAgentSdkSession', 'defaultAnthropicConfigId', 'defaultAnthropicProfileId',
            'defaultMessageTemplateId', 'defaultRole',
        ], 'every per-run setting a tab shows, not the walk continuations');
        const start = { ...BUILTIN_RUN_QUEUE_SETTINGS, defaultMessageTemplateId: 'tOld', walkContinuations: 3 };
        const from = { ...BUILTIN_RUN_QUEUE_SETTINGS, autoSend: false, defaultTransport: 'anthropic' as const, defaultAnthropicProfileId: 'p', walkContinuations: 0 };
        assert.deepEqual(defaultSettingsDiff(from, start).sort(), ['autoSend', 'defaultAnthropicProfileId', 'defaultMessageTemplateId']);
        const next = startWithDefaultsFrom(start, from);
        assert.equal(next.walkContinuations, 3, 'the walk continuations stay');
        assert.equal(next.defaultMessageTemplateId, undefined, 'an unset template is taken unset');
        assert.deepEqual(defaultSettingsDiff(from, next), []);
        assert.deepEqual(defaultSettingsDiff({ ...from, defaultAnthropicConfigId: '' }, next), [], 'unset equals ""');
        const keys = runQueueSettingsToKeys(next, DEFAULT_SETTING_FIELDS);
        assert.equal('walk-continuations' in keys, false);
        assert.equal(keys['default-message-template-id'], '');
        assert.deepEqual(readRunQueueSettings(keys).start, { ...next, walkContinuations: BUILTIN_RUN_QUEUE_SETTINGS.walkContinuations }, 'read back as the start values');
    });
});
