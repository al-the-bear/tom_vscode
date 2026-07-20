/**
 * Tests for PollClaimRegistry — the single-poller model that keeps Telegram's
 * getUpdates to one consumer per bot token (qr5).
 *
 * The bug this pins: within one extension host, both the standalone command
 * poller and the AI Conversation channel resolve the SAME per-quest bot token
 * and each try to poll. Telegram returns 409 Conflict to the superseded caller,
 * so the two pollers alternate success/409 and neither receives reliably. The
 * registry arbitrates: the first caller on a token owns the single poll loop;
 * every later caller must defer (send-only) until the owner releases it.
 */
import test, { describe } from 'node:test';
import assert from 'node:assert/strict';

import { PollClaimRegistry } from '../telegramPollClaim.js';

describe('PollClaimRegistry', () => {
    test('the first caller claims a token; a second caller on the same token is refused', () => {
        const registry = new PollClaimRegistry();
        // The standalone poller starts first — it owns the poll loop.
        assert.equal(registry.tryClaim('bot-token-A'), true);
        // The AI Conversation channel resolves the same token and would 409 —
        // it is refused, so it must defer (send-only).
        assert.equal(registry.tryClaim('bot-token-A'), false);
        assert.equal(registry.isClaimed('bot-token-A'), true);
    });

    test('distinct bot tokens are claimed independently (per-quest bots do not collide)', () => {
        const registry = new PollClaimRegistry();
        assert.equal(registry.tryClaim('bot-token-A'), true);
        assert.equal(registry.tryClaim('bot-token-B'), true);
        assert.equal(registry.isClaimed('bot-token-A'), true);
        assert.equal(registry.isClaimed('bot-token-B'), true);
    });

    test('releasing a token lets a deferred caller take it over', () => {
        const registry = new PollClaimRegistry();
        assert.equal(registry.tryClaim('bot-token-A'), true);
        assert.equal(registry.tryClaim('bot-token-A'), false);
        // Owner stops listening → releases the claim.
        registry.release('bot-token-A');
        assert.equal(registry.isClaimed('bot-token-A'), false);
        // The previously-deferred caller can now become the single poller.
        assert.equal(registry.tryClaim('bot-token-A'), true);
    });

    test('releasing an unclaimed token is a no-op (idempotent stop)', () => {
        const registry = new PollClaimRegistry();
        // stopListening runs release unconditionally-ish; releasing a token that
        // was never claimed must not throw or corrupt state.
        registry.release('never-claimed');
        assert.equal(registry.isClaimed('never-claimed'), false);
        // A subsequent claim still works.
        assert.equal(registry.tryClaim('never-claimed'), true);
    });

    test('a fresh registry claims nothing (no cross-instance leakage)', () => {
        const first = new PollClaimRegistry();
        first.tryClaim('bot-token-A');
        const second = new PollClaimRegistry();
        // Each host/registry arbitrates only its own tokens.
        assert.equal(second.isClaimed('bot-token-A'), false);
        assert.equal(second.tryClaim('bot-token-A'), true);
    });
});
