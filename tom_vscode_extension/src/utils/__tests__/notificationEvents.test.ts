/**
 * @TOM INFO › NOTIFICATIONS: the events, grouped, filtered, as lines (vscimpb124, src/utils/notificationEvents.ts,
 * src/utils/notificationDrafts.ts).
 *
 *   NE-1 grouping: one type, the same agent, the same quest within 60 s of the group's first merge; another agent,
 *        another quest, another type, the user or 61 s later stay separate; newest group first
 *   NE-2 filters: windows (none: all), types, Clear
 *   NE-3 the line texts: single events of every type, and grouped ones
 *   NE-4 the details: who, the agent, what it was working on, the fields, the members
 *   NE-5 the todo update: the changed fields (old → new, cut), a status change vs an edit, nothing changed
 *   NE-6 the queue drafts: kind, run, preview; who from the item itself (another quest, timed, done
 *        notification) or the call's context
 *   NE-7 the window choices: every window the events name, newest first
 */

import { describe, test } from 'node:test';
import assert from 'node:assert/strict';

import {
    NOTIFICATION_TYPES, NOTIFICATION_TYPE_INFO, USER_NOTIFICATION_TYPES, changedTodoFields, eventText, filterNotifications, groupDetails, groupLine, groupNotifications, notificationWindows, todoUpdateType,
    type NotificationEvent, type NotificationType, type NotificationWho,
} from '../notificationEvents.js';
import { queueItemDraft, todoCreatedDraft, todoUpdateDraft } from '../notificationDrafts.js';

const T0 = Date.parse('2026-11-16T10:00:00Z');
const AGENT: NotificationWho = { kind: 'agent', transport: 'anthropic', profile: 'opus', session: 'default@another', queueItemId: 'q1', todo: 'vscode_extension/vscimpb121' };
const OTHER: NotificationWho = { kind: 'agent', transport: 'anthropic', profile: 'opus', session: 'chat' };
let n = 0;
function ev(type: NotificationType, sec: number, extra: Partial<NotificationEvent> = {}): NotificationEvent {
    n++;
    return {
        id: `e${n}`, type, at: new Date(T0 + sec * 1000).toISOString(), windowId: 'w1_m', quest: 'vscode_extension', run: 'another', who: AGENT,
        ...(type.startsWith('todo') ? { todo: { id: `t${n}`, quest: 'vscode_extension', title: `todo ${n}`, fields: type === 'todoChanged' ? [{ field: 'status', old: 'in-progress', new: 'completed' }] : [] } } : {}),
        ...(type.startsWith('item') ? { item: { id: `i${n}`, run: 'another', kind: 'normal', preview: `prompt ${n}` } } : {}),
        ...extra,
    };
}

describe('grouping', () => {
    test('NE-1: same type, agent and quest within 60 s merge', () => {
        const a = ev('todoCreated', 0);
        const b = ev('todoCreated', 30);
        const c = ev('todoCreated', 60);
        const late = ev('todoCreated', 61);
        const otherAgent = ev('todoCreated', 10, { who: OTHER });
        const otherQuest = ev('todoCreated', 10, { todo: { id: 'x', quest: 'tom_specs', fields: [] } });
        const otherType = ev('todoUpdated', 10);
        const user = ev('todoCreated', 10, { who: { kind: 'user' } });
        const groups = groupNotifications([c, otherAgent, a, late, b, otherQuest, otherType, user]);
        const byFirst = (e: NotificationEvent) => groups.find((g) => g.members[0].id === e.id)!;
        assert.deepEqual(byFirst(a).members.map((m) => m.id), [a.id, b.id, c.id], 'within 60 s of the first');
        assert.deepEqual(byFirst(late).members.map((m) => m.id), [late.id], '61 s after the first starts a new group');
        for (const e of [otherAgent, otherQuest, otherType, user]) { assert.equal(byFirst(e).members.length, 1, e.id); }
        assert.equal(groups.length, 6);
        assert.equal(groups[0].members[0].id, late.id, 'newest first');
        assert.equal(byFirst(a).first, a.at);
        assert.equal(byFirst(a).last, c.at);
    });
});

