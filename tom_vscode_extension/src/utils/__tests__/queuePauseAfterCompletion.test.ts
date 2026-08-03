import test, { describe } from 'node:test';
import assert from 'node:assert/strict';

import { decidePauseAfterCompletion } from '../queueStep3Utils.js';

/**
 * "Pause after this" — the per-item flag that lets a queue item run to the
 * end of its repeat loop and then stop the queue instead of letting the next
 * item start.
 *
 * The decision is deliberately split out of the manager because the manager's
 * six completion sites (answer-wait timer, answer file, resume, manual
 * Continue, sendItem, resend) each advance the queue in their own way — some
 * gate on `autoSendEnabled`, some call `sendNext()` unconditionally. They all
 * consult this one function so the flag cannot mean two different things
 * depending on how the item happened to finish.
 */
describe('decidePauseAfterCompletion - per-item queue hold', () => {
    test('no flag: the queue behaves exactly as before (auto-send on)', () => {
        assert.deepEqual(
            decidePauseAfterCompletion(undefined, true),
            { disableAutoSend: false, holdQueue: false },
        );
    });

    test('flag explicitly false is the same as no flag', () => {
        assert.deepEqual(
            decidePauseAfterCompletion(false, true),
            { disableAutoSend: false, holdQueue: false },
        );
    });

    test('no flag + auto-send already off: the gate stays inert', () => {
        // An already-paused queue must not be *further* disturbed by a
        // completion — that is the pre-existing behaviour and this feature
        // must not change it for items that never asked to pause.
        assert.deepEqual(
            decidePauseAfterCompletion(undefined, false),
            { disableAutoSend: false, holdQueue: false },
        );
    });

    test('flag set + auto-send on: hold the queue and flip auto-send off', () => {
        // Flipping auto-send off is what makes the pause *visible* and
        // survives a reload — the user sees the queue toggle in the paused
        // state rather than a queue that silently stopped.
        assert.deepEqual(
            decidePauseAfterCompletion(true, true),
            { disableAutoSend: true, holdQueue: true },
        );
    });

    test('flag set + auto-send already off: still holds, but has nothing to persist', () => {
        // `holdQueue` is NOT derived from `autoSendEnabled`: the Anthropic
        // completion paths call `sendNext()` regardless of the auto-send
        // flag, so a caller that only re-read `autoSendEnabled` would start
        // the next item anyway. The hold has to be reported independently.
        assert.deepEqual(
            decidePauseAfterCompletion(true, false),
            { disableAutoSend: false, holdQueue: true },
        );
    });
});
