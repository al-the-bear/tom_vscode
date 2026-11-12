/**
 * The todo panel's session and run (vscimpb60d), through the real todo panel handler, process store and chat
 * variables store under the vscode stub; only the prompt queue's enqueue and the Anthropic send are replaced, so
 * the test sees what they are given.
 *
 *   TR-1 the selection rules (utils/todoPanelRunSession.ts): the default session `chat`; a run of the quest kept,
 *        another `default`; the session of a run `<session>@<run>`
 *   TR-2 the host answers qtGetRunSession with the session, the run and the run select's options (`default` first);
 *        qtSetRun keeps the run (per window and quest), a run the quest does not have is `default`; every view
 *        showing the controls hears the change
 *   TR-3 Send, Queue and Guide me (qtTodoButton / qtGuideUserAction) use the panel's session and run: Send runs in
 *        `<session>@<run>` as the run; Queue names the session on the item and gives it the run
 *   TR-4 the bar: stacked Queue (one item per todo), add-to-queue and the stacked / single Send (on Anthropic) use
 *        them too; the bar's transport is the panel run's queue default
 *   TR-5 a run deleted elsewhere falls back to `default` and is forgotten
 *   TR-6 a Send as another run than the window's runs with that run's process position (processRunFor)
 */

/* eslint-disable @typescript-eslint/naming-convention -- YAML keys */
import test, { after, describe } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'fs';
import * as path from 'path';

const EXT_ROOT = path.resolve(__dirname, '..', '..', '..');
const SANDBOX = fs.realpathSync(fs.mkdtempSync(path.join(EXT_ROOT, '..', '..', '..', 'ztmp', 'vscode_extension_261112_vscimpb60d_todopanel-')));
const WS = path.join(SANDBOX, 'ws');
const HOME = path.join(SANDBOX, 'home');
const QUEST = 'q1';
function put(rel: string, text: string): void {
    const abs = path.join(WS, rel);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, text);
}
put(`_ai/quests/${QUEST}/overview.${QUEST}.md`, '# Q1\n');
put(`_ai/quests/${QUEST}/todos.${QUEST}.todo.yaml`, [
    'todos:',
    '  - id: a1', '    title: A', '    description: do a', '    status: not-started', '    priority: medium',
    '  - id: a2', '    title: B', '    description: do b', '    status: not-started', '    priority: medium',
    '  - id: u1', '    title: U', '    description: yours', '    status: not-started', '    priority: medium', '    user_action: true', '',
].join('\n'));
put('_ai/processes/design/design.process.yaml', [
    'id: design', 'name: Design', 'phases:', '  - id: p1', '    steps:', '      - id: plan', '        name: Plan', '      - id: build', '        name: Build',
    '    gate:', '      id: g1', '',
].join('\n'));
put('_ai/processes/design/design.md', '# Design\n');
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
import { setExtensionPath } from '../handler_shared.js';
import { handleQuestTodoMessage, setQuestTodoContext } from '../questTodoPanel-handler.js';
import * as router from '../sendToChatRouter.js';
import { TODO_PANEL_DEFAULT_SESSION, todoPanelRunKey, todoPanelSelection, todoPanelSessionKey } from '../../utils/todoPanelRunSession.js';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Json = any;
let context: Json;
(function start(): void {
    const storage = path.join(SANDBOX, 'storage');
    fs.mkdirSync(storage, { recursive: true });
    const memento = (): unknown => {
        const values = new Map<string, unknown>();
        return { get: (k: string, d?: unknown) => values.has(k) ? values.get(k) : d, update: async (k: string, v: unknown) => { if (v === undefined) { values.delete(k); } else { values.set(k, v); } }, keys: () => [...values.keys()], setKeysForSync: () => undefined };
    };
    context = {
        subscriptions: [], extensionPath: EXT_ROOT, extensionUri: { fsPath: EXT_ROOT, scheme: 'file', path: EXT_ROOT },
        globalStorageUri: { fsPath: storage, scheme: 'file' }, storageUri: { fsPath: storage, scheme: 'file' }, logUri: { fsPath: storage, scheme: 'file' },
        globalStoragePath: storage, storagePath: storage, logPath: storage, globalState: memento(), workspaceState: memento(),
        asAbsolutePath: (rel: string) => path.join(EXT_ROOT, rel),
    };
    setExtensionPath(EXT_ROOT);
    TomAiConfiguration.init(context);
    ChatVariablesStore.init(context);
    ProcessStateStore.init(context);
    setQuestTodoContext(context);
})();

