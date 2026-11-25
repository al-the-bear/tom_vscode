/**
 * "Send between iterations" through the real queue manager (src/utils/
 * queueSendBetween.ts, PromptQueueManager), under the vscode stub. Only the
 * transport is a stub, so nothing reaches a model: a turn that is sent stays
 * running (its item `sending`) until the test answers it.
 *
 *   SBQ-1 Send next on the pending item under a running loop marks it (the editor state flags it
 *         `canSendBetween`); a second click unmarks it; an item further down cannot be marked
 *   SBQ-2 the interleaved order: after iteration 1 the loop steps aside (back to pending, counters
 *         kept), the marked item moves in front of it and is sent (its mark cleared); once it is done
 *         the loop resumes with iteration 2 — not iteration 1 again
 *   SBQ-3 paused (auto-send off) at the boundary: the loop holds as before and the mark stays
 *   SBQ-4 the mark survives the queue file (`send-between`)
 *   SBQ-5 Queue next (enqueueNext): pending directly under the running loop and marked to go between its
 *         iterations; with nothing sending, in front of the first pending item and unmarked; no profile or
 *         session pinned (the queue's own apply)
 *   SBQ-6 editing a pending item's text: it keeps its place, the queue holds before sending it while the
 *         edit is open (also when it is the marked item between iterations), Save writes the text and sends
 *         it, Cancel keeps the old text; a sent item cannot be opened; closing the editor ends every edit
 */

import test, { after, describe } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

const SANDBOX = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'queue-send-between-')));
const WS = path.join(SANDBOX, 'ws');
const HOME = path.join(SANDBOX, 'home');
const QUEST = 'q1';
const EXT_ROOT = path.resolve(__dirname, '..', '..', '..');
/* eslint-disable @typescript-eslint/naming-convention -- config keys */
const CONFIG = JSON.stringify({
    anthropic: {
        apiKeyEnvVar: 'TOM_TEST_ANTHROPIC_KEY',
        profiles: [{ id: 'sdk', name: 'SDK', systemPrompt: '', configurationId: 'c-sdk' }],
        configurations: [{ id: 'c-sdk', name: 'Agent SDK', model: 'claude-test', transport: 'agentSdk' }],
    },
}, null, 2);
for (const [rel, text] of [[`_ai/quests/${QUEST}/overview.${QUEST}.md`, '# Q1\n'], ['.tom/tom_vscode_extension.json', CONFIG]]) {
    const abs = path.join(WS, rel);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, text);
}
fs.mkdirSync(HOME, { recursive: true });
process.env.HOME = HOME;
process.env.USERPROFILE = HOME;
process.env.TOM_TEST_ANTHROPIC_KEY = 'test-key';

import { installVscodeStub } from './_vscode-stub.js';
const vscodeStub = installVscodeStub({ workspaceFolders: [WS] });
(vscodeStub.stub.workspace as Record<string, unknown>).workspaceFile = { fsPath: path.join(WS, `${QUEST}.code-workspace`), scheme: 'file' };

import { ChatVariablesStore } from '../../managers/chatVariablesStore.js';
import { TimerEngine } from '../../managers/timerEngine.js';
import { PromptQueueManager, type QueuedPrompt } from '../../managers/promptQueueManager.js';
import { TomAiConfiguration } from '../../utils/tomAiConfiguration.js';
import { setExtensionPath } from '../../handlers/handler_shared.js';
import { runningLoopAbove } from '../../utils/queueSendBetween.js';
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
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Json = any;
const handler = AnthropicHandler.instance as Json;
const originalSend = handler.sendMessage;
/** The turns sent (their text) and the ones running; a turn ends when the test answers it. */
const sent: string[] = [];
const running: Array<() => void> = [];
handler.sendMessage = (opts: Json) => new Promise((resolve) => {
    const text = String(opts.userText);
    sent.push(text);
    running.push(() => resolve({ text: `done: ${text.slice(0, 30)}`, turnsUsed: 1, toolCallCount: 0 }));
});
after(() => {
    handler.sendMessage = originalSend;
    for (const stop of [() => PromptQueueManager.instance.dispose(), () => TimerEngine.instance.dispose()]) {
        try { stop(); } catch { /* not started */ }
    }
    for (const s of subscriptions.splice(0)) { try { s.dispose(); } catch { /* already gone */ } }
    vscodeStub.restore();
    fs.rmSync(SANDBOX, { recursive: true, force: true });
});

