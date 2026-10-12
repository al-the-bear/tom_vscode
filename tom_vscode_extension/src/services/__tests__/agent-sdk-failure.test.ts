/**
 * Tests for the Agent SDK failure-cause module.
 *
 * When the Claude Code child process exits non-zero, the SDK throws
 * "Claude Code process exited with code 1" and nothing else. The real cause
 * arrived earlier in the stream: an assistant message carrying `error`
 * (e.g. `authentication_failed`) and the text "Failed to authenticate: OAuth
 * session expired …", or an `is_error` result, or a line on the CLI's stderr.
 *
 * Coverage (AF-*):
 *   AF-1  an assistant `error` + its text become the cause
 *   AF-2  an `is_error` result with an error subtype becomes the cause
 *   AF-3  an `auth_status` message with an error becomes an auth cause
 *   AF-4  ordinary assistant / success messages leave no cause
 *   AF-5  wrapping the exit error LEADS with the cause and keeps the exit text
 *   AF-6  wrapping without a cause falls back to the last stderr line, then to
 *         the original error unchanged
 *   AF-7  non-retryable vs busy classification
 *   AF-8  stderr capture is bounded (keeps the tail) and scrubbed
 *   AF-9  scrubSecrets redacts token-shaped strings and keeps prose
 *   AF-10 the wrapped error's stack starts with the cause-led message
 *   AF-11 non-retryable causes carry advice the user can act on
 *
 * The module imports neither `vscode` nor the SDK.
 */

import test, { describe } from 'node:test';
import assert from 'node:assert/strict';

import {
    FailureCauseCollector,
    AgentSdkFailureError,
    withFailureCause,
    isNonRetryableFailure,
    isBusyFailure,
    scrubSecrets,
    failureAdvice,
    STDERR_TAIL_LIMIT,
} from '../agent-sdk-failure.js';

// The fixtures below are SDK wire messages, whose fields are snake_case.
/* eslint-disable @typescript-eslint/naming-convention */

const EXIT = 'Claude Code process exited with code 1';
const OAUTH = 'Failed to authenticate: OAuth session expired and could not be refreshed';

function authAssistant(): unknown {
    return {
        type: 'assistant',
        error: 'authentication_failed',
        message: { content: [{ type: 'text', text: OAUTH }] },
    };
}

describe('FailureCauseCollector', () => {
    test('AF-1: an assistant error and its text become the cause', () => {
        const c = new FailureCauseCollector();
        c.observe(authAssistant());
        assert.deepEqual(c.cause, { kind: 'authentication_failed', detail: OAUTH });
    });

    test('AF-2: an is_error result with an error subtype becomes the cause', () => {
        const c = new FailureCauseCollector();
        c.observe({
            type: 'result',
            subtype: 'error_during_execution',
            is_error: true,
            errors: ['Tool runner crashed', 'second line'],
        });
        assert.deepEqual(c.cause, {
            kind: 'error_during_execution',
            detail: 'Tool runner crashed; second line',
        });
    });

    test('AF-2b: a success-subtype result with is_error uses its result text', () => {
        const c = new FailureCauseCollector();
        c.observe({ type: 'result', subtype: 'success', is_error: true, result: 'API Error: 400 bad request' });
        assert.deepEqual(c.cause, { kind: 'error_result', detail: 'API Error: 400 bad request' });
    });

    test('AF-2c: an assistant error wins over a later generic error result', () => {
        const c = new FailureCauseCollector();
        c.observe(authAssistant());
        c.observe({ type: 'result', subtype: 'success', is_error: true, result: OAUTH });
        assert.equal(c.cause?.kind, 'authentication_failed');
    });

    test('AF-3: an auth_status message with an error becomes an auth cause', () => {
        const c = new FailureCauseCollector();
        c.observe({ type: 'auth_status', isAuthenticating: false, output: [], error: 'token refresh failed' });
        assert.deepEqual(c.cause, { kind: 'authentication_failed', detail: 'token refresh failed' });
    });

    test('AF-4: ordinary messages leave no cause', () => {
        const c = new FailureCauseCollector();
        c.observe({ type: 'assistant', message: { content: [{ type: 'text', text: 'hello' }] } });
        c.observe({ type: 'result', subtype: 'success', is_error: false, result: 'hello' });
        c.observe({ type: 'system', subtype: 'init' });
        c.observe(null);
        assert.equal(c.cause, undefined);
    });

    test('AF-8: stderr capture keeps a bounded, scrubbed tail', () => {
        const c = new FailureCauseCollector();
        c.addStderr('x'.repeat(STDERR_TAIL_LIMIT * 2));
        c.addStderr('\nAuthorization: Bearer abcdefghijklmnopqrstuvwxyz0123456789\nfinal line\n');
        assert.ok(c.stderrTail.length <= STDERR_TAIL_LIMIT, `tail is ${c.stderrTail.length} chars`);
        assert.ok(c.stderrTail.endsWith('final line\n'));
        assert.ok(!c.stderrTail.includes('abcdefghijklmnopqrstuvwxyz0123456789'));
        assert.ok(c.stderrTail.includes('[redacted]'));
    });
});

