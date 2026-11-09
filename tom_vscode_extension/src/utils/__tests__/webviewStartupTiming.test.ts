/**
 * Start-up timings in the debug log (src/utils/webviewStartupTiming.ts).
 *
 *   ST-1 a view's resolve is logged with its time after activation began; its
 *        first post and first received message once each, with the time after
 *        the resolve and the message type; later traffic is not logged, and
 *        posts still reach the webview
 *   ST-2 tracking a webview twice logs nothing more
 *   ST-3 the stall monitor logs every probe late by the threshold, with the
 *        time it ended, and a summary when it stops after its duration
 *   ST-4 stopping the monitor early writes the summary once and stops the probe
 */

import test, { describe } from 'node:test';
import assert from 'node:assert/strict';
import { monitorStartupStalls, trackWebviewStartup } from '../webviewStartupTiming.js';

type Listener = (m: unknown) => unknown;

function fakeWebview() {
    const listeners: Listener[] = [];
    const delivered: unknown[] = [];
    const webview = {
        postMessage(message: unknown): Thenable<boolean> {
            delivered.push(message);
            return Promise.resolve(true);
        },
        onDidReceiveMessage(listener: Listener) {
            listeners.push(listener);
            return { dispose() { /* not needed */ } };
        },
    };
    const receive = (m: unknown): void => { for (const l of listeners) { l(m); } };
    return { webview, delivered, receive };
}

describe('trackWebviewStartup', () => {
    test('ST-1: resolve, first post and first message, once each', async () => {
        let clock = 1500;
        const lines: string[] = [];
        const fake = fakeWebview();
        trackWebviewStartup(fake.webview, 'tomAi.wsPanel', 1000, (l) => lines.push(l), () => clock);
        clock = 1540;
        await fake.webview.postMessage({ type: 'guidelinesGroups' });
        clock = 1600;
        await fake.webview.postMessage({ type: 'docsGroups' });
        clock = 2700;
        fake.receive({ type: 'getGuidelinesGroups' });
        fake.receive({ type: 'getDocsGroups' });
        assert.deepEqual(lines, [
            'startup tomAi.wsPanel: resolved +500ms after activation began',
            'startup tomAi.wsPanel: first post (guidelinesGroups) +40ms after resolve',
            'startup tomAi.wsPanel: first message (getGuidelinesGroups) +1200ms after resolve',
        ]);
        assert.deepEqual(fake.delivered, [{ type: 'guidelinesGroups' }, { type: 'docsGroups' }]);
    });

    test('ST-2: tracking twice logs nothing more', async () => {
        const lines: string[] = [];
        const fake = fakeWebview();
        trackWebviewStartup(fake.webview, 'v', undefined, (l) => lines.push(l), () => 0);
        trackWebviewStartup(fake.webview, 'v', undefined, (l) => lines.push(l), () => 0);
        await fake.webview.postMessage({ type: 'x' });
        fake.receive('not an object');
        assert.deepEqual(lines, [
            'startup v: resolved',
            'startup v: first post (x) +0ms after resolve',
            'startup v: first message (?) +0ms after resolve',
        ]);
    });
});

describe('monitorStartupStalls', () => {
    function harness(durationMs: number) {
        let clock = 0;
        let probe: (() => void) | undefined;
        let cleared = 0;
        const lines: string[] = [];
        const stop = monitorStartupStalls({
            durationMs,
            intervalMs: 100,
            thresholdMs: 250,
            log: (l) => lines.push(l),
            now: () => clock,
            setInterval: (fn) => { probe = fn; return 'handle'; },
            clearInterval: (h) => { assert.equal(h, 'handle'); cleared++; },
        });
        const tick = (at: number): void => { clock = at; probe?.(); };
        return { lines, stop, tick, cleared: () => cleared };
    }

    test('ST-3: late probes are stalls; a summary after the duration', () => {
        const h = harness(1000);
        h.tick(100);
        h.tick(200);
        h.tick(600); // 300ms late
        h.tick(700);
        h.tick(1100); // 300ms late, and past the duration
        assert.deepEqual(h.lines, [
            'startup stall: event loop held 300ms (ending +600ms)',
            'startup stall: event loop held 300ms (ending +1100ms)',
            'startup stalls: 2 of >=250ms in 1100ms, longest 300ms, total 600ms',
        ]);
        assert.equal(h.cleared(), 1);
    });

    test('ST-4: stopped early, the summary is written once', () => {
        const h = harness(60_000);
        h.tick(100);
        h.stop();
        h.stop();
        assert.deepEqual(h.lines, ['startup stalls: 0 of >=250ms in 100ms, longest 0ms, total 0ms']);
        assert.equal(h.cleared(), 1);
    });
});
