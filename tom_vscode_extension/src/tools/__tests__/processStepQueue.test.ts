/**
 * A process step ends with its queue: Proceed queues the step's prompt and a
 * process-move marker, and the process moves on only when the queue reaches
 * the marker with the step's items done (src/utils/processMoveMarker.ts,
 * PromptQueueManager, processActionService). The real queue and process store
 * run under the vscode stub, in a sandbox workspace; nothing is sent to a
 * model — the test sets the items' statuses as their sends would.
 *
 *   PS-1 Proceed queues the prompt and the marker and leaves the state on the step; the step is running
 *        (1 item left); Proceed again is refused while it runs
 *   PS-2 an agent queuing items while the step's prompt runs: they inherit the Proceed run and go before
 *        the marker; an item queued outside the run goes after it
 *   PS-3 the queue reaches the marker while an item of the step still waits: it waits, the state stays;
 *        once all are sent it moves the process (to the decision after a repeatable step) and is sent
 *   PS-4 an item of the step failed: the marker is held (status error), the step shows held, Proceed is
 *        refused; Repeat drops the marker and Proceed queues the step again with a new run the old failed
 *        item does not hold; Move on makes the marker's move and removes it
 *   PS-5 Skip removes the open marker of the quest and moves; a set state (tomAi_setProcessState) too
 *   PS-6 a step Proceed runs with no prompt (a user action) moves at once, no marker
 *   PS-7 the marker's move survives the queue file (`process-move`, `process-run` with its proceedId)
 *   PS-8 conditions (vscimpb36): a step whose `judge:` condition the agent finds false during its Proceed run
 *        (tomAi_setProcessState {leaveOut}) keeps its marker and is left out when the run ends, recorded as the
 *        agent's; Leave out by the user passes an optional step and, by its variable, a conditional one; a
 *        `leaveOut` without a run leaves out at once; where nothing is judged it is refused; a process started
 *        from its beginning passes a first phase its condition excludes
 *   PS-9 custom chat variables (a process's run parameters, a reported TODO) survive a whole run: Proceed and its
 *        marker, a user action, a decision, a gate, a phase move, a process set by the tool, the response values
 *        (vscimpb38)
 */

/* eslint-disable @typescript-eslint/naming-convention -- chat-variable names (`design-mode`, `TODO`) */
import test, { after, describe } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

const SANDBOX = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'process-step-queue-')));
const WS = path.join(SANDBOX, 'ws');
const HOME = path.join(SANDBOX, 'home');
const QUEST = 'q1';
const EXT_ROOT = path.resolve(__dirname, '..', '..', '..');

function put(rel: string, text: string): void {
    const abs = path.join(WS, rel);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, text);
}
put(`_ai/quests/${QUEST}/overview.${QUEST}.md`, '# Quest Overview: Q1\n');
put('_ai/processes/flow/flow.process.yaml', [
    'id: flow',
    'name: Flow',
    'phases:',
    '  - id: build',
    '    name: Build',
    '    steps:',
    '      - id: code',
    '        name: Code',
    '      - id: check',
    '        name: Check',
    '        userAction: true',
    '      - id: review',
    '        name: Review',
    '        repeatable: true',
    '    gate:',
    '      id: gate',
    '      name: Gate',
    '',
].join('\n'));
put('_ai/processes/flow/flow.md', '# Flow\n');
put('_ai/processes/cond/cond.process.yaml', [
    'id: cond',
    'phases:',
    '  - id: pre',
    '    when:',
    '      var: mode',
    '      equals: full',
    '    steps:',
    '      - id: prepare',
    '    gate:',
    '      id: gate',
    '  - id: main',
    '    steps:',
    '      - id: first',
    '      - id: announce',
    '        when:',
    '          judge: the release changes the public API',
    '      - id: extra',
    '        optional: true',
    '      - id: second',
    '        when:',
    '          var: mode',
    '          equals: full',
    '    gate:',
    '      id: gate',
    '',
].join('\n'));
put('_ai/processes/cond/cond.md', '# Cond\n');
put('.tom/tom_vscode_extension.json', '{}\n');
fs.mkdirSync(HOME, { recursive: true });
process.env.HOME = HOME;
process.env.USERPROFILE = HOME;

