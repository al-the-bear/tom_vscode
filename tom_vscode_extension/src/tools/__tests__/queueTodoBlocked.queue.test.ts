/**
 * A queue item whose todo is blocked (a/c of the 2026-11-19 request), through the real manager under the vscode
 * stub; the transport is a stub that plays the agent.
 *
 *   TB-1 a walk whose next todo waits for a todo that is not completed is held: nothing is sent, the item is
 *        `todo-blocked` with what it waits for (`blockedOn`, the queue file's `blocked-on`), its run is paused and
 *        the queue reports it as holding (`item-blocked`); when the blocker is completed the entry leaves the
 *        todo's `blocked_by`, and resuming the run releases the item and the walk runs
 *   TB-2 blockers completed in the meantime never hold: a todo still marked `blocked` whose blocker is done is
 *        set back to not-started and runs; a stale met entry on a not-started todo blocks nothing
 *   TB-3 a blocked todo further down holds nothing yet: the todos before it run, the walk holds when it reaches it
 *   TB-4 a plain item that names its todo (`todoIdPattern`, the todo panel's Queue button) is held the same way
 *        before its prompt goes out; the items queued after it in its run wait behind it (resumed or not), and
 *        once its blocker is completed it is sent first, then they follow in their order
 *   TB-5 a todo marked `blocked` with nothing that says why holds the item too
 *   TB-6 a walk runs an in-progress todo of its series that no running item works on (a stale claim) and does not
 *        hold a later todo that waits for it: both run, in order
 *   TB-7 a blocker a queue item ahead runs (here a staged one naming it) does not hold the walk behind it
 *   TB-8 a held walk's Continue skips the blocked todo and goes on with the next; Run anyway runs it without
 *        waiting; a single-todo item offers Run anyway but no Continue; Stop and Interrupt put a held item back to
 *        staged (its hold record gone)
 *   TB-9 the hold that paused the run is recorded (`holdPausedRun`, the queue file's `hold-paused-run`); once the
 *        blocker is completed — seen by recheckHeldItems, which the todo files' watcher calls — the item is
 *        released and its run goes on by itself: the walk runs without the user resuming it
 *   TB-10 a run the user paused himself (auto-send set off after the hold) stays paused: the item is released
 *         to pending, nothing is sent
 *   TB-11 the run's `autoResumeHeld` off: released, not resumed
 *   TB-12 a walk held at a `decision-needed` todo: once every decision of the todo is answered (its status left
 *         as it was), the todo is set to not-started, the item is released and its run goes on by itself
 *   TB-13 send between iterations on a GROUP walk: the pending item after the running GROUP item is flagged
 *         `canSendBetween`-able (runningLoopAbove) and, marked during the first member's turn, is sent after it,
 *         before the second member
 */

import test, { after, describe } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'fs';
import * as path from 'path';

