import test, { describe } from 'node:test';
import assert from 'node:assert/strict';

import {
    computeRepeatDecision,
    convertStagedToPending,
    shouldAutoPauseOnEmpty,
    applyRepetitionAffixes,
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

    test('repetition affixes substitute placeholders for current repetition number', () => {
        const wrapped = applyRepetitionAffixes({
            originalText: 'Prompt',
            repeatPrefix: 'Run {{repeatNumber}} of {{repeatCount}} (index={{repeatIndex}})',
            repeatSuffix: 'Finished {{repeatNumber}}',
            repeatCount: 4,
            repeatIndex: 2,
        });

        assert.equal(
            wrapped,
            'Run 3 of 4 (index=2)\n\nPrompt\n\nFinished 3',
        );
    });

    test('repetition affixes substitute ${...} placeholders', () => {
        const wrapped = applyRepetitionAffixes({
            originalText: 'Prompt',
            repeatPrefix: 'Run ${repeatNumber} of ${repeatCount} (index=${repeatIndex})',
            repeatSuffix: 'Finished ${repeatNumber}',
            repeatCount: 4,
            repeatIndex: 2,
        });

        assert.equal(
            wrapped,
            'Run 3 of 4 (index=2)\n\nPrompt\n\nFinished 3',
        );
    });

    test('repetition affixes substitute mustache placeholders with whitespace', () => {
        const wrapped = applyRepetitionAffixes({
            originalText: 'Prompt',
            repeatPrefix: 'Run {{ repeatNumber }} of {{ repeatCount }} (index={{ repeatIndex }})',
            repeatSuffix: 'Finished {{ repeatNumber }}',
            repeatCount: 4,
            repeatIndex: 2,
        });

        assert.equal(
            wrapped,
            'Run 3 of 4 (index=2)\n\nPrompt\n\nFinished 3',
        );
    });
});