// What the panel hands the queue and the Anthropic send.
const enqueued: Json[] = [];
const sends: Json[] = [];
const runDefaults: Record<string, Json> = { default: { defaultTransport: 'copilot' }, r2: { defaultTransport: 'anthropic' } };
(PromptQueueManager as Json)._inst = {
    enqueue: async (o: Json) => { enqueued.push(o); return { id: `q${enqueued.length}`, ...o }; },
    runQueueSettings: (run?: string) => runDefaults[run ?? 'default'] ?? { defaultTransport: 'copilot' },
    get defaultTransport() { return 'copilot'; },
};
const originalSend = router.runAnthropicSend;
(router as Json).runAnthropicSend = async (_ctx: unknown, prompt: string, opts: Json) => { sends.push({ prompt, ...opts }); return { target: 'anthropic', ok: false }; };
after(() => {
    (router as Json).runAnthropicSend = originalSend;
    (PromptQueueManager as Json)._inst = undefined;
    vscodeStub.restore();
    fs.rmSync(SANDBOX, { recursive: true, force: true });
});

const store = (): ProcessStateStore => ProcessStateStore.instance!;
function view(): { webview: Json; posted: Json[] } {
    const posted: Json[] = [];
    return { posted, webview: { postMessage: async (m: Json) => { posted.push(JSON.parse(JSON.stringify(m))); return true; } } };
}
const last = (posted: Json[], type: string): Json => [...posted].reverse().find((m) => m.type === type);
const send = (webview: Json, msg: Json): Promise<boolean> => handleQuestTodoMessage({ questId: QUEST, ...msg }, webview);

