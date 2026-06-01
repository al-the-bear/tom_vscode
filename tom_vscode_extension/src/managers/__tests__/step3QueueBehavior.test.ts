import test, { describe } from 'node:test';
import assert from 'node:assert/strict';

import {
    computeRepeatDecision,
    convertStagedToPending,
    shouldAutoPauseOnEmpty,
    applyRepetitionAffixes,
    buildNextTemplateIterationParams,
} from '../../utils/queueStep3Utils.js';

describe('Step 3 - Issue 4: queue auto-pause behavior', () => {
    test('auto-pause should trigger when auto-send is on and pending count is zero', () => {
        assert.equal(shouldAutoPauseOnEmpty(true, 0), true);
    });

    test('auto-pause should not trigger when auto-send is already off', () => {
        assert.equal(shouldAutoPauseOnEmpty(false, 0), false);
    });

    test('auto-pause should not trigger when pending items exist', () => {
        assert.equal(shouldAutoPauseOnEmpty(true, 2), false);
    });
});

describe('Step 3 - Issue 5: sendAllStaged', () => {
    test('sendAllStaged converts staged items to pending and returns count', () => {
        const items = [
            { id: '1', status: 'staged' },
            { id: '2', status: 'pending' },
            { id: '3', status: 'staged' },
            { id: '4', status: 'sent' },
        ];

        const changed = convertStagedToPending(items);

        assert.equal(changed, 2);
        assert.deepEqual(
            items.map((i: any) => i.status),
            ['pending', 'pending', 'pending', 'sent'],
        );
    });

    test('sendAllStaged returns 0 when there are no staged items', () => {
        const items = [{ id: '1', status: 'pending' }];
        const changed = convertStagedToPending(items);

        assert.equal(changed, 0);
        assert.deepEqual(items.map((i: any) => i.status), ['pending']);
    });
});

describe('Step 3 - Issue 10: repeat decision', () => {
    test('repeat decision schedules next run when repeatIndex < repeatCount', () => {
        const decision = computeRepeatDecision({ repeatCount: 3, repeatIndex: 1 });
        assert.equal(decision.shouldRepeat, true);
        assert.equal(decision.nextRepeatIndex, 2);
        assert.equal(decision.progressLabel, '2/3');
    });

    test('repeat decision does not schedule when repeatIndex reached repeatCount', () => {
        const decision = computeRepeatDecision({ repeatCount: 3, repeatIndex: 2 });
        assert.equal(decision.shouldRepeat, false);
        assert.equal(decision.nextRepeatIndex, 3);
        assert.equal(decision.progressLabel, '3/3');
    });

    test('repeat decision does not schedule when repeatCount is missing', () => {
        const decision = computeRepeatDecision({ repeatCount: undefined, repeatIndex: 0 });
        assert.equal(decision.shouldRepeat, false);
        assert.equal(decision.nextRepeatIndex, 0);
        assert.equal(decision.progressLabel, '1/1');
    });

    test('repetition affixes wrap original prompt with blank lines', () => {
        const wrapped = applyRepetitionAffixes({
            originalText: 'Main prompt body',
            repeatPrefix: 'Prefix text',
            repeatSuffix: 'Suffix text',
            repeatCount: 3,
            repeatIndex: 1,
        });

        assert.equal(wrapped, 'Prefix text\n\nMain prompt body\n\nSuffix text');
    });

    test('repetition affixes keep ${...} placeholders (resolved later in queue manager)', () => {
        const wrapped = applyRepetitionAffixes({
            originalText: 'Prompt',
            repeatPrefix: 'Run ${repeatNumber} of ${repeatCount} (index=${repeatIndex})',
            repeatSuffix: 'Finished ${repeatNumber}',
            repeatCount: 4,
            repeatIndex: 2,
        });

        assert.equal(
            wrapped,
            'Run ${repeatNumber} of ${repeatCount} (index=${repeatIndex})\n\nPrompt\n\nFinished ${repeatNumber}',
        );
    });

    test('next template iteration params advance templateRepeatIndex and reset main repeatIndex to 0', () => {
        // Sequence in flight: iteration 1 of 3 finished. The builder
        // must produce params for iteration 2 (templateRepeatIndex=1)
        // while resetting the inner main-prompt counter so the new
        // iteration runs its main reps from the top.
        const params = buildNextTemplateIterationParams(
            {
                originalText: 'Body',
                templateRepeatCount: 3,
                templateRepeatIndex: 0,
                repeatCount: 2,
                repeatPrefix: 'Run ${repeatNumber}',
                prePrompts: [{ text: 'PP', repeatCount: 1 }],
                followUps: [{ originalText: 'FU', repeatCount: 1 }],
            },
            3,
        );

        assert.ok(params, 'builder must return params when more iterations are pending');
        assert.equal(params!.templateRepeatCount, 3);
        assert.equal(params!.templateRepeatIndex, 1, 'next iteration index advances by one');
        assert.equal(params!.repeatIndex, 0, 'main-prompt counter must reset for the new iteration');
        assert.equal(params!.repeatCount, 2, 'main-prompt count carries through unchanged');
        assert.equal(params!.repeatPrefix, 'Run ${repeatNumber}', 'affix placeholders re-render per iteration');
        assert.equal(params!.initialStatus, 'pending');
        assert.equal(params!.deferSend, true);
        assert.deepEqual(params!.prePrompts.map(p => p.text), ['PP']);
        assert.deepEqual(params!.followUps.map(f => f.originalText), ['FU']);
        assert.equal(params!.progressLabel, '1/3', 'progressLabel describes the just-completed iteration');
    });

    test('next template iteration params return null when sequence is complete', () => {
        // Iteration 3 of 3 just finished. No further iteration to enqueue.
        const params = buildNextTemplateIterationParams(
            {
                originalText: 'Body',
                templateRepeatCount: 3,
                templateRepeatIndex: 2,
            },
            3,
        );
        assert.equal(params, null);
    });

    test('next template iteration params return null when templateRepeatCount <= 1', () => {
        // Single-shot prompt — no template repetition was ever configured.
        // computeRepeatDecision treats <=1 as shouldRepeat=false.
        const params = buildNextTemplateIterationParams(
            { originalText: 'Body', templateRepeatCount: 1, templateRepeatIndex: 0 },
            1,
        );
        assert.equal(params, null);
    });

    test('next template iteration params preserve reminder + answerWrapper + answerWaitMinutes settings', () => {
        // The bug we're fixing surfaces when these inheritable
        // per-iteration knobs silently drop through the gap. Lock them
        // into a regression test so future refactors don't lose them.
        const params = buildNextTemplateIterationParams(
            {
                originalText: 'Body',
                templateRepeatCount: 4,
                templateRepeatIndex: 1,
                answerWrapper: true,
                answerWaitMinutes: 7,
                reminderTemplateId: 'tpl-42',
                reminderTimeoutMinutes: 12,
                reminderRepeat: true,
                reminderEnabled: true,
            },
            4,
        );

        assert.ok(params);
        assert.equal(params!.answerWrapper, true);
        assert.equal(params!.answerWaitMinutes, 7);
        assert.equal(params!.reminderTemplateId, 'tpl-42');
        assert.equal(params!.reminderTimeoutMinutes, 12);
        assert.equal(params!.reminderRepeat, true);
        assert.equal(params!.reminderEnabled, true);
        assert.equal(params!.templateRepeatIndex, 2, 'next iteration index advances by one');
    });

    test('repetition affixes keep mustache placeholders unchanged', () => {
        const wrapped = applyRepetitionAffixes({
            originalText: 'Prompt',
            repeatPrefix: 'Run {{repeatNumber}} of {{repeatCount}} (index={{repeatIndex}})',
            repeatSuffix: 'Finished {{repeatNumber}}',
            repeatCount: 4,
            repeatIndex: 2,
        });

        assert.equal(
            wrapped,
            'Run {{repeatNumber}} of {{repeatCount}} (index={{repeatIndex}})\n\nPrompt\n\nFinished {{repeatNumber}}',
        );
    });
});
