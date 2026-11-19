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
 *   TD-4 the default queue buttons (vscimpb151): the bar's default Save to Queue first, then the one that asks; the
 *        detail's default queue button first; both post `defaultTarget: true`; the detail's buttons are icon buttons
 *   TD-5 the Next and Fresh toggles: in the bar before the queue buttons and as the first two buttons of a todo's Run
 *        row; a click posts qtSetQueueToggle and shows on every copy; the host's qtQueueToggles sets them; Next shows
 *        its state by its icon (the numbered list: the end; the arrow up in a circle: next), Fresh as a pressed
 *        toggle; the tooltips say what they do
 *   TD-6 a group todo's Run row ends with two GROUP item buttons: in the default run (`defaultTarget: true`) and
 *        with options, both posting qtQueueTodoGroup; a plain todo has none
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
            assert.match(queue.title, /asks the quest, run and free session \(next or at the end as the Next toggle says\)/);
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

        test('TD-4: the default queue buttons', (t) => {
            const { w, posted } = setup(t, config);
            const bar = w.document.querySelector('.qt-top-chat-group');
            const ids = [...bar.querySelectorAll('button')].map((b: Win) => b.id).filter(Boolean);
            assert.ok(ids.indexOf('qt-btn-add-queue-default') >= 0 && ids.indexOf('qt-btn-add-queue-default') < ids.indexOf('qt-btn-add-queue'), ids.join(', '));
            w.qtRenderDetail({ id: 'a1', title: 'A', status: 'not-started', _sourceFile: 'todos.q1.todo.yaml' });
            const row = w.document.querySelector('#qt-detail-pane .qt-todo-buttons');
            const kinds = [...row.querySelectorAll('.qt-todo-btn')].map((b: Win) => b.getAttribute('data-qt-todo-btn'));
            assert.deepEqual(kinds, ['queueDefault', 'chat', 'queue'], 'the default queue button first');
            for (const b of row.querySelectorAll('button')) { assert.equal((b as Win).textContent.trim(), '', 'icon only'); }
            posted.length = 0;
            row.querySelector('[data-qt-todo-btn="queueDefault"]').click();
            const msg = posted.find((m) => m.type === 'qtTodoButton');
            assert.deepEqual([msg.target, msg.defaultTarget], ['queue', true]);
            posted.length = 0;
            w.qtSelectedTodoId = 'a1';
            w.document.getElementById('qt-btn-add-queue-default').click();
            const bm = posted.find((m) => m.type === 'qtAddCurrentTodoToQueue');
            assert.ok(bm, posted.map((m) => m.type).join(', '));
            assert.deepEqual([bm.todoId, bm.defaultTarget], ['a1', true]);
        });

        test('TD-5: the Next and Fresh toggles', (t) => {
            const { w, posted } = setup(t, config);
            const bar = w.document.querySelector('.qt-top-chat-group');
            const order = [...bar.querySelectorAll('button')].map((b: Win) => b.getAttribute('data-qt-queue-toggle') || b.id);
            assert.ok(order.indexOf('next') >= 0 && order.indexOf('next') < order.indexOf('fresh') && order.indexOf('fresh') < order.indexOf('qt-btn-add-queue-default'), order.join(', '));
            w.qtRenderDetail({ id: 'a1', title: 'A', status: 'not-started', _sourceFile: 'todos.q1.todo.yaml' });
            const row = w.document.querySelector('#qt-detail-pane .qt-todo-buttons');
            const rowButtons = [...row.querySelectorAll('button')] as Win[];
            assert.deepEqual(rowButtons.slice(0, 2).map((b) => b.getAttribute('data-qt-queue-toggle')), ['next', 'fresh'], 'the first buttons of the row');
            const nexts = (): Win[] => [...w.document.querySelectorAll('[data-qt-queue-toggle="next"]')];
            const freshs = (): Win[] => [...w.document.querySelectorAll('[data-qt-queue-toggle="fresh"]')];
            assert.equal(nexts().length, 2, 'the bar\'s and the row\'s');
            for (const b of nexts()) {
                assert.equal(b.getAttribute('aria-pressed'), 'false');
                assert.ok(b.querySelector('.codicon-list-ordered'), 'off: the numbered list (queued at the end)');
                assert.match(b.title, /^Queue next: off — .* at the end of the queue\./);
            }
            posted.length = 0;
            rowButtons[0].click();
            assert.deepEqual(posted.find((m) => m.type === 'qtSetQueueToggle'), { type: 'qtSetQueueToggle', which: 'next', on: true });
            for (const b of nexts()) {
                assert.equal(b.getAttribute('aria-pressed'), 'true', 'every copy');
                assert.ok(b.querySelector('.codicon-arrow-circle-up'), 'on: the arrow up in a circle (queued next)');
                assert.match(b.title, /^Queue next: on — .* at the front of the queue/);
            }
            posted.length = 0;
            bar.querySelector('[data-qt-queue-toggle="fresh"]').click();
            assert.deepEqual(posted.find((m) => m.type === 'qtSetQueueToggle'), { type: 'qtSetQueueToggle', which: 'fresh', on: true });
            for (const b of freshs()) {
                assert.equal(b.getAttribute('aria-pressed'), 'true');
                assert.ok(b.classList.contains('pressed'));
                assert.match(b.title, /^Fresh: on — .* a new one-prompt session based on the session picked/);
            }
            // The host's state wins, and a row rendered afterwards shows it.
            w.qtHandleMessage({ type: 'qtQueueToggles', next: false, fresh: true });
            w.qtRenderDetail({ id: 'a2', title: 'B', status: 'not-started', _sourceFile: 'todos.q1.todo.yaml' });
            for (const b of nexts()) { assert.equal(b.getAttribute('aria-pressed'), 'false'); }
            for (const b of freshs()) { assert.equal(b.getAttribute('aria-pressed'), 'true'); }
            w.qtHandleMessage({ type: 'qtQueueToggles', next: false, fresh: false });
            for (const b of freshs()) { assert.equal(b.classList.contains('pressed'), false); }
        });

        test('TD-6: a group todo\'s GROUP item buttons', (t) => {
            const { w, posted } = setup(t, config);
            w.qtRenderDetail({ id: 'a1', title: 'A', status: 'not-started', _sourceFile: 'todos.q1.todo.yaml' });
            assert.equal(w.document.querySelectorAll('#qt-detail-pane .qt-group-item-btn').length, 0, 'a plain todo has none');
            w.qtRenderDetail({ id: 'g1', title: 'G', status: 'group', comprised_of: ['a1'], _sourceFile: 'todos.q1.todo.yaml' });
            const row = w.document.querySelector('#qt-detail-pane .qt-todo-buttons');
            const buttons = [...row.querySelectorAll('button')] as Win[];
            assert.equal(buttons.length, 8, 'the two toggles, the four run buttons, the two group buttons');
            assert.deepEqual(buttons.slice(6).map((b) => b.getAttribute('data-qt-group-item')), ['default', 'ask'], 'behind the four run buttons');
            assert.match(buttons[6].title, /^Queue as group in the default run \(default@default\)/);
            assert.match(buttons[7].title, /^Queue as group with options: .* asks the quest, run and free session/);
            posted.length = 0;
            buttons[6].click();
            assert.deepEqual(posted.find((m) => m.type === 'qtQueueTodoGroup'), { type: 'qtQueueTodoGroup', questId: posted.find((m) => m.type === 'qtQueueTodoGroup').questId, todoId: 'g1', sourceFile: 'todos.q1.todo.yaml', defaultTarget: true });
            posted.length = 0;
            buttons[7].click();
            const asked = posted.find((m) => m.type === 'qtQueueTodoGroup');
            assert.deepEqual([asked.todoId, 'defaultTarget' in asked], ['g1', false], 'with options: the host asks');
        });
    });
}