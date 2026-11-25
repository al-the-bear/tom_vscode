/**
 * The Recent prompts panel's collector (src/utils/recentPrompts.ts).
 *
 *   RP-1 prompts are counted across stages: pre-prompts (with their repetitions), the main prompt per
 *        iteration, a walk iteration's continuations, follow-ups (with their repetitions)
 *   RP-2 a repeated item's main stage is one iteration per repetition / walked todo, each with its answer
 *        (`repetitionAnswers`, the turns before the last from `earlier`); the last dispatched prompt shows its
 *        expanded text, the others the text as queued; a TODO item's single iteration is not a group
 *   RP-3 rows newest first; at most 100 prompts — the row crossing the limit keeps its newest prompts, older rows go
 *   RP-4 chat sends: one prompt with its answer or error; items that never went out are left out
 *   RP-5 a row: kind, todos with titles, the first line, settings (profile by name, no "(None)" template),
 *        the time, the start of the last answer (about 200 characters, whitespace folded)
 */

import test, { describe } from 'node:test';
import assert from 'node:assert/strict';

import { answerStart, collectRecentPrompts, countPrompts, recentPromptRow, RECENT_PROMPTS_LIMIT, type RecentPromptSourceItem } from '../recentPrompts.js';
import { continuationPrompt } from '../walkCompletionCheck.js';

function item(over: Partial<RecentPromptSourceItem> & { id: string }): RecentPromptSourceItem {
    return { status: 'sent', originalText: `prompt of ${over.id}`, createdAt: '2026-11-20T10:00:00.000Z', sentAt: '2026-11-20T10:00:00.000Z', ...over };
}

