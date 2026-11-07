/**
 * The @CHAT panel's plan-mode UI (media/chatPanel/main.js), in a JSDOM running the real script (CC-3, CC-27).
 *
 *   CP-1 `planMode {active}` shows and hides the badge; its Leave plan mode button posts `leavePlanMode`
 *   CP-2 `planProposal {id, html}` opens the ANTHROPIC/LLM subpanel and shows the plan; Accept posts
 *        `planDecision {accepted: true}`, Keep planning `{accepted: false, feedback}`; a second plan waits its
 *        turn; the same id sent twice (a restarted webview) is shown once; `planProposalSettled` closes it
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
    w.acquireVsCodeApi = () => ({
        postMessage: (m: Record<string, unknown>) => posted.push(JSON.parse(JSON.stringify(m))),
        setState: () => undefined,
        getState: () => ({ expanded: ['copilot'], pinned: [] }),
    });
    w.__INIT__ = {};
    w.eval(media('chatPanel', 'main.js'));
    const send = (data: Record<string, unknown>) => w.dispatchEvent(new w.MessageEvent('message', { data }));
    const $ = (id: string) => w.document.getElementById(id);
    const click = (action: string) => w.document.querySelector(`[data-action="${action}"]`).click();
    return { w, posted, send, $, click };
}

describe('chat panel: plan mode', () => {
    test('CP-1: the badge', (t) => {
        const s = setup(t);
        assert.equal(s.$('anthropic-plan-badge').style.display, 'none');
        s.send({ type: 'planMode', active: true });
        assert.equal(s.$('anthropic-plan-badge').style.display, 'flex');
        assert.match(s.$('anthropic-plan-badge').textContent, /Plan mode: read and plan only/);
        s.click('leavePlanMode');
        assert.ok(s.posted.some((m) => m.type === 'leavePlanMode'));
        s.send({ type: 'planMode', active: false });
        assert.equal(s.$('anthropic-plan-badge').style.display, 'none');
    });

    test('CP-2: a proposed plan', (t) => {
        const s = setup(t);
        const section = s.w.document.querySelector('[data-section="anthropic"]');
        assert.ok(section.classList.contains('collapsed'));
        s.send({ type: 'planProposal', id: 'plan-1', html: '<h2>Step 1</h2><p>Read the code</p>' });
        s.send({ type: 'planProposal', id: 'plan-1', html: '<h2>Step 1</h2>' });
        s.send({ type: 'planProposal', id: 'plan-2', html: '<p>Second plan</p>' });
        assert.ok(section.classList.contains('expanded'), 'the subpanel opens');
        assert.equal(s.$('anthropic-plan-overlay').style.display, 'block');
        assert.match(s.$('anthropic-plan-body').textContent, /Step 1.*Read the code/s);
        s.$('anthropic-plan-feedback').value = 'split step 1';
        s.click('planKeep');
        const decisions = () => s.posted.filter((m) => m.type === 'planDecision');
        assert.deepEqual(decisions(), [{ type: 'planDecision', id: 'plan-1', accepted: false, feedback: 'split step 1' }]);
        assert.match(s.$('anthropic-plan-body').textContent, /Second plan/, 'the next plan, once');
        assert.equal(s.$('anthropic-plan-feedback').value, '', 'the note starts empty');
        s.click('planAccept');
        assert.deepEqual(decisions()[1], { type: 'planDecision', id: 'plan-2', accepted: true, feedback: '' });
        assert.equal(s.$('anthropic-plan-overlay').style.display, 'none');
        s.send({ type: 'planProposal', id: 'plan-3', html: '<p>Third</p>' });
        s.send({ type: 'planProposalSettled', id: 'plan-3' });
        assert.equal(s.$('anthropic-plan-overlay').style.display, 'none', 'settled elsewhere (the badge): closed');
    });
});
