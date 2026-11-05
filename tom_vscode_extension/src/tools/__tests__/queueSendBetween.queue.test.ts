/**
 * "Send between iterations" through the real queue manager (src/utils/
 * queueSendBetween.ts, PromptQueueManager), under the vscode stub on the
 * Copilot transport, so nothing reaches a model: a Copilot send only opens
 * the (stubbed) chat and waits for an answer file.
 *
 *   SBQ-1 Send next on the pending item under a running loop marks it (the editor state flags it
 *         `canSendBetween`); a second click unmarks it; an item further down cannot be marked
 *   SBQ-2 the interleaved order: after iteration 1 the loop steps aside (back to pending, counters
 *         kept), the marked item moves in front of it and is sent (its mark cleared); once it is done
 *         the loop resumes with iteration 2 — not iteration 1 again
 *   SBQ-3 paused (auto-send off) at the boundary: the loop holds as before and the mark stays
 *   SBQ-4 the mark survives the queue file (`send-between`)
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
import { PromptQueueManager, type QueuedPrompt } from '../../managers/promptQueueManager.js';
import { TomAiConfiguration } from '../../utils/tomAiConfiguration.js';
import { setExtensionPath } from '../../handlers/handler_shared.js';
import { runningLoopAbove } from '../../utils/queueSendBetween.js';

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
const ids = (): string[] => queue().items.map((i) => i.id);
const wait = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));
// The dispatcher is private: the test drives one iteration boundary itself.
const boundary = (item: QueuedPrompt): Promise<string> =>
    (queue() as unknown as { dispatchNextStageForSendingItem(i: QueuedPrompt): Promise<string> }).dispatchNextStageForSendingItem(item);

function clear(): void { for (const i of [...queue().items]) { queue().remove(i.id); } }

/** A Copilot loop of three iterations with its first iteration sent, plus two pending items under it. */
async function loopWithOneIterationDone(): Promise<{ loop: QueuedPrompt; a: QueuedPrompt; b: QueuedPrompt }> {
    clear();
    const loop = await queue().enqueue({ originalText: 'iteration', repeatCount: 3, transport: 'copilot', deferSend: true });
    const a = await queue().enqueue({ originalText: 'between', transport: 'copilot', deferSend: true });
    const b = await queue().enqueue({ originalText: 'later', transport: 'copilot', deferSend: true });
    loop.status = 'sending';
    loop.repeatIndex = 1;
    loop.lastDispatched = { kind: 'main', expandedText: 'iteration', transport: 'copilot', dispatchedAt: new Date().toISOString() } as QueuedPrompt['lastDispatched'];
    return { loop, a, b };
}

describe('send between iterations', () => {
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
            await wait(50);
            const sentA = queue().getById(a.id)!;
            assert.equal(sentA.status, 'sending', 'the marked item is sent');
            assert.equal(sentA.sendBetween, undefined, 'its mark is cleared');
            assert.equal(queue().getById(loop.id)?.status, 'pending', 'the loop waits behind it');
            // The marked item's answer arrives: it is done; the queue goes on.
            sentA.status = 'sent';
            await queue().sendNext();
            await wait(50);
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
});
