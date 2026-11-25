/**
 * The todo panel's title field (media/questTodoPanel/main.js qtTitleField / qtWireTitleField): three lines high in the
 * detail form and the new-todo form, so a long title can be read whole, and still one line.
 *
 *   QTF-1 the detail form and the new-todo form show the title in a three-row text area (`qt-title-field`), the
 *         stored title as its text; its style is not the 90 px minimum of the other text areas
 *   QTF-2 a title stays one line: Enter adds no line break, a pasted line break becomes a space (in the field and in
 *         what is saved), and an edit saves as before
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

function setup(t: { after(fn: () => void): void }): { w: Win; posted: Win[] } {
    const dom = new JSDOM(`<body>${media('questTodoPanel', 'fragment.html')}</body>`, { runScripts: 'outside-only' });
    const w = dom.window as Win;
    t.after(() => w.close());
    const posted: Win[] = [];
    w.vscode = { postMessage: (m: Win) => posted.push(JSON.parse(JSON.stringify(m))), getState: () => undefined, setState: () => undefined };
    w.eval('var qtViewConfig = {};\n' + media('questTodoPanel', 'grouping.js') + media('questTodoPanel', 'main.js'));
    return { w, posted };
}

const LONG = 'A todo title long enough to need more than one line of the detail pane, so that it can only be read whole when the field shows several lines';

describe('todo panel: the title field', () => {
    test('QTF-1: three lines in both forms', (t) => {
        const { w } = setup(t);
        w.eval("qtCurrentQuestId = 'qa';");
        w.qtRenderDetail({ id: 'vbs1', title: LONG, status: 'not-started', sourceFile: 'todos.qa.todo.yaml' });
        const field = w.document.getElementById('qt-d-title');
        assert.equal(field.tagName, 'TEXTAREA');
        assert.equal(field.getAttribute('rows'), '3');
        assert.ok(field.classList.contains('qt-title-field'));
        assert.equal(field.value, LONG, 'the stored title');
        w.qtShowNewTodoForm('vbs9');
        const fresh = w.document.getElementById('qt-d-title');
        assert.deepEqual([fresh.tagName, fresh.getAttribute('rows'), fresh.value], ['TEXTAREA', '3', '']);
        assert.match(media('questTodoPanel', 'style.css'), /\.qt-form-row textarea\.qt-title-field \{ min-height: 0;/, 'not the 90 px of the other text areas');
    });

    test('QTF-2: one line all the same', (t) => {
        const { w } = setup(t);
        w.eval("qtCurrentQuestId = 'qa';");
        w.qtRenderDetail({ id: 'vbs1', title: 'Short', status: 'not-started', sourceFile: 'todos.qa.todo.yaml' });
        const field = w.document.getElementById('qt-d-title');
        const enter = new w.KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true });
        field.dispatchEvent(enter);
        assert.equal(enter.defaultPrevented, true, 'Enter adds no line break');
        field.value = 'First line\nsecond line \r\n third';
        field.dispatchEvent(new w.Event('input', { bubbles: true }));
        assert.equal(field.value, 'First line second line third', 'a pasted line break becomes a space');
        assert.equal(w.qtCollectFormData().title, 'First line second line third');
        // Even a value set without an input event is saved as one line.
        field.value = 'a\nb';
        assert.equal(w.qtCollectFormData().title, 'a b');
        assert.equal(w.qtOneLine('one'), 'one');
    });
});
