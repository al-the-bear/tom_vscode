/**
 * The todo panel across quests (vscimpb137), through the real todo panel handler under the vscode stub.
 *
 *   SC-1 a quest todo view starts on its own quest, live files: `plain` (the panel as it always was)
 *   SC-2 the scope is kept per panel instance: all quests with the archived files → several quests, not plain;
 *        the list (`__all_quests__`) holds every quest's live and archived todos, each row's file `<quest>/<file>`,
 *        an archived one marked `retired`; the detail of an archived todo is marked too
 *   SC-3 the picker: All quests… then the ticked quests (checkboxes); one other quest in the sidebar view is not plain
 *   SC-4 Restore: the archived todo back into its live file; the panel is asked to reload; refused when the live
 *        file holds the id
 *   SC-5 a todo file changed: the panel is asked to reload what it shows (not handed the window's quest list)
 *   SC-6 views without a scope: session and workspace-file panels answer `available: false`
 *   SC-7 @TOM TODO (vscimpb138): an instance of its own — it starts on the workspace's quests (vscimpb144) with the quest
 *        prefix on, its scope and its sort / filter state apart from the other panels'; without an active quest it
 *        starts on all quests
 *   SC-8 a list of several quests names a group's own quest: the sidebar view (fixed on alpha) renames a group of
 *        beta in beta when its scope shows beta; with its scope on alpha alone it stays alpha
 */

/* eslint-disable @typescript-eslint/naming-convention -- YAML keys */
import test, { after, describe } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'fs';
import * as path from 'path';

const EXT_ROOT = path.resolve(__dirname, '..', '..', '..');
const SANDBOX = fs.realpathSync(fs.mkdtempSync(path.join(EXT_ROOT, '..', '..', '..', 'ztmp', 'vscode_extension_261117_vscimpb137_scope-')));
const WS = path.join(SANDBOX, 'ws');
const HOME = path.join(SANDBOX, 'home');
function put(rel: string, text: string): void {
    const abs = path.join(WS, rel);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, text);
}
const todos = (quest: string, list: string[]): string => `quest: ${quest}\ntodos:\n${list.join('')}`;
const todo = (id: string, status = 'not-started', extra = ''): string => `  - id: ${id}\n    title: T ${id}\n    status: ${status}\n${extra}`;
put('_ai/quests/alpha/overview.alpha.md', '# Alpha\n');
put('_ai/quests/alpha/todos.alpha.todo.yaml', todos('alpha', [todo('al1'), todo('al2')]));
put('_ai/quests/beta/overview.beta.md', '# Beta\n');
put('_ai/quests/beta/todos.beta.todo.yaml', todos('beta', [todo('be1'), todo('be3')]));
put('_ai/quests/beta/todos-archived.beta.todo.yaml', todos('beta', [todo('be2', 'completed', '    archived: 2026-11-01\n'), todo('be3', 'completed', '    archived: 2026-11-01\n')]));
put('_ai/quests/gamma/overview.gamma.md', '# Gamma\n');
put('_ai/quests/gamma/todos.gamma.todo.yaml', todos('gamma', [todo('ga1')]));
put('.tom/tom_vscode_extension.json', '{}\n');
fs.mkdirSync(HOME, { recursive: true });
process.env.HOME = HOME;
process.env.USERPROFILE = HOME;

import { installVscodeStub } from '../../tools/__tests__/_vscode-stub.js';
const vscodeStub = installVscodeStub({ workspaceFolders: [WS] });
(vscodeStub.stub.workspace as Record<string, unknown>).workspaceFile = { fsPath: path.join(WS, 'alpha.code-workspace'), scheme: 'file' };
(vscodeStub.stub as Record<string, unknown>).QuickPickItemKind = { Separator: -1, Default: 0 };

import { TomAiConfiguration } from '../../utils/tomAiConfiguration.js';
import { setExtensionPath } from '../handler_shared.js';
import { handleQuestTodoMessage, sendQuestTodoRefresh, setQuestTodoContext } from '../questTodoPanel-handler.js';

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
    TomAiConfiguration.init(context as Json);
    setQuestTodoContext(context as Json);
})();
after(() => {
    vscodeStub.restore();
    fs.rmSync(SANDBOX, { recursive: true, force: true });
});

function view(config: Json): { webview: Json; posted: Json[] } {
    const posted: Json[] = [];
    const webview = { postMessage: async (m: Json) => { posted.push(JSON.parse(JSON.stringify(m))); return true; } };
    void handleQuestTodoMessage({ type: 'qtInitConfig', config }, webview as Json);
    return { webview, posted };
}
const last = (posted: Json[], type: string): Json => [...posted].reverse().find((m) => m.type === type);
const send = (webview: Json, msg: Json): Promise<boolean> => handleQuestTodoMessage(msg, webview);
const SIDEBAR = { mode: 'fixed-file', fixedQuestId: 'alpha', hideQuestSelect: true };