const EXT_ROOT = path.resolve(__dirname, '..', '..', '..');
const SANDBOX = fs.realpathSync(fs.mkdtempSync(path.join(EXT_ROOT, '..', '..', '..', 'ztmp', 'vscode_extension_261119_todoblocked_queue-')));
const WS = path.join(SANDBOX, 'ws');
const HOME = path.join(SANDBOX, 'home');
const QUEST = 'q1';
const QDIR = path.join(WS, '_ai', 'quests', QUEST);
fs.mkdirSync(QDIR, { recursive: true });
// A root of its own, so nothing resolves to the real workspace.
fs.mkdirSync(path.join(SANDBOX, '.tom'), { recursive: true });
fs.writeFileSync(path.join(SANDBOX, '.tom', 'tom_root.yaml'), 'root: true\n');
fs.writeFileSync(path.join(QDIR, `overview.${QUEST}.md`), '# Q1\n');
// The configuration is the root's.
fs.writeFileSync(path.join(SANDBOX, '.tom', 'tom_vscode_extension.json'), JSON.stringify({
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
import { TimerEngine } from '../../managers/timerEngine.js';
import { PromptQueueManager, type QueuedPrompt } from '../../managers/promptQueueManager.js';
import { AnthropicHandler } from '../../handlers/anthropic-handler.js';
import { AskUserRegistry } from '../../services/askUserRegistry.js';
import { findTodoById, updateTodo } from '../../managers/questTodoManager.js';
import { runningLoopAbove } from '../../utils/queueSendBetween.js';
import { holdingState, queueHoldingDraft } from '../../services/userNotificationEmitter.js';
import { TomAiConfiguration } from '../../utils/tomAiConfiguration.js';
import { setExtensionPath } from '../../handlers/handler_shared.js';

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
after(() => {
    for (const stop of [() => PromptQueueManager.instance.dispose(), () => TimerEngine.instance.dispose()]) {
        try { stop(); } catch { /* not started */ }
    }
    for (const s of subscriptions.splice(0)) { try { s.dispose(); } catch { /* already gone */ } }
    vscodeStub.restore();
    fs.rmSync(SANDBOX, { recursive: true, force: true });
});

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Json = any;
const queue = (): PromptQueueManager => PromptQueueManager.instance;
const wait = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));
const handler = AnthropicHandler.instance as Json;
const originalSend = handler.sendMessage;
after(() => { handler.sendMessage = originalSend; });

/** Each turn: its options; `script(opts, n)` plays the agent and says the answer. */
const turns: Json[] = [];
let script: (opts: Json, n: number) => string = () => 'done';
handler.sendMessage = async (opts: Json) => {
    turns.push(opts);
    return { text: script(opts, turns.length), turnsUsed: 1, toolCallCount: 0 };
};
const todoOf = (id: string): Json => findTodoById(QUEST, id);
const setStatus = (id: string, status: string): void => { updateTodo(QUEST, id, { status } as never); };
const todoIdIn = (text: string): string | undefined => /(\w+\d_x)/.exec(text)?.[1];
/** Write a todo file of the quest: `[id, status, blocked_by?]` per todo. */
function writeTodoFile(name: string, todos: Array<[string, string, string[]?]>): void {
    const text = todos.map(([id, status, blockedBy]) => [
        `  - id: ${id}`, `    title: todo ${id}`, `    description: do ${id}`, `    status: ${status}`, '    priority: medium', '    created: 2026-11-19',
        ...(blockedBy?.length ? ['    blocked_by:', ...blockedBy.map((b) => `      - ${b}`)] : []),
    ].join('\n'));
    fs.writeFileSync(path.join(QDIR, `todos.${name}.${QUEST}.todo.yaml`), `todos:\n${text.join('\n')}\n`);
}

function reset(): void {
    queue().autoSendEnabled = false;
    AskUserRegistry.instance.cancel('reset');
    for (const i of [...queue().items]) { queue().remove(i.id); }
    turns.length = 0;
}
async function runWalk(prefix: string, opts: Record<string, unknown> = {}): Promise<QueuedPrompt> {
    const item = await queue().enqueue({ originalText: 'work on ${repeatTodoId}', repeatCount: `${prefix}*`, transport: 'anthropic', anthropicProfileId: 'sdk', session: `s-${prefix}`, deferSend: true, initialStatus: 'pending', ...opts } as never);
    queue().autoSendEnabled = true;
    await wait(400);
    return item;
}
const live = (item: QueuedPrompt): QueuedPrompt => queue().getById(item.id) as QueuedPrompt;
function queueFileText(id: string): string {
    const found: string[] = [];
    const walk = (dir: string): void => {
        for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
            const p = path.join(dir, e.name);
            if (e.isDirectory()) { walk(p); } else if (/\.ya?ml$/.test(e.name) && fs.readFileSync(p, 'utf8').includes(id)) { found.push(fs.readFileSync(p, 'utf8')); }
        }
    };
    walk(SANDBOX);
    return found.join('\n');
}


