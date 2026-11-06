/**
 * Tool-approval requests brought in front of the user (src/utils/approvalRelay.ts).
 *
 *   AR-1 a request reveals the chat view every time and is posted at once when the webview is ready
 *   AR-2 a request made while the view does not exist (or its webview has not started) is posted when the
 *        webview reports ready, oldest first; requests settled in between are not
 *   AR-3 a settled request is dropped and the webview told; settling an unknown id does nothing
 */

import test, { describe } from 'node:test';
import assert from 'node:assert/strict';

import { ApprovalRelay } from '../approvalRelay.js';

function harness(ready: boolean) {
    const posted: Array<Record<string, unknown>> = [];
    let reveals = 0;
    const host = { ready, isReady: () => host.ready, reveal: () => { reveals++; }, post: (m: Record<string, unknown>) => { posted.push(m); } };
    return { relay: new ApprovalRelay(host), host, posted, reveals: () => reveals };
}

const req = (id: string, tool = 'tomAi_editFile') => ({ toolUseId: id, toolName: tool, inputSummary: `input of ${id}` });

describe('approval relay', () => {
    test('AR-1: reveal and post', () => {
        const h = harness(true);
        h.relay.request(req('t1'));
        h.relay.request(req('t2', 'tomAi_runCommand'));
        assert.equal(h.reveals(), 2, 'the view is brought forward for every request');
        assert.deepEqual(h.posted, [
            { type: 'anthropicToolApproval', toolId: 't1', toolName: 'tomAi_editFile', inputSummary: 'input of t1' },
            { type: 'anthropicToolApproval', toolId: 't2', toolName: 'tomAi_runCommand', inputSummary: 'input of t2' },
        ]);
        assert.deepEqual(h.relay.openIds, ['t1', 't2']);
    });

    test('AR-2: a view that is not ready yet', () => {
        const h = harness(false);
        h.relay.request(req('a'));
        h.relay.request(req('b'));
        h.relay.request(req('c'));
        assert.equal(h.reveals(), 3, 'revealing opens the view');
        assert.equal(h.posted.length, 0, 'nothing posted before the webview can show it');
        h.relay.settled('b');
        assert.equal(h.posted.length, 0, 'settling is not posted to a webview that is not there');
        h.host.ready = true;
        h.relay.ready();
        assert.deepEqual(h.posted.map((m) => m.toolId), ['a', 'c']);
        assert.equal(h.reveals(), 4);
        h.posted.length = 0;
        h.relay.ready();
        assert.deepEqual(h.posted.map((m) => m.toolId), ['a', 'c'], 'a reloaded webview gets the open requests again');
    });

    test('AR-3: settled', () => {
        const h = harness(true);
        h.relay.request(req('x'));
        h.posted.length = 0;
        h.relay.settled('x');
        assert.deepEqual(h.posted, [{ type: 'anthropicToolApprovalSettled', toolId: 'x' }]);
        assert.deepEqual(h.relay.openIds, []);
        h.relay.settled('x');
        h.relay.settled('never');
        assert.equal(h.posted.length, 1, 'unknown ids are ignored');
        const reveals = h.reveals();
        h.relay.ready();
        assert.equal(h.reveals(), reveals, 'nothing open: no reveal on ready');
    });
});
