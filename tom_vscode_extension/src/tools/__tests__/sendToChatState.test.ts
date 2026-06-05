/**
 * Tests for the interactive-Anthropic-send mutual-exclusion guard
 * (`src/handlers/sendToChatState.ts`).
 *
 * This guard encodes the spec rule that while one interactive Anthropic turn
 * is running (panel Send, Send-to-Chat, or the scripting bridge), a second is
 * **rejected** rather than queued. The three callers share this single flag,
 * so the contract worth pinning is: exactly one holder at a time, and the slot
 * frees on release.
 *
 * Lives under tools/__tests__ (rather than handlers/__tests__) because that is
 * the directory `npm test` globs; the guard module is dependency-free, so it
 * imports cleanly from here without the vscode stub.
 *
 * Run from the extension folder with:
 *   npm run compile && node --test out/tools/__tests__/sendToChatState.test.js
 */

import test, { describe, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

import {
    isAnthropicSendInFlight,
    tryBeginAnthropicSend,
    endAnthropicSend,
} from '../../handlers/sendToChatState.js';

describe('sendToChatState — interactive send guard', () => {
    beforeEach(() => {
        // The flag is module-level state; reset between tests.
        endAnthropicSend();
    });

    test('starts free', () => {
        assert.equal(isAnthropicSendInFlight(), false);
    });

    test('first claim succeeds and marks in-flight', () => {
        assert.equal(tryBeginAnthropicSend(), true);
        assert.equal(isAnthropicSendInFlight(), true);
    });

    test('second concurrent claim is rejected', () => {
        assert.equal(tryBeginAnthropicSend(), true);
        // A second caller (e.g. Send-to-Chat while the panel is sending) is
        // told the slot is taken — it must reject, not queue.
        assert.equal(tryBeginAnthropicSend(), false);
        assert.equal(isAnthropicSendInFlight(), true);
    });

    test('release frees the slot for the next caller', () => {
        assert.equal(tryBeginAnthropicSend(), true);
        endAnthropicSend();
        assert.equal(isAnthropicSendInFlight(), false);
        assert.equal(tryBeginAnthropicSend(), true);
    });

    test('release is idempotent', () => {
        endAnthropicSend();
        endAnthropicSend();
        assert.equal(isAnthropicSendInFlight(), false);
    });
});
