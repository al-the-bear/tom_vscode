/**
 * A session two prompts would share (src/utils/sessionBusy.ts,
 * handlers/busySessionChoice.ts, handlers/chatQueueTracking.ts,
 * PromptQueueManager), through the real queue manager under the vscode stub.
 *
 *   BS-1 the queue does not start an item in a session a chat send runs in: the pending item stays, flagged
 *        waiting for that session (chatHoldingSessionOf), Send now holds it too; once the chat send ended the
 *        queue starts it; an item in another session is not held
 *   BS-2 a chat send into a busy session: free → it goes; busy with a running queue item → the choice names
 *        it; "Run next" queues it pending directly under the running loop, marked between its iterations;
 *        "Run after the current item" queues it there unmarked; "Send now in session Y" answers a free session
 *        (a busy one is not offered); dismissing it does not send; without a person (Telegram) it is refused,
 *        naming the running item
 *   BS-3 Remove on a chat item: a stale `chat` item (its send no longer runs) is removed; a running one is
 *        removed and its send stopped — trackChatSend ends with the removal error and runs the send's cancel
 *   BS-4 the timeout: a chat send without a result in time is stopped (cancel runs) and its item is `chat-sent`
 *        with the timeout error
 */

import test, { after, describe } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

const SANDBOX = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'busy-session-')));
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
import { ReminderSystem } from '../../managers/reminderSystem.js';
import { TimerEngine } from '../../managers/timerEngine.js';
import { PromptQueueManager } from '../../managers/promptQueueManager.js';
import { TomAiConfiguration } from '../../utils/tomAiConfiguration.js';
import { setExtensionPath } from '../../handlers/handler_shared.js';
import { chatTimeoutError, CHAT_REMOVED_ERROR, isChatSendActive, trackChatSend } from '../../handlers/chatQueueTracking.js';
import { resolveBusySession, __setBusySessionPickForTests } from '../../handlers/busySessionChoice.js';

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
    ReminderSystem.init(context);
    TimerEngine.init(context);
    PromptQueueManager.init(context);
})();
after(() => {
    for (const stop of [() => PromptQueueManager.instance.dispose(), () => TimerEngine.instance.dispose(), () => ReminderSystem.instance.dispose()]) {
        try { stop(); } catch { /* not started */ }
    }
    for (const s of subscriptions.splice(0)) { try { s.dispose(); } catch { /* already gone */ } }
    vscodeStub.restore();
    fs.rmSync(SANDBOX, { recursive: true, force: true });
});

const queue = (): PromptQueueManager => PromptQueueManager.instance;
const wait = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));
function clear(): void { for (const i of [...queue().items]) { queue().remove(i.id); } }

/** A chat send running in `session` until `finish` is called. */
function runningChat(session: string, opts?: { cancel?: () => void; timeoutMs?: number }): { done: Promise<unknown>; finish(): void; id(): string | undefined } {
    let finish!: () => void;
    const answer = new Promise<{ text: string }>((r) => { finish = () => r({ text: 'the answer' }); });
    const done = trackChatSend({ text: 'chat prompt', session, source: 'panel' }, () => answer, opts);
    done.catch(() => undefined);
    return { done, finish, id: () => queue().items.find((i) => i.status === 'chat' && i.originalText === 'chat prompt')?.id };
}

