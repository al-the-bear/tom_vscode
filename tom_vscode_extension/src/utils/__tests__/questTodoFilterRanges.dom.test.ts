/**
 * The todo panel's filter: the Completed date range and the Blocking section
 * (media/questTodoPanel/main.js).
 *
 *   QF-1 a Completed range keeps only the todos completed inside it; a todo without a completed_date
 *        is dropped while either bound is set
 *   QF-2 the picker offers a Completed row beside Created and Updated, and its inputs write the state
 *   QF-3 a Completed bound or a Blocking choice makes the filter active; a saved state without them
 *        restores as "all"
 *   QF-4 the Blocking section keeps the todos that block open todos (yes), the others (no), or all
 */

/* eslint-disable @typescript-eslint/naming-convention -- `completed_date` is the todo schema's YAML key */
import test, { describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { JSDOM } from 'jsdom';

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
    { id: 'cd1', title: 'Early', status: 'completed', completed_date: '2026-10-01' },
    { id: 'cd2', title: 'Inside', status: 'completed', completed_date: '2026-10-15' },
    { id: 'cd3', title: 'Late', status: 'completed', completed_date: '2026-11-02' },
    { id: 'cd4', title: 'Open', status: 'not-started', blocking: ['cd5'] },
    { id: 'cd5', title: 'Waits', status: 'blocked' },
    { id: 'cd6', title: 'Blocks a done one', status: 'not-started', blocking: ['cd2'] },
];

function load(w: Win): void {
    w.eval(`qtTodos = ${JSON.stringify(todos)};`);
    w.qtExpandAllGroups();
    w.qtRenderList();
}

const rows = (w: Win): string[] =>
    [...w.document.querySelectorAll('#qt-list-pane .qt-todo-item')].map((e: Win) => e.getAttribute('data-qt-id')).sort();

describe('todo panel: filter ranges', () => {
    test('QF-1: the Completed range', (t) => {
        const w = setup(t);
        load(w);
        assert.deepEqual(rows(w), ['cd1', 'cd2', 'cd3', 'cd4', 'cd5', 'cd6']);
        w.eval("qtFilterState.completedFrom = '2026-10-10'; qtFilterState.completedTo = '2026-10-31';"); w.qtRenderList();
        assert.deepEqual(rows(w), ['cd2'], 'only the todo completed inside the range');
        w.eval("qtFilterState.completedTo = '';"); w.qtRenderList();
        assert.deepEqual(rows(w), ['cd2', 'cd3'], 'a lower bound alone');
        w.eval("qtFilterState.completedFrom = ''; qtFilterState.completedTo = '2026-10-01';"); w.qtRenderList();
        assert.deepEqual(rows(w), ['cd1'], 'an upper bound alone, inclusive, and no todo without a completed_date');
    });

    test('QF-2: the picker row', (t) => {
        const w = setup(t);
        load(w);
        w.qtRenderFilterPicker();
        const from = w.document.getElementById('qt-fp-completed-from');
        const to = w.document.getElementById('qt-fp-completed-to');
        assert.ok(from && to, 'the picker has the Completed inputs');
        assert.ok(w.document.getElementById('qt-fp-created-from') && w.document.getElementById('qt-fp-updated-from'));
        from.value = '2026-10-10';
        from.dispatchEvent(new w.Event('change'));
        to.value = '2026-10-31';
        to.dispatchEvent(new w.Event('change'));
        w.document.getElementById('qt-fp-ok').click();
        assert.deepEqual(rows(w), ['cd2']);
        w.qtRenderFilterPicker();
        assert.equal(w.document.getElementById('qt-fp-completed-from').value, '2026-10-10', 'the picker shows the stored range');
    });

    test('QF-3: the active-filter test and the saved state', (t) => {
        const w = setup(t);
        assert.equal(w.qtHasActiveFilters(), false);
        w.eval("qtFilterState.completedTo = '2026-10-31';");
        assert.equal(w.qtHasActiveFilters(), true, 'a Completed bound');
        w.eval('qtFilterState = qtEmptyFilterState(); qtFilterState.blocking = ["yes"];');
        assert.equal(w.qtHasActiveFilters(), true, 'a Blocking choice');
        const js = media('questTodoPanel', 'main.js');
        assert.match(js, /completedFrom: fs\.completedFrom \|\| '',/);
        assert.match(js, /blocking: fs\.blocking \|\| \[\],/, 'an older saved state restores as all');
    });

    test('QF-4: the Blocking section', (t) => {
        const w = setup(t);
        load(w);
        w.eval("qtFilterState.blocking = ['yes'];"); w.qtRenderList();
        assert.deepEqual(rows(w), ['cd4'], 'only a todo that blocks an open todo (cd6 blocks a completed one)');
        w.eval("qtFilterState.blocking = ['no'];"); w.qtRenderList();
        assert.deepEqual(rows(w), ['cd1', 'cd2', 'cd3', 'cd5', 'cd6']);
        w.qtRenderFilterPicker();
        assert.equal(w.document.querySelectorAll('[data-qt-filter-type="blocking"]').length, 2, 'the picker offers both');
    });
});
