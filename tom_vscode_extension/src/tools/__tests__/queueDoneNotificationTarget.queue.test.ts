/**
 * Where a queue item's done notification goes (vscimpb71; src/utils/doneNotification.ts, src/utils/questInbox.ts):
 * the real queue manager and process store under the vscode stub, the dispatch replaced by a gate the test opens.
 *
 *   DT-1 defaults unchanged: no target named, the notification is queued in the item's own run and session
 *        (`<session>@<run>`), ahead of the pending items, `${itemOutcome}` filled
 *   DT-2 the same quest, another run: the notification goes into that run's lane, its session becoming
 *        `<session>@<run2>`; `${senderQuest}` / `${senderRun}` name where it came from
 *   DT-3 another quest: posted through the poster with the run named (default `default`), the item's pause stays
 *        with the item; the item records where it was posted and that it waits (no window there), also in its entry
 *        meta
 *   DT-4 the other side, the inbox: a notification posted from another quest into this quest's run is queued in
 *        that run's lane with the sender filled in; a run this quest does not have makes it an error in `default`
 *   DT-6 a todo walk sent from another quest (`repeatCount: "wk-*"`) is queued in the named run's lane with its
 *        repeat count and todo pattern; into a run this quest lacks it is an error in `default`, no run created
 *   DT-7 a walk's claim (ww_a_collab-5): a sending item holds it; its settle carries out a completed todo's
 *        on_done once, and a completion left to the claim runs at its release too
 *   DT-5 what came out (vscimpb72): ${itemTitle}, ${itemAnswer} and ${itemTodos} are filled from the finished item
 *        when its notification is queued — in this queue and posted to another quest — the answer escaped
 */

/* eslint-disable @typescript-eslint/naming-convention -- YAML keys */
import test, { after, describe } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'fs';
import * as path from 'path';

const EXT_ROOT = path.resolve(__dirname, '..', '..', '..');
const SANDBOX = fs.realpathSync(fs.mkdtempSync(path.join(EXT_ROOT, '..', '..', '..', 'ztmp', 'vscode_extension_261113_vscimpb71_donetarget-')));
const WS = path.join(SANDBOX, 'ws');
const HOME = path.join(SANDBOX, 'home');
const QUEST = 'q1';

function put(rel: string, text: string): void {
    const abs = path.join(WS, rel);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, text);
}
put(`_ai/quests/${QUEST}/overview.${QUEST}.md`, '# Q1\n');
// Two processes, each naming its own session, so their runs' prompts run in different conversations.
for (const [id, session] of [['design', 'work'], ['review', 'check']]) {
    put(`_ai/processes/${id}/${id}.process.yaml`, [
        `id: ${id}`, `name: ${id}`, `session: ${session}`, 'phases:', '  - id: p1', '    steps:',
        '      - id: plan', '        name: Plan', '      - id: build', '        name: Build',
        '    gate:', '      id: g1', '',
    ].join('\n'));
    put(`_ai/processes/${id}/${id}.md`, `# ${id}\n`);
}
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
import { PromptQueueManager, type QueuedPrompt } from '../../managers/promptQueueManager.js';
import { TomAiConfiguration } from '../../utils/tomAiConfiguration.js';
import { setExtensionPath } from '../../handlers/handler_shared.js';
import { installProcessMoveMarkers } from '../../services/processActionService.js';
import { DEFAULT_RUN } from '../../utils/processRuns.js';
import { getQueueFolder } from '../../storage/queueFileStorage.js';
import { inboxFileName, writeInboxFile } from '../../utils/questInbox.js';
import { doneNotificationMetaFromYaml, doneNotificationMetaToYaml } from '../../utils/doneNotification.js';
import { getWorkspaceName } from '../../utils/panelYamlStore.js';
import { deferTodoOnDone, setTodoOnDonePorts, takeDeferredTodoOnDone } from '../../services/todoOnDoneRunner.js';
import * as os from 'os';

