/**
 * The todo panel shows todo groups (vscimpb126): the real fragment.html, grouping.js and main.js in jsdom.
 *
 *   TGP-1 a group todo heads its members like a prefix group: title, member count, progress (done / all, every
 *         member counted); collapsed at first, the arrow expands it; members in `comprised_of` order; a member also
 *         stays in its prefix group (shown twice)
 *   TGP-2 a member of another quest is a line with its quest/id and title; an archived member is marked; a member
 *         the filter hides is left out
 *   TGP-3 a click on the header (not the arrow) selects the group todo and asks for its details
 *   TGP-4 a member's row shows its groups (part_of) as chips; a click goes to the group (its quest for `<quest>/<id>`)
 *   TGP-5 the detail view: Members (badges in order, ◀ ▶ reorder, × removes, the form sends comprised_of), Part of
 *         (read-only); the Members row of a todo that is no group appears when its status is set to `group`
 *   TGP-6 the group's queue button (header, detail view) asks the host to queue the group as a GROUP item (vscimpb127)
 *   TGP-8 a tile's queue button queues an individual todo as the detail's Queue button does (qtTodoButton, a
 *         normal prompt with the todo id), a group todo as a GROUP item; the detail view's "Queue as todo item"
 *         asks for a TODO item; a done todo's tile has none
 *   TGP-7 qtTodoGroupsOf (grouping.js): the groups by title, progress over all members, members marked foreign
 */

