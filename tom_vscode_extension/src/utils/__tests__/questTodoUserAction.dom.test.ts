/**
 * The todo panel and `user_action` (media/questTodoPanel/main.js).
 *
 *   QU-1 a list row of a user-action todo carries the 👤 mark; any other row does not
 *   QU-2 the detail form's checkbox shows the field, and the form data carries it: true when checked,
 *        false when not (an update then removes the key)
 *   QU-3 a user-action row carries the `user-action` class, whose title the stylesheet colours yellow
 *   QU-4 the filter's "User action" section keeps the user's own todos (yes), the others (no), or all
 *        (none); a filter state saved before the field existed restores as "all"
 *   QU-5 the 👤 toggle shows only the user's own todos and opens every prefix group; again, all todos
 *   QU-6 "Expand all" opens every prefix group, "Collapse all" closes them
 */

/* eslint-disable @typescript-eslint/naming-convention -- `user_action` is the todo schema's YAML key */
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

describe('todo panel: user-action todos', () => {
    test('QU-1: the list row', (t) => {
        const w = setup(t);
        const mine = w.qtRenderTodoRow({ id: 'vbs3', title: 'Look at it', status: 'not-started', user_action: true });
        const other = w.qtRenderTodoRow({ id: 'vbs4', title: 'Build it', status: 'not-started' });
        assert.match(mine, /class="qt-user-action"[^>]*>👤</);
        assert.doesNotMatch(other, /qt-user-action/);
    });

    test('QU-2: the detail form', (t) => {
        const w = setup(t);
        const pane = w.document.getElementById('qt-detail-pane');
        assert.ok(pane, 'the fragment has a detail pane');
        pane.innerHTML = '<input type="checkbox" id="qt-d-user-action" checked>';
        assert.equal(w.qtCollectFormData().user_action, true);
        w.document.getElementById('qt-d-user-action').checked = false;
        assert.equal(w.qtCollectFormData().user_action, false);
        pane.innerHTML = '';
        assert.equal(w.qtCollectFormData().user_action, undefined, 'the new-todo form has no checkbox: nothing to write');
        const form = media('questTodoPanel', 'main.js');
        assert.match(form, /id="qt-d-user-action"' \+ \(todo\.user_action === true \? ' checked' : ''\)/, 'the detail form shows the stored value');
    });

    const todos = [
        { id: 'vbs3', title: 'Look at it', status: 'not-started', user_action: true },
        { id: 'vbs4', title: 'Build it', status: 'not-started' },
        { id: 'qr1', title: 'Drivers', status: 'not-started' },
    ];
    const load = (w: Win): void => { w.eval(`qtTodos = ${JSON.stringify(todos)};`); w.qtRenderList(); };
    const rows = (w: Win): string[] => [...w.document.querySelectorAll('#qt-list-pane .qt-todo-item')].map((e: Win) => e.getAttribute('data-qt-id'));
    const groupsOpen = (w: Win): number => w.document.querySelectorAll('#qt-list-pane .qt-group-header:not(.collapsed)').length;

    test('QU-3: yellow title', (t) => {
        const w = setup(t);
        assert.match(w.qtRenderTodoRow(todos[0]), /class="qt-todo-item status-not-started user-action"/);
        assert.doesNotMatch(w.qtRenderTodoRow(todos[1]), /user-action"/);
        assert.match(media('questTodoPanel', 'style.css'), /\.qt-todo-item\.user-action \.ttitle \{ color: var\(--vscode-editorWarning-foreground/);
    });

    test('QU-4: the filter', (t) => {
        const w = setup(t);
        load(w);
        w.qtExpandAllGroups();
        assert.deepEqual(rows(w).sort(), ['qr1', 'vbs3', 'vbs4']);
        w.eval("qtFilterState.userAction = ['yes'];"); w.qtRenderList();
        assert.deepEqual(rows(w), ['vbs3']);
        w.eval("qtFilterState.userAction = ['no'];"); w.qtRenderList();
        assert.deepEqual(rows(w).sort(), ['qr1', 'vbs4']);
        assert.equal(w.qtHasActiveFilters(), true);
        w.qtRenderFilterPicker();
        assert.equal(w.document.querySelectorAll('[data-qt-filter-type="userAction"]').length, 2, 'the picker offers both');
        assert.deepEqual(JSON.parse(JSON.stringify(w.qtEmptyFilterState().userAction)), []);
        assert.match(media('questTodoPanel', 'main.js'), /userAction: fs\.userAction \|\| \[\],/, 'an older saved state restores as all');
    });

    test('QU-5: the toggle', (t) => {
        const w = setup(t);
        load(w);
        assert.equal(groupsOpen(w), 0, 'groups start collapsed');
        w.document.getElementById('qt-btn-only-mine').click();
        assert.deepEqual(rows(w), ['vbs3'], 'only the user\'s own todos, visible');
        assert.equal(w.document.getElementById('qt-btn-only-mine').classList.contains('active-indicator'), true);
        w.document.getElementById('qt-btn-only-mine').click();
        assert.deepEqual(rows(w).sort(), ['qr1', 'vbs3', 'vbs4'], 'all again, and every group stayed open');
        assert.equal(w.document.getElementById('qt-btn-only-mine').classList.contains('active-indicator'), false);
    });

    test('QU-6: expand and collapse all', (t) => {
        const w = setup(t);
        load(w);
        w.document.getElementById('qt-btn-expand-all').click();
        assert.equal(groupsOpen(w), 2);
        assert.equal(rows(w).length, 3);
        w.document.getElementById('qt-btn-collapse-all').click();
        assert.equal(groupsOpen(w), 0);
    });
});
