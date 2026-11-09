/**
 * Queued todos (src/utils/todoQueueMarks.ts, QM-*).
 *
 *   QM-1 an item's todo id pattern: its own todoIdPattern, else a `<prefix>*` repeat count, else none
 *   QM-2 a pattern names a todo: an exact id whatever its status; `<prefix>*` the open todos with that prefix;
 *        several, comma-separated
 *   QM-3 the status rank is the queue editor's (statusSortRank in media/shared/queueEntryUtils.js), status by status
 *   QM-4 the numbers are the `#N` the queue editor shows each item with (its list rendered in jsdom)
 *   QM-5 the marks: only items that have not finished, every one that names the todo, ascending; `walks: false`
 *        keeps the exact ids only; the tooltip names the first and the others
 *   QM-6 the todo panel: a queued todo's row shows `⏵#N` with the tooltip; a group with queued todos shows the
 *        first number on its header (collapsed groups hide the rows), the tooltip naming every item and how many
 *        of its todos; `qtQueueChanged` loads the list again
 */

import test, { describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import * as vm from 'node:vm';
import { JSDOM } from 'jsdom';

import {
    queueDisplayNumbers, statusSortRank, todoIdPatternMatches, todoIdPatternOf, todoQueueMarks, todoQueueMarkTitle,
} from '../todoQueueMarks.js';

const ROOT = join(__dirname, '..', '..', '..');
const media = (...p: string[]): string => readFileSync(join(ROOT, 'media', ...p), 'utf-8');
const STATUSES = ['decision-needed', 'error', 'retry', 'waiting', 'interrupted', 'sending', 'chat', 'pending', 'staged', 'sent', 'chat-sent', 'odd'];

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Win = any;

describe('queued todos', () => {
    test('QM-1: the pattern of an item', () => {
        assert.equal(todoIdPatternOf({ todoIdPattern: 'chat9_akiq-x' }), 'chat9_akiq-x');
        assert.equal(todoIdPatternOf({ repeatCount: 'chat*' }), 'chat*', 'a group walk');
        assert.equal(todoIdPatternOf({ repeatCount: ' chat* ', todoIdPattern: '' }), 'chat*');
        assert.equal(todoIdPatternOf({ repeatCount: 3 }), undefined);
        assert.equal(todoIdPatternOf({ repeatCount: '*' }), undefined, 'a bare * names no prefix');
        assert.equal(todoIdPatternOf({ repeatCount: 'chat*', todoIdPattern: 'other1' }), 'other1', 'its own field first');
    });

    test('QM-2: which todos a pattern names', () => {
        assert.equal(todoIdPatternMatches('chat9', { id: 'chat9', status: 'completed' }), true, 'an exact id, whatever its status');
        assert.equal(todoIdPatternMatches('chat9', { id: 'chat90' }), false);
        assert.equal(todoIdPatternMatches('chat*', { id: 'chat10_x', status: 'not-started' }), true);
        assert.equal(todoIdPatternMatches('chat*', { id: 'chat10_x', status: 'completed' }), false, 'a walk passes closed todos');
        assert.equal(todoIdPatternMatches('chat*', { id: 'chat10_x', status: 'cancelled' }), false);
        assert.equal(todoIdPatternMatches('chat*', { id: 'other' }), false);
        assert.equal(todoIdPatternMatches('a1, b2', { id: 'b2' }), true, 'several');
    });

    test('QM-3: the editor\'s status rank', () => {
        const context: Record<string, unknown> = {};
        vm.createContext(context);
        vm.runInContext(media('shared', 'queueEntryUtils.js'), context);
        const webviewRank = context.statusSortRank as (s: string) => number;
        for (const status of STATUSES) {
            assert.equal(statusSortRank(status), webviewRank(status), status);
        }
    });

    test('QM-4: the numbers the queue editor shows', () => {
        const at = (m: number): string => new Date(Date.UTC(2026, 10, 9, 10, m)).toISOString();
        const base = { type: 'normal', transport: 'copilot', template: '(None)', expandedText: '', prePrompts: [], followUps: [] };
        const items = [
            { ...base, id: 's1', status: 'sent', createdAt: at(1), originalText: 'prompt-alpha' },
            { ...base, id: 'p1', status: 'pending', createdAt: at(2), originalText: 'prompt-bravo' },
            { ...base, id: 'st', status: 'staged', createdAt: at(3), originalText: 'prompt-charlie' },
            { ...base, id: 'sd', status: 'sending', createdAt: at(4), originalText: 'prompt-delta' },
            { ...base, id: 'p2', status: 'pending', createdAt: at(5), originalText: 'prompt-echo' },
            { ...base, id: 's2', status: 'sent', createdAt: at(6), originalText: 'prompt-foxtrot' },
            { ...base, id: 'dn', status: 'decision-needed', createdAt: at(7), originalText: 'prompt-golf' },
        ];
        const html = media('queueEditor', 'index.html').replace(/<script[\s\S]*?<\/script>/g, '');
        const w = new JSDOM(html, { runScripts: 'outside-only' }).window as Win;
        try {
            w.acquireVsCodeApi = () => ({ postMessage: () => undefined, setState: () => undefined, getState: () => undefined });
            w.__INIT__ = { state: { items, autoSend: false, anthropicProfiles: [] }, queueDefaultPickerHtml: '', addFormPickerHtml: '' };
            w.eval([media('shared', 'mdOverlay.js'), media('shared', 'queueEntryUtils.js'), media('shared', 'queueEntryRenderFunctions.js'), media('shared', 'queueEntryMessageHandlers.js'), media('queueEditor', 'main.js')].join('\n;\n'));
            // Each item by its unique prompt text; its number from its header.
            const shown = new Map<string, number>();
            for (const el of w.document.querySelectorAll('.queue-item')) {
                const item = items.find((i) => (el.textContent ?? '').includes(i.originalText));
                const n = /#(\d+)/.exec(el.querySelector('.item-header')?.textContent ?? '');
                if (item && n) { shown.set(item.id, Number(n[1])); }
            }
            assert.equal(shown.size, items.length, 'every item numbered');
            assert.deepEqual(queueDisplayNumbers(items), shown);
        } finally {
            w.close();
        }
    });

    test('QM-5: the marks', () => {
        const items = [
            { id: 'walk', status: 'sending', repeatCount: 'chat*' },
            { id: 'one', status: 'pending', todoIdPattern: 'chat10' },
            { id: 'done', status: 'sent', todoIdPattern: 'chat11' },
            { id: 'two', status: 'staged', todoIdPattern: 'chat10,other1' },
        ];
        const todos = [
            { id: 'chat10', status: 'not-started' },
            { id: 'chat11', status: 'not-started' },
            { id: 'chat12', status: 'completed' },
            { id: 'other1' },
            { id: 'free' },
        ];
        const marks = todoQueueMarks(items, todos);
        assert.deepEqual(Object.fromEntries(marks), { chat10: [1, 2, 3], chat11: [1], other1: [3] }, 'the walk (#1), then #2 and #3; a finished item names nothing');
        const otherQuest = todoQueueMarks(items, todos, { walks: false });
        assert.deepEqual(Object.fromEntries(otherQuest), { chat10: [2, 3], other1: [3] }, 'another quest: exact ids only');
        assert.equal(todoQueueMarkTitle([2]), 'Queued: #2');
        assert.equal(todoQueueMarkTitle([1, 2, 3]), 'Queued: #1 (first), #2, #3');
        assert.equal(todoQueueMarks([], todos).size, 0);
    });

    test('QM-6: the todo panel row and its refresh', () => {
        const html = media('questTodoPanel', 'fragment.html');
        const w = new JSDOM(`<body>${html}</body>`, { runScripts: 'outside-only' }).window as Win;
        try {
            const posted: Array<Record<string, unknown>> = [];
            w.vscode = { postMessage: (m: Record<string, unknown>) => posted.push(m), setState: () => undefined, getState: () => undefined };
            w.eval('var qtViewConfig = {};\n' + media('questTodoPanel', 'grouping.js') + media('questTodoPanel', 'main.js'));
            // The views route every `qt*` message to qtHandleMessage (media/wsPanel/main.js and the todo editors).
            const fire = (data: Record<string, unknown>): void => { w.qtHandleMessage(data); };
            fire({ type: 'qtTodos', questId: 'q1', file: 'all', todos: [
                { id: 'chat10', title: 'Queued twice', status: 'not-started', sourceFile: 'todos.q1.todo.yaml', queued: [2, 5], queuedTitle: 'Queued: #2 (first), #5' },
                { id: 'free', title: 'Not queued', status: 'not-started', sourceFile: 'todos.q1.todo.yaml' },
            ] });
            const group = w.document.querySelector('.qt-group-header[data-qt-group="chat"] .qt-group-queued');
            assert.ok(group, 'the (collapsed) group shows it');
            assert.equal(group.textContent, '⏵#2');
            assert.equal(group.getAttribute('title'), 'Queued: #2 (first), #5 — 1 of 1 todos');
            w.eval("qtExpandedGroups['#chat'] = true;");
            w.qtRenderList();
            const mark = w.document.querySelector('[data-qt-id="chat10"] .qt-queued');
            assert.ok(mark, 'the queued todo is marked');
            assert.equal(mark.textContent, '⏵#2', 'the first item\'s number');
            assert.equal(mark.getAttribute('title'), 'Queued: #2 (first), #5', 'the tooltip names every one');
            assert.equal(w.document.querySelector('[data-qt-id="free"] .qt-queued'), null);
            posted.length = 0;
            fire({ type: 'qtQueueChanged' });
            assert.deepEqual(posted.filter((m) => m.type === 'qtGetTodos').length, 1, 'the list is loaded again');
        } finally {
            w.close();
        }
    });
});
