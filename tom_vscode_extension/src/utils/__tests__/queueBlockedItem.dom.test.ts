/**
 * A queue item held at a blocked todo in the Prompt Queue editor, and the todo panel's queue marks with a long run
 * name (media/shared/queueEntryRenderFunctions.js, media/queueEditor/main.js, media/questTodoPanel/main.js).
 *
 *   QB-1 the held item's header has Stop (back to staged), Continue (a walk or GROUP item: skipBlockedTodo) and Run
 *        anyway (runBlockedTodoAnyway); a single todo's has no Continue; the hint is black on the amber header
 *   QB-2 the toolbar's Stop and Interrupt are enabled while the run has a held item
 *   QB-3 a queue mark names a long run by its first 15 characters; the group header's label keeps its room
 */

import test, { describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { JSDOM } from 'jsdom';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Win = any;

const media = (...parts: string[]): string => readFileSync(join(__dirname, '..', '..', '..', 'media', ...parts), 'utf-8');

function editor(t: { after(fn: () => void): void }, items: unknown[]): { w: Win; posted: Win[] } {
    const html = media('queueEditor', 'index.html').replace(/<script[\s\S]*?<\/script>/g, '');
    const dom = new JSDOM(html, { runScripts: 'outside-only' });
    const w = dom.window as Win;
    t.after(() => w.close());
    const posted: Win[] = [];
    w.acquireVsCodeApi = () => ({ postMessage: (m: Win) => posted.push(JSON.parse(JSON.stringify(m))), setState: () => undefined, getState: () => ({}) });
    w.__INIT__ = {
        state: { items, autoSend: false, processRuns: ['default'], currentRun: 'default' },
        queueDefaultPickerHtml: '<select id="queueDefault-transport-profile"></select>',
        addFormPickerHtml: '<select id="addForm-transport-profile"></select>',
    };
    w.eval([media('shared', 'queueEntryUtils.js'), media('shared', 'queueEntryRenderFunctions.js'), media('shared', 'queueEntryMessageHandlers.js'), media('queueEditor', 'main.js')].join('\n;\n'));
    return { w, posted };
}

const base = { type: 'normal', template: '(None)', createdAt: '2026-11-19T10:00:00.000Z', run: 'default' };
const WALK = { ...base, id: 'w1', status: 'todo-blocked', originalText: 'walk', expandedText: 'walk', repeatCount: 'tj*', blockedOn: 'todo tj1_x waits for gate8 (in-progress)', blockedActions: { canSkip: true, canRunAnyway: true } };
const SINGLE = { ...base, id: 's1', status: 'todo-blocked', originalText: 'one', expandedText: 'one', todoIdPattern: 'tl1_x', blockedOn: 'todo tl1_x waits for gate8 (in-progress)', blockedActions: { canSkip: false, canRunAnyway: true } };

/** Run the handler of an inline onclick (JSDOM does not run inline handlers from the page's script scope). */
const click = (w: Win, el: Win): void => { w.eval(el.getAttribute('onclick')); };

describe('a held queue item', () => {
    test('QB-1: its buttons and its hint', (t) => {
        const { w, posted } = editor(t, [WALK, SINGLE]);
        const header = (id: string): Win => w.document.querySelector(`.queue-item[data-id="${id}"] .status-bar`) ?? [...w.document.querySelectorAll('.queue-item')].find((e: Win) => e.innerHTML.includes(`'${id}'`)).querySelector('.status-bar');
        const walk = header('w1');
        const stop = walk.querySelector('.codicon-debug-stop');
        const skip = walk.querySelector('.codicon-debug-step-over');
        const anyway = walk.querySelector('.codicon-run-all');
        assert.ok(stop && skip && anyway, 'Stop, Continue and Run anyway');
        click(w, skip);
        click(w, anyway);
        click(w, stop);
        assert.deepEqual(posted.filter((m) => ['skipBlockedTodo', 'runBlockedTodoAnyway', 'setItemStatus'].includes(m.type)).map((m) => [m.type, m.id, m.status].filter(Boolean)),
            [['skipBlockedTodo', 'w1'], ['runBlockedTodoAnyway', 'w1'], ['setItemStatus', 'w1', 'staged']]);
        const single = header('s1');
        assert.equal(single.querySelector('.codicon-debug-step-over'), null, 'a single todo has no Continue');
        assert.ok(single.querySelector('.codicon-run-all'));
        assert.match(walk.querySelector('.todo-blocked-badge').textContent, /blocked: todo tj1_x waits for gate8/);
        assert.match(media('shared', 'queueEntryStyles.css'), /\.todo-blocked-badge \{ color: #000;/, 'black on the amber header');
    });

    test('QB-2: Stop and Interrupt in the toolbar', (t) => {
        const { w } = editor(t, [WALK]);
        assert.equal(w.document.getElementById('stopActiveBtn').disabled, false);
        assert.match(w.document.getElementById('stopActiveBtn').title, /held at a blocked todo/);
        assert.equal(w.document.getElementById('interruptForContinuationBtn').disabled, false);
    });
});

describe('the todo panel\'s queue marks', () => {
    test('QB-3: a long run name', (t) => {
        const dom = new JSDOM(`<body>${media('questTodoPanel', 'fragment.html')}</body>`, { runScripts: 'outside-only' });
        const w = dom.window as Win;
        t.after(() => w.close());
        w.vscode = { postMessage: () => undefined, getState: () => undefined, setState: () => undefined };
        w.eval('var qtViewConfig = {};\n' + media('shared', 'mdOverlay.js') + media('questTodoPanel', 'grouping.js') + media('questTodoPanel', 'main.js'));
        assert.equal(w.qtQueuedLabel(3, 'office_and_pdf_integration_prototype'), 'office_and_pdf… #3');
        assert.equal(w.qtQueuedLabel(3, 'chg1'), 'chg1 #3');
        assert.equal(w.qtQueuedLabel(3, 'default'), '#3');
        const css = media('questTodoPanel', 'style.css');
        assert.match(css, /\.qt-group-header \.qt-group-label \{[^}]*min-width: 4em/, 'the prefix keeps room');
        assert.match(css, /\.qt-group-header \.qt-group-queued \{[^}]*text-overflow: ellipsis/, 'the mark shrinks first');
    });
});
