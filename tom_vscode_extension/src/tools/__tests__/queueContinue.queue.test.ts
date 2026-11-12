/**
 * Continue on a running stage (vscimpb54), through the real queue manager and its real `dispatchStage` under the
 * vscode stub. Only the transport is a stub: `AnthropicHandler.sendMessage` waits as a turn blocked in
 * tomAi_askUser does, and on cancel it ENDS NORMALLY with its last text — as the Agent SDK does when the askUser
 * call is cancelled. Measured in the d4rt window: Continue sent the next todo, and the cancelled turn's frame took
 * its normal end as the answer and sent the one after it too (two prompts at once).
 *
 *   CC-1 Agent SDK: Continue on a `w*` walk whose turn waits in tomAi_askUser sends exactly one next stage (the next
 *        todo); the cancelled turn's normal end sends nothing; the cancelled stage keeps the turn's last text,
 *        marked as ended by Continue; the walk then finishes, each todo sent once, never two turns at once
 *   CC-2 the direct API: the same
 *   CC-3 Stop (set to staged) while the turn runs: the turn's normal end sends nothing
 *   CC-4 CC-1 and CC-2 with a turn that ends the moment it is cancelled — before Continue's advance has run a stage
 */

/* eslint-disable @typescript-eslint/naming-convention -- config keys */
import test, { after, describe } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'fs';
import * as path from 'path';

const EXT_ROOT = path.resolve(__dirname, '..', '..', '..');
const SANDBOX = fs.realpathSync(fs.mkdtempSync(path.join(EXT_ROOT, '..', '..', '..', 'ztmp', 'vscode_extension_261112_vscimpb54_continue-')));
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

function writeTodos(prefix: string, n: number): void {
    const todos = Array.from({ length: n }, (_, i) => [
        `  - id: ${prefix}${i + 1}_x`, `    title: todo ${i + 1}`, '    status: not-started', '    priority: medium', '    created: 2026-11-12',
    ].join('\n'));
    fs.writeFileSync(path.join(QDIR, `todos.${prefix}.${QUEST}.todo.yaml`), `todos:\n${todos.join('\n')}\n`);
}

import { installVscodeStub } from './_vscode-stub.js';
const vscodeStub = installVscodeStub({ workspaceFolders: [WS] });
(vscodeStub.stub.workspace as Record<string, unknown>).workspaceFile = { fsPath: path.join(WS, `${QUEST}.code-workspace`), scheme: 'file' };

import { ChatVariablesStore } from '../../managers/chatVariablesStore.js';
import { ReminderSystem } from '../../managers/reminderSystem.js';
import { TimerEngine } from '../../managers/timerEngine.js';
import { CONTINUE_ANSWER_MARK, PromptQueueManager, type QueuedPrompt } from '../../managers/promptQueueManager.js';
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
const ASKING = 'I need your decision on the next step.';

/**
 * The turns sent (their text) and the ones running; a running turn waits until answered or cancelled. `inFlight`
 * counts the turns not cancelled: a cancelled turn still winding down beside the next stage is expected.
 */
