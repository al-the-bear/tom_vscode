/**
 * The todo panel's queue-target flow (vscimpb139; utils/todoQueueTarget.ts, utils/todoPanelRunSession.ts), through
 * the real todo panel handler, process store and session store under the vscode stub; the prompt queue and the
 * Anthropic send are replaced, so the test sees what they are given, and the picks are answered through the flow's
 * test seam.
 *
 *   QF-1 every queue button asks quest → run → free session: the quests with an open window (this one the default,
 *        preselected), the window's runs (`default` first, this window's marked), only the free sessions of the run
 *        (a queue item or a chat send in one makes it busy), the queue default and "New session…"; next or end is
 *        the panel's Next toggle, never asked; next goes to the front (enqueueNext), the confirmation names quest,
 *        run, session and position
 *   QF-2 after the first use "Last: …" comes first and queues there with one Enter; picking anew preselects the last
 *        run and session; the position is the toggle's, also for "Last: …"
 *   QF-3 Escape at any step queues nothing
 *   QF-4 another quest: its runs with their state (busy, paused) from its window's run list, its free sessions from its
 *        queue entries on disk; the item reaches it through its window's inbox with run, session and position; a new
 *        session there is a fresh one by name
 *   QF-5 TODO / GROUP items, the group walk and the stacked todos take the flow; a TODO item or a walk goes into its
 *        own quest only; the todo's own quest is the default when it has a window
 *   QF-6 direct sends (Send, Guide me's send, the bar's Send) ask for a free session of this window's runs, with
 *        "Last: …" first; they send there, as that run
 *   QF-7 no run and no session in the panel: the views get only the Done notification toggle's state (qtDoneNotification);
 *        the toggle is off by default and cannot be turned on without a template (vscimpb146); on, the items queued
 *        here and through another quest's inbox record who queued them (the run and session chosen); off, none
 *   QF-8 a Send as another run runs with that run's process position (processRunFor)
 *   QF-9 the default queue buttons (`defaultTarget`, vscimpb151): the bar's Save to Queue, the stack and the detail's
 *        queue button go straight into the default run's default session (`default@default`) at the end, no pick;
 *        the flow's buttons still ask; a run created now has its default session `default@<run>` at once
 *   QF-10 the Next and Fresh toggles and a group todo's GROUP item buttons: the views get the toggles' state
 *        (qtQueueToggles), off by default; Next on, the default buttons queue next; Fresh on, a queued item runs in a
 *        temporary session based on the session picked (here made at once, in another quest by its window:
 *        `new-session.based-on`), a direct send in one that is discarded after the send; a group todo queued with
 *        `defaultTarget` is a GROUP item in the default run without a pick, without it the flow asks
 */

/* eslint-disable @typescript-eslint/naming-convention -- YAML keys */
import test, { after, describe } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'fs';
import * as path from 'path';
import { parse as parseYaml } from 'yaml';

