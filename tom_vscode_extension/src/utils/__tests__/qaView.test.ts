/**
 * The Q&A page's model (src/utils/qaView.ts) and the decision answer rule (src/utils/todoDecisions.ts).
 *
 *   QV-1 the filter: current quest, the workspace's quests (the current one included), selected quests (existing only);
 *        a stored filter of unknown shape is the default
 *   QV-2 the Questions entries: only the shown quests, newest first, an answer given joined to its stored answer, a
 *        stored answer no journal names listed as an entry of this host
 *   QV-3 the Decisions entries: open first (no decision on a live todo still to do), then answered newest first; an
 *        archived todo's decision is never open; deleted files left out; the option letters
 *   QV-4 the counters: no marker = all new; markShown moves each quest's time to its newest entry; later entries new
 *   QV-5 answering a decision: the text written, the status flipped only when it was the last open one of a
 *        decision-needed todo; an unknown index or an empty answer is refused
 */

import test, { describe } from 'node:test';
import assert from 'node:assert/strict';

import {
    decisionEntriesOf, markShown, newCount, normaliseQaFilter, normaliseQaMarker, questionEntries, questsOfFilter, sortDecisionEntries,
} from '../qaView.js';
import { answerTodoDecision, decisionOptionLetters } from '../todoDecisions.js';
import type { QaItem } from '../qaJournal.js';
import type { UserAnswer } from '../userAnswers.js';

const stored = (id: string, quest: string, at: string): UserAnswer => ({
    id, at, windowId: 'w', quest, run: 'default', title: `T ${id}`, answer: 'a', suggestedPrompts: [{ label: 'P', text: 'p' }],
    suggestedTodos: [], read: false,
});
const item = (id: string, quest: string, time: string, extra: Partial<QaItem> = {}): QaItem => ({ id, kind: 'question', time, host: 'mbp', quest, ...extra } as QaItem);

