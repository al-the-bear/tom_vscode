/**
 * The Up / Down buttons of the editors with a list on the left, and the todo panel's search clear button, each
 * page in a JSDOM running its real script.
 *
 *   EM-1 template editor (profiles, templates): the buttons are off without a selection and at the list's
 *        ends; a click posts `move` with the category, the entry and the direction; the reordered list
 *        (`categoryItems`) is drawn with the selection kept and the buttons following it
 *   EM-2 Role Editor: a click posts `move`; `order` redraws only the list — the form keeps what was typed
 *   EM-3 group prompt editor: an entry moves within its own list (scope and kind): the buttons count only its
 *        peers; `order` reorders the list and keeps an unsaved text
 *   EM-4 process editor: the buttons follow the selected process; a click posts `move`; the list sent again
 *        is drawn in its new order
 *   EM-5 todo panel: the clear button of the search field is hidden while the field is empty, shown once it
 *        holds text; a click empties the field, shows every todo again, hides the button and focuses the field
 */

import test, { describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { JSDOM } from 'jsdom';

const MEDIA = join(__dirname, '..', '..', '..', 'media');
const asset = (...parts: string[]): string => readFileSync(join(MEDIA, ...parts), 'utf-8');

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Win = any;
type Posted = Array<Record<string, unknown>>;

/** An editor page: the body of its index.html and its main.js, with a recording host. */
function editor(t: { after(fn: () => void): void }, panel: string, init: Record<string, unknown> = {}): { w: Win; posted: Posted } {
    const body = asset(panel, 'index.html').split(/<body[^>]*>/)[1].split('<script')[0];
    const dom = new JSDOM(`<!DOCTYPE html><body>${body}</body>`, { runScripts: 'outside-only' });
    const w = dom.window as Win;
    t.after(() => w.close());
    const posted: Posted = [];
    w.__INIT__ = init;
    w.acquireVsCodeApi = () => ({ postMessage: (m: Record<string, unknown>) => posted.push(JSON.parse(JSON.stringify(m))), getState: () => undefined, setState: () => undefined });
    w.eval(asset(panel, 'main.js'));
    return { w, posted };
}
const send = (w: Win, data: Record<string, unknown>): void => { w.dispatchEvent(new w.MessageEvent('message', { data })); };
const off = (w: Win, id: string): boolean => w.document.getElementById(id).disabled === true;
const texts = (w: Win, selector: string): string[] => Array.from(w.document.querySelectorAll(selector) as Win[]).map((e: Win) => String(e.textContent));

describe('editors: the Up / Down buttons', () => {
    test('EM-1: template editor', (t) => {
        const { w, posted } = editor(t, 'globalTemplateEditor');
        const items = [{ id: 'p1', label: 'One' }, { id: 'p2', label: 'Two' }, { id: 'p3', label: 'Three' }];
        send(w, { type: 'allData', categories: [{ id: 'anthropicProfiles', label: 'Profiles', items }], initialCategory: 'anthropicProfiles' });
        assert.ok(off(w, 'btnMoveUp') && off(w, 'btnMoveDown'), 'no selection: both off');
        w.document.querySelectorAll('#fileList .item')[0].click();
        assert.ok(off(w, 'btnMoveUp') && !off(w, 'btnMoveDown'), 'first entry: only down');
        w.document.querySelectorAll('#fileList .item')[2].click();
        assert.ok(!off(w, 'btnMoveUp') && off(w, 'btnMoveDown'), 'last entry: only up');
        posted.length = 0;
        w.document.getElementById('btnMoveUp').click();
        assert.deepEqual(posted, [{ type: 'move', category: 'anthropicProfiles', itemId: 'p3', direction: 'up' }]);
        send(w, { type: 'categoryItems', category: 'anthropicProfiles', items: [items[0], items[2], items[1]] });
        assert.deepEqual(texts(w, '#fileList .item'), ['One', 'Three', 'Two']);
        assert.equal(w.document.querySelector('#fileList .item.selected').textContent, 'Three');
        assert.ok(!off(w, 'btnMoveUp') && !off(w, 'btnMoveDown'), 'now in the middle');
    });

    test('EM-2: Role Editor', (t) => {
        const { w, posted } = editor(t, 'rolesEditor', { kind: 'roles' });
        const role = (id: string) => ({ id, roleType: '', text: `# ${id}\n` });
        send(w, { type: 'data', kind: 'roles', items: [role('architect'), role('builder'), role('critic')], roleTypes: [] });
        assert.ok(off(w, 'btnMoveUp') && !off(w, 'btnMoveDown'), 'the first role is selected: only down');
        w.document.querySelector('#itemList li[data-id="builder"]').click();
        assert.ok(!off(w, 'btnMoveUp') && !off(w, 'btnMoveDown'));
        const typed = Array.from(w.document.querySelectorAll('textarea') as Win[])[0] as Win;
        assert.ok(typed, 'the role form has a text area');
        typed.value = 'unsaved text';
        posted.length = 0;
        w.document.getElementById('btnMoveDown').click();
        assert.deepEqual(posted, [{ type: 'move', kind: 'roles', id: 'builder', direction: 'down' }]);
        send(w, { type: 'order', kind: 'roles', ids: ['architect', 'critic', 'builder'] });
        assert.deepEqual(Array.from(w.document.querySelectorAll('#itemList li') as Win[]).map((li: Win) => li.dataset.id), ['architect', 'critic', 'builder']);
        assert.ok(!off(w, 'btnMoveUp') && off(w, 'btnMoveDown'), 'now last');
        assert.equal((Array.from(w.document.querySelectorAll('textarea') as Win[])[0] as Win).value, 'unsaved text', 'the form is not drawn again');
    });

    test('EM-3: group prompt editor', (t) => {
        const { w, posted } = editor(t, 'groupPromptEditor');
        const entry = (scope: string, kind: string, name: string, text: string) => ({ scope, kind, name, text, exists: true, key: `${scope}:${kind}:${name}` });
        send(w, {
            type: 'load', questId: 'q1', quests: ['q1'], selected: 'global:addition:b', variables: [],
            entries: [entry('global', 'default', '', 'D'), entry('global', 'addition', 'a', 'A'), entry('global', 'addition', 'b', 'B'), entry('quest', 'prompt', 'p', 'P')],
        });
        assert.ok(!off(w, 'moveUp') && off(w, 'moveDown'), 'b is the last of the two global additions');
        const text = w.document.getElementById('text');
        text.value = 'B edited';
        text.dispatchEvent(new w.Event('input'));
        posted.length = 0;
        w.document.getElementById('moveUp').click();
        assert.deepEqual(posted, [{ type: 'move', key: 'global:addition:b', direction: 'up' }]);
        send(w, { type: 'order', keys: ['global:default:', 'global:addition:b', 'global:addition:a', 'quest:prompt:p'] });
        assert.deepEqual(texts(w, '.item').map((s) => s.replace(/\s*[•*●]\s*$/, '').trim().slice(0, 1)), ['D', 'b', 'a', 'p']);
        assert.ok(off(w, 'moveUp') && !off(w, 'moveDown'), 'b is now the first of its list');
        assert.equal(w.document.getElementById('text').value, 'B edited', 'the unsaved text stays');
    });

    test('EM-4: process editor', (t) => {
        const { w, posted } = editor(t, 'processEditor');
        const proc = (id: string) => ({ id, name: id.toUpperCase(), valid: true, errorCount: 0, inputs: [], phases: [] });
        send(w, { type: 'list', processes: [proc('one'), proc('two'), proc('three')], roles: [], currentProcess: '', selected: 'one' });
        assert.ok(off(w, 'btn-move-up') && !off(w, 'btn-move-down'), 'the first process: only down');
        posted.length = 0;
        w.document.getElementById('btn-move-down').click();
        assert.deepEqual(posted, [{ type: 'move', id: 'one', direction: 'down' }]);
        send(w, { type: 'list', processes: [proc('two'), proc('one'), proc('three')], roles: [], currentProcess: '', selected: 'one' });
        assert.deepEqual(texts(w, '#list .item-id'), ['two', 'one', 'three']);
        assert.ok(!off(w, 'btn-move-up') && !off(w, 'btn-move-down'));
    });
});

describe('todo panel: the search field', () => {
    test('EM-5: the clear button', (t) => {
        const dom = new JSDOM(`<body>${asset('questTodoPanel', 'fragment.html')}</body>`, { runScripts: 'outside-only' });
        const w = dom.window as Win;
        t.after(() => w.close());
        w.vscode = { postMessage: () => undefined, getState: () => undefined, setState: () => undefined };
        w.eval('var qtViewConfig = {};\n' + asset('questTodoPanel', 'grouping.js') + asset('questTodoPanel', 'main.js'));
        w.eval(`qtTodos = ${JSON.stringify([{ id: 'aa1', title: 'Alpha', status: 'not-started' }, { id: 'aa2', title: 'Beta', status: 'not-started' }])};`);
        w.eval("qtGroupTodosByPrefix(qtTodos).forEach(function(g) { qtExpandedGroups['#' + g.prefix] = true; });");
        w.qtRenderList();
        const rows = (): string[] => Array.from(w.document.querySelectorAll('#qt-list-pane .qt-todo-item') as Win[]).map((e: Win) => String(e.getAttribute('data-qt-id')));
        const field = w.document.getElementById('qt-search');
        const clear = w.document.getElementById('qt-search-clear');
        assert.ok(clear, 'the search field has a clear button');
        assert.equal(clear.hidden, true, 'hidden while the field is empty');
        assert.deepEqual(rows(), ['aa1', 'aa2']);
        field.value = 'beta';
        field.dispatchEvent(new w.Event('input'));
        assert.equal(clear.hidden, false);
        assert.deepEqual(rows(), ['aa2']);
        clear.click();
        assert.equal(field.value, '');
        assert.equal(clear.hidden, true);
        assert.deepEqual(rows(), ['aa1', 'aa2']);
        assert.equal(w.document.activeElement, field, 'the field has the focus again');
    });
});
