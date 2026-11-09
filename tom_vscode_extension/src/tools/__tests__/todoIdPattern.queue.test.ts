/**
 * The todo id pattern of queue items (QueuedPrompt.todoIdPattern), through the
 * real queue manager under the vscode stub, and the todo panel's marks.
 *
 *   TP-1 enqueue keeps a given pattern, takes `<prefix>*` from a walk's repeat count, none otherwise
 *   TP-2 the entry file carries it (`todo-id-pattern`) and a reload reads it back
 *   TP-3 the todo panel: Add to queue sets the todo's id; a posted list marks the queued todos with the queue
 *        editor's numbers and the tooltip (a walk its open todos only); when the queue changes the webview is
 *        told (qtQueueChanged) and the list it loads again has no stale marks
 *   TP-4 tomAi_addQueueItem takes todoIdPattern; tomAi_listQueue shows each item's pattern, a walk's too
 *   TP-5 a repeated item's answers per repetition (repetitionAnswers) are kept in its entry file
 *        (`repetition-answers`) and read back after a reload
 */

import test, { after, describe } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

const SANDBOX = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'todo-pattern-')));
const WS = path.join(SANDBOX, 'ws');
const HOME = path.join(SANDBOX, 'home');
const QUEST = 'q1';
const EXT_ROOT = path.resolve(__dirname, '..', '..', '..');
const TODOS = [
    'todos:',
    '  - id: walk1_akiw-first',
    '    title: First of the walk',
    '    status: not-started',
    '  - id: walk2_akiw-second',
    '    title: Second of the walk',
    '    status: completed',
    '  - id: solo1_akiw-alone',
    '    title: Queued alone',
    '    status: not-started',
    '',
].join('\n');
for (const [rel, text] of [[`_ai/quests/${QUEST}/overview.${QUEST}.md`, '# Q1\n'], ['.tom/tom_vscode_extension.json', '{}\n'], [`_ai/quests/${QUEST}/todos.${QUEST}.todo.yaml`, TODOS]]) {
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
import { PromptQueueManager } from '../../managers/promptQueueManager.js';
import { TomAiConfiguration } from '../../utils/tomAiConfiguration.js';
import { setExtensionPath } from '../../handlers/handler_shared.js';
import { handleQuestTodoMessage } from '../../handlers/questTodoPanel-handler.js';
import { ADD_TO_PROMPT_QUEUE_TOOL, QUEUE_LIST_TOOL } from '../chat-enhancement-tools.js';

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
const wait = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));
function clear(): void { for (const i of [...queue().items]) { queue().remove(i.id); } }

