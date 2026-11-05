/**
 * The todo panel's sort picker: grouping on or off, and the `id` sort
 * (media/questTodoPanel/main.js, grouping.js).
 *
 *   QS-1 no sort field: the groups alphabetically, the todos in each by id in number order (2 before 10)
 *   QS-2 a sort field (title) orders the todos inside the groups; the groups stay where they are; ties by id
 *   QS-3 the picker offers `id` and a "Group by prefix" checkbox, on by default; off, the list is one plain
 *        list (no group headers) in the chosen order, the Sort button is marked, and the state saves
 *        `grouped: false`; a saved `grouped: false` restores it, Reset groups again
 */

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

function setup(t: { after(fn: () => void): void }): { w: Win; posted: Array<Record<string, unknown>> } {
    const dom = new JSDOM(`<body>${media('questTodoPanel', 'fragment.html')}</body>`, { runScripts: 'outside-only' });
    const w = dom.window as Win;
    t.after(() => w.close());
    const posted: Array<Record<string, unknown>> = [];
    w.vscode = { postMessage: (m: Record<string, unknown>) => posted.push(JSON.parse(JSON.stringify(m))), getState: () => undefined, setState: () => undefined };
    w.eval('var qtViewConfig = {};\n' + media('questTodoPanel', 'grouping.js') + media('questTodoPanel', 'main.js'));
    return { w, posted };
}

const TODOS = [
    { id: 'qr10', title: 'A ten', status: 'not-started' },
    { id: 'vex1', title: 'Z vex', status: 'not-started' },
    { id: 'qr2', title: 'C two', status: 'not-started' },
    { id: 'cleanup', title: 'B cleanup', status: 'not-started' },
    { id: 'qr1', title: 'B one', status: 'not-started' },
];

function load(w: Win): void {
    w.eval(`qtTodos = ${JSON.stringify(TODOS)};`);
    w.qtExpandAllGroups ? w.qtExpandAllGroups() : w.eval("qtGroupTodosByPrefix(qtTodos).forEach(function(g) { qtExpandedGroups['#' + g.prefix] = true; });");
    w.qtRenderList();
}
const rows = (w: Win): string[] => [...w.document.querySelectorAll('#qt-list-pane .qt-todo-item')].map((e: Win) => e.getAttribute('data-qt-id'));
const headers = (w: Win): number => w.document.querySelectorAll('#qt-list-pane .qt-group-header').length;

describe('todo panel: the sort picker', () => {
    test('QS-1: default order', (t) => {
        const { w } = setup(t);
        load(w);
        assert.equal(headers(w), 3);
        assert.deepEqual(rows(w), ['qr1', 'qr2', 'qr10', 'vex1', 'cleanup']);
    });

    test('QS-2: a sort field orders the todos inside the groups', (t) => {
        const { w } = setup(t);
        w.eval("qtSortFields = [{ field: 'title', asc: true }];");
        load(w);
        assert.deepEqual(rows(w), ['qr10', 'qr1', 'qr2', 'vex1', 'cleanup'], 'by title in each group; groups in place');
        w.eval("qtSortFields = [{ field: 'id', asc: false }];");
        w.qtRenderList();
        assert.deepEqual(rows(w), ['qr10', 'qr2', 'qr1', 'vex1', 'cleanup'], 'id descending: by number');
    });

    test('QS-3: grouping off and on', (t) => {
        const { w, posted } = setup(t);
        load(w);
        w.qtRenderSortPicker();
        const picker = w.document.getElementById('qt-sort-picker');
        assert.ok(picker.querySelector('[data-qt-sort-field="id"]'), 'the id sort is offered');
        const box = w.document.getElementById('qt-sp-group');
        assert.equal(box.checked, true, 'grouped by default');
        box.checked = false;
        box.dispatchEvent(new w.Event('change'));
        assert.equal(headers(w), 0, 'no group headers');
        assert.deepEqual(rows(w), ['cleanup', 'qr1', 'qr2', 'qr10', 'vex1'], 'one plain list, by id');
        assert.ok(w.document.getElementById('qt-btn-sort').classList.contains('active-indicator'), 'the Sort button is marked');
        const saved = posted.filter((m) => m.type === 'qtSaveState').pop() as { state: { grouped: boolean } };
        assert.equal(saved.state.grouped, false, 'saved');
        w.eval("qtSortFields = [{ field: 'title', asc: true }];");
        w.qtRenderList();
        assert.deepEqual(rows(w), ['qr10', 'cleanup', 'qr1', 'qr2', 'vex1'], 'plain list in the chosen order');

        w.document.getElementById('qt-sp-reset').click();
        assert.equal(headers(w), 3, 'Reset groups again');
        assert.equal(w.document.getElementById('qt-btn-sort').classList.contains('active-indicator'), false);

        const second = setup(t).w;
        second.qtHandleMessage({ type: 'qtState', state: { grouped: false } });
        load(second);
        assert.equal(headers(second), 0, 'a saved grouped: false restores');
    });
});
