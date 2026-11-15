/**
 * Interrupt for continuation, soft first (vscimpb112), through the real queue manager, the real SoftInterruptRegistry
 * and AskUserRegistry and the queue editor's Continue dialog under the vscode stub. Only the transport is a stub:
 * `AnthropicHandler.sendMessage` runs a scripted turn whose tool results pass the registry's hold point from inside
 * the item's dispatch, as the hold points of the real transports do (handlers/__tests__/softInterrupt-direct.test.ts
 * tests those).
 *
 *   SQ-1  the button holds the next tool result: the result is not returned until release, the item stays sending,
 *         held at the tool, its run paused; re-enabling auto-send (setRunAutoSend, what Telegram's `continue` calls)
 *         releases it and the turn goes on — nothing resent
 *   SQ-2  nothing held within the wait (shortened from 15 s): the hard interrupt — the turn is cancelled, the item
 *         interrupted, its run paused; resume resends with RESEND_INTERRUPTED_NOTE in the conversation the turn ran in
 *   SQ-3  a second click: the hard interrupt now; held, the resend also carries the held result
 *   SQ-4  the turn ends within the wait: the stage is done, the run stays paused, nothing held or resent
 *   SQ-5  a held Agent SDK turn lost (its process ended): interrupted, run paused; the resend carries the note, the
 *         held result and the turn's conversation
 *   SQ-6  a held direct-API turn lost: the conversation was saved; resume continues it exactly — no resend, no note
 *   SQ-7  a Copilot item: the hard interrupt at once
 *   SQ-8  a turn waiting in a question counts as held; the answer given while held is kept until Resume
 *   SQ-9  a turn waiting in tomAi_waitFor counts as held
 *   SQ-10 between two stages: the button only pauses the run; the next stage goes out on resume
 *   SQ-11 Continue on a held item offers Resume and Hard interrupt only; Resume releases it (auto-send back on);
 *         Hard interrupt interrupts it
 *   SQ-12 a reload while soft-interrupted: crash recovery makes the item interrupted with the note and pauses its run
 *   SQ-13 Move back to Staged on an interrupted item: a fresh restart, the note and the held result dropped
 */

/* eslint-disable @typescript-eslint/naming-convention -- config keys */
import test, { after, describe } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'fs';
import * as path from 'path';

const EXT_ROOT = path.resolve(__dirname, '..', '..', '..');
const SANDBOX = fs.realpathSync(fs.mkdtempSync(path.join(EXT_ROOT, '..', '..', '..', 'ztmp', 'vscode_extension_261115_vscimpb112_soft-')));
const WS = path.join(SANDBOX, 'ws');
const HOME = path.join(SANDBOX, 'home');
const QUEST = 'q1';
const QDIR = path.join(WS, '_ai', 'quests', QUEST);
fs.mkdirSync(QDIR, { recursive: true });
fs.writeFileSync(path.join(QDIR, `overview.${QUEST}.md`), '# Q1\n');
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
import { ReminderSystem } from '../../managers/reminderSystem.js';
import { TimerEngine } from '../../managers/timerEngine.js';
import { PromptQueueManager, type QueuedPrompt } from '../../managers/promptQueueManager.js';
import { TomAiConfiguration } from '../../utils/tomAiConfiguration.js';
import { setExtensionPath } from '../../handlers/handler_shared.js';
import { AnthropicHandler } from '../../handlers/anthropic-handler.js';
import { AskUserRegistry } from '../../services/askUserRegistry.js';
import { SoftInterruptRegistry, type HoldRelease } from '../../services/softInterrupt.js';
import { currentQueueItemId } from '../../services/userWaits.js';
import { continueWithChoice } from '../../handlers/queueEditor-handler.js';
import { RESEND_INTERRUPTED_NOTE } from '../../utils/pendingQuestion.js';

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
const win = vscodeStub.stub.window as Json;
const soft = SoftInterruptRegistry.instance;
after(() => {
    handler.sendMessage = originalSend;
    AskUserRegistry.instance.cancel('test over');
    for (const stop of [() => PromptQueueManager.instance.dispose(), () => TimerEngine.instance.dispose(), () => ReminderSystem.instance.dispose()]) {
        try { stop(); } catch { /* not started */ }
    }
    for (const s of subscriptions.splice(0)) { try { s.dispose(); } catch { /* already gone */ } }
    vscodeStub.restore();
    fs.rmSync(SANDBOX, { recursive: true, force: true });
});

