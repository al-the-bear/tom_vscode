/**
 * The Prompt Queue editor's line for a turn waiting in tomAi_waitFor (vscimpb82; media/shared/queueEntryRenderFunctions.js
 * renderWaitFor, media/queueEditor/main.js).
 *
 *   QE-1 a sending item with `waitForView` shows `⏳ Waiting: <reason> — until … (… left)`, the details in the tooltip,
 *        and Interrupt the wait and move on, which posts `interruptWaitFor` with the item; a pending item or one without
 *        a view shows no line
 *   QE-2 the time left moves on without a redraw (tickWaitForLines)
 *   QE-3 the run tab's title names the wait
 *   QE-4 the host: waitForViewOf builds the view of a sending item only; the `interruptWaitFor` message reaches the
 *        manager (handler source)
 */

import test, { describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { JSDOM } from 'jsdom';

import type { QueuedPrompt } from '../../managers/promptQueueManager.js';
import { installVscodeStub } from '../../tools/__tests__/_vscode-stub.js';

function readMedia(...parts: string[]): string {
    return readFileSync(join(__dirname, '..', '..', '..', 'media', ...parts), 'utf-8');
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Win = any;

function setup(t: { after(fn: () => void): void }, items: unknown[]): { w: Win; posted: Win[] } {
    const html = readMedia('queueEditor', 'index.html').replace(/<script[\s\S]*?<\/script>/g, '');
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
    w.eval([
        readMedia('shared', 'queueEntryUtils.js'),
        readMedia('shared', 'queueEntryRenderFunctions.js'),
        readMedia('shared', 'queueEntryMessageHandlers.js'),
        readMedia('queueEditor', 'main.js'),
    ].join('\n;\n'));
    return { w, posted };
}

const base = { type: 'normal', template: '(None)', createdAt: '2026-11-13T10:00:00.000Z' };
const UNTIL = new Date(Date.now() + 65 * 60_000 + 20_000).toISOString();
const VIEW = { reason: 'pub.dev limit: 12 versions in 24 h', details: 'the oldest is a day old then', until: UNTIL, untilLabel: '14:20', left: 'until 14:20 (1 h 5 min left)', since: '2026-11-13T12:00:00.000Z' };

describe('Prompt Queue editor — a turn waiting in tomAi_waitFor', () => {
    test('QE-1: the line and its button', (t) => {
        const { w, posted } = setup(t, [
            { ...base, id: 'a', status: 'sending', originalText: 'a', expandedText: 'a', waitForView: VIEW },
            { ...base, id: 'b', status: 'pending', originalText: 'b', expandedText: 'b', waitForView: VIEW },
            { ...base, id: 'c', status: 'sending', originalText: 'c', expandedText: 'c' },
        ]);
        const lines = [...w.document.querySelectorAll('#queueList .wait-for')];
        assert.deepEqual(lines.map((l: Win) => l.dataset.qid), ['a'], 'a sending item with a view only');
        const badge = lines[0].querySelector('.wait-for-badge');
        assert.match(badge.textContent, /^⏳ Waiting: pub\.dev limit: 12 versions in 24 h — until 14:20 \(1 h 5 min left\)$/);
        assert.match(badge.title, /the oldest is a day old then/);
        const btn = lines[0].querySelector('.wait-for-btn');
        assert.equal(btn.textContent, 'Interrupt the wait and move on');
        assert.match(btn.getAttribute('onclick'), /interruptWaitFor\('a'\)/);
        w.interruptWaitFor('a');
        assert.deepEqual(posted.filter((m) => m.type === 'interruptWaitFor'), [{ type: 'interruptWaitFor', id: 'a' }]);
    });

    test('QE-2: the time left moves on', (t) => {
        const { w } = setup(t, [{ ...base, id: 'a', status: 'sending', originalText: 'a', expandedText: 'a', waitForView: VIEW }]);
        const span = w.document.querySelector('.wait-for-left');
        w.tickWaitForLines(w.document, Date.parse(UNTIL) - 10 * 60_000 - 5_000);
        assert.match(span.textContent, /^until (\w{3} )?\d\d:\d\d \(10 min left\)$/);
        w.tickWaitForLines(w.document, Date.parse(UNTIL) - 30_000);
        assert.match(span.textContent, /\(under a minute left\)$/);
    });

    test('QE-3: the run tab names the wait', (t) => {
        const { w } = setup(t, [{ ...base, id: 'a', status: 'sending', originalText: 'a', expandedText: 'a', waitForView: VIEW }]);
        assert.match(w.document.querySelector('#runTabs .run-tab[data-run="default"]').title, /; waiting: pub\.dev limit: 12 versions in 24 h until 14:20$/);
    });

    test('QE-4: the host', (t) => {
        const stub = installVscodeStub();
        t.after(() => stub.restore());
        // eslint-disable-next-line @typescript-eslint/no-require-imports
        const { waitForViewOf } = require('../../handlers/queueEditor-handler.js') as typeof import('../../handlers/queueEditor-handler');
        const state = { reason: 'r', details: 'd', since: '2026-11-13T12:00:00.000Z', until: new Date(Date.now() + 5 * 60_000).toISOString() };
        const view = waitForViewOf({ status: 'sending', waitingFor: state } as unknown as QueuedPrompt);
        assert.equal(view?.reason, 'r');
        assert.equal(view?.details, 'd');
        assert.match(view?.left ?? '', /^until \d\d:\d\d \((4|5) min left\)$/);
        assert.equal(waitForViewOf({ status: 'pending', waitingFor: state } as unknown as QueuedPrompt), undefined);
        assert.equal(waitForViewOf({ status: 'sending' } as unknown as QueuedPrompt), undefined);
        const host = readFileSync(join(__dirname, '..', '..', '..', 'src', 'handlers', 'queueEditor-handler.ts'), 'utf-8');
        const handler = host.slice(host.indexOf("case 'interruptWaitFor':"), host.indexOf("case 'continueSending':"));
        assert.match(handler, /qm\.interruptWaitFor\(String\(msg\.id/);
    });
});
