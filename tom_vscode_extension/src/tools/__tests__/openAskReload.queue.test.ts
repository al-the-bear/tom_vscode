/**
 * An ask survives a window reload (vscimpb166, services/openAskRecord.ts and the queue manager): through the real
 * manager and the real tomAi_askUser tool; only the transport is a stub.
 *
 *   RA-1 the rules: which window restores an ask (its own, or one whose window is gone; never a live other
 *        window's); the record read back from an entry file; the continuation prompt quotes the question and the
 *        answer and says the reload happened; the description of a picker and an MD Browser ask
 *   RA-2 recording: while a queue item's turn waits in tomAi_askUser the call is on the item (`openAsk`) and in its
 *        entry file (`open-ask`); answered, it is gone; an ask outside a queue item's turn records nothing; the
 *        window's shutdown keeps the record
 *   RA-3 restore after a reload: a sending item with a recorded ask is not reset to pending; the question is shown
 *        again for the item (the registry and the user-input panel), its window taken over; the answer goes into
 *        the item's session as the continuation (quoting question and answer, the interrupted turn's session id),
 *        the stage's own text stays, the item completes
 *   RA-4 a reload in another state keeps today's behaviour: a sending item without a recorded ask goes back to
 *        pending; an ask a live other window shows is left to it
 *   RA-5 a Resend while the restored ask waits closes it, and its answer is not sent as a continuation
 *   RA-6 a send of the @CHAT panel (a chat item) that waited in an ask: after the reload it is not settled as
 *        abandoned, its question is shown again, and the answer goes out as a new chat send in the same session and
 *        run (quoting question and answer); its entry ends with the reload note
 *   RA-7 the window going down keeps the record, and the turn does not go on with the closing note
 */

/* eslint-disable @typescript-eslint/naming-convention -- YAML keys */
import test, { after, describe } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'fs';
import * as path from 'path';

const EXT_ROOT = path.resolve(__dirname, '..', '..', '..');
const SANDBOX = fs.realpathSync(fs.mkdtempSync(path.join(EXT_ROOT, '..', '..', '..', 'ztmp', 'vscode_extension_261118_vscimpb166_reload-')));
const WS = path.join(SANDBOX, 'ws');
const HOME = path.join(SANDBOX, 'home');
const QUEST = 'q1';
const QDIR = path.join(WS, '_ai', 'quests', QUEST);
fs.mkdirSync(QDIR, { recursive: true });
fs.writeFileSync(path.join(QDIR, `overview.${QUEST}.md`), '# Q1\n');
fs.writeFileSync(path.join(QDIR, `todos.${QUEST}.todo.yaml`), 'todos: []\n');
fs.mkdirSync(path.join(WS, '.tom'), { recursive: true });
fs.writeFileSync(path.join(WS, '.tom', 'tom_vscode_extension.json'), JSON.stringify({
    anthropic: {
        profiles: [{ id: 'sdk', name: 'SDK', systemPrompt: '', configurationId: 'c-sdk' }],
        configurations: [{ id: 'c-sdk', name: 'Agent SDK', model: 'claude-test', transport: 'agentSdk' }],
    },
}, null, 2));
fs.mkdirSync(HOME, { recursive: true });
process.env.HOME = HOME;
process.env.USERPROFILE = HOME;

import { installVscodeStub } from './_vscode-stub.js';
const vscodeStub = installVscodeStub({ workspaceFolders: [WS] });
(vscodeStub.stub.workspace as Record<string, unknown>).workspaceFile = { fsPath: path.join(WS, `${QUEST}.code-workspace`), scheme: 'file' };

import { ChatVariablesStore } from '../../managers/chatVariablesStore.js';
import { TimerEngine } from '../../managers/timerEngine.js';
import { PromptQueueManager, type QueuedPrompt } from '../../managers/promptQueueManager.js';
import { AnthropicHandler } from '../../handlers/anthropic-handler.js';
import { AskUserRegistry } from '../../services/askUserRegistry.js';
import { userInteractions } from '../../services/userInteractions.js';
import { TomAiConfiguration } from '../../utils/tomAiConfiguration.js';
import { setExtensionPath } from '../../handlers/handler_shared.js';
import { ASK_USER_LIVE_TOOL } from '../../handlers/askUser-handler.js';
import { getLocalFolder } from '../../handlers/windowStatusPanel-handler.js';
import '../tool-executors.js';
import { describeOpenAsk, markShuttingDown, openAskContinuationPrompt, parseOpenAskRecord, setOpenAskChatSender, shouldRestoreOpenAsk, type OpenAskRecord } from '../../services/openAskRecord.js';
import { RELOADED_CHAT_SEND_NOTE } from '../../managers/promptQueueManager.js';

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
        globalStorageUri: { fsPath: storage, scheme: 'file' }, storageUri: { fsPath: storage, scheme: 'file' }, logUri: { fsPath: storage, scheme: 'file' },
        globalStoragePath: storage, storagePath: storage, logPath: storage, globalState: memento(), workspaceState: memento(),
        asAbsolutePath: (rel: string) => path.join(EXT_ROOT, rel),
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

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Json = any;
const queue = (): PromptQueueManager => PromptQueueManager.instance;
const q = (): Json => PromptQueueManager.instance as Json;
const wait = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));
const handler = AnthropicHandler.instance as Json;
const originalSend = handler.sendMessage;
after(() => { handler.sendMessage = originalSend; });

