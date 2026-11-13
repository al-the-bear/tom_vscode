/**
 * One action, one item: the todo views' queue and send paths (questTodoPanel-handler.ts, media/questTodoPanel/main.js;
 * the side QUEST TODOS view and the @WS Quest TODO section share both), vscimpb77. Through the real todo panel
 * handler under the vscode stub; the prompt queue's enqueue (with the queue's own one-todo-one-item rule) and the
 * Anthropic send are replaced, so the test counts what reaches them.
 *
 *   PD-1 the webview: one click on the bar's Save to Queue posts one message, and a burst of three clicks within
 *        110 ms posts one (the button is paused 2 s); the same for the bar's Send and a group's walk button; the
 *        side view and the @WS section load the script once each (one listener per button)
 *   PD-2 a burst of three messages within 110 ms reaches the queue or the send once, on every path: add to queue,
 *        the detail's Queue / Send / Guide me, the bar's Send, stacked Queue (one item per todo, once), stacked
 *        Send (one prompt), the group walk (asked once)
 *   PD-3 a different todo, template or action right after is not swallowed
 *   PD-4 a todo already in the queue (staged, pending or sending) is not added again: the notice says so and
 *        offers Queue again, which adds it as a deliberate repeat (allowDuplicateTodo); stacked Queue adds the
 *        others and names the queued ones
 */

/* eslint-disable @typescript-eslint/naming-convention -- YAML keys */
import test, { after, describe } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'fs';
import * as path from 'path';
import { JSDOM } from 'jsdom';

const EXT_ROOT = path.resolve(__dirname, '..', '..', '..');
const SANDBOX = fs.realpathSync(fs.mkdtempSync(path.join(EXT_ROOT, '..', '..', '..', 'ztmp', 'vscode_extension_261113_vscimpb77_doublesubmit-')));
const WS = path.join(SANDBOX, 'ws');
const HOME = path.join(SANDBOX, 'home');
const QUEST = 'q1';
function put(rel: string, text: string): void {
    const abs = path.join(WS, rel);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, text);
}
const todo = (id: string, extra: string[] = []): string[] => [`  - id: ${id}`, `    title: ${id.toUpperCase()}`, `    description: do ${id}`, '    status: not-started', '    priority: medium', ...extra];
put(`_ai/quests/${QUEST}/overview.${QUEST}.md`, '# Q1\n');
put(`_ai/quests/${QUEST}/todos.${QUEST}.todo.yaml`, ['todos:',
    ...todo('a1'), ...todo('a2'), ...todo('a3'), ...todo('b1'), ...todo('b2'), ...todo('c1'), ...todo('c2'), ...todo('d1'), ...todo('d2'), ...todo('d3'),
    ...todo('e1'), ...todo('e2'), ...todo('u1', ['    user_action: true']), ''].join('\n'));
put('.tom/tom_vscode_extension.json', JSON.stringify({ anthropic: { userMessageTemplates: [
    { id: 'execute-todo', name: 'Execute TODO', template: 'EXEC ${userMessage}' },
    { id: 'guide-user-action', name: 'Guide me', template: 'GUIDE ${userMessage}' },
] } }, null, 2));
fs.mkdirSync(HOME, { recursive: true });
process.env.HOME = HOME;
process.env.USERPROFILE = HOME;

import { installVscodeStub } from '../../tools/__tests__/_vscode-stub.js';
const vscodeStub = installVscodeStub({ workspaceFolders: [WS] });
(vscodeStub.stub.workspace as Record<string, unknown>).workspaceFile = { fsPath: path.join(WS, `${QUEST}.code-workspace`), scheme: 'file' };

