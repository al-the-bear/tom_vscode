import test, { describe } from 'node:test';
import assert from 'node:assert/strict';

import { applyCrashRecovery } from '../../utils/queueCrashRecoveryUtils.js';

describe('applyCrashRecovery', () => {
    test('resets sending items to pending and clears transient send fields', () => {
        const items = [
            {
                id: 'a',
                status: 'sending',
                requestId: 'req-123',
                expectedRequestId: 'req-123',
                reminderSentCount: 2,
                lastReminderAt: 1_700_000_000,
            },
        ];

        const count = applyCrashRecovery(items as any);

        assert.equal(count, 1);
        assert.equal(items[0].status, 'pending');
        assert.equal(items[0].requestId, undefined);
        assert.equal(items[0].expectedRequestId, undefined);
        assert.equal(items[0].reminderSentCount, 0);
        assert.equal(items[0].lastReminderAt, undefined);
    });

    test('preserves lastDispatched and warning so the Resend button stays functional', () => {
        const lastDispatched = {
            expandedText: 'Hello',
            transport: 'copilot',
            originalTextIndex: 0,
        };
        const items: any[] = [
            {
                id: 'a',
                status: 'sending',
                lastDispatched,
                warning: 'rate-limit',
            },
        ];

        applyCrashRecovery(items);

        assert.equal(items[0].status, 'pending');
        assert.deepEqual(items[0].lastDispatched, lastDispatched);
        assert.equal(items[0].warning, 'rate-limit');
    });

    test('does not touch items whose status is not sending', () => {
        const items: any[] = [
            { id: 'a', status: 'staged' },
            { id: 'b', status: 'pending', requestId: 'keep-me' },
            { id: 'c', status: 'sent', requestId: 'also-keep' },
            { id: 'd', status: 'error', requestId: 'keep-too' },
        ];

        const count = applyCrashRecovery(items);

        assert.equal(count, 0);
        assert.deepEqual(
            items.map(i => i.status),
            ['staged', 'pending', 'sent', 'error'],
        );
        assert.equal(items[1].requestId, 'keep-me');
        assert.equal(items[2].requestId, 'also-keep');
        assert.equal(items[3].requestId, 'keep-too');
    });

    test('recovers multiple items and returns the correct count', () => {
        const items: any[] = [
            { id: 'a', status: 'sending' },
            { id: 'b', status: 'pending' },
            { id: 'c', status: 'sending' },
            { id: 'd', status: 'sending' },
        ];

        const count = applyCrashRecovery(items);

        assert.equal(count, 3);
        assert.deepEqual(
            items.map(i => i.status),
            ['pending', 'pending', 'pending', 'pending'],
        );
    });

    test('is idempotent on a second call', () => {
        const items: any[] = [
            { id: 'a', status: 'sending', requestId: 'x' },
        ];

        const first = applyCrashRecovery(items);
        const second = applyCrashRecovery(items);

        assert.equal(first, 1);
        assert.equal(second, 0);
        assert.equal(items[0].status, 'pending');
    });

    test('returns 0 on an empty items array', () => {
        const items: any[] = [];
        assert.equal(applyCrashRecovery(items), 0);
    });
});