const queue = (): PromptQueueManager => PromptQueueManager.instance;
const wait = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/** A scripted turn: its options, whether it was cancelled, and its controls. */
interface Turn {
    opts: Json;
    text: string;
    cancelled: boolean;
    end(answer: string): void;
    fail(err: Error): void;
    /** A tool call of the turn: its result passes the hold point (as the real transports' hold points do). */
    tool(name: string, result: string, extras?: Json): Promise<HoldRelease>;
    /** The answer a question of the turn received (after its hold point). */
    answer?: string;
}
const turns: Turn[] = [];
handler.sendMessage = (opts: Json) => new Promise((resolve, reject) => {
    const itemId = currentQueueItemId();
    let ended = false;
    const turn: Turn = {
        opts,
        text: String(opts.userText),
        cancelled: false,
        end: (answer) => { if (!ended) { ended = true; resolve({ text: answer, turnsUsed: 1, toolCallCount: 1 }); } },
        fail: (err) => { if (!ended) { ended = true; reject(err); } },
        tool: (name, result, extras) => soft.holdAt(itemId, name, result, extras),
    };
    opts.cancellationToken?.onCancellationRequested(() => { turn.cancelled = true; setTimeout(() => turn.end('the turn was cancelled'), 20); });
    // The conversation the turn runs in, at its first message.
    opts.onTurnSessionId?.(`sid-${turns.length + 1}`);
    if (turn.text.includes('ASK')) {
        // tomAi_askUser from inside the item's dispatch; its answer then passes the hold point.
        void AskUserRegistry.instance.begin({ questions: ['Which order?'], fallbackPrompt: 'fallback', onOpen: () => undefined, onResolve: () => undefined })
            .then(async (answer) => {
                const released = await soft.holdAt(itemId, 'tomAi_askUser', answer);
                turn.answer = answer;
                if (!released.aborted) { turn.end(`answered: ${answer}`); }
            });
    }
    turns.push(turn);
});

function reset(): void {
    queue().autoSendEnabled = false;
    AskUserRegistry.instance.cancel('reset');
    for (const i of [...queue().items]) { queue().remove(i.id); }
    turns.length = 0;
    soft.timeoutMs = 15_000;
}
const live = (item: QueuedPrompt): QueuedPrompt => queue().getById(item.id) as QueuedPrompt;
async function startItem(text: string, extra: Record<string, unknown> = {}): Promise<QueuedPrompt> {
    reset();
    const item = await queue().enqueue({ originalText: text, transport: 'anthropic', anthropicProfileId: 'sdk', deferSend: true, initialStatus: 'pending', ...extra } as never);
    queue().autoSendEnabled = true;
    await wait(150);
    assert.equal(turns.length, 1, 'its turn runs');
    return item;
}

