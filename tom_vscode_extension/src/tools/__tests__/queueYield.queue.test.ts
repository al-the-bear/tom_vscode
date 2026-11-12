/**
 * "Let the next item go first" (vscimpb60e, src/utils/queueYield.ts) through the real queue manager and its real
 * `dispatchStage` under the vscode stub; only the transport is a stub whose turns wait until the test answers them
 * (and complete their todo, as an agent would).
 *
 *   LY-1 pressed during an iteration of a `<prefix>*` walk: that iteration finishes (its answer kept), then the next
 *        pending item of the lane is sent, then the walk resumes at its next todo — each todo once, none skipped;
 *        an item of another run's lane is no yield target; the item shows the flag until it yields
 *   LY-2 pressed again before the iteration ends: cancelled, the walk goes on without yielding
 *   LY-3 on a pending iteration item: it moves at once behind the next pending item of its lane; the new order
 *        survives a reload (written to the queue files)
 *   LY-4 no following pending item in its lane, or not an iteration item: refused, with the reason
 *   LY-5 tomAi_updateQueueItem `letNextGoFirst` arms and cancels it
 */

/* eslint-disable @typescript-eslint/naming-convention -- config keys */
import test, { after, describe } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'fs';
import * as path from 'path';

const EXT_ROOT = path.resolve(__dirname, '..', '..', '..');
const SANDBOX = fs.realpathSync(fs.mkdtempSync(path.join(EXT_ROOT, '..', '..', '..', 'ztmp', 'vscode_extension_261112_vscimpb60e_yield-')));
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
import { PromptQueueManager, type QueuedPrompt } from '../../managers/promptQueueManager.js';
import { readAllEntries } from '../../storage/queueFileStorage.js';
import { updateQueueItemImpl, type PromptQueueAccess } from '../prompt-queue-tools.js';
import { updateTodo } from '../../managers/questTodoManager.js';
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
/** The turns sent (their text) and the ones running; a turn ends when the test answers it, completing its todo. */
const sent: string[] = [];
const running: Array<() => void> = [];
handler.sendMessage = (opts: Json) => new Promise((resolve) => {
    const text = String(opts.userText);
    sent.push(text);
    running.push(() => {
        const id = /(\w+\d_x)/.exec(text)?.[1];
        if (id) { updateTodo(QUEST, id, { status: 'completed' } as never); }
        resolve({ text: `done: ${text.slice(0, 30)}`, turnsUsed: 1, toolCallCount: 0 });
    });
});
async function answer(): Promise<void> {
    const next = running.shift();
    assert.ok(next, 'a turn is running');
    next();
    await wait(250);
}
function reset(): void {
    queue().autoSendEnabled = false;
    for (const i of [...queue().items]) { queue().remove(i.id); }
    sent.length = 0;
    running.length = 0;
}
const labels = (): string[] => sent.map((t) => /(\w+\d_x)/.exec(t)?.[1] ?? /(plain-\w+)/.exec(t)?.[1] ?? t.slice(0, 20));
const walkItem = (prefix: string, opts: Json = {}): Promise<QueuedPrompt> =>
    queue().enqueue({ originalText: 'work on ${repeatTodoId}', repeatCount: `${prefix}*`, transport: 'anthropic', anthropicProfileId: 'sdk', session: `s-${prefix}`, deferSend: true, initialStatus: 'pending', ...opts } as never);
const plainItem = (name: string, opts: Json = {}): Promise<QueuedPrompt> =>
    queue().enqueue({ originalText: `do plain-${name}`, transport: 'anthropic', anthropicProfileId: 'sdk', session: `s-${name}`, deferSend: true, initialStatus: 'pending', ...opts } as never);
const statusOf = (item: QueuedPrompt): string | undefined => queue().getById(item.id)?.status;
const order = (): string[] => queue().items.map((i) => i.id);

