/**
 * The @CHAT panel's tool-approval dialog (media/chatPanel/main.js), in a JSDOM running the real script.
 *
 *   CA-1 the webview reports approvalUiReady when it has started
 *   CA-2 a request opens the Anthropic subpanel when another one (Copilot) was shown, and shows the dialog
 *   CA-3 requests arriving while one is shown wait their turn: each gets its own answer, in order; the same
 *        request sent twice (a reloaded webview) is shown once
 *   CA-4 a request settled elsewhere (Stop, a queue cancel) leaves the dialog, the next one shows
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

function setup(t: { after(fn: () => void): void }) {
    const html = media('chatPanel', 'index.html').replace(/<script[\s\S]*?<\/script>/g, '');
    const dom = new JSDOM(html, { runScripts: 'outside-only' });
    const w = dom.window as Win;
    t.after(() => w.close());
    const posted: Array<Record<string, unknown>> = [];
    // The user last looked at the Copilot subpanel.
    w.acquireVsCodeApi = () => ({
        postMessage: (m: Record<string, unknown>) => posted.push(JSON.parse(JSON.stringify(m))),
        setState: () => undefined,
        getState: () => ({ expanded: ['copilot'], pinned: [] }),
    });
    w.__INIT__ = {};
    w.eval(media('chatPanel', 'main.js'));
    const send = (data: Record<string, unknown>) => w.dispatchEvent(new w.MessageEvent('message', { data }));
    const section = (id: string) => w.document.querySelector(`[data-section="${id}"]`);
    const overlay = () => w.document.getElementById('anthropic-approval-overlay');
    const body = () => w.document.getElementById('anthropic-approval-body').textContent as string;
    const click = (action: string) => w.document.querySelector(`#anthropic-approval-overlay [data-action="${action}"]`).click();
    const answers = () => posted.filter((m) => m.type === 'anthropicToolApprovalResponse');
    return { w, posted, send, section, overlay, body, click, answers };
}

const request = (toolId: string, toolName = 'tomAi_editFile') => ({ type: 'anthropicToolApproval', toolId, toolName, inputSummary: `input ${toolId}` });

describe('chat panel: tool approval', () => {
    test('CA-1: ready', (t) => {
        const s = setup(t);
        assert.ok(s.posted.some((m) => m.type === 'approvalUiReady'));
    });

    test('CA-2: the Anthropic subpanel opens', (t) => {
        const s = setup(t);
        assert.ok(s.section('anthropic').classList.contains('collapsed'), 'Copilot was shown');
        s.send(request('t1'));
        assert.ok(s.section('anthropic').classList.contains('expanded'), 'the Anthropic subpanel is open');
        assert.equal(s.overlay().style.display, 'block');
        assert.match(s.body(), /Tool: tomAi_editFile[\s\S]*input t1/);
    });

    test('CA-3: one at a time, each answered', (t) => {
        const s = setup(t);
        s.send(request('t1'));
        s.send(request('t2', 'tomAi_runCommand'));
        s.send(request('t1'));
        assert.match(s.body(), /input t1[\s\S]*1 more waiting/);
        s.click('anthropicApprovalApprove');
        assert.deepEqual(s.answers(), [{ type: 'anthropicToolApprovalResponse', toolId: 't1', approved: true, approveAll: false }]);
        assert.equal(s.overlay().style.display, 'block', 'the next request shows');
        assert.match(s.body(), /tomAi_runCommand[\s\S]*input t2/);
        s.click('anthropicApprovalDeny');
        assert.deepEqual(s.answers().map((m) => [m.toolId, m.approved]), [['t1', true], ['t2', false]]);
        assert.equal(s.overlay().style.display, 'none');
        s.send(request('t1'));
        assert.equal(s.overlay().style.display, 'block', 'an id answered before may come again (a new request)');
    });

    test('CA-4: settled elsewhere', (t) => {
        const s = setup(t);
        s.send(request('a'));
        s.send(request('b'));
        s.send({ type: 'anthropicToolApprovalSettled', toolId: 'a' });
        assert.match(s.body(), /input b/);
        s.send({ type: 'anthropicToolApprovalSettled', toolId: 'b' });
        assert.equal(s.overlay().style.display, 'none');
        assert.deepEqual(s.answers(), [], 'no answer is sent for a settled request');
    });
});
