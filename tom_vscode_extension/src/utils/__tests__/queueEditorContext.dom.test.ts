/**
 * The Prompt Queue editor's context bar (media/queueEditor): Quest, Role and
 * the queue's default Agent SDK session in one line, Role and Session
 * clickable — each opens a VS Code picker on the host.
 *
 *   QC-1 the bar reads `Quest: … | Role: … | Session: …` (then Projects); Role and Session are links;
 *        without a role the Role link offers to set one; there is no separate session row
 *   QC-2 clicking Role posts `pickRole`, clicking Session `pickQueueDefaultSession`; a state update
 *        refreshes the session shown
 */

import test, { describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { JSDOM } from 'jsdom';

function readMedia(...parts: string[]): string {
    return readFileSync(join(__dirname, '..', '..', '..', 'media', ...parts), 'utf-8');
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Win = any;

function setup(t: { after(fn: () => void): void }, state: Record<string, unknown>): { window: Win; posted: Array<Record<string, unknown>> } {
    const html = readMedia('queueEditor', 'index.html').replace(/<script[\s\S]*?<\/script>/g, '');
    const dom = new JSDOM(html, { runScripts: 'outside-only' });
    const window = dom.window as Win;
    t.after(() => window.close());
    const posted: Array<Record<string, unknown>> = [];
    window.acquireVsCodeApi = () => ({ postMessage: (m: Record<string, unknown>) => posted.push({ ...m }), setState: () => undefined, getState: () => undefined });
    window.__INIT__ = { state: { items: [], autoSend: false, ...state } };
    window.eval([
        readMedia('shared', 'queueEntryUtils.js'),
        readMedia('shared', 'queueEntryRenderFunctions.js'),
        readMedia('shared', 'queueEntryMessageHandlers.js'),
        readMedia('queueEditor', 'main.js'),
    ].join('\n;\n'));
    return { window, posted };
}

describe('Prompt Queue editor — the context bar', () => {
    test('QC-1: Quest, Role and Session in one line', (t) => {
        const { window } = setup(t, { context: { quest: 'tom_uam', role: 'spec_author', activeProjects: ['tom_uam'] }, queueDefaultSession: 'p2s3r1ss1' });
        const bar = window.document.getElementById('contextSummary');
        assert.equal(bar.textContent, 'Quest: tom_uam  |  Role: spec_author  |  Session: p2s3r1ss1  |  Projects: tom_uam');
        const links = [...bar.querySelectorAll('.ctx-link')];
        assert.deepEqual(links.map((l: Win) => [l.dataset.pick, l.textContent]), [['role', 'spec_author'], ['session', 'p2s3r1ss1']]);
        assert.equal(window.document.getElementById('queueDefaultSessionRow'), null, 'the session moved into the bar');
        const none = setup(t, { context: { quest: 'q', role: '', activeProjects: [] } }).window.document.getElementById('contextSummary');
        assert.equal(none.textContent, 'Quest: q  |  Role: (none)  |  Session: default');
    });

    test('QC-2: the links open the pickers', (t) => {
        const { window, posted } = setup(t, { context: { quest: 'q', role: 'spec_author', activeProjects: [] }, queueDefaultSession: '' });
        const link = (pick: string): Win => window.document.querySelector(`#contextSummary .ctx-link[data-pick="${pick}"]`);
        link('role').click();
        assert.deepEqual(posted.pop(), { type: 'pickRole' });
        link('session').click();
        assert.deepEqual(posted.pop(), { type: 'pickQueueDefaultSession' });
        window.dispatchEvent(new window.MessageEvent('message', { data: { type: 'state', items: [], context: { quest: 'q', role: 'spec_author', activeProjects: [] }, queueDefaultSession: 'per-todo' } }));
        assert.equal(link('session').textContent, 'per-todo');
    });
});