const queue = (): PromptQueueManager => PromptQueueManager.instance;
const ids = (): string[] => queue().items.map((i) => i.id);
const wait = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));
/** The oldest running turn answers. */
async function answer(): Promise<void> {
    const next = running.shift();
    assert.ok(next, 'a turn is running');
    next();
    await wait(250);
}
// The dispatcher is private: the test drives one iteration boundary itself.
const boundary = (item: QueuedPrompt): Promise<string> =>
    (queue() as unknown as { dispatchNextStageForSendingItem(i: QueuedPrompt): Promise<string> }).dispatchNextStageForSendingItem(item);

function clear(): void {
    for (const i of [...queue().items]) { queue().remove(i.id); }
    sent.length = 0;
    running.length = 0;
}

/** A loop of three iterations with its first iteration sent, plus two pending items under it. */
async function loopWithOneIterationDone(): Promise<{ loop: QueuedPrompt; a: QueuedPrompt; b: QueuedPrompt }> {
    clear();
    const loop = await queue().enqueue({ originalText: 'iteration', repeatCount: 3, transport: 'anthropic', deferSend: true });
    const a = await queue().enqueue({ originalText: 'between', transport: 'anthropic', deferSend: true });
    const b = await queue().enqueue({ originalText: 'later', transport: 'anthropic', deferSend: true });
    loop.status = 'sending';
    loop.repeatIndex = 1;
    loop.lastDispatched = { kind: 'main', expandedText: 'iteration', transport: 'anthropic', dispatchedAt: new Date().toISOString() } as QueuedPrompt['lastDispatched'];
    return { loop, a, b };
}

