/**
 * One todo, one waiting queue item (src/utils/todoQueueDuplicates.ts, PromptQueueManager.enqueue), vscimpb77,
 * through the real queue manager under the vscode stub.
 *
 *   QD-1 the rule: an item staged, pending or sending holds its todo id pattern (a todo id, `<prefix>*` — given or
 *        from a walk's repeat count — or several comma-separated, compared without the spaces around the commas);
 *        a finished or failed one does not; the notice names the todo (or the walk), the item's status and id
 *   QD-2 the queue: a second enqueue of a queued todo is refused with TodoAlreadyQueuedError and adds nothing (the
 *        queue log says so); `allowDuplicateTodo` adds it as a deliberate repeat; another todo, a walk over another
 *        prefix and items without a todo are not touched; once the item has finished the todo can be queued again
 *   QD-3 tomAi_addQueueItem answers the refusal as its error and takes `allowDuplicateTodo`; an item another
 *        quest sends (the inbox) is queued even when its todos are
 */

import test, { after, describe } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'fs';
import * as path from 'path';

const EXT_ROOT = path.resolve(__dirname, '..', '..', '..');
const SANDBOX = fs.realpathSync(fs.mkdtempSync(path.join(EXT_ROOT, '..', '..', '..', 'ztmp', 'vscode_extension_261113_vscimpb77_queuedup-')));
const WS = path.join(SANDBOX, 'ws');
const HOME = path.join(SANDBOX, 'home');
const QUEST = 'q1';
const TODOS = ['todos:', '  - id: t1', '    title: One', '    status: not-started', '  - id: walk1_x', '    title: W', '    status: not-started', ''].join('\n');
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
import { isTodoAlreadyQueued, normalizedTodoPattern, queuedItemForTodoPattern, todoAlreadyQueuedNotice, TodoAlreadyQueuedError, WAITING_OR_RUNNING } from '../../utils/todoQueueDuplicates.js';
import { ADD_TO_PROMPT_QUEUE_TOOL } from '../chat-enhancement-tools.js';

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
function clear(): void { for (const i of [...queue().items]) { queue().remove(i.id); } }

