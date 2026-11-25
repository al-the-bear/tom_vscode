/**
 * A GROUP item's members and its selection (vscimpb129, src/utils/groupItemSelection.ts and the walk rules in
 * queueStep3Utils.ts).
 *
 *   GS-1 the members in comprised_of order with their markers: → the member being sent, ✓ completed / needs
 *        attention for those sent, a checkbox for the others, checked by the walk's rules — a prefix walk's: not
 *        started, blocked or decision-needed (the walk holds there), not the user's own; a completed, in-progress or
 *        user-action member unchecked
 *   GS-2 the user's choices win over the rules: a completed or blocked member checked, an open one unchecked; a
 *        member added later follows the rules, a removed one is dropped
 *   GS-3 the walk sends exactly the checked members, in order: a checked completed / blocked / user-action member is
 *        picked, an unchecked open one passed; a sent member is never picked again; nothing checked → empty reason
 *   GS-4 the selection helpers: one member's choice, select all, the selection of a list, parse
 *   GS-5 an unchecked decision-needed member holds no walk; an unchecked user-action member is not reported as left
 *        to the user
 *   GS-6 the queue editor's list: → / ✓ / ⚠ / checkbox rows (a sent member's mark alone, its outcome on hover),
 *        Select all / Reset to rules while editable, their messages; no buttons and disabled boxes on a sent item
 *   GS-7 a `<prefix>*` walk lists its todos the same way, lowest number first (only the prefix's, by number); a TODO
 *        item (one todo) lists none
 *   GS-8 the item header shows what a walk walks in place of the repeat counters — `todos <prefix>*`, `todo group
 *        <id>`, `todo <id>` — with no [MP …] / [T …] counter; the prefix walk's list is headed Todos, a group's Members
 *   GS-9 a prefix walk sends exactly its checked todos: a checked completed or blocked one is sent, an unchecked open
 *        one passed
 */

