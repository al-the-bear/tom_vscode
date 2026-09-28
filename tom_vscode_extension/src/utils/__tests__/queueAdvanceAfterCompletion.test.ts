import test, { describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { decideAdvanceAfterCompletion } from '../queueStep3Utils.js';

/**
 * "Does the queue keep going?" — the single decision every completion path
 * asks once an item has finished its last stage / repetition.
 *
 * There are two independent reasons to stop: the queue is paused
 * (`autoSendEnabled` is off), or the item carries the per-item "pause after
 * this" flag. Both used to be answered separately at each of the manager's
 * six completion sites, and three of them answered only half the question —
 * the Anthropic tails advanced with a bare `sendNext()` that never looked at
 * the auto-send flag, so a paused queue kept marching. Folding both reasons
 * into one function is what makes that class of bug unrepresentable.
 */
describe('decideAdvanceAfterCompletion - does the queue move on?', () => {
    test('auto-send on, no flag: advance, change nothing', () => {
        assert.deepEqual(
            decideAdvanceAfterCompletion(undefined, true),
            { advance: true, disableAutoSend: false },
        );
    });

    test('auto-send OFF, no flag: hold — a paused queue stays paused', () => {
        // The bug this pins: the Anthropic completion tails used to call
        // `sendNext()` here regardless, so pausing the queue did not stop it
        // from starting the next item once the running one finished.
        assert.deepEqual(
            decideAdvanceAfterCompletion(undefined, false),
            { advance: false, disableAutoSend: false },
        );
    });

    test('flag explicitly false is the same as no flag', () => {
        assert.deepEqual(
            decideAdvanceAfterCompletion(false, true),
            { advance: true, disableAutoSend: false },
        );
    });

    test('flag set + auto-send on: hold and flip auto-send off', () => {
        // Flipping auto-send off is what makes the pause *visible* and
        // survives a reload — the user sees the queue toggle in the paused
        // state rather than a queue that silently stopped.
        assert.deepEqual(
            decideAdvanceAfterCompletion(true, true),
            { advance: false, disableAutoSend: true },
        );
    });

    test('flag set + auto-send already off: holds, nothing to persist', () => {
        assert.deepEqual(
            decideAdvanceAfterCompletion(true, false),
            { advance: false, disableAutoSend: false },
        );
    });
});

/**
 * Wiring check.
 *
 * The truth table above is worthless if a completion path does not consult
 * it — which is exactly how the original bug survived: the decision existed,
 * three sites just did not ask. `PromptQueueManager` cannot be instantiated
 * under `node:test` (it imports `vscode`), so the invariant is asserted
 * against the source: **wherever an item reaches `'sent'` and the queue is
 * then advanced, the advance goes through the single gate.**
 */
describe('every completion path funnels through the one gate', () => {
    // Project root is three levels up from out/utils/__tests__; the invariant
    // lives in the TypeScript source, not the build output.
    const managerSource = readFileSync(
        join(__dirname, '..', '..', '..', 'src', 'managers', 'promptQueueManager.ts'),
        'utf-8',
    );

    /**
     * Lines that complete a queue *item*. `pp.status = 'sent'` is excluded on
     * purpose — that is a pre-prompt stage finishing inside an item, which
     * never advances the queue.
     */
    const completionLines = managerSource
        .split('\n')
        .map((line, idx) => ({ line, idx }))
        .filter(({ line }) => /^\s*(?:sending|liveItem|item)\.status = 'sent';/.test(line));

    /**
     * How far past the completion an advance may sit. Generous enough to
     * cover the widest real tail (the answer-wait timer, ~20 lines) and short
     * enough not to reach the next completion site in the file.
     */
    const WINDOW = 40;

    /**
     * Both ways a tail advances. `delaySendNext` must be spelled out: it does
     * not contain `sendNext` at a word boundary, so a `\bsendNext\(` pattern
     * silently skips the three sites that use it — which would make half of
     * the assertions below pass without testing anything.
     */
    const ADVANCES = /\b(?:sendNext|delaySendNext)\(/;

    test('the manager has exactly the six known item-completion sites', () => {
        // A seventh would mean a new tail that this test has not been thought
        // about for — fail loudly rather than silently stop covering it.
        assert.equal(
            completionLines.length,
            6,
            `expected 6 item-completion sites, found ${completionLines.length} `
            + `at lines ${completionLines.map(c => c.idx + 1).join(', ')}`,
        );
    });

    for (const { idx } of completionLines) {
        test(`completion at line ${idx + 1} advances only through _shouldAdvanceQueueAfter`, () => {
            const window = managerSource.split('\n').slice(idx, idx + WINDOW).join('\n');
            assert.match(
                window,
                ADVANCES,
                `no advance found within ${WINDOW} lines of the completion at line ${idx + 1} — `
                + 'either the tail moved and the window needs widening, or this test has '
                + 'stopped covering it',
            );
            assert.match(
                window,
                /_shouldAdvanceQueueAfter\(/,
                `the completion at line ${idx + 1} advances the queue without asking `
                + `_shouldAdvanceQueueAfter — it will run on even when the queue is paused `
                + `or the item carries "pause after this"`,
            );
        });
    }
});
