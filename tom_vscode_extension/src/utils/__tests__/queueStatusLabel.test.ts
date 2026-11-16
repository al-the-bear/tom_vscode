/**
 * Every queue item shows its status and kind in one label (vscimpb128, src/utils/queueStatusLabel.ts and its twin in
 * media/shared/queueEntryUtils.js).
 *
 *   QL-1 the label: status word and kind (PENDING TODO, SENDING GROUP, STAGED PROMPT, SENT CHAT, ERROR PREFIX); a chat
 *        send's statuses read SENDING / SENT; the class names the kind
 *   QL-2 the webview's queueStatusKindLabel is the same, case by case
 *   QL-3 the webview's queueItemKindOf: the item's itemKind, else what deriveQueueItemKind derives
 *   QL-4 the rendered queue editor: each item's header shows its label; the extra states stay in it (SENDING TODO
 *        (PAUSED), RETRYING GROUP 2/7, INTERRUPTED ITERATION — RESENDS ON RESUME, DECISION-NEEDED PREFIX); the status
 *        bar keeps its colour class by status
 */

import test, { describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import vm from 'node:vm';
import { JSDOM } from 'jsdom';

import { queueStatusKindLabel } from '../queueStatusLabel.js';
import { deriveQueueItemKind, QUEUE_ITEM_KINDS } from '../queueItemKind.js';

function readMedia(...parts: string[]): string {
    return readFileSync(join(__dirname, '..', '..', '..', 'media', ...parts), 'utf-8');
}

const STATUSES = ['staged', 'pending', 'sending', 'sent', 'error', 'waiting', 'retry', 'decision-needed', 'interrupted', 'chat', 'chat-sent', 'paused', 'retrying'];

describe('the status and kind label', () => {
    test('QL-1: the label', () => {
        assert.deepEqual(queueStatusKindLabel('pending', 'todo'), { text: 'PENDING TODO', cls: 'status-kind kind-todo' });
        assert.equal(queueStatusKindLabel('sending', 'group').text, 'SENDING GROUP');
        assert.equal(queueStatusKindLabel('staged', 'prompt').text, 'STAGED PROMPT');
        assert.equal(queueStatusKindLabel('error', 'prefix').text, 'ERROR PREFIX');
        assert.equal(queueStatusKindLabel('pending', 'iteration').text, 'PENDING ITERATION');
        assert.equal(queueStatusKindLabel('chat', 'chat').text, 'SENDING CHAT');
        assert.equal(queueStatusKindLabel('chat-sent', 'chat').text, 'SENT CHAT');
        assert.equal(queueStatusKindLabel('pending', undefined).text, 'PENDING PROMPT', 'no kind: a plain prompt');
    });

    test('QL-2: the webview twin', () => {
        const context: Record<string, any> = {};
        vm.createContext(context);
        vm.runInContext(readMedia('shared', 'queueEntryUtils.js'), context);
        for (const status of STATUSES) {
            for (const kind of [...QUEUE_ITEM_KINDS, undefined]) {
                assert.deepEqual(JSON.parse(JSON.stringify(context.queueStatusKindLabel(status, kind))), queueStatusKindLabel(status, kind), `${status} ${kind}`);
            }
        }
    });

    test('QL-3: the webview\'s kind', () => {
        const context: Record<string, any> = {};
        vm.createContext(context);
        vm.runInContext(readMedia('shared', 'queueEntryUtils.js'), context);
        const cases: Array<Record<string, unknown>> = [
            { repeatCount: 'todo:q/a' }, { repeatCount: 'group:q/g' }, { repeatCount: 'dsa*' }, { repeatCount: '*' },
            { repeatCount: 3 }, { repeatCount: '4' }, { repeatCount: '1' }, { repeatCount: 'myCount' }, { repeatCount: 1 }, {},
            { status: 'chat' }, { status: 'chat-sent', repeatCount: 3 }, { chatSource: 'panel' }, { repeatCount: 'todo:bad' },
        ];
        for (const item of cases) { assert.equal(context.queueItemKindOf(item), deriveQueueItemKind(item), JSON.stringify(item)); }
        assert.equal(context.queueItemKindOf({ itemKind: 'group', repeatCount: 3 }), 'group', 'the item\'s own kind wins');
    });
});

describe('the rendered queue editor', () => {
    test('QL-4: each header shows status and kind', (t) => {
        const items = [
            { id: 'i1', status: 'pending', originalText: 'a', itemKind: 'todo', repeatCount: 'todo:q/x1', createdAt: '2026-11-16T10:00:00Z' },
            { id: 'i2', status: 'staged', originalText: 'b', createdAt: '2026-11-16T10:01:00Z' },
            { id: 'i3', status: 'sending', originalText: 'c', itemKind: 'todo', awaitingAnswer: true, requestId: 'r', createdAt: '2026-11-16T10:02:00Z' },
            { id: 'i4', status: 'retry', originalText: 'd', itemKind: 'group', retryAttempt: 2, createdAt: '2026-11-16T10:03:00Z' },
            { id: 'i5', status: 'interrupted', originalText: 'e', repeatCount: 3, createdAt: '2026-11-16T10:04:00Z' },
            { id: 'i6', status: 'decision-needed', originalText: 'f', repeatCount: 'dec*', createdAt: '2026-11-16T10:05:00Z' },
            { id: 'i7', status: 'error', originalText: 'g', itemKind: 'prefix', repeatCount: 'p*', createdAt: '2026-11-16T10:06:00Z' },
        ];
        const html = readMedia('queueEditor', 'index.html').replace(/<script[\s\S]*?<\/script>/g, '');
        const dom = new JSDOM(html, { runScripts: 'outside-only' });
        const window = dom.window as any;
        t.after(() => window.close());
        window.acquireVsCodeApi = () => ({ postMessage: () => undefined, setState: () => undefined, getState: () => undefined });
        // auto-send off: a sending item awaiting its answer reads "(PAUSED)".
        window.__INIT__ = { state: { items, autoSend: false } };
        window.eval([
            readMedia('shared', 'queueEntryUtils.js'),
            readMedia('shared', 'queueEntryRenderFunctions.js'),
            readMedia('shared', 'queueEntryMessageHandlers.js'),
            readMedia('queueEditor', 'main.js'),
        ].join('\n;\n'));
        const row = (id: string) => [...window.document.querySelectorAll('#queueList .queue-item')].find((el: any) => el.outerHTML.includes(`'${id}'`)) as any;
        const label = (id: string) => row(id)?.querySelector('.status-kind')?.textContent;
        const bar = (id: string) => row(id)?.querySelector('.status-bar')?.textContent ?? '';
        assert.equal(label('i1'), 'PENDING TODO');
        assert.ok(row('i1').querySelector('.status-kind.kind-todo'));
        assert.equal(label('i2'), 'STAGED PROMPT', 'a plain item reads PROMPT');
        assert.equal(label('i3'), 'SENDING TODO');
        assert.match(bar('i3'), /SENDING TODO \(PAUSED\)/);
        assert.equal(label('i4'), 'RETRYING GROUP');
        assert.match(bar('i4'), /RETRYING GROUP 2\/7/);
        assert.match(bar('i5'), /INTERRUPTED ITERATION — RESENDS ON RESUME/, 'its kind derived from the repeat count');
        assert.equal(label('i6'), 'DECISION-NEEDED PREFIX');
        assert.equal(label('i7'), 'ERROR PREFIX');
        assert.ok(row('i7').querySelector('.status-bar.error'), 'the colour stays by status');
    });
});
