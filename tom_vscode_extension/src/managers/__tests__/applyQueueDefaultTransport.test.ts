import test, { describe } from 'node:test';
import assert from 'node:assert/strict';

import {
    applyQueueDefaultTransportToItem,
    type QueueTransportTarget,
} from '../../utils/queueStep3Utils.js';

describe('applyQueueDefaultTransportToItem - adopt queue-default transport/profile', () => {
    test('copies the queue-default transport + profile onto the item', () => {
        const item: QueueTransportTarget = { transport: 'copilot' };
        applyQueueDefaultTransportToItem(item, {
            transport: 'anthropic',
            anthropicProfileId: 'prof-a',
            anthropicConfigId: 'cfg-a',
        });
        assert.equal(item.transport, 'anthropic');
        assert.equal(item.anthropicProfileId, 'prof-a');
        assert.equal(item.anthropicConfigId, 'cfg-a');
    });

    test('blank/whitespace profile + config ids collapse to undefined (mirror queue default exactly)', () => {
        const item: QueueTransportTarget = {
            transport: 'anthropic',
            anthropicProfileId: 'stale-profile',
            anthropicConfigId: 'stale-config',
        };
        applyQueueDefaultTransportToItem(item, {
            transport: 'copilot',
            anthropicProfileId: '   ',
            anthropicConfigId: '',
        });
        assert.equal(item.transport, 'copilot');
        assert.equal(item.anthropicProfileId, undefined, 'stale profile override must be cleared');
        assert.equal(item.anthropicConfigId, undefined, 'stale config override must be cleared');
    });

    test('unknown transport value is coerced to copilot', () => {
        const item: QueueTransportTarget = {};
        applyQueueDefaultTransportToItem(item, {
            // Simulate a malformed persisted default.
            transport: 'bogus' as unknown as 'copilot',
        });
        assert.equal(item.transport, 'copilot');
    });

    test('leaves non-transport fields (status, repeat counters, template, text) untouched — repetition continuity', () => {
        // Extra fields model a currently-repeating item; the button must not
        // disturb its place in the repetition or its content.
        const item = {
            transport: 'copilot' as 'copilot' | 'anthropic',
            anthropicProfileId: undefined as string | undefined,
            anthropicConfigId: undefined as string | undefined,
            status: 'sending',
            repeatIndex: 2,
            repeatCount: 5,
            template: 'my-template',
            originalText: 'hello',
        };
        applyQueueDefaultTransportToItem(item, { transport: 'anthropic', anthropicProfileId: 'prof-x' });
        assert.equal(item.transport, 'anthropic');
        assert.equal(item.anthropicProfileId, 'prof-x');
        assert.equal(item.status, 'sending', 'status must be preserved so the item keeps repeating');
        assert.equal(item.repeatIndex, 2, 'repeat index preserved — next repetition, not a restart');
        assert.equal(item.repeatCount, 5);
        assert.equal(item.template, 'my-template', 'template left intact (only transport/profile change)');
        assert.equal(item.originalText, 'hello');
    });

    test('returns the same item reference it mutated', () => {
        const item: QueueTransportTarget = { transport: 'copilot' };
        const result = applyQueueDefaultTransportToItem(item, { transport: 'copilot' });
        assert.equal(result, item);
    });
});