const EXT_ROOT = path.resolve(__dirname, '..', '..', '..');
const SANDBOX = fs.realpathSync(fs.mkdtempSync(path.join(EXT_ROOT, '..', '..', '..', 'ztmp', 'vscode_extension_261117_vscimpb139_flow-')));
const WS = path.join(SANDBOX, 'ws');
const HOME = path.join(SANDBOX, 'home');
const QUEST = 'q1';
function put(rel: string, text: string): void {
    const abs = path.join(WS, rel);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, text);
}
// The sandbox is its own root: it lies under the real workspace's ztmp/, whose root marker the layout would find.
put('.tom/tom_root.yaml', 'version: 1\n');
put(`_ai/quests/${QUEST}/overview.${QUEST}.md`, '# Q1\n');
put(`_ai/quests/${QUEST}/todos.${QUEST}.todo.yaml`, [
    'todos:',
    '  - id: a1', '    title: A', '    description: do a', '    status: not-started', '    priority: medium',
    '  - id: a2', '    title: B', '    description: do b', '    status: not-started', '    priority: medium',
    '  - id: u1', '    title: U', '    description: yours', '    status: not-started', '    priority: medium', '    user_action: true',
    '  - id: g1', '    title: G', '    description: a group', '    status: group', '    priority: medium', '    comprised_of: [a1, a2]', '',
].join('\n'));
put('_ai/quests/q2/overview.q2.md', '# Q2\n');
put('_ai/quests/q2/todos.q2.todo.yaml', 'todos:\n  - id: z1\n    title: Z\n    status: not-started\n');
put('_ai/processes/design/design.process.yaml', [
    'id: design', 'name: Design', 'phases:', '  - id: p1', '    steps:', '      - id: plan', '        name: Plan', '      - id: build', '        name: Build',
    '    gate:', '      id: g1', '',
].join('\n'));
put('_ai/processes/design/design.md', '# Design\n');
put('.tom/tom_vscode_extension.json', JSON.stringify({ anthropic: { userMessageTemplates: [
    { id: 'execute-todo', name: 'Execute TODO', template: 'EXEC ${userMessage}' },
    { id: 'guide-user-action', name: 'Guide me', template: 'GUIDE ${userMessage}' },
] } }, null, 2));
// Another quest's window (q2), live, with its runs' states (vscimpb123).
put('_ai/local/win2.window-state.json', JSON.stringify({
    windowId: 'win2', workspace: 'q2', activeQuest: 'q2', heartbeat: new Date(Date.now() + 3_600_000).toISOString(), status: [],
    runs: [{ run: 'default', state: 'running', detail: 'item z', pending: 1 }, { run: 'rq', state: 'paused', pending: 0 }],
}));
// What q2's queue has on disk: an item sending in session other2.
put('_ai/queue/host_q2_261117_000000_q2.normal.entry.queue.yaml', [
    'meta:', '  id: e1', '  quest: q2', '  status: sending', 'prompt-queue:', '  - id: P1', '    type: main', '    name: Main', '    prompt-text: x', '    session: other2', '    run: default', '',
].join('\n'));
fs.mkdirSync(HOME, { recursive: true });
process.env.HOME = HOME;
process.env.USERPROFILE = HOME;

import { installVscodeStub } from '../../tools/__tests__/_vscode-stub.js';
const vscodeStub = installVscodeStub({ workspaceFolders: [WS] });
(vscodeStub.stub.workspace as Record<string, unknown>).workspaceFile = { fsPath: path.join(WS, `${QUEST}.code-workspace`), scheme: 'file' };
(vscodeStub.stub as Record<string, unknown>).ThemeIcon = class { constructor(public id: string) { /* a codicon */ } };
(vscodeStub.stub as Record<string, unknown>).QuickPickItemKind = { Separator: -1, Default: 0 };

import { ChatVariablesStore } from '../../managers/chatVariablesStore.js';
import { seedLegacyDefault } from '../../tools/__tests__/_processTestRun.js';
import { ProcessStateStore } from '../../managers/processStateStore.js';
import { PromptQueueManager } from '../../managers/promptQueueManager.js';
import { TomAiConfiguration } from '../../utils/tomAiConfiguration.js';
import { setExtensionPath } from '../handler_shared.js';
import { __setTodoTargetPickForTests, handleQuestTodoMessage, setQuestTodoContext } from '../questTodoPanel-handler.js';
import * as router from '../sendToChatRouter.js';
import { createSession, readSession } from '../../services/agentSdkSessionStore.js';
import { sessionsFolder } from '../sessionPicker.js';
import { tryBeginAnthropicSend, __resetAnthropicSendsForTests } from '../sendToChatState.js';
import type { TodoPickItem } from '../../utils/todoQueueTarget.js';

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
const runDefaults: Record<string, Json> = { default: { defaultTransport: 'anthropic' }, r2: { defaultTransport: 'copilot' } };
(PromptQueueManager as Json)._inst = {
    enqueue: async (o: Json) => { enqueued.push({ how: 'end', ...o }); return { id: `q${enqueued.length}`, status: 'staged', ...o }; },
    enqueueNext: async (o: Json) => { enqueued.push({ how: 'next', ...o }); return { id: `q${enqueued.length}`, status: 'pending', ...o }; },
    runQueueSettings: (run?: string) => runDefaults[run ?? 'default'] ?? { defaultTransport: 'copilot' },
    // A queue item runs in busy@r2.
    sessionHolder: (s: string) => (s === 'busy@r2' ? { kind: 'queue', label: 'running item' } : undefined),
    get defaultTransport() { return 'copilot'; },
};
const originalSend = router.runAnthropicSend;
// Not ok: Guide me's closing question (which waits for the user) is not asked.
(router as Json).runAnthropicSend = async (_ctx: unknown, prompt: string, opts: Json) => { sends.push({ prompt, ...opts }); return { target: 'anthropic', ok: false }; };

