/**
 * Tool-impl tests for `notify-user-tool.ts` — `tomAi_notifyUser`.
 *
 * Strategy: a spied `NotificationChannels` fake records every method
 * called + its args, with a programmable Telegram return so the
 * auto-fallback path can be exercised in both directions.
 *
 * Coverage entry #22 four-row checklist:
 *
 *   a) Description clarity — verified in the impl file; the 4
 *      channels (auto/vscode/statusbar/telegram), 3 urgency levels,
 *      modal vs non-modal, and dismissal semantics are documented.
 *   b) Ambiguities — covered:
 *        - modal vs non-modal: modal: true blocks and returns
 *          dismissedBy; non-modal returns immediately
 *        - dismissal semantics: button label or "close" surfaced
 *        - Telegram configured vs not (auto fallback)
 *        - Telegram requested but unavailable: explicit error
 *   c) Spied channels assert which urgency-method was called.
 *   d) Timing — sub-ms via `withTiming` (no real network).
 */

import test, { beforeEach, describe } from 'node:test';
import assert from 'node:assert/strict';

import { withTiming } from './_timing.js';
import {
    notifyUserImpl,
    type NotificationChannels,
} from '../notify-user-tool.js';

// ===========================================================================
// Spied channels fake
// ===========================================================================

interface ChannelCall {
    method: 'showInformation' | 'showWarning' | 'showError' | 'setStatusBarMessage' | 'sendTelegram';
    args: unknown[];
}

interface SpiedChannels extends NotificationChannels {
    calls: ChannelCall[];
    setTelegram(result: { ok: true } | { ok: false; reason: string } | null): void;
    setVscodeDismissedBy(label: string | undefined): void;
}

function makeChannels(): SpiedChannels {
    const calls: ChannelCall[] = [];
    let telegramResult: { ok: true } | { ok: false; reason: string } | null = null;
    let dismissedBy: string | undefined = undefined;
    return {
        calls,
        setTelegram(r) { telegramResult = r; },
        setVscodeDismissedBy(label) { dismissedBy = label; },
        async showInformation(text, opts) {
            calls.push({ method: 'showInformation', args: [text, opts] });
            return dismissedBy;
        },
        async showWarning(text, opts) {
            calls.push({ method: 'showWarning', args: [text, opts] });
            return dismissedBy;
        },
        async showError(text, opts) {
            calls.push({ method: 'showError', args: [text, opts] });
            return dismissedBy;
        },
        setStatusBarMessage(text, timeoutMs) {
            calls.push({ method: 'setStatusBarMessage', args: [text, timeoutMs] });
        },
        sendTelegram(text) {
            calls.push({ method: 'sendTelegram', args: [text] });
            if (telegramResult === null) { return null; }
            return Promise.resolve(telegramResult);
        },
    };
}

let channels: SpiedChannels;
beforeEach(() => { channels = makeChannels(); });

// ===========================================================================
// Channel routing — c-row's "assert which one was called"
// ===========================================================================

describe('notifyUserImpl — channel routing per urgency', () => {

    test('typical call (info, auto, no Telegram): falls through to showInformation', async () => {
        // Telegram unconfigured by default
        const raw = await withTiming('tomAi_notifyUser:typical', () =>
            notifyUserImpl(channels, { message: 'hello' }));
        const r = JSON.parse(raw);
        assert.equal(r.ok, true);
        assert.equal(r.channel, 'vscode');
        assert.equal(r.urgency, 'info');
        assert.equal(r.modal, false);
        // Verified: showInformation called, NOT warning/error
        assert.equal(channels.calls.filter((c) => c.method === 'showInformation').length, 1);
        assert.equal(channels.calls.filter((c) => c.method === 'showWarning').length, 0);
        assert.equal(channels.calls.filter((c) => c.method === 'showError').length, 0);
    });

    test('urgency: warning → showWarning', async () => {
        const r = JSON.parse(await notifyUserImpl(channels, { message: 'x', urgency: 'warning' }));
        assert.equal(r.urgency, 'warning');
        const call = channels.calls.find((c) => c.method === 'showWarning');
        assert.ok(call, 'showWarning must be called');
        assert.match(call.args[0] as string, /🟡/);
    });

    test('urgency: error → showError', async () => {
        const r = JSON.parse(await notifyUserImpl(channels, { message: 'x', urgency: 'error' }));
        assert.equal(r.urgency, 'error');
        const call = channels.calls.find((c) => c.method === 'showError');
        assert.ok(call, 'showError must be called');
        assert.match(call.args[0] as string, /🔴/);
    });

    test('title is prepended above the message', async () => {
        await notifyUserImpl(channels, { message: 'body', title: 'subject', urgency: 'info' });
        const call = channels.calls.find((c) => c.method === 'showInformation')!;
        assert.match(call.args[0] as string, /\*\*subject\*\*[\s\S]*body/);
    });

    test('empty message rejected', async () => {
        const r = JSON.parse(await notifyUserImpl(channels, { message: '   ' }));
        assert.match(r.error, /`message` is required/);
        assert.equal(channels.calls.length, 0);
    });
});

// ===========================================================================
// Modal / dismissal semantics
// ===========================================================================

