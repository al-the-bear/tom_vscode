import test, { describe } from 'node:test';
import assert from 'node:assert/strict';

import {
    computeRepeatEditability,
    applyRepeatEditToItem,
    type RepeatEditTarget,
} from '../../utils/queueStep3Utils.js';

describe('computeRepeatEditability', () => {
    test('staged and pending are fully editable', () => {
        assert.equal(computeRepeatEditability('staged'), 'full');
        assert.equal(computeRepeatEditability('pending'), 'full');
    });

    test('sending and waiting allow counter edits only', () => {
        assert.equal(computeRepeatEditability('sending'), 'counters');
        assert.equal(computeRepeatEditability('waiting'), 'counters');
    });

    test('terminal statuses are not editable', () => {
        assert.equal(computeRepeatEditability('sent'), 'none');
        assert.equal(computeRepeatEditability('error'), 'none');
    });
});

describe('applyRepeatEditToItem', () => {
    test('none mode is a no-op', () => {
        const item: RepeatEditTarget = { repeatCount: 3, repeatIndex: 1 };
        applyRepeatEditToItem(item, { repeatCount: 9, repeatIndex: 4 }, 'none');
        assert.equal(item.repeatCount, 3);
        assert.equal(item.repeatIndex, 1);
    });

    test('counters mode applies count and index for the main prompt (sending fix)', () => {
        const item: RepeatEditTarget = { repeatCount: 3, repeatIndex: 0 };
        applyRepeatEditToItem(item, { repeatCount: 5, repeatIndex: 2 }, 'counters');
        assert.equal(item.repeatCount, 5);
        assert.equal(item.repeatIndex, 2);
    });

    test('counters mode applies template count and template index (the previously-dropped fields)', () => {
        const item: RepeatEditTarget = { templateRepeatCount: 2, templateRepeatIndex: 0 };
        applyRepeatEditToItem(item, { templateRepeatCount: 4, templateRepeatIndex: 3 }, 'counters');
        assert.equal(item.templateRepeatCount, 4);
        assert.equal(item.templateRepeatIndex, 3);
    });

    test('counters mode does NOT apply prefix/suffix/answerWait', () => {
        const item: RepeatEditTarget = { repeatPrefix: 'a', repeatSuffix: 'b', answerWaitMinutes: 10 };
        applyRepeatEditToItem(
            item,
            { repeatPrefix: 'X', repeatSuffix: 'Y', answerWaitMinutes: 99 },
            'counters',
        );
        assert.equal(item.repeatPrefix, 'a');
        assert.equal(item.repeatSuffix, 'b');
        assert.equal(item.answerWaitMinutes, 10);
    });

    test('full mode applies every field including prefix/suffix/answerWait (pending fix)', () => {
        const item: RepeatEditTarget = {};
        applyRepeatEditToItem(
            item,
            {
                repeatCount: 6,
                repeatIndex: 1,
                templateRepeatCount: 3,
                templateRepeatIndex: 2,
                repeatPrefix: 'pre',
                repeatSuffix: 'suf',
                answerWaitMinutes: 15,
            },
            'full',
        );
        assert.equal(item.repeatCount, 6);
        assert.equal(item.repeatIndex, 1);
        assert.equal(item.templateRepeatCount, 3);
        assert.equal(item.templateRepeatIndex, 2);
        assert.equal(item.repeatPrefix, 'pre');
        assert.equal(item.repeatSuffix, 'suf');
        assert.equal(item.answerWaitMinutes, 15);
    });

    test('string repeatCount (variable name) is stored and clears the resolved cache', () => {
        const item: RepeatEditTarget = { repeatCount: 3, resolvedRepeatCount: 3 };
        applyRepeatEditToItem(item, { repeatCount: 'batchCount' }, 'counters');
        assert.equal(item.repeatCount, 'batchCount');
        assert.equal(item.resolvedRepeatCount, undefined);
    });

    test('numeric repeatCount is clamped non-negative and clears the resolved cache', () => {
        const item: RepeatEditTarget = { resolvedRepeatCount: 7 };
        applyRepeatEditToItem(item, { repeatCount: -4 }, 'counters');
        assert.equal(item.repeatCount, 0);
        assert.equal(item.resolvedRepeatCount, undefined);
    });

    test('templateRepeatCount of 0 clears to undefined', () => {
        const item: RepeatEditTarget = { templateRepeatCount: 5 };
        applyRepeatEditToItem(item, { templateRepeatCount: 0 }, 'full');
        assert.equal(item.templateRepeatCount, undefined);
    });

    test('index fields are clamped non-negative', () => {
        const item: RepeatEditTarget = {};
        applyRepeatEditToItem(item, { repeatIndex: -3, templateRepeatIndex: -2 }, 'counters');
        assert.equal(item.repeatIndex, 0);
        assert.equal(item.templateRepeatIndex, 0);
    });

    test('answerWaitMinutes of 0 clears to undefined in full mode', () => {
        const item: RepeatEditTarget = { answerWaitMinutes: 20 };
        applyRepeatEditToItem(item, { answerWaitMinutes: 0 }, 'full');
        assert.equal(item.answerWaitMinutes, undefined);
    });
});
