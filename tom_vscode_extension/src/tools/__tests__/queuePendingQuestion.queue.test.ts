/**
 * A queue item whose turn waits for the user's answer (vscimpb55), through the real queue manager, the real
 * AskUserRegistry, the real question panel handler and the queue editor's Continue dialog under the vscode stub.
 * Only the transport is a stub: `AnthropicHandler.sendMessage` asks through the registry from inside the item's
 * dispatch, as tomAi_askUser does, and waits for the answer; on cancel it ends normally (the Agent SDK's way).
 * Measured in the d4rt window: a walk's question waited 9 h 25 min with its tab closed, nothing showed it, and
 * Continue dropped it ('Answered via cancel').
 *
 *   QW-0 @T: Show Pending Question is registered, and its status-bar entry shows while a question waits (it runs
 *        the command) and hides once it is answered
 *   QW-1 the item knows its question (since when); the question can be opened again after its tab was closed (its
 *        panel instrumented for the debug log; shown again, the open panel comes to the front), and
 *        the answer given there reaches the turn, which goes on — the walk then finishes, each todo once
 *   QW-2 Continue's Skip closes the question with a note the turn receives, and sends exactly the next todo
 *   QW-3 Resend of a stage waiting in a question: the question is closed with a note, the same todo is sent again
 *        with the interruption note (not recorded as its text), the old turn's end sends nothing, one live turn
 *   QW-4 Resend of a running stage without a question: the same, and the walk finishes
 *   QW-5 Stop closes the question with a note
 *   QW-6 the Continue dialog: Answer now only while waiting (it opens the question), Resend and Skip always,
 *        Cancel does nothing
 */

/* eslint-disable @typescript-eslint/naming-convention -- config keys */
import test, { after, describe } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'fs';
import * as path from 'path';

const EXT_ROOT = path.resolve(__dirname, '..', '..', '..');
const SANDBOX = fs.realpathSync(fs.mkdtempSync(path.join(EXT_ROOT, '..', '..', '..', 'ztmp', 'vscode_extension_261112_vscimpb55_question-')));
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
import { TomAiConfiguration } from '../../utils/tomAiConfiguration.js';
import { setExtensionPath } from '../../handlers/handler_shared.js';
import { AnthropicHandler } from '../../handlers/anthropic-handler.js';
import { AskUserRegistry } from '../../services/askUserRegistry.js';
import { initPendingQuestionUi, openAskPanelIds, showPendingQuestion, SHOW_PENDING_QUESTION_COMMAND } from '../../handlers/askUser-handler.js';
import { continueWithChoice } from '../../handlers/queueEditor-handler.js';
import { QUESTION_CLOSED_BY_RESEND, QUESTION_CLOSED_BY_SKIP, QUESTION_CLOSED_BY_STOP, RESEND_INTERRUPTED_NOTE } from '../../utils/pendingQuestion.js';

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
const cmds = vscodeStub.stub.commands as Json;
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
const registry = (): AskUserRegistry => AskUserRegistry.instance;
const wait = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/** The turns sent, the ones running (not cancelled), the answers the question tool received. */
const sent: string[] = [];
const running: Array<() => void> = [];
const toolAnswers: string[] = [];
/** Todos whose first turn asks a question (a resent turn does not ask again). */
const asks = new Set<string>();
let inFlight = 0;
let maxInFlight = 0;
handler.sendMessage = (opts: Json) => new Promise((resolve) => {
    const text = String(opts.userText);
    sent.push(text);
    inFlight++;
    maxInFlight = Math.max(maxInFlight, inFlight);
    let live = true;
    let ended = false;
    const stopCounting = (): void => { if (live) { live = false; inFlight--; } };
    const end = (answer: string): void => {
        if (ended) { return; }
        ended = true;
        stopCounting();
        resolve({ text: answer, turnsUsed: 1, toolCallCount: 1 });
    };
    opts.cancellationToken?.onCancellationRequested(() => { stopCounting(); setTimeout(() => end('the turn was cancelled'), 30); });
    const todo = /(\w+_x)/.exec(text)?.[1] ?? '';
    if (asks.delete(todo)) {
        // tomAi_askUser: asked from inside the item's dispatch, waiting for the answer.
        void registry().begin({ questions: ['Which order?'], fallbackPrompt: 'fallback', onOpen: () => undefined, onResolve: () => undefined })
            .then((answer) => { toolAnswers.push(answer); end(`answered: ${answer}`); });
    } else {
        running.push(() => end(`done: ${todo}`));
    }
});
async function finishTurn(): Promise<void> {
    const next = running.shift();
    assert.ok(next, 'a turn is running');
    next();
    await wait(150);
}
function reset(): void {
    queue().autoSendEnabled = false;
    registry().cancel('reset');
    for (const i of [...queue().items]) { queue().remove(i.id); }
    sent.length = 0;
    running.length = 0;
    toolAnswers.length = 0;
    asks.clear();
    inFlight = 0;
    maxInFlight = 0;
}
const todoIds = (): string[] => sent.map((t) => /(\w+_x)/.exec(t)?.[1] ?? t);
const live = (item: QueuedPrompt): QueuedPrompt => queue().getById(item.id) as QueuedPrompt;
async function startWalk(prefix: string, asking: string[]): Promise<QueuedPrompt> {
    reset();
    writeTodos(prefix, 3);
    for (const a of asking) { asks.add(a); }
    const item = await queue().enqueue({ originalText: 'work on ${repeatTodoId}', repeatCount: `${prefix}*`, transport: 'anthropic', anthropicProfileId: 'sdk', session: `s-${prefix}`, deferSend: true, initialStatus: 'pending' } as never);
    queue().autoSendEnabled = true;
    await wait(200);
    return item;
}