describe('send between iterations', () => {
    test('setup', () => {
        queue().autoSendEnabled = false;
        queue().setDefaultTransport('anthropic', 'sdk');
    });

    test('SBQ-1: marking and unmarking', async () => {
        const { a, b } = await loopWithOneIterationDone();
        assert.ok(runningLoopAbove(queue().items, a.id), 'the editor offers it on the item under the loop');
        assert.equal(runningLoopAbove(queue().items, b.id), undefined, 'not further down');
        assert.equal(queue().toggleSendBetween(a.id), true);
        assert.equal(queue().toggleSendBetween(b.id), undefined, 'cannot mark an item further down');
        assert.equal(queue().toggleSendBetween(a.id), false, 'a second click unmarks');
        assert.equal(queue().getById(a.id)?.sendBetween, undefined);
    });

    test('SBQ-2: iteration 1, the marked item, iteration 2', async () => {
        const { loop, a, b } = await loopWithOneIterationDone();
        queue().toggleSendBetween(a.id);
        queue().autoSendEnabled = true;
        try {
            const outcome = await boundary(loop);
            assert.equal(outcome, 'paused', 'the loop steps aside');
            assert.deepEqual(ids(), [a.id, loop.id, b.id], 'the marked item moved in front of the loop');
            assert.equal(loop.status, 'pending');
            assert.equal(loop.repeatIndex, 1, 'counters kept');
            await wait(250);
            const sentA = queue().getById(a.id)!;
            assert.equal(sentA.status, 'sending', 'the marked item is sent');
            assert.ok(sent.some((t) => t.includes('between')), 'its prompt went out');
            assert.ok(!sent.some((t) => t.includes('iteration')), 'the loop\'s next iteration did not');
            assert.equal(sentA.sendBetween, undefined, 'its mark is cleared');
            assert.equal(queue().getById(loop.id)?.status, 'pending', 'the loop waits behind it');
            // The marked item's answer arrives: it is done; the queue goes on.
            await answer();
            assert.equal(queue().getById(a.id)?.status, 'sent', 'the marked item is done');
            const resumed = queue().getById(loop.id)!;
            assert.equal(resumed.status, 'sending', 'the loop resumes');
            assert.equal(resumed.repeatIndex, 2, 'with iteration 2, not iteration 1 again');
            assert.equal(queue().getById(b.id)?.status, 'pending', 'the rest still waits');
        } finally {
            queue().autoSendEnabled = false;
        }
    });

    test('SBQ-3: paused at the boundary, the loop holds and the mark stays', async () => {
        const { loop, a } = await loopWithOneIterationDone();
        queue().toggleSendBetween(a.id);
        queue().autoSendEnabled = false;
        assert.equal(await boundary(loop), 'paused');
        assert.equal(loop.status, 'sending', 'held as before');
        assert.equal(queue().getById(a.id)?.sendBetween, true, 'the mark stays');
        assert.deepEqual(ids().slice(0, 2), [loop.id, a.id], 'nothing moved');
    });

    test('SBQ-4: the mark survives the queue file', async () => {
        const { a } = await loopWithOneIterationDone();
        queue().toggleSendBetween(a.id);
        const files: string[] = [];
        const walk = (dir: string): void => {
            for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
                const p = path.join(dir, e.name);
                if (e.isDirectory()) { walk(p); } else if (/\.ya?ml$/.test(e.name) && fs.readFileSync(p, 'utf8').includes(a.id)) { files.push(p); }
            }
        };
        walk(SANDBOX);
        assert.ok(files.some((f) => /send-between: true/.test(fs.readFileSync(f, 'utf8'))), 'written as meta send-between');
        clear();
    });

    test('SBQ-5: Queue next', async () => {
        const { loop, a } = await loopWithOneIterationDone();
        const next = await queue().enqueueNext({ originalText: 'urgent', transport: 'anthropic' });
        assert.equal(next.status, 'pending');
        assert.deepEqual(ids().slice(0, 3), [loop.id, next.id, a.id], 'directly under the running loop');
        assert.equal(queue().getById(next.id)?.sendBetween, true, 'marked: sent between the loop\'s iterations');
        assert.equal(next.anthropicProfileId, undefined, 'the queue\'s profile');
        assert.equal(next.session, undefined, 'the queue\'s session');
        // Nothing sending: in front of the pending items, no mark.
        clear();
        queue().autoSendEnabled = false;
        const staged = await queue().enqueue({ originalText: 'staged', transport: 'anthropic', deferSend: true, initialStatus: 'staged' });
        const pending = await queue().enqueue({ originalText: 'pending', transport: 'anthropic', deferSend: true });
        const first = await queue().enqueueNext({ originalText: 'first', transport: 'anthropic', deferSend: true });
        assert.deepEqual(ids(), [staged.id, first.id, pending.id]);
        assert.equal(queue().getById(first.id)?.sendBetween, undefined);
        clear();
    });

    test('SBQ-6: editing a pending item holds the queue for it', async () => {
        const { loop, a } = await loopWithOneIterationDone();
        queue().toggleSendBetween(a.id);
        assert.equal(queue().beginTextEdit(a.id), true);
        assert.equal(queue().isTextBeingEdited(a.id), true);
        queue().autoSendEnabled = true;
        try {
            assert.equal(await boundary(loop), 'paused', 'the loop steps aside for the marked item');
            await wait(250);
            assert.equal(queue().getById(a.id)?.status, 'pending', 'held: it is being edited');
            assert.equal(queue().getById(loop.id)?.status, 'pending', 'the loop waits behind it');
            assert.equal(ids().indexOf(a.id), 0, 'it keeps its place');
            await queue().endTextEdit(a.id, 'between, edited');
            await wait(250);
            const sent = queue().getById(a.id)!;
            assert.equal(sent.originalText, 'between, edited', 'saved');
            assert.equal(sent.status, 'sending', 'and sent once saved');
            assert.equal(queue().beginTextEdit(a.id), false, 'a sending item cannot be opened');
        } finally {
            queue().autoSendEnabled = false;
        }
        // Cancel keeps the text; closing the editor (no id) ends every open edit.
        clear();
        const p = await queue().enqueue({ originalText: 'keep me', transport: 'anthropic', deferSend: true });
        assert.equal(queue().beginTextEdit(p.id), true);
        await queue().endTextEdit(p.id);
        assert.equal(queue().getById(p.id)?.originalText, 'keep me');
        assert.equal(queue().isTextBeingEdited(p.id), false);
        queue().beginTextEdit(p.id);
        await queue().endTextEdit(undefined);
        assert.equal(queue().isTextBeingEdited(p.id), false, 'closing the editor ends it');
        clear();
    });
});