describe('withFailureCause', () => {
    test('AF-5: the wrapped message leads with the cause and keeps the exit text', () => {
        const c = new FailureCauseCollector();
        c.observe(authAssistant());
        const wrapped = withFailureCause(new Error(EXIT), c) as Error;
        assert.ok(wrapped instanceof AgentSdkFailureError);
        assert.ok(
            wrapped.message.startsWith(`Agent SDK failed: authentication_failed — ${OAUTH}`),
            wrapped.message,
        );
        assert.ok(wrapped.message.includes(`(${EXIT})`), wrapped.message);
        assert.ok(wrapped.message.endsWith(failureAdvice('authentication_failed') ?? '<none>'), wrapped.message);
        assert.equal((wrapped as AgentSdkFailureError).failure.kind, 'authentication_failed');
        assert.equal((wrapped as AgentSdkFailureError).nonRetryable, true);
    });

    test('AF-6: no structured cause → last non-empty stderr line', () => {
        const c = new FailureCauseCollector();
        c.addStderr('starting\nError: could not read settings file\n\n');
        const wrapped = withFailureCause(new Error(EXIT), c) as Error;
        assert.ok(wrapped.message.startsWith('Agent SDK failed: Error: could not read settings file'), wrapped.message);
        assert.ok(wrapped.message.includes(`(${EXIT})`));
        assert.equal((wrapped as AgentSdkFailureError).nonRetryable, false);
    });

    test('AF-6b: no cause and no stderr → the original error unchanged', () => {
        const original = new Error(EXIT);
        assert.equal(withFailureCause(original, new FailureCauseCollector()), original);
    });

    test('AF-6c: a cancelled attempt is never rewrapped', () => {
        const c = new FailureCauseCollector();
        c.observe(authAssistant());
        const original = new Error('Cancelled');
        assert.equal(withFailureCause(original, c, { cancelled: true }), original);
    });

    test('AF-10: the stack starts with the cause-led message', () => {
        const c = new FailureCauseCollector();
        c.observe(authAssistant());
        const wrapped = withFailureCause(new Error(EXIT), c) as Error;
        assert.ok(wrapped.stack?.startsWith(`AgentSdkFailureError: ${wrapped.message}`), wrapped.stack);
        assert.ok(wrapped.stack?.includes(EXIT));
    });
});

describe('classification', () => {
    test('AF-7: auth, billing and invalid requests are non-retryable', () => {
        for (const kind of ['authentication_failed', 'billing_error', 'invalid_request', 'oauth_org_not_allowed',
            'account_on_hold', 'verification_required', 'model_not_found', 'cloud_credential_error']) {
            assert.equal(isNonRetryableFailure({ kind, detail: '' }), true, kind);
            assert.equal(isBusyFailure({ kind, detail: '' }), false, kind);
        }
    });

    test('AF-7b: rate_limit, overloaded and server_error are busy, not non-retryable', () => {
        for (const kind of ['rate_limit', 'overloaded', 'server_error']) {
            assert.equal(isBusyFailure({ kind, detail: '' }), true, kind);
            assert.equal(isNonRetryableFailure({ kind, detail: '' }), false, kind);
        }
    });

    test('AF-7c: unknown and execution errors are neither', () => {
        for (const kind of ['unknown', 'error_during_execution', 'error_result', 'stderr']) {
            assert.equal(isNonRetryableFailure({ kind, detail: '' }), false, kind);
            assert.equal(isBusyFailure({ kind, detail: '' }), false, kind);
        }
        assert.equal(isNonRetryableFailure(undefined), false);
        assert.equal(isBusyFailure(undefined), false);
    });

    test('AF-11: non-retryable causes carry advice; others none', () => {
        assert.match(failureAdvice('authentication_failed') ?? '', /sign in again/i);
        assert.match(failureAdvice('billing_error') ?? '', /billing|credit/i);
        assert.ok(failureAdvice('invalid_request'));
        assert.equal(failureAdvice('overloaded'), undefined);
    });
});

describe('scrubSecrets', () => {
    test('AF-9: token-shaped strings are redacted, prose kept', () => {
        const raw = [
            'key sk-ant-oat01-AbCdEfGhIjKlMnOpQrStUvWxYz0123456789',
            'gh ghp_1234567890abcdefghijABCDEFGHIJ123456',
            'pat github_pat_11ABCDEFG0123456789_abcdefghijklmnopqrstuvwxyz',
            'Authorization: Bearer eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxIn0.abcdefghijklmnop',
            'refresh_token=0123456789abcdef0123456789abcdef',
            'Failed to authenticate: OAuth session expired and could not be refreshed',
        ].join('\n');
        const out = scrubSecrets(raw);
        assert.ok(!out.includes('AbCdEfGhIjKlMnOpQrStUvWxYz0123456789'), out);
        assert.ok(!out.includes('ghp_1234567890'), out);
        assert.ok(!out.includes('github_pat_11ABCDEFG'), out);
        assert.ok(!out.includes('eyJhbGciOiJIUzI1NiJ9'), out);
        assert.ok(!out.includes('0123456789abcdef0123456789abcdef'), out);
        assert.ok(out.includes('Failed to authenticate: OAuth session expired and could not be refreshed'), out);
    });
});
