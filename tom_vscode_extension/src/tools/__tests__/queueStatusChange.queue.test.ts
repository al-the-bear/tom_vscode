/**
 * A queue item's status and place set by hand (src/utils/queueStatusChange.ts; PromptQueueManager.changeItemStatus,
 * relocateItem, setSessionOfRunItems — the queue editor's status label and its run / session chips).
 *
 *   QS-1 the rules: error, waiting, retry and the running or held statuses offer pending, staged and sent; staged,
 *        pending and sent offer the other two; a chat send none; everything not sent may move; the lane places —
 *        the end, the top (before the run's first item not being sent), next (right after the run's iterating
 *        sending item, else as the top)
 *   QS-2 on a real queue: an error, a waiting and a retry item go back to pending / staged with their failure, wait
 *        and countdown cleared, or are marked sent; a sending item is stopped first; staged ↔ sent ↔ pending; a chat
 *        send and a target not offered are refused
 *   QS-3 a move: to another run at the end, at the top, next between the iterations of its iterating sending item
 *        (marked send-between); a sending item goes on as pending; its session named in the new run, or the one
 *        chosen, or the run's default (''); a process-move marker is refused; the session for the run's other staged
 *        and pending items, not for the ones that started
 */

/* eslint-disable @typescript-eslint/naming-convention */
import test, { after, describe } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

const SANDBOX = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'queue-status-change-')));
const WS = path.join(SANDBOX, 'ws');
const HOME = path.join(SANDBOX, 'home');
const QUEST = 'q1';
const EXT_ROOT = path.resolve(__dirname, '..', '..', '..');
for (const [rel, text] of [[`_ai/quests/${QUEST}/overview.${QUEST}.md`, '# Q1\n'], ['.tom/tom_vscode_extension.json', '{}\n']]) {
    const abs = path.join(WS, rel);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, text);
}
fs.mkdirSync(HOME, { recursive: true });
process.env.HOME = HOME;
process.env.USERPROFILE = HOME;

import { installVscodeStub } from './_vscode-stub.js';
const vscodeStub = installVscodeStub({ workspaceFolders: [WS] });
(vscodeStub.stub.workspace as Record<string, unknown>).workspaceFile = { fsPath: path.join(WS, `${QUEST}.code-workspace`), scheme: 'file' };

import { ChatVariablesStore } from '../../managers/chatVariablesStore.js';
import { TimerEngine } from '../../managers/timerEngine.js';
import { PromptQueueManager } from '../../managers/promptQueueManager.js';
import { TomAiConfiguration } from '../../utils/tomAiConfiguration.js';
import { setExtensionPath } from '../../handlers/handler_shared.js';
import { canRelocateQueueItem, iteratingSendingItem, laneInsertIndex, queueStatusChoices, type LaneItem } from '../../utils/queueStatusChange.js';

const subscriptions: Array<{ dispose(): void }> = [];
(function start(): void {
    const storage = path.join(SANDBOX, 'storage');
    fs.mkdirSync(storage, { recursive: true });
    const memento = (): unknown => {
        const values = new Map<string, unknown>();
        return { get: (k: string, d?: unknown) => values.has(k) ? values.get(k) : d, update: async (k: string, v: unknown) => { values.set(k, v); }, keys: () => [...values.keys()], setKeysForSync: () => undefined };
    };
    const context = {
        subscriptions, extensionPath: EXT_ROOT, extensionUri: { fsPath: EXT_ROOT, scheme: 'file' },
        globalStorageUri: { fsPath: storage, scheme: 'file' }, storageUri: { fsPath: storage, scheme: 'file' },
        logUri: { fsPath: storage, scheme: 'file' }, globalStoragePath: storage, storagePath: storage, logPath: storage,
        globalState: memento(), workspaceState: memento(), asAbsolutePath: (rel: string) => path.join(EXT_ROOT, rel),
    } as never;
    setExtensionPath(EXT_ROOT);
    TomAiConfiguration.init(context);
    ChatVariablesStore.init(context);
    TimerEngine.init(context);
    PromptQueueManager.init(context);
})();
after(() => {
    for (const stop of [() => PromptQueueManager.instance.dispose(), () => TimerEngine.instance.dispose()]) {
        try { stop(); } catch { /* not started */ }
    }
    for (const s of subscriptions.splice(0)) { try { s.dispose(); } catch { /* already gone */ } }
    vscodeStub.restore();
    fs.rmSync(SANDBOX, { recursive: true, force: true });
});

