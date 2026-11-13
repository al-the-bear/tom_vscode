/**
 * A queue turn waiting in tomAi_waitFor (vscimpb82), through the real manager under the vscode stub; the
 * transport is a stub whose turn calls the real tool inside the item's dispatch (so the wait belongs to the item).
 *
 *   QF-1 the wait shows on the item (waitForOf, the queue file's `waiting-for`, tomAi_listQueue's projection, the
 *        window summary) and ends by itself at its time: the tool answers `elapsed`, the state is cleared, the turn
 *        goes on and the item is sent
 *   QF-2 Interrupt the wait and move on: the tool answers `interrupted` at once, the turn ends with its note, the
 *        item steps back behind the next pending item of its lane (resumeAfterWait, in the file too), that item
 *        goes first, and then the item's stage is sent again with WAIT_RESUME_NOTE and finishes
 *   QF-3 nothing follows in its lane: the item is held as staged; sent again, it resumes with the note
 *   QF-4 Continue on a waiting item offers Keep waiting and Interrupt the wait and move on, then Resend and Skip;
 *        Keep waiting changes nothing, Interrupt interrupts
 *   QF-5 Stop on a waiting item cancels the wait: the tool answers `cancelled`, the state is cleared
 */

/* eslint-disable @typescript-eslint/naming-convention -- config keys */
import test, { after, describe } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'fs';
import * as path from 'path';

const EXT_ROOT = path.resolve(__dirname, '..', '..', '..');
const SANDBOX = fs.realpathSync(fs.mkdtempSync(path.join(EXT_ROOT, '..', '..', '..', 'ztmp', 'vscode_extension_261113_vscimpb82_waitfor-')));
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
import { ReminderSystem } from '../../managers/reminderSystem.js';
import { TimerEngine } from '../../managers/timerEngine.js';
import { PromptQueueManager, type QueuedPrompt } from '../../managers/promptQueueManager.js';
import { continueWithChoice } from '../../handlers/queueEditor-handler.js';
import { TomAiConfiguration } from '../../utils/tomAiConfiguration.js';
import { setExtensionPath } from '../../handlers/handler_shared.js';
import { AnthropicHandler } from '../../handlers/anthropic-handler.js';
import { waitForImpl } from '../wait-for-tool.js';
import { projectQueueItem } from '../prompt-queue-tools.js';
import { summarizeQueue } from '../../utils/windowActivity.js';
import { WAIT_RESUME_NOTE } from '../../utils/waitFor.js';

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

/** Each send: its options, the tool's answer when its prompt asks to wait, and the function that ends its turn. */
interface Send { opts: Json; tool?: Promise<string>; finish(text?: string): void }
const sends: Send[] = [];
/** How long a prompt saying `please wait` waits, in minutes. */
let waitMinutes = 60;
handler.sendMessage = (opts: Json) => new Promise((resolve) => {
    const send: Send = { opts, finish: (text?: string) => resolve({ text: text ?? 'done', turnsUsed: 1, toolCallCount: 1 }) };
    // The turn calls the tool here, inside the item's dispatch (runAsQueueItem), as a real turn's tool call would.
    if (String(opts.userText).includes('please wait')) {
        send.tool = waitForImpl({ reason: 'pub.dev limit: 12 versions in 24 h', minutes: waitMinutes, details: 'the oldest of the 12 is a day old then' });
    }
    sends.push(send);
});
const last = (): Send => sends[sends.length - 1];
const statusOf = (item: QueuedPrompt): string | undefined => queue().getById(item.id)?.status;
function queueFileText(id: string): string {
    const found: string[] = [];
    const walk = (dir: string): void => {
        for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
            const p = path.join(dir, e.name);
            if (e.isDirectory()) { walk(p); } else if (/\.ya?ml$/.test(e.name)) {
                const text = fs.readFileSync(p, 'utf8');
                if (text.includes(id)) { found.push(text); }
            }
        }
    };
    walk(SANDBOX);
    return found.join('\n');
}
const add = (text: string, status: 'staged' | 'pending' = 'staged'): Promise<QueuedPrompt> =>
    queue().enqueue({ originalText: text, transport: 'anthropic', anthropicProfileId: 'sdk', deferSend: true, initialStatus: status } as never);
function clean(): void {
    queue().autoSendEnabled = false;
    for (const i of [...queue().items]) { queue().remove(i.id); }
    sends.length = 0;
}