import test, { describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import vm from 'node:vm';
import { JSDOM } from 'jsdom';

function readPanelAsset(file: string): string {
    return readFileSync(join(__dirname, '..', '..', '..', 'media', 'questTodoPanel', file), 'utf-8');
}

interface Msg { type: string; [k: string]: unknown }

/** A value from the jsdom / vm realm as a plain one (deepStrictEqual compares prototypes). */
const plain = <T>(v: T): T => JSON.parse(JSON.stringify(v)) as T;

function setupPanel(todos: unknown[], quest = 'qa'): { window: any; sent: Msg[] } {
    const dom = new JSDOM(`<!DOCTYPE html><body>${readPanelAsset('fragment.html')}</body>`, { runScripts: 'outside-only' });
    const window = dom.window as any;
    const sent: Msg[] = [];
    window.vscode = { postMessage: (m: Msg) => { sent.push(m); } };
    window.eval('var qtViewConfig = {};');
    window.eval(readPanelAsset('grouping.js'));
    window.eval(readPanelAsset('main.js'));
    window.eval(`qtCurrentQuestId = ${JSON.stringify(quest)};`);
    window.qtTodos = todos;
    window.eval('qtRenderList()');
    return { window, sent };
}

const MEMBERS = [
    { ref: 'rel2-changelog', quest: 'qa', id: 'rel2-changelog', title: 'Changelog', status: 'completed', found: true },
    { ref: 'qb/b7-docs', quest: 'qb', id: 'b7-docs', title: 'Docs in qb', status: 'not-started', found: true },
    { ref: 'rel3-tag', quest: 'qa', id: 'rel3-tag', title: 'Tag', status: 'in-progress', found: true },
    { ref: 'rel9-old', quest: 'qa', id: 'rel9-old', title: 'Old step', status: 'completed', found: true },
];
const TODOS = [
    { id: 'rel1-release', title: 'Release 2.0', status: 'group', priority: 'high', comprised_of: MEMBERS.map((m) => m.ref), group_members: MEMBERS, sourceFile: 'todos.qa.todo.yaml' },
    { id: 'rel2-changelog', title: 'Changelog', status: 'completed', part_of: ['rel1-release'], sourceFile: 'todos.qa.todo.yaml' },
    { id: 'rel3-tag', title: 'Tag', status: 'in-progress', part_of: ['rel1-release', 'qb/bg1-big'], sourceFile: 'todos.qa.todo.yaml' },
    { id: 'misc1-other', title: 'Other', status: 'not-started', sourceFile: 'todos.qa.todo.yaml' },
];

const header = (w: any) => w.document.querySelector('#qt-list-pane .qt-todogroup-header');
const memberIds = (w: any) => [...w.document.querySelectorAll('#qt-list-pane .qt-todogroup-members > *')]
    .map((el: any) => el.getAttribute('data-qt-id') ?? `line:${el.getAttribute('data-qt-member-ref')}`);

describe('todo groups in the todo panel', () => {
    test('TGP-1: the group heads its members', () => {
        const { window } = setupPanel(TODOS);
        const h = header(window);
        assert.ok(h, 'a todo-group header');
        assert.equal(h.querySelector('.qt-group-label').textContent, 'Release 2.0');
        assert.equal(h.querySelector('.qt-group-count').textContent, '(4)');
        // Two lines, like a todo's row: the title line, then the priority dot and the id.
        assert.ok(h.querySelector('.qt-todogroup-row1 .qt-todogroup-toggle') && h.querySelector('.qt-todogroup-row1 .qt-todogroup-icon'), 'arrow and folder in front');
        assert.equal(h.querySelector('.qt-todogroup-row2 .tid').textContent, 'rel1-release', 'its id on the second line');
        assert.ok(h.querySelector('.qt-todogroup-row2 .qt-priority-dot.high'), 'its priority dot');
        assert.equal(h.querySelector('.qt-todogroup-progress').textContent, '2/4', 'Changelog and the archived Old step are done');
        assert.ok(h.classList.contains('collapsed'));
        assert.deepEqual(memberIds(window), []);
        h.querySelector('.qt-todogroup-toggle').click();
        assert.deepEqual(memberIds(window), ['rel2-changelog', 'line:qb/b7-docs', 'rel3-tag', 'line:rel9-old'], 'comprised_of order');
        window.eval('qtExpandAllGroups()');
        const tagRows = window.document.querySelectorAll('#qt-list-pane .qt-todo-item[data-qt-id="rel3-tag"]');
        assert.equal(tagRows.length, 2, 'in the group and in its prefix group');
    });

    test('TGP-2: foreign, archived and filtered members', () => {
        const { window } = setupPanel(TODOS);
        header(window).querySelector('.qt-todogroup-toggle').click();
        const lines = [...window.document.querySelectorAll('.qt-group-member-line')] as any[];
        assert.equal(lines[0].querySelector('.tid').textContent, 'qb/b7-docs');
        assert.equal(lines[0].querySelector('.ttitle').textContent, 'Docs in qb');
        assert.match(lines[1].querySelector('.ttitle').textContent, /Old step \(archived\)/);
        window.eval("qtFilterState.status = ['group', 'in-progress']; qtRenderList();");
        assert.deepEqual(memberIds(window), ['line:qb/b7-docs', 'rel3-tag', 'line:rel9-old'], 'the completed Changelog row is filtered out');
    });

    test('TGP-3: the header opens the group', () => {
        const { window, sent } = setupPanel(TODOS);
        header(window).querySelector('.qt-group-label').click();
        assert.equal(window.eval('qtSelectedTodoId'), 'rel1-release');
        assert.deepEqual(sent.filter((m) => m.type === 'qtGetTodo').map((m) => [m.questId, m.todoId]), [['qa', 'rel1-release']]);
        assert.ok(header(window).classList.contains('collapsed'), 'opening it does not toggle it');
    });

    test('TGP-4: part_of chips', () => {
        const { window, sent } = setupPanel(TODOS);
        window.eval('qtExpandAllGroups()');
        const row = window.document.querySelector('#qt-list-pane .qt-todo-item[data-qt-id="misc1-other"]');
        assert.equal(row.querySelectorAll('.qt-partof-chip').length, 0);
        const tag = window.document.querySelector('#qt-list-pane .qt-todo-item[data-qt-id="rel3-tag"]');
        const chips = [...tag.querySelectorAll('.qt-partof-chip')] as any[];
        assert.deepEqual(chips.map((c) => c.getAttribute('data-qt-partof')), ['rel1-release', 'qb/bg1-big']);
        chips[1].click();
        assert.deepEqual(plain(sent.at(-1)), { type: 'qtGetTodo', questId: 'qb', todoId: 'bg1-big' });
        window.eval('qtCollapseAllGroups()');
        window.eval('qtExpandedGroups["#misc"] = true; qtExpandedGroups["#rel"] = true; qtRenderList();');
        window.document.querySelector('#qt-list-pane .qt-todo-item[data-qt-id="rel3-tag"] .qt-partof-chip').click();
        assert.deepEqual(plain(sent.at(-1)), { type: 'qtGetTodo', questId: 'qa', todoId: 'rel1-release', sourceFile: 'todos.qa.todo.yaml' });
        assert.equal(header(window).classList.contains('collapsed'), false, 'the group is opened');
    });

    test('TGP-5: the detail view', () => {
        const { window } = setupPanel(TODOS);
        window.qtRenderDetail({ ...TODOS[0], comprised_of: [...TODOS[0].comprised_of as string[]], description: 'd' });
        const ids = () => [...window.document.querySelectorAll('#qt-d-comprised-wrap .qt-todo-badge')].map((b: any) => b.getAttribute('data-qt-badge-id'));
        assert.deepEqual(ids(), ['rel2-changelog', 'qb/b7-docs', 'rel3-tag', 'rel9-old']);
        assert.match(window.document.querySelector('#qt-d-members-row').textContent, /Members \(2\/4 done\)/);
        window.document.querySelector('#qt-d-comprised-wrap .qt-badge-move[data-qt-badge-id="rel2-changelog"][data-qt-move-dir="1"]').click();
        assert.deepEqual(ids(), ['qb/b7-docs', 'rel2-changelog', 'rel3-tag', 'rel9-old']);
        window.document.querySelector('#qt-d-comprised-wrap .qt-badge-remove[data-qt-badge-id="rel9-old"]').click();
        assert.deepEqual(plain(window.eval('qtCollectFormData()').comprised_of), ['qb/b7-docs', 'rel2-changelog', 'rel3-tag']);

        window.qtRenderDetail({ ...TODOS[2], description: 'd' });
        assert.equal(window.document.querySelector('#qt-d-members-row').style.display, 'none', 'no group: hidden');
        assert.equal(window.eval('qtCollectFormData()').comprised_of, undefined, 'nothing to write');
        const partOf = [...window.document.querySelectorAll('#qt-d-partof-wrap .qt-todo-badge')] as any[];
        assert.deepEqual(partOf.map((b) => b.getAttribute('data-qt-badge-id')), ['rel1-release', 'qb/bg1-big']);
        assert.equal(window.document.querySelectorAll('#qt-d-partof-wrap .qt-badge-remove').length, 0, 'read-only');
        const status = window.document.getElementById('qt-d-status');
        status.value = 'group';
        status.dispatchEvent(new window.Event('change'));
        assert.equal(window.document.querySelector('#qt-d-members-row').style.display, '', 'shown for a new group');
        assert.deepEqual(plain(window.eval('qtCollectFormData()').comprised_of), []);
    });

    test('TGP-6: the queue button', () => {
        const { window, sent } = setupPanel(TODOS);
        window.document.querySelector('.qt-todogroup-queue-btn').click();
        assert.deepEqual(plain(sent.at(-1)), { type: 'qtQueueTodoGroup', questId: 'qa', todoId: 'rel1-release', sourceFile: 'todos.qa.todo.yaml' });
        window.qtRenderDetail({ ...TODOS[0], description: 'd' });
        window.document.getElementById('qt-d-group-queue').click();
        assert.deepEqual(plain(sent.at(-1)), { type: 'qtQueueTodoGroup', questId: 'qa', todoId: 'rel1-release', sourceFile: 'todos.qa.todo.yaml' });
    });

    test('TGP-8: Queue as todo item', () => {
        const { window, sent } = setupPanel(TODOS);
        window.eval('qtExpandAllGroups()');
        const tile = (id: string) => window.document.querySelector(`#qt-list-pane .qt-todo-item[data-qt-id="${id}"]`);
        assert.equal(tile('rel2-changelog').querySelector('.qt-queue-item-btn'), null, 'a done todo has none');
        assert.match(tile('rel3-tag').querySelector('.qt-queue-item-btn').getAttribute('title'), /^Queue this todo: a prompt with the todo in the Todo buttons template/);
        tile('rel3-tag').querySelector('.qt-queue-item-btn').click();
        assert.deepEqual(plain(sent.at(-1)), { type: 'qtTodoButton', target: 'queue', questId: 'qa', todoId: 'rel3-tag', sourceFile: 'todos.qa.todo.yaml' }, 'a normal todo, not a TODO item walk');
        assert.equal(window.eval('qtSelectedTodoId'), '', 'the click does not select the row');
        assert.match(tile('rel1-release').querySelector('.qt-queue-item-btn').getAttribute('title'), /GROUP item/);
        tile('rel1-release').querySelector('.qt-queue-item-btn').click();
        assert.deepEqual(plain(sent.at(-1)), { type: 'qtQueueAsTodoItem', questId: 'qa', todoId: 'rel1-release', sourceFile: 'todos.qa.todo.yaml' }, 'a group todo: a GROUP item');
        window.qtRenderDetail({ ...TODOS[2], description: 'd' });
        const detailBtn = window.document.querySelector('.qt-queue-item-detail-btn');
        assert.match(detailBtn.title, /^Queue as todo item/, 'an icon button: its tooltip names it');
        detailBtn.click();
        assert.deepEqual(plain(sent.at(-1)), { type: 'qtQueueAsTodoItem', questId: 'qa', todoId: 'rel3-tag', sourceFile: 'todos.qa.todo.yaml' });
        // A group todo's Run row: the run-all button queues the group todo itself as a TODO item (its own group
        // buttons queue the GROUP item).
        window.qtRenderDetail({ ...TODOS[0], description: 'd' });
        const groupRunAll = window.document.querySelector('.qt-queue-item-detail-btn');
        assert.match(groupRunAll.title, /the group todo itself as a TODO item/);
        groupRunAll.click();
        assert.deepEqual(plain(sent.at(-1)), { type: 'qtQueueAsTodoItem', questId: 'qa', todoId: 'rel1-release', sourceFile: 'todos.qa.todo.yaml', asTodo: true });
    });
});

describe('qtTodoGroupsOf', () => {
    test('TGP-7: groups, progress, foreign members', () => {
        const sandbox: Record<string, any> = {};
        vm.createContext(sandbox);
        vm.runInContext(readPanelAsset('grouping.js'), sandbox);
        const groups = sandbox.qtTodoGroupsOf([
            { id: 'z1', title: 'Zeta', status: 'group', comprised_of: ['a1', 'qa/a2', 'qb/x'], group_members: [
                { ref: 'a1', status: 'completed' }, { ref: 'qa/a2', status: 'cancelled' }, { ref: 'qb/x', title: 'X', status: 'in-progress' }] },
            { id: 'y1', title: 'Alpha', status: 'completed', comprised_of: ['a1'] },
            { id: 'a1', title: 'A one', status: 'completed' },
            { id: 'plain', title: 'not a group', status: 'not-started' },
        ], 'qa');
        assert.deepEqual(plain(groups.map((g: any) => [g.todo.id, g.done, g.total])), [['y1', 1, 1], ['z1', 2, 3]], 'by title; progress');
        const z = groups[1];
        assert.deepEqual(plain(z.members.map((m: any) => [m.ref, !!m.row, m.foreign])), [['a1', true, false], ['qa/a2', false, false], ['qb/x', false, true]]);
        assert.equal(z.members[2].title, 'X');
    });

    test('TGP-R: the list and the detail follow a membership change at once', () => {
        const { window, sent } = setupPanel(TODOS);
        // The group's detail is open; a member is removed there and saved: the list is loaded again from the host.
        window.eval("qtSelectedTodoId = 'rel1-release'; qtDetailTodo = { id: 'rel1-release', status: 'group', comprised_of: ['rel3-tag'] };");
        sent.length = 0;
        window.qtHandleMessage({ type: 'qtSaved', success: true, todoId: 'rel1-release' });
        assert.ok(sent.some((m: any) => m.type === 'qtGetTodos'), 'a saved group todo reloads the list');
        // Another todo saved: no reload.
        window.eval("qtDetailTodo = { id: 'misc1-other', status: 'not-started' };");
        sent.length = 0;
        window.qtHandleMessage({ type: 'qtSaved', success: true, todoId: 'misc1-other' });
        assert.ok(!sent.some((m: any) => m.type === 'qtGetTodos'));
        // Todos moved into a group todo from the list: the open detail is asked for again.
        sent.length = 0;
        window.qtHandleMessage({ type: 'qtArchiveResult', success: true, moved: [], refreshDetail: true });
        assert.ok(sent.some((m: any) => m.type === 'qtGetTodos'), 'the list');
        assert.ok(sent.some((m: any) => m.type === 'qtGetTodo' && m.todoId === 'rel1-release'), 'and the open detail: ' + JSON.stringify(sent.map((m: any) => m.type)));
    });
});
