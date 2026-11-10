/**
 * The todo panel: moving todos into another id group, and renaming a todo from
 * its detail pane (handlers/questTodoPanel-handler.ts, the webview's buttons).
 *
 *   GM-1 the ID edit: the input box offers the id, refuses one the quest has; the todo is renamed, references in
 *        the quest follow, the webview is told (qtRenamed, then the detail of the new id)
 *   GM-2 "Move to another group…": offered in the move picker; the group picked, the todos are numbered after its
 *        last todo below 999 and placed before its finalizer (`<prefix>999`); their own group is not offered,
 *        nor a group only archived todos hold (it is numbered past, though: `fin5` is taken in the archive);
 *        the groups come alphabetically, with "Enter a prefix…" after them
 *   GM-3 the webview: the ID field has the edit button for a quest todo (not for session todos); a click posts
 *        qtRenameTodo with the id and file; qtRenamed selects the new id and loads the list again
 */

/* eslint-disable @typescript-eslint/naming-convention -- field names are the todo schema's YAML keys (snake_case) */
import test, { describe } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { readFileSync } from 'node:fs';
import { JSDOM } from 'jsdom';

import { installVscodeStub } from '../../tools/__tests__/_vscode-stub.js';

const WS = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'todo-group-move-')));
const QUEST = 'qp';
const stubbed = installVscodeStub({ workspaceFolders: [WS] });
const stubWindow = stubbed.stub.window as Record<string, unknown>;

import * as questTodo from '../../managers/questTodoManager.js';
import { handleQuestTodoMessage } from '../questTodoPanel-handler.js';

const ROOT = path.resolve(__dirname, '..', '..', '..');
const media = (...p: string[]): string => readFileSync(path.join(ROOT, 'media', ...p), 'utf-8');
const main = path.join(WS, '_ai', 'quests', QUEST, `todos.${QUEST}.todo.yaml`);