const turns: Json[] = [];
let script: (opts: Json, n: number) => Promise<string> | string = () => 'done';
handler.sendMessage = async (opts: Json) => {
    turns.push(opts);
    return { text: await script(opts, turns.length), turnsUsed: 1, toolCallCount: 0 };
};
const promptOf = (opts: Json): string => String(opts.userText ?? opts.prompt ?? JSON.stringify(opts));
const live = (item: QueuedPrompt): QueuedPrompt => queue().getById(item.id) as QueuedPrompt;
function entryText(id: string): string {
    const found: string[] = [];
    const walk = (dir: string): void => {
        for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
            const p = path.join(dir, e.name);
            if (e.isDirectory()) { walk(p); } else if (/\.ya?ml$/.test(e.name) && fs.readFileSync(p, 'utf8').includes(id)) { found.push(fs.readFileSync(p, 'utf8')); }
        }
    };
    walk(SANDBOX);
    return found.join('\n');
}
function reset(): void {
    queue().autoSendEnabled = false;
    AskUserRegistry.instance.cancel('reset');
    for (const i of [...queue().items]) { queue().remove(i.id); }
    turns.length = 0;
}

/** A sending item as a reload finds it: its main stage sent, its turn waiting in `ask`. */
async function itemLeftByReload(ask: OpenAskRecord | undefined): Promise<QueuedPrompt> {
    const item = await queue().enqueue({ originalText: 'the stage text', transport: 'anthropic', anthropicProfileId: 'sdk', session: 's-reload', deferSend: true } as never);
    const it = live(item) as Json;
    it.status = 'sending';
    it.lastDispatched = { kind: 'main', expandedText: 'the stage text', transport: 'anthropic', anthropicProfileId: 'sdk', dispatchedAt: new Date().toISOString() };
    it.turnSessionId = 'sid-before-reload';
    it.repeatIndex = 1; // its main stage was sent (the counter a send advances)
    if (ask) { it.openAsk = ask; }
    q().persist();
    return item;
}

