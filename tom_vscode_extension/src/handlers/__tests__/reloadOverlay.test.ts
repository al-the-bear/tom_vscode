/**
 * The reload overlay (handlers/reloadOverlay-handler.ts, utils/reloadOverlayRows.ts, media/reloadOverlay;
 * vscimpb142b): another window migrated the workspace, this window paused every run.
 *
 *   RO-1 the list from the queue: the queue items sending and this window's chat sends, as the prompt queue
 *        labels them (status and kind), with run, session, title; another window's chat send and idle items are
 *        not listed; a listed item shows when it is done — SENT …, an iteration item between iterations
 *        PAUSED …, back at pending PENDING … (PAUSED), removed REMOVED; idle once nothing runs
 *   RO-2 the messages: Interrupt of a queue item is the hard interrupt for continuation, of a chat send its
 *        cancel; Reload window reloads
 *   RO-3 the page (JSDOM): the headline, the rows, Interrupt posts once and waits, "Nothing runs any more"
 *        when idle, Reload window
 *   RO-4 the overlay under the vscode stub: the panel, the status-bar item and its command, the list following
 *        the queue; the service shows it after another window's migration
 */

import test, { after, describe } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { JSDOM } from 'jsdom';

import { installVscodeStub } from '../../tools/__tests__/_vscode-stub.js';
const vscodeStub = installVscodeStub({ workspaceFolders: [os.tmpdir()] });

import { handleReloadOverlayMessage, reloadOverlayState, showReloadOverlay, SHOW_RELOAD_OVERLAY_COMMAND, type ReloadOverlayDeps } from '../reloadOverlay-handler.js';
import { reloadOverlayRows, reloadOverlayText, trackRunningItems, type OverlayQueueItem } from '../../utils/reloadOverlayRows.js';
import { setExtensionPath } from '../handler_shared.js';

const EXT = path.resolve(__dirname, '..', '..', '..');
setExtensionPath(EXT);
after(() => vscodeStub.restore());

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Json = any;
const ME = 'win1';
const paused = (): boolean => false;

function queue(): OverlayQueueItem[] {
    return [
        { id: 'a', status: 'sending', awaitingAnswer: true, itemKind: 'todo', run: 'another', session: 's1', originalText: '\nDo the quest todo vscimpb1 — something\nmore' },
        { id: 'b', status: 'chat', itemKind: 'chat', chatWindowId: ME, session: 'chat', originalText: 'A chat question' },
        { id: 'c', status: 'chat', itemKind: 'chat', chatWindowId: 'other', originalText: 'Another window' },
        { id: 'd', status: 'pending', itemKind: 'prompt', originalText: 'waiting' },
        { id: 'e', status: 'sending', awaitingAnswer: false, itemKind: 'prefix', originalText: 'a walk between iterations' },
        { id: 'f', status: 'sending', awaitingAnswer: true, itemKind: 'iteration', processRun: { run: 'collab' }, originalText: 'repeat' },
    ];
}