describe('filters', () => {
    test('NE-2: windows, types, Clear', () => {
        const a = ev('itemQueued', 0);
        const b = ev('todoChanged', 5, { windowId: 'w2_m', quest: 'tom_specs' });
        const c = ev('todoCreated', 100);
        const all = [a, b, c];
        assert.equal(filterNotifications(all, { windows: [] }).length, 3, 'no window ticked: every window');
        assert.deepEqual(filterNotifications(all, { windows: ['w2_m'] }).map((e) => e.id), [b.id]);
        assert.deepEqual(filterNotifications(all, { windows: ['w1_m', 'w2_m'], types: ['todoChanged', 'todoCreated'] }).map((e) => e.id), [b.id, c.id]);
        assert.deepEqual(filterNotifications(all, { windows: [], types: [] }), []);
        assert.deepEqual(filterNotifications(all, { windows: [], clearedAt: b.at }).map((e) => e.id), [c.id], 'Clear hides what was there');
    });
});

describe('texts', () => {
    test('NE-3: the lines', () => {
        const line = (e: NotificationEvent) => groupLine(groupNotifications([e])[0]);
        assert.equal(line(ev('itemQueued', 0, { item: { id: 'i', run: 'another', kind: 'normal', preview: 'Do the quest todo' } })), 'queued "Do the quest todo" · another');
        assert.equal(line(ev('itemDeleted', 0, { item: { id: 'i', run: 'default', kind: 'timed', preview: 'Check' } })), 'deleted timed "Check" · default');
        assert.equal(line(ev('todoCreated', 0, { todo: { id: 'qr1', quest: 'vscode_extension', fields: [] } })), 'todo qr1 created · vscode_extension');
        assert.equal(line(ev('todoChanged', 0, { todo: { id: 'vscimpb121', quest: 'vscode_extension', fields: [{ field: 'status', old: 'in-progress', new: 'completed' }] } })), 'todo vscimpb121 → completed · vscode_extension');
        assert.equal(line(ev('todoUpdated', 0, { todo: { id: 't', quest: 'q', fields: [{ field: 'notes' }, { field: 'priority', old: 'low', new: 'high' }] } })), 'todo t edited (notes, priority) · q');
        const five = groupNotifications([0, 1, 2, 3, 4].map((s) => ev('todoCreated', s)));
        assert.equal(groupLine(five[0]), '5 todos created by default@another · vscode_extension');
        const changed = groupNotifications([ev('todoChanged', 0), ev('todoChanged', 1)]);
        assert.equal(groupLine(changed[0]), '2 todos → completed by default@another · vscode_extension');
        const yours = groupNotifications([ev('itemDeleted', 0, { who: { kind: 'user' } }), ev('itemDeleted', 1, { who: { kind: 'user' } })]);
        assert.equal(groupLine(yours[0]), '2 items deleted by you · vscode_extension');
        const ext = groupNotifications([ev('todoChanged', 0, { who: { kind: 'extension', label: 'blocked todos follow their blockers' } })]);
        assert.match(groupDetails(ext[0])[0], /the extension \(blocked todos follow their blockers\)/);
    });

    test('NE-4: the details', () => {
        const g = groupNotifications([ev('todoChanged', 0), ev('todoChanged', 20)])[0];
        const d = groupDetails(g);
        assert.equal(d[0], 'Who: an agent');
        assert.equal(d[1], 'Agent: transport anthropic, profile opus, session default@another');
        assert.equal(d[2], 'Working on: queue item q1, todo vscode_extension/vscimpb121');
        assert.equal(d[3], 'Window: vscode_extension · run another');
        assert.match(d[4], /^When: .* … /);
        assert.ok(d.some((l) => l.startsWith('• todo ')), 'the members are listed');
        assert.ok(d.some((l) => /status: in-progress → completed/.test(l)), 'the fields, old → new');
        assert.equal(groupDetails(groupNotifications([ev('itemQueued', 0, { who: { kind: 'user' } })])[0])[0], 'Who: you (the UI)');
    });

    test('NE-5: the todo update', () => {
        const before = { id: 't', status: 'in-progress', notes: 'a', priority: 'low', updated: '2026-11-15', blocking: ['x'] };
        const after = { id: 't', status: 'completed', notes: 'a\n\nDone '.padEnd(200, 'x'), priority: 'low', updated: '2026-11-16', blocking: [] };
        const fields = changedTodoFields(before, after);
        assert.deepEqual(fields.map((f) => f.field), ['notes', 'status'], 'updated and blocking are no change');
        assert.equal(fields[1].old, 'in-progress');
        assert.equal(fields[1].new, 'completed');
        assert.ok(fields[0].new!.length <= 80 && fields[0].new!.endsWith('…'), 'a text is cut to one short line');
        assert.equal(todoUpdateType(fields), 'todoChanged');
        assert.equal(todoUpdateType(changedTodoFields({ id: 't', notes: 'a' }, { id: 't', notes: 'b' })), 'todoUpdated');
        assert.equal(todoUpdateDraft('q', { id: 't', notes: 'a' }, { id: 't', notes: 'a', updated: 'x' }), undefined, 'nothing changed: no event');
        assert.deepEqual(todoCreatedDraft('q', { id: 't', title: 'Title', status: 'not-started' }), { type: 'todoCreated', todo: { id: 't', quest: 'q', title: 'Title', fields: [{ field: 'status', new: 'not-started' }] } });
    });

    test('NE-6: the queue drafts', () => {
        const d = queueItemDraft('itemQueued', { id: 'i1', status: 'pending', run: 'collab', originalText: 'Do\nthe   thing' });
        assert.deepEqual(d, { type: 'itemQueued', run: 'collab', item: { id: 'i1', run: 'collab', kind: 'normal', preview: 'Do the thing' } });
        assert.equal(queueItemDraft('itemQueued', { id: 'm', status: 'pending', processMove: {}, processRun: { run: 'r' } }).item!.kind, 'process-move marker');
        assert.equal(queueItemDraft('itemQueued', { id: 'm', status: 'pending', processRun: { run: 'r' } }).run, 'r', 'a Proceed item is its run\'s');
        assert.deepEqual(queueItemDraft('itemQueued', { id: 'x', status: 'pending', from: { quest: 'tom_specs' } }).who, { kind: 'agent', fromQuest: 'tom_specs' });
        assert.equal(queueItemDraft('itemQueued', { id: 'x', status: 'pending', type: 'timed' }).who!.label, 'timed request');
        assert.match(queueItemDraft('itemQueued', { id: 'x', status: 'pending', notificationOf: 'q9' }).who!.label!, /done notification of q9/);
        assert.equal(queueItemDraft('itemDeleted', { id: 'x', status: 'sent', type: 'timed' }).who, undefined, 'a deletion: the caller\'s context');
    });

    test('NE-8: a message the user wrote to a waiting turn (vscimpb173)', () => {
        assert.equal(NOTIFICATION_TYPES[NOTIFICATION_TYPES.length - 1], 'message', 'a type of its own, after the others');
        assert.deepEqual(NOTIFICATION_TYPE_INFO.message, { label: 'You wrote', icon: 'mail' });
        assert.ok(!USER_NOTIFICATION_TYPES.includes('message'), 'from the user, not directed at him: not in USER NOTIFICATIONS');
        const wrote = (sec: number, title: string): NotificationEvent => ev('message', sec, { who: { kind: 'user' }, run: 'r2', user: { kind: 'waitFor', title, details: ['To the waiting turn of queue item q1 (tomAi_waitFor)', title], queueItemId: 'q1' } });
        const one = wrote(0, 'Also bump the changelog.');
        assert.equal(eventText(one), 'you wrote to a waiting turn: Also bump the changelog. · r2');
        const groups = groupNotifications([one, wrote(20, 'and tag it')]);
        assert.equal(groups.length, 1);
        assert.equal(groupLine(groups[0]), '2 messages written to waiting turns by you · vscode_extension');
        assert.ok(groupDetails(groupNotifications([one])[0]).includes('To the waiting turn of queue item q1 (tomAi_waitFor)'));
        assert.equal(filterNotifications([one], { windows: [], types: ['itemQueued'] }).length, 0, 'its toggle hides it');
    });

    test('NE-7: the window choices', () => {
        const ws = notificationWindows([ev('itemQueued', 0, { windowId: 'a', quest: 'qa' }), ev('itemQueued', 50, { windowId: 'b', quest: 'qb' }), ev('itemQueued', 10, { windowId: 'a', quest: 'qa2' })]);
        assert.deepEqual(ws, [{ windowId: 'b', quest: 'qb' }, { windowId: 'a', quest: 'qa2' }]);
    });
});