describe('recent prompts — the collector', () => {
    test('RP-1: counting prompts across stages and iterations', () => {
        const row = recentPromptRow(item({
            id: 'a', repeatCount: 3, repeatIndex: 3, iterationSeq: 3, itemKind: 'iteration',
            prePrompts: [{ text: 'pp', status: 'sent', repeatIndex: 2, answerText: 'pp answer' }],
            followUps: [{ originalText: 'fu', repeatIndex: 1, answerText: 'fu answer' }],
            answerText: 'main 3',
        }))!;
        assert.equal(row.promptCount, 2 + 3 + 1);
        assert.deepEqual(row.nodes.map((n) => (n.type === 'prompt' ? n.prompt.label : `${n.label} [${n.prompts.length}]`)), [
            'Pre-prompt 1 (1/2)', 'Pre-prompt 1 (2/2)', 'Repetition 1 [1]', 'Repetition 2 [1]', 'Repetition 3 [1]', 'Follow-up 1',
        ]);
        // A pre-prompt known as sent only by its status counts once.
        assert.equal(recentPromptRow(item({ id: 'b', prePrompts: [{ text: 'pp', status: 'sent' }], answerText: 'x' }))!.promptCount, 2);
        // A walk iteration with continuations is one prompt per turn.
        const walk = recentPromptRow(item({
            id: 'w', repeatCount: 'abc*', walkedTodos: ['abc1', 'abc2'],
            repetitionAnswers: [
                { key: 'abc1', text: 'done 1', at: '2026-11-20T10:01:00.000Z' },
                { key: 'abc2', text: 'done 2 at last', at: '2026-11-20T10:05:00.000Z', continuations: 2, earlier: ['first try', 'second try'] },
            ],
        }))!;
        assert.equal(walk.kind, 'prefix');
        assert.equal(walk.promptCount, 1 + 3);
        assert.equal(countPrompts(walk.nodes), 4);
    });

    test('RP-2: iterations, their answers and the text as sent', () => {
        const walk = recentPromptRow(item({
            id: 'w', repeatCount: 'abc*', walkedTodos: ['abc1', 'abc2'], repeatTodoId: 'abc2',
            repetitionAnswers: [
                { key: 'abc1', text: 'done 1', at: '2026-11-20T10:01:00.000Z' },
                { key: 'abc2', text: 'done 2', at: '2026-11-20T10:05:00.000Z', continuations: 1, earlier: ['not yet'] },
            ],
            lastDispatched: { kind: 'main', expandedText: 'EXPANDED abc2', dispatchedAt: '2026-11-20T10:03:00.000Z' },
        }), { todoTitle: (id) => (id === 'abc1' ? 'First' : undefined) })!;
        const [it1, it2] = walk.nodes;
        assert.ok(it1.type === 'iteration' && it2.type === 'iteration');
        assert.equal(it1.label, 'Todo abc1 — First');
        assert.equal(it1.todoTitle, 'First');
        assert.deepEqual(it1.prompts.map((p) => [p.label, p.text, p.expanded, p.answer]), [['Main prompt', 'prompt of w', false, 'done 1']]);
        assert.deepEqual(it2.prompts.map((p) => [p.stage, p.text, p.expanded, p.answer]), [
            ['main', 'EXPANDED abc2', true, 'not yet'],
            ['continuation', continuationPrompt('abc2'), true, 'done 2'],
        ]);
        assert.equal(walk.lastAnswerStart, 'done 2');
        // Pre-prompt and follow-up: the last dispatched one is as sent.
        const staged = recentPromptRow(item({
            id: 'f', prePrompts: [{ text: 'pp', status: 'sent', repeatIndex: 1, answerText: 'ppa' }],
            followUps: [{ originalText: 'fu1', repeatIndex: 1, answerText: 'fa1' }, { originalText: 'fu2', repeatIndex: 1, answerText: 'fa2' }],
            answerText: 'ma',
            lastDispatched: { kind: 'followUp', followUpIndex: 1, expandedText: 'FU2 EXPANDED', dispatchedAt: '2026-11-20T10:09:00.000Z' },
        }))!;
        assert.deepEqual(staged.nodes.map((n) => n.type === 'prompt' && [n.prompt.text, n.prompt.expanded, n.prompt.answer]), [
            ['pp', false, 'ppa'], ['prompt of f', false, 'ma'], ['fu1', false, 'fa1'], ['FU2 EXPANDED', true, 'fa2'],
        ]);
        // A TODO item: one iteration, shown as prompts, not as a group.
        const todo = recentPromptRow(item({ id: 't', repeatCount: 'todo:q/abc7', answerText: 'did it' }))!;
        assert.equal(todo.kind, 'todo');
        assert.deepEqual(todo.nodes.map((n) => n.type), ['prompt']);
        assert.deepEqual(todo.todos, [{ id: 'abc7' }]);
    });

    test('RP-3: newest first, at most 100 prompts', () => {
        const items: RecentPromptSourceItem[] = [];
        for (let i = 0; i < 30; i++) {
            const at = new Date(Date.UTC(2026, 10, 20, 10, i)).toISOString();
            items.push(item({ id: `i${i}`, sentAt: at, repeatCount: 4, repeatIndex: 4, iterationSeq: 4, itemKind: 'iteration', answerText: `a${i}` }));
        }
        const { rows, promptCount, truncated } = collectRecentPrompts(items);
        assert.equal(RECENT_PROMPTS_LIMIT, 100);
        assert.equal(promptCount, 100);
        assert.equal(truncated, true);
        assert.deepEqual(rows.slice(0, 3).map((r) => r.id), ['i29', 'i28', 'i27'], 'newest first');
        assert.equal(rows.length, 25, '25 rows of 4');
        // The row that crosses the limit keeps its newest prompts.
        const odd = [...items.slice(0, 24), item({ id: 'p', sentAt: '2026-11-19T09:00:00.000Z', repeatCount: 7, repeatIndex: 7, iterationSeq: 7, itemKind: 'iteration', answerText: 'last' })];
        const cut = collectRecentPrompts(odd);
        const last = cut.rows[cut.rows.length - 1];
        assert.equal(last.id, 'p');
        assert.equal(last.promptCount, 4);
        assert.deepEqual(last.nodes.map((n) => n.type === 'iteration' && n.label), ['Repetition 4', 'Repetition 5', 'Repetition 6', 'Repetition 7']);
        assert.equal(cut.promptCount, 100);
        // Ordered by the last dispatch when it is newer than the item's send time.
        const order = collectRecentPrompts([
            item({ id: 'old', sentAt: '2026-11-20T08:00:00.000Z', answerText: 'x' }),
            item({ id: 'new', sentAt: '2026-11-20T07:00:00.000Z', answerText: 'y', lastDispatched: { kind: 'main', expandedText: 'y', dispatchedAt: '2026-11-20T09:00:00.000Z' } }),
        ]);
        assert.deepEqual(order.rows.map((r) => r.id), ['new', 'old']);
        assert.equal(order.truncated, false);
    });

    test('RP-4: chat sends; items that never went out', () => {
        const { rows } = collectRecentPrompts([
            item({ id: 'c1', status: 'chat-sent', chatSource: 'panel', expandedText: 'hello there', answerText: 'hi', itemKind: 'chat' }),
            item({ id: 'c2', status: 'chat-sent', chatSource: 'editor', expandedText: 'boom', error: 'quota', sentAt: '2026-11-20T11:00:00.000Z' }),
            item({ id: 'staged', status: 'staged', sentAt: undefined }),
            item({ id: 'pending', status: 'pending', sentAt: undefined, repeatCount: 3 }),
        ]);
        assert.deepEqual(rows.map((r) => r.id), ['c2', 'c1']);
        const [err, ok] = rows;
        assert.equal(ok.kind, 'chat');
        assert.equal(ok.promptCount, 1);
        assert.deepEqual(ok.nodes[0].type === 'prompt' && [ok.nodes[0].prompt.label, ok.nodes[0].prompt.text, ok.nodes[0].prompt.expanded, ok.nodes[0].prompt.answer], ['Chat send (panel)', 'hello there', true, 'hi']);
        assert.ok(err.nodes[0].type === 'prompt' && err.nodes[0].prompt.error === true && err.nodes[0].prompt.answer === 'Error: quota');
        assert.equal(err.lastAnswerStart, 'Error: quota');
    });

    test('RP-5: a row\'s headline, settings and answer start', () => {
        const long = `${'word '.repeat(80)}\n\nend`;
        const row = recentPromptRow(item({
            id: 'r', originalText: '\n  First line here\nsecond', template: '(None)', run: 'rel1', session: 'work', anthropicProfileId: 'p1', role: 'coder',
            todoIdPattern: 'abc3, xyz*', answerText: long,
        }), { todoTitle: (id) => (id === 'abc3' ? 'Third' : undefined), profileName: (id) => (id === 'p1' ? 'Opus' : undefined) })!;
        assert.equal(row.kind, 'prompt');
        assert.equal(row.firstLine, 'First line here');
        assert.deepEqual(row.todos, [{ id: 'abc3', title: 'Third' }, { id: 'xyz*' }]);
        assert.deepEqual(row.settings, { run: 'rel1', session: 'work', profile: 'Opus', role: 'coder' });
        assert.equal(row.sentAt, '2026-11-20T10:00:00.000Z');
        assert.ok(row.lastAnswerStart.length <= 201 && row.lastAnswerStart.endsWith('…'));
        assert.ok(!/\s{2}/.test(row.lastAnswerStart), 'whitespace folded');
        assert.equal(answerStart('  a \n b  '), 'a b');
        const plain = recentPromptRow(item({ id: 'd', template: 'execute-todo', answerText: 'ok' }))!;
        assert.deepEqual(plain.settings, { run: 'default', template: 'execute-todo' });
        assert.deepEqual(recentPromptRow(item({ id: 'g', repeatCount: 'group:q/rel', walkedTodos: ['m1'], answerText: 'a' }), { todoTitle: () => 'Release' })!.todos, [{ id: 'rel', title: 'Release' }]);
    });
});
