/**
 * Copilot answer files are taken only by the window and stage they answer (qrfix2). The answer folder is shared
 * by every window, and every window's watcher sees every file. Replays the 2026-11-07 17:20 case through the real
 * queue manager: one manager stands in for each window in turn (its own `vscode.env.sessionId`, its own sending
 * item), and the same answer file reaches all of them. The dispatch frame (what advances a stage) is replaced by a
 * recorder, so nothing reaches a model.
 *
 *   AO-1 the 17:20 case: window A's Copilot answer in its window-named file reaches window B (an Anthropic stage
 *        sending) and window C (a Copilot stage waiting for another request): neither advances nor announces it;
 *        window A, the owner, advances and announces it, and the file is marked processed
 *   AO-2 a window-named file answering a named request: its owner window takes it when the content names its
 *        request, another window running a stage that waits for the same request id does not, and the owner
 *        window ignores it when the content names another request
 *   AO-3 a request-named file: the stage waiting for that request takes it; a stage waiting for a request whose
 *        id the file name only begins with does not
 *   AO-4 the stage in flight (its last dispatch) decides: an Anthropic item's Copilot follow-up takes its file; a
 *        Copilot item whose Anthropic stage is in flight takes nothing with a stale expected id
 */

import test, { after, describe } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'fs';
import * as path from 'path';

const EXT_ROOT = path.resolve(__dirname, '..', '..', '..');
const SANDBOX = fs.realpathSync(fs.mkdtempSync(path.join(EXT_ROOT, '..', '..', '..', 'ztmp', 'vscode_extension_261114_qrfix2_answerowner-')));
const WS = path.join(SANDBOX, 'ws');
const HOME = path.join(SANDBOX, 'home');
const QUEST = 'q1';

function put(rel: string, text: string): void {
    const abs = path.join(WS, rel);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, text);
}
put(`_ai/quests/${QUEST}/overview.${QUEST}.md`, '# Q1\n');
put('.tom/tom_vscode_extension.json', '{}\n');
fs.mkdirSync(HOME, { recursive: true });
process.env.HOME = HOME;
process.env.USERPROFILE = HOME;

import { installVscodeStub } from './_vscode-stub.js';
const vscodeStub = installVscodeStub({ workspaceFolders: [WS] });
(vscodeStub.stub.workspace as Record<string, unknown>).workspaceFile = { fsPath: path.join(WS, `${QUEST}.code-workspace`), scheme: 'file' };
const env = vscodeStub.stub.env as { sessionId: string; machineId: string };

import { ChatVariablesStore } from '../../managers/chatVariablesStore.js';
import { ProcessStateStore } from '../../managers/processStateStore.js';
import { TimerEngine } from '../../managers/timerEngine.js';
import { PromptQueueManager, type QueuedPrompt } from '../../managers/promptQueueManager.js';
import { TomAiConfiguration } from '../../utils/tomAiConfiguration.js';
import { setExtensionPath } from '../../handlers/handler_shared.js';
import { getCopilotChatAnswerFolderAbsolute } from '../../utils/sendToChatConfig.js';

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
    ProcessStateStore.init(context);
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

interface Internals {
    _items: QueuedPrompt[];
    _runDispatchFrame(item: QueuedPrompt): Promise<string>;
    onAnswerFileChanged(file?: string): Promise<void>;
}
const queue = (): PromptQueueManager => PromptQueueManager.instance;
const q = (): Internals => queue() as unknown as Internals;

/** The windows of the 17:20 case: each a session id (the first 8 characters name its window file) on one machine. */
const MACHINE = '89f7e0a0-machine';
const WINDOW = { a: '87dae86e-al-the-bear', b: 'b1b1b1b1-vscode-extension', c: 'c2c2c2c2-tom-d4rt' } as const;
const windowFile = (session: string): string => `${session.substring(0, 8)}_${MACHINE.substring(0, 8)}_answer.json`;

let advanced: string[] = [];
let announced = 0;

async function item(text: string, transport: 'copilot' | 'anthropic', expectedRequestId?: string): Promise<QueuedPrompt> {
    const it = await queue().enqueue({ originalText: text, transport, deferSend: true, initialStatus: 'staged' } as never);
    it.status = 'sending';
    it.sentAt = new Date().toISOString();
    it.expectedRequestId = expectedRequestId;
    return it;
}

/** `file` (written fresh with `content`) reaches the window `session` whose only item is `sending`. */
async function deliver(session: string, sending: QueuedPrompt, file: string, content: Record<string, unknown>): Promise<void> {
    env.sessionId = session;
    env.machineId = MACHINE;
    q()._items = [sending];
    const abs = path.join(getCopilotChatAnswerFolderAbsolute(), file);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, JSON.stringify(content));
    await q().onAnswerFileChanged(abs);
}

