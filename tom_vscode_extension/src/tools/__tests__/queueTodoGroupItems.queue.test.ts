/**
 * TODO and GROUP queue items (vscimpb127) through the real manager and its real dispatch; only the transport is a
 * stub. It plays the agent: a turn may set the walked todo's status in the real todo file.
 *
 *   TGI-1 a TODO item runs its one todo: the prompt carries the todo's record, the todo is claimed (in-progress)
 *         while its turn runs; completed, the item is done after one turn; its kind is `todo`, in its entry file too
 *   TGI-2 a TODO item's todo left in-progress gets a continuation in the same session (the walk's completion check)
 *   TGI-3 a GROUP item walks the group's members in `comprised_of` order, one per iteration, passing a user-action,
 *         a completed and a blocked member and one of another quest; its kind is `group`
 *   TGI-4 every item carries its kind: prefix walk, repeated prompt, plain prompt
 *   TGI-5 a GROUP item's selection (vscimpb129): members listed by the rules, checked / unchecked by hand, stored as
 *         `group-selection` in the entry file, shown by tomAi_listQueue and set by tomAi_updateQueueItem; the walk
 *         sends exactly the checked members, in order (a completed and a user-action one too), then the ✓ markers
 */

/* eslint-disable @typescript-eslint/naming-convention -- YAML keys */
import test, { after, describe } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'fs';
import * as path from 'path';
import YAML from 'yaml';

const EXT_ROOT = path.resolve(__dirname, '..', '..', '..');
const SANDBOX = fs.realpathSync(fs.mkdtempSync(path.join(EXT_ROOT, '..', '..', '..', 'ztmp', 'vscode_extension_261116_vscimpb127_items-')));
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

fs.writeFileSync(path.join(QDIR, `todos.${QUEST}.todo.yaml`), `todos:
  - id: solo1_x
    title: the solo todo
    status: not-started
  - id: solo2_x
    title: the lingering todo
    status: not-started
  - id: grp1_x
    title: the group
    status: group
    comprised_of:
      - mem3_x
      - mem1_x
      - mine1_x
      - done1_x
      - wait1_x
      - other/x9
      - q1/mem2_x
  - id: mem1_x
    title: member one
    status: not-started
  - id: mem2_x
    title: member two
    status: not-started
  - id: mem3_x
    title: member three
    status: not-started
  - id: mine1_x
    title: the user's
    status: not-started
    user_action: true
  - id: done1_x
    title: done already
    status: completed
  - id: wait1_x
    title: blocked
    status: blocked
    blocked_by:
      - solo2_x
  - id: pre1_x
    title: prefix one
    status: not-started
`);

import { installVscodeStub } from './_vscode-stub.js';
const vscodeStub = installVscodeStub({ workspaceFolders: [WS] });
(vscodeStub.stub.workspace as Record<string, unknown>).workspaceFile = { fsPath: path.join(WS, `${QUEST}.code-workspace`), scheme: 'file' };

import { ChatVariablesStore } from '../../managers/chatVariablesStore.js';
import { ReminderSystem } from '../../managers/reminderSystem.js';
import { TimerEngine } from '../../managers/timerEngine.js';
import { PromptQueueManager, type QueuedPrompt } from '../../managers/promptQueueManager.js';
import { AnthropicHandler } from '../../handlers/anthropic-handler.js';
import { AskUserRegistry } from '../../services/askUserRegistry.js';
import { findTodoById, updateTodo } from '../../managers/questTodoManager.js';
import { TomAiConfiguration } from '../../utils/tomAiConfiguration.js';
import { setExtensionPath } from '../../handlers/handler_shared.js';
import { todoWalkValue } from '../../utils/queueStep3Utils.js';

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
const wait = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));
const handler = AnthropicHandler.instance as Json;
const originalSend = handler.sendMessage;
after(() => { handler.sendMessage = originalSend; });

const turns: Json[] = [];
let script: (opts: Json, n: number) => string = () => 'done';
handler.sendMessage = async (opts: Json) => {
    turns.push(opts);
    return { text: script(opts, turns.length), turnsUsed: 1, toolCallCount: 0 };
};
const todoOf = (id: string): Json => findTodoById(QUEST, id);
const setStatus = (id: string, status: string): void => { updateTodo(QUEST, id, { status } as never); };
const promptOf = (opts: Json): string => String(opts.prompt ?? opts.userMessage ?? opts.text ?? JSON.stringify(opts));
const walkedIn = (opts: Json): string | undefined => /walk (\w+_x)/.exec(promptOf(opts))?.[1];