/** A webview stand-in that records what is posted to it. */
function fakeWebview(): { webview: never; posted: Array<Record<string, unknown>> } {
    const posted: Array<Record<string, unknown>> = [];
    return { webview: { postMessage: async (m: Record<string, unknown>) => { posted.push(JSON.parse(JSON.stringify(m))); return true; } } as never, posted };
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Json = any;
const todosOf = (posted: Array<Record<string, unknown>>): Json[] => (posted.filter((m) => m.type === 'qtTodos').pop()?.todos ?? []) as Json[];

describe('the todo id pattern of queue items', () => {
    test('TP-1: set on enqueue', async () => {
        clear();
        queue().autoSendEnabled = false;
        const one = await queue().enqueue({ originalText: 'one todo', todoIdPattern: 'solo1_akiw-alone', deferSend: true });
        const walk = await queue().enqueue({ originalText: 'the walk', repeatCount: 'walk*', deferSend: true });
        const plain = await queue().enqueue({ originalText: 'no todo', deferSend: true });
        assert.equal(one.todoIdPattern, 'solo1_akiw-alone');
        assert.equal(walk.todoIdPattern, 'walk*', 'a group walk gives it');
        assert.equal(plain.todoIdPattern, undefined);
        clear();
    });

    test('TP-2: kept in the entry file', async () => {
        clear();
        const item = await queue().enqueue({ originalText: 'one todo', todoIdPattern: 'solo1_akiw-alone,walk*', deferSend: true });
        const folder = path.join(WS, '_ai', 'queue');
        const file = fs.readdirSync(folder).map((f) => fs.readFileSync(path.join(folder, f), 'utf8')).find((t) => t.includes(item.id));
        assert.match(file ?? '', /todo-id-pattern: solo1_akiw-alone,walk\*/);
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        (queue() as any)._reloadFromDisk();
        await wait(400);
        assert.equal(queue().getById(item.id)?.todoIdPattern, 'solo1_akiw-alone,walk*', 'read back');
        clear();
    });

    test('TP-3: the todo panel', async () => {
        clear();
        queue().autoSendEnabled = false;
        const { webview, posted } = fakeWebview();
        await handleQuestTodoMessage({ type: 'qtAddCurrentTodoToQueue', questId: QUEST, todoId: 'solo1_akiw-alone' }, webview);
        const added = queue().items.find((i) => i.todoIdPattern === 'solo1_akiw-alone');
        assert.ok(added, 'Add to queue sets the todo id');
        await queue().enqueue({ originalText: 'the walk', repeatCount: 'walk*', deferSend: true });
        await handleQuestTodoMessage({ type: 'qtGetTodos', questId: QUEST, file: 'all' }, webview);
        const rows = todosOf(posted);
        const byId = (id: string): Json => rows.find((t) => t.id === id);
        assert.deepEqual(byId('solo1_akiw-alone').queued, [1]);
        assert.equal(byId('solo1_akiw-alone').queuedTitle, 'Queued: #1');
        assert.deepEqual(byId('walk1_akiw-first').queued, [2], 'the walk names its open todo');
        assert.equal(byId('walk2_akiw-second').queued, undefined, 'not the completed one');
        // The queue changes: the webview is told, and the list it loads again has no marks.
        posted.length = 0;
        clear();
        await wait(50);
        assert.ok(posted.some((m) => m.type === 'qtQueueChanged'), 'told about the change');
        await handleQuestTodoMessage({ type: 'qtGetTodos', questId: QUEST, file: 'all' }, webview);
        assert.ok(todosOf(posted).every((t) => t.queued === undefined), 'nothing queued any more');
        clear();
    });

    test('TP-4: the queue tools', async () => {
        clear();
        const added = JSON.parse(await ADD_TO_PROMPT_QUEUE_TOOL.execute({ text: 'from an agent', todoIdPattern: ' solo1_akiw-alone ' }));
        assert.equal(added.ok, true, JSON.stringify(added));
        await queue().enqueue({ originalText: 'the walk', repeatCount: 'walk*', deferSend: true });
        const listed = JSON.parse(await QUEUE_LIST_TOOL.execute({}));
        const patterns = (listed.items as Json[]).map((i) => i.todoIdPattern).sort();
        assert.deepEqual(patterns, ['solo1_akiw-alone', 'walk*']);
        assert.match(JSON.stringify((ADD_TO_PROMPT_QUEUE_TOOL as Json).inputSchema), /todo panel marks them queued/);
        clear();
    });

    test('TP-5: the answers of every repetition are kept', async () => {
        clear();
        const item = await queue().enqueue({ originalText: 'the walk', repeatCount: 'walk*', deferSend: true });
        item.repetitionAnswers = [{ key: 'walk1_akiw-first', text: 'first answer', at: '2026-11-09T10:00:00.000Z' }, { key: 'walk3_x', text: 'third answer', at: '2026-11-09T11:00:00.000Z' }];
        await queue().updateText(item.id, 'the walk, edited');
        const folder = path.join(WS, '_ai', 'queue');
        const file = fs.readdirSync(folder).map((f) => fs.readFileSync(path.join(folder, f), 'utf8')).find((t) => t.includes(item.id));
        assert.match(file ?? '', /repetition-answers:/);
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        (queue() as any)._reloadFromDisk();
        await wait(400);
        assert.deepEqual(queue().getById(item.id)?.repetitionAnswers, item.repetitionAnswers, 'read back');
        clear();
    });
});
