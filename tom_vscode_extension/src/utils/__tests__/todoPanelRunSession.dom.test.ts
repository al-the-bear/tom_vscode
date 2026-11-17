/**
 * The todo panel without a run and a session of its own (vscimpb139; media/questTodoPanel), in both quest todo
 * views — the @TOM sidebar's QUEST TODOS (a fixed quest) and @WS › Quest TODO (the quest select) — in a JSDOM
 * running the real script. Where an item goes is asked when it is queued or sent (the host's queue-target flow).
 *
 *   TD-1 the top bar has no session button and no Run select; the Done notification toggle and the template button
 *        stay; the view asks for the toggle's state (qtGetDoneNotification), not for a run and session
 *   TD-2 the todo detail's Run row has Send, Queue and Queue as todo item, without a session or a run, and their
 *        tooltips say the host asks where
 *   TD-3 the host's qtDoneNotification sets the toggle; the buttons post their messages with no run or session
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

for (const [name, config] of VIEWS) {
    describe(`todo panel without run and session — ${name}`, () => {
        test('TD-1: the top bar', (t) => {
            const { w, posted } = setup(t, config);
            const bar = w.document.querySelector('.qt-top-chat-group');
            assert.ok(bar, 'the bar\'s send group');
            assert.equal(w.document.querySelector('.qt-run-session, .qt-run-select, [data-qt-pick-session]'), null, 'no session button, no Run select');
            assert.ok(bar.querySelector('#qt-done-notification'), 'the Done notification toggle stays');
            assert.ok(bar.querySelector('#qt-template-btn'), 'the template button stays');
            assert.ok(posted.some((m) => m.type === 'qtGetDoneNotification'));
            assert.equal(posted.some((m) => m.type === 'qtGetRunSession'), false);
        });

        test('TD-2: the detail\'s Run row', (t) => {
            const { w } = setup(t, config);
            w.qtRenderDetail({ id: 'a1', title: 'A', status: 'not-started', _sourceFile: 'todos.q1.todo.yaml' });
            const row = w.document.querySelector('#qt-detail-pane .qt-todo-buttons');
            assert.ok(row);
            assert.equal(row.querySelector('.qt-run-session, .qt-run-select, .qt-session-btn'), null);
            const chat = row.querySelector('.qt-todo-btn[data-qt-todo-btn="chat"]');
            const queue = row.querySelector('.qt-todo-btn[data-qt-todo-btn="queue"]');
            assert.ok(chat && queue && row.querySelector('.qt-queue-item-detail-btn'));
            assert.match(chat.title, /a free session of this window \(asked for\)/);
            assert.match(queue.title, /asks the quest, run, free session and next \/ end/);
            assert.doesNotMatch(row.innerHTML, /panel(&#39;|')s session and run/);
        });

        test('TD-3: the toggle\'s state and the buttons\' messages', (t) => {
            const { w, posted } = setup(t, config);
            w.qtHandleMessage({ type: 'qtDoneNotification', on: false });
            assert.equal(w.document.getElementById('qt-done-notification').getAttribute('aria-pressed'), 'false');
            w.qtHandleMessage({ type: 'qtDoneNotification', on: true });
            assert.equal(w.document.getElementById('qt-done-notification').getAttribute('aria-pressed'), 'true');
            w.qtRenderDetail({ id: 'a1', title: 'A', status: 'not-started', _sourceFile: 'todos.q1.todo.yaml' });
            posted.length = 0;
            w.document.querySelector('.qt-todo-btn[data-qt-todo-btn="queue"]').click();
            const msg = posted.find((m) => m.type === 'qtTodoButton');
            assert.ok(msg, 'the Queue button posts qtTodoButton');
            assert.equal(msg.target, 'queue');
            assert.equal('run' in msg || 'session' in msg, false, 'no run or session: the host asks');
        });
    });
}