function reset(): void {
    queue().autoSendEnabled = false;
    AskUserRegistry.instance.cancel('reset');
    for (const i of [...queue().items]) { queue().remove(i.id); }
    turns.length = 0;
}
async function run(repeatCount: string, opts: Record<string, unknown> = {}): Promise<QueuedPrompt> {
    const item = await queue().enqueue({ originalText: 'walk ${repeatTodoId}', repeatCount, transport: 'anthropic', anthropicProfileId: 'sdk', session: 's-items', deferSend: true, initialStatus: 'pending', ...opts } as never);
    queue().autoSendEnabled = true;
    await wait(500);
    return item;
}
const live = (item: QueuedPrompt): QueuedPrompt => queue().getById(item.id) as QueuedPrompt;
function entryText(id: string): string {
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

describe('TODO and GROUP items', () => {
    test('TGI-1: a TODO item runs its todo with claim and record', async () => {
        reset();
        let statusInTurn = '';
        script = (opts) => { statusInTurn = todoOf('solo1_x').status; setStatus('solo1_x', 'completed'); return `did ${walkedIn(opts)}`; };
        const item = await run(todoWalkValue('todo', QUEST, 'solo1_x'), { todoIdPattern: 'solo1_x' });
        assert.equal(turns.length, 1, 'one turn');
        assert.equal(walkedIn(turns[0]), 'solo1_x');
        assert.match(promptOf(turns[0]), /title: the solo todo/, 'the record is appended');
        assert.equal(statusInTurn, 'in-progress', 'claimed while its turn runs');
        assert.equal(todoOf('solo1_x').status, 'completed');
        assert.equal(live(item).status, 'sent');
        assert.equal(live(item).itemKind, 'todo');
        assert.match(entryText(item.id), /item-kind: todo/);
    });

    test('TGI-2: a TODO item left in-progress gets a continuation', async () => {
        reset();
        script = (_opts, n) => { if (n === 2) { setStatus('solo2_x', 'completed'); } return `turn ${n}`; };
        await run(todoWalkValue('todo', QUEST, 'solo2_x'));
        await wait(500);
        assert.equal(turns.length, 2, 'the first turn left it in-progress: one continuation');
        assert.equal(turns[1].session ?? turns[1].sessionName ?? 's-items', turns[0].session ?? turns[0].sessionName ?? 's-items', 'the same session');
        assert.equal(todoOf('solo2_x').status, 'completed');
    });

    test('TGI-3: a GROUP item walks its members in comprised_of order', async () => {
        reset();
        script = (opts) => { const id = walkedIn(opts); if (id) { setStatus(id, 'completed'); } return `did ${id}`; };
        const item = await run(todoWalkValue('group', QUEST, 'grp1_x'));
        await wait(800);
        assert.deepEqual(turns.map(walkedIn), ['mem3_x', 'mem1_x', 'wait1_x', 'mem2_x'],
            'comprised_of order; the user\'s and the completed are passed, other/x9 is not walked; wait1_x is released once solo2_x (its blocker) is done');
        assert.equal(todoOf('mine1_x').status, 'not-started', 'the user\'s todo is left to the user');
        assert.equal(live(item).itemKind, 'group');
        assert.equal(todoOf('grp1_x').status, 'group', 'still a group: the user\'s todo is open and other/x9 is not found');
        setStatus('mine1_x', 'completed');
        updateTodo(QUEST, 'grp1_x', { comprised_of: ['mem3_x', 'mem1_x', 'mine1_x', 'done1_x', 'wait1_x', 'q1/mem2_x'] } as never);
        setStatus('mem1_x', 'in-progress');
        setStatus('mem1_x', 'completed');
        assert.equal(todoOf('grp1_x').status, 'completed', 'every member done now: the group completes (vscimpb125)');
    });

    test('TGI-5: a GROUP item\'s selection: stored, listed, and the walk sends exactly the checked', async () => {
        reset();
        // Added to the todo file as it is now (earlier tests rewrote it through the todo writers).
        const file = path.join(QDIR, `todos.${QUEST}.todo.yaml`);
        const doc = YAML.parse(fs.readFileSync(file, 'utf8')) as { todos: Json[] };
        doc.todos.push(
            { id: 'grp2_x', title: 'the second group', status: 'group', comprised_of: ['sel1_x', 'sel2_x', 'sel3_x', 'sel4_x'] },
            { id: 'sel1_x', title: 'open one', status: 'not-started' },
            { id: 'sel2_x', title: 'done one', status: 'completed' },
            { id: 'sel3_x', title: 'open three', status: 'not-started' },
            { id: 'sel4_x', title: 'the user\'s four', status: 'not-started', user_action: true },
        );
        fs.writeFileSync(file, YAML.stringify(doc));
        const item = await queue().enqueue({ originalText: 'walk ${repeatTodoId}', repeatCount: todoWalkValue('group', QUEST, 'grp2_x'), transport: 'anthropic', anthropicProfileId: 'sdk', session: 's-items', deferSend: true } as never);
        const marks = (): string[] => (queue().groupMembers(item.id) ?? []).map((m) => `${m.id}:${m.marker}:${m.checked ?? m.outcome}`);
        assert.deepEqual(marks(), ['sel1_x:todo:true', 'sel2_x:todo:false', 'sel3_x:todo:true', 'sel4_x:todo:false'], 'the rules');
        assert.ok(queue().setGroupSelection(item.id, { member: 'sel2_x', checked: true }), 'a completed member checked by hand');
        assert.ok(queue().setGroupSelection(item.id, { member: 'sel3_x', checked: false }));
        assert.deepEqual(marks(), ['sel1_x:todo:true', 'sel2_x:todo:true', 'sel3_x:todo:false', 'sel4_x:todo:false']);
        await wait(300);
        assert.match(entryText(item.id), /group-selection:\s*\n\s+checked:\s*\n\s+- sel2_x\s*\n\s+unchecked:\s*\n\s+- sel3_x/, 'persisted in the entry file');

        // The tools: listQueue shows the members with their marker; updateQueueItem takes groupSelection.
        const { QUEUE_LIST_TOOL, QUEUE_UPDATE_ITEM_TOOL } = await import('../chat-enhancement-tools.js');
        const listed = JSON.parse(await QUEUE_LIST_TOOL.execute({}) as string).items.find((i: Json) => i.id === item.id);
        assert.deepEqual(listed.members.map((m: Json) => `${m.id} ${m.marker}`), ['sel1_x ☑', 'sel2_x ☑', 'sel3_x ☐', 'sel4_x ☐']);
        assert.equal(listed.members[1].chosen, true);
        const refused = JSON.parse(await QUEUE_UPDATE_ITEM_TOOL.execute({ queueItemId: item.id, groupSelection: ['nope_x'] }) as string);
        assert.equal(refused.ok, false);
        const updated = JSON.parse(await QUEUE_UPDATE_ITEM_TOOL.execute({ queueItemId: item.id, groupSelection: ['sel2_x', 'sel4_x'] }) as string);
        assert.equal(updated.ok, true, JSON.stringify(updated));
        assert.deepEqual(marks(), ['sel1_x:todo:false', 'sel2_x:todo:true', 'sel3_x:todo:false', 'sel4_x:todo:true']);

        // Run it: exactly sel2_x and sel4_x, in order.
        script = (opts) => { const id = walkedIn(opts); if (id) { setStatus(id, 'completed'); } return `did ${id}`; };
        queue().setStatus(item.id, 'pending');
        queue().autoSendEnabled = true;
        await wait(900);
        assert.deepEqual(turns.map(walkedIn), ['sel2_x', 'sel4_x'], 'a completed and a user-action member checked; the open unchecked ones passed');
        assert.equal(todoOf('sel1_x').status, 'not-started');
        assert.equal(todoOf('sel3_x').status, 'not-started');
        assert.equal(live(item).status, 'sent');
        assert.deepEqual(marks(), ['sel1_x:todo:false', 'sel2_x:sent:completed', 'sel3_x:todo:false', 'sel4_x:sent:completed']);
        assert.equal(queue().setGroupSelection(item.id, { all: true }), false, 'a sent item\'s selection is fixed');
    });

    test('TGI-4: every item carries its kind', async () => {
        reset();
        queue().autoSendEnabled = false;
        const prefix = await queue().enqueue({ originalText: 'p ${repeatTodoId}', repeatCount: 'pre*', deferSend: true } as never);
        const repeated = await queue().enqueue({ originalText: 'again', repeatCount: 3, deferSend: true } as never);
        const plain = await queue().enqueue({ originalText: 'once', deferSend: true } as never);
        assert.deepEqual([prefix, repeated, plain].map((i) => live(i).itemKind), ['prefix', 'iteration', 'prompt']);
        assert.match(entryText(repeated.id), /item-kind: iteration/);
    });
});