describe('the todo panel\'s session and run', () => {
    test('TR-1: the selection rules', () => {
        assert.deepEqual(todoPanelSelection(undefined, undefined, ['default']), { session: TODO_PANEL_DEFAULT_SESSION, run: 'default', effectiveSession: 'chat', runFellBack: false });
        assert.deepEqual(todoPanelSelection('work', 'r2', ['default', 'r2']), { session: 'work', run: 'r2', effectiveSession: 'work@r2', runFellBack: false });
        assert.deepEqual(todoPanelSelection('work', 'gone', ['default']), { session: 'work', run: 'default', effectiveSession: 'work', runFellBack: true });
        assert.equal(todoPanelSelection('chat', 'r2', ['default', 'r2']).effectiveSession, 'chat', 'the shared chat session is never renamed');
    });

    test('setup: a second run', async () => {
        await ProcessStateStore.ready;
        assert.equal(store().apply({ process: 'design' }, 'user').ok, true);
        assert.equal(store().createRun('r2', 'design', 'user', false).ok, true);
        assert.equal((store().withRun('r2', () => store().apply({ process: 'design', phase: 'p1', step: 'build' }, 'user')) as Json).ok, true);
    });

    test('TR-2: the controls\' state, kept per window and quest', async () => {
        const bar = view();
        const other = view();
        await send(bar.webview, { type: 'qtGetRunSession' });
        await send(other.webview, { type: 'qtGetRunSession' });
        let state = last(bar.posted, 'qtRunSession');
        assert.deepEqual([state.session, state.effectiveSession, state.run], ['chat', 'chat', 'default']);
        assert.deepEqual(state.runs.map((o: Json) => o.run), ['default', 'r2'], 'default first');
        await send(bar.webview, { type: 'qtSetRun', run: 'r2' });
        assert.equal(context.workspaceState.get(todoPanelRunKey(QUEST)), 'r2', 'kept in the workspace state');
        assert.equal(last(other.posted, 'qtRunSession').run, 'r2', 'the other view hears it');
        await context.workspaceState.update(todoPanelSessionKey(QUEST), 'work');
        await send(bar.webview, { type: 'qtGetRunSession' });
        state = last(bar.posted, 'qtRunSession');
        assert.deepEqual([state.session, state.effectiveSession, state.run], ['work', 'work@r2', 'r2']);
        await send(bar.webview, { type: 'qtSetRun', run: 'nope' });
        assert.equal(last(bar.posted, 'qtRunSession').run, 'default', 'a run the quest does not have');
        await send(bar.webview, { type: 'qtSetRun', run: 'r2' });
    });

    test('TR-3: Send, Queue and Guide me', async () => {
        const { webview } = view();
        enqueued.length = 0;
        sends.length = 0;
        await send(webview, { type: 'qtTodoButton', target: 'queue', todoId: 'a1' });
        await send(webview, { type: 'qtGuideUserAction', target: 'queue', todoId: 'u1' });
        assert.deepEqual(enqueued.map((o) => [o.todoIdPattern, o.session, o.run, o.transport]), [['a1', 'work', 'r2', 'anthropic'], ['u1', 'work', 'r2', 'anthropic']]);
        await new Promise((r) => setTimeout(r, 3100)); // past the 3 s double-click guard
        await send(webview, { type: 'qtTodoButton', target: 'chat', todoId: 'a1' });
        await send(webview, { type: 'qtGuideUserAction', target: 'chat', todoId: 'u1' });
        assert.deepEqual(sends.map((o) => [o.session, o.run, /todo panel/.test(o.source)]), [['work@r2', 'r2', true], ['work@r2', 'r2', true]]);
        assert.match(sends[0].userMessageTemplate, /^EXEC/);
        assert.match(sends[1].userMessageTemplate, /^GUIDE/);
    });

    test('TR-4: the bar', async () => {
        const { webview } = view();
        enqueued.length = 0;
        sends.length = 0;
        await send(webview, { type: 'qtQueueStackedTodos', todos: [{ todoId: 'a1' }, { todoId: 'a2' }], template: '__none__' });
        await send(webview, { type: 'qtAddCurrentTodoToQueue', todoId: 'a2', template: '__none__' });
        assert.deepEqual(enqueued.map((o) => [o.todoIdPattern, o.session, o.run]), [['a1', 'work', 'r2'], ['a2', 'work', 'r2'], ['a2', 'work', 'r2']]);
        // r2's queue default is Anthropic: the bar's Send goes there, in the panel's session, as its run.
        await send(webview, { type: 'qtSendStackedTodos', todos: [{ todoId: 'a1' }, { todoId: 'a2' }], template: '__none__' });
        await send(webview, { type: 'qtSendCurrentTodoToCopilot', todoId: 'a1', template: '__none__' });
        assert.deepEqual(sends.map((o) => [o.session, o.run]), [['work@r2', 'r2'], ['work@r2', 'r2']]);
    });

    test('TR-5: a run deleted elsewhere', async () => {
        const { webview, posted } = view();
        assert.equal(store().deleteRuns(['r2']).ok, true);
        await send(webview, { type: 'qtGetRunSession' });
        const state = last(posted, 'qtRunSession');
        assert.deepEqual([state.run, state.effectiveSession], ['default', 'work']);
        assert.equal(context.workspaceState.get(todoPanelRunKey(QUEST)), undefined, 'forgotten');
    });

    test('TR-6: a Send as another run', () => {
        assert.equal(store().createRun('r3', 'design', 'user', false).ok, true);
        assert.equal((store().withRun('r3', () => store().apply({ process: 'design', phase: 'p1', step: 'build' }, 'user')) as Json).ok, true);
        const position = router.processRunFor('r3');
        assert.equal(position?.run, 'r3');
        assert.equal(position?.state.step, 'build', 'the run\'s position');
        assert.equal(router.processRunFor('default'), undefined, 'the window\'s run: no context needed');
        assert.equal(router.processRunFor(undefined), undefined);
    });
});