// The picks: each call recorded, answered by the next scripted answer (an item's value, by label start or index).
const picks: Array<{ title: string; items: Array<TodoPickItem<unknown>> }> = [];
let answers: Array<string | number | undefined> = [];
__setTodoTargetPickForTests(async (items, title) => {
    picks.push({ title, items: items as Array<TodoPickItem<unknown>> });
    const a = answers.shift();
    if (a === undefined) { return undefined; }
    const item = typeof a === 'number' ? items[a] : items.find((i) => i.label === a || i.label.startsWith(a));
    assert.ok(item, `an item "${a}" in ${title}: ${items.map((i) => i.label).join(' | ')}`);
    return item!.value;
});
after(() => {
    (router as Json).runAnthropicSend = originalSend;
    (PromptQueueManager as Json)._inst = undefined;
    __resetAnthropicSendsForTests();
    vscodeStub.restore();
    fs.rmSync(SANDBOX, { recursive: true, force: true });
});

const store = (): ProcessStateStore => ProcessStateStore.instance!;
function view(): { webview: Json; posted: Json[] } {
    const posted: Json[] = [];
    return { posted, webview: { postMessage: async (m: Json) => { posted.push(JSON.parse(JSON.stringify(m))); return true; } } };
}
const send = (webview: Json, msg: Json): Promise<boolean> => handleQuestTodoMessage({ questId: QUEST, ...msg }, webview);
const toggle = (webview: Json, which: 'next' | 'fresh', on: boolean): Promise<boolean> => send(webview, { type: 'qtSetQueueToggle', which, on });
const labels = (i: number): string[] => picks[i].items.map((x) => x.label);
const active = (i: number): string | undefined => picks[i].items.find((x) => x.active)?.label;
const infos = (): string[] => vscodeStub.spies.byMethod('window.showInformationMessage').map((c) => String(c.args[0]));
const warnings = (): string[] => vscodeStub.spies.byMethod('window.showWarningMessage').map((c) => String(c.args[0]));
const inbox = (): Json[] => fs.readdirSync(path.join(WS, '_ai', 'queue')).filter((f) => f.endsWith('.inbox.queue.yaml')).sort()
    .map((f) => parseYaml(fs.readFileSync(path.join(WS, '_ai', 'queue', f), 'utf8')));
let tick = 0;
const tpl = (): string => `t${++tick}`;

