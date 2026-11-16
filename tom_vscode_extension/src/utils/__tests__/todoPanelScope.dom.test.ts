/**
 * The todo panel across quests in the webview (media/questTodoPanel, vscimpb137), in a JSDOM running the real script.
 *
 *   SD-1 the panel asks for its scope; its own quest with live files (`plain`) shows the scope controls in the quest
 *        select's place and loads nothing again: the panel as it always was
 *   SD-2 several quests: the list is `__all_quests__`, the file select hidden, the order select shown, the toggles
 *        say which files and whether the quest prefix is on; the controls post qtSetScope / qtPickScope
 *   SD-3 the rows: the quest in front of each id; an archived row marked, read-only (no stack circle, no actions)
 *        with Restore, which posts qtRestoreTodo with the row's file
 *   SD-4 the orderings: the groups of all quests combined; by quest then groups (each quest's own groups); by quest
 *        then list
 *   SD-5 an archived todo's detail: marked, every field disabled, Restore
 *   SD-6 back to the panel's own quest: it loads that quest again, the file select back; a refresh request reloads
 */

import test, { describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { JSDOM } from 'jsdom';

const ROOT = join(__dirname, '..', '..', '..');
const media = (...p: string[]): string => readFileSync(join(ROOT, 'media', ...p), 'utf-8');

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Win = any;

function setup(t: { after(fn: () => void): void }): { w: Win; posted: Win[] } {
    const dom = new JSDOM(`<body>${media('questTodoPanel', 'fragment.html')}</body>`, { runScripts: 'outside-only' });
    const w = dom.window as Win;
    t.after(() => w.close());
    const posted: Win[] = [];
    w.vscode = { postMessage: (m: Win) => posted.push(JSON.parse(JSON.stringify(m))), getState: () => undefined, setState: () => undefined };
    w.eval('var qtViewConfig = {"mode":"fixed-file","fixedQuestId":"alpha","hideQuestSelect":true};\n' + media('shared', 'mdOverlay.js') + media('questTodoPanel', 'grouping.js') + media('questTodoPanel', 'main.js'));
    w.eval("qtCurrentQuestId = 'alpha';");
    return { w, posted };
}

const FILES = { live: true, archived: true, deleted: false };
const MULTI = (order: string, prefix = true): Win => ({
    type: 'qtScope', available: true, plain: false, quests: ['alpha', 'beta'], prefix,
    scope: { kind: 'all', files: FILES, order }, buttonText: 'All quests (2)',
});
const ROWS = {
    type: 'qtTodos', questId: '__all_quests__', file: 'all',
    todos: [
        { id: 'xx1', title: 'A one', status: 'not-started', sourceFile: 'alpha/todos.alpha.todo.yaml' },
        { id: 'xx2', title: 'B two', status: 'not-started', sourceFile: 'beta/todos.beta.todo.yaml' },
        { id: 'xx3', title: 'B old', status: 'completed', sourceFile: 'beta/todos-archived.beta.todo.yaml', retired: 'archived' },
    ],
};
const rowsOf = (w: Win): string[] => [...w.document.querySelectorAll('#qt-list-pane .qt-todo-item .tid')].map((e: Win) => e.textContent);

describe('the todo panel across quests (webview)', () => {
    test('SD-1: its own quest, live files', (t) => {
        const { w, posted } = setup(t);
        assert.ok(posted.some((m) => m.type === 'qtGetScope'), 'asks for its scope');
        posted.length = 0;
        w.qtHandleMessage({ type: 'qtScope', available: true, plain: true, quests: ['alpha'], prefix: false, scope: { kind: 'one', quest: 'alpha', files: { live: true, archived: false, deleted: false }, order: 'combined' }, buttonText: 'alpha' });
        assert.equal(w.document.getElementById('qt-scope-controls').style.display, '');
        assert.equal(w.document.getElementById('qt-quest-select').style.display, 'none', 'the scope picker takes its place');
        assert.equal(w.document.querySelector('#qt-scope-btn .qt-scope-name').textContent, 'alpha');
        assert.equal(w.document.getElementById('qt-quest-order').style.display, 'none', 'no order with one quest');
        assert.equal(w.document.getElementById('qt-files-live').getAttribute('aria-pressed'), 'true');
        assert.equal(w.document.getElementById('qt-files-archived').getAttribute('aria-pressed'), 'false');
        assert.equal(posted.filter((m) => m.type === 'qtGetTodos').length, 0, 'nothing loaded again');
        // Without a scope (session / workspace views): the controls stay hidden.
        w.qtHandleMessage({ type: 'qtScope', available: false });
        assert.equal(w.document.getElementById('qt-scope-controls').style.display, 'none');
    });

    test('SD-2: several quests', (t) => {
        const { w, posted } = setup(t);
        posted.length = 0;
        w.qtHandleMessage(MULTI('combined'));
        assert.deepEqual(posted.filter((m) => m.type === 'qtGetTodos'), [{ type: 'qtGetTodos', questId: '__all_quests__', file: 'all' }]);
        assert.equal(w.eval('qtCurrentQuestId'), '__all_quests__');
        assert.equal(w.document.getElementById('qt-file-select').style.display, 'none');
        assert.equal(w.document.getElementById('qt-quest-order').style.display, '');
        assert.equal(w.document.getElementById('qt-files-archived').getAttribute('aria-pressed'), 'true');
        assert.match(w.document.getElementById('qt-files-archived').title, /^Archived todos: shown/);
        assert.equal(w.document.getElementById('qt-quest-prefix').getAttribute('aria-pressed'), 'true');
        posted.length = 0;
        w.document.getElementById('qt-files-deleted').click();
        assert.deepEqual(posted.pop().scope.files, { live: true, archived: true, deleted: true });
        w.document.getElementById('qt-quest-prefix').click();
        assert.equal(posted.pop().scope.prefix, false);
        const order = w.document.getElementById('qt-quest-order');
        order.value = 'quest-list';
        order.dispatchEvent(new w.Event('change'));
        assert.equal(posted.pop().scope.order, 'quest-list');
        w.document.getElementById('qt-scope-btn').click();
        assert.deepEqual(posted.pop(), { type: 'qtPickScope' });
    });

    test('SD-3: the rows', (t) => {
        const { w, posted } = setup(t);
        w.qtHandleMessage(MULTI('combined'));
        w.qtHandleMessage(ROWS);
        w.qtExpandAllGroups();
        assert.deepEqual(rowsOf(w).sort(), ['alpha/xx1', 'beta/xx2', 'beta/xx3'], 'the quest in front of every id');
        const old = w.document.querySelector('.qt-todo-item[data-qt-id="xx3"]');
        assert.ok(old.classList.contains('retired'));
        assert.equal(old.querySelector('.qt-retired-badge').textContent, 'archived');
        assert.equal(old.querySelector('.qt-stack-circle'), null, 'not stacked');
        assert.equal(old.querySelector('.qt-trash-btn, .qt-reopen-btn, .qt-move-ws-btn'), null, 'no other action');
        posted.length = 0;
        old.querySelector('.qt-restore-btn').click();
        assert.deepEqual(posted.filter((m) => m.type === 'qtRestoreTodo'), [{ type: 'qtRestoreTodo', questId: '__all_quests__', todoId: 'xx3', sourceFile: 'beta/todos-archived.beta.todo.yaml' }]);
        assert.equal(posted.filter((m) => m.type === 'qtGetTodo').length, 0, 'Restore does not open the detail');
        // The prefix off: the bare ids.
        w.qtHandleMessage(MULTI('combined', false));
        w.qtHandleMessage(ROWS);
        assert.deepEqual(rowsOf(w).sort(), ['xx1', 'xx2', 'xx3']);
    });

    test('SD-4: the orderings', (t) => {
        const { w } = setup(t);
        w.qtHandleMessage(MULTI('combined'));
        w.qtHandleMessage(ROWS);
        w.qtExpandAllGroups();
        const pane = (): Win => w.document.getElementById('qt-list-pane');
        assert.equal(pane().querySelectorAll('.qt-quest-header').length, 0, 'combined: no quest level');
        const xx = [...pane().querySelectorAll('.qt-group-header')].filter((h: Win) => /xx/.test(h.textContent));
        assert.equal(xx.length, 1, 'one xx group for both quests');
        assert.match(xx[0].querySelector('.qt-group-count').textContent, /\(3\)/);
        assert.equal(xx[0].querySelector('.qt-group-walk-btn'), null, 'no walk over several quests');

        w.qtHandleMessage(MULTI('quest-groups'));
        w.qtHandleMessage(ROWS);
        w.qtExpandAllGroups();
        assert.deepEqual([...pane().querySelectorAll('.qt-quest-header')].map((h: Win) => h.getAttribute('data-qt-quest')), ['alpha', 'beta']);
        const groups = [...pane().querySelectorAll('.qt-group-header')].map((h: Win) => h.getAttribute('data-qt-group'));
        assert.deepEqual(groups, ['alpha::xx', 'beta::xx'], 'each quest its own groups');
        const betaGroup = pane().querySelector('.qt-group-header[data-qt-group="beta::xx"]');
        assert.equal(betaGroup.getAttribute('data-qt-group-quest'), 'beta');
        assert.ok(betaGroup.querySelector('.qt-group-walk-btn'), 'a walk in that quest');
        assert.deepEqual(rowsOf(w), ['alpha/xx1', 'beta/xx2', 'beta/xx3']);
        // A quest collapses on its own.
        pane().querySelector('.qt-quest-header[data-qt-quest="alpha"]').click();
        assert.deepEqual(rowsOf(w), ['beta/xx2', 'beta/xx3']);

        w.qtHandleMessage(MULTI('quest-list'));
        w.qtHandleMessage(ROWS);
        w.qtExpandAllGroups();
        assert.equal(pane().querySelectorAll('.qt-quest-header').length, 2);
        assert.equal(pane().querySelectorAll('.qt-group-header').length, 0, 'the todos as a list');
        assert.deepEqual(rowsOf(w), ['alpha/xx1', 'beta/xx2', 'beta/xx3']);
    });

    test('SD-5: an archived todo\'s detail', (t) => {
        const { w, posted } = setup(t);
        w.qtHandleMessage(MULTI('combined'));
        w.qtHandleMessage(ROWS);
        w.qtRenderDetail({ id: 'xx3', title: 'B old', status: 'completed', _retired: 'archived', _resolvedQuestId: 'beta' });
        const form = w.document.querySelector('#qt-detail-pane .qt-detail-form');
        assert.ok(form.classList.contains('retired'));
        assert.match(form.querySelector('.qt-retired-banner').textContent, /Archived todo — read-only\./);
        const editable = [...form.querySelectorAll('input, textarea, select, button')].filter((e: Win) => !e.disabled && !e.classList.contains('qt-restore-btn') && !e.classList.contains('qt-md-btn'));
        assert.deepEqual(editable.map((e: Win) => e.id || e.className), [], 'every field disabled');
        posted.length = 0;
        form.querySelector('.qt-retired-banner .qt-restore-btn').click();
        assert.equal(posted.filter((m) => m.type === 'qtRestoreTodo')[0].todoId, 'xx3');
    });

    test('SD-6: back to its own quest; a refresh', (t) => {
        const { w, posted } = setup(t);
        w.qtHandleMessage(MULTI('combined'));
        posted.length = 0;
        w.qtHandleMessage({ type: 'qtRefreshRequest' });
        assert.deepEqual(posted.filter((m) => m.type === 'qtGetTodos'), [{ type: 'qtGetTodos', questId: '__all_quests__', file: 'all' }], 'reloads its scope');
        posted.length = 0;
        w.qtHandleMessage({ type: 'qtScope', available: true, plain: true, quests: ['alpha'], prefix: false, scope: { kind: 'one', quest: 'alpha', files: { live: true, archived: false, deleted: false }, order: 'combined' }, buttonText: 'alpha' });
        assert.deepEqual(posted.filter((m) => m.type === 'qtGetTodos'), [{ type: 'qtGetTodos', questId: 'alpha', file: 'all' }]);
        assert.equal(w.document.getElementById('qt-file-select').style.display, '');
        posted.length = 0;
        w.qtHandleMessage({ type: 'qtRefreshRequest' });
        assert.deepEqual(posted.filter((m) => m.type === 'qtGetTodos'), [{ type: 'qtGetTodos', questId: 'alpha', file: 'all' }]);
    });
});