function seed(ids: string[]): void {
    for (const id of ids) {
        questTodo.createTodoInFile(main, { id, title: `T ${id}`, description: `do ${id}`, status: 'not-started' } as never);
    }
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Json = any;
function fakeWebview(): { webview: never; posted: Json[] } {
    const posted: Json[] = [];
    return { webview: { postMessage: async (m: Json) => { posted.push(JSON.parse(JSON.stringify(m))); return true; } } as never, posted };
}

describe('todo panel: another group, and the id edit', () => {
    test('GM-1: renaming from the detail pane', async () => {
        seed(['ren1_ba-old', 'ren2_ba-other']);
        questTodo.updateTodoInFile(main, 'ren2_ba-other', { blocked_by: ['ren1_ba-old'] } as never);
        let offered: Json;
        stubWindow.showInputBox = async (opts: Json) => { offered = opts; return 'ren7_ba-new'; };
        const { webview, posted } = fakeWebview();
        await handleQuestTodoMessage({ type: 'qtRenameTodo', questId: QUEST, todoId: 'ren1_ba-old', sourceFile: `todos.${QUEST}.todo.yaml` }, webview);
        assert.equal(offered.value, 'ren1_ba-old', 'the input offers the id');
        assert.match(String(offered.validateInput('ren2_ba-other')), /already has a todo ren2_ba-other/);
        assert.equal(offered.validateInput('ren8_ba-free'), undefined);
        assert.ok(questTodo.findTodoByIdInFile(main, 'ren7_ba-new'), 'renamed');
        assert.deepEqual(questTodo.findTodoByIdInFile(main, 'ren2_ba-other')!.blocked_by, ['ren7_ba-new'], 'the reference follows');
        assert.deepEqual(posted.find((m) => m.type === 'qtRenamed'), { type: 'qtRenamed', oldId: 'ren1_ba-old', todoId: 'ren7_ba-new' });
        const detail = posted.find((m) => m.type === 'qtTodoDetail');
        assert.equal(detail?.todo?.id, 'ren7_ba-new', 'then the detail of the new id');
    });

    test('GM-2: Move to another group', async () => {
        seed(['fin1_bb-a', 'fin2_bb-b', 'fin999_bb-final', 'mov1_bb-x', 'mov2_bb-y', 'abc1_bb-z']);
        const archived = path.join(WS, '_ai', 'quests', QUEST, `todos-archived.${QUEST}.todo.yaml`);
        questTodo.createTodoInFile(archived, { id: 'oldgrp1_bb-done', title: 'T', description: 'd', status: 'completed' } as never);
        questTodo.createTodoInFile(archived, { id: 'fin5_bb-done', title: 'T', description: 'd', status: 'completed' } as never);
        const pickers: Json[] = [];
        stubWindow.showQuickPick = async (items: Json[], opts: Json) => {
            pickers.push({ items, opts });
            if (pickers.length === 1) { return items.find((i) => i.choice?.kind === 'pickGroup'); }
            return items.find((i) => i.option?.prefix === 'fin');
        };
        const { webview } = fakeWebview();
        await handleQuestTodoMessage({
            type: 'qtMoveTodosToDestination', questId: QUEST, file: 'all',
            todos: [{ todoId: 'mov1_bb-x', sourceFile: `todos.${QUEST}.todo.yaml` }, { todoId: 'mov2_bb-y', sourceFile: `todos.${QUEST}.todo.yaml` }],
        }, webview);
        assert.ok(pickers[0].items.some((i: Json) => /Move to another group/.test(i.label)), 'offered');
        assert.ok(!pickers[1].items.some((i: Json) => i.option?.prefix === 'mov'), 'not their own group');
        const groups = pickers[1].items.filter((i: Json) => i.option?.kind === 'group').map((i: Json) => i.option.prefix);
        assert.ok(!groups.includes('oldgrp'), 'a group only archived todos hold is not offered');
        assert.deepEqual(groups, [...groups].sort(), 'alphabetically');
        assert.equal(pickers[1].items[groups.length].option.kind, 'custom', 'then Enter a prefix…');
        const ids = questTodo.readTodoFile(main).map((t) => t.id).filter((id) => /^(fin|mov)/.test(id));
        assert.deepEqual(ids, ['fin1_bb-a', 'fin2_bb-b', 'fin6_bb-x', 'fin7_bb-y', 'fin999_bb-final'], 'at the end of the group, before its finalizer, numbered past the archived fin5');
    });

    test('GM-3: the webview', () => {
        const setup = (mode: string): { w: Json; posted: Json[] } => {
            const w = new JSDOM(`<body>${media('questTodoPanel', 'fragment.html')}</body>`, { runScripts: 'outside-only' }).window as Json;
            const posted: Json[] = [];
            w.vscode = { postMessage: (m: Json) => posted.push(JSON.parse(JSON.stringify(m))), getState: () => undefined, setState: () => undefined };
            w.eval(`var qtViewConfig = ${JSON.stringify(mode ? { mode } : {})};\n` + media('questTodoPanel', 'grouping.js') + media('questTodoPanel', 'main.js'));
            w.eval("qtCurrentQuestId = 'qp';");
            return { w, posted };
        };
        const { w, posted } = setup('');
        w.qtRenderDetail({ id: 'ren9_bc-x', title: 'X', status: 'not-started', _sourceFile: 'todos.qp.todo.yaml' });
        const btn = w.document.getElementById('qt-d-id-edit');
        assert.ok(btn, 'the edit button');
        btn.click();
        assert.deepEqual(posted.filter((m) => m.type === 'qtRenameTodo'), [{ type: 'qtRenameTodo', questId: 'qp', todoId: 'ren9_bc-x', sourceFile: 'todos.qp.todo.yaml' }]);
        posted.length = 0;
        w.qtHandleMessage({ type: 'qtRenamed', oldId: 'ren9_bc-x', todoId: 'ren10_bc-x' });
        assert.equal(w.eval('qtSelectedTodoId'), 'ren10_bc-x');
        assert.equal(posted.filter((m) => m.type === 'qtGetTodos').length, 1);
        const session = setup('session');
        session.w.qtRenderDetail({ id: 'wt-3', title: 'S', status: 'pending' });
        assert.equal(session.w.document.getElementById('qt-d-id-edit'), null, 'no edit for session todos');
    });
});
