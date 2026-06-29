/**
 * Tests for the pure Agent SDK retry-decision logic
 * (spec: anthropic_sdk_integration.md §18, "Anthropic Transport Retry").
 *
 * Coverage:
 *   - isUnknownSessionError: matches "no session" / "unknown session"
 *     (case-insensitive), rejects unrelated errors.
 *   - planAgentSdkRetry give-up: on cancellation, and when attempts exhausted.
 *   - planAgentSdkRetry retry-fresh: when no session id known, and on an
 *     unknown/no-session error even though a session id was captured.
 *   - planAgentSdkRetry retry-resume: with the captured session id, preferring
 *     capturedSessionId over resumeSessionId.
 *
 * The module under test imports neither `vscode` nor the Agent SDK, so it
 * loads directly under `node --test` without a stub.
 */

import test, { describe } from 'node:test';
import assert from 'node:assert/strict';

import {
    isUnknownSessionError,
    planAgentSdkRetry,
    computeBackoffMs,
    DEFAULT_TRANSPORT_RETRY_TEMPLATE,
    selectTransportRetryTemplateBody,
} from '../agent-sdk-retry.js';

describe('isUnknownSessionError', () => {
    test('matches "no session"', () => {
        assert.equal(isUnknownSessionError('Error: no session found'), true);
    });

    test('matches "unknown session" (e.g. "unknown session id")', () => {
        assert.equal(isUnknownSessionError('Unknown session id: abc123'), true);
    });

    test('is case-insensitive', () => {
        assert.equal(isUnknownSessionError('NO SESSION'), true);
        assert.equal(isUnknownSessionError('Unknown Session ID'), true);
    });

    test('rejects unrelated error text', () => {
        assert.equal(isUnknownSessionError('rate limit exceeded'), false);
        assert.equal(isUnknownSessionError('network timeout'), false);
        assert.equal(isUnknownSessionError(''), false);
    });
});

describe('planAgentSdkRetry — give up', () => {
    test('gives up when cancellation was requested', () => {
        const plan = planAgentSdkRetry({
            attemptsMade: 1,
            maxAttempts: 3,
            errorMessage: 'boom',
            capturedSessionId: 'sess-1',
            cancelled: true,
        });
        assert.deepEqual(plan, { kind: 'give-up' });
    });

    test('gives up when attemptsMade >= maxAttempts', () => {
        const plan = planAgentSdkRetry({
            attemptsMade: 3,
            maxAttempts: 3,
            errorMessage: 'boom',
            capturedSessionId: 'sess-1',
        });
        assert.deepEqual(plan, { kind: 'give-up' });
    });

    test('cancellation takes precedence over an otherwise-retryable state', () => {
        const plan = planAgentSdkRetry({
            attemptsMade: 1,
            maxAttempts: 5,
            errorMessage: 'transient',
            resumeSessionId: 'sess-r',
            capturedSessionId: 'sess-c',
            cancelled: true,
        });
        assert.deepEqual(plan, { kind: 'give-up' });
    });
});

describe('planAgentSdkRetry — fresh session', () => {
    test('retries fresh when no session id is known', () => {
        const plan = planAgentSdkRetry({
            attemptsMade: 1,
            maxAttempts: 3,
            errorMessage: 'transient failure',
        });
        assert.deepEqual(plan, { kind: 'retry-fresh' });
    });

    test('retries fresh on a "no session" error even with a captured id', () => {
        const plan = planAgentSdkRetry({
            attemptsMade: 1,
            maxAttempts: 3,
            errorMessage: 'no session found for that id',
            capturedSessionId: 'sess-1',
            resumeSessionId: 'sess-0',
        });
        assert.deepEqual(plan, { kind: 'retry-fresh' });
    });

    test('retries fresh on an "unknown session id" error even with a resume id', () => {
        const plan = planAgentSdkRetry({
            attemptsMade: 1,
            maxAttempts: 3,
            errorMessage: 'Unknown session id: sess-0',
            resumeSessionId: 'sess-0',
        });
        assert.deepEqual(plan, { kind: 'retry-fresh' });
    });
});