describe('a queue item whose todo is blocked', () => {
    test('setup', () => {
        queue().autoSendEnabled = false;
        queue().setDefaultTransport('anthropic', 'sdk');
    });
    script = (opts) => {
        const id = todoIdIn(String(opts.userText));
        if (id) { setStatus(id, 'completed'); }
        return `done ${id}`;
    };

    test('TB-1: a walk held at a blocked todo, released when the blocker is completed', async () => {
        reset();
        writeTodoFile('gates', [['gate1', 'in-progress']]);
        writeTodoFile('ta', [['ta1_x', 'not-started', ['gate1']], ['ta2_x', 'not-started']]);
        const item = await runWalk('ta');
        assert.equal(turns.length, 0, 'nothing is sent');
        assert.equal(live(item).status, 'todo-blocked');
        assert.equal(live(item).blockedOn, 'todo ta1_x waits for gate1 (in-progress)');
        assert.equal(queue().autoSendEnabled, false, 'its run is paused, as at an open decision');
        assert.match(queueFileText(item.id), /status: "?todo-blocked/);
        assert.match(queueFileText(item.id), /blocked-on: "?todo ta1_x waits for gate1 \(in-progress\)/);
        assert.equal(todoOf('ta1_x').status, 'not-started', 'the todo is not claimed');
        // The queue reports it as holding for the user.
        const holding = queue().holdingItems().find((h) => h.id === item.id)!;
        assert.equal(holdingState(holding), 'item-blocked');
        const draft = queueHoldingDraft(holding, 'item-blocked');
        assert.equal(draft.type, 'queueHolding');
        assert.equal(draft.user?.kind, 'item-blocked');
        assert.match(draft.user!.title, /^Queue item item-blocked: /);
        assert.deepEqual(draft.user!.details, ['The item is held: todo ta1_x waits for gate1 (in-progress).', 'It goes back to pending once the blocker is completed; resume the run then.']);
        // Resumed while the blocker is still open: held again, nothing sent.
        queue().autoSendEnabled = true;
        await wait(300);
        assert.equal(turns.length, 0);
        assert.equal(live(item).status, 'todo-blocked');
        // The blocker is completed: it leaves the todo's blocked_by; resuming releases the item and the walk runs.
        setStatus('gate1', 'completed');
        assert.equal(todoOf('ta1_x').blocked_by, undefined, 'the done blocker left blocked_by');
        queue().autoSendEnabled = true;
        await wait(500);
        assert.deepEqual(turns.map((t) => todoIdIn(String(t.userText))), ['ta1_x', 'ta2_x']);
        assert.equal(live(item).status, 'sent');
        assert.equal(live(item).blockedOn, undefined);
        assert.doesNotMatch(queueFileText(item.id), /blocked-on:/);
    });

    test('TB-2: blockers completed in the meantime never hold', async () => {
        reset();
        // Written as they are found after an edit outside the extension: the blockers are done, the entries still there.
        writeTodoFile('gates', [['gate2', 'completed'], ['gate3', 'cancelled']]);
        writeTodoFile('tb', [['tb1_x', 'blocked', ['gate2']], ['tb2_x', 'not-started', ['gate3']]]);
        const item = await runWalk('tb');
        assert.deepEqual(turns.map((t) => todoIdIn(String(t.userText))), ['tb1_x', 'tb2_x'], 'both run');
        assert.equal(live(item).status, 'sent');
    });

    test('TB-3: a blocked todo further down holds only when the walk reaches it', async () => {
        reset();
        writeTodoFile('gates', [['gate4', 'not-started']]);
        writeTodoFile('tc', [['tc1_x', 'not-started'], ['tc2_x', 'not-started', ['gate4']], ['tc3_x', 'not-started']]);
        const item = await runWalk('tc');
        assert.deepEqual(turns.map((t) => todoIdIn(String(t.userText))), ['tc1_x'], 'the todo before it ran; the one after it waits');
        assert.equal(live(item).status, 'todo-blocked');
        assert.equal(live(item).blockedOn, 'todo tc2_x waits for gate4 (not-started)');
        // Another quest's blocker, named `<quest>/<id>`, that exists nowhere: blocked too (not found).
        reset();
        writeTodoFile('td', [['td1_x', 'not-started', ['other_quest/nothing1']]]);
        const lost = await runWalk('td');
        assert.equal(live(lost).blockedOn, 'todo td1_x waits for other_quest/nothing1 (not found)');
        assert.equal(turns.length, 0);
    });

    test('TB-4: a plain item that names its todo', async () => {
        reset();
        writeTodoFile('gates', [['gate5', 'in-progress'], ['gate6', 'completed']]);
        writeTodoFile('te', [['te1_x', 'not-started', ['gate5']], ['te2_x', 'not-started'], ['te3_x', 'blocked', ['gate6']]]);
        const add = (id: string): Promise<QueuedPrompt> => queue().enqueue({
            originalText: `do the todo ${id}`, todoIdPattern: id, transport: 'anthropic', anthropicProfileId: 'sdk', session: `s-${id}`, deferSend: true, initialStatus: 'pending',
        } as never);
        const blocked = await add('te1_x');
        queue().autoSendEnabled = true;
        await wait(300);
        assert.equal(turns.length, 0, 'its prompt does not go out');
        assert.equal(live(blocked).status, 'todo-blocked');
        assert.equal(live(blocked).blockedOn, 'todo te1_x waits for gate5 (in-progress)');
        // The items queued after it wait behind it, even with the run resumed: its run keeps its order.
        const free = await add('te2_x');
        const releasable = await add('te3_x');
        queue().autoSendEnabled = true;
        await wait(500);
        assert.equal(turns.length, 0, 'nothing after the held item runs before it');
        assert.equal(live(free).status, 'pending');
        assert.equal(live(releasable).status, 'pending');
        assert.equal(live(blocked).status, 'todo-blocked', 'still held');
        // Its blocker completed: released and sent first, then the others in their order.
        setStatus('gate5', 'completed');
        queue().autoSendEnabled = true;
        await wait(700);
        assert.deepEqual(turns.map((t) => todoIdIn(String(t.userText))), ['te1_x', 'te2_x', 'te3_x']);
        for (const i of [blocked, free, releasable]) { assert.equal(live(i).status, 'sent'); }
    });

    test('TB-5: blocked without a blocker named', async () => {
        reset();
        writeTodoFile('tf', [['tf1_x', 'blocked']]);
        const item = await runWalk('tf');
        assert.equal(turns.length, 0);
        assert.equal(live(item).status, 'todo-blocked');
        assert.equal(live(item).blockedOn, 'todo tf1_x is blocked (its status says so; no `blocked_by` names why)');
        reset();
    });

    test('TB-6: a stale in-progress todo of the series runs first and holds nothing', async () => {
        reset();
        writeTodoFile('tg', [['tg1_x', 'in-progress'], ['tg2_x', 'not-started', ['tg1_x']]]);
        const item = await runWalk('tg');
        assert.deepEqual(turns.map((t) => todoIdIn(String(t.userText))), ['tg1_x', 'tg2_x']);
        assert.equal(live(item).status, 'sent');
    });

    test('TB-7: a blocker an item ahead runs does not hold', async () => {
        reset();
        writeTodoFile('tz', [['tz1_x', 'not-started']]);
        writeTodoFile('ti', [['ti1_x', 'not-started', ['tz1_x']]]);
        const ahead = await queue().enqueue({ originalText: 'do tz1_x', todoIdPattern: 'tz1_x', transport: 'anthropic', anthropicProfileId: 'sdk', session: 's-tz', deferSend: true, initialStatus: 'staged' } as never);
        assert.equal(live(ahead).status, 'staged');
        const item = await runWalk('ti');
        assert.deepEqual(turns.map((t) => todoIdIn(String(t.userText))), ['ti1_x'], 'not held: the item ahead runs its blocker');
        assert.equal(live(item).status, 'sent');
    });

    test('TB-8: Continue, Run anyway, Stop and Interrupt on a held item', async () => {
        reset();
        writeTodoFile('gates', [['gate8', 'in-progress']]);
        writeTodoFile('tj', [['tj1_x', 'not-started', ['gate8']], ['tj2_x', 'not-started']]);
        const walk = await runWalk('tj');
        assert.equal(live(walk).status, 'todo-blocked');
        assert.equal(live(walk).blockedTodo, 'tj1_x');
        assert.deepEqual(queue().blockedItemActions(walk.id), { canSkip: true, canRunAnyway: true });
        assert.equal(queue().skipBlockedTodo(walk.id), true);
        await wait(500);
        assert.deepEqual(turns.map((t) => todoIdIn(String(t.userText))), ['tj2_x'], 'the walk went on with the next todo');
        assert.equal(live(walk).status, 'sent');
        assert.equal(todoOf('tj1_x').status, 'not-started', 'the skipped todo is left as it was');
        assert.match(queueFileText(walk.id), /skipped-todos:/);

        reset();
        writeTodoFile('tk', [['tk1_x', 'blocked', ['gate8']]]);
        const anyway = await runWalk('tk');
        assert.equal(live(anyway).status, 'todo-blocked');
        assert.equal(queue().runBlockedTodoAnyway(anyway.id), true);
        await wait(500);
        assert.deepEqual(turns.map((t) => todoIdIn(String(t.userText))), ['tk1_x'], 'run without waiting for gate8');
        assert.equal(live(anyway).status, 'sent');

        reset();
        writeTodoFile('tl', [['tl1_x', 'not-started', ['gate8']], ['tl2_x', 'not-started', ['gate8']]]);
        const single = await queue().enqueue({ originalText: 'do tl1_x', todoIdPattern: 'tl1_x', transport: 'anthropic', anthropicProfileId: 'sdk', session: 's-tl1', deferSend: true, initialStatus: 'pending' } as never);
        queue().autoSendEnabled = true;
        await wait(300);
        assert.equal(live(single).status, 'todo-blocked');
        assert.deepEqual(queue().blockedItemActions(single.id), { canSkip: false, canRunAnyway: true }, 'a single todo has no next one');
        assert.equal(queue().skipBlockedTodo(single.id), false);
        assert.equal(queue().stopActiveItem(), true, 'Stop takes the held item');
        assert.equal(live(single).status, 'staged');
        assert.equal(live(single).blockedOn, undefined);
        assert.equal(live(single).blockedTodo, undefined);
        const other = await queue().enqueue({ originalText: 'do tl2_x', todoIdPattern: 'tl2_x', transport: 'anthropic', anthropicProfileId: 'sdk', session: 's-tl2', deferSend: true, initialStatus: 'pending' } as never);
        queue().autoSendEnabled = true;
        await wait(300);
        assert.equal(live(other).status, 'todo-blocked');
        assert.equal(queue().interruptActiveItemForContinuation(), true, 'Interrupt takes the held item too');
        assert.equal(live(other).status, 'staged');
        assert.equal(turns.length, 0);
        reset();
    });

    test('TB-9: released by a completed blocker, the run goes on by itself', async () => {
        reset();
        writeTodoFile('gates', [['gate9', 'in-progress']]);
        writeTodoFile('tm', [['tm1_x', 'not-started', ['gate9']], ['tm2_x', 'not-started']]);
        const item = await runWalk('tm');
        assert.equal(live(item).status, 'todo-blocked');
        assert.equal(queue().autoSendEnabled, false, 'the hold paused the run');
        assert.equal(live(item).holdPausedRun, true);
        assert.match(queueFileText(item.id), /hold-paused-run: true/);
        // Nothing changed yet: the recheck keeps it held.
        queue().recheckHeldItems();
        await wait(200);
        assert.equal(live(item).status, 'todo-blocked');
        assert.equal(queue().autoSendEnabled, false);
        // The blocker is completed (another run, window or quest): the watcher's recheck releases and resumes.
        setStatus('gate9', 'completed');
        queue().recheckHeldItems();
        await wait(500);
        // The run went on by itself (Auto-Pause switches it off again once its lane is empty).
        assert.deepEqual(turns.map((t) => todoIdIn(String(t.userText))), ['tm1_x', 'tm2_x']);
        assert.equal(live(item).status, 'sent');
        assert.equal(live(item).holdPausedRun, undefined);
        reset();
    });

    test('TB-10: a run the user paused himself stays paused', async () => {
        reset();
        writeTodoFile('gates', [['gate10', 'in-progress']]);
        writeTodoFile('tn', [['tn1_x', 'not-started', ['gate10']]]);
        const item = await runWalk('tn');
        assert.equal(live(item).status, 'todo-blocked');
        queue().autoSendEnabled = false; // the user pauses the run himself
        assert.equal(live(item).holdPausedRun, undefined, 'the hold no longer decides the resume');
        setStatus('gate10', 'completed');
        queue().recheckHeldItems();
        await wait(300);
        assert.equal(live(item).status, 'pending', 'released');
        assert.equal(queue().autoSendEnabled, false, 'the run stays paused');
        assert.equal(turns.length, 0);
        reset();
    });

    test('TB-11: auto-resume after a hold switched off', async () => {
        reset();
        queue().setRunQueueSettings(undefined, { autoResumeHeld: false });
        try {
            writeTodoFile('gates', [['gate11', 'in-progress']]);
            writeTodoFile('to', [['to1_x', 'not-started', ['gate11']]]);
            const item = await runWalk('to');
            assert.equal(live(item).status, 'todo-blocked');
            setStatus('gate11', 'completed');
            queue().recheckHeldItems();
            await wait(300);
            assert.equal(live(item).status, 'pending');
            assert.equal(queue().autoSendEnabled, false, 'not resumed');
            assert.equal(turns.length, 0);
        } finally {
            queue().setRunQueueSettings(undefined, { autoResumeHeld: true });
            reset();
        }
    });

    test('TB-12: a walk held at a decision goes on once the decisions are answered', async () => {
        reset();
        const file = path.join(QDIR, `todos.tp.${QUEST}.todo.yaml`);
        fs.writeFileSync(file, [
            'todos:',
            '  - id: tp1_x', '    title: todo tp1_x', '    description: do tp1_x', '    status: decision-needed', '    priority: medium', '    created: 2026-11-25',
            '    decisions:', '      - summary: which one', '        decision_needed: (a) or (b)', '      - summary: how much', '        decision_needed: little or much', '        decision: little',
            '  - id: tp2_x', '    title: todo tp2_x', '    description: do tp2_x', '    status: not-started', '    priority: medium', '    created: 2026-11-25',
            '',
        ].join('\n'));
        const item = await runWalk('tp');
        assert.equal(live(item).status, 'decision-needed');
        assert.equal(queue().autoSendEnabled, false);
        assert.equal(live(item).holdPausedRun, true);
        // One decision still open: held.
        queue().recheckHeldItems();
        await wait(200);
        assert.equal(live(item).status, 'decision-needed');
        assert.equal(todoOf('tp1_x').status, 'decision-needed');
        // The user answers the last decision in the todo panel; the status is left as it was.
        fs.writeFileSync(file, fs.readFileSync(file, 'utf8').replace('        decision_needed: (a) or (b)\n', '        decision_needed: (a) or (b)\n        decision: (a)\n'));
        queue().recheckHeldItems();
        await wait(500);
        assert.equal(todoOf('tp1_x').status !== 'decision-needed', true, 'the decided todo was set to not-started (and then run)');
        // The run went on by itself (Auto-Pause switches it off again once its lane is empty).
        assert.deepEqual(turns.map((t) => todoIdIn(String(t.userText))), ['tp1_x', 'tp2_x']);
        assert.equal(live(item).status, 'sent');
        reset();
    });

    test('TB-13: send between iterations on a GROUP walk', async () => {
        reset();
        fs.writeFileSync(path.join(QDIR, `todos.tq.${QUEST}.todo.yaml`), [
            'todos:',
            '  - id: tqg_x', '    title: the group', '    description: the group', '    status: group', '    priority: medium', '    created: 2026-11-25',
            '    comprised_of:', '      - tq1_x', '      - tq2_x',
            '  - id: tq1_x', '    title: todo tq1_x', '    description: do tq1_x', '    status: not-started', '    priority: medium', '    created: 2026-11-25',
            '  - id: tq2_x', '    title: todo tq2_x', '    description: do tq2_x', '    status: not-started', '    priority: medium', '    created: 2026-11-25',
            '',
        ].join('\n'));
        const walk = await queue().enqueue({ originalText: 'work on ${repeatTodoId}', repeatCount: `group:${QUEST}/tqg_x`, transport: 'anthropic', anthropicProfileId: 'sdk', session: 's-tq', deferSend: true, initialStatus: 'pending' } as never);
        const between = await queue().enqueue({ originalText: 'between the members', transport: 'anthropic', anthropicProfileId: 'sdk', session: 's-between', deferSend: true, initialStatus: 'pending' } as never);
        const plain = script;
        let flagged: boolean | undefined;
        script = (opts, n) => {
            if (n === 1) {
                flagged = runningLoopAbove(queue().items as never, between.id)?.id === walk.id;
                queue().toggleSendBetween(between.id);
            }
            return plain(opts, n);
        };
        try {
            queue().autoSendEnabled = true;
            await wait(900);
        } finally { script = plain; }
        assert.equal(flagged, true, 'the item after the running GROUP walk may go between its iterations');
        assert.deepEqual(turns.map((t) => todoIdIn(String(t.userText)) ?? 'between'), ['tq1_x', 'between', 'tq2_x']);
        assert.equal(live(walk).status, 'sent');
        assert.equal(live(between).status, 'sent');
        reset();
    });
});