import test, { describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { JSDOM } from 'jsdom';

import { groupItemMembers, memberMarkerText, parseGroupSelection, selectionOf, withMemberChoice, withSelectionFlags } from '../groupItemSelection.js';
import { collectUserActionTodos, decisionHoldingWalk, emptyTodoIterationReason, pickNextTodoForIteration, type TodoIterationSource } from '../queueStep3Utils.js';

const WALK = { kind: 'group' as const, quest: 'q1', id: 'g1' };
const VALUE = 'group:q1/g1';
const TODOS: TodoIterationSource[] = [
    { id: 'g1', title: 'the group', status: 'group', comprisedOf: ['a1', 'b1', 'c1', 'd1', 'e1', 'f1'] },
    { id: 'a1', title: 'A', status: 'completed' },
    { id: 'b1', title: 'B', status: 'not-started' },
    { id: 'c1', title: 'C', status: 'blocked' },
    { id: 'd1', title: 'D', status: 'not-started', userAction: true },
    { id: 'e1', title: 'E', status: 'not-started' },
    { id: 'f1', title: 'F', status: 'in-progress' },
];

describe('the members of a GROUP item', () => {
    test('GS-1: markers and the rules', () => {
        const rows = groupItemMembers({ walk: WALK, todos: TODOS, sent: new Set(['a1', 'f1']), sendingId: 'b1' });
        assert.deepEqual(rows.map((r) => [r.id, r.marker, r.outcome ?? r.checked ?? null]), [
            ['a1', 'sent', 'completed'], ['b1', 'sending', null], ['c1', 'todo', true],
            ['d1', 'todo', false], ['e1', 'todo', true], ['f1', 'sent', 'needs attention'],
        ]);
        assert.equal(rows[0].title, 'A');
        assert.deepEqual(rows.map(memberMarkerText), ['✓ completed', '→', '☑', '☐', '☑', '✓ needs attention']);
        // Blocked and decision-needed members are queued like a prefix walk's: the walk holds there; the user's own is not.
        const held = groupItemMembers({ walk: WALK, todos: TODOS.map((t) => (t.id === 'e1' ? { ...t, status: 'decision-needed' } : t.id === 'd1' ? { ...t, status: 'blocked' } : t)), sent: new Set() });
        assert.deepEqual(held.map((r) => [r.id, r.checked]), [['a1', false], ['b1', true], ['c1', true], ['d1', false], ['e1', true], ['f1', false]]);
        assert.deepEqual(groupItemMembers({ walk: { kind: 'prefix', prefix: 'x' }, todos: TODOS, sent: new Set() }), [], 'no GROUP item');
    });

    test('GS-2: choices over rules; added and removed members', () => {
        const selection = { checked: ['a1', 'c1', 'gone1'], unchecked: ['e1'] };
        const rows = groupItemMembers({ walk: WALK, todos: TODOS, selection, sent: new Set() });
        assert.deepEqual(rows.map((r) => [r.id, r.checked, r.byRule, r.chosen ?? false]), [
            ['a1', true, false, true], ['b1', true, true, false], ['c1', true, true, true],
            ['d1', false, false, false], ['e1', false, true, true], ['f1', false, false, false],
        ]);
        const later = TODOS.map((t) => (t.id === 'g1' ? { ...t, comprisedOf: ['a1', 'e1', 'n1'] } : t)).concat({ id: 'n1', status: 'not-started' });
        assert.deepEqual(groupItemMembers({ walk: WALK, todos: later, selection, sent: new Set() }).map((r) => [r.id, r.checked]),
            [['a1', true], ['e1', false], ['n1', true]], 'n1 added later follows the rules; b1..f1 removed are gone');
    });

    test('GS-3: the walk sends exactly the checked members', () => {
        const selection = { checked: ['a1', 'c1', 'd1'], unchecked: ['b1', 'e1'] };
        const sent = new Set<string>();
        const order: string[] = [];
        for (let i = 0; i < 10; i++) {
            const next = pickNextTodoForIteration(VALUE, withSelectionFlags(TODOS, selection, sent));
            if (!next) { break; }
            order.push(next.id);
            sent.add(next.id);
        }
        assert.deepEqual(order, ['a1', 'c1', 'd1'], 'a completed, a blocked and a user-action member checked; b1, e1 unchecked');
        const rulesOnly = pickNextTodoForIteration(VALUE, withSelectionFlags(TODOS, undefined, new Set()));
        assert.equal(rulesOnly?.id, 'b1', 'without a selection: the rules');
        const none = { checked: [], unchecked: ['b1', 'c1', 'e1'] };
        assert.equal(pickNextTodoForIteration(VALUE, withSelectionFlags(TODOS, none, new Set())), undefined);
        assert.match(emptyTodoIterationReason(VALUE, withSelectionFlags(TODOS, none, new Set()), 'q1') ?? '', /none of the 3 todos/,
            'the unchecked ones are not counted');
        const all = { checked: [], unchecked: ['a1', 'b1', 'c1', 'd1', 'e1', 'f1'] };
        assert.match(emptyTodoIterationReason(VALUE, withSelectionFlags(TODOS, all, new Set()), 'q1') ?? '', /unchecked in the item's selection/);
    });

    test('GS-4: the helpers', () => {
        const one = withMemberChoice(undefined, 'b1', false);
        assert.deepEqual(one, { checked: [], unchecked: ['b1'] });
        assert.deepEqual(withMemberChoice(one, 'b1', true), { checked: ['b1'], unchecked: [] });
        assert.deepEqual(selectionOf(['a1', 'b1', 'c1'], ['c1', 'a1']), { checked: ['a1', 'c1'], unchecked: ['b1'] });
        assert.deepEqual(parseGroupSelection({ checked: ['a1', 3, ''], unchecked: 'x' }), { checked: ['a1'], unchecked: [] });
        assert.equal(parseGroupSelection({ checked: [] }), undefined);
        assert.equal(parseGroupSelection('x'), undefined);
    });

    test('GS-5: unchecked members hold nothing and are not left to the user', () => {
        const todos = TODOS.concat({ id: 'q9', status: 'decision-needed' }).map((t) => (t.id === 'g1' ? { ...t, comprisedOf: ['q9', 'd1', 'b1'] } : t));
        assert.equal(decisionHoldingWalk(VALUE, todos).length, 1, 'by the rules q9 holds the walk');
        const flagged = withSelectionFlags(todos, { checked: [], unchecked: ['q9', 'd1'] }, new Set());
        assert.equal(decisionHoldingWalk(VALUE, flagged).length, 0);
        assert.deepEqual(collectUserActionTodos(VALUE, flagged), []);
        assert.equal(pickNextTodoForIteration(VALUE, flagged)?.id, 'b1');
    });
});

function readMedia(...parts: string[]): string {
    return readFileSync(join(__dirname, '..', '..', '..', 'media', ...parts), 'utf-8');
}

describe('the queue editor\'s member list', () => {
    test('GS-6: rows, buttons and messages', (t) => {
        const groupMembers = groupItemMembers({ walk: WALK, todos: TODOS, selection: { checked: ['c1'], unchecked: [] }, sent: new Set(['a1']), sendingId: 'b1' });
        const items = [
            { id: 'g-live', status: 'sending', originalText: 'walk', itemKind: 'group', repeatCount: VALUE, groupMembers, createdAt: '2026-11-16T10:00:00Z' },
            { id: 'g-done', status: 'sent', originalText: 'walk', itemKind: 'group', repeatCount: VALUE, groupMembers, createdAt: '2026-11-16T10:01:00Z' },
        ];
        const html = readMedia('queueEditor', 'index.html').replace(/<script[\s\S]*?<\/script>/g, '');
        const dom = new JSDOM(html, { runScripts: 'outside-only' });
        const window = dom.window as any;
        t.after(() => window.close());
        const posted: any[] = [];
        window.acquireVsCodeApi = () => ({ postMessage: (m: unknown) => posted.push(m), setState: () => undefined, getState: () => undefined });
        window.__INIT__ = { state: { items, autoSend: false } };
        window.eval([
            readMedia('shared', 'queueEntryUtils.js'),
            readMedia('shared', 'queueEntryRenderFunctions.js'),
            readMedia('shared', 'queueEntryMessageHandlers.js'),
            readMedia('queueEditor', 'main.js'),
        ].join('\n;\n'));
        const row = (id: string) => [...window.document.querySelectorAll('#queueList .queue-item')].find((el: any) => el.outerHTML.includes(`'${id}'`)) as any;
        const live = row('g-live');
        const memberRows = [...live.querySelectorAll('.group-members .gm-row')] as any[];
        assert.deepEqual(memberRows.map((r) => r.getAttribute('data-member')), ['a1', 'b1', 'c1', 'd1', 'e1', 'f1'], 'comprised_of order');
        assert.equal(memberRows[0].querySelector('.gm-mark').textContent, '✓', 'the mark alone');
        assert.equal(memberRows[0].querySelector('.gm-mark').title, 'Sent by this item: completed', 'the outcome on hover');
        const attention = window.document.createElement('div');
        attention.innerHTML = window.renderGroupMembers({ status: 'sent', groupMembers: [{ id: 'f1', status: 'in-progress', marker: 'sent', outcome: 'needs attention' }] }, 'x');
        assert.equal(attention.querySelector('.gm-mark').textContent, '⚠', 'needs attention: its own mark');
        assert.equal(attention.querySelector('.gm-mark').title, 'Sent by this item: needs attention');
        assert.doesNotMatch(attention.textContent, /needs attention/, 'no text beside the mark');
        assert.match(memberRows[1].querySelector('.gm-mark').textContent, /→/);
        const box = (r: any) => r.querySelector('input.gm-box');
        assert.deepEqual(memberRows.slice(2).map((r) => box(r).checked), [true, false, true, false], 'c1 by hand, d1 the user\'s, e1 by rules, f1 in progress');
        assert.match(memberRows[2].textContent, /blocked/, 'its status shows');
        assert.match(memberRows[2].textContent, /C/, 'its title shows');
        // The inline handlers, as the webview runs them (jsdom does not run inline handlers here).
        const run = (el: any, attr: string) => window.Function(attr === 'onchange' ? 'checked' : '', el.getAttribute(attr).replace('this.checked', 'checked')).call(el, true);
        run(box(memberRows[3]), 'onchange');
        run(live.querySelector('.gm-all'), 'onclick');
        run(live.querySelector('.gm-rules'), 'onclick');
        assert.deepEqual(JSON.parse(JSON.stringify(posted.filter((m) => m.type === 'setGroupSelection'))), [
            { type: 'setGroupSelection', id: 'g-live', member: 'd1', checked: true },
            { type: 'setGroupSelection', id: 'g-live', all: true },
            { type: 'setGroupSelection', id: 'g-live', rules: true },
        ]);
        const done = row('g-done');
        assert.equal(done.querySelector('.gm-all'), null, 'a sent item has no buttons');
        assert.ok([...done.querySelectorAll('input.gm-box')].every((b: any) => b.disabled));
    });

    const PREFIX = { kind: 'prefix' as const, prefix: 'ww' };
    const WW: TodoIterationSource[] = [
        { id: 'ww10_x', title: 'Ten', status: 'not-started' },
        { id: 'ww2_x', title: 'Two', status: 'completed' },
        { id: 'ww3_x', title: 'Three', status: 'blocked' },
        { id: 'zz1_x', title: 'Other', status: 'not-started' },
        { id: 'ww1_x', title: 'One', status: 'not-started' },
    ];

    test('GS-7: a prefix walk lists its todos', () => {
        const members = groupItemMembers({ walk: PREFIX, todos: WW, sent: new Set(['ww1_x']), sendingId: 'ww10_x' });
        assert.deepEqual(members.map((m) => m.id), ['ww1_x', 'ww2_x', 'ww3_x', 'ww10_x'], 'the prefix\'s todos, lowest number first');
        assert.deepEqual(members.map(memberMarkerText), ['✓ needs attention', '☐', '☑', '→']);
        assert.deepEqual(groupItemMembers({ walk: { kind: 'todo', quest: 'q1', id: 'ww1_x' }, todos: WW, sent: new Set() }), [], 'a TODO item lists none');
        // Read again after the todo file changed: a new todo shows, an archived one is gone.
        const later = groupItemMembers({ walk: PREFIX, todos: [...WW.filter((t) => t.id !== 'ww2_x'), { id: 'ww4_x', title: 'Four', status: 'not-started' }], sent: new Set() });
        assert.deepEqual(later.map((m) => m.id), ['ww1_x', 'ww3_x', 'ww4_x', 'ww10_x']);
    });

    test('GS-8: the header and the prefix walk\'s list', (t) => {
        const prefixMembers = groupItemMembers({ walk: PREFIX, todos: WW, sent: new Set() });
        const items = [
            { id: 'p-walk', status: 'pending', originalText: 'walk', itemKind: 'prefix', repeatCount: 'ww*', groupMembers: prefixMembers, createdAt: '2026-11-25T10:00:00Z' },
            { id: 'g-walk', status: 'sending', originalText: 'walk', itemKind: 'group', repeatCount: VALUE, repeatTodoId: 'b1', groupMembers: groupItemMembers({ walk: WALK, todos: TODOS, sent: new Set() }), createdAt: '2026-11-25T10:01:00Z' },
            { id: 't-item', status: 'staged', originalText: 'one', itemKind: 'todo', repeatCount: 'todo:q1/b1', createdAt: '2026-11-25T10:02:00Z' },
            { id: 'counted', status: 'staged', originalText: 'three times', repeatCount: 3, createdAt: '2026-11-25T10:03:00Z' },
        ];
        const html = readMedia('queueEditor', 'index.html').replace(/<script[\s\S]*?<\/script>/g, '');
        const dom = new JSDOM(html, { runScripts: 'outside-only' });
        const window = dom.window as any;
        t.after(() => window.close());
        window.acquireVsCodeApi = () => ({ postMessage: () => undefined, setState: () => undefined, getState: () => undefined });
        window.__INIT__ = { state: { items, autoSend: false } };
        window.eval([
            readMedia('shared', 'queueEntryUtils.js'),
            readMedia('shared', 'queueEntryRenderFunctions.js'),
            readMedia('shared', 'queueEntryMessageHandlers.js'),
            readMedia('queueEditor', 'main.js'),
        ].join('\n;\n'));
        const row = (id: string) => [...window.document.querySelectorAll('#queueList .queue-item')].find((el: any) => el.outerHTML.includes(`'${id}'`)) as any;
        const header = (id: string) => (row(id).querySelector('.walk-info')?.textContent ?? '') as string;
        assert.equal(header('p-walk'), 'todos ww*');
        assert.equal(header('g-walk'), 'todo group g1');
        assert.equal(header('t-item'), 'todo b1');
        for (const id of ['p-walk', 'g-walk', 't-item']) {
            assert.doesNotMatch(row(id).textContent, /\[MP|\[T /, `${id}: no repeat counters`);
        }
        assert.match(row('g-walk').textContent, /\[b1\]/, 'the todo being worked on beside it');
        assert.match(row('counted').innerHTML, /\[MP /, 'a counted repeat keeps its counter');
        assert.equal(row('p-walk').querySelector('.group-members .gm-head').textContent, 'Todos');
        assert.deepEqual([...row('p-walk').querySelectorAll('.gm-row')].map((r: any) => r.getAttribute('data-member')), ['ww1_x', 'ww2_x', 'ww3_x', 'ww10_x']);
        assert.equal(row('g-walk').querySelector('.group-members .gm-head').textContent, 'Members');
    });

    test('GS-9: a prefix walk sends exactly its checked todos', () => {
        const selection = { checked: ['ww2_x', 'ww3_x'], unchecked: ['ww1_x'] };
        const sent = new Set<string>();
        const order: string[] = [];
        let todos = WW;
        for (let i = 0; i < 10; i++) {
            const next = pickNextTodoForIteration('ww*', withSelectionFlags(todos, selection, sent));
            if (!next) { break; }
            order.push(next.id);
            sent.add(next.id);
            // The turn completes the todo it was sent.
            todos = todos.map((x) => (x.id === next.id ? { ...x, status: 'completed' } : x));
        }
        assert.deepEqual(order, ['ww2_x', 'ww3_x', 'ww10_x'], 'ww2 (completed) and ww3 (blocked) checked, ww1 unchecked, ww10 by the rules');
    });
});