import { installVscodeStub } from './_vscode-stub.js';
const vscodeStub = installVscodeStub({ workspaceFolders: [WS] });
(vscodeStub.stub.workspace as Record<string, unknown>).workspaceFile = { fsPath: path.join(WS, `${QUEST}.code-workspace`), scheme: 'file' };

import { ChatVariablesStore } from '../../managers/chatVariablesStore.js';
import { ProcessStateStore } from '../../managers/processStateStore.js';
import { ReminderSystem } from '../../managers/reminderSystem.js';
import { TimerEngine } from '../../managers/timerEngine.js';
import { PromptQueueManager, PROCESS_MARKER_HELD_ERROR, parseProcessMove, type QueuedPrompt } from '../../managers/promptQueueManager.js';
import { TomAiConfiguration } from '../../utils/tomAiConfiguration.js';
import { setExtensionPath } from '../../handlers/handler_shared.js';
import { runInProcessPosition } from '../../services/processRunContext.js';
import { confirmProcessAction, dropHeldStep, installProcessMoveMarkers, moveOnFromHeldStep } from '../../services/processActionService.js';
import { SET_PROCESS_STATE_TOOL } from '../quest-process-tools.js';

const subscriptions: Array<{ dispose(): void }> = [];
function start(): void {
    const storage = path.join(SANDBOX, 'storage');
    fs.mkdirSync(storage, { recursive: true });
    const memento = (): unknown => {
        const values = new Map<string, unknown>();
        return { get: (k: string, d?: unknown) => values.has(k) ? values.get(k) : d, update: async (k: string, v: unknown) => { values.set(k, v); }, keys: () => [...values.keys()], setKeysForSync: () => undefined };
    };
    const context = {
        subscriptions,
        extensionPath: EXT_ROOT,
        extensionUri: { fsPath: EXT_ROOT, scheme: 'file' },
        globalStorageUri: { fsPath: storage, scheme: 'file' },
        storageUri: { fsPath: storage, scheme: 'file' },
        logUri: { fsPath: storage, scheme: 'file' },
        globalStoragePath: storage,
        storagePath: storage,
        logPath: storage,
        globalState: memento(),
        workspaceState: memento(),
        asAbsolutePath: (rel: string) => path.join(EXT_ROOT, rel),
    } as never;
    setExtensionPath(EXT_ROOT);
    TomAiConfiguration.init(context);
    ChatVariablesStore.init(context);
    ProcessStateStore.init(context);
    ReminderSystem.init(context);
    TimerEngine.init(context);
    PromptQueueManager.init(context);
    installProcessMoveMarkers();
}
start();
after(() => {
    for (const stop of [() => PromptQueueManager.instance.dispose(), () => TimerEngine.instance.dispose(), () => ReminderSystem.instance.dispose()]) {
        try { stop(); } catch { /* not started */ }
    }
    for (const s of subscriptions.splice(0)) { try { s.dispose(); } catch { /* already gone */ } }
    vscodeStub.restore();
    fs.rmSync(SANDBOX, { recursive: true, force: true });
});

const queue = (): PromptQueueManager => PromptQueueManager.instance;
/**
 * Step the queue by hand with auto-send off: every run's lane takes its next item (the queue's settings are per
 * run and a paused run starts nothing unless forced, as an explicit retry does).
 */
const drive = (): Promise<void> => queue().sendNext(new Set(['default', ...queue().items.map((i) => i.processRun?.run ?? i.run ?? 'default')]));
const store = (): ProcessStateStore => ProcessStateStore.instance!;
const markers = (): QueuedPrompt[] => queue().items.filter((i) => i.processMove);
const set = (id: string, status: QueuedPrompt['status']): void => { (queue().getById(id) as QueuedPrompt).status = status; };
function clearQueue(): void { for (const i of [...queue().items]) { queue().remove(i.id); } }
async function at(step: string): Promise<void> {
    clearQueue();
    const r = store().apply({ process: 'flow', phase: 'build', step }, 'user');
    assert.equal(r.ok, true, JSON.stringify(r));
    assert.equal(store().state.step, step);
}
/** Proceed, as the action page confirms it. */
async function proceed(): Promise<{ prompt: QueuedPrompt; marker: QueuedPrompt }> {
    const r = await confirmProcessAction('proceed', undefined, '');
    assert.deepEqual([r.ok, r.ok && r.queued], [true, true], JSON.stringify(r));
    const marker = markers().find((m) => m.status !== 'sent')!;
    const prompt = queue().items.find((i) => !i.processMove && i.processRun?.proceedId === marker.processRun?.proceedId)!;
    return { prompt, marker };
}

