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
