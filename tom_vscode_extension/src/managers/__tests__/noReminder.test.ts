/**
 * Tests for the "No Reminder" bug fix (Issue 3).
 *
 * Verifies that selecting "__none__" as reminder template correctly prevents
 * reminder generation.  Tests cover the three fix points:
 *
 * Bug A: isReminderEligible() must respect reminderEnabled for all item types
 * Bug B: enqueue() must keep '__none__' as reminderTemplateId (not clear to undefined)
 * Defense: checkResponseTimeouts() must skip when reminderTemplateId === '__none__'
 */

import test, { describe } from 'node:test';
import assert from 'node:assert/strict';

// ---------------------------------------------------------------------------
// The functions under test are extracted from promptQueueManager.ts logic.
// We mirror the exact production logic here to test in isolation (no vscode).
// ---------------------------------------------------------------------------

/** Mirror of QueuedPrompt — minimal shape for testing. */
interface TestQueuedPrompt {
    type: 'normal' | 'timed' | 'reminder';
    reminderEnabled?: boolean;
    followUps?: Array<{ reminderEnabled?: boolean }>;
    followUpIndex?: number;
    reminderTemplateId?: string;
}

// ---------------------------------------------------------------------------
// Test: Bug A — isReminderEligible must reject reminderEnabled=false
// ---------------------------------------------------------------------------

describe('Issue 3 Bug A: isReminderEligible', () => {

    /**
     * Production logic (FIXED version):
     * ```
     * if (item.reminderEnabled === false) { return false; }
     * if (item.type !== 'timed') { return true; }
     * // ... timed-specific follow-up logic ...
     * ```
     */
    function isReminderEligible(item: TestQueuedPrompt): boolean {
        // --- FIX: check reminderEnabled first, for ALL item types ---
        if (item.reminderEnabled === false) { return false; }
        if (item.type !== 'timed') { return true; }
        const followUps = item.followUps || [];
        const sentFollowUps = item.followUpIndex || 0;
        const activeFollowUp = sentFollowUps > 0 && sentFollowUps <= followUps.length
            ? followUps[sentFollowUps - 1]
            : undefined;
        return !!(activeFollowUp?.reminderEnabled ?? item.reminderEnabled);
    }

    test('normal item with reminderEnabled=false is NOT eligible', () => {
        const item: TestQueuedPrompt = { type: 'normal', reminderEnabled: false };
        assert.equal(isReminderEligible(item), false);
    });

    test('normal item with reminderEnabled=true IS eligible', () => {
        const item: TestQueuedPrompt = { type: 'normal', reminderEnabled: true };
        assert.equal(isReminderEligible(item), true);
    });

    test('normal item with reminderEnabled=undefined IS eligible (backwards compat)', () => {
        const item: TestQueuedPrompt = { type: 'normal', reminderEnabled: undefined };
        assert.equal(isReminderEligible(item), true);
    });

    test('timed item with reminderEnabled=false is NOT eligible', () => {
        const item: TestQueuedPrompt = { type: 'timed', reminderEnabled: false };
        assert.equal(isReminderEligible(item), false);
    });

    test('timed item with reminderEnabled=true IS eligible', () => {
        const item: TestQueuedPrompt = { type: 'timed', reminderEnabled: true };
        assert.equal(isReminderEligible(item), true);
    });

    test('reminder item with reminderEnabled=false is NOT eligible', () => {
        const item: TestQueuedPrompt = { type: 'reminder', reminderEnabled: false };
        assert.equal(isReminderEligible(item), false);
    });
});

// ---------------------------------------------------------------------------
// Test: Bug B — enqueue must keep '__none__' as reminderTemplateId
// ---------------------------------------------------------------------------

describe('Issue 3 Bug B: __none__ template preservation', () => {

    /**
     * Production logic (FIXED version):
     * - REMOVED: if (isNoReminder) { effectiveReminderTemplateId = undefined; }
     * - KEPT: reminderEnabled set to false when __none__
     * - KEPT: reminderTemplateId stores '__none__' directly
     */
    function computeEffectiveReminder(opts: {
        reminderTemplateId?: string;
        reminderEnabled?: boolean;
        defaultTemplateId?: string;
    }): { reminderTemplateId: string | undefined; reminderEnabled: boolean } {
        const defaultTemplate = opts.defaultTemplateId ?? 'default_reminder';
        let effectiveReminderTemplateId: string | undefined = opts.reminderTemplateId ?? defaultTemplate;
        const isNoReminder = effectiveReminderTemplateId === '__none__';
        // FIX: Do NOT clear to undefined — keep '__none__' as the stored value
        // (removed: if (isNoReminder) { effectiveReminderTemplateId = undefined; })
        return {
            reminderTemplateId: effectiveReminderTemplateId,
            reminderEnabled: isNoReminder ? false : !!opts.reminderEnabled,
        };
    }

    test('__none__ template is preserved as reminderTemplateId', () => {
        const result = computeEffectiveReminder({ reminderTemplateId: '__none__' });
        assert.equal(result.reminderTemplateId, '__none__',
            'reminderTemplateId must be "__none__", not undefined');
    });

    test('__none__ template sets reminderEnabled to false', () => {
        const result = computeEffectiveReminder({ reminderTemplateId: '__none__', reminderEnabled: true });
        assert.equal(result.reminderEnabled, false);
    });

    test('normal template is preserved', () => {
        const result = computeEffectiveReminder({ reminderTemplateId: 'my_template', reminderEnabled: true });
        assert.equal(result.reminderTemplateId, 'my_template');
        assert.equal(result.reminderEnabled, true);
    });

    test('undefined template falls back to default', () => {
        const result = computeEffectiveReminder({ defaultTemplateId: 'fallback' });
        assert.equal(result.reminderTemplateId, 'fallback');
    });
});

// ---------------------------------------------------------------------------
// Test: Defense — checkResponseTimeouts should skip __none__
// ---------------------------------------------------------------------------

describe('Issue 3 Defense: __none__ guard in checkResponseTimeouts', () => {

    /**
     * Production logic (FIXED version):
     * After isReminderEligible check, adds:
     *   if (sending.reminderTemplateId === '__none__') { return; }
     */
    function shouldGenerateReminder(item: TestQueuedPrompt): boolean {
        // Step 1: eligibility check
        if (item.reminderEnabled === false) { return false; }
        // Step 2: __none__ guard (defense-in-depth)
        if (item.reminderTemplateId === '__none__') { return false; }
        return true;
    }

    test('item with __none__ template does NOT generate reminder', () => {
        // Even if reminderEnabled is not false (e.g. undefined from old data)
        const item: TestQueuedPrompt = {
            type: 'normal',
            reminderTemplateId: '__none__',
            reminderEnabled: undefined,
        };
        assert.equal(shouldGenerateReminder(item), false);
    });

    test('item with real template and reminderEnabled=true DOES generate', () => {
        const item: TestQueuedPrompt = {
            type: 'normal',
            reminderTemplateId: 'my_template',
            reminderEnabled: true,
        };
        assert.equal(shouldGenerateReminder(item), true);
    });

    test('item with undefined template and reminderEnabled=false does NOT generate', () => {
        const item: TestQueuedPrompt = {
            type: 'normal',
            reminderTemplateId: undefined,
            reminderEnabled: false,
        };
        assert.equal(shouldGenerateReminder(item), false);
    });
});