describe('the reload overlay', () => {
    test('RO-1: the list from the queue', () => {
        const items = queue();
        const tracked = trackRunningItems(items, [], ME, paused);
        assert.deepEqual(tracked, ['a', 'b', 'f'], 'sending with a prompt in flight, and this window\'s chat send');
        let rows = reloadOverlayRows(items, tracked, ME, paused);
        assert.deepEqual(rows.map((r) => [r.id, r.label, r.run, r.session, r.running, r.chat]), [
            ['a', 'SENDING TODO (PAUSED)', 'another', 's1', true, false],
            ['b', 'SENDING CHAT', 'default', 'chat', true, true],
            ['f', 'SENDING ITERATION (PAUSED)', 'collab', 'default', true, false],
        ]);
        assert.equal(rows[0].title, 'Do the quest todo vscimpb1 — something');
        assert.equal(rows[0].cls, 'status-kind kind-todo');
        // They end.
        items[0].status = 'sent'; items[0].awaitingAnswer = false;
        items[1].status = 'chat-sent';
        items[5].awaitingAnswer = false;
        rows = reloadOverlayRows(items, tracked, ME, paused);
        assert.deepEqual(rows.map((r) => [r.label, r.running]), [['SENT TODO', false], ['SENT CHAT', false], ['PAUSED ITERATION', false]]);
        items[5].status = 'pending';
        assert.equal(reloadOverlayRows(items, tracked, ME, paused)[2].label, 'PENDING ITERATION (PAUSED)');
        const rest = items.filter((i) => i.id !== 'b');
        assert.equal(reloadOverlayRows(rest, tracked, ME, paused)[1].label, 'REMOVED');
        const deps = fakeDeps(items);
        const state = reloadOverlayState(deps, 9, [...tracked]);
        assert.equal(state.idle, true);
        assert.equal(state.text, 'The workspace has been migrated to version 9, a reload is required. All runs have been paused. Let the currently running prompts finish, then reload.');
        assert.equal(reloadOverlayText(9), state.text);
        // With the run still sending on its own, a sending item counts as running.
        assert.equal(trackRunningItems([{ id: 'x', status: 'sending', itemKind: 'prompt' }], [], ME, () => true).length, 1);
    });

    test('RO-2: the messages', () => {
        const calls: string[] = [];
        const deps = fakeDeps([], calls);
        assert.equal(handleReloadOverlayMessage(deps, { type: 'interrupt', id: 'a' }), true);
        assert.equal(handleReloadOverlayMessage(deps, { type: 'interrupt', id: 'b', chat: true }), true);
        assert.equal(handleReloadOverlayMessage(deps, { type: 'interrupt' }), false);
        assert.deepEqual(calls, ['interrupt a', 'cancelChat b']);
        const before = vscodeStub.spies.byMethod('commands.executeCommand').length;
        assert.equal(handleReloadOverlayMessage(deps, { type: 'reload' }), true);
        assert.deepEqual(vscodeStub.spies.byMethod('commands.executeCommand').slice(before).map((c) => c.args[0]), ['workbench.action.reloadWindow']);
        const service = fs.readFileSync(path.join(EXT, 'src', 'services', 'aiFormatCheckService.ts'), 'utf8');
        assert.match(service, /interruptActiveItemForContinuation\(id, undefined, \{ hard: true \}\)/, 'the hard interrupt');
        assert.match(service, /cancelAnthropicSendOfChatItem\(id\)/);
    });

    test('RO-3: the page', () => {
        const read = (f: string): string => fs.readFileSync(path.join(EXT, 'media', 'reloadOverlay', f), 'utf8');
        const html = read('index.html').replace(/<script[\s\S]*?<\/script>/g, '').replace(/\{\{[a-zA-Z]+\}\}/g, '');
        const w = new JSDOM(html, { runScripts: 'outside-only' }).window as Json;
        const posted: Json[] = [];
        w.acquireVsCodeApi = () => ({ postMessage: (m: Json) => posted.push(m) });
        const items = queue();
        const tracked = trackRunningItems(items, [], ME, paused);
        w.__INIT__ = { version: 9, text: reloadOverlayText(9), rows: reloadOverlayRows(items, tracked, ME, paused), idle: false };
        w.eval(read('main.js'));
        const $ = (id: string): Json => w.document.getElementById(id);
        assert.equal($('roTitle').textContent, 'The workspace has been migrated to version 9');
        assert.match($('roText').textContent, /All runs have been paused/);
        assert.match($('roIdle').textContent, /^3 prompt\(s\) still running/);
        const rowsOf = (): Json[] => [...w.document.querySelectorAll('#roRows tr')];
        assert.equal(rowsOf().length, 3);
        assert.deepEqual([...rowsOf()[0].querySelectorAll('td')].slice(0, 4).map((td: Json) => td.textContent), ['SENDING TODO (PAUSED)', 'another', 's1', 'Do the quest todo vscimpb1 — something']);
        rowsOf()[1].querySelector('.ro-interrupt').click();
        assert.equal(JSON.stringify(posted.filter((m) => m.type === 'interrupt')), '[{"type":"interrupt","id":"b","chat":true}]');
        assert.equal(rowsOf()[1].querySelector('.ro-interrupt').disabled, true, 'it waits for the queue');
        assert.equal(rowsOf()[1].querySelector('.ro-interrupt').textContent, 'Interrupting…');
        rowsOf()[0].querySelector('.ro-interrupt').click();
        assert.equal(posted.filter((m) => m.type === 'interrupt').at(-1).chat, false);
        for (const i of items) { if (i.status === 'sending') { i.status = 'sent'; } if (i.status === 'chat') { i.status = 'chat-sent'; } }
        w.dispatchEvent(new w.MessageEvent('message', { data: { type: 'state', state: { version: 9, text: reloadOverlayText(9), rows: reloadOverlayRows(items, tracked, ME, paused), idle: true } } }));
        assert.equal($('roIdle').textContent, 'Nothing runs any more: reload now.');
        assert.equal(w.document.querySelectorAll('.ro-interrupt').length, 0);
        assert.equal(rowsOf()[0].querySelector('td').textContent, 'SENT TODO');
        $('roReload').click();
        assert.equal(posted.at(-1).type, 'reload');
        w.close();
    });

    test('RO-4: the overlay in a window', async () => {
        const items = queue();
        let fire: () => void = () => undefined;
        const deps = { ...fakeDeps(items), onDidChange: (l: () => void) => { fire = l; return { dispose: () => undefined }; } };
        const registered = new Map<string, () => unknown>();
        const cmds = vscodeStub.stub.commands as Record<string, unknown>;
        const original = cmds.registerCommand;
        cmds.registerCommand = (id: string, fn: () => unknown) => { registered.set(id, fn); return { dispose: () => undefined }; };
        try {
            showReloadOverlay({ extensionUri: { fsPath: EXT, scheme: 'file' }, subscriptions: [] } as never, deps, 9);
        } finally { cmds.registerCommand = original; }
        const panels = ((vscodeStub.stub.window as Json).__webviewPanels as Json[]).filter((p) => p.viewType === 'tomAi.reloadOverlay');
        assert.equal(panels.length, 1);
        assert.match(panels[0].webview.html, /window\.__INIT__ = /);
        assert.ok(registered.has(SHOW_RELOAD_OVERLAY_COMMAND), 'the status-bar item\'s command');
        items[0].status = 'sent';
        fire();
        const last = panels[0].webview.__posted.at(-1);
        assert.equal(last.type, 'state');
        assert.equal(last.state.rows[0].label, 'SENT TODO', 'the list follows the queue');
        panels[0].webview.__receive({ type: 'interrupt', id: 'f' });
        await new Promise((r) => setTimeout(r, 10));
        // The service shows it after another window's migration.
        const service = fs.readFileSync(path.join(EXT, 'src', 'services', 'aiFormatCheckService.ts'), 'utf8');
        assert.match(service, /pauseAllRuns\(\);[\s\S]{0,200}showReloadOverlay\(context, reloadOverlayDeps\(\), now\);/);
        assert.doesNotMatch(service, /reloadRequiredText/, 'the warning is gone');
    });
});

function fakeDeps(items: OverlayQueueItem[], calls: string[] = []): ReloadOverlayDeps {
    return {
        items: () => items,
        autoSend: paused,
        windowId: () => ME,
        onDidChange: () => ({ dispose: () => undefined }),
        interruptItem: (id) => { calls.push(`interrupt ${id}`); return true; },
        cancelChat: (id) => { calls.push(`cancelChat ${id}`); return true; },
        viewColumn: () => undefined,
    };
}