describe('a process step ends with its queue', () => {
    test('setup: auto-send off, the quest active', async () => {
        await ProcessStateStore.ready;
        queue().autoSendEnabled = false;
        assert.equal(store().activeQuest, QUEST);
    });

    test('PS-1, PS-2, PS-3: Proceed, the agent\'s items, the move', async () => {
        await at('code');
        const { prompt, marker } = await proceed();
        assert.equal(store().state.step, 'code', 'the state stays on the step');
        assert.deepEqual(queue().items.map((i) => i.id), [prompt.id, marker.id], 'the prompt, then the marker');
        assert.equal(marker.originalText, '⏭ move the process to Build › Check');
        assert.ok(prompt.processRun?.proceedId && prompt.processRun.proceedId === marker.processRun?.proceedId, 'one Proceed run');
        assert.deepEqual([queue().stepRunProgress(QUEST)?.left, queue().stepRunProgress(QUEST)?.held], [1, false]);
        const again = await confirmProcessAction('proceed', undefined, '');
        assert.equal(again.ok, false);
        assert.match(!again.ok ? again.error : '', /still running — 1 item\(s\) left/);

        // PS-2: the prompt runs and its agent queues two todo walks; something else is queued meanwhile.
        set(prompt.id, 'sending');
        const walk1 = await runInProcessPosition(prompt.processRun, () => queue().enqueue({ originalText: 'walk 1', deferSend: true }));
        const walk2 = await runInProcessPosition(prompt.processRun, () => queue().enqueue({ originalText: 'walk 2', deferSend: true }));
        const other = await queue().enqueue({ originalText: 'unrelated', deferSend: true });
        assert.deepEqual(queue().items.map((i) => i.id), [prompt.id, walk1.id, walk2.id, marker.id, other.id], 'the walks before the marker, the rest after');
        assert.equal(walk1.processRun?.proceedId, prompt.processRun?.proceedId, 'inherited');
        assert.equal(queue().stepRunProgress(QUEST)?.left, 3);
        queue().remove(other.id);

        // PS-3: the marker is reached while a walk still waits (a rate-limit wait).
        set(prompt.id, 'sent');
        set(walk1.id, 'sent');
        set(walk2.id, 'waiting');
        await drive();
        assert.equal(queue().getById(marker.id)?.status, 'pending', 'the marker waits');
        assert.equal(store().state.step, 'code', 'the state stays');
        assert.equal(queue().stepRunProgress(QUEST)?.left, 1);
        set(walk2.id, 'sent');
        await drive();
        assert.equal(queue().getById(marker.id)?.status, 'sent', 'the marker has moved');
        assert.equal(store().state.step, 'check', 'the process moved on');
        assert.equal(queue().stepRunProgress(QUEST), undefined, 'no step running');
    });

    test('PS-3: after a repeatable step the marker moves to the decision', async () => {
        await at('review');
        const { prompt, marker } = await proceed();
        set(prompt.id, 'sent');
        await drive();
        assert.equal(queue().getById(marker.id)?.status, 'sent');
        assert.deepEqual([store().state.step, store().state.decision], ['review', true], 'the decision opens');
    });

    test('PS-4: a failed item holds the marker; repeat, then move on', async () => {
        await at('code');
        const first = await proceed();
        set(first.prompt.id, 'error');
        await drive();
        const held = queue().getById(first.marker.id)!;
        assert.deepEqual([held.status, held.error], ['error', PROCESS_MARKER_HELD_ERROR], 'held');
        assert.equal(store().state.step, 'code');
        assert.equal(queue().stepRunProgress(QUEST)?.held, true);
        const refused = await confirmProcessAction('proceed', undefined, '');
        assert.match(!refused.ok ? refused.error : '', /failed: repeat the step or move on/);

        // Repeat: the marker goes and the step is queued again, as a new run.
        await dropHeldStep();
        assert.equal(markers().filter((m) => m.status !== 'sent').length, 0);
        const second = await proceed();
        assert.notEqual(second.marker.processRun?.proceedId, first.marker.processRun?.proceedId, 'a new run');
        set(second.prompt.id, 'sent');
        await drive();
        assert.equal(store().state.step, 'check', 'the old failed item does not hold the new run');

        // Move on: the marker's move is made now.
        await at('code');
        const third = await proceed();
        set(third.prompt.id, 'error');
        await drive();
        const moved = await moveOnFromHeldStep();
        assert.equal(moved.ok, true, JSON.stringify(moved));
        assert.equal(store().state.step, 'check');
        assert.equal(queue().getById(third.marker.id), undefined, 'the marker is removed');
    });

    test('PS-5: Skip and a set state remove the marker', async () => {
        await at('code');
        const { marker } = await proceed();
        const skipped = await confirmProcessAction('skip', undefined, '');
        assert.equal(skipped.ok, true, JSON.stringify(skipped));
        assert.equal(queue().getById(marker.id), undefined, 'Skip removed the marker');
        assert.equal(store().state.step, 'check');

        await at('code');
        const second = await proceed();
        const answer = JSON.parse(String(await SET_PROCESS_STATE_TOOL.execute({ step: 'review' } as never)));
        assert.equal(answer.ok, true, JSON.stringify(answer));
        assert.equal(answer.processMoveMarkersRemoved, 1);
        assert.equal(queue().getById(second.marker.id), undefined);
        assert.ok(queue().getById(second.prompt.id), 'the step\'s prompt stays in the queue');
    });

    test('PS-6: a user action moves at once', async () => {
        await at('check');
        const r = await confirmProcessAction('proceed', undefined, '');
        assert.deepEqual([r.ok, r.ok && r.queued], [true, false]);
        assert.equal(markers().length, 0, 'no marker');
        assert.equal(store().state.step, 'review', 'moved at once');
    });

    test('PS-7: the marker survives the queue file', async () => {
        await at('code');
        const { marker } = await proceed();
        const files: string[] = [];
        const walk = (dir: string): void => {
            for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
                const p = path.join(dir, e.name);
                if (e.isDirectory()) { walk(p); } else if (/\.ya?ml$/.test(e.name) && fs.readFileSync(p, 'utf8').includes(marker.id)) { files.push(p); }
            }
        };
        walk(SANDBOX);
        assert.ok(files.length > 0, 'the queue file holds the marker');
        const text = fs.readFileSync(files[0], 'utf8');
        assert.match(text, /process-move:/);
        assert.match(text, new RegExp(`proceedId: ${marker.processRun!.proceedId}`));
        assert.deepEqual(parseProcessMove({ kind: 'proceed', label: 'Proceed', to: 'X' }), { kind: 'proceed', label: 'Proceed', to: 'X' });
        assert.equal(parseProcessMove({ kind: 'proceed' }), undefined);
        clearQueue();
    });

    test('PS-8: conditions — the agent leaves a step out, the user an optional one', async () => {
        clearQueue();
        ChatVariablesStore.instance.set('mode', 'short', 'user');
        // Started from its beginning: the first phase's condition fails, so it starts in `main`.
        assert.equal(store().apply({ process: 'cond' }, 'user').ok, true);
        assert.deepEqual([store().state.phase, store().state.step], ['main', 'first']);
        assert.deepEqual(store().state.skipped?.map((r) => [r.phase, r.by]), [['pre', 'condition']]);
        // Nothing to judge at `first`.
        const refused = JSON.parse(String(await SET_PROCESS_STATE_TOOL.execute({ leaveOut: 'x' } as never)));
        assert.equal(refused.ok, false);
        assert.match(refused.error, /nothing at the current position has a condition for the agent to judge/);

        assert.equal(store().apply({ step: 'announce' }, 'user').ok, true);
        const { prompt, marker } = await proceed();
        set(prompt.id, 'sending');
        const answer = JSON.parse(String(await runInProcessPosition(prompt.processRun, () => SET_PROCESS_STATE_TOOL.execute({ leaveOut: 'no public API change' } as never))));
        assert.equal(answer.ok, true, JSON.stringify(answer));
        assert.equal(answer.processMoveMarkersRemoved, undefined, 'the marker stays');
        assert.deepEqual(store().state.leaveOut, { level: 'step', reason: 'no public API change' });
        assert.equal(store().state.step, 'announce', 'nothing moves while the run runs');
        set(prompt.id, 'sent');
        await drive();
        assert.equal(queue().getById(marker.id)?.status, 'sent');
        assert.equal(store().state.step, 'extra', 'left out when the run ended');
        assert.equal(store().state.leaveOut, undefined);
        const last = store().state.skipped!.at(-1)!;
        assert.deepEqual([last.step, last.by, last.reason], ['announce', 'agent', 'no public API change']);

        // The user leaves the optional step out; `second` is passed by its variable.
        const left = await confirmProcessAction('leave-out', 'step', '');
        assert.equal(left.ok, true, JSON.stringify(left));
        assert.equal(store().state.step, 'gate');
        assert.deepEqual(store().state.skipped!.slice(-2).map((r) => [r.step, r.by]), [['extra', 'user'], ['second', 'condition']]);

        // Without a running step the agent's leaveOut leaves out at once.
        assert.equal(store().apply({ step: 'announce' }, 'user').ok, true);
        const now = JSON.parse(String(await SET_PROCESS_STATE_TOOL.execute({ leaveOut: 'not needed' } as never)));
        assert.equal(now.ok, true, JSON.stringify(now));
        assert.equal(store().state.step, 'extra');
        const both = JSON.parse(String(await SET_PROCESS_STATE_TOOL.execute({ leaveOut: 'x', step: 'first' } as never)));
        assert.match(both.error, /`leaveOut` goes alone/);
        ChatVariablesStore.instance.remove('mode');
        clearQueue();
    });

    test('PS-9: custom chat variables survive a process run', async () => {
        clearQueue();
        const chat = ChatVariablesStore.instance;
        chat.set('design', 'process_design', 'anthropic');
        chat.set('design-mode', 'revise', 'anthropic');
        const custom = (): Record<string, string> => ({ ...chat.custom });
        const expected = { 'design': 'process_design', 'design-mode': 'revise' };
        // A step run with Proceed, its marker moving the process.
        await at('code');
        const { prompt } = await proceed();
        set(prompt.id, 'sent');
        await drive();
        assert.equal(store().state.step, 'check');
        // The response values of an answer (`TODO`) add to them.
        chat.setCustomBulk({ TODO: '_ai/quests/q1/todos.q1.todo.yaml/a1_x' }, 'anthropic');
        // A user action confirmed, a repeatable step run to its decision, the decision taken.
        assert.equal((await confirmProcessAction('proceed', undefined, '')).ok, true);
        const review = await proceed();
        set(review.prompt.id, 'sent');
        await drive();
        assert.equal(store().state.decision, true);
        assert.equal((await confirmProcessAction('finish', undefined, '')).ok, true);
        // The gate, then the process finished at its decision.
        const gate = await proceed();
        set(gate.prompt.id, 'sent');
        await drive();
        assert.equal((await confirmProcessAction('finish-process', undefined, '')).ok, true);
        assert.equal(store().state.completed, true);
        // A phase move and another process, set by the tool.
        assert.equal(JSON.parse(String(await SET_PROCESS_STATE_TOOL.execute({ process: 'cond' } as never))).ok, true);
        assert.equal(JSON.parse(String(await SET_PROCESS_STATE_TOOL.execute({ phase: 'pre' } as never))).ok, true);
        assert.deepEqual(custom(), { ...expected, TODO: '_ai/quests/q1/todos.q1.todo.yaml/a1_x' });
        for (const k of ['design', 'design-mode', 'TODO']) { chat.remove(k); }
        clearQueue();
    });
});