describe('the Q&A page model', () => {
    test('QV-1: the filter', () => {
        const all = ['a', 'b', 'c'];
        assert.deepEqual(questsOfFilter({ scope: 'current', selected: [] }, 'a', [], all), ['a']);
        assert.deepEqual(questsOfFilter({ scope: 'current', selected: [] }, 'default', [], all), []);
        assert.deepEqual(questsOfFilter({ scope: 'workspace', selected: [] }, 'a', ['b', 'c'], all), ['a', 'b', 'c']);
        assert.deepEqual(questsOfFilter({ scope: 'selected', selected: ['c', 'zz'] }, 'a', [], all), ['c']);
        assert.deepEqual(normaliseQaFilter({ scope: 'nonsense', selected: 'x' }), { scope: 'current', selected: [] });
        assert.deepEqual(normaliseQaFilter({ scope: 'selected', selected: ['b', 'b', 3, ''] }), { scope: 'selected', selected: ['b'] });
    });

    test('QV-2: the Questions entries', () => {
        const items: QaItem[] = [
            item('q1', 'a', '2026-11-25T10:00:00Z'),
            item('g1', 'a', '2026-11-25T12:00:00Z', { kind: 'answerGiven', answerId: 's1', title: 'given' }),
            item('q2', 'b', '2026-11-25T13:00:00Z'),
        ];
        const store = [stored('s1', 'a', '2026-11-25T12:00:00Z'), stored('s2', 'a', '2026-11-25T11:00:00Z'), stored('s3', 'b', '2026-11-25T14:00:00Z')];
        const entries = questionEntries(items, store, ['a'], 'this-host');
        assert.deepEqual(entries.map((e) => e.key), ['a|g1', 'a|store-s2', 'a|q1']);
        assert.equal(entries[0].stored?.id, 's1', 'joined to its stored answer');
        assert.equal(entries[1].item.kind, 'answerGiven');
        assert.equal(entries[1].item.host, 'this-host');
        assert.deepEqual(entries[1].item.suggestedPrompts, ['P']);
        assert.equal(entries[2].stored, undefined);
    });

    test('QV-3: the Decisions entries', () => {
        const todos = [
            { id: 't1', title: 'One', status: 'decision-needed', updated: '2026-11-20', decisions: [{ summary: 'open one', decision_needed: 'Pick: (a) left, **(b)** right, (a) again' }, { summary: 'done one', decision: 'yes' }] },
            { id: 't2', description: 'Two\nmore', status: 'completed', completed_date: '2026-11-24', decisions: [{ summary: 'never answered' }] },
            { id: 't3', status: 'not-started', updated: '2026-11-22', decisions: [{ summary: 'open three' }] },
            { id: 't4', status: 'decision-needed', decisions: [{ summary: 'deleted' }], _sourceFile: 'todos-deleted.q.todo.yaml' },
            { id: 't5', status: 'completed', completed_date: '2026-11-25', decisions: [{ summary: 'archived', decision: 'b' }], _sourceFile: 'todos-archived.q.todo.yaml' },
            { id: 't6', status: 'decision-needed', decisions: [{ summary: 'archived open' }], _sourceFile: 'todos-archived.q.todo.yaml', updated: '2026-11-01' },
        ];
        const entries = sortDecisionEntries(decisionEntriesOf('q', todos));
        assert.deepEqual(entries.map((e) => [e.summary, e.open]), [
            ['open three', true], ['open one', true],
            ['archived', false], ['never answered', false], ['done one', false], ['archived open', false],
        ]);
        assert.deepEqual(entries[1].options, ['a', 'b']);
        assert.equal(entries[1].key, 'q|t1|0');
        assert.equal(entries[3].todoTitle, 'Two');
        assert.equal(entries[2].archived, true);
        assert.deepEqual(decisionOptionLetters('(a) one\n(b) two\n- (c) three'), ['a', 'b', 'c']);
        assert.deepEqual(decisionOptionLetters('call f(x) twice'), []);
    });

    test('QV-4: the counters', () => {
        const items = [item('q1', 'a', '2026-11-25T10:00:00Z'), item('q2', 'a', '2026-11-25T11:00:00Z'), item('q3', 'b', '2026-11-25T09:00:00Z')];
        const entries = questionEntries(items, [], ['a', 'b'], 'h');
        assert.equal(newCount(entries, 'questions', {}), 3, 'no marker: all new');
        const marker = markShown({}, entries, 'questions');
        assert.deepEqual(marker, { a: { questions: Date.parse('2026-11-25T11:00:00Z') }, b: { questions: Date.parse('2026-11-25T09:00:00Z') } });
        assert.equal(newCount(entries, 'questions', marker), 0);
        const later = questionEntries([...items, item('q4', 'b', '2026-11-25T12:00:00Z')], [], ['a', 'b'], 'h');
        assert.equal(newCount(later, 'questions', marker), 1);
        assert.equal(newCount(later, 'decisions', marker), 4, 'the other tab has its own marker');
        assert.deepEqual(normaliseQaMarker({ a: { questions: 5, decisions: 'x' }, b: 3 }), { a: { questions: 5 } });
    });

    test('QV-5: answering a decision', () => {
        const decisions = [{ summary: 'one' }, { summary: 'two', decision: 'done' }, { summary: 'three' }];
        const first = answerTodoDecision(decisions, 'decision-needed', 0, '  (b) because  ');
        assert.deepEqual(first, { decisions: [{ summary: 'one', decision: '(b) because' }, { summary: 'two', decision: 'done' }, { summary: 'three' }] });
        const last = answerTodoDecision(first!.decisions, 'decision-needed', 2, 'yes');
        assert.equal(last?.status, 'not-started');
        assert.equal(answerTodoDecision(first!.decisions, 'in-progress', 2, 'yes')?.status, undefined, 'only decision-needed flips');
        assert.equal(answerTodoDecision(decisions, 'decision-needed', 5, 'x'), undefined);
        assert.equal(answerTodoDecision(decisions, 'decision-needed', 0, '  '), undefined);
    });
});