describe('planAgentSdkRetry — resume session', () => {
    test('resumes with the captured session id', () => {
        const plan = planAgentSdkRetry({
            attemptsMade: 1,
            maxAttempts: 3,
            errorMessage: 'transient failure',
            capturedSessionId: 'sess-captured',
        });
        assert.deepEqual(plan, { kind: 'retry-resume', sessionId: 'sess-captured' });
    });

    test('prefers capturedSessionId over resumeSessionId', () => {
        const plan = planAgentSdkRetry({
            attemptsMade: 1,
            maxAttempts: 3,
            errorMessage: 'transient failure',
            resumeSessionId: 'sess-resume',
            capturedSessionId: 'sess-captured',
        });
        assert.deepEqual(plan, { kind: 'retry-resume', sessionId: 'sess-captured' });
    });

    test('falls back to resumeSessionId when nothing was captured', () => {
        const plan = planAgentSdkRetry({
            attemptsMade: 1,
            maxAttempts: 3,
            errorMessage: 'transient failure',
            resumeSessionId: 'sess-resume',
        });
        assert.deepEqual(plan, { kind: 'retry-resume', sessionId: 'sess-resume' });
    });

    test('keeps retrying while attempts remain', () => {
        const plan = planAgentSdkRetry({
            attemptsMade: 2,
            maxAttempts: 3,
            errorMessage: 'transient failure',
            capturedSessionId: 'sess-1',
        });
        assert.deepEqual(plan, { kind: 'retry-resume', sessionId: 'sess-1' });
    });
});

describe('planAgentSdkRetry — busy errors are bounded by the time budget', () => {
    test('a busy error keeps retrying past maxAttempts while within the budget', () => {
        // attemptsMade far exceeds maxAttempts, but the budget is not yet spent.
        const plan = planAgentSdkRetry({
            attemptsMade: 9,
            maxAttempts: 3,
            errorMessage: 'API Error: 529 overloaded',
            capturedSessionId: 'sess-1',
            errorIsBusy: true,
            elapsedMs: 60_000,
            maxTotalWaitMs: 240 * 60_000,
        });
        assert.deepEqual(plan, { kind: 'retry-resume', sessionId: 'sess-1' });
    });

    test('a busy error gives up once the budget is exhausted', () => {
        const plan = planAgentSdkRetry({
            attemptsMade: 2,
            maxAttempts: 99,
            errorMessage: 'API Error: 529 overloaded',
            capturedSessionId: 'sess-1',
            errorIsBusy: true,
            elapsedMs: 240 * 60_000,
            maxTotalWaitMs: 240 * 60_000,
        });
        assert.deepEqual(plan, { kind: 'give-up' });
    });

    test('a busy error with no budget falls back to the maxAttempts count bound', () => {
        const plan = planAgentSdkRetry({
            attemptsMade: 3,
            maxAttempts: 3,
            errorMessage: 'API Error: 529 overloaded',
            capturedSessionId: 'sess-1',
            errorIsBusy: true,
            // no maxTotalWaitMs → count-bounded → exhausted
        });
        assert.deepEqual(plan, { kind: 'give-up' });
    });

    test('a NON-busy error stays count-bounded even when a budget is supplied', () => {
        const plan = planAgentSdkRetry({
            attemptsMade: 3,
            maxAttempts: 3,
            errorMessage: 'some non-retryable failure',
            capturedSessionId: 'sess-1',
            errorIsBusy: false,
            elapsedMs: 1_000,
            maxTotalWaitMs: 240 * 60_000,
        });
        assert.deepEqual(plan, { kind: 'give-up' });
    });

    test('cancellation still wins over an in-budget busy error', () => {
        const plan = planAgentSdkRetry({
            attemptsMade: 1,
            maxAttempts: 3,
            errorMessage: 'API Error: 529 overloaded',
            capturedSessionId: 'sess-1',
            errorIsBusy: true,
            elapsedMs: 0,
            maxTotalWaitMs: 240 * 60_000,
            cancelled: true,
        });
        assert.deepEqual(plan, { kind: 'give-up' });
    });

    test('a busy budget retry with no session id restarts fresh', () => {
        const plan = planAgentSdkRetry({
            attemptsMade: 5,
            maxAttempts: 3,
            errorMessage: 'API Error: 500 Internal server error',
            errorIsBusy: true,
            elapsedMs: 10_000,
            maxTotalWaitMs: 240 * 60_000,
        });
        assert.deepEqual(plan, { kind: 'retry-fresh' });
    });
});

