/**
 * The speech bubble of a running queue item: a message into its running prompt (PromptQueueManager
 * canMessageRunningItem / messageRunningItem), on the real manager in a sandbox root; the transport is a stub
 * that registers a live Agent SDK input for the item's session while its turn runs.
 *
 *   RM-1 not running, or running without a live Agent SDK query in its session: no message (canMessageRunningItem
 *        false; messageRunningItem refused with the reason); an empty text is refused
 *   RM-2 running with a live query: the text goes into it as another user message (trimmed); the item keeps it
 *        (`into: running`), with the answer once the query answers it; the questions journal records it
 *   RM-3 the queue file keeps `into: running` (round trip)
 */

import { describe, test, after } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'fs';
import * as path from 'path';

const EXT_ROOT = path.resolve(__dirname, '..', '..', '..');
const SANDBOX = fs.realpathSync(fs.mkdtempSync(path.join(EXT_ROOT, '..', '..', '..', 'ztmp', 'vscode_extension_261119_runmsg_queue-')));
const WS = path.join(SANDBOX, 'ws');
const HOME = path.join(SANDBOX, 'home');
const QUEST = 'q1';
const QDIR = path.join(WS, '_ai', 'quests', QUEST);
fs.mkdirSync(QDIR, { recursive: true });
// A root of its own, so nothing resolves to the real workspace.
fs.mkdirSync(path.join(SANDBOX, '.tom'), { recursive: true });
fs.writeFileSync(path.join(SANDBOX, '.tom', 'tom_root.yaml'), 'root: true\n');
fs.writeFileSync(path.join(QDIR, `overview.${QUEST}.md`), '# Q1\n');
// The configuration is the root's.
fs.writeFileSync(path.join(SANDBOX, '.tom', 'tom_vscode_extension.json'), JSON.stringify({
    anthropic: {
        profiles: [
            { id: 'sdk', name: 'SDK', systemPrompt: '', configurationId: 'c-sdk', isDefault: true },
            { id: 'api', name: 'API', systemPrompt: '', configurationId: 'c-api' },
        ],
        configurations: [
            { id: 'c-sdk', name: 'Agent SDK', model: 'claude-test', transport: 'agentSdk' },
            { id: 'c-api', name: 'Direct', model: 'claude-test', transport: 'direct' },
        ],
    },
}, null, 2));
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
import { AnthropicHandler } from '../../handlers/anthropic-handler.js';
import { registerLiveQuery } from '../../services/agentSdkLiveInputs.js';
import { waitMessagesFromYaml, waitMessagesToYaml } from '../../utils/itemWaitMessages.js';
import { TomAiConfiguration } from '../../utils/tomAiConfiguration.js';
import { setExtensionPath } from '../../handlers/handler_shared.js';

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

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Json = any;
const queue = (): PromptQueueManager => PromptQueueManager.instance;
const live = (id: string): Json => queue().getById(id);
const wait = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));
const handler = AnthropicHandler.instance as Json;
const originalSend = handler.sendMessage;
after(() => { handler.sendMessage = originalSend; });

/** The running turn: what was pushed into it, how to answer a push, and how to end the turn. */
let pushed: string[] = [];
let answerPush: (text: string) => void = () => undefined;
let endTurn: () => void = () => undefined;
let liveQuery = true;
handler.sendMessage = (opts: Json) => new Promise((resolve) => {
    let unregister: () => void = () => undefined;
    if (liveQuery) {
        const input = {
            closed: false,
            push: (text: string) => {
                pushed.push(text);
                return { answer: new Promise<string>((r) => { answerPush = r; }) };
            },
        };
        unregister = registerLiveQuery(opts.sessionKey, input as never);
    }
    endTurn = () => { unregister(); resolve({ text: 'done', turnsUsed: 1, toolCallCount: 0 }); };
});

describe('queue item: a message into its running prompt', () => {
    test('RM-1: nothing to write into', async () => {
        queue().autoSendEnabled = false;
        liveQuery = false;
        const item = await queue().enqueue({ originalText: 'work', transport: 'anthropic', anthropicProfileId: 'sdk', deferSend: true } as never);
        assert.equal(queue().canMessageRunningItem(item.id), false);
        assert.deepEqual(queue().messageRunningItem(item.id, 'hi'), { ok: false, reason: 'The item is not running.' });
        void queue().sendNow(item.id);
        await wait(150);
        assert.equal(live(item.id).status, 'sending');
        assert.ok(queue().runningSessionOf(item.id));
        assert.equal(queue().canMessageRunningItem(item.id), false, 'no live Agent SDK query in its session');
        const refused = queue().messageRunningItem(item.id, 'hi') as Json;
        assert.equal(refused.ok, false);
        assert.match(refused.reason, /only an Agent SDK prompt takes a message while it runs/);
        assert.deepEqual(queue().messageRunningItem(item.id, '  '), { ok: false, reason: 'The message is empty.' });
        endTurn();
        await wait(150);
        queue().remove(item.id);
    });

    test('RM-2: into the running query, with its answer', async () => {
        liveQuery = true;
        pushed = [];
        const item = await queue().enqueue({ originalText: 'work', transport: 'anthropic', anthropicProfileId: 'sdk', deferSend: true } as never);
        void queue().sendNow(item.id);
        await wait(150);
        assert.equal(queue().canMessageRunningItem(item.id), true);
        const r = queue().messageRunningItem(item.id, '  Also update the changelog.  ') as Json;
        assert.equal(r.ok, true);
        assert.equal(r.session, queue().runningSessionOf(item.id));
        assert.deepEqual(pushed, ['Also update the changelog.']);
        assert.deepEqual(live(item.id).waitMessages.map((m: Json) => [m.into, m.text, m.answer]), [['running', 'Also update the changelog.', undefined]]);
        answerPush('  Changelog updated.  ');
        assert.equal(await r.answer, '  Changelog updated.  ');
        await wait(20);
        assert.equal(live(item.id).waitMessages[0].answer, 'Changelog updated.');
        const journal = fs.readFileSync(path.join(QDIR, `questions.${QUEST}.md`), 'utf8');
        assert.match(journal, /message to a running prompt/);
        assert.match(journal, /Also update the changelog\./);
        endTurn();
        await wait(150);
        assert.equal(live(item.id).status, 'sent');
        assert.equal(live(item.id).waitMessages.length, 1, 'kept after the item ended');
    });

    test('RM-3: the queue file keeps it', () => {
        const yaml = waitMessagesToYaml([{ at: '2026-11-19T12:00:00.000Z', into: 'running', text: 'x', answer: 'y' }]);
        assert.deepEqual(yaml, [{ at: '2026-11-19T12:00:00.000Z', into: 'running', text: 'x', answer: 'y' }]);
        assert.deepEqual(waitMessagesFromYaml(yaml), [{ at: '2026-11-19T12:00:00.000Z', into: 'running', text: 'x', answer: 'y' }]);
    });
});
