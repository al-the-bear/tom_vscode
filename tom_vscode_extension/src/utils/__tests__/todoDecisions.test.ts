/**
 * Tests for the todo `decisions` model — the list of things the user has to
 * decide before a todo can be started.
 *
 * The normaliser is the gate between hand-written YAML and everything that
 * reads it (the panel, the archive journal, the MCP tools), so it has to make
 * one guarantee above all: **every decision it returns has a non-empty
 * `summary`**. The collapsed UI shows nothing but the summary, and an
 * unlabelled row the user cannot identify is worse than no row.
 */

import test, { describe } from 'node:test';
import assert from 'node:assert/strict';

import {
    normaliseTodoDecisions,
    isDecisionResolved,
    hasUnresolvedDecisions,
} from '../todoDecisions.js';

describe('normaliseTodoDecisions', () => {

    test('absent / non-array → undefined, never an empty list', () => {
        // `undefined` and `[]` round-trip differently through YAML: one omits
        // the key, the other writes `decisions: []` into every todo.
        assert.equal(normaliseTodoDecisions(undefined), undefined);
        assert.equal(normaliseTodoDecisions(null), undefined);
        assert.equal(normaliseTodoDecisions('nope'), undefined);
        assert.equal(normaliseTodoDecisions({ summary: 'x' }), undefined);
    });

    test('an empty array → undefined', () => {
        assert.equal(normaliseTodoDecisions([]), undefined);
    });

    test('a full decision survives intact and in order', () => {
        const out = normaliseTodoDecisions([
            { summary: 'Which database?', decision_needed: 'Postgres or MySQL', decision: 'Postgres' },
            { summary: 'Destructive migration?', decision_needed: 'Data loss is possible' },
        ]);
        assert.equal(out?.length, 2);
        assert.deepEqual(out?.[0], {
            summary: 'Which database?',
            decision_needed: 'Postgres or MySQL',
            decision: 'Postgres',
        });
        assert.equal(out?.[1].summary, 'Destructive migration?');
        assert.equal(out?.[1].decision, undefined);
    });

    test('a bare string is shorthand for a summary-only decision', () => {
        const out = normaliseTodoDecisions(['Which database?']);
        assert.deepEqual(out, [{ summary: 'Which database?' }]);
    });

    test('all three fields are trimmed', () => {
        const out = normaliseTodoDecisions([
            { summary: '  s  ', decision_needed: '  n  ', decision: '  d  ' },
        ]);
        assert.deepEqual(out, [{ summary: 's', decision_needed: 'n', decision: 'd' }]);
    });

    test('blank optional fields are dropped rather than persisted as empty strings', () => {
        const out = normaliseTodoDecisions([{ summary: 's', decision_needed: '   ', decision: '' }]);
        assert.deepEqual(out, [{ summary: 's' }]);
    });

    test('a missing summary is derived from the first line of decision_needed', () => {
        // The collapsed row must always be identifiable.
        const out = normaliseTodoDecisions([
            { decision_needed: 'Pick a database\nPostgres or MySQL, both are fine' },
        ]);
        assert.equal(out?.[0].summary, 'Pick a database');
        assert.equal(out?.[0].decision_needed, 'Pick a database\nPostgres or MySQL, both are fine');
    });

    test('an entry with nothing to say is dropped', () => {
        assert.equal(normaliseTodoDecisions([{}, { summary: '  ' }, null, 42, '']), undefined);
    });

    test('junk entries are dropped without taking the good ones with them', () => {
        const out = normaliseTodoDecisions([null, { summary: 'keep me' }, {}, 'and me']);
        assert.deepEqual(out, [{ summary: 'keep me' }, { summary: 'and me' }]);
    });

    test('a very long derived summary is truncated so the collapsed row stays one line', () => {
        const long = 'x'.repeat(300);
        const out = normaliseTodoDecisions([{ decision_needed: long }]);
        assert.ok(out![0].summary.length < 300);
        assert.ok(out![0].summary.startsWith('xxx'));
        // The full text is still there — only the label was shortened.
        assert.equal(out![0].decision_needed, long);
    });

    test('an explicit summary is never overwritten by decision_needed', () => {
        const out = normaliseTodoDecisions([{ summary: 'mine', decision_needed: 'theirs' }]);
        assert.equal(out?.[0].summary, 'mine');
    });
});

describe('isDecisionResolved', () => {

    test('a recorded decision is resolved', () => {
        assert.equal(isDecisionResolved({ summary: 's', decision: 'do it' }), true);
    });

    test('no decision, or a blank one, is unresolved', () => {
        assert.equal(isDecisionResolved({ summary: 's' }), false);
        assert.equal(isDecisionResolved({ summary: 's', decision: '   ' }), false);
    });
});

describe('hasUnresolvedDecisions', () => {

    test('no decisions at all → nothing to wait for', () => {
        assert.equal(hasUnresolvedDecisions(undefined), false);
        assert.equal(hasUnresolvedDecisions([]), false);
    });

    test('one unresolved decision is enough', () => {
        assert.equal(hasUnresolvedDecisions([
            { summary: 'a', decision: 'yes' },
            { summary: 'b' },
        ]), true);
    });

    test('every decision recorded → nothing left to wait for', () => {
        assert.equal(hasUnresolvedDecisions([
            { summary: 'a', decision: 'yes' },
            { summary: 'b', decision: 'no' },
        ]), false);
    });
});