describe('the todo panel\'s queue-target flow', () => {
    test('setup: runs and sessions', async () => {
        await ProcessStateStore.ready;
        seedLegacyDefault(store(), WS, QUEST, { process: 'design' });
        assert.equal(store().createRun('r2', 'design', 'user', false).ok, true);
        ChatVariablesStore.instance.set('quest', QUEST, 'user');
        for (const name of ['work', 'work@r2', 'busy@r2']) { assert.equal(createSession(sessionsFolder(QUEST), name, {}).ok, true, name); }
        for (const name of ['other', 'other2']) { assert.equal(createSession(sessionsFolder('q2'), name, {}).ok, true, name); }
        // A chat send runs in session chat.
        assert.equal(tryBeginAnthropicSend('chat'), true);
    });

    test('QF-1: quest → run → free session; next / end is the toggle', async () => {
        const { webview } = view();
        picks.length = 0;
        enqueued.length = 0;
        await toggle(webview, 'next', true);
        answers = ['q1', 'r2', 'work@r2'];
        await send(webview, { type: 'qtAddCurrentTodoToQueue', todoId: 'a1', template: tpl() });
        assert.equal(picks.length, 3, 'three picks: the position is not asked');
        assert.match(picks[0].title, /1\/3 quest/);
        assert.deepEqual(labels(0), ['q1', 'q2'], 'the quests with an open window, no Last yet');
        assert.equal(active(0), 'q1', 'the window\'s quest preselected');
        assert.match(picks[0].items[1].description ?? '', /inbox/);
        assert.deepEqual(labels(1), ['default', 'r2'], 'the window\'s runs, default first');
        assert.match(picks[1].items[0].description ?? '', /this window's run/);
        assert.deepEqual(labels(2), ['work@r2', '$(list-ordered) Run default (default@r2)', '$(add) New session…'], 'only the free sessions: chat (a chat send) and busy@r2 (a queue item) are not offered');
        assert.equal(enqueued.length, 1);
        assert.deepEqual([enqueued[0].how, enqueued[0].run, enqueued[0].session, enqueued[0].todoIdPattern], ['next', 'r2', 'work@r2', 'a1'], 'next: the front of the queue');
        assert.match(infos().at(-1)!, /Queued todo a1 — quest q1, run r2, session work@r2, next in the queue\./);
    });

    test('QF-2: "Last: …" first, the last choices preselected', async () => {
        const { webview } = view();
        picks.length = 0;
        enqueued.length = 0;
        answers = ['$(history) Last:'];
        await send(webview, { type: 'qtAddCurrentTodoToQueue', todoId: 'a2', template: tpl() });
        assert.equal(picks.length, 1, 'one Enter');
        assert.equal(picks[0].items[0].label, '$(history) Last: q1 / r2 / work@r2 / next');
        assert.equal(active(0), '$(history) Last: q1 / r2 / work@r2 / next');
        assert.deepEqual([enqueued[0].how, enqueued[0].run, enqueued[0].session], ['next', 'r2', 'work@r2']);
        // Picking anew: the last run and session preselected; the toggle off: the end this time, also for "Last: …".
        picks.length = 0;
        await toggle(webview, 'next', false);
        answers = ['q1', 'r2', 'work@r2'];
        await send(webview, { type: 'qtAddCurrentTodoToQueue', todoId: 'a2', template: tpl() });
        assert.equal(active(1), 'r2');
        assert.equal(active(2), 'work@r2');
        assert.equal(picks.length, 3);
        assert.equal(enqueued.at(-1).how, 'end');
        answers = ['$(history) Last:'];
        await send(webview, { type: 'qtAddCurrentTodoToQueue', todoId: 'a2', template: tpl() });
        assert.equal(enqueued.at(-1).how, 'end', 'Last: the toggle decides the place');
        assert.equal(enqueued.at(-1).deferSend, true, 'the end: staged, as before');
    });

    test('QF-3: Escape at any step', async () => {
        const { webview } = view();
        for (let step = 0; step < 3; step++) {
            enqueued.length = 0;
            answers = ['q1', 'r2', 'work@r2'].slice(0, step);
            answers.push(undefined);
            await send(webview, { type: 'qtAddCurrentTodoToQueue', todoId: 'a1', template: tpl() });
            assert.equal(enqueued.length, 0, `nothing queued at step ${step + 1}`);
        }
    });

    test('QF-4: another quest, through its window\'s inbox', async () => {
        const { webview } = view();
        picks.length = 0;
        enqueued.length = 0;
        answers = ['q2', 'default', 'other'];
        await send(webview, { type: 'qtAddCurrentTodoToQueue', todoId: 'a1', template: tpl() });
        assert.deepEqual(labels(1), ['default', 'rq'], 'its runs from its window\'s run list');
        assert.match(picks[1].items[0].description ?? '', /^busy — running: item z, 1 pending/);
        assert.match(picks[1].items[1].description ?? '', /^paused/);
        assert.deepEqual(labels(2), ['other', '$(list-ordered) Run default (default@default)', '$(add) New session…'], 'other2 is busy (its queue entry on disk), no chat session there');
        assert.equal(enqueued.length, 0, 'not this window\'s queue');
        let items = inbox();
        assert.equal(items.length, 1);
        assert.deepEqual([items[0].run, items[0].session, items[0]['todo-id-pattern'], items[0].position, items[0].from.quest], ['default', 'other', 'a1', undefined, 'q1']);
        assert.match(infos().at(-1)!, /quest q2, run default, session other, at the end of the queue \(through its window's inbox\)\./);
        // A new session there: a fresh one, by name; next.
        const win = vscodeStub.stub.window as Json;
        const input = win.showInputBox;
        win.showInputBox = async () => 'fresh';
        try {
            await toggle(webview, 'next', true);
            answers = ['q2', 'rq', '$(add) New session'];
            await send(webview, { type: 'qtAddCurrentTodoToQueue', todoId: 'a2', template: tpl() });
        } finally { win.showInputBox = input; await toggle(webview, 'next', false); }
        items = inbox();
        const fresh = items.find((i) => i['new-session']);
        assert.deepEqual([fresh.run, fresh['new-session'], fresh.position, fresh.session], ['rq', { name: 'fresh@rq' }, 'next', undefined]);
        // The last target keeps the session by name (it exists once the item ran).
        answers = [undefined];
        picks.length = 0;
        await send(webview, { type: 'qtAddCurrentTodoToQueue', todoId: 'a2', template: tpl() });
        assert.equal(picks[0].items[0].label, '$(history) Last: q2 / rq / fresh@rq / next');
    });

    test('QF-5: TODO / GROUP items, the walk, the stack', async () => {
        const { webview } = view();
        enqueued.length = 0;
        answers = ['q1', 'default', '$(list-ordered) Run default (default@default)'];
        await send(webview, { type: 'qtQueueAsTodoItem', todoId: 'a1' });
        assert.deepEqual([enqueued[0].todoIdPattern, enqueued[0].transport, enqueued[0].run, enqueued[0].session, enqueued[0].template], ['a1', 'anthropic', 'default', undefined, 'execute-todo'], 'Run default: no session of its own, the run\'s default when it is sent');
        // A TODO item walks its own quest's todos: into another quest it is refused.
        enqueued.length = 0;
        const before = inbox().length;
        answers = ['q2', 'default', 'other'];
        await send(webview, { type: 'qtQueueAsTodoItem', todoId: 'a2' });
        assert.equal(enqueued.length + inbox().length - before, 0);
        assert.match(warnings().at(-1)!, /walks the todos of quest q1: queue it into q1, not q2/);
        // A group todo's Run row (asTodo): the group todo itself as a TODO item, its members not walked.
        enqueued.length = 0;
        answers = ['q1', 'default', '$(list-ordered) Run default (default@default)'];
        await send(webview, { type: 'qtQueueAsTodoItem', todoId: 'g1', asTodo: true });
        assert.deepEqual([enqueued[0].repeatCount, enqueued[0].todoIdPattern, enqueued[0].transport, enqueued[0].template], ['todo:q1/g1', 'g1', 'anthropic', 'execute-todo'], 'a TODO item over the group todo');
        // The todo's own quest is the default when it has a window (a list of several quests).
        picks.length = 0;
        answers = [undefined];
        await send(webview, { type: 'qtAddCurrentTodoToQueue', questId: '__all_quests__', todoId: 'z1', sourceFile: 'q2/todos.q2.todo.yaml', template: tpl() });
        assert.match(picks[0].items.find((i) => i.label === 'q2')!.description!, /default/, 'q2 (the todo\'s quest) is the default');
        assert.deepEqual(labels(0).slice(1), ['q2', 'q1'], 'after Last: the default first');
        // The walk (its group prompt picker takes the first prompt).
        const win = vscodeStub.stub.window as Json;
        const original = win.createQuickPick;
        win.createQuickPick = () => {
            const handlers: Record<string, (x?: unknown) => void> = {};
            const qp: Json = {
                items: [], selectedItems: [], dispose: () => undefined,
                onDidAccept: (f: () => void) => { handlers.accept = f; }, onDidTriggerItemButton: (f: () => void) => { handlers.button = f; },
                onDidHide: (f: () => void) => { handlers.hide = f; },
                hide: () => handlers.hide?.(),
                show: () => { qp.selectedItems = [qp.items[0]]; handlers.accept?.(); },
            };
            return qp;
        };
        try {
            enqueued.length = 0;
            answers = ['q1', 'r2', 'work@r2'];
            await send(webview, { type: 'qtQueueGroupPrompt', prefix: 'a' });
            assert.deepEqual([enqueued[0].repeatCount, enqueued[0].run, enqueued[0].session], ['a*', 'r2', 'work@r2']);
            assert.match(infos().at(-1)!, /Queued a walk over a\* with "Default" — quest q1, run r2, session work@r2, at the end of the queue\./);
        } finally { win.createQuickPick = original; }
        // The stack: one target for all.
        enqueued.length = 0;
        picks.length = 0;
        answers = ['$(history) Last:'];
        await send(webview, { type: 'qtQueueStackedTodos', todos: [{ todoId: 'a1' }, { todoId: 'u1' }], template: '__none__' });
        assert.equal(picks.length, 1);
        assert.deepEqual(enqueued.map((o) => [o.todoIdPattern, o.run, o.session]), [['a1', 'r2', 'work@r2'], ['u1', 'r2', 'work@r2']]);
        // Guide me's queue path and a todo's Queue button: the flow too.
        enqueued.length = 0;
        answers = ['$(history) Last:'];
        await send(webview, { type: 'qtTodoButton', target: 'queue', todoId: 'a2' });
        assert.deepEqual([enqueued[0].todoIdPattern, enqueued[0].template, enqueued[0].transport, enqueued[0].run], ['a2', 'execute-todo', 'anthropic', 'r2']);
    });

    test('QF-6: direct sends ask for a free session', async () => {
        const { webview } = view();
        picks.length = 0;
        sends.length = 0;
        await new Promise((r) => setTimeout(r, 3100)); // past the 3 s double-click guard
        answers = ['work@r2'];
        await send(webview, { type: 'qtTodoButton', target: 'chat', todoId: 'a1' });
        assert.equal(picks.length, 1, 'only the session');
        assert.deepEqual(labels(0), ['work', 'work@r2'], 'the free sessions of the window\'s runs: not chat (a chat send), not busy@r2');
        assert.deepEqual(picks[0].items.map((i) => i.description), ['run default · free', 'run r2 · free']);
        assert.deepEqual([sends[0].session, sends[0].run, /todo panel/.test(sends[0].source)], ['work@r2', 'r2', true]);
        assert.match(sends[0].userMessageTemplate, /^EXEC/);
        // Guide me's send: "Last: …" first.
        picks.length = 0;
        answers = ['$(history) Last:'];
        await send(webview, { type: 'qtGuideUserAction', target: 'chat', todoId: 'u1' });
        assert.equal(picks[0].items[0].label, '$(history) Last: work@r2 — run r2');
        assert.deepEqual([sends[1].session, sends[1].run], ['work@r2', 'r2']);
        assert.match(sends[1].userMessageTemplate, /^GUIDE/);
        // The bar's Send (this window's run's transport: Anthropic): the same pick.
        answers = ['work'];
        await send(webview, { type: 'qtSendCurrentTodoToCopilot', todoId: 'a2', template: '__none__' });
        assert.deepEqual([sends[2].session, sends[2].run], ['work', 'default']);
        // Escape: nothing sent.
        answers = [undefined];
        await send(webview, { type: 'qtSendCurrentTodoToCopilot', todoId: 'a1', template: '__none__' });
        assert.equal(sends.length, 3);
    });

    test('QF-7: no run and no session in the panel', async () => {
        const { webview, posted } = view();
        await send(webview, { type: 'qtGetDoneNotification' });
        assert.deepEqual(posted.filter((m) => m.type === 'qtDoneNotification'), [{ type: 'qtDoneNotification', on: false, available: false }],
            'off by default; disabled without a template (vscimpb146)');
        await send(webview, { type: 'qtSetDoneNotification', on: true });
        assert.deepEqual(posted.filter((m) => m.type === 'qtDoneNotification').at(-1), { type: 'qtDoneNotification', on: false, available: false },
            'it cannot be turned on without a template');
        assert.equal(posted.some((m) => m.type === 'qtRunSession'), false);
        // With a template: on, and the panel's items record who queued them — the run and session queued into.
        const cfgFile = path.join(WS, '.tom', 'tom_vscode_extension.json');
        const cfg = fs.readFileSync(cfgFile, 'utf8');
        fs.writeFileSync(cfgFile, JSON.stringify({ ...JSON.parse(cfg), todoPanel: { doneNotificationTemplate: 'Done: ${todoId}' } }));
        try {
            await send(webview, { type: 'qtSetDoneNotification', on: true });
            assert.deepEqual(posted.filter((m) => m.type === 'qtDoneNotification').at(-1), { type: 'qtDoneNotification', on: true, available: true });
            enqueued.length = 0;
            answers = ['q1', 'r2', 'work@r2'];
            await send(webview, { type: 'qtAddCurrentTodoToQueue', todoId: 'a1', template: tpl() });
            assert.deepEqual(enqueued.at(-1).queuedBy, { quest: 'q1', run: 'r2', session: 'work@r2' });
            assert.equal(enqueued.at(-1).doneNotificationPrompt, undefined, 'no done notification rides on the item');
            answers = ['q2', 'default', 'other'];
            await send(webview, { type: 'qtAddCurrentTodoToQueue', todoId: 'a2', template: tpl() });
            assert.deepEqual(inbox().find((i) => i['queued-by'])?.['queued-by'], { quest: 'q2', run: 'default', session: 'other' }, 'through the inbox too');
            await send(webview, { type: 'qtSetDoneNotification', on: false });
            answers = ['q1', 'r2', 'work@r2'];
            await send(webview, { type: 'qtAddCurrentTodoToQueue', todoId: 'a1', template: tpl() });
            assert.equal(enqueued.at(-1).queuedBy, undefined, 'box off: nobody recorded');
        } finally {
            fs.writeFileSync(cfgFile, cfg);
        }
        const host = fs.readFileSync(path.join(EXT_ROOT, 'src', 'handlers', 'questTodoPanel-handler.ts'), 'utf-8');
        assert.doesNotMatch(host, /case 'qtPickSession'|case 'qtSetRun'|case 'qtGetRunSession'|todoPanelSelectionNow|todoPanelQueueTarget/);
    });

    test('QF-9: the default queue buttons', async () => {
        const { webview } = view();
        picks.length = 0;
        enqueued.length = 0;
        answers = [];
        await send(webview, { type: 'qtAddCurrentTodoToQueue', todoId: 'a1', template: tpl(), defaultTarget: true });
        assert.equal(picks.length, 0, 'nothing asked');
        assert.deepEqual([enqueued[0].how, enqueued[0].run, enqueued[0].session, enqueued[0].todoIdPattern], ['end', 'default', 'default@default', 'a1']);
        await new Promise((r) => setTimeout(r, 3100)); // past the 3 s double-click guard
        await send(webview, { type: 'qtTodoButton', target: 'queue', todoId: 'a2', defaultTarget: true });
        assert.equal(picks.length, 0);
        assert.deepEqual([enqueued[1].run, enqueued[1].session], ['default', 'default@default'], 'the detail\'s default queue button');
        // The flow's own button still asks.
        answers = [undefined];
        await send(webview, { type: 'qtAddCurrentTodoToQueue', todoId: 'a2', template: tpl() });
        assert.equal(picks.length, 1, 'the quest asked');
    });

    test('QF-10: the Next and Fresh toggles, the group buttons', async () => {
        const { webview, posted } = view();
        const toggles = (): Json => posted.filter((m) => m.type === 'qtQueueToggles').at(-1);
        await send(webview, { type: 'qtGetDoneNotification' });
        assert.deepEqual(toggles(), { type: 'qtQueueToggles', next: false, fresh: false }, 'both off by default');
        // Next: the default buttons queue next, nothing asked.
        await toggle(webview, 'next', true);
        assert.deepEqual(toggles(), { type: 'qtQueueToggles', next: true, fresh: false });
        picks.length = 0;
        enqueued.length = 0;
        answers = [];
        await send(webview, { type: 'qtAddCurrentTodoToQueue', todoId: 'a1', template: tpl(), defaultTarget: true });
        assert.deepEqual([picks.length, enqueued[0].how, enqueued[0].run, enqueued[0].session], [0, 'next', 'default', 'default@default']);
        // A group todo: a GROUP item in the default run without a pick, and with the flow.
        await send(webview, { type: 'qtQueueTodoGroup', todoId: 'g1', defaultTarget: true });
        assert.deepEqual([picks.length, enqueued[1].how, enqueued[1].run, enqueued[1].session, enqueued[1].todoIdPattern], [0, 'next', 'default', 'default@default', 'g1,a1,a2'], 'the group and its members');
        assert.match(String(enqueued[1].repeatCount), /^group:/, 'a GROUP item');
        await toggle(webview, 'next', false);
        await new Promise((r) => setTimeout(r, 3100)); // past the 3 s double-click guard
        answers = ['q1', 'r2', 'work@r2'];
        await send(webview, { type: 'qtQueueTodoGroup', todoId: 'g1' });
        assert.deepEqual([picks.length, enqueued[2].how, enqueued[2].run, enqueued[2].session], [3, 'end', 'r2', 'work@r2'], 'with options: asked');
        // Fresh: a one-prompt session based on the session picked.
        await toggle(webview, 'fresh', true);
        assert.deepEqual(toggles(), { type: 'qtQueueToggles', next: false, fresh: true });
        answers = ['q1', 'r2', 'work@r2'];
        await send(webview, { type: 'qtAddCurrentTodoToQueue', todoId: 'a2', template: tpl() });
        const item = enqueued.at(-1);
        assert.match(item.session, /^tmp-.*-fresh0$/);
        assert.equal(item.temporarySession, true, 'the queue removes it when the item is done');
        assert.equal(readSession(sessionsFolder(QUEST), item.session)?.basedOn, 'work@r2', 'made, based on the session picked');
        assert.match(infos().at(-1)!, /session work@r2, at the end of the queue, in a fresh one-prompt session based on it\./);
        // Another quest: its window makes the temporary session (`new-session.based-on`).
        answers = ['q2', 'default', 'other'];
        await send(webview, { type: 'qtAddCurrentTodoToQueue', todoId: 'a1', template: tpl() });
        const sent = inbox().at(-1);
        assert.deepEqual([sent['new-session'], sent.session], [{ 'based-on': 'other' }, undefined]);
        // A direct send: in a temporary session that is gone when the send is over.
        sends.length = 0;
        answers = ['work'];
        await send(webview, { type: 'qtSendCurrentTodoToCopilot', todoId: 'a2', template: '__none__' });
        assert.match(sends[0].session, /^tmp-.*-fresh$/);
        assert.equal(sends[0].run, 'default');
        assert.equal(readSession(sessionsFolder(QUEST), sends[0].session), undefined, 'discarded after the send');
        await toggle(webview, 'fresh', false);
        answers = ['work'];
        await send(webview, { type: 'qtSendCurrentTodoToCopilot', todoId: 'a1', template: '__none__' });
        assert.equal(sends[1].session, 'work', 'off: the session itself');
    });

    test('QF-8: a Send as another run', () => {
        assert.equal(store().createRun('r3', 'design', 'user', false).ok, true);
        assert.equal((store().withRun('r3', () => store().apply({ process: 'design', phase: 'p1', step: 'build' }, 'user')) as Json).ok, true);
        const position = router.processRunFor('r3');
        assert.equal(position?.run, 'r3');
        assert.equal(position?.state.step, 'build', 'the run\'s position');
        assert.equal(router.processRunFor('default'), undefined, 'the window\'s run: no context needed');
        assert.equal(router.processRunFor(undefined), undefined);
    });
});
