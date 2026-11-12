/**
 * The @CHAT ANTHROPIC/LLM subpanel shows a queue item waiting for its background work (vscimpb57), with the queue
 * editor's line, ? list and three choices.
 *
 *   CW-1 nothing waits: the line is hidden; a `queueBackgroundWaits` message shows one line per waiting item (count,
 *        running time, limit), an empty one hides it again
 *   CW-2 the ? opens the list of running tasks (command, output file / handle); the buttons post
 *        `queueBackgroundWaitAction` with the item and the choice; Wait without limit is disabled with no limit
 *   CW-3 the host: it sends the waiting items (backgroundWaitViewOf) on queue changes and each minute, and routes a
 *        button to the manager through applyBackgroundWaitAction, the queue editor's own
 */

import test, { afterEach, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { JSDOM } from 'jsdom';

const ROOT = join(__dirname, '..', '..', '..');
const media = (...p: string[]): string => readFileSync(join(ROOT, 'media', ...p), 'utf-8');
const src = (...p: string[]): string => readFileSync(join(ROOT, 'src', ...p), 'utf-8');

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Win = any;
const open: Win[] = [];
afterEach(() => { while (open.length) { open.pop().close(); } });

function chatPanel(): { w: Win; posted: Array<Record<string, unknown>> } {
    const html = media('chatPanel', 'index.html').replace(/<script[\s\S]*?<\/script>/g, '');
    const w = new JSDOM(html, { runScripts: 'outside-only' }).window as Win;
    open.push(w);
    const posted: Array<Record<string, unknown>> = [];
    w.acquireVsCodeApi = () => ({ postMessage: (m: Record<string, unknown>) => posted.push(JSON.parse(JSON.stringify(m))), setState: () => undefined, getState: () => ({ expanded: ['anthropic'], pinned: [] }) });
    w.__INIT__ = {};
    w.eval(media('chatPanel', 'main.js'));
    return { w, posted };
}

function deliver(w: Win, msg: unknown): void {
    w.dispatchEvent(new w.MessageEvent('message', { data: msg }));
}

const WAIT = {
    id: 'q7',
    label: 'work on ww3_x',
    view: {
        line: '2 tasks, 1 h 20 min of 6 h', limit: '6 h', unlimited: false,
        items: [
            { id: 'b1', kind: 'task', description: 'Wait for the corpus run', command: 'until [ -f done ]; do sleep 30; done', outputFile: '/tmp/b1.output' },
            { id: 'proc_2', kind: 'command', description: 'npm test', command: 'npm test' },
        ],
    },
};

describe('@CHAT: a queue item waiting for its background work', () => {
    test('CW-1: shown while an item waits', () => {
        const { w } = chatPanel();
        const box = w.document.getElementById('anthropic-bg-waits');
        assert.ok(box, 'the line lives in the ANTHROPIC/LLM subpanel');
        assert.equal(box.style.display, 'none');
        deliver(w, { type: 'queueBackgroundWaits', waits: [WAIT] });
        assert.equal(box.style.display, '');
        assert.match(box.querySelector('.bg-wait-badge').textContent, /Queue: waiting for background work — 2 tasks, 1 h 20 min of 6 h/);
        assert.match(box.querySelector('.bg-wait-badge').title, /work on ww3_x/);
        deliver(w, { type: 'queueBackgroundWaits', waits: [] });
        assert.equal(box.style.display, 'none');
    });

    test('CW-2: the ? list and the three buttons', () => {
        const { w, posted } = chatPanel();
        deliver(w, { type: 'queueBackgroundWaits', waits: [WAIT, { ...WAIT, id: 'q8', view: { ...WAIT.view, unlimited: true, line: '1 task, 3 h, no limit' } }] });
        const box = w.document.getElementById('anthropic-bg-waits');
        const first = box.querySelector('.bg-wait[data-qid="q7"]');
        assert.equal(first.querySelector('.bg-wait-list'), null);
        first.querySelector('[data-bg-action="toggle"]').click();
        const list = box.querySelector('.bg-wait[data-qid="q7"] .bg-wait-list');
        assert.match(list.textContent, /Wait for the corpus run \[b1\]/);
        assert.match(list.textContent, /until \[ -f done \]; do sleep 30; done/);
        assert.match(list.textContent, /output: \/tmp\/b1\.output/);
        assert.match(list.textContent, /npm test \[handle proc_2\]/);
        posted.length = 0;
        for (const action of ['waitWithoutLimit', 'keepWaiting', 'stopWaiting']) {
            box.querySelector(`.bg-wait[data-qid="q7"] [data-bg-action="${action}"]`).click();
        }
        assert.deepEqual(posted, [
            { type: 'queueBackgroundWaitAction', id: 'q7', action: 'waitWithoutLimit' },
            { type: 'queueBackgroundWaitAction', id: 'q7', action: 'keepWaiting' },
            { type: 'queueBackgroundWaitAction', id: 'q7', action: 'stopWaiting' },
        ]);
        assert.equal(box.querySelector('.bg-wait[data-qid="q7"] [data-bg-action="keepWaiting"]').textContent, 'Keep waiting up to 6 h');
        assert.equal(box.querySelector('.bg-wait[data-qid="q8"] [data-bg-action="waitWithoutLimit"]').disabled, true);
        assert.match(media('chatPanel', 'style.css'), /\.bg-wait \{/);
    });

    test('CW-3: the host', () => {
        const handler = src('handlers', 'chatPanel-handler.ts');
        assert.match(handler, /this\._watchQueueBackgroundWaits\(webviewView\);/);
        assert.match(handler, /backgroundWaitViewOf\(item\)/);
        assert.match(handler, /queue\.onDidChange\(send\)/);
        assert.match(handler, /setInterval\(send, 60_000\)/);
        assert.match(handler, /case 'queueBackgroundWaitAction':[\s\S]{0,400}applyBackgroundWaitAction\(queueModule\.PromptQueueManager\.instance, String\(message\.id \?\? ''\), message\.action\)/);
    });
});