import { ChatVariablesStore } from '../../managers/chatVariablesStore.js';
import { ProcessStateStore } from '../../managers/processStateStore.js';
import { PromptQueueManager } from '../../managers/promptQueueManager.js';
import { TomAiConfiguration } from '../../utils/tomAiConfiguration.js';
import { queuedItemForTodoPattern, TodoAlreadyQueuedError } from '../../utils/todoQueueDuplicates.js';
import { todoIdPatternOf } from '../../utils/todoQueueMarks.js';
import { setExtensionPath } from '../handler_shared.js';
import { handleQuestTodoMessage, setQuestTodoContext } from '../questTodoPanel-handler.js';
import * as router from '../sendToChatRouter.js';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Json = any;
(function start(): void {
    const storage = path.join(SANDBOX, 'storage');
    fs.mkdirSync(storage, { recursive: true });
    const memento = (): unknown => {
        const values = new Map<string, unknown>();
        return { get: (k: string, d?: unknown) => values.has(k) ? values.get(k) : d, update: async (k: string, v: unknown) => { if (v === undefined) { values.delete(k); } else { values.set(k, v); } }, keys: () => [...values.keys()], setKeysForSync: () => undefined };
    };
    const context = {
        subscriptions: [], extensionPath: EXT_ROOT, extensionUri: { fsPath: EXT_ROOT, scheme: 'file', path: EXT_ROOT },
        globalStorageUri: { fsPath: storage, scheme: 'file' }, storageUri: { fsPath: storage, scheme: 'file' }, logUri: { fsPath: storage, scheme: 'file' },
        globalStoragePath: storage, storagePath: storage, logPath: storage, globalState: memento(), workspaceState: memento(),
        asAbsolutePath: (rel: string) => path.join(EXT_ROOT, rel),
    };
    setExtensionPath(EXT_ROOT);
    TomAiConfiguration.init(context as never);
    ChatVariablesStore.init(context as never);
    ProcessStateStore.init(context as never);
    setQuestTodoContext(context as never);
})();

// The queue: records every enqueue and applies the queue's one-todo-one-item rule (todoQueueDuplicates.ts).
const enqueued: Json[] = [];
const items: Json[] = [];
const sends: Json[] = [];
(PromptQueueManager as Json)._inst = {
    get items() { return items; },
    enqueue: async (o: Json) => {
        const pattern = todoIdPatternOf({ todoIdPattern: o.todoIdPattern, repeatCount: o.repeatCount });
        const existing = pattern && !o.allowDuplicateTodo ? queuedItemForTodoPattern(items, pattern) : undefined;
        if (existing) { throw new TodoAlreadyQueuedError(pattern!, existing.id, existing.status); }
        enqueued.push(o);
        const item = { id: `item-${enqueued.length}-0000`, status: 'staged', ...o };
        items.push(item);
        return item;
    },
    runQueueSettings: () => ({ defaultTransport: 'anthropic' }),
    get defaultTransport() { return 'anthropic'; },
};
const originalSend = router.runAnthropicSend;
(router as Json).runAnthropicSend = async (_ctx: unknown, prompt: string, opts: Json) => { sends.push({ prompt, ...opts }); return { target: 'anthropic', ok: true }; };
after(() => {
    (router as Json).runAnthropicSend = originalSend;
    (PromptQueueManager as Json)._inst = undefined;
    vscodeStub.restore();
    fs.rmSync(SANDBOX, { recursive: true, force: true });
});

const webview: Json = { postMessage: async () => true };
const send = (msg: Json): Promise<boolean> => handleQuestTodoMessage({ questId: QUEST, ...msg }, webview);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
/** Three copies of one message within 110 ms (0, 50, 105 ms), handled side by side as the webview delivers them. */
async function burst(msg: Json): Promise<void> {
    const runs = [send(msg)];
    await sleep(50);
    runs.push(send(msg));
    await sleep(55);
    runs.push(send(msg));
    await Promise.all(runs);
}
const warnings = (): string[] => vscodeStub.spies.byMethod('window.showWarningMessage').map((c: Json) => String(c.args[0]));
const statusNotes = (): string[] => vscodeStub.spies.byMethod('window.setStatusBarMessage').map((c: Json) => String(c.args[0]));

function panelWindow(t: { after(fn: () => void): void }): { w: Json; posted: Json[] } {
    const read = (...p: string[]) => fs.readFileSync(path.join(EXT_ROOT, 'media', ...p), 'utf-8');
    const w = new JSDOM(`<body>${read('questTodoPanel', 'fragment.html')}</body>`, { runScripts: 'outside-only' }).window as Json;
    t.after(() => w.close());
    const posted: Json[] = [];
    w.vscode = { postMessage: (m: Json) => posted.push(JSON.parse(JSON.stringify(m))), getState: () => undefined, setState: () => undefined };
    w.eval('var qtViewConfig = {};\n' + read('questTodoPanel', 'grouping.js') + read('questTodoPanel', 'main.js'));
    return { w, posted };
}

