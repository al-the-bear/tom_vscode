/**
 * Tests for the **Decisions** journal markdown shapes.
 *
 * The journal is the durable record of what the user decided: a todo carries
 * its open questions in `decisions[]` while it is alive, and when it is
 * archived the todo leaves the active file — so without the journal the
 * decision disappears with it. What is pinned here is therefore mostly about
 * *loss*: the todo id, the timestamp, and every decision including the ones
 * that were never answered.
 */
import test, { describe } from 'node:test';
import assert from 'node:assert/strict';

import {
    decisionsJournalHeader,
    formatDecisionJournalEntry,
    type DecisionJournalEntry,
} from '../decisionsJournalFormat.js';

const AT = Date.parse('2026-08-03T09:41:07.000Z');

function entry(over: Partial<DecisionJournalEntry> = {}): DecisionJournalEntry {
    return {
        todoId: 'vex1_agäo-storage',
        title: 'Pick the storage backend',
        archivedAt: AT,
        decisions: [{ summary: 'sqlite or postgres', decision: 'postgres' }],
        ...over,
    };
}

describe('formatDecisionJournalEntry', () => {
    test('records the todo id and the archive timestamp', () => {
        const md = formatDecisionJournalEntry(entry());
        assert.match(md, /vex1_agäo-storage/, 'todo id present');
        assert.match(md, /2026-08-03T09:41:07\.000Z/, 'full date and time present');
    });

    test('the entry heading is a level-2 heading so entries are separable', () => {
        const md = formatDecisionJournalEntry(entry());
        assert.match(md, /^## /m);
    });

    test('carries the todo title alongside the id', () => {
        const md = formatDecisionJournalEntry(entry());
        assert.match(md, /Pick the storage backend/);
    });

    test('a todo with no title still records the id', () => {
        const md = formatDecisionJournalEntry(entry({ title: undefined }));
        assert.match(md, /vex1_agäo-storage/);
    });

    test('writes the summary, the question and the answer', () => {
        const md = formatDecisionJournalEntry(entry({
            decisions: [{
                summary: 'sqlite or postgres',
                decision_needed: 'Local dev wants sqlite; the fleet needs concurrent writers.',
                decision: 'postgres — the fleet requirement wins.',
            }],
        }));
        assert.match(md, /sqlite or postgres/);
        assert.match(md, /the fleet needs concurrent writers/);
        assert.match(md, /the fleet requirement wins/);
    });

    test('an unresolved decision is recorded, visibly unanswered', () => {
        // The whole point of archiving with an open decision is that it was
        // never settled. Dropping it would make the journal claim otherwise.
        const md = formatDecisionJournalEntry(entry({
            decisions: [{ summary: 'retry budget', decision_needed: 'How many retries?' }],
        }));
        assert.match(md, /retry budget/);
        assert.match(md, /How many retries\?/);
        assert.match(md, /not decided/i);
    });

    test('every decision of a todo is written, in order', () => {
        const md = formatDecisionJournalEntry(entry({
            decisions: [
                { summary: 'first thing', decision: 'a' },
                { summary: 'second thing', decision: 'b' },
                { summary: 'third thing' },
            ],
        }));
        assert.ok(md.indexOf('first thing') < md.indexOf('second thing'));
        assert.ok(md.indexOf('second thing') < md.indexOf('third thing'));
    });

    test('multi-line decision text stays inside its own bullet', () => {
        // A raw newline would end the list item and let the continuation render
        // as a sibling of the next decision.
        const md = formatDecisionJournalEntry(entry({
            decisions: [{
                summary: 'schema',
                decision: 'Use JSON Schema.\nDraft 2020-12, no exceptions.',
            }],
        }));
        const continuation = md.split('\n').find(l => l.includes('Draft 2020-12'));
        assert.ok(continuation, 'continuation line present');
        assert.match(continuation!, /^\s+\S/, 'continuation line is indented');
    });

    test('ends with exactly one trailing newline so entries append cleanly', () => {
        const md = formatDecisionJournalEntry(entry());
        assert.match(md, /[^\n]\n$/);
    });

    test('a todo whose decisions list is empty produces nothing', () => {
        assert.equal(formatDecisionJournalEntry(entry({ decisions: [] })), '');
    });
});

describe('decisionsJournalHeader', () => {
    test('names the quest', () => {
        assert.match(decisionsJournalHeader('vscode_extension'), /vscode_extension/);
    });

    test('starts with a level-1 heading and ends with a blank separator', () => {
        const header = decisionsJournalHeader('vscode_extension');
        assert.match(header, /^# /);
        assert.match(header, /\n\n$/);
    });
});
