/**
 * The prompts as sent, through the real queue manager (utils/sentPrompts.ts); the transport is a stub that
 * reports the system prompt and user message it composed (`onPromptComposed`) and answers at once.
 *
 *   SPQ-1 an item with a pre-prompt and a follow-up sends three stages: each gets a record on the item —
 *         `Pre-prompt 1`, `Main prompt`, `Follow-up 1` — with the user message and the system prompt as sent kept
 *         once each in the queue folder's `sent-prompts/` (one system prompt shared by all three stages: one file);
 *         the records survive the queue file (reloaded from disk)
 *   SPQ-2 a chat send's prompt is recorded on its chat item (`recordChatPrompt`, label `Chat send`)
 */

/* eslint-disable @typescript-eslint/naming-convention -- config keys */
import test, { after, describe } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'fs';
import * as path from 'path';

const EXT_ROOT = path.resolve(__dirname, '..', '..', '..');
const SANDBOX = fs.realpathSync(fs.mkdtempSync(path.join(EXT_ROOT, '..', '..', '..', 'ztmp', 'vscode_extension_261126_01_aifmt-8_sent-')));
const WS = path.join(SANDBOX, 'ws');
const HOME = path.join(SANDBOX, 'home');
const QUEST = 'q1';
const QDIR = path.join(WS, '_ai', 'quests', QUEST);
fs.mkdirSync(QDIR, { recursive: true });
fs.writeFileSync(path.join(QDIR, `overview.${QUEST}.md`), '# Q1\n');
fs.mkdirSync(path.join(WS, '.tom'), { recursive: true });
fs.writeFileSync(path.join(WS, '.tom', 'tom_root.yaml'), 'root: true\n');
fs.writeFileSync(path.join(WS, '.tom', 'tom_vscode_extension.json'), JSON.stringify({
    anthropic: {
        apiKeyEnvVar: 'TOM_TEST_ANTHROPIC_KEY',
        profiles: [{ id: 'sdk', name: 'SDK', systemPrompt: '', configurationId: 'c-sdk' }],
        configurations: [{ id: 'c-sdk', name: 'Agent SDK', model: 'claude-test', transport: 'agentSdk' }],
    },
}, null, 2));
fs.mkdirSync(HOME, { recursive: true });
process.env.HOME = HOME;
process.env.USERPROFILE = HOME;
process.env.TOM_TEST_ANTHROPIC_KEY = 'test-key';

import { installVscodeStub } from './_vscode-stub.js';
const vscodeStub = installVscodeStub({ workspaceFolders: [WS] });
(vscodeStub.stub.workspace as Record<string, unknown>).workspaceFile = { fsPath: path.join(WS, `${QUEST}.code-workspace`), scheme: 'file' };

import { ChatVariablesStore } from '../../managers/chatVariablesStore.js';
import { TimerEngine } from '../../managers/timerEngine.js';
import { PromptQueueManager } from '../../managers/promptQueueManager.js';
import { TomAiConfiguration } from '../../utils/tomAiConfiguration.js';
import { setExtensionPath } from '../../handlers/handler_shared.js';
import { AnthropicHandler } from '../../handlers/anthropic-handler.js';
import { getQueueFolder, readAllEntries } from '../../storage/queueFileStorage.js';
import { readSentText, SENT_PROMPTS_FOLDER } from '../../utils/sentPrompts.js';

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

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Json = any;
const handler = AnthropicHandler.instance as Json;
const originalSend = handler.sendMessage;
after(() => {
    handler.sendMessage = originalSend;
    for (const stop of [() => PromptQueueManager.instance.dispose(), () => TimerEngine.instance.dispose()]) {
        try { stop(); } catch { /* not started */ }
    }
    for (const s of subscriptions.splice(0)) { try { s.dispose(); } catch { /* already gone */ } }
    vscodeStub.restore();
    fs.rmSync(SANDBOX, { recursive: true, force: true });
});

const SYSTEM = '# The system prompt\n\nShared by every stage.';
handler.sendMessage = async (opts: Json) => {
    opts.onPromptComposed?.({ systemPrompt: SYSTEM, userMessage: `WRAPPED: ${opts.userText}` });
    return { text: `answer to ${opts.userText}`, turnsUsed: 1, toolCallCount: 0 };
};

const queue = (): PromptQueueManager => PromptQueueManager.instance;
const wait = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

describe('the prompts as sent', () => {
    test('SPQ-1: every stage of an item is recorded with its texts as sent', async () => {
        queue().setDefaultTransport('anthropic', 'sdk');
        const { id } = await queue().enqueue({
            originalText: 'the main work', transport: 'anthropic', anthropicProfileId: 'sdk', deferSend: true, initialStatus: 'pending',
            prePrompts: [{ text: 'first look around' }], followUps: [{ originalText: 'then summarise' }],
        } as never);
        queue().autoSendEnabled = true;
        for (let i = 0; i < 60 && queue().items.find((x) => x.id === id)?.status !== 'sent'; i++) { await wait(100); }
        queue().autoSendEnabled = false;
        const item = queue().items.find((x) => x.id === id)!;
        assert.equal(item.status, 'sent');
        const records = item.sentPrompts ?? [];
        assert.deepEqual(records.map((r) => r.label), ['Pre-prompt 1', 'Main prompt', 'Follow-up 1']);
        const folder = getQueueFolder()!;
        const userTexts = records.map((r) => readSentText(folder, r.promptRef!));
        assert.ok(userTexts[0]!.startsWith('WRAPPED: ') && userTexts[0]!.includes('first look around'), 'the pre-prompt as sent');
        assert.ok(userTexts[1]!.includes('the main work'));
        assert.ok(userTexts[2]!.includes('then summarise'));
        assert.equal(new Set(records.map((r) => r.systemRef)).size, 1, 'one system prompt for all three');
        assert.equal(readSentText(folder, records[0].systemRef!), SYSTEM);
        assert.equal(records[0].systemChars, SYSTEM.length);
        const files = fs.readdirSync(path.join(folder, SENT_PROMPTS_FOLDER));
        assert.equal(files.length, 4, 'three user messages, one system prompt');
        // The records are in the queue file.
        const stored = readAllEntries().flatMap((e) => e.doc['prompt-queue'] ?? []).map((p) => p.execution?.['sent-prompts']).find((s) => Array.isArray(s));
        assert.deepEqual(stored?.map((s: Json) => s.label), ['Pre-prompt 1', 'Main prompt', 'Follow-up 1'], 'persisted');
    });

    test('SPQ-2: a chat send\'s prompt goes onto its chat item', () => {
        const id = queue().addChatItem({ text: 'hello', session: 'chat', source: 'panel' });
        queue().recordChatPrompt(id, { systemPrompt: SYSTEM, userMessage: 'hello, wrapped' });
        const item = queue().items.find((x) => x.id === id)!;
        assert.deepEqual(item.sentPrompts?.map((r) => r.label), ['Chat send']);
        assert.equal(readSentText(getQueueFolder()!, item.sentPrompts![0].promptRef!), 'hello, wrapped');
    });
});
