/**
 * The todo panel and a todo's target date `due` (media/questTodoPanel/main.js, vscimpb152aa).
 *
 *   QDU-1 a row of an overdue todo wears the red calendar with its date and the `overdue` class (the title red);
 *         a row with a date not yet passed wears the quiet date chip; a row without a date neither
 *   QDU-2 the filter: Overdue yes keeps only the overdue rows, no only the others, and counts as an active filter
 *   QDU-3 the detail form: a Due date field (red when overdue, the reminder's time when it went out), sent with
 *         a save as `due` ("" when emptied)
 *   QDU-4 the list row's data (todoListItem) carries `due` and `overdue` (derived, against the day given)
 */

/* eslint-disable @typescript-eslint/naming-convention -- the todo schema's YAML keys */
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
    { id: 'dd1', title: 'Late', status: 'in-progress', due: '2026-11-30', overdue: true },
    { id: 'dd2', title: 'Soon', status: 'not-started', due: '2026-12-09' },
    { id: 'dd3', title: 'Undated', status: 'not-started' },
];

describe('todo panel: due dates', () => {
    test('QDU-1: the row marks', (t) => {
        const w = setup(t);
        const late = w.qtRenderTodoRow(todos[0]);
        assert.match(late, /class="qt-todo-item status-in-progress overdue/);
        assert.match(late, /<span class="qt-due qt-overdue" title="Overdue: it was due on 2026-11-30"><span class="codicon codicon-calendar"><\/span> 2026-11-30<\/span>/);
        const soon = w.qtRenderTodoRow(todos[1]);
        assert.match(soon, /<span class="qt-due" title="Due on 2026-12-09">/);
        assert.doesNotMatch(soon, /overdue/);
        assert.doesNotMatch(w.qtRenderTodoRow(todos[2]), /qt-due/);
        const css = media('questTodoPanel', 'style.css');
        assert.match(css, /\.qt-todo-item \.qt-due\.qt-overdue \{[^}]*color: var\(--vscode-errorForeground/);
        assert.match(css, /\.qt-todo-item\.overdue \.ttitle \{[^}]*color: var\(--vscode-errorForeground/);
    });

    test('QDU-2: the overdue filter', (t) => {
        const w = setup(t);
        w.eval(`qtTodos = ${JSON.stringify(todos)}; qtGroupByPrefix = false;`);
        w.eval(`qtFilterState.overdue = ['yes'];`);
        assert.equal(w.qtHasActiveFilters(), true);
        w.qtRenderList();
        const ids = (): string[] => [...w.document.querySelectorAll('.qt-todo-item')].map((e: Win) => e.getAttribute('data-qt-id'));
        assert.deepEqual(ids(), ['dd1']);
        w.eval(`qtFilterState.overdue = ['no'];`);
        w.qtRenderList();
        assert.deepEqual(ids().sort(), ['dd2', 'dd3']);
        w.eval(`qtFilterState.overdue = [];`);
        assert.equal(w.qtHasActiveFilters(), false);
        w.qtRenderFilterPicker();
        assert.ok(w.document.querySelector('[data-qt-filter-type="overdue"][data-qt-filter-val="yes"]'), 'the picker offers it');
    });

    test('QDU-3: the detail form', (t) => {
        const w = setup(t);
        w.qtRenderDetail({ id: 'dd1', title: 'Late', status: 'in-progress', due: '2026-11-30', overdue: true, due_reminded: '2026-11-30T09:00+01:00' });
        const input = w.document.getElementById('qt-d-due-date');
        assert.ok(input, 'a Due field');
        assert.equal(input.value, '2026-11-30');
        assert.equal(input.className, 'qt-overdue-input');
        assert.match(w.document.querySelector('.qt-due-reminded').textContent, /2026-11-30 09:00/);
        assert.equal(w.qtCollectFormData().due, '2026-11-30');
        input.value = '';
        assert.equal(w.qtCollectFormData().due, '', 'emptied: removed on save');
        w.qtRenderDetail({ id: 'dd3', title: 'Undated', status: 'not-started' });
        assert.equal(w.document.getElementById('qt-d-due-date').value, '');
        assert.equal(w.document.querySelector('.qt-due-reminded'), null);
    });

    test('QDU-4: the list row data', () => {
        const late = todoListItem({ id: 'a', status: 'blocked', due: '2026-11-30' }, 'f', 'a', '2026-12-01');
        assert.deepEqual([late.due, late.overdue], ['2026-11-30', true]);
        const today = todoListItem({ id: 'b', status: 'not-started', due: '2026-12-01' }, 'f', 'b', '2026-12-01');
        assert.deepEqual([today.due, today.overdue], ['2026-12-01', undefined]);
        const done = todoListItem({ id: 'c', status: 'completed', due: '2026-11-30' }, 'f', 'c', '2026-12-01');
        assert.equal(done.overdue, undefined);
        assert.equal('due' in todoListItem({ id: 'd', status: 'not-started' }, 'f'), false);
    });
});