describe('an ask survives a window reload', () => {
    test('RA-1: the rules', () => {
        const rec: OpenAskRecord = { tool: 'tomAi_askUser', input: { questions: ['Ship it?', 'Which tag?'], title: 'Release' }, windowId: 'w-old', startedAt: '2026-11-18T10:00:00Z' };
        assert.equal(shouldRestoreOpenAsk(rec, 'w-old', new Set(['w-old'])), true, 'its own window');
        assert.equal(shouldRestoreOpenAsk(rec, 'w-new', new Set(['w-new'])), true, 'its window is gone (reloaded)');
        assert.equal(shouldRestoreOpenAsk(rec, 'w-new', new Set(['w-new', 'w-old'])), false, 'a live other window keeps it');
        assert.equal(shouldRestoreOpenAsk({ ...rec, windowId: '' }, 'w-new', new Set(['w-new'])), true);
        assert.deepEqual(parseOpenAskRecord({ tool: 'tomAi_askUser', input: { questions: ['a'] }, 'window-id': 'w', 'started-at': 't' }),
            { tool: 'tomAi_askUser', input: { questions: ['a'] }, windowId: 'w', startedAt: 't' });
        assert.equal(parseOpenAskRecord({ tool: 'tomAi_other', input: {} }), undefined);
        assert.equal(parseOpenAskRecord('x'), undefined);
        const text = openAskContinuationPrompt(rec, 'Yes; v2');
        assert.match(text, /window was reloaded while you were waiting in tomAi_askUser/);
        assert.match(text, /> Title: Release\n> 1\. Ship it\?\n> 2\. Which tag\?/);
        assert.match(text, /What tomAi_askUser answered:\n\nYes; v2$/);
        assert.match(describeOpenAsk({ ...rec, tool: 'tomAi_askUserPicker', input: { items: ['a', { label: 'b' }], prompt: 'Pick', canPickMany: true } }), /Prompt: Pick\nItems: a \| b\n\(several/);
        assert.match(describeOpenAsk({ ...rec, tool: 'tomAi_askInMdBrowser', input: { filePath: 'x.md', buttons: [{ id: 'ok', label: 'OK' }], finishReviewRound: true } }), /Document: x\.md\nButtons: OK\nfinishReviewRound: true/);
    });

    test('RA-2: recording while the ask is open', async () => {
        reset();
        let during: Json;
        let duringFile = '';
        script = async () => {
            const answer = ASK_USER_LIVE_TOOL.execute({ questions: ['Pick a colour?'] } as never);
            await wait(100);
            const it = queue().items.find((i) => i.status === 'sending') as Json;
            during = it?.openAsk && JSON.parse(JSON.stringify(it.openAsk));
            duringFile = entryText(it.id);
            const pending = AskUserRegistry.instance.pendingForQueueItem(it.id)!;
            AskUserRegistry.instance.submit(pending.requestId, 'blue', 'vscode');
            return `answered ${await answer}`;
        };
        const item = await queue().enqueue({ originalText: 'ask me', transport: 'anthropic', anthropicProfileId: 'sdk', session: 's-rec', deferSend: true, initialStatus: 'pending' } as never);
        queue().autoSendEnabled = true;
        await wait(600);
        assert.equal(during?.tool, 'tomAi_askUser');
        assert.deepEqual(during?.input, { questions: ['Pick a colour?'] });
        assert.ok(during?.windowId, 'the window that shows it');
        assert.match(duringFile, /open-ask:\s*\n\s+tool: tomAi_askUser/, 'in the entry file');
        assert.equal(live(item).status, 'sent');
        assert.equal(live(item).openAsk, undefined, 'answered: gone');
        assert.doesNotMatch(entryText(item.id), /open-ask/);
        // Outside a queue item's turn nothing is recorded.
        const outside = ASK_USER_LIVE_TOOL.execute({ questions: ['Panel question?'] } as never);
        await wait(50);
        assert.ok(queue().items.every((i) => !i.openAsk));
        AskUserRegistry.instance.cancel('done');
        await outside;
    });

    test('RA-3: restored after a reload, the answer continues the item', async () => {
        reset();
        const item = await itemLeftByReload({ tool: 'tomAi_askUser', input: { questions: ['Ship it?'], title: 'Release' }, windowId: 'window-before-reload', startedAt: '2026-11-18T10:00:00Z' });
        // The reload: crash recovery over what is on disk.
        q()._applyCrashRecoveryTo([live(item)]);
        assert.equal(live(item).status, 'sending', 'not reset to pending');
        const restored = q()._restoreOpenAsks() as Promise<void>;
        await wait(150);
        const pending = AskUserRegistry.instance.pendingForQueueItem(item.id);
        assert.deepEqual(pending?.questions, ['Ship it?'], 'the question is shown again');
        assert.equal(pending?.title, 'Release');
        assert.ok(userInteractions.forQueueItem(item.id).some((i) => i.kind === 'question'), 'in the user-input panel, for the item');
        assert.notEqual(live(item).openAsk?.windowId, 'window-before-reload', 'taken over by this window');
        assert.match(entryText(item.id), /open-ask:/, 'still recorded while it waits');
        script = () => 'went on';
        AskUserRegistry.instance.submit(pending!.requestId, 'Yes, ship v2', 'vscode');
        await restored;
        await wait(100);
        const last = turns.at(-1);
        assert.ok(last, 'the answer was sent');
        const text = promptOf(last);
        assert.match(text, /window was reloaded while you were waiting in tomAi_askUser/);
        assert.match(text, /> Title: Release\n> 1\. Ship it\?/);
        assert.match(text, /Yes, ship v2/);
        assert.equal(last.continueSessionId, 'sid-before-reload', 'the conversation the interrupted turn ran in');
        assert.equal(live(item).lastDispatched?.expandedText, 'the stage text', 'the stage keeps its text');
        assert.equal(live(item).status, 'sent');
        assert.equal(live(item).openAsk, undefined);
    });

    test('RA-4: other states and other windows', async () => {
        reset();
        const plain = await itemLeftByReload(undefined);
        q()._applyCrashRecoveryTo([live(plain)]);
        assert.equal(live(plain).status, 'pending', 'a reload in another state: back to pending (resend)');
        // An ask a live other window shows: kept sending, left to that window, not shown here.
        const folder = getLocalFolder();
        assert.ok(folder);
        fs.mkdirSync(folder!, { recursive: true });
        const heartbeat = path.join(folder!, 'w-other.window-state.json');
        fs.writeFileSync(heartbeat, JSON.stringify({ windowId: 'w-other', heartbeat: new Date().toISOString() }));
        try {
            const other = await itemLeftByReload({ tool: 'tomAi_askUser', input: { questions: ['Theirs?'] }, windowId: 'w-other', startedAt: '' });
            q()._applyCrashRecoveryTo([live(other)]);
            assert.equal(live(other).status, 'sending', 'kept sending');
            assert.equal(live(other).openAsk?.windowId, 'w-other', 'still the other window\'s');
            assert.equal(q()._openAsksToRestore.has(other.id), false, 'not restored here');
            live(other).status = 'error';
        } finally {
            fs.rmSync(heartbeat, { force: true });
        }
    });

    test('RA-5: a Resend closes the restored ask; its answer is not sent', async () => {
        reset();
        const item = await itemLeftByReload({ tool: 'tomAi_askUser', input: { questions: ['Wait?'] }, windowId: 'gone', startedAt: '' });
        q()._applyCrashRecoveryTo([live(item)]);
        const restored = q()._restoreOpenAsks() as Promise<void>;
        await wait(150);
        assert.ok(AskUserRegistry.instance.pendingForQueueItem(item.id));
        script = () => 'resent';
        await queue().resendLastPrompt(item.id, undefined, { interruptRunning: true });
        await restored;
        assert.equal(AskUserRegistry.instance.pendingForQueueItem(item.id), undefined, 'closed');
        assert.equal(turns.length, 1, 'only the resend went out');
        assert.doesNotMatch(promptOf(turns[0]), /window was reloaded/);
    });

    test('RA-6: a panel send restored after a reload', async () => {
        reset();
        const sent: Array<{ text: string; session?: string; run?: string }> = [];
        setOpenAskChatSender(async (p) => { sent.push(p); });
        const id = queue().addChatItem({ text: 'panel prompt', session: 'chat-panel', source: 'panel', run: 'r2' });
        const chatItem = queue().getById(id) as Json;
        chatItem.openAsk = { tool: 'tomAi_askUser', input: { questions: ['Merge now?'] }, windowId: 'gone-window', startedAt: '' };
        chatItem.chatWindowId = 'gone-window';
        q().persist();
        // The reload: the queue is read again from its files.
        q().restore();
        const item = queue().getById(id) as Json;
        assert.equal(item.status, 'chat', 'not settled as abandoned');
        const restored = q()._restoreOpenAsks() as Promise<void>;
        await wait(150);
        const pending = AskUserRegistry.instance.pendingForQueueItem(id);
        assert.deepEqual(pending?.questions, ['Merge now?'], 'the question is shown again');
        assert.equal(pending?.run, 'r2', 'in the send\'s run');
        AskUserRegistry.instance.submit(pending!.requestId, 'Yes, merge', 'vscode');
        await restored;
        assert.equal(sent.length, 1, 'one chat send');
        assert.equal(sent[0].session, 'chat-panel');
        assert.equal(sent[0].run, 'r2');
        assert.match(sent[0].text, /window was reloaded while you were waiting in tomAi_askUser[\s\S]*> 1\. Merge now\?[\s\S]*Yes, merge$/);
        const ended = queue().getById(id) as Json;
        assert.equal(ended.status, 'chat-sent');
        assert.equal(ended.answerText, RELOADED_CHAT_SEND_NOTE);
        assert.equal(ended.openAsk, undefined);
        setOpenAskChatSender(undefined);
    });

    test('RA-7: the window going down keeps the record', async () => {
        reset();
        let file = '';
        let goneOn = false;
        script = async () => {
            const answer = ASK_USER_LIVE_TOOL.execute({ questions: ['Still there?'] } as never);
            await wait(100);
            const it = queue().items.find((i) => i.status === 'sending') as Json;
            markShuttingDown();
            AskUserRegistry.instance.cancel('The window is closing.');
            await wait(100);
            file = entryText(it.id);
            await answer;
            goneOn = true;
            return 'gone';
        };
        await queue().enqueue({ originalText: 'ask then reload', transport: 'anthropic', anthropicProfileId: 'sdk', session: 's-down', deferSend: true, initialStatus: 'pending' } as never);
        queue().autoSendEnabled = true;
        await wait(600);
        queue().autoSendEnabled = false;
        assert.match(file, /open-ask:\s*\n\s+tool: tomAi_askUser/, 'the reloaded window finds it');
        assert.equal(goneOn, false, 'the turn does not go on with the closing note');
    });
});