describe('a queue turn waiting in tomAi_waitFor', () => {
    test('QF-1: shown on the item, ends by itself', async () => {
        clean();
        queue().setDefaultTransport('anthropic', 'sdk');
        waitMinutes = 0.01; // 600 ms
        const item = await add('publish, please wait');
        void queue().sendNow(item.id);
        await wait(150);
        const state = queue().waitForOf(item.id);
        assert.equal(state?.reason, 'pub.dev limit: 12 versions in 24 h');
        assert.ok(Date.parse(state!.until) > Date.now());
        const file = queueFileText(item.id);
        assert.match(file, /waiting-for:/);
        assert.match(file, /reason: "?pub\.dev limit/);
        assert.equal(projectQueueItem(queue().getById(item.id)!).waitingFor?.reason, state?.reason, 'tomAi_listQueue');
        assert.equal(summarizeQueue({ items: queue().items, autoSend: false }).sending?.waitingFor?.reason, state?.reason, 'the window status');
        const answer = JSON.parse(await last().tool!);
        assert.equal(answer.outcome, 'elapsed');
        assert.equal(queue().waitForOf(item.id), undefined, 'the wait is over');
        assert.doesNotMatch(queueFileText(item.id), /waiting-for:/);
        last().finish();
        await wait(150);
        assert.equal(statusOf(item), 'sent');
    });

    test('QF-2: interrupt and move on', async () => {
        clean();
        waitMinutes = 60;
        queue().autoSendEnabled = true;
        const a = await add('publish a, please wait');
        void queue().sendNow(a.id);
        await wait(150);
        const b = await add('b goes on', 'pending');
        await wait(100);
        assert.equal(statusOf(a), 'sending');
        assert.equal(statusOf(b), 'pending', 'the lane is held by the waiting turn');
        assert.ok(queue().waitForOf(a.id));
        assert.equal(queue().interruptWaitFor(a.id), true);
        const answer = JSON.parse(await sends[0].tool!);
        assert.equal(answer.outcome, 'interrupted');
        assert.match(answer.message, /End your turn now/);
        sends[0].finish('Waited for pub.dev; still to do: publish a.');
        await wait(200);
        const ids = queue().items.map((i) => i.id);
        assert.ok(ids.indexOf(a.id) > ids.indexOf(b.id), 'a stepped back behind b');
        assert.equal(queue().getById(a.id)?.resumeAfterWait, true);
        assert.match(queueFileText(a.id), /resume-after-wait: true/);
        assert.equal(statusOf(b), 'sending', 'b goes first');
        assert.equal(statusOf(a), 'pending');
        last().finish();
        await wait(250);
        assert.equal(statusOf(b), 'sent');
        assert.equal(statusOf(a), 'sending', 'a runs again');
        assert.ok(String(last().opts.userText).startsWith(WAIT_RESUME_NOTE), 'its stage is sent again with the note');
        assert.equal(queue().getById(a.id)?.resumeAfterWait, undefined);
        assert.equal(queue().interruptWaitFor(b.id), false, 'b does not wait');
        // The resent stage waits again (its prompt still says so); this time it runs to its end.
        assert.equal(queue().interruptWaitFor(a.id), true);
        await last().tool;
        last().finish('note again');
        await wait(250);
        assert.equal(statusOf(a), 'staged', 'nothing followed in its lane this time');
        queue().autoSendEnabled = false;
    });

    test('QF-3: nothing follows — held as staged, then resumed', async () => {
        clean();
        waitMinutes = 60;
        const item = await add('alone, please wait');
        void queue().sendNow(item.id);
        await wait(150);
        assert.equal(queue().interruptWaitFor(item.id), true);
        await last().tool;
        last().finish('still to do: the publish');
        await wait(200);
        assert.equal(statusOf(item), 'staged');
        assert.equal(queue().getById(item.id)?.resumeAfterWait, true);
        waitMinutes = 0.005;
        void queue().sendNow(item.id);
        await wait(150);
        assert.ok(String(last().opts.userText).startsWith(WAIT_RESUME_NOTE));
        await last().tool;
        last().finish();
        await wait(200);
        assert.equal(statusOf(item), 'sent');
    });

    test('QF-4: Continue on a waiting item', async () => {
        clean();
        waitMinutes = 60;
        const shown: unknown[][] = [];
        let pick: string | undefined;
        const win = vscodeStub.stub.window as Json;
        const original = win.showWarningMessage;
        win.showWarningMessage = (...args: unknown[]) => { shown.push(args); return Promise.resolve(pick); };
        try {
            const item = await add('continue me, please wait');
            void queue().sendNow(item.id);
            await wait(150);
            pick = 'Keep waiting';
            await continueWithChoice(queue(), item.id);
            assert.deepEqual(shown[0].slice(2), ['Keep waiting', 'Interrupt the wait and move on', 'Resend this stage', 'Skip to the next stage']);
            assert.match(String(shown[0][0]), /waiting: pub\.dev limit: 12 versions in 24 h — until (?:[A-Z][a-z]{2} )?\d\d:\d\d \(59 min left\)/);
            assert.ok(queue().waitForOf(item.id), 'Keep waiting changes nothing');
            pick = 'Interrupt the wait and move on';
            await continueWithChoice(queue(), item.id);
            assert.equal(JSON.parse(await last().tool!).outcome, 'interrupted');
            last().finish('note');
            await wait(200);
            assert.equal(statusOf(item), 'staged');
        } finally {
            win.showWarningMessage = original;
        }
    });

    test('QF-5: Stop cancels the wait', async () => {
        clean();
        waitMinutes = 60;
        const item = await add('stop me, please wait');
        void queue().sendNow(item.id);
        await wait(150);
        assert.ok(queue().waitForOf(item.id));
        assert.equal(queue().stopActiveItem(item.id), true);
        const answer = JSON.parse(await last().tool!);
        assert.equal(answer.outcome, 'cancelled');
        assert.equal(queue().getById(item.id)?.waitingFor, undefined);
        last().finish();
        await wait(150);
    });
});