describe('Let the next item go first', () => {
    test('setup', () => {
        queue().autoSendEnabled = false;
        queue().setDefaultTransport('anthropic', 'sdk');
    });

    test('LY-1: during an iteration', async () => {
        reset();
        writeTodos('ya', 3);
        const w = await walkItem('ya');
        const n = await plainItem('next');
        const other = await plainItem('otherrun', { run: 'r2' });
        queue().setRunAutoSend('r2', false);
        queue().autoSendEnabled = true;
        await wait(250);
        assert.deepEqual(labels(), ['ya1_x'], 'the walk\'s first iteration runs; the next item waits in its lane');
        const r = queue().letNextGoFirst(w.id);
        assert.deepEqual(r, { ok: true, mode: 'armed', behind: n.id }, 'the next item of its own lane, not the other run\'s');
        assert.equal(queue().getById(w.id)?.yieldAfterIteration, true, 'shown until it yields');
        await answer();
        assert.deepEqual(labels(), ['ya1_x', 'plain-next'], 'the iteration finished, then the next item goes first');
        assert.equal(statusOf(w), 'pending');
        assert.equal(queue().getById(w.id)?.yieldAfterIteration, undefined);
        assert.ok(order().indexOf(w.id) > order().indexOf(n.id), 'the walk moved behind it');
        assert.equal((queue().getById(w.id)?.repetitionAnswers ?? []).some((a: Json) => a.key === 'ya1_x'), true, 'the iteration\'s answer is kept');
        await answer();
        assert.equal(statusOf(n), 'sent');
        assert.deepEqual(labels(), ['ya1_x', 'plain-next', 'ya2_x'], 'the walk resumes at its next todo');
        await answer();
        await answer();
        assert.deepEqual(labels(), ['ya1_x', 'plain-next', 'ya2_x', 'ya3_x'], 'each todo once');
        assert.equal(statusOf(w), 'sent');
        assert.equal(statusOf(other), 'pending', 'the other run\'s lane is paused and untouched');
        reset();
    });

    test('LY-2: cancelled before the iteration ends', async () => {
        reset();
        writeTodos('yb', 2);
        const w = await walkItem('yb');
        const n = await plainItem('after');
        queue().autoSendEnabled = true;
        await wait(250);
        assert.equal(queue().letNextGoFirst(w.id).ok, true);
        assert.deepEqual(queue().letNextGoFirst(w.id), { ok: true, mode: 'cancelled' }, 'pressed again: cancelled');
        await answer();
        assert.deepEqual(labels(), ['yb1_x', 'yb2_x'], 'the walk goes on');
        await answer();
        await wait(150);
        assert.deepEqual(labels(), ['yb1_x', 'yb2_x', 'plain-after']);
        await answer();
        assert.equal(statusOf(n), 'sent');
        reset();
    });

    test('LY-3: a pending iteration item, and a reload', async () => {
        reset();
        writeTodos('yc', 2);
        const w = await walkItem('yc');
        const p = await plainItem('first');
        assert.deepEqual(order(), [w.id, p.id]);
        assert.deepEqual(queue().letNextGoFirst(w.id), { ok: true, mode: 'moved', behind: p.id });
        assert.deepEqual(order(), [p.id, w.id], 'moved at once behind the next item');
        await wait(100);
        // A reload reads the queue files: the order is theirs.
        (queue() as Json)._loadFromEntryFiles(readAllEntries());
        assert.deepEqual(order(), [p.id, w.id], 'the order survives a reload');
        assert.equal(sent.length, 0, 'nothing sent: auto-send is off');
        reset();
    });

    test('LY-4: refused, with the reason', async () => {
        reset();
        writeTodos('yd', 2);
        const w = await walkItem('yd');
        const alone = queue().letNextGoFirst(w.id);
        assert.equal(alone.ok, false);
        assert.match(queue().letNextGoFirstUnavailable(w.id) ?? '', /no pending item follows it in its lane/);
        const p = await plainItem('single');
        assert.equal(queue().letNextGoFirstUnavailable(w.id), undefined, 'now there is one');
        assert.match(queue().letNextGoFirstUnavailable(p.id) ?? '', /not an iteration item|no pending item/);
        await plainItem('later');
        assert.match(queue().letNextGoFirstUnavailable(p.id) ?? '', /not an iteration item/);
        reset();
    });

    test('LY-5: the tool', async () => {
        reset();
        writeTodos('ye', 2);
        const w = await walkItem('ye');
        await plainItem('t');
        queue().autoSendEnabled = true;
        await wait(250);
        const access = {
            getById: (id: string) => queue().getById(id) as never,
            letNextGoFirst: (id: string) => queue().letNextGoFirst(id),
        } as unknown as PromptQueueAccess;
        let r = JSON.parse(await updateQueueItemImpl(access, { queueItemId: w.id, letNextGoFirst: true }));
        assert.equal(r.letNextGoFirst?.mode, 'armed', JSON.stringify(r));
        r = JSON.parse(await updateQueueItemImpl(access, { queueItemId: w.id, letNextGoFirst: true }));
        assert.equal(r.letNextGoFirst, undefined, 'already armed: nothing changes');
        r = JSON.parse(await updateQueueItemImpl(access, { queueItemId: w.id, letNextGoFirst: false }));
        assert.equal(r.letNextGoFirst?.mode, 'cancelled');
        queue().autoSendEnabled = false;
        while (running.length) { await answer(); }
        reset();
    });
});
