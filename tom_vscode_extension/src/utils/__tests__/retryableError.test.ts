/**
 * Tests for the shared transient-error classifier (`isRetryableBusyError`).
 *
 * This guards the retryable set used by BOTH retry paths:
 *   - the time-budget loop (`withRetryBudget`, direct + Local LLM transports), and
 *   - the Agent SDK transport retry loop.
 *
 * The notable contract: HTTP 429 / 500 / 503 / 529 are all transient and
 * retryable — including 500 ("Internal server error"), which the user hits on
 * the queue path and which must NOT be treated as fatal. Both the raw Anthropic
 * SDK shape (numeric `.status`) and the Claude Agent SDK shape
 * (`API Error: <code> { ... }` in the message) are recognised.
 *
 * The module imports neither `vscode` nor any SDK, so it loads directly under
 * `node --test`.
 */

import test, { describe } from 'node:test';
import assert from 'node:assert/strict';

import { isRetryableBusyError } from '../retryableError.js';

describe('isRetryableBusyError — numeric status', () => {
    for (const status of [429, 500, 503, 529]) {
        test(`retries on HTTP ${status}`, () => {
            assert.equal(isRetryableBusyError({ status }), true);
        });
    }

    test('does NOT retry on a non-transient status (400 / 401 / 404)', () => {
        assert.equal(isRetryableBusyError({ status: 400 }), false);
        assert.equal(isRetryableBusyError({ status: 401 }), false);
        assert.equal(isRetryableBusyError({ status: 404 }), false);
    });
});

describe('isRetryableBusyError — Agent SDK message shape', () => {
    test('retries on a 529 overloaded "API Error" string (no numeric status)', () => {
        const msg =
            'API Error: 529 {"type":"error","error":{"type":"overloaded_error",' +
            '"message":"Overloaded"},"request_id":"req_x"} · check status.claude.com';
        assert.equal(isRetryableBusyError(new Error(msg)), true);
    });

    test('retries on a 500 internal-server-error "API Error" string', () => {
        const msg =
            'API Error: 500 {"type":"error","error":{"type":"api_error",' +
            '"message":"Internal server error"},"request_id":"req_y"} · check status.claude.com';
        assert.equal(isRetryableBusyError(new Error(msg)), true);
    });

    test('retries when only the body text says "Internal server error"', () => {
        assert.equal(isRetryableBusyError(new Error('boom: Internal server error')), true);
    });
});

describe('isRetryableBusyError — textual signals (HTTP-prefixed + phrases)', () => {
    test('retries on HTTP 500 / 503 / 529 textual forms', () => {
        assert.equal(isRetryableBusyError(new Error('HTTP 500 from backend')), true);
        assert.equal(isRetryableBusyError(new Error('HTTP 503 service down')), true);
        assert.equal(isRetryableBusyError(new Error('HTTP 529 overloaded')), true);
    });

    test('retries on rate-limit / overloaded / service-unavailable / server-busy / too-many-requests', () => {
        assert.equal(isRetryableBusyError(new Error('rate limit exceeded')), true);
        assert.equal(isRetryableBusyError(new Error('the model is Overloaded')), true);
        assert.equal(isRetryableBusyError(new Error('503 Service Unavailable')), true);
        assert.equal(isRetryableBusyError(new Error('server busy, try later')), true);
        assert.equal(isRetryableBusyError(new Error('Too Many Requests')), true);
    });
});

describe('isRetryableBusyError — non-transient / edge cases', () => {
    test('returns false for null / undefined', () => {
        assert.equal(isRetryableBusyError(null), false);
        assert.equal(isRetryableBusyError(undefined), false);
    });

    test('returns false for an ordinary error (auth / not found / bad request)', () => {
        assert.equal(isRetryableBusyError(new Error('401 Unauthorized')), false);
        assert.equal(isRetryableBusyError(new Error('model not found')), false);
        assert.equal(isRetryableBusyError(new Error('invalid_request_error: bad field')), false);
    });

    test('does not match an incidental "500" that is not a status code', () => {
        assert.equal(isRetryableBusyError(new Error('processed 500 items successfully')), false);
    });
});