describe('answer files are taken by their owner only', () => {
    test('setup', async () => {
        await ProcessStateStore.ready;
        queue().autoSendEnabled = false;
        queue().setRunQueueSettings('default', { autoSend: false });
        q()._runDispatchFrame = async (it: QueuedPrompt) => { advanced.push(it.originalText); return 'paused'; };
        subscriptions.push(queue().onAnswerReceived(() => { announced++; }));
    });

    test('AO-1: the 17:20 case — only window A advances on its own answer', async () => {
        advanced = []; announced = 0;
        // Window A's prompt named no request id: its answer file and its expected id are the window's own.
        const stemA = windowFile(WINDOW.a).replace('_answer.json', '');
        const a = await item('A: copilot prompt', 'copilot', stemA);
        const b = await item('B: ccparity_d_claudecode-4 on the Agent SDK', 'anthropic');
        const c = await item('C: copilot prompt waiting for req-c', 'copilot', 'req-c');
        const answer = { requestId: stemA, generatedMarkdown: 'the answer of window A' };

        await deliver(WINDOW.b, b, windowFile(WINDOW.a), answer);
        await deliver(WINDOW.c, c, windowFile(WINDOW.a), answer);
        assert.deepEqual(advanced, [], 'the other windows do not advance');
        assert.equal(announced, 0, 'nor announce the answer (the reminder system listens to it)');
        assert.equal(b.status, 'sending');
        assert.equal(b.answerText, undefined);
        assert.equal(c.answerText, undefined);
        assert.equal(JSON.parse(fs.readFileSync(path.join(getCopilotChatAnswerFolderAbsolute(), windowFile(WINDOW.a)), 'utf8')).processed, undefined, 'and leave the file unmarked');

        await deliver(WINDOW.a, a, windowFile(WINDOW.a), answer);
        assert.deepEqual(advanced, ['A: copilot prompt'], 'window A advances');
        assert.equal(announced, 1);
        assert.ok(JSON.parse(fs.readFileSync(path.join(getCopilotChatAnswerFolderAbsolute(), windowFile(WINDOW.a)), 'utf8')).processed, 'marked processed');
    });

    test('AO-2: a window-named file is its window\'s, and only for the request its content names', async () => {
        advanced = []; announced = 0;
        const a = await item('A2: copilot prompt with a request id', 'copilot', 'req-a2');
        const c = await item('C2: copilot prompt with the same request id', 'copilot', 'req-a2');
        const answer = { requestId: 'req-a2', generatedMarkdown: 'A2' };
        await deliver(WINDOW.c, c, windowFile(WINDOW.a), answer);
        assert.deepEqual(advanced, [], 'another window\'s window file, even naming the request it waits for');
        await deliver(WINDOW.a, a, windowFile(WINDOW.a), { requestId: 'req-other', generatedMarkdown: 'other' });
        assert.deepEqual(advanced, [], 'its own window file naming another request');
        await deliver(WINDOW.a, a, windowFile(WINDOW.a), answer);
        assert.deepEqual(advanced, ['A2: copilot prompt with a request id']);
        assert.equal(announced, 1);
    });

    test('AO-3: a request-named file is its request\'s', async () => {
        advanced = []; announced = 0;
        const shortId = await item('C3: waits for req-1', 'copilot', 'req-1');
        await deliver(WINDOW.c, shortId, 'req-10_answer.json', { requestId: 'req-10', generatedMarkdown: 'ten' });
        assert.deepEqual(advanced, [], 'req-10 is not req-1');
        const owner = await item('C3: waits for req-10', 'copilot', 'req-10');
        await deliver(WINDOW.b, owner, 'req-10_answer.json', { requestId: 'req-10', generatedMarkdown: 'ten' });
        assert.deepEqual(advanced, ['C3: waits for req-10'], 'a request id is unique across windows: its file is its stage\'s');
        assert.equal(announced, 1);
    });

    test('AO-4: the stage in flight decides, not the item\'s main transport', async () => {
        advanced = []; announced = 0;
        // An Anthropic item whose Copilot follow-up is in flight takes that follow-up's file.
        const followUp = await item('D4: Anthropic main, Copilot follow-up in flight', 'anthropic', 'req-d4');
        followUp.lastDispatched = { kind: 'followUp', followUpIndex: 0, expandedText: 'x', transport: 'copilot', dispatchedAt: new Date().toISOString() };
        await deliver(WINDOW.b, followUp, 'req-d4_answer.json', { requestId: 'req-d4', generatedMarkdown: 'd4' });
        assert.deepEqual(advanced, ['D4: Anthropic main, Copilot follow-up in flight']);
        // A Copilot item whose Anthropic stage is in flight, with a stale expected id, takes nothing.
        const stale = await item('E4: Copilot main, Anthropic stage in flight', 'copilot', 'req-e4');
        stale.lastDispatched = { kind: 'followUp', followUpIndex: 0, expandedText: 'x', transport: 'anthropic', dispatchedAt: new Date().toISOString() };
        await deliver(WINDOW.b, stale, 'req-e4_answer.json', { requestId: 'req-e4', generatedMarkdown: 'e4' });
        assert.deepEqual(advanced, ['D4: Anthropic main, Copilot follow-up in flight'], 'the stale id drives nothing');
        assert.equal(announced, 1);
    });
});
