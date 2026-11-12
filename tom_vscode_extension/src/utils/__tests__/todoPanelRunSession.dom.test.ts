/**
 * The todo panel's session and run controls (vscimpb60d; media/questTodoPanel) in both quest todo views — the @TOM
 * sidebar's QUEST TODOS (a fixed quest) and @WS › Quest TODO (the quest select) — in a JSDOM running the real script.
 *
 *   TD-1 the view asks for them (qtGetRunSession); the top bar shows the session button (speech bubble + the
 *        session its sends run in) and the Run select (`default` first, the window's run marked); a run other than
 *        the window's is marked
 *   TD-2 the detail panel's Run row shows the same controls beside Send and Queue; one selection: a change in either
 *        shows in both
 *   TD-3 the session button posts qtPickSession; picking a run posts qtSetRun; the host's answer re-renders both
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

const VIEWS: Array<[string, Record<string, unknown>]> = [
    ['QUEST TODOS (sidebar)', { mode: 'fixed-file', fixedQuestId: 'q1', hideQuestSelect: true, hideFileSelect: false }],
    ['@WS › Quest TODO', {}],
];

function setup(t: { after(fn: () => void): void }, config: Record<string, unknown>): { w: Win; posted: Win[] } {
    const dom = new JSDOM(`<body>${media('questTodoPanel', 'fragment.html')}</body>`, { runScripts: 'outside-only' });
    const w = dom.window as Win;
    t.after(() => w.close());
    const posted: Win[] = [];
    w.vscode = { postMessage: (m: Win) => posted.push(JSON.parse(JSON.stringify(m))), getState: () => undefined, setState: () => undefined };
    w.eval(`var qtViewConfig = ${JSON.stringify(config)};\n` + media('shared', 'mdOverlay.js') + media('questTodoPanel', 'grouping.js') + media('questTodoPanel', 'main.js'));
    w.eval("qtCurrentQuestId = 'q1';");
    return { w, posted };
}
const STATE = { type: 'qtRunSession', session: 'work', effectiveSession: 'work@r2', run: 'r2', windowRun: 'default', runs: [{ run: 'default', label: 'default (PROCESS view)' }, { run: 'r2', label: 'r2' }] };

for (const [name, config] of VIEWS) {
    describe(`todo panel session and run — ${name}`, () => {
        test('TD-1: the top bar', (t) => {
            const { w, posted } = setup(t, config);
            assert.ok(posted.some((m) => m.type === 'qtGetRunSession'), 'asks for them');
            const bar = w.document.getElementById('qt-bar-run-session');
            assert.ok(bar.closest('.qt-top-chat-group'), 'in the top bar, beside the send buttons');
            assert.match(bar.querySelector('.qt-session-btn').textContent, /chat/, 'until told: the default session');
            w.qtHandleMessage(STATE);
            assert.equal(bar.querySelector('.qt-session-btn .qt-session-name').textContent, 'work@r2');
            assert.ok(bar.querySelector('.qt-session-btn .codicon-comment-discussion'));
            const sel = bar.querySelector('.qt-run-select');
            assert.deepEqual([...sel.options].map((o: Win) => [o.value, o.textContent]), [['default', 'default (PROCESS view)'], ['r2', 'r2']]);
            assert.equal(sel.value, 'r2');
            assert.ok(sel.classList.contains('run-other'), 'another run than the window\'s is marked');
        });

        test('TD-2: the detail panel, one selection', (t) => {
            const { w } = setup(t, config);
            w.qtHandleMessage(STATE);
            w.qtRenderDetail({ id: 'a1', title: 'A', status: 'not-started', _sourceFile: 'todos.q1.todo.yaml' });
            const detail = w.document.querySelector('#qt-detail-pane .qt-run-session');
            assert.ok(detail, 'in the detail\'s Run row');
            assert.ok(detail.closest('.qt-todo-buttons').querySelector('.qt-todo-btn[data-qt-todo-btn="chat"]'), 'beside Send and Queue');
            assert.equal(detail.querySelector('.qt-session-name').textContent, 'work@r2');
            assert.equal(detail.querySelector('.qt-run-select').value, 'r2');
            w.qtHandleMessage({ ...STATE, run: 'default', effectiveSession: 'work' });
            for (const el of w.document.querySelectorAll('.qt-run-session')) {
                assert.equal(el.querySelector('.qt-run-select').value, 'default', 'both places follow');
                assert.equal(el.querySelector('.qt-session-name').textContent, 'work');
            }
        });

        test('TD-3: picking', (t) => {
            const { w, posted } = setup(t, config);
            w.qtHandleMessage(STATE);
            w.qtRenderDetail({ id: 'a1', title: 'A', status: 'not-started' });
            posted.length = 0;
            w.document.querySelector('#qt-bar-run-session .qt-session-btn').click();
            w.document.querySelector('#qt-detail-pane .qt-session-btn').click();
            const sel = w.document.querySelector('#qt-detail-pane .qt-run-select');
            sel.value = 'default';
            sel.dispatchEvent(new w.Event('change', { bubbles: true }));
            assert.deepEqual(posted, [{ type: 'qtPickSession' }, { type: 'qtPickSession' }, { type: 'qtSetRun', run: 'default' }]);
            assert.equal(w.document.querySelector('#qt-bar-run-session .qt-run-select').value, 'default', 'the bar follows at once');
        });
    });
}