const queue = (): PromptQueueManager => PromptQueueManager.instance;
function clear(): void { for (const i of [...queue().items]) { queue().remove(i.id); } }


const find = (id: string) => queue().items.find((i) => i.id === id)!;
const ids = (run: string): string[] => queue().items.filter((i) => (i.run || 'default') === run).map((i) => i.id);

describe('a queue item\'s status and place set by hand', () => {
    test('QS-1: the rules', () => {
        const of = (s: string): string[] => queueStatusChoices(s).map((c) => c.status);
        for (const s of ['error', 'waiting', 'retry', 'sending', 'interrupted', 'todo-blocked', 'decision-needed']) {
            assert.deepEqual(of(s), ['pending', 'staged', 'sent'], s);
        }
        assert.deepEqual([of('staged'), of('pending'), of('sent')], [['pending', 'sent'], ['staged', 'sent'], ['staged', 'pending']]);
        assert.deepEqual([of('chat'), of('chat-sent')], [[], []]);
        assert.ok(queueStatusChoices('sent').every((c) => c.label && c.detail));
        assert.deepEqual(['staged', 'pending', 'error', 'waiting', 'retry', 'sending', 'todo-blocked', 'sent', 'chat', 'chat-sent'].map(canRelocateQueueItem),
            [true, true, true, true, true, true, true, false, false, false]);
        const lane: LaneItem[] = [
            { id: 'a', status: 'sending', run: 'r', iterates: true },
            { id: 'b', status: 'pending', run: 'r', iterates: false },
            { id: 'o', status: 'pending', run: 'other', iterates: false },
            { id: 'c', status: 'staged', run: 'r', iterates: false },
        ];
        assert.equal(laneInsertIndex(lane, 'r', 'end'), 4);
        assert.equal(laneInsertIndex(lane, 'r', 'top'), 1, 'before the first item not being sent');
        assert.equal(laneInsertIndex(lane, 'r', 'next'), 1, 'right after the iterating sending item');
        assert.equal(iteratingSendingItem(lane, 'r')?.id, 'a');
        const still = lane.map((i) => (i.id === 'a' ? { ...i, iterates: false } : i));
        assert.equal(iteratingSendingItem(still, 'r'), undefined);
        assert.equal(laneInsertIndex(still, 'r', 'next'), 1, 'no iterating item: as the top');
        assert.equal(laneInsertIndex(lane, 'empty', 'top'), 4, 'a run without items: the end');
    });

    test('QS-2: the status on a real queue', async () => {
        clear();
        for (const r of ['s1']) { queue().setRunQueueSettings(r, { autoSend: false, defaultTransport: 'copilot' }); }
        const make = async (text: string) => queue().enqueue({ originalText: text, transport: 'copilot', deferSend: true, run: 's1' } as never);
        const err = await make('failed');
        Object.assign(find(err.id), { status: 'error', error: 'overloaded', outOfBudget: { reason: 'x' } });
        assert.deepEqual(queue().changeItemStatus(err.id, 'pending'), { ok: true });
        assert.deepEqual([find(err.id).status, find(err.id).error, find(err.id).outOfBudget], ['pending', undefined, undefined]);
        const wait = await make('limited');
        Object.assign(find(wait.id), { status: 'waiting', waitingUntil: '2030-01-01T00:00:00Z', waitingResetLabel: 'Tue 10:00' });
        assert.deepEqual(queue().changeItemStatus(wait.id, 'staged'), { ok: true });
        assert.deepEqual([find(wait.id).status, find(wait.id).waitingUntil, find(wait.id).waitingResetLabel], ['staged', undefined, undefined]);
        const retry = await make('retrying');
        Object.assign(find(retry.id), { status: 'retry', retryAttempt: 3, retryUntil: '2030-01-01T00:00:00Z' });
        assert.deepEqual(queue().changeItemStatus(retry.id, 'sent'), { ok: true });
        assert.deepEqual([find(retry.id).status, find(retry.id).retryAttempt, find(retry.id).retryUntil], ['sent', undefined, undefined]);
        assert.ok(find(retry.id).sentAt, 'marked sent: a sent time');
        assert.deepEqual(queue().changeItemStatus(retry.id, 'pending'), { ok: true }, 'sent → pending');
        const running = await make('running');
        find(running.id).status = 'sending';
        assert.deepEqual(queue().changeItemStatus(running.id, 'pending'), { ok: true });
        assert.equal(find(running.id).status, 'pending', 'stopped first, then pending');
        const staged = await make('staged');
        assert.deepEqual(queue().changeItemStatus(staged.id, 'sent'), { ok: true });
        assert.equal(find(staged.id).status, 'sent');
        const r = queue().changeItemStatus(staged.id, 'sent');
        assert.equal(r.ok, false, 'not offered: sent → sent');
        const chat = await make('a chat send');
        find(chat.id).status = 'chat-sent';
        assert.equal(queue().changeItemStatus(chat.id, 'pending').ok, false, 'a chat send is not the queue\'s');
        assert.equal(queue().changeItemStatus('nope', 'pending').ok, false);
        clear();
    });

    test('QS-3: a move', async () => {
        clear();
        for (const r of ['m1', 'm2']) { queue().setRunQueueSettings(r, { autoSend: false, defaultTransport: 'copilot' }); }
        const make = async (text: string, run: string, extra: Record<string, unknown> = {}) =>
            queue().enqueue({ originalText: text, transport: 'copilot', deferSend: true, run, ...extra } as never);
        const loop = await make('loop', 'm2', { repeatCount: 3 });
        find(loop.id).status = 'sending';
        const p1 = await make('p1', 'm2');
        find(p1.id).status = 'pending';
        const moving = await make('moving', 'm1', { session: 'work@m1' });
        // At the end of run m2; its session named in m2.
        assert.deepEqual(queue().relocateItem(moving.id, { run: 'm2', place: 'end' }), { ok: true, sendBetween: false });
        assert.deepEqual(ids('m2'), [loop.id, p1.id, moving.id]);
        assert.equal(find(moving.id).session, 'work@m2');
        // At the top: before the first item not being sent.
        assert.equal(queue().relocateItem(moving.id, { run: 'm2', place: 'top' }).ok, true);
        assert.deepEqual(ids('m2'), [loop.id, moving.id, p1.id]);
        // Next: right after the iterating sending item, between its iterations; a session chosen.
        find(moving.id).status = 'pending';
        const next = queue().relocateItem(moving.id, { run: 'm2', place: 'next', session: 'other@m2' });
        assert.deepEqual(next, { ok: true, sendBetween: true });
        assert.equal(find(moving.id).sendBetween, true);
        assert.equal(find(moving.id).session, 'other@m2');
        // A sending item goes on as pending; '' is the run's default session.
        const sending = await make('was sending', 'm1', { session: 'x@m1' });
        find(sending.id).status = 'sending';
        assert.equal(queue().relocateItem(sending.id, { run: 'm1', place: 'end', session: '' }).ok, true);
        assert.deepEqual([find(sending.id).status, find(sending.id).session], ['pending', undefined]);
        // Refused: a process-move marker, a sent item.
        const marker = await make('marker', 'm1');
        find(marker.id).processMove = { to: 'x' } as never;
        assert.equal(queue().relocateItem(marker.id, { run: 'm2', place: 'end' }).ok, false);
        const done = await make('done', 'm1');
        find(done.id).status = 'sent';
        assert.equal(queue().relocateItem(done.id, { run: 'm2', place: 'end' }).ok, false);
        // The session for the run's other items not sent yet: staged and pending, not the ones that started.
        const res = queue().setSessionOfRunItems('m2', 'shared@m2', moving.id);
        assert.equal(res.changed, 1, 'p1');
        assert.equal(find(p1.id).session, 'shared@m2');
        assert.notEqual(find(loop.id).session, 'shared@m2', 'the sending item keeps its session');
        assert.equal(find(moving.id).session, 'other@m2', 'the moved item keeps the one chosen');
        clear();
    });
});