describe('busy sessions', () => {
    test('BS-1: the queue waits for a session a chat send runs in', async () => {
        clear();
        queue().autoSendEnabled = false;
        const chat = runningChat('walk');
        await wait(20);
        const held = await queue().enqueue({ originalText: 'queued in walk', transport: 'anthropic', session: 'walk', deferSend: true });
        const other = await queue().enqueue({ originalText: 'queued in other', transport: 'anthropic', session: 'other', deferSend: true });
        assert.equal(queue().chatHoldingSessionOf(held)?.session, 'walk', 'flagged: waiting for session walk');
        assert.equal(queue().chatHoldingSessionOf(other), undefined, 'another session is not held');
        assert.equal(queue().sessionHolder('walk')?.kind, 'chat');
        await queue().sendNow(held.id);
        assert.equal(queue().getById(held.id)?.status, 'pending', 'Send now holds it too');
        queue().autoSendEnabled = true;
        try {
            await queue().sendNext();
            assert.equal(queue().getById(held.id)?.status, 'pending', 'the queue does not start it');
            chat.finish();
            await chat.done;
            await wait(100);
            assert.notEqual(queue().getById(held.id)?.status, 'pending', 'started once the chat send ended');
            assert.equal(queue().sessionHolder('walk')?.kind === 'chat', false);
        } finally {
            queue().autoSendEnabled = false;
        }
        clear();
    });

    test('BS-2: a chat send into a busy session', async () => {
        clear();
        queue().autoSendEnabled = false;
        const send = { text: 'from the chat', profileId: 'p1' };
        assert.deepEqual(await resolveBusySession({ session: 'walk', send, interactive: true, questId: QUEST }), { kind: 'free' });
        // A repeating queue item runs in walk; a chat send runs in other.
        const loop = await queue().enqueue({ originalText: 'the todo walk', repeatCount: 3, transport: 'anthropic', session: 'walk', deferSend: true });
        loop.status = 'sending';
        loop.repeatIndex = 1;
        const otherChat = runningChat('other');
        await wait(20);
        let offered: string[] = [];
        let title = '';
        const choose = (kind: string, session?: string) => async (choices: Array<{ kind: string; session?: string; label: string }>, t: string) => {
            offered = choices.map((c) => c.label); title = t;
            return choices.find((c) => c.kind === kind && (!session || c.session === session)) as never;
        };
        __setBusySessionPickForTests(choose('next'));
        const next = await resolveBusySession({ session: 'walk', send, interactive: true, questId: QUEST });
        assert.deepEqual(next, { kind: 'queued', how: 'next', session: 'walk' });
        assert.match(title, /Session walk is busy: the queue item "the todo walk" runs in session walk/);
        assert.deepEqual(offered, ['Run next in session walk', 'Run after the current item in session walk', 'Send now in session chat', 'Send now in session default'], 'the free sessions only (other is busy)');
        let items = queue().items;
        const queuedNext = items[items.indexOf(loop) + 1];
        assert.equal(queuedNext.originalText, 'from the chat');
        assert.equal(queuedNext.status, 'pending');
        assert.equal(queuedNext.session, 'walk');
        assert.equal(queuedNext.anthropicProfileId, 'p1');
        assert.equal(queuedNext.sendBetween, true, 'between the loop\'s iterations');
        __setBusySessionPickForTests(choose('after'));
        assert.deepEqual(await resolveBusySession({ session: 'walk', send: { text: 'after it' }, interactive: true, questId: QUEST }), { kind: 'queued', how: 'after', session: 'walk' });
        items = queue().items;
        const after = items.find((i) => i.originalText === 'after it')!;
        assert.equal(after.sendBetween, undefined, 'after all its iterations');
        assert.equal(items.indexOf(after), items.indexOf(loop) + 1, 'directly under the running item');
        __setBusySessionPickForTests(choose('session', 'default'));
        assert.deepEqual(await resolveBusySession({ session: 'walk', send, interactive: true, questId: QUEST }), { kind: 'send', session: 'default' });
        __setBusySessionPickForTests(async () => undefined);
        assert.equal((await resolveBusySession({ session: 'walk', send, interactive: true, questId: QUEST })).kind, 'cancelled');
        const refused = await resolveBusySession({ session: 'walk', send, interactive: false, questId: QUEST });
        assert.equal(refused.kind, 'cancelled');
        assert.match((refused as { message: string }).message, /Not sent: the queue item "the todo walk" runs in session walk/);
        // Busy with a chat send: the same choice.
        __setBusySessionPickForTests(choose('session', 'chat'));
        assert.deepEqual(await resolveBusySession({ session: 'other', send, interactive: true, questId: QUEST }), { kind: 'send', session: 'chat' });
        assert.match(title, /the chat send "chat prompt" runs in session other/);
        otherChat.finish();
        await otherChat.done;
        loop.status = 'sent';
        clear();
    });

    test('BS-3: Remove on a chat item', async () => {
        clear();
        // A stale running chat item: its send no longer runs (the hung case).
        const staleId = queue().addChatItem({ text: 'hung send', session: 'default', source: 'panel' });
        assert.equal(queue().getById(staleId)?.status, 'chat');
        assert.equal(queue().sessionHolder('default'), undefined, 'a send that no longer runs holds nothing');
        queue().remove(staleId);
        assert.equal(queue().getById(staleId), undefined, 'removed');
        // A running one: removing it stops the send.
        let cancelled = 0;
        const chat = runningChat('default', { cancel: () => { cancelled++; } });
        await wait(20);
        const id = chat.id()!;
        assert.equal(isChatSendActive(id), true);
        queue().remove(id);
        await assert.rejects(chat.done, new RegExp(CHAT_REMOVED_ERROR.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
        assert.equal(cancelled, 1, 'the send was cancelled');
        assert.equal(isChatSendActive(id), false);
        assert.equal(queue().getById(id), undefined);
    });

    test('BS-4: no result in time', async () => {
        clear();
        let cancelled = 0;
        const chat = runningChat('default', { cancel: () => { cancelled++; }, timeoutMs: 60 });
        await wait(20);
        const id = chat.id()!;
        await assert.rejects(chat.done, /no result within 1 minute \(the prompt queue's response timeout\): the send was stopped/);
        assert.equal(cancelled, 1);
        const item = queue().getById(id)!;
        assert.equal(item.status, 'chat-sent');
        assert.match(String(item.error), /no result within/);
        assert.equal(chatTimeoutError(60), "no result within 60 minutes (the prompt queue's response timeout): the send was stopped");
        clear();
    });
});