describe('notifyUserImpl — modal / dismissal', () => {

    test('default is non-modal (modal: false in the args)', async () => {
        await notifyUserImpl(channels, { message: 'x' });
        const call = channels.calls.find((c) => c.method === 'showInformation')!;
        assert.deepEqual(call.args[1], { modal: false });
    });

    test('modal: true forwards to the channel', async () => {
        channels.setVscodeDismissedBy('OK');
        const r = JSON.parse(await notifyUserImpl(channels, {
            message: 'are you sure?', channel: 'vscode', modal: true,
        }));
        const call = channels.calls.find((c) => c.method === 'showInformation')!;
        assert.deepEqual(call.args[1], { modal: true });
        assert.equal(r.modal, true);
        assert.equal(r.dismissedBy, 'OK');
    });

    test('dismissedBy: null when the toast times out (no button click)', async () => {
        channels.setVscodeDismissedBy(undefined);
        const r = JSON.parse(await notifyUserImpl(channels, { message: 'x' }));
        assert.equal(r.dismissedBy, null);
    });
});

// ===========================================================================
// Explicit channels
// ===========================================================================

describe('notifyUserImpl — explicit channel selection', () => {

    test('channel: "statusbar" routes to setStatusBarMessage with default timeout', async () => {
        const r = JSON.parse(await notifyUserImpl(channels, {
            message: 'background task done', channel: 'statusbar',
        }));
        assert.equal(r.channel, 'statusbar');
        assert.equal(r.statusBarTimeoutMs, 5000);
        const call = channels.calls.find((c) => c.method === 'setStatusBarMessage')!;
        assert.equal(call.args[1], 5000);
        // No vscode toast in this path
        assert.equal(channels.calls.filter((c) => c.method.startsWith('show')).length, 0);
    });

    test('statusBarTimeoutMs honoured + clamped to 500 ms minimum', async () => {
        await notifyUserImpl(channels, { message: 'x', channel: 'statusbar', statusBarTimeoutMs: 100 });
        const call = channels.calls.find((c) => c.method === 'setStatusBarMessage')!;
        assert.equal(call.args[1], 500, 'clamped to 500ms minimum');
    });

    test('channel: "telegram" + configured → sendTelegram', async () => {
        channels.setTelegram({ ok: true });
        const r = JSON.parse(await notifyUserImpl(channels, {
            message: 'remote ping', channel: 'telegram',
        }));
        assert.equal(r.channel, 'telegram');
        assert.equal(channels.calls.filter((c) => c.method === 'sendTelegram').length, 1);
        // No vscode toast on explicit telegram path
        assert.equal(channels.calls.filter((c) => c.method.startsWith('show')).length, 0);
    });

    test('channel: "telegram" + NOT configured → clear error, no fallback', async () => {
        // telegramResult stays null → unconfigured
        const r = JSON.parse(await notifyUserImpl(channels, {
            message: 'x', channel: 'telegram',
        }));
        assert.equal(r.ok, false);
        assert.match(r.error, /Telegram channel requested but not configured/);
        assert.match(r.error, /channel: "vscode"/);
        // sendTelegram called once (to probe), but no toast fallback because channel was EXPLICIT
        assert.equal(channels.calls.filter((c) => c.method.startsWith('show')).length, 0);
    });

    test('channel: "telegram" + send error surfaces the HTTP failure', async () => {
        channels.setTelegram({ ok: false, reason: 'HTTP 401' });
        const r = JSON.parse(await notifyUserImpl(channels, {
            message: 'x', channel: 'telegram',
        }));
        assert.equal(r.ok, false);
        assert.match(r.error, /Telegram send failed: HTTP 401/);
    });
});

// ===========================================================================
// Auto channel — fallback chain
// ===========================================================================

describe('notifyUserImpl — auto channel fallback', () => {

    test('auto + Telegram OK → reports channel: telegram, autoFallback: false', async () => {
        channels.setTelegram({ ok: true });
        const r = JSON.parse(await notifyUserImpl(channels, { message: 'x' }));
        assert.equal(r.channel, 'telegram');
        assert.equal(r.autoFallback, false);
        // No toast because Telegram succeeded
        assert.equal(channels.calls.filter((c) => c.method.startsWith('show')).length, 0);
    });

    test('auto + Telegram tried + failed → falls back to vscode, autoFallback: true with reason', async () => {
        channels.setTelegram({ ok: false, reason: 'HTTP 500' });
        const r = JSON.parse(await notifyUserImpl(channels, { message: 'x', urgency: 'warning' }));
        assert.equal(r.channel, 'vscode');
        assert.equal(r.autoFallback, true);
        assert.match(r.fallbackReason, /HTTP 500/);
        // Both sendTelegram + showWarning fired
        assert.equal(channels.calls.filter((c) => c.method === 'sendTelegram').length, 1);
        assert.equal(channels.calls.filter((c) => c.method === 'showWarning').length, 1);
    });

    test('auto + Telegram NOT configured → vscode straight away (no fallback flag set)', async () => {
        // telegramResult stays null
        const r = JSON.parse(await notifyUserImpl(channels, { message: 'x' }));
        assert.equal(r.channel, 'vscode');
        assert.equal(r.autoFallback, false);
        // sendTelegram was still called to probe configuration
        assert.equal(channels.calls.filter((c) => c.method === 'sendTelegram').length, 1);
        // And then showInformation fired
        assert.equal(channels.calls.filter((c) => c.method === 'showInformation').length, 1);
    });
});
