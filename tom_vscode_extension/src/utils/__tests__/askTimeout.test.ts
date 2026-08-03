/**
 * Tests for `resolveAskTimeoutMs` — the rule that turns the user's configured
 * *ceiling* and the model's per-call *request* into the deadline an ask is
 * actually armed with.
 *
 * The contract, in one sentence: **an ask waits indefinitely unless somebody
 * asked for a deadline**, and when both sides ask, the shorter one wins.
 *
 * The asymmetry between the two inputs is deliberate and is what most of these
 * tests pin down:
 *
 *   - the **ceiling** is floored (a ceiling that rounds down is conservative)
 *     and 0 means "no ceiling", matching `parseChatQuestionsConfig`;
 *   - the **request** is floored but never below one minute — a model asking
 *     for 30 seconds wants *a* deadline, and silently turning that into "wait
 *     forever" would be the opposite of what it asked for.
 */

import test, { describe } from 'node:test';
import assert from 'node:assert/strict';

import { resolveAskTimeoutMs } from '../askTimeout.js';

const MIN = 60_000;

describe('resolveAskTimeoutMs', () => {

    test('neither side asks for a deadline → undefined (wait indefinitely)', () => {
        assert.equal(resolveAskTimeoutMs(0, undefined), undefined);
    });

    test('ceiling only → the ceiling', () => {
        assert.equal(resolveAskTimeoutMs(15, undefined), 15 * MIN);
    });

    test('per-call request only → the request, even with no ceiling', () => {
        assert.equal(resolveAskTimeoutMs(0, 3), 3 * MIN);
    });

    test('both present → the shorter one wins (request shorter)', () => {
        assert.equal(resolveAskTimeoutMs(30, 5), 5 * MIN);
    });

    test('both present → the shorter one wins (ceiling shorter)', () => {
        assert.equal(resolveAskTimeoutMs(5, 30), 5 * MIN);
    });

    test('equal ceiling and request → that value', () => {
        assert.equal(resolveAskTimeoutMs(7, 7), 7 * MIN);
    });

    test('a sub-minute request is raised to one minute, never dropped', () => {
        // The model asked for a deadline. Flooring 0.5 to 0 and calling that
        // "no request" would turn an explicit deadline into an infinite wait.
        assert.equal(resolveAskTimeoutMs(0, 0.5), MIN);
        assert.equal(resolveAskTimeoutMs(0, 0.01), MIN);
    });

    test('a fractional request above a minute is floored', () => {
        assert.equal(resolveAskTimeoutMs(0, 2.9), 2 * MIN);
    });

    test('a fractional ceiling is floored', () => {
        assert.equal(resolveAskTimeoutMs(2.9, undefined), 2 * MIN);
    });

    test('a fractional ceiling below one minute is no ceiling at all', () => {
        // Matches `parseChatQuestionsConfig`, which already clamps the stored
        // value to a whole number ≥ 0 — 0 being "no ceiling".
        assert.equal(resolveAskTimeoutMs(0.4, undefined), undefined);
    });

    test('negative values on either side are treated as absent', () => {
        assert.equal(resolveAskTimeoutMs(-5, undefined), undefined);
        assert.equal(resolveAskTimeoutMs(0, -5), undefined);
        assert.equal(resolveAskTimeoutMs(-5, 4), 4 * MIN);
        assert.equal(resolveAskTimeoutMs(4, -5), 4 * MIN);
    });

    test('non-finite / wrong-typed values are treated as absent', () => {
        assert.equal(resolveAskTimeoutMs(Number.NaN, undefined), undefined);
        assert.equal(resolveAskTimeoutMs(0, Number.NaN), undefined);
        assert.equal(resolveAskTimeoutMs(0, Number.POSITIVE_INFINITY), undefined);
        assert.equal(resolveAskTimeoutMs('10' as unknown as number, undefined), undefined);
        assert.equal(resolveAskTimeoutMs(0, '10' as unknown as number), undefined);
    });

    test('an absent ceiling behaves like 0', () => {
        assert.equal(resolveAskTimeoutMs(undefined, undefined), undefined);
        assert.equal(resolveAskTimeoutMs(undefined, 3), 3 * MIN);
    });
});
