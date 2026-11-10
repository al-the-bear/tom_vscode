/**
 * The todo panel and `decision-needed` todos (media/questTodoPanel/main.js; the panel serves QUEST TODOS,
 * the @WS Quest TODO section and the todo editor alike).
 *
 *   QD-1 a list row of a `decision-needed` todo carries the yellow "decision-needed" chip, its tooltip naming
 *        the open decisions and that a walk holds only when it reaches the todo; any other row has none
 *   QD-2 a group header carries a yellow ❓ with the count of its decision-needed todos, the tooltip naming
 *        them; a group without one has none
 *   QD-3 the detail form shows the chip beside the status; the stylesheet colours the chip warning yellow
 *   QD-4 the list row's data (todoListItem) carries the summaries of the open decisions, only for a
 *        decision-needed todo
 */

/* eslint-disable @typescript-eslint/naming-convention -- `open_decisions` is a list-row field like `user_action` */
import test, { describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { JSDOM } from 'jsdom';

import { todoListItem } from '../todoListItem.js';

function media(...parts: string[]): string {
    return readFileSync(join(__dirname, '..', '..', '..', 'media', ...parts), 'utf-8');
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Win = any;

function setup(t: { after(fn: () => void): void }): Win {
    const dom = new JSDOM(`<body>${media('questTodoPanel', 'fragment.html')}</body>`, { runScripts: 'outside-only' });
    const w = dom.window as Win;
    t.after(() => w.close());
    w.vscode = { postMessage: () => undefined, getState: () => undefined, setState: () => undefined };
    w.eval('var qtViewConfig = {};\n' + media('questTodoPanel', 'grouping.js') + media('questTodoPanel', 'main.js'));
    return w;
}

const todos = [
    { id: 'vbs1', title: 'Build it', status: 'not-started' },
    { id: 'vbs2', title: 'Ship it', status: 'not-started' },
    { id: 'vbs3', title: 'Pick a backend', status: 'decision-needed', open_decisions: ['Which store', 'Which region'] },
    { id: 'qr1', title: 'Drivers', status: 'not-started' },
];

describe('todo panel: decision-needed todos', () => {
    test('QD-1: the row chip', (t) => {
        const w = setup(t);
        const row = w.qtRenderTodoRow(todos[2]);
        assert.match(row, /<span class="qt-decision-chip" title="Decision needed \(2 open\): Which store; Which region — a prefix\* walk holds when it reaches this todo">decision-needed<\/span>/);
        assert.doesNotMatch(w.qtRenderTodoRow(todos[0]), /qt-decision-chip/);
        assert.match(w.qtRenderTodoRow({ id: 'x1', status: 'decision-needed' }), /title="Decision needed: answer its decisions in the todo/);
    });

    test('QD-2: the group header', (t) => {
        const w = setup(t);
        w.eval(`qtTodos = ${JSON.stringify(todos)};`);
        w.qtRenderList();
        const vbs = w.document.querySelector('.qt-group-header[data-qt-group="vbs"]');
        const mark = vbs.querySelector('.qt-group-decisions');
        assert.ok(mark, 'the vbs group carries the chip');
        assert.equal(mark.textContent, '❓1');
        assert.equal(mark.getAttribute('title'), '1 todo with open decisions: vbs3 (Pick a backend) — Which store; Which region');
        assert.equal(w.document.querySelector('.qt-group-header[data-qt-group="qr"] .qt-group-decisions'), null);
        const two = w.qtGroupDecisionMark({ todos: [todos[2], { id: 'vbs5', status: 'decision-needed' }] });
        assert.match(two, />❓2</);
        assert.match(two, /2 todos with open decisions: vbs3 \(Pick a backend\) — Which store; Which region; vbs5 — answer its decisions in the todo/);
    });

    test('QD-3: the detail form and the colour', (t) => {
        const w = setup(t);
        w.qtRenderDetail({ id: 'vbs3', title: 'Pick a backend', status: 'decision-needed', decisions: [{ summary: 'Which store', decision_needed: '(a) or (b)' }, { summary: 'Done one', decision: '(a)' }] });
        const chip = w.document.querySelector('#qt-detail-pane .qt-decision-chip');
        assert.ok(chip, 'beside the status');
        assert.match(chip.getAttribute('title'), /\(1 open\): Which store/);
        w.qtRenderDetail({ id: 'vbs1', title: 'Build it', status: 'not-started' });
        assert.equal(w.document.querySelector('#qt-detail-pane .qt-decision-chip'), null);
        assert.match(media('questTodoPanel', 'style.css'), /\.qt-decision-chip \{[^}]*color: var\(--vscode-editorWarning-foreground/);
    });

    test('QD-4: the row data', () => {
        const row = todoListItem({ id: 'vbs3', status: 'decision-needed', decisions: [{ summary: 'Which store' }, { summary: 'Settled', decision: '(b)' }, {}] }, 'todos.q.todo.yaml');
        assert.deepEqual(row.open_decisions, ['Which store', '(a decision)']);
        assert.equal(todoListItem({ id: 'vbs1', status: 'not-started', decisions: [{ summary: 'x' }] }, 'f').open_decisions, undefined);
    });
});