describe('the todo panel across quests', () => {
    test('SC-1: its own quest, live files', async () => {
        const { webview, posted } = view(SIDEBAR);
        await send(webview, { type: 'qtGetScope' });
        const s = last(posted, 'qtScope');
        assert.equal(s.available, true);
        assert.deepEqual(s.quests, ['alpha']);
        assert.equal(s.plain, true, 'the panel as it always was');
        assert.equal(s.prefix, false);
        assert.equal(s.buttonText, 'alpha');
    });

    test('SC-2: all quests with the archived files', async () => {
        const { webview, posted } = view(SIDEBAR);
        await send(webview, { type: 'qtSetScope', scope: { kind: 'all', files: { live: true, archived: true, deleted: false }, order: 'quest-groups' } });
        const s = last(posted, 'qtScope');
        assert.deepEqual(s.quests, ['alpha', 'beta', 'gamma']);
        assert.equal(s.plain, false);
        assert.equal(s.prefix, true, 'on with several quests');
        assert.equal(s.scope.order, 'quest-groups');
        // Kept for this panel instance: another sidebar view reads it, the @WS section has its own.
        const other = view(SIDEBAR);
        await send(other.webview, { type: 'qtGetScope' });
        assert.deepEqual(last(other.posted, 'qtScope').quests, ['alpha', 'beta', 'gamma']);
        const ws = view({});
        await send(ws.webview, { type: 'qtGetScope' });
        assert.deepEqual(last(ws.posted, 'qtScope').quests, ['alpha'], 'the @WS section keeps its own');
        await send(webview, { type: 'qtGetTodos', questId: '__all_quests__', file: 'all' });
        const list = last(posted, 'qtTodos');
        assert.equal(list.questId, '__all_quests__');
        const rows = list.todos.map((t: Json) => `${t.sourceFile}#${t.id}${t.retired ? `:${t.retired}` : ''}`).sort();
        assert.deepEqual(rows, [
            'alpha/todos.alpha.todo.yaml#al1', 'alpha/todos.alpha.todo.yaml#al2',
            'beta/todos-archived.beta.todo.yaml#be2:archived', 'beta/todos-archived.beta.todo.yaml#be3:archived',
            'beta/todos.beta.todo.yaml#be1', 'beta/todos.beta.todo.yaml#be3',
            'gamma/todos.gamma.todo.yaml#ga1',
        ]);
        await send(webview, { type: 'qtGetTodo', questId: '__all_quests__', todoId: 'be2', sourceFile: 'beta/todos-archived.beta.todo.yaml' });
        const detail = last(posted, 'qtTodoDetail').todo;
        assert.equal(detail.id, 'be2');
        assert.equal(detail._retired, 'archived', 'shown read-only');
        assert.equal(detail._resolvedQuestId, 'beta');
        // Live files off: only the archived todos.
        await send(webview, { type: 'qtSetScope', scope: { ...s.scope, files: { live: false, archived: true, deleted: false } } });
        await send(webview, { type: 'qtGetTodos', questId: '__all_quests__', file: 'all' });
        assert.deepEqual(last(posted, 'qtTodos').todos.map((t: Json) => t.id).sort(), ['be2', 'be3']);
        await send(webview, { type: 'qtSetScope', scope: s.scope });
    });

    test('SC-3: the picker', async () => {
        const win = vscodeStub.stub.window as Json;
        const original = win.showQuickPick;
        const answers: Array<(items: Json[]) => Json> = [
            (items) => items.find((i) => /All quests/.test(i.label)),
            (items) => items.filter((i) => i.label === 'beta' || i.label === 'gamma'),
        ];
        const seen: Json[][] = [];
        win.showQuickPick = async (items: Json[]) => { seen.push(items); return answers.shift()!(items); };
        try {
            const { webview, posted } = view(SIDEBAR);
            await send(webview, { type: 'qtPickScope' });
            assert.ok(seen[1].every((i: Json) => typeof i.picked === 'boolean'), 'checkboxes per quest');
            const s = last(posted, 'qtScope');
            assert.deepEqual(s.scope.picked, ['beta', 'gamma']);
            assert.deepEqual(s.quests, ['beta', 'gamma']);
            assert.equal(s.buttonText, 'All quests (2/3)');
            answers.push((items) => items.find((i) => i.label === 'gamma'));
            await send(webview, { type: 'qtPickScope' });
            const one = last(posted, 'qtScope');
            assert.deepEqual([one.scope.kind, one.quests, one.plain], ['one', ['gamma'], false], 'another quest than the view\'s own is not plain');
            await send(webview, { type: 'qtSetScope', scope: { kind: 'one', quest: 'alpha' } });
        } finally {
            win.showQuickPick = original;
        }
    });

    test('SC-4: Restore', async () => {
        const { webview, posted } = view(SIDEBAR);
        await send(webview, { type: 'qtRestoreTodo', questId: '__all_quests__', todoId: 'be2', sourceFile: 'beta/todos-archived.beta.todo.yaml' });
        const live = fs.readFileSync(path.join(WS, '_ai/quests/beta/todos.beta.todo.yaml'), 'utf8');
        assert.match(live, /id: be2/);
        assert.doesNotMatch(live, /archived:/);
        assert.doesNotMatch(fs.readFileSync(path.join(WS, '_ai/quests/beta/todos-archived.beta.todo.yaml'), 'utf8'), /id: be2/);
        assert.ok(posted.some((m) => m.type === 'qtRefreshRequest'), 'the panel loads again');
        const errors = vscodeStub.spies.byMethod('window.showErrorMessage').length;
        await send(webview, { type: 'qtRestoreTodo', questId: '__all_quests__', todoId: 'be3', sourceFile: 'beta/todos-archived.beta.todo.yaml' });
        const err = vscodeStub.spies.byMethod('window.showErrorMessage').slice(errors).map((c) => String(c.args[0]));
        assert.match(err[0] ?? '', /Restore of be3 refused: .*already holds a todo be3/);
    });

    test('SC-5: a changed todo file', () => {
        const { webview, posted } = view(SIDEBAR);
        sendQuestTodoRefresh(webview as Json);
        assert.deepEqual(posted, [{ type: 'qtRefreshRequest' }]);
    });

    test('SC-6: views without a scope', async () => {
        for (const config of [{ mode: 'session' }, { mode: 'workspace-file' }, { mode: 'fixed-file', fixedQuestId: 'alpha', fixedFile: 'todos.alpha.todo.yaml' }]) {
            const { webview, posted } = view(config);
            await send(webview, { type: 'qtGetScope' });
            assert.equal(last(posted, 'qtScope').available, false, JSON.stringify(config));
        }
    });

    test('SC-8: a group of another quest in the list', async () => {
        const win = vscodeStub.stub.window as Json;
        const original = win.showInputBox;
        const titles: string[] = [];
        win.showInputBox = async (opts: Json) => { titles.push(String(opts.title)); return undefined; };
        try {
            const multi = view({ ...SIDEBAR, scopeInstance: 'sc8-multi' });
            await send(multi.webview, { type: 'qtSetScope', scope: { kind: 'all', files: { live: true, archived: false, deleted: false }, order: 'combined' } });
            await send(multi.webview, { type: 'qtRenameGroup', questId: 'beta', prefix: 'be' });
            assert.match(titles.at(-1)!, /of quest beta$/);
            const one = view({ ...SIDEBAR, scopeInstance: 'sc8-one' });
            await send(one.webview, { type: 'qtGetScope' });
            await send(one.webview, { type: 'qtRenameGroup', questId: 'beta', prefix: 'be' });
            assert.match(titles.at(-1)!, /of quest alpha$/, 'not in its scope: the panel\'s own quest');
        } finally { win.showInputBox = original; }
    });

    test('SC-7: @TOM TODO', async () => {
        const TOM_TODO = { scopeInstance: 'tom-todo', defaultScopeKind: 'workspace', questPrefixByDefault: true, hideQuestSelect: true };
        const { webview, posted } = view(TOM_TODO);
        await send(webview, { type: 'qtGetScope' });
        const s = last(posted, 'qtScope');
        assert.equal(s.scope.kind, 'workspace', 'the workspace\'s quests (vscimpb144)');
        assert.deepEqual(s.quests, ['alpha', 'beta', 'gamma'], 'no workspace list: every quest');
        assert.equal(s.prefix, true, 'the quest prefix on');
        assert.equal(s.buttonText, 'Workspace quests (3)');
        assert.equal(s.plain, false);
        // Its own scope: changing it leaves QUEST TODOS as it is, and the other way round.
        await send(webview, { type: 'qtSetScope', scope: { ...s.scope, files: { live: true, archived: true, deleted: true } } });
        const sidebar = view(SIDEBAR);
        await send(sidebar.webview, { type: 'qtGetScope' });
        assert.deepEqual(last(sidebar.posted, 'qtScope').scope.files, { live: true, archived: false, deleted: false });
        assert.equal(last(sidebar.posted, 'qtScope').prefix, false);
        // Its own sort / filter state.
        await send(webview, { type: 'qtSaveState', state: { sortFields: [{ field: 'title', asc: true }] } });
        await send(sidebar.webview, { type: 'qtSaveState', state: { sortFields: [{ field: 'id', asc: false }] } });
        await send(webview, { type: 'qtGetState' });
        assert.deepEqual(last(posted, 'qtState').state.sortFields, [{ field: 'title', asc: true }]);
        // Without an active quest (a window on `default`): the workspace's quests.
        const ws = vscodeStub.stub.workspace as Record<string, unknown>;
        const file = ws.workspaceFile;
        ws.workspaceFile = { fsPath: path.join(WS, 'default.code-workspace'), scheme: 'file' };
        try {
            const fresh = view({ ...TOM_TODO, scopeInstance: 'tom-todo-2' });
            await send(fresh.webview, { type: 'qtGetScope' });
            const none = last(fresh.posted, 'qtScope');
            assert.equal(none.scope.kind, 'workspace');
            assert.deepEqual(none.quests, ['alpha', 'beta', 'gamma']);
            assert.equal(none.prefix, true);
        } finally {
            ws.workspaceFile = file;
        }
    });
});
