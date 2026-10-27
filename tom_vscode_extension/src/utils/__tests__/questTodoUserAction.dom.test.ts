/**
 * The todo panel and `user_action` (media/questTodoPanel/main.js).
 *
 *   QU-1 a list row of a user-action todo carries the 👤 mark; any other row does not
 *   QU-2 the detail form's checkbox shows the field, and the form data carries it: true when checked,
 *        false when not (an update then removes the key)
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
});
