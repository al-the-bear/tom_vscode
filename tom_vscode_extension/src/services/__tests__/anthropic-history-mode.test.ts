/**
 * Tests for `resolveEffectiveHistoryMode`.
 *
 * Regression guard for the chat-panel session bug: an `agentSdk`
 * configuration that omits `historyMode` must default to `sdk-managed`
 * so the SDK session id is persisted (and the chat panel's
 * `chat.session.json` actually appears). Every other transport — and an
 * explicit value on any transport — keeps its existing behaviour.
 */

import test, { describe } from 'node:test';
import assert from 'node:assert/strict';

import { resolveEffectiveHistoryMode } from '../anthropicPayload.js';

describe('resolveEffectiveHistoryMode', () => {
    test('agentSdk with no historyMode defaults to sdk-managed', () => {
        assert.equal(resolveEffectiveHistoryMode(undefined, 'agentSdk'), 'sdk-managed');
    });

    test('agentSdk with unrecognised historyMode defaults to sdk-managed', () => {
        assert.equal(resolveEffectiveHistoryMode('bogus', 'agentSdk'), 'sdk-managed');
    });

    test('direct with no historyMode defaults to trim_and_summary', () => {
        assert.equal(resolveEffectiveHistoryMode(undefined, 'direct'), 'trim_and_summary');
    });

    test('vscodeLm and localLlm default to trim_and_summary', () => {
        assert.equal(resolveEffectiveHistoryMode(undefined, 'vscodeLm'), 'trim_and_summary');
        assert.equal(resolveEffectiveHistoryMode(undefined, 'localLlm'), 'trim_and_summary');
    });

    test('explicit recognised value always wins over the transport fallback', () => {
        // An agentSdk config can still opt out of SDK continuity.
        assert.equal(resolveEffectiveHistoryMode('trim_and_summary', 'agentSdk'), 'trim_and_summary');
        // A direct config can still request sdk-managed.
        assert.equal(resolveEffectiveHistoryMode('sdk-managed', 'direct'), 'sdk-managed');
        for (const mode of ['full', 'summary', 'llm_extract'] as const) {
            assert.equal(resolveEffectiveHistoryMode(mode, 'agentSdk'), mode);
            assert.equal(resolveEffectiveHistoryMode(mode, 'direct'), mode);
        }
    });
});
