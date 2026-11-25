import test, { describe } from 'node:test';
import assert from 'node:assert/strict';

import { computeHealthCheckDecisions } from '../../utils/queueStep4Utils.js';

describe('Step 4 - Issue 6: health check decisions', () => {
    test('requests sendNext when pending exists, auto-send is on, and nothing sending', () => {
        const d = computeHealthCheckDecisions({
            autoSendEnabled: true,
            pendingCount: 2,
            sendingCount: 0,
        });
        assert.equal(d.shouldTriggerSendNext, true);
    });

    test('requests nothing with auto-send off, nothing pending, or an item sending', () => {
        assert.equal(computeHealthCheckDecisions({ autoSendEnabled: false, pendingCount: 2, sendingCount: 0 }).shouldTriggerSendNext, false);
        assert.equal(computeHealthCheckDecisions({ autoSendEnabled: true, pendingCount: 0, sendingCount: 0 }).shouldTriggerSendNext, false);
        assert.equal(computeHealthCheckDecisions({ autoSendEnabled: true, pendingCount: 2, sendingCount: 1 }).shouldTriggerSendNext, false);
    });
});