describe('a queue item waiting for an answer', () => {
    test('setup', () => {
        queue().autoSendEnabled = false;
        queue().setDefaultTransport('anthropic', 'sdk');
    });

    test('QW-0: the command and the status-bar entry', async () => {
        const registered: string[] = [];
        const items: Json[] = [];
        const createItem = win.createStatusBarItem;
        const register = cmds.registerCommand;
        win.createStatusBarItem = () => {
            const item: Json = { text: '', tooltip: '', visible: false, show() { item.visible = true; }, hide() { item.visible = false; }, dispose() { /* none */ } };
            items.push(item);
            return item;
        };
        cmds.registerCommand = (id: string) => { registered.push(id); return { dispose: () => undefined }; };
        const ctx = { subscriptions: [] as Array<{ dispose(): void }> };
        try {
            initPendingQuestionUi(ctx as never);
        } finally {
            win.createStatusBarItem = createItem;
            cmds.registerCommand = register;
        }
        assert.deepEqual(registered, [SHOW_PENDING_QUESTION_COMMAND]);
        const status = items[0];
        assert.equal(status.command, SHOW_PENDING_QUESTION_COMMAND);
        assert.equal(status.visible, false, 'nothing waits');
        const item = await startWalk('qz', ['qz1_x']);
        assert.equal(status.visible, true, 'a question waits');
        assert.match(String(status.tooltip), /waits for your answer since \d\d:\d\d/);
        assert.equal(registry().submit(registry().getPending()!.requestId, 'ok', 'vscode'), true);
        await wait(150);
        assert.equal(status.visible, false, 'answered');
        for (const d of ctx.subscriptions) { d.dispose(); }
        queue().remove(item.id);
        reset();
    });

    test('QW-1: found again after its tab was closed, and answered there', async () => {
        const item = await startWalk('qa', ['qa1_x']);
        const question = queue().pendingQuestionOf(item.id);
        assert.ok(question, 'the item knows the question its turn waits in');
        assert.equal(typeof question.askedAt, 'number');
        assert.deepEqual(queue().waitingForUserOf(item.id), ['question']);
        assert.equal(registry().getPending()?.queueItemId, item.id);
        // No panel is open (the stub turn opened none, as after a closed tab): showing it opens one.
        assert.deepEqual(openAskPanelIds(), []);
        const panels: Json[] = [];
        const createPanel = win.createWebviewPanel;
        win.createWebviewPanel = (...args: unknown[]) => { const p = createPanel(...args); panels.push(p); return p; };
        try {
            assert.equal(showPendingQuestion(), true);
        } finally {
            win.createWebviewPanel = createPanel;
        }
        assert.deepEqual(openAskPanelIds(), [question.requestId], 'a panel for the pending question');
        assert.equal(panels[0]?.webview?.[Symbol.for('tomAi.webviewMessagesInstrumented')], true, 'its messages go to the debug log');
        assert.equal(showPendingQuestion(), true, 'shown again: the open panel comes to the front');
        assert.equal(panels.length, 1, 'no second panel');
        // The answer given there (the panel's submit goes to the registry) reaches the turn.
        assert.equal(registry().submit(question.requestId, 'B before A', 'vscode'), true);
        await wait(200);
        assert.deepEqual(toolAnswers, ['B before A']);
        assert.equal(queue().pendingQuestionOf(item.id), undefined, 'no longer waiting');
        assert.deepEqual(todoIds(), ['qa1_x', 'qa2_x'], 'the turn went on with the answer, then the next todo');
        await finishTurn();
        await finishTurn();
        assert.equal(live(item).status, 'sent');
        assert.deepEqual(todoIds(), ['qa1_x', 'qa2_x', 'qa3_x']);
        assert.equal(maxInFlight, 1);
    });

    test('QW-2: Skip closes the question with a note and sends exactly the next todo', async () => {
        const item = await startWalk('qb', ['qb1_x']);
        assert.ok(queue().pendingQuestionOf(item.id));
        const continued = queue().continueSending(item.id);
        await wait(300);
        assert.deepEqual(toolAnswers, [QUESTION_CLOSED_BY_SKIP], 'the turn is told the question was closed');
        assert.equal(registry().hasPending(), false);
        assert.deepEqual(todoIds(), ['qb1_x', 'qb2_x']);
        await finishTurn();
        await finishTurn();
        assert.equal(await continued, true);
        assert.equal(live(item).status, 'sent');
        assert.equal(sent.length, 3);
        assert.equal(maxInFlight, 1);
    });

    test('QW-3: Resend of a stage waiting in a question', async () => {
        const item = await startWalk('qc', ['qc1_x']);
        assert.ok(queue().pendingQuestionOf(item.id));
        const resent = queue().resendSendingStage(item.id);
        await wait(300);
        assert.deepEqual(toolAnswers, [QUESTION_CLOSED_BY_RESEND]);
        assert.deepEqual(todoIds(), ['qc1_x', 'qc1_x'], 'the same todo again, nothing else');
        assert.ok(sent[1].startsWith(RESEND_INTERRUPTED_NOTE), 'the agent is told its turn was interrupted');
        assert.equal(inFlight, 1);
        assert.ok(!live(item).lastDispatched?.expandedText.includes(RESEND_INTERRUPTED_NOTE), 'the note is not recorded as the stage text');
        await finishTurn();
        const kept = (live(item).repetitionAnswers ?? []).find((a) => a.key === 'qc1_x');
        assert.equal(kept?.text, 'done: qc1_x', 'the resent turn\'s answer, not the cancelled one\'s');
        assert.deepEqual(todoIds(), ['qc1_x', 'qc1_x', 'qc2_x']);
        await finishTurn();
        await finishTurn();
        await resent;
        assert.equal(live(item).status, 'sent');
        assert.equal(maxInFlight, 1);
    });

    test('QW-4: Resend of a running stage without a question', async () => {
        const item = await startWalk('qd', []);
        running.shift(); // that turn only ends by the cancel now
        const resent = queue().resendSendingStage(item.id);
        await wait(300);
        assert.deepEqual(todoIds(), ['qd1_x', 'qd1_x']);
        assert.equal(inFlight, 1);
        await finishTurn();
        await finishTurn();
        await finishTurn();
        await resent;
        assert.deepEqual(todoIds(), ['qd1_x', 'qd1_x', 'qd2_x', 'qd3_x']);
        assert.equal(live(item).status, 'sent');
        assert.equal(maxInFlight, 1);
        await assert.rejects(queue().resendSendingStage(item.id), /not sending/);
    });

    test('QW-5: Stop closes the question', async () => {
        const item = await startWalk('qe', ['qe1_x']);
        assert.equal(queue().stopActiveItem(item.id), true);
        await wait(200);
        assert.deepEqual(toolAnswers, [QUESTION_CLOSED_BY_STOP]);
        assert.equal(live(item).status, 'staged');
        assert.equal(sent.length, 1);
    });

    test('QW-6: the Continue dialog', async () => {
        const shown: unknown[][] = [];
        const commands: string[] = [];
        let pick: string | undefined;
        win.showWarningMessage = (...args: unknown[]) => { shown.push(args); return Promise.resolve(pick); };
        cmds.executeCommand = (cmd: string) => { commands.push(cmd); return Promise.resolve(undefined); };

        const item = await startWalk('qf', ['qf1_x']);
        // Cancel: nothing happens.
        pick = undefined;
        await continueWithChoice(queue(), item.id);
        assert.deepEqual(shown[0].slice(2), ['Answer now', 'Resend this stage', 'Skip to the next todo'], 'Answer now while waiting');
        assert.match(String(shown[0][0]), /waiting for your answer \(since \d\d:\d\d/);
        assert.equal((shown[0][1] as { modal?: boolean }).modal, true);
        assert.ok(registry().hasPending(), 'still waiting');
        assert.equal(live(item).status, 'sending');
        // Answer now: opens the question, the turn keeps waiting.
        pick = 'Answer now';
        await continueWithChoice(queue(), item.id);
        assert.deepEqual(commands, ['tomAi.showPendingQuestion']);
        assert.ok(registry().hasPending());
        assert.equal(sent.length, 1);
        // Skip: closes the question and goes on.
        pick = 'Skip to the next todo';
        void continueWithChoice(queue(), item.id);
        await wait(300);
        assert.deepEqual(toolAnswers, [QUESTION_CLOSED_BY_SKIP]);
        assert.deepEqual(todoIds(), ['qf1_x', 'qf2_x']);
        // Not waiting: no Answer now; Resend resends the running stage.
        pick = 'Resend this stage';
        void continueWithChoice(queue(), item.id);
        await wait(300);
        assert.deepEqual(shown[3].slice(2), ['Resend this stage', 'Skip to the next todo'], 'Resend and Skip always');
        assert.deepEqual(todoIds(), ['qf1_x', 'qf2_x', 'qf2_x']);
        reset();
    });
});