describe('computeBackoffMs — exponential backoff for busy retries', () => {
    test('doubles from the initial delay per retry index', () => {
        const opts = { initialDelayMs: 1000, maxDelayMs: 5 * 60 * 1000 };
        assert.equal(computeBackoffMs(0, opts), 1000);
        assert.equal(computeBackoffMs(1, opts), 2000);
        assert.equal(computeBackoffMs(2, opts), 4000);
        assert.equal(computeBackoffMs(3, opts), 8000);
    });

    test('caps at maxDelayMs', () => {
        const opts = { initialDelayMs: 1000, maxDelayMs: 10_000 };
        assert.equal(computeBackoffMs(10, opts), 10_000);
    });

    test('clamps negative / fractional indices to index 0', () => {
        assert.equal(computeBackoffMs(-3, { initialDelayMs: 500 }), 500);
        assert.equal(computeBackoffMs(0.9, { initialDelayMs: 500 }), 500);
    });

    test('uses sane defaults when no options are given', () => {
        assert.equal(computeBackoffMs(0), 1000);
        assert.equal(computeBackoffMs(100), 5 * 60 * 1000);
    });
});

describe('DEFAULT_TRANSPORT_RETRY_TEMPLATE', () => {
    test('references the ${errorText} placeholder', () => {
        assert.ok(DEFAULT_TRANSPORT_RETRY_TEMPLATE.includes('${errorText}'));
    });
});

describe('selectTransportRetryTemplateBody', () => {
    test('falls back to the in-code constant when section is undefined', () => {
        assert.equal(selectTransportRetryTemplateBody(undefined), DEFAULT_TRANSPORT_RETRY_TEMPLATE);
    });

    test('falls back to the in-code constant when there are no templates', () => {
        assert.equal(
            selectTransportRetryTemplateBody({ templates: [] }),
            DEFAULT_TRANSPORT_RETRY_TEMPLATE,
        );
    });

    test('"use default" (empty templateId) resolves to the isDefault template', () => {
        const body = selectTransportRetryTemplateBody({
            templateId: '',
            templates: [
                { id: 'a', template: 'A body' },
                { id: 'default-retry', template: 'DEFAULT body', isDefault: true },
            ],
        });
        assert.equal(body, 'DEFAULT body');
    });

    test('"use default" falls back to the constant when no template is marked default', () => {
        const body = selectTransportRetryTemplateBody({
            templateId: '',
            templates: [
                { id: 'a', template: 'A body' },
                { id: 'b', template: 'B body' },
            ],
        });
        assert.equal(body, DEFAULT_TRANSPORT_RETRY_TEMPLATE);
    });

    test('an explicit templateId selects that template, ignoring isDefault', () => {
        const body = selectTransportRetryTemplateBody({
            templateId: 'a',
            templates: [
                { id: 'a', template: 'A body' },
                { id: 'default-retry', template: 'DEFAULT body', isDefault: true },
            ],
        });
        assert.equal(body, 'A body');
    });

    test('an explicit but missing templateId falls back to the constant (not the default)', () => {
        const body = selectTransportRetryTemplateBody({
            templateId: 'gone',
            templates: [
                { id: 'default-retry', template: 'DEFAULT body', isDefault: true },
            ],
        });
        assert.equal(body, DEFAULT_TRANSPORT_RETRY_TEMPLATE);
    });
});