const sent: string[] = [];
const running: Array<() => void> = [];
let inFlight = 0;
let maxInFlight = 0;
/** How long a cancelled turn takes to end: 0 ends it at once, inside Continue's own advance. */
let cancelEndsAfterMs = 30;
handler.sendMessage = (opts: Json) => new Promise((resolve) => {
    sent.push(String(opts.userText));
    inFlight++;
    maxInFlight = Math.max(maxInFlight, inFlight);
    handler._lastAssistantText = ASKING;
    let live = true;
    let ended = false;
    const stopCounting = (): void => {
        if (live) { live = false; inFlight--; }
    };
    const end = (text: string): void => {
        if (ended) { return; }
        ended = true;
        stopCounting();
        resolve({ text, turnsUsed: 1, toolCallCount: 1 });
    };
    // Waiting in tomAi_askUser: a cancel lets the turn end NORMALLY with its last text (the Agent SDK's way).
    opts.cancellationToken?.onCancellationRequested(() => {
        stopCounting();
        if (cancelEndsAfterMs === 0) { end(ASKING); } else { setTimeout(() => end(ASKING), cancelEndsAfterMs); }
    });
    running.push(() => end(`done: ${String(opts.userText).slice(0, 40)}`));
});
async function answer(): Promise<void> {
    const next = running.shift();
    assert.ok(next, 'a turn is running');
    next();
    await wait(150);
}
function reset(): void {
    queue().autoSendEnabled = false;
    for (const i of [...queue().items]) { queue().remove(i.id); }
    sent.length = 0;
    running.length = 0;
    inFlight = 0;
    maxInFlight = 0;
}
const walk = (prefix: string, profile: string): Promise<QueuedPrompt> =>
    queue().enqueue({ originalText: 'work on ${repeatTodoId}', repeatCount: `${prefix}*`, transport: 'anthropic', anthropicProfileId: profile, session: `s-${prefix}`, deferSend: true, initialStatus: 'pending' } as never);
const todoIds = (): string[] => sent.map((t) => /(\w+_x)/.exec(t)?.[1] ?? t);
const statusOf = (item: QueuedPrompt): string | undefined => queue().getById(item.id)?.status;

async function continueScenario(prefix: string, profile: string, endsAfterMs = 30): Promise<void> {
    reset();
    cancelEndsAfterMs = endsAfterMs;
    writeTodos(prefix, 3);
    const item = await walk(prefix, profile);
    queue().autoSendEnabled = true;
    await wait(200);
    assert.deepEqual(todoIds(), [`${prefix}1_x`], 'the first todo\'s turn waits in tomAi_askUser');
    running.shift(); // that turn only ends by the cancel now
    // Continue's frame runs the next stages itself (a direct answer goes straight on): it resolves when the walk ends.
    const continued = queue().continueSending(item.id);
    await wait(300);
    assert.deepEqual(todoIds(), [`${prefix}1_x`, `${prefix}2_x`], 'exactly one next stage: the cancelled turn\'s normal end sent nothing');
    assert.equal(inFlight, 1, 'one turn running');
    const live = queue().getById(item.id) as QueuedPrompt;
    const kept = (live.repetitionAnswers ?? []).find((a) => a.key === `${prefix}1_x`);
    assert.equal(kept?.text, `${ASKING}${CONTINUE_ANSWER_MARK}`, 'the cancelled stage keeps the turn\'s last text, marked');
    await answer();
    assert.deepEqual(todoIds(), [`${prefix}1_x`, `${prefix}2_x`, `${prefix}3_x`]);
    await answer();
    assert.equal(await continued, true);
    assert.equal(statusOf(item), 'sent');
    assert.equal(sent.length, 3, 'each todo once');
    assert.equal(maxInFlight, 1, 'never two live turns at once');
}

describe('Continue on a running stage', () => {
    test('setup', () => {
        queue().autoSendEnabled = false;
        queue().setDefaultTransport('anthropic', 'sdk');
    });

    test('CC-1: Agent SDK, the turn waiting in tomAi_askUser', async () => {
        await continueScenario('ca', 'sdk');
    });

    test('CC-2: the direct API', async () => {
        await continueScenario('cb', 'api');
    });

    test('CC-4: the cancelled turn ends at once, inside Continue\'s own advance', async () => {
        await continueScenario('cd', 'sdk', 0);
        await continueScenario('ce', 'api', 0);
        cancelEndsAfterMs = 30;
    });

    test('CC-3: Stop while the turn runs', async () => {
        reset();
        writeTodos('cc', 3);
        const item = await walk('cc', 'sdk');
        queue().autoSendEnabled = true;
        await wait(200);
        running.shift();
        assert.equal(queue().stopActiveItem(item.id), true);
        await wait(300);
        assert.equal(sent.length, 1, 'the stopped turn\'s normal end sent nothing');
        assert.equal(statusOf(item), 'staged');
        reset();
    });
});