describe('one todo, one waiting queue item', () => {
    test('QD-1: the rule', () => {
        assert.deepEqual([...WAITING_OR_RUNNING].sort(), ['pending', 'sending', 'staged']);
        assert.equal(normalizedTodoPattern(' a1 , b* '), 'a1,b*');
        assert.equal(normalizedTodoPattern('  '), undefined);
        const items = [
            { id: 'i1', status: 'sent', todoIdPattern: 'a1' },
            { id: 'i2', status: 'error', todoIdPattern: 'a1' },
            { id: 'i3', status: 'staged', todoIdPattern: 'b1, b2' },
            { id: 'i4', status: 'sending', repeatCount: 'grp*' },
            { id: 'i5', status: 'pending', todoIdPattern: 'c1' },
        ];
        assert.equal(queuedItemForTodoPattern(items, 'a1'), undefined, 'finished or failed: not holding it');
        assert.equal(queuedItemForTodoPattern(items, 'b1,b2')?.id, 'i3');
        assert.equal(queuedItemForTodoPattern(items, 'b1'), undefined, 'the whole pattern is compared');
        assert.equal(queuedItemForTodoPattern(items, 'grp*')?.id, 'i4', 'a walk from its repeat count');
        assert.equal(queuedItemForTodoPattern(items, 'c1')?.id, 'i5');
        assert.equal(queuedItemForTodoPattern(items, undefined), undefined);
        assert.equal(todoAlreadyQueuedNotice('c1', { id: 'abcdef123456', status: 'pending' }), 'Todo c1 is already in the prompt queue (pending, item abcdef12): not added again.');
        assert.match(todoAlreadyQueuedNotice('grp*', { id: 'x', status: 'sending' }), /^The walk over grp\* is already in the prompt queue/);
        const e = new TodoAlreadyQueuedError('c1', 'i5', 'pending');
        assert.ok(isTodoAlreadyQueued(e));
        assert.ok(isTodoAlreadyQueued(Object.assign(new Error('x'), { name: 'TodoAlreadyQueuedError' })), 'by name too');
        assert.ok(!isTodoAlreadyQueued(new Error('x')));
    });

    test('QD-2: the queue', async () => {
        clear();
        queue().autoSendEnabled = false;
        const first = await queue().enqueue({ originalText: 'do t1', todoIdPattern: 't1', deferSend: true });
        await assert.rejects(queue().enqueue({ originalText: 'do t1 again', todoIdPattern: 't1', deferSend: true }),
            (e: unknown) => isTodoAlreadyQueued(e) && (e as TodoAlreadyQueuedError).existingId === first.id && /Todo t1 is already in the prompt queue \((staged|pending), item /.test((e as Error).message));
        assert.equal(queue().items.filter((i) => i.todoIdPattern === 't1').length, 1, 'nothing added');
        await assert.rejects(queue().enqueue({ originalText: 'pending too', todoIdPattern: ' t1 ', initialStatus: 'pending', deferSend: true }), (e: unknown) => isTodoAlreadyQueued(e));
        const repeat = await queue().enqueue({ originalText: 'deliberately', todoIdPattern: 't1', deferSend: true, allowDuplicateTodo: true });
        assert.equal(repeat.todoIdPattern, 't1');
        assert.equal(queue().items.filter((i) => i.todoIdPattern === 't1').length, 2, 'a deliberate repeat');
        // Walks: the same prefix is refused, another is not; items without a todo are never touched.
        await queue().enqueue({ originalText: 'walk', repeatCount: 'walk*', deferSend: true });
        await assert.rejects(queue().enqueue({ originalText: 'walk again', repeatCount: 'walk*', deferSend: true }), /The walk over walk\* is already in the prompt queue/);
        await assert.rejects(queue().enqueue({ originalText: 'walk named', todoIdPattern: 'walk*', deferSend: true }), (e: unknown) => isTodoAlreadyQueued(e));
        await queue().enqueue({ originalText: 'other walk', repeatCount: 'other*', deferSend: true });
        await queue().enqueue({ originalText: 'plain', deferSend: true });
        await queue().enqueue({ originalText: 'plain', deferSend: true });
        // Finished: the todo is free again.
        for (const i of queue().items.filter((x) => x.todoIdPattern === 't1')) { i.status = 'sent'; }
        const again = await queue().enqueue({ originalText: 'after it ran', todoIdPattern: 't1', deferSend: true });
        assert.ok(['staged', 'pending'].includes(again.status), 'added');
        clear();
    });

    test('QD-3: the tool and the inbox', async () => {
        clear();
        queue().autoSendEnabled = false;
        const one = JSON.parse(await ADD_TO_PROMPT_QUEUE_TOOL.execute({ text: 'by an agent', todoIdPattern: 't1' }));
        assert.equal(one.ok, true, JSON.stringify(one));
        const two = JSON.parse(await ADD_TO_PROMPT_QUEUE_TOOL.execute({ text: 'by an agent again', todoIdPattern: 't1' }));
        assert.equal(two.ok, false);
        assert.match(two.error, /Todo t1 is already in the prompt queue \((staged|pending), item /);
        const three = JSON.parse(await ADD_TO_PROMPT_QUEUE_TOOL.execute({ text: 'on purpose', todoIdPattern: 't1', allowDuplicateTodo: true }));
        assert.equal(three.ok, true, JSON.stringify(three));
        assert.match(JSON.stringify(ADD_TO_PROMPT_QUEUE_TOOL.inputSchema), /"allowDuplicateTodo":\{"type":"boolean"/);
        const manager = fs.readFileSync(path.join(EXT_ROOT, 'src', 'managers', 'promptQueueManager.ts'), 'utf8');
        assert.match(manager, /const withoutSession = \{ \.\.\.conversion\.enqueue, session: undefined, temporarySession: undefined, allowDuplicateTodo: true \};/);
        assert.match(manager, /: \{ \.\.\.conversion\.enqueue, initialStatus: 'pending', allowDuplicateTodo: true \}\);/);
        clear();
    });
});
