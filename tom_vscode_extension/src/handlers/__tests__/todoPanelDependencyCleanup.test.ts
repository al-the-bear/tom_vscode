/**
 * The todo panel's dependency cleanup button, host and page (src/handlers/questTodoPanel-handler.ts
 * runTodoDependencyCleanup, media/questTodoPanel/main.js), through the vscode stub in a sandbox workspace.
 *
 *   DB-1 the host asks which todos — the ones the list shows (their count), the open windows' quests, all quests —
 *        then runs the pass on the choice: here the todos shown, so only they change
 *   DB-2 the status bar shows "Checking todo dependencies n/m" counting up to m, and is gone afterwards; the
 *        summary is shown; the panel is told to load its list again
 *   DB-3 dismissing the picker changes nothing
 *   DB-4 the page: the button sends the todos the list shows after its filters (id and file); the answer
 *        reloads the list
 */

/* eslint-disable @typescript-eslint/naming-convention -- the todo schema's YAML keys */
import { describe, test, after } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'fs';
import * as path from 'path';
import { JSDOM } from 'jsdom';

const EXT = path.resolve(__dirname, '..', '..', '..');
const SANDBOX = fs.realpathSync(fs.mkdtempSync(path.join(EXT, '..', '..', '..', 'ztmp', 'vscode_extension_261119_depcleanup_panel-')));
const WS = path.join(SANDBOX, 'ws');
fs.mkdirSync(path.join(SANDBOX, '.tom'), { recursive: true });
fs.writeFileSync(path.join(SANDBOX, '.tom', 'tom_root.yaml'), 'root: true\n');
for (const q of ['qa', 'qb']) { fs.mkdirSync(path.join(WS, '_ai', 'quests', q), { recursive: true }); }
process.env.HOME = path.join(SANDBOX, 'home');
process.env.USERPROFILE = process.env.HOME;
fs.mkdirSync(process.env.HOME, { recursive: true });

import { installVscodeStub } from '../../tools/__tests__/_vscode-stub.js';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Json = any;
const infos: string[] = [];
const vs = installVscodeStub({ workspaceFolders: [WS], methodOverrides: { showInformationMessage: async (m: unknown) => { infos.push(String(m)); return undefined; } } });
(vs.stub.workspace as Json).workspaceFile = { fsPath: path.join(WS, 'qa.code-workspace'), scheme: 'file' };
let pickItems: Json[] = [];
let pickAnswer: (items: Json[]) => Json = () => undefined;
(vs.stub.window as Json).showQuickPick = async (items: Json[]) => { pickItems = items; return pickAnswer(items); };
const barTexts: string[] = [];
let barDisposed = 0;
(vs.stub.window as Json).createStatusBarItem = () => {
    const item: Json = { show: () => undefined, hide: () => undefined, dispose: () => { barDisposed++; } };
    let text = '';
    Object.defineProperty(item, 'text', { get: () => text, set: (v: string) => { text = v; barTexts.push(v); } });
    return item;
};
after(() => { vs.restore(); fs.rmSync(SANDBOX, { recursive: true, force: true }); });

import { createTodo, findTodoById } from '../../managers/questTodoManager.js';
import { handleQuestTodoMessage } from '../questTodoPanel-handler.js';

createTodo('qa', { id: 'gate1', description: 'open', status: 'in-progress' } as never);
createTodo('qa', { id: 'gate2', description: 'done', status: 'completed' } as never);
createTodo('qa', { id: 'w1', description: 'shown', status: 'blocked', blocked_by: ['gate2'] } as never);
createTodo('qa', { id: 'w2', description: 'not shown', status: 'blocked', blocked_by: ['gate2', 'vanished1'] } as never);
createTodo('qa', { id: 'w3', description: 'shown, still blocked', status: 'blocked', blocked_by: ['gate1', 'gate2'] } as never);

const posted: Json[] = [];
const webview = { postMessage: async (m: Json) => { posted.push(JSON.parse(JSON.stringify(m))); return true; } } as never;