let context: never;
const subscriptions: Array<{ dispose(): void }> = [];
(function start(): void {
    const storage = path.join(SANDBOX, 'storage');
    fs.mkdirSync(storage, { recursive: true });
    const memento = (): unknown => {
        const values = new Map<string, unknown>();
        return { get: (k: string, d?: unknown) => values.has(k) ? values.get(k) : d, update: async (k: string, v: unknown) => { values.set(k, v); }, keys: () => [...values.keys()], setKeysForSync: () => undefined };
    };
    context = {
        subscriptions, extensionPath: EXT_ROOT, extensionUri: { fsPath: EXT_ROOT, scheme: 'file' },
        globalStorageUri: { fsPath: storage, scheme: 'file' }, storageUri: { fsPath: storage, scheme: 'file' }, logUri: { fsPath: storage, scheme: 'file' },
        globalStoragePath: storage, storagePath: storage, logPath: storage, globalState: memento(), workspaceState: memento(),
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
})();
after(() => {
    for (const stop of [() => PromptQueueManager.instance.dispose(), () => TimerEngine.instance.dispose(), () => ReminderSystem.instance.dispose()]) {
        try { stop(); } catch { /* not started */ }
    }
    for (const s of subscriptions.splice(0)) { try { s.dispose(); } catch { /* already gone */ } }
    vscodeStub.restore();
    fs.rmSync(SANDBOX, { recursive: true, force: true });
});

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Json = any;
const queue = (): PromptQueueManager => PromptQueueManager.instance;
const store = (): ProcessStateStore => ProcessStateStore.instance!;
const wait = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/** The items whose dispatch runs now, and the gate that finishes one. */
const inFlight = new Map<string, () => void>();
function gateDispatch(): void {
    (queue() as Json).dispatchNextStageForSendingItem = (item: QueuedPrompt) => new Promise<'done'>((resolve) => {
        inFlight.set(item.id, () => { inFlight.delete(item.id); resolve('done'); });
    });
}
async function finish(item: QueuedPrompt): Promise<void> {
    const open = inFlight.get(item.id);
    assert.ok(open, `${item.id} is in flight`);
    open();
    await wait(60);
}
function clean(): void {
    queue().autoSendEnabled = false;
    for (const i of [...queue().items]) { queue().remove(i.id); }
    inFlight.clear();
    store().selectRun(DEFAULT_RUN);
    for (const r of store().runs()) { if (r.run !== DEFAULT_RUN) { store().deleteRuns([r.run]); } }
    for (const r of [...queue().heldRuns]) { queue().setRunHeld(r, false); }
    queue().setRunAutoSend('default', false);
}

const add = (opts: Record<string, unknown>): Promise<QueuedPrompt> =>
    queue().enqueue({ transport: 'anthropic', deferSend: true, initialStatus: 'pending', ...opts } as never);
const notificationOf = (item: QueuedPrompt): QueuedPrompt | undefined => queue().items.find((i) => i.notificationOf === item.id);

describe('the done notification\'s quest and run', () => {
    test('setup', async () => {
        await ProcessStateStore.ready;
        queue().autoSendEnabled = false;
        queue().setDefaultTransport('anthropic');
        gateDispatch();
        assert.equal(store().createRun('r1', 'design', 'user', false).ok, true);
        assert.equal(store().createRun('r2', 'review', 'user', false).ok, true);
    });

    test('DT-1: defaults unchanged', async () => {
        clean();
        const item = await add({ originalText: 'work', run: 'r1', session: 'sa', doneNotificationPrompt: 'told: ${itemOutcome}' });
        const waiting = await add({ originalText: 'next', run: 'r1', session: 'sa' });
        queue().setRunQueueSettings('r1', { autoSend: true, autoPause: false });
        await wait(60);
        await finish(item);
        const n = notificationOf(item);
        assert.ok(n, 'the notification is queued');
        assert.equal(n.originalText, 'told: done');
        assert.equal(n.run, 'r1');
        assert.equal(n.session, 'sa@r1');
        assert.ok(queue().items.indexOf(n) < queue().items.findIndex((i) => i.id === waiting.id), 'ahead of the pending item');
        assert.equal(queue().getById(item.id)?.doneNotificationPosted, undefined);
        clean();
    });

    test('DT-2: the same quest, another run', async () => {
        clean();
        const item = await add({
            originalText: 'work', run: 'r1', session: 'sa', pauseAfter: true,
            doneNotificationPrompt: '${senderQuest}/${senderRun}: ${itemOutcome}', doneNotificationRun: 'r2',
        });
        assert.equal(item.doneNotificationRun, 'r2');
        queue().setRunQueueSettings('r1', { autoSend: true, autoPause: false });
        queue().setRunQueueSettings('r2', { autoSend: false });
        await wait(60);
        await finish(item);
        const n = notificationOf(item);
        assert.ok(n);
        assert.equal(n.run, 'r2', 'that run\'s lane');
        assert.equal(n.session, 'sa@r2', 'that run\'s session');
        assert.equal(n.originalText, `${QUEST}/r1: done`);
        assert.equal(n.pauseAfter, true, 'the pause moves with it, as before');
        assert.equal(n.processRun, undefined);
        clean();
    });

    test('DT-3: another quest, through the poster', async () => {
        clean();
        const posts: Json[] = [];
        queue().setDoneNotificationPoster((p) => { posts.push(p); return { file: 'h_q2_261113_120000-abc.inbox.queue.yaml', targetRunning: false }; });
        try {
            const item = await add({
                originalText: 'work', run: 'r1', session: 'sa', pauseAfter: true,
                doneNotificationPrompt: 'from ${senderQuest}/${senderRun}: ${itemOutcome}', doneNotificationQuest: 'q2',
            });
            queue().setRunQueueSettings('r1', { autoSend: true, autoPause: false });
            await wait(60);
            await finish(item);
            assert.equal(notificationOf(item), undefined, 'nothing queued here');
            assert.deepEqual(posts, [{
                quest: 'q2', run: 'default', text: `from ${QUEST}/r1: done`, notificationOf: item.id, from: { quest: QUEST, run: 'r1' },
            }]);
            const done = queue().getById(item.id)!;
            assert.equal(done.pauseAfter, true, 'the pause stays with the item');
            assert.deepEqual({ ...done.doneNotificationPosted, at: undefined },
                { quest: 'q2', run: 'default', file: 'h_q2_261113_120000-abc.inbox.queue.yaml', waiting: true, at: undefined });
            const meta = doneNotificationMetaToYaml(done) as Json;
            assert.equal(meta['done-notification'].quest, 'q2');
            assert.equal(meta['done-notification'].posted.waiting, true);
            assert.deepEqual(doneNotificationMetaFromYaml(meta).doneNotificationPosted, done.doneNotificationPosted, 'round-trips');
            // A named run there.
            const second = await add({ originalText: 'again', run: 'r1', doneNotificationPrompt: 'x', doneNotificationQuest: 'q2', doneNotificationRun: 'rx' });
            queue().setRunAutoSend('r1', true); // the first item's pause-after paused r1
            await wait(60);
            await finish(second);
            assert.equal(posts[1].run, 'rx');
            // This quest named as the target is the default (stored as unset).
            const own = await add({ originalText: 'own', run: 'r1', doneNotificationPrompt: 'x', doneNotificationQuest: QUEST });
            assert.equal(own.doneNotificationQuest, undefined);
        } finally {
            queue().setDoneNotificationPoster(undefined);
            clean();
        }
    });

    test('DT-4: the inbox side', async () => {
        clean();
        assert.equal(store().createRun('r2', 'review', 'user', false).ok, true, 'clean() removed the runs');
        queue().setRunQueueSettings('r2', { autoSend: false });
        const folder = getQueueFolder()!;
        writeInboxFile(folder, inboxFileName(os.hostname(), getWorkspaceName(), new Date(), 'dt4a'), {
            text: '${senderQuest}/${senderRun} reports: done', run: 'r2', notificationOf: 'abc12345',
            from: { quest: 'q2', run: 'rx', windowId: 'w9', host: os.hostname(), sentAt: new Date().toISOString() },
        });
        writeInboxFile(folder, inboxFileName(os.hostname(), getWorkspaceName(), new Date(), 'dt4b'), {
            text: 'into a missing run', run: 'nope',
            from: { quest: 'q2', windowId: 'w9', host: os.hostname(), sentAt: new Date().toISOString() },
        });
        assert.equal(await queue().takeInbox(), 2);
        const n = queue().items.find((i) => i.originalText === 'q2/rx reports: done');
        assert.ok(n, queue().items.map((i) => i.originalText).join(' | '));
        assert.equal(n.run, 'r2', 'that run\'s lane');
        assert.equal(n.notificationOf, 'abc12345');
        assert.equal(n.from?.run, 'rx');
        const missing = queue().items.find((i) => i.originalText === 'into a missing run')!;
        assert.equal(missing.status, 'error');
        assert.equal(missing.run, 'default');
        assert.match(String(missing.error), /no process run "nope"/);
        clean();
    });

    test('DT-6: a todo walk sent into a run (ww_a_collab-4)', async () => {
        clean();
        put(`_ai/quests/${QUEST}/todos.${QUEST}.todo.yaml`, [
            `quest: ${QUEST}`, 'todos:',
            '  - id: wk-1', '    description: first', '    status: not-started',
            '  - id: wk-2', '    description: second', '    status: not-started', '',
        ].join('\n'));
        assert.equal(store().createRun('r2', 'review', 'user', false).ok, true);
        queue().setRunQueueSettings('r2', { autoSend: false });
        const folder = getQueueFolder()!;
        const from = { quest: 'q2', run: 'rx', windowId: 'w9', host: os.hostname(), sentAt: new Date().toISOString() };
        writeInboxFile(folder, inboxFileName(os.hostname(), getWorkspaceName(), new Date(), 'dt6a'), {
            text: 'walk ${repeatTodoId}', run: 'r2', repeatCount: 'wk-*', from,
        });
        writeInboxFile(folder, inboxFileName(os.hostname(), getWorkspaceName(), new Date(), 'dt6b'), {
            text: 'walk into a missing run', run: 'nope', repeatCount: 'wk-*', from,
        });
        assert.equal(await queue().takeInbox(), 2);
        const walk = queue().items.find((i) => i.originalText === 'walk ${repeatTodoId}');
        assert.ok(walk, queue().items.map((i) => i.originalText).join(' | '));
        assert.equal(walk.run, 'r2', 'that run\'s lane');
        assert.equal(walk.repeatCount, 'wk-*', 'a todo walk');
        assert.equal(walk.todoIdPattern, 'wk-*', 'its todos marked queued');
        assert.equal(walk.status, 'pending');
        const missing = queue().items.find((i) => i.originalText === 'walk into a missing run')!;
        assert.equal(missing.status, 'error');
        assert.equal(missing.run, 'default', 'the run is not created');
        assert.ok(!store().runs().some((r) => r.run === 'nope'), 'no run nope created');
        fs.rmSync(path.join(WS, `_ai/quests/${QUEST}/todos.${QUEST}.todo.yaml`), { force: true });
        clean();
    });

    test('DT-7: a walk\'s claim and its on_done (ww_a_collab-5)', async () => {
        clean();
        put(`_ai/quests/${QUEST}/todos.${QUEST}.todo.yaml`, [
            `quest: ${QUEST}`, 'todos:',
            '  - id: wk-1', '    description: first', '    status: completed',
            '    on_done:', '      action: [notify]', '      notify_prompt: wk-1 is done', '',
        ].join('\n'));
        const sent: string[] = [];
        setTodoOnDonePorts({
            windowQuest: () => QUEST, findTodo: () => undefined, groupPrompt: () => '', writeTarget: () => undefined,
            appendNotes: () => undefined, enqueueLocal: async (send) => { sent.push(send.text); },
            postToQuest: () => undefined, log: () => undefined, today: () => '2026-11-15',
        });
        try {
            const item = await add({ originalText: 'walk', repeatCount: 'wk-*' });
            const claim = { questId: QUEST, todoId: 'wk-1', priorStatus: 'not-started', claimedAt: new Date().toISOString() };
            (item as Json).todoClaim = claim;
            (item as Json).status = 'sending';
            assert.equal(queue().holdsTodoClaim(QUEST, 'wk-1'), true, 'a sending item holds the claim');
            assert.equal(queue().holdsTodoClaim(QUEST, 'wk-2'), false);
            (item as Json).status = 'pending';
            assert.equal(queue().holdsTodoClaim(QUEST, 'wk-1'), false, 'only while it is sent');
            // The settle: the todo is completed now, so its on_done runs once.
            (queue() as Json)._settleTodoOnDone(claim, 'default');
            await wait(50);
            assert.deepEqual(sent, ['wk-1 is done']);
            // A completion left to the claim (deferred) runs at the release too, then is taken.
            deferTodoOnDone(QUEST, 'wk-1');
            (item as Json).todoClaim = { ...claim };
            (queue() as Json).releaseQuestTodoClaim(item, 'test');
            await wait(50);
            assert.deepEqual(sent, ['wk-1 is done', 'wk-1 is done']);
            assert.equal(takeDeferredTodoOnDone(QUEST, 'wk-1'), false);
        } finally {
            setTodoOnDonePorts(undefined);
            fs.rmSync(path.join(WS, `_ai/quests/${QUEST}/todos.${QUEST}.todo.yaml`), { force: true });
            clean();
        }
    });

    test('DT-5: the answer reaches the notification', async () => {
        clean();
        const item = await add({
            originalText: 'File the todos\nof idea tsm', run: 'r1', todoIdPattern: 'tsm1_a',
            doneNotificationPrompt: '${itemTitle}: ${itemOutcome}\n${itemAnswer}\n${itemTodos}',
        });
        queue().setRunQueueSettings('r1', { autoSend: true, autoPause: false });
        await wait(60);
        (queue().getById(item.id) as Json).answerText = 'Filed tsm1_a; kept ${senderQuest} as written.';
        await finish(item);
        const n = notificationOf(item)!;
        assert.equal(n.originalText, 'File the todos: done\nFiled tsm1_a; kept $${senderQuest} as written.\ntsm1_a (status unknown)');

        const posts: Json[] = [];
        queue().setDoneNotificationPoster((p) => { posts.push(p); return { file: 'f.inbox.queue.yaml', targetRunning: true }; });
        try {
            const other = await add({ originalText: 'Report', run: 'r1', doneNotificationPrompt: 'From ${senderQuest}: ${itemAnswer}', doneNotificationQuest: 'q2' });
            queue().setRunAutoSend('r1', true);
            await wait(60);
            await finish(n); // the first notification goes first in r1's lane
            (queue().getById(other.id) as Json).answerText = 'All three filed.';
            await finish(other);
            assert.equal(posts[0].text, `From ${QUEST}: All three filed.`);
            assert.equal(queue().getById(other.id)?.doneNotificationPosted?.waiting, false);
        } finally {
            queue().setDoneNotificationPoster(undefined);
            clean();
        }
    });
});
