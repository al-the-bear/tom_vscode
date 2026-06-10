/**
 * Tests for `getQuestRefreshSettings` — the pure resolver that reads the GLOBAL
 * half of the Quest Refresh feature (interval + prompt text per panel) from a
 * possibly-partial / absent `questRefresh` config block.
 *
 * The per-quest half (active flag + counter) lives in QuestRefreshStore, not
 * here. This resolver is the single place the global defaults + coercions live,
 * so the Status-Page section, the store's `getInterval`/`getRefreshPrompt`, and
 * the send-path hooks all read one source of truth.
 *
 * `vscode` is stubbed before importing sendToChatConfig (which requires it),
 * mirroring the mcpServerSettings test seam.
 */

import test, { describe } from 'node:test';
import assert from 'node:assert/strict';

import { installVscodeStub } from '../../tools/__tests__/_vscode-stub.js';
installVscodeStub({});

import { getQuestRefreshSettings } from '../sendToChatConfig.js';
import type { SendToChatConfig, QuestRefreshPanel } from '../sendToChatConfig.js';

const cfgWith = (questRefresh: unknown): SendToChatConfig =>
    ({ questRefresh } as unknown as SendToChatConfig);

const PANELS: QuestRefreshPanel[] = ['anthropic', 'localLlm', 'copilot'];

describe('getQuestRefreshSettings — defaults', () => {
    const expectedDefaults = { promptInterval: 0, refreshPrompt: '' };

    test('null config → interval 0, empty prompt for every panel', () => {
        for (const panel of PANELS) {
            assert.deepEqual(getQuestRefreshSettings(null, panel), expectedDefaults);
        }
    });

    test('undefined config → defaults', () => {
        assert.deepEqual(getQuestRefreshSettings(undefined, 'anthropic'), expectedDefaults);
    });

    test('missing questRefresh block → defaults', () => {
        assert.deepEqual(getQuestRefreshSettings({} as SendToChatConfig, 'anthropic'), expectedDefaults);
    });

    test('missing panel within the block → defaults', () => {
        assert.deepEqual(
            getQuestRefreshSettings(cfgWith({ anthropic: { promptInterval: 5, refreshPrompt: 'x' } }), 'localLlm'),
            expectedDefaults,
        );
    });
});

describe('getQuestRefreshSettings — overrides honoured', () => {
    test('interval + prompt are read from config when present', () => {
        const cfg = cfgWith({
            anthropic: { promptInterval: 10, refreshPrompt: 'refresh me' },
            localLlm: { promptInterval: 3, refreshPrompt: 'llm refresh' },
        });
        assert.deepEqual(getQuestRefreshSettings(cfg, 'anthropic'), {
            promptInterval: 10,
            refreshPrompt: 'refresh me',
        });
        assert.deepEqual(getQuestRefreshSettings(cfg, 'localLlm'), {
            promptInterval: 3,
            refreshPrompt: 'llm refresh',
        });
    });
});

describe('getQuestRefreshSettings — sane fallbacks for bad values', () => {
    test('non-positive interval falls back to 0 (never)', () => {
        assert.equal(getQuestRefreshSettings(cfgWith({ anthropic: { promptInterval: 0 } }), 'anthropic').promptInterval, 0);
        assert.equal(getQuestRefreshSettings(cfgWith({ anthropic: { promptInterval: -4 } }), 'anthropic').promptInterval, 0);
    });

    test('non-number interval falls back to 0', () => {
        assert.equal(
            getQuestRefreshSettings(cfgWith({ anthropic: { promptInterval: 'nope' } }), 'anthropic').promptInterval,
            0,
        );
    });

    test('fractional interval is floored', () => {
        assert.equal(
            getQuestRefreshSettings(cfgWith({ anthropic: { promptInterval: 7.9 } }), 'anthropic').promptInterval,
            7,
        );
    });

    test('non-string refreshPrompt falls back to empty', () => {
        assert.equal(
            getQuestRefreshSettings(cfgWith({ anthropic: { refreshPrompt: 123 } }), 'anthropic').refreshPrompt,
            '',
        );
    });
});