describe('the todo views: one action, one item', () => {
    test('PD-1: the webview', async (t) => {
        const { w, posted } = panelWindow(t);
        w.eval(`qtSelectedTodoId = 'a1'; qtDetailTodo = { id: 'a1' }; qtTodos = [{ id: 'a1', status: 'not-started' }, { id: 'grp1_x', status: 'not-started' }, { id: 'grp2_x', status: 'not-started' }];`);
        const count = (type: string) => posted.filter((m) => m.type === type).length;
        const add = w.document.getElementById('qt-btn-add-queue');
        add.click();
        assert.equal(count('qtAddCurrentTodoToQueue'), 1, 'one click, one message');
        add.click(); await sleep(50); add.click(); await sleep(55); add.click();
        assert.equal(count('qtAddCurrentTodoToQueue'), 1, 'a burst while it is paused: nothing more');
        assert.equal(add.disabled, true);
        const sendBtn = w.document.getElementById('qt-btn-send-copilot');
        assert.ok(sendBtn, 'the bar\'s Send');
        sendBtn.click(); sendBtn.click(); sendBtn.click();
        assert.equal(count('qtSendCurrentTodoToCopilot'), 1);
        w.qtRenderList();
        const walk = w.document.querySelector('.qt-group-walk-btn');
        assert.ok(walk, 'a group header with its walk button');
        walk.click(); walk.click(); walk.click();
        assert.equal(count('qtQueueGroupPrompt'), 1);
        const js = fs.readFileSync(path.join(EXT_ROOT, 'media', 'questTodoPanel', 'main.js'), 'utf-8');
        assert.match(js, /if \(addQueueBtn\.disabled\) return;\s*qtPauseButton\(addQueueBtn\);/);
        // One script per view: the side view's page and the @WS panel's include it once each.
        const host = fs.readFileSync(path.join(EXT_ROOT, 'src', 'handlers', 'questTodoPanel-handler.ts'), 'utf-8');
        const ws = fs.readFileSync(path.join(EXT_ROOT, 'src', 'handlers', 'wsPanel-handler.ts'), 'utf-8');
        assert.equal((ws.match(/getQuestTodoScript\(\)/g) ?? []).length, 1);
        assert.equal((host.match(/onDidReceiveMessage\(async \(message\) => \{\s*await handleQuestTodoMessage\(message, webviewView\.webview\);/g) ?? []).length, 1, 'one listener per resolved view');
    });

    test('PD-2: a burst of three messages within 110 ms', async () => {
        const before = () => ({ q: enqueued.length, s: sends.length });
        let b = before();
        await burst({ type: 'qtAddCurrentTodoToQueue', todoId: 'a1', template: '__none__' });
        assert.equal(enqueued.length - b.q, 1, 'add to queue');
        assert.equal(enqueued.at(-1).todoIdPattern, 'a1');
        b = before();
        await burst({ type: 'qtTodoButton', target: 'queue', todoId: 'a2' });
        assert.equal(enqueued.length - b.q, 1, 'the detail\'s Queue');
        b = before();
        await burst({ type: 'qtTodoButton', target: 'chat', todoId: 'a3' });
        assert.equal(sends.length - b.s, 1, 'the detail\'s Send');
        b = before();
        await burst({ type: 'qtGuideUserAction', target: 'queue', todoId: 'u1' });
        assert.equal(enqueued.length - b.q, 1, 'Guide me (queue)');
        b = before();
        await burst({ type: 'qtSendCurrentTodoToCopilot', todoId: 'b1', template: '__none__' });
        assert.equal(sends.length - b.s, 1, 'the bar\'s Send');
        b = before();
        await burst({ type: 'qtQueueStackedTodos', todos: [{ todoId: 'c1' }, { todoId: 'c2' }], template: '__none__' });
        assert.deepEqual(enqueued.slice(b.q).map((o) => o.todoIdPattern), ['c1', 'c2'], 'stacked Queue: one item per todo, once');
        b = before();
        await burst({ type: 'qtSendStackedTodos', todos: [{ todoId: 'd1' }, { todoId: 'd2' }], template: '__none__' });
        assert.equal(sends.length - b.s, 1, 'stacked Send: one prompt');
        const walkAsked = () => warnings().filter((m) => m.startsWith('A group walk goes over')).length;
        const asked = walkAsked();
        // The window works on another quest, so each walk that gets through is answered by the quest check (no picker).
        const windowQuest = ChatVariablesStore.instance.quest;
        ChatVariablesStore.instance.set('quest', 'other', 'user');
        await burst({ type: 'qtQueueGroupPrompt', prefix: 'e' });
        ChatVariablesStore.instance.set('quest', windowQuest || '', 'user');
        assert.equal(walkAsked() - asked, 1, 'the group walk: handled once (here: the quest check answers)');
        assert.ok(statusNotes().some((m) => /Already queued: todo a1 within 3 s/.test(m)));
        assert.ok(statusNotes().some((m) => /Already sent: todo b1 within 3 s/.test(m)));
    });

    test('PD-3: a different todo, template or action is not swallowed', async () => {
        const q = enqueued.length;
        const s = sends.length;
        await send({ type: 'qtAddCurrentTodoToQueue', todoId: 'd3', template: '__none__' });
        await send({ type: 'qtSendCurrentTodoToCopilot', todoId: 'd3', template: '__none__' });
        await send({ type: 'qtSendCurrentTodoToCopilot', todoId: 'd3', template: 'execute-todo' });
        assert.equal(enqueued.length - q, 1);
        assert.equal(sends.length - s, 2, 'Send after Queue, and another template');
    });

    test('PD-4: a todo already queued', async () => {
        const win = vscodeStub.stub.window as Json;
        const original = win.showWarningMessage;
        const offered: Json[] = [];
        let answer: string | undefined;
        win.showWarningMessage = (message: string, ...buttons: string[]) => { offered.push({ message, buttons }); return Promise.resolve(answer); };
        try {
            // e1 is queued (staged); adding it again with another template (past the 3-s guard) is refused.
            await send({ type: 'qtAddCurrentTodoToQueue', todoId: 'e1', template: '__none__' });
            const q = enqueued.length;
            await send({ type: 'qtAddCurrentTodoToQueue', todoId: 'e1', template: 'execute-todo' });
            await sleep(10);
            assert.equal(enqueued.length, q, 'not added again');
            assert.match(offered.at(-1).message, /^Todo e1 is already in the prompt queue \(staged, item item-[\d-]+\): not added again\.$/);
            assert.deepEqual(offered.at(-1).buttons, ['Queue again']);
            // Queue again: a deliberate repeat.
            answer = 'Queue again';
            await send({ type: 'qtAddCurrentTodoToQueue', todoId: 'e1', template: 'other-template' });
            await sleep(20);
            assert.equal(enqueued.length, q + 1);
            assert.equal(enqueued.at(-1).allowDuplicateTodo, true);
            assert.equal(enqueued.at(-1).todoIdPattern, 'e1');
            // Stacked Queue: e2 is added, e1 (queued) is named.
            answer = undefined;
            await send({ type: 'qtQueueStackedTodos', todos: [{ todoId: 'e1' }, { todoId: 'e2' }], template: 'stack-tpl' });
            await sleep(10);
            assert.equal(enqueued.at(-1).todoIdPattern, 'e2');
            assert.match(offered.at(-1).message, /Todo e1 is already in the prompt queue/);
            // A sent item does not hold its todo: once e2's item has run, e2 can be queued again.
            items.find((i) => i.todoIdPattern === 'e2').status = 'sent';
            await send({ type: 'qtAddCurrentTodoToQueue', todoId: 'e2', template: 'after-sent' });
            assert.equal(enqueued.at(-1).todoIdPattern, 'e2');
            assert.equal(enqueued.at(-1).allowDuplicateTodo, undefined);
        } finally {
            win.showWarningMessage = original;
        }
    });
});
