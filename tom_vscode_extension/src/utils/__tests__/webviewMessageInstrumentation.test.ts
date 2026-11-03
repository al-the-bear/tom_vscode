/**
 * instrumentWebviewMessages (src/utils/webviewMessageInstrumentation.ts): the
 * debug log's view of what a webview posts.
 *
 *   WM-1 one message to a webview with two listeners is logged ONCE, and both
 *        listeners receive it (the chat panel has two; every click was logged twice)
 *   WM-2 skipped types (polling) are not logged, and still delivered
 *   WM-3 a throwing listener is reported with its message type, per listener,
 *        and the error still reaches the caller
 *   WM-4 instrumenting twice changes nothing (one log line, listeners called once)
 *   WM-5 functions in a payload are logged as [Function]
 */

import test, { describe } from 'node:test';
import assert from 'node:assert/strict';
import { instrumentWebviewMessages } from '../webviewMessageInstrumentation.js';

type Listener = (m: unknown) => unknown;

/** The part of a VS Code webview the helper touches: an event others subscribe to. */
function fakeWebview() {
    const listeners: Listener[] = [];
    const webview = {
        onDidReceiveMessage(listener: Listener, thisArgs?: unknown) {
            const bound = (m: unknown) => listener.call(thisArgs, m);
            listeners.push(bound);
            return { dispose: () => { listeners.splice(listeners.indexOf(bound), 1); } };
        },
    };
    /** Fire one message the way VS Code's emitter does: every listener, in order. */
    const post = async (m: unknown): Promise<PromiseSettledResult<unknown>[]> => Promise.allSettled(listeners.map(async (l) => l(m)));
    return { webview, post, listeners };
}

function setup(skipTypes: string[] = []) {
    const fake = fakeWebview();
    const logged: string[] = [];
    const reported: Array<{ where: string; type: unknown }> = [];
    instrumentWebviewMessages(fake.webview, {
        source: 'tomAi.chatPanel',
        skipTypes,
        log: (line) => { logged.push(line); },
        report: (where, _err, details) => { reported.push({ where, type: details.messageType }); },
    });
    return { ...fake, logged, reported };
}

describe('webview message instrumentation', () => {
    test('WM-1: one log line per message, every listener called', async () => {
        const w = setup();
        const a: unknown[] = []; const b: unknown[] = [];
        w.webview.onDidReceiveMessage((m) => { a.push(m); });
        w.webview.onDidReceiveMessage((m) => { b.push(m); });
        await w.post({ type: 'anthropicToolApprovalResponse', approved: true });
        assert.equal(w.logged.length, 1);
        assert.match(w.logged[0], /^tomAi\.chatPanel payload=\{"type":"anthropicToolApprovalResponse","approved":true\}$/);
        assert.equal(a.length, 1);
        assert.equal(b.length, 1);
    });

    test('WM-2: skipped types are not logged but delivered', async () => {
        const w = setup(['poll']);
        const got: unknown[] = [];
        w.webview.onDidReceiveMessage((m) => { got.push(m); });
        await w.post({ type: 'poll' });
        await w.post({ type: 'send' });
        assert.equal(w.logged.length, 1);
        assert.equal(got.length, 2);
    });

    test('WM-3: a throwing listener is reported and the error kept', async () => {
        const w = setup();
        w.webview.onDidReceiveMessage(() => { throw new Error('boom'); });
        w.webview.onDidReceiveMessage(() => undefined);
        // The first listener is the instrumentation's own logger.
        const [logger, throwing, quiet] = await w.post({ type: 'send' });
        assert.equal(logger.status, 'fulfilled');
        assert.equal(throwing.status, 'rejected');
        assert.equal(quiet.status, 'fulfilled');
        assert.deepEqual(w.reported, [{ where: 'tomAi.chatPanel.onDidReceiveMessage', type: 'send' }]);
    });

    test('WM-4: instrumenting twice changes nothing', async () => {
        const fake = fakeWebview();
        const logged: string[] = [];
        const opts = { source: 'v', log: (l: string) => { logged.push(l); }, report: () => undefined };
        instrumentWebviewMessages(fake.webview, opts);
        instrumentWebviewMessages(fake.webview, opts);
        let calls = 0;
        fake.webview.onDidReceiveMessage(() => { calls++; });
        await fake.post({ type: 'x' });
        assert.equal(logged.length, 1);
        assert.equal(calls, 1);
    });

    test('WM-5: functions in a payload', async () => {
        const w = setup();
        await w.post({ type: 'x', cb: () => 1 });
        assert.match(w.logged[0], /"cb":"\[Function\]"/);
    });
});