describe('interrupt for continuation — soft first', () => {
    test('setup', () => {
        queue().autoSendEnabled = false;
        queue().setDefaultTransport('anthropic', 'sdk');
    });

    test('SQ-1: the next tool result is held until release', async () => {
        const item = await startItem('task one');
        assert.equal(queue().interruptActiveItemForContinuation(item.id), true);
        assert.equal(queue().autoSendEnabled, false, 'the run paused');
        assert.equal(queue().softInterruptOf(item.id)?.heldAt, undefined, 'requested, not held yet');
        let released: HoldRelease | undefined;
        void turns[0].tool('Bash', 'built').then((r) => { released = r; });
        await wait(50);
        assert.equal(released, undefined, 'the tool result is not returned');
        assert.equal(live(item).status, 'sending');
        assert.equal(live(item).softInterrupt?.tool, 'Bash');
        assert.equal(live(item).softInterrupt?.heldResult, 'built');
        assert.equal(typeof live(item).softInterrupt?.heldAt, 'number');
        // What Telegram's `continue` calls (telegram-commands.ts setRunning): the run's auto-send back on.
        queue().setRunAutoSend(undefined, true);
        await wait(50);
        assert.deepEqual(released, {}, 'released (held under a minute)');
        assert.equal(live(item).softInterrupt, undefined);
        turns[0].end('done');
        await wait(150);
        assert.equal(turns.length, 1, 'nothing resent');
        assert.equal(live(item).status, 'sent');
    });

    test('SQ-2: no hold point within the wait — the hard interrupt, resent with the note in the same conversation', async () => {
        const item = await startItem('task two');
        soft.timeoutMs = 120;
        queue().interruptActiveItemForContinuation(item.id);
        await wait(300);
        assert.equal(turns[0].cancelled, true, 'the turn was cancelled');
        assert.equal(live(item).status, 'interrupted');
        assert.equal(live(item).interruptNote, true);
        assert.equal(queue().autoSendEnabled, false);
        queue().autoSendEnabled = true;
        await wait(150);
        assert.equal(turns.length, 2, 'resent');
        assert.ok(turns[1].text.startsWith(RESEND_INTERRUPTED_NOTE), turns[1].text);
        assert.match(turns[1].text, /task two$/);
        assert.equal(turns[1].opts.continueSessionId, 'sid-1', 'the conversation the turn ran in');
        assert.equal(live(item).interruptNote, undefined);
        turns[1].end('done');
        await wait(150);
        assert.equal(live(item).status, 'sent');
    });

    test('SQ-3: a second click — the hard interrupt now, the held result with the resend', async () => {
        const item = await startItem('task three');
        queue().interruptActiveItemForContinuation(item.id);
        void turns[0].tool('Read', 'line 1');
        await wait(30);
        assert.equal(queue().interruptActiveItemForContinuation(), true, 'the toolbar\'s second click');
        assert.equal(live(item).status, 'interrupted');
        assert.equal(turns[0].cancelled, true);
        queue().autoSendEnabled = true;
        await wait(150);
        assert.match(turns[1].text, new RegExp(`^${RESEND_INTERRUPTED_NOTE.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\n\\nThe result of your last tool call Read was: line 1\\n\\ntask three$`));
        turns[1].end('done');
        await wait(150);
    });

    test('SQ-4: the turn ends within the wait — the stage is done, the run stays paused', async () => {
        const item = await startItem('task four');
        queue().interruptActiveItemForContinuation(item.id);
        turns[0].end('finished by itself');
        await wait(150);
        assert.equal(live(item).status, 'sent', 'the stage is done');
        assert.equal(live(item).softInterrupt, undefined);
        assert.equal(soft.stateOf(item.id), undefined, 'nothing held');
        assert.equal(queue().autoSendEnabled, false, 'the run stays paused');
        assert.equal(turns.length, 1, 'nothing resent');
    });

    test('SQ-5: a held Agent SDK turn lost — resent with the note, the held result and its conversation', async () => {
        const item = await startItem('task five');
        queue().interruptActiveItemForContinuation(item.id);
        void turns[0].tool('Bash', 'compiled');
        await wait(30);
        turns[0].fail(new Error('Claude Code process exited with code 1'));
        await wait(100);
        assert.equal(live(item).status, 'interrupted');
        assert.equal(live(item).interruptNote, true);
        assert.equal(live(item).softInterrupt?.heldResult, 'compiled');
        assert.equal(queue().autoSendEnabled, false);
        queue().autoSendEnabled = true;
        await wait(150);
        assert.ok(turns[1].text.startsWith(RESEND_INTERRUPTED_NOTE));
        assert.match(turns[1].text, /The result of your last tool call Bash was: compiled/);
        assert.equal(turns[1].opts.continueSessionId, 'sid-1');
        turns[1].end('done');
        await wait(150);
    });

    test('SQ-6: a held direct-API turn lost — its saved conversation continues, no resend', async () => {
        const item = await startItem('task six');
        queue().interruptActiveItemForContinuation(item.id);
        const messages = [{ role: 'user', content: 'task six' }, { role: 'assistant', content: [{ type: 'tool_use', id: 't1', name: 'tomAi_echo', input: {} }] }, { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't1', content: 'echo' }] }];
        void turns[0].tool('tomAi_echo', 'echo', { conversation: { transport: 'direct', messages } });
        await wait(50);
        const file = live(item).heldConversationFile;
        assert.ok(file && fs.existsSync(file), 'the conversation is saved');
        turns[0].fail(new Error('extension host restarted'));
        await wait(100);
        assert.equal(live(item).status, 'interrupted');
        assert.ok(fs.existsSync(file!), 'kept for the resume');
        queue().autoSendEnabled = true;
        await wait(150);
        assert.deepEqual(turns[1].opts.resumeConversation, { transport: 'direct', messages }, 'held under a minute: as saved');
        assert.equal(turns[1].text, 'task six', 'no note: the turn goes on, nothing is resent to it');
        assert.equal(turns[1].opts.continueSessionId, undefined);
        turns[1].end('done');
        await wait(150);
        assert.equal(fs.existsSync(file!), false, 'used up once the continued turn ended');
        assert.equal(live(item).heldConversationFile, undefined);
    });

    test('SQ-7: a Copilot item — the hard interrupt at once', async () => {
        const item = await startItem('task seven');
        live(item).lastDispatched = { ...live(item).lastDispatched!, transport: 'copilot' };
        assert.equal(queue().interruptActiveItemForContinuation(item.id), true);
        assert.equal(live(item).status, 'interrupted');
        assert.equal(soft.stateOf(item.id), undefined, 'no soft interrupt');
        await wait(60);
        reset();
    });

    test('SQ-8: a question counts as held; its answer is kept until Resume', async () => {
        const item = await startItem('task ASK');
        await wait(30);
        assert.ok(AskUserRegistry.instance.pendingForQueueItem(item.id), 'the turn waits in a question');
        queue().interruptActiveItemForContinuation(item.id);
        assert.equal(live(item).softInterrupt?.kind, 'question', 'held at once');
        assert.equal(queue().autoSendEnabled, false);
        const pending = AskUserRegistry.instance.pendingForQueueItem(item.id)!;
        assert.equal(AskUserRegistry.instance.submit(pending.requestId, 'alphabetical', 'vscode'), true, 'the answer is accepted');
        await wait(50);
        assert.equal(turns[0].answer, undefined, 'and kept');
        assert.equal(live(item).softInterrupt?.tool, 'tomAi_askUser');
        queue().autoSendEnabled = true;
        await wait(150);
        assert.equal(turns[0].answer, 'alphabetical', 'Resume hands it to the turn');
        assert.equal(live(item).status, 'sent');
    });

    test('SQ-9: a turn in tomAi_waitFor counts as held', async () => {
        const item = await startItem('task nine');
        live(item).waitingFor = { reason: 'pub.dev limit', until: new Date(Date.now() + 600_000).toISOString(), since: new Date().toISOString() } as never;
        queue().interruptActiveItemForContinuation(item.id);
        assert.equal(soft.stateOf(item.id)?.kind, 'wait');
        assert.equal(soft.stateOf(item.id)?.tool, 'tomAi_waitFor');
        delete live(item).waitingFor;
        queue().autoSendEnabled = true;
        await wait(30);
        turns[0].end('done');
        await wait(150);
    });

    test('SQ-10: between two stages the button only pauses the run', async () => {
        const item = await startItem('first stage', { followUps: [{ originalText: 'second stage' }] });
        queue().autoSendEnabled = false;
        turns[0].end('stage one done');
        await wait(150);
        assert.equal(live(item).status, 'sending', 'between two stages, its run paused');
        assert.equal(queue().interruptActiveItemForContinuation(item.id), true);
        assert.equal(live(item).status, 'sending', 'not interrupted');
        assert.equal(soft.stateOf(item.id), undefined, 'no soft interrupt: no turn runs');
        assert.equal(live(item).interruptNote, undefined);
        assert.equal(queue().autoSendEnabled, false, 'the run paused');
        queue().autoSendEnabled = true;
        await wait(150);
        assert.equal(turns.length, 2, 'the next stage goes out on resume');
        assert.match(turns[1].text, /second stage/);
        turns[1].end('done');
        await wait(150);
    });

    test('SQ-11: Continue on a held item — Resume and Hard interrupt', async () => {
        const item = await startItem('task eleven');
        queue().interruptActiveItemForContinuation(item.id);
        void turns[0].tool('Bash', 'x');
        await wait(30);
        const shown: Json[] = [];
        const original = win.showWarningMessage;
        win.showWarningMessage = async (...args: Json[]) => { shown.push(args); return 'Resume'; };
        try { await continueWithChoice(queue(), item.id); } finally { win.showWarningMessage = original; }
        assert.deepEqual(shown[0].slice(2), ['Resume', 'Hard interrupt'], 'no Stop');
        assert.equal(queue().autoSendEnabled, true, 'Resume: auto-send back on');
        assert.equal(soft.stateOf(item.id), undefined, 'released');
        turns[0].end('done');
        await wait(150);

        const second = await startItem('task eleven b');
        queue().interruptActiveItemForContinuation(second.id);
        win.showWarningMessage = async () => 'Hard interrupt';
        try { await continueWithChoice(queue(), second.id); } finally { win.showWarningMessage = original; }
        assert.equal(live(second).status, 'interrupted');
        await wait(60);
    });

    test('SQ-13: Move back to Staged drops what the interrupt recorded', async () => {
        const item = await startItem('task thirteen');
        queue().interruptActiveItemForContinuation(item.id, undefined, { hard: true });
        assert.equal(live(item).interruptNote, true);
        assert.equal(queue().setStatus(item.id, 'staged'), true);
        assert.equal(live(item).interruptNote, undefined, 'a fresh restart carries no note');
        assert.equal(live(item).softInterrupt, undefined);
        await wait(60);
    });

    test('SQ-12: a reload while soft-interrupted', () => {
        reset();
        queue().autoSendEnabled = true;
        const leftover: Json = { id: 'x1', status: 'sending', softInterrupt: { requestedAt: Date.now(), heldAt: Date.now(), kind: 'tool', tool: 'Bash', heldResult: 'r' }, lastDispatched: { kind: 'main', expandedText: 't', transport: 'anthropic' } };
        const q = queue() as Json;
        q._applyCrashRecoveryTo([leftover]);
        assert.equal(leftover.status, 'interrupted');
        assert.equal(leftover.interruptNote, true);
        assert.equal(leftover.softInterrupt.heldResult, 'r', 'kept for the resend');
        q._pauseLostSoftRuns();
        assert.equal(queue().autoSendEnabled, false, 'its run stays paused');
    });
});
