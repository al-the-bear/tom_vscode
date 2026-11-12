/**
 * A run's queue items without a session of their own run in the run's queue session (qrun1), through the real
 * manager with Queue per run; the transport is a stub whose turns wait until the test ends them.
 *
 *   RQ-1 an item of run `collab` without a session sends while an item of the default run sends in `default`:
 *        in `default@collab`, not waiting for `default` (the collab run was stuck so on 2026-11-12)
 *   RQ-2 an item that names its session keeps it; the default run's item keeps the queue default
 */

/* eslint-disable @typescript-eslint/naming-convention -- config keys */
import test, { after, describe } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'fs';
import * as path from 'path';

const EXT_ROOT = path.resolve(__dirname, '..', '..', '..');
const SANDBOX = fs.realpathSync(fs.mkdtempSync(path.join(EXT_ROOT, '..', '..', '..', 'ztmp', 'vscode_extension_261112_qrun1_runsessions-')));
const WS = path.join(SANDBOX, 'ws');
const HOME = path.join(SANDBOX, 'home');
const QUEST = 'q1';
const QDIR = path.join(WS, '_ai', 'quests', QUEST);
fs.mkdirSync(QDIR, { recursive: true });
fs.writeFileSync(path.join(QDIR, `overview.${QUEST}.md`), '# Q1\n');
fs.mkdirSync(path.join(WS, '.tom'), { recursive: true });
fs.writeFileSync(path.join(WS, '.tom', 'tom_vscode_extension.json'), JSON.stringify({
    anthropic: {
        apiKeyEnvVar: 'TOM_TEST_ANTHROPIC_KEY',
        profiles: [
            { id: 'sdk', name: 'SDK', systemPrompt: '', configurationId: 'c-sdk' },
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
process.env.TOM_TEST_ANTHROPIC_KEY = 'test-key';

import { installVscodeStub } from './_vscode-stub.js';
const vscodeStub = installVscodeStub({ workspaceFolders: [WS] });
(vscodeStub.stub.workspace as Record<string, unknown>).workspaceFile = { fsPath: path.join(WS, `${QUEST}.code-workspace`), scheme: 'file' };

import { ChatVariablesStore } from '../../managers/chatVariablesStore.js';
import { ReminderSystem } from '../../managers/reminderSystem.js';
import { TimerEngine } from '../../managers/timerEngine.js';
import { PromptQueueManager } from '../../managers/promptQueueManager.js';
import { TomAiConfiguration } from '../../utils/tomAiConfiguration.js';
import { setExtensionPath } from '../../handlers/handler_shared.js';
import { AnthropicHandler } from '../../handlers/anthropic-handler.js';

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

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Json = any;
const handler = AnthropicHandler.instance as Json;
const originalSend = handler.sendMessage;
after(() => {
    handler.sendMessage = originalSend;
    for (const stop of [() => PromptQueueManager.instance.dispose(), () => TimerEngine.instance.dispose(), () => ReminderSystem.instance.dispose()]) {
        try { stop(); } catch { /* not started */ }
    }
    for (const s of subscriptions.splice(0)) { try { s.dispose(); } catch { /* already gone */ } }
    vscodeStub.restore();
    fs.rmSync(SANDBOX, { recursive: true, force: true });
});

const queue = (): PromptQueueManager => PromptQueueManager.instance;
const wait = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));
const turns: Json[] = [];
const ends: Array<() => void> = [];
handler.sendMessage = (opts: Json) => new Promise((resolve) => {
    turns.push(opts);
    ends.push(() => resolve({ text: 'done', turnsUsed: 1, toolCallCount: 0 }));
});

describe('the queue session of a run', () => {
    test('RQ-1: two runs, no named sessions: they send at once, each in its own session', async () => {
        queue().setDefaultTransport('anthropic', 'sdk');
        queue().queuePerRun = true;
        await queue().enqueue({ originalText: 'default-run work', transport: 'anthropic', anthropicProfileId: 'sdk', run: 'default', deferSend: true, initialStatus: 'pending' } as never);
        await queue().enqueue({ originalText: 'collab-run work', transport: 'anthropic', anthropicProfileId: 'sdk', run: 'collab', deferSend: true, initialStatus: 'pending' } as never);
        queue().autoSendEnabled = true;
        await wait(400);
        const byText = (t: string): Json => turns.find((o) => String(o.userText).includes(t));
        assert.ok(byText('default-run work'), 'the default run sends');
        assert.ok(byText('collab-run work'), 'the collab run sends at the same time, not waiting for session default');
        assert.equal(byText('collab-run work').sessionKey, 'default@collab');
        assert.notEqual(byText('default-run work').sessionKey, 'default@collab');
        for (const end of ends.splice(0)) { end(); }
        await wait(200);
    });

    test('RQ-2: a named session is kept', async () => {
        turns.length = 0;
        await queue().enqueue({ originalText: 'named work', transport: 'anthropic', anthropicProfileId: 'sdk', run: 'collab', session: 'idea@collab', deferSend: true, initialStatus: 'pending' } as never);
        queue().autoSendEnabled = true; // Auto-Pause stopped the queue when RQ-1 emptied it
        await wait(400);
        assert.equal(turns.find((o) => String(o.userText).includes('named work'))?.sessionKey, 'idea@collab');
        for (const end of ends.splice(0)) { end(); }
        await wait(200);
        queue().autoSendEnabled = false;
    });
});