describe('the todo panel: dependency cleanup', () => {
    test('DB-3: dismissed', async () => {
        pickAnswer = () => undefined;
        await handleQuestTodoMessage({ type: 'qtDependencyCleanup', questId: 'qa', visible: [{ id: 'w1', sourceFile: 'todos.qa.todo.yaml' }] }, webview);
        assert.equal(pickItems.length, 3);
        assert.equal(findTodoById('qa', 'w1')!.status, 'blocked', 'nothing changed');
        assert.equal(barTexts.length, 0);
    });

    test('DB-1 / DB-2: the todos shown', async () => {
        posted.length = 0;
        pickAnswer = (items) => items[0];
        await handleQuestTodoMessage({ type: 'qtDependencyCleanup', questId: 'qa', visible: [
            { id: 'w1', sourceFile: 'todos.qa.todo.yaml' }, { id: 'w3', sourceFile: 'todos.qa.todo.yaml' },
        ] }, webview);
        assert.deepEqual(pickItems.map((p: Json) => p.label), ['$(list-filter) The todos shown in the list', "$(window) The open windows' quests", '$(globe) All quests']);
        assert.equal(pickItems[0].description, '2 todos');
        assert.equal(findTodoById('qa', 'w1')!.status, 'not-started');
        assert.equal(findTodoById('qa', 'w1')!.blocked_by, undefined);
        assert.deepEqual(findTodoById('qa', 'w3')!.blocked_by, ['gate1'], 'the open blocker stays');
        assert.equal(findTodoById('qa', 'w3')!.status, 'blocked');
        assert.deepEqual(findTodoById('qa', 'w2')!.blocked_by, ['gate2', 'vanished1'], 'not shown: unchanged');
        assert.equal(barTexts[0], '$(sync~spin) Checking todo dependencies…');
        assert.ok(barTexts.includes('$(sync~spin) Checking todo dependencies 0/2'));
        assert.equal(barTexts.at(-1), '$(sync~spin) Checking todo dependencies 2/2');
        assert.equal(barDisposed, 1, 'gone afterwards');
        assert.match(infos.at(-1)!, /^Todo dependencies: 2 todos checked, 2 blocked_by entries removed \(2 done, 0 no longer a live todo\), 1 unblocked/);
        assert.ok(posted.some((m) => m.type === 'qtDependencyCleanupDone'));
    });

    test('DB-1: all quests', async () => {
        pickAnswer = (items) => items[2];
        await handleQuestTodoMessage({ type: 'qtDependencyCleanup', questId: 'qa', visible: [] }, webview);
        assert.equal(findTodoById('qa', 'w2')!.status, 'not-started', 'done and vanished blockers both gone');
        assert.equal(findTodoById('qa', 'w2')!.blocked_by, undefined);
    });

    test('DB-4: the page', (t) => {
        const media = (...p: string[]): string => fs.readFileSync(path.join(EXT, 'media', ...p), 'utf8');
        const dom = new JSDOM(`<body>${media('questTodoPanel', 'fragment.html')}</body>`, { runScripts: 'outside-only' });
        const w = dom.window as Json;
        t.after(() => w.close());
        const sent: Json[] = [];
        w.vscode = { postMessage: (m: Json) => sent.push(JSON.parse(JSON.stringify(m))), getState: () => undefined, setState: () => undefined };
        w.eval('var qtViewConfig = {};\n' + media('questTodoPanel', 'grouping.js') + media('questTodoPanel', 'main.js'));
        w.qtHandleMessage({ type: 'qtTodos', questId: 'qa', file: 'all', todos: [
            { id: 'a1', title: 'Alpha', status: 'blocked', sourceFile: 'todos.qa.todo.yaml' },
            { id: 'b1', title: 'Beta', status: 'completed', sourceFile: 'todos.qa.todo.yaml' },
        ] });
        const field = w.document.getElementById('qt-search');
        field.value = 'alpha';
        field.dispatchEvent(new w.Event('input'));
        const btn = w.document.getElementById('qt-btn-dep-cleanup');
        assert.match(btn.getAttribute('title'), /^Clean up the todo dependencies/);
        btn.click();
        assert.deepEqual(sent.filter((m) => m.type === 'qtDependencyCleanup').pop(), { type: 'qtDependencyCleanup', questId: w.eval('qtCurrentQuestId'), visible: [{ id: 'a1', sourceFile: 'todos.qa.todo.yaml' }] });
        sent.length = 0;
        w.qtHandleMessage({ type: 'qtDependencyCleanupDone' });
        assert.equal(sent.filter((m) => m.type === 'qtGetTodos').length, 1, 'the list is loaded again');
    });
});
