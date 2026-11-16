/**
 * A GROUP item's members and its selection (vscimpb129, src/utils/groupItemSelection.ts and the walk rules in
 * queueStep3Utils.ts).
 *
 *   GS-1 the members in comprised_of order with their markers: → the member being sent, ✓ completed / needs
 *        attention for those sent, a checkbox for the others, checked by the walk's rules (not started, not the
 *        user's own; a completed, blocked or user-action member unchecked)
 *   GS-2 the user's choices win over the rules: a completed or blocked member checked, an open one unchecked; a
 *        member added later follows the rules, a removed one is dropped
 *   GS-3 the walk sends exactly the checked members, in order: a checked completed / blocked / user-action member is
 *        picked, an unchecked open one passed; a sent member is never picked again; nothing checked → empty reason
 *   GS-4 the selection helpers: one member's choice, select all, the selection of a list, parse
 *   GS-5 an unchecked decision-needed member holds no walk; an unchecked user-action member is not reported as left
 *        to the user
 *   GS-6 the queue editor's list: → / ✓ / checkbox rows, Select all / Reset to rules while editable, their
 *        messages; no buttons and disabled boxes on a sent item
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
            ['a1', 'sent', 'completed'], ['b1', 'sending', null], ['c1', 'todo', false],
            ['d1', 'todo', false], ['e1', 'todo', true], ['f1', 'sent', 'needs attention'],
        ]);
        assert.equal(rows[0].title, 'A');
        assert.deepEqual(rows.map(memberMarkerText), ['✓ completed', '→', '☐', '☐', '☑', '✓ needs attention']);
        assert.deepEqual(groupItemMembers({ walk: { kind: 'prefix', prefix: 'x' }, todos: TODOS, sent: new Set() }), [], 'no GROUP item');
    });

    test('GS-2: choices over rules; added and removed members', () => {
        const selection = { checked: ['a1', 'c1', 'gone1'], unchecked: ['e1'] };
        const rows = groupItemMembers({ walk: WALK, todos: TODOS, selection, sent: new Set() });
        assert.deepEqual(rows.map((r) => [r.id, r.checked, r.byRule, r.chosen ?? false]), [
            ['a1', true, false, true], ['b1', true, true, false], ['c1', true, false, true],
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
        assert.match(memberRows[0].textContent, /✓ completed/);
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
});
