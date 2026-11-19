/**
 * @TOM INFO › USER NOTIFICATIONS and the user-directed events of NOTIFICATIONS (vscimpb170;
 * src/utils/userNotifications.ts, src/services/userNotificationEmitter.ts, the sources, media/userNotifications/).
 *
 *   UN-1 the types: the old five keep their order and merge rules; the user-directed types follow, each with a
 *        toggle label and icon; their lines and details (the questions, the outcome, urgency and channel)
 *   UN-2 the rows: one per user-directed event (not merged), newest first; an ask open until its close (paired by
 *        window and key), then answered with the outcome; notices; the open count; who, run, queue item, todo
 *   UN-3 dismiss: hidden from USER NOTIFICATIONS only — the log is not touched, NOTIFICATIONS still shows it; the
 *        dismissed set is a file shared by windows, pruned to ids still in the log; "dismiss all answered" leaves
 *        the open asks
 *   UN-4 the emitter: an interaction opening and closing writes askOpened / askClosed with its outcome; a run
 *        arriving at a process decision writes decisionWaiting once; an item beginning to hold the queue
 *        (decision-needed, error, needs attention) writes queueHolding once; what waits at the start is not written
 *   UN-5 the sources write to the log: tomAi_notifyUser (message, urgency, channel), tomAi_suggestSubprocess, a todo
 *        filed or turned decision-needed / user action (not one that already was), a paused run; the asks report
 *        how they closed (questions, pickers, MD Browser asks, approvals, plans)
 *   UN-6 the USER NOTIFICATIONS webview: rows with state, Open for this window's open ask (also on a click), Dismiss
 *        and Dismiss answered post; the NOTIFICATIONS webview shows the new types' toggles
 *   UN-7 the view: contributed in @TOM INFO above NOTIFICATIONS, registered, its badge counting the open asks
 */

import test, { after, describe } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'fs';
import * as path from 'path';
import { JSDOM } from 'jsdom';

import {
    NOTIFICATION_TYPES, NOTIFICATION_TYPE_INFO, USER_NOTIFICATION_TYPES, eventText, filterNotifications, groupDetails, groupNotifications,
    type NotificationEvent, type NotificationType,
} from '../notificationEvents.js';
import { addDismissed, dismissibleAnsweredIds, durationText, openAskCount, readDismissed, userNotificationRows } from '../userNotifications.js';
import {
    askClosedDraft, askOpenedDraft, holdingState, interactionDetails, queueHoldingDraft, startUserNotificationEmitter, subprocessSuggestedDraft,
    userNotifiedDraft, userTodoDraft, type HoldingItem,
} from '../../services/userNotificationEmitter.js';
import { UserInteractions } from '../../services/userInteractions.js';
import { configureNotificationLog, readNotificationEvents, type NotificationDraft } from '../../services/notificationLog.js';
import { notifyUserImpl } from '../../tools/notify-user-tool.js';
import { suggestSubprocessImpl } from '../../tools/process-stack-tools.js';

const EXT = path.resolve(__dirname, '..', '..', '..');
const SANDBOX = fs.realpathSync(fs.mkdtempSync(path.join(EXT, '..', '..', '..', 'ztmp', 'vscode_extension_261119_vscimpb170_un-')));
after(() => { configureNotificationLog(undefined, undefined); fs.rmSync(SANDBOX, { recursive: true, force: true }); });
const src = (...p: string[]): string => fs.readFileSync(path.join(EXT, ...p), 'utf8');

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Json = any;
let n = 0;
const T0 = Date.parse('2026-11-19T10:00:00Z');
function ev(type: NotificationType, sec: number, extra: Partial<NotificationEvent> = {}): NotificationEvent {
    return { id: `e${++n}`, type, at: new Date(T0 + sec * 1000).toISOString(), windowId: 'w1', quest: 'vscode_extension', run: 'default', who: { kind: 'agent', transport: 'anthropic', session: 'default' }, ...extra };
}

describe('USER NOTIFICATIONS', () => {
    test('UN-1: the types in NOTIFICATIONS', () => {
        assert.deepEqual(NOTIFICATION_TYPES.slice(0, 5), ['itemQueued', 'itemDeleted', 'todoCreated', 'todoUpdated', 'todoChanged'], 'the old five first, in order');
        assert.deepEqual(USER_NOTIFICATION_TYPES, ['askOpened', 'askClosed', 'userNotified', 'answer', 'subprocessSuggested', 'decisionWaiting', 'userTodo', 'queueHolding']);
        for (const t of NOTIFICATION_TYPES) { assert.ok(NOTIFICATION_TYPE_INFO[t].label && NOTIFICATION_TYPE_INFO[t].icon, t); }
        assert.ok(USER_NOTIFICATION_TYPES.every((t) => NOTIFICATION_TYPES.includes(t)));
        // Merge rules: unchanged for the old types, the same for the new ones.
        const old = groupNotifications([ev('todoCreated', 0), ev('todoCreated', 30), ev('todoCreated', 61)]);
        assert.deepEqual(old.map((g) => g.members.length), [1, 2]);
        const asks = groupNotifications([ev('askOpened', 0, { user: { kind: 'question', key: 'q1', title: 'A' } }), ev('askOpened', 10, { user: { kind: 'question', key: 'q2', title: 'B' } })]);
        assert.equal(asks.length, 1, 'merged in NOTIFICATIONS as the others are');
        assert.equal(filterNotifications([ev('askOpened', 0)], { windows: [], types: ['todoCreated'] }).length, 0, 'its toggle hides it');
        const opened = ev('askOpened', 0, { user: { kind: 'question', key: 'q1', title: 'The assistant has some questions', details: ['1. Which?', 'Choices: a · b'] } });
        assert.equal(eventText(opened), 'waits for you: The assistant has some questions · default');
        const closed = ev('askClosed', 5, { user: { kind: 'question', key: 'q1', title: 'The assistant has some questions', outcome: 'answered: a' } });
        assert.equal(eventText(closed), 'answered: The assistant has some questions — answered: a · default');
        const told = ev('userNotified', 0, { user: { title: 'Build done', urgency: 'warning', channel: 'auto' } });
        const d = groupDetails(groupNotifications([told])[0]);
        assert.ok(d.includes('urgency warning, channel auto'));
        assert.ok(groupDetails(groupNotifications([opened])[0]).includes('1. Which?'));
        assert.equal(durationText(3 * 60_000), '3 min');
        assert.equal(durationText(125 * 60_000), '2 h 5 min');
        assert.equal(durationText(28 * 3_600_000), '1 d 4 h');
    });

    test('UN-2: the rows', () => {
        const events: NotificationEvent[] = [
            ev('itemQueued', 0),
            ev('askOpened', 1, { user: { kind: 'question', key: 'q1', title: 'Q one', details: ['1. Which?'], queueItemId: 'item-7' } }),
            ev('askOpened', 2, { user: { kind: 'picker', key: 'p1', title: 'Pick' } }),
            ev('askClosed', 3, { user: { kind: 'question', key: 'q1', title: 'Q one', outcome: 'answered: (b)' } }),
            ev('askOpened', 4, { windowId: 'w2', user: { kind: 'question', key: 'q1', title: 'Same key, other window' } }),
            ev('userTodo', 5, { todo: { id: 't1', quest: 'q', fields: [] }, user: { kind: 'decision-needed', title: 'Decision needed in todo t1' } }),
            ev('queueHolding', 6, { who: { kind: 'extension', label: 'the queue' }, user: { kind: 'error', title: 'Queue item error: "x"' } }),
            ev('todoChanged', 7),
        ];
        const rows = userNotificationRows(events);
        assert.deepEqual(rows.map((r) => [r.title, r.state]), [
            ['Queue item error: "x"', 'notice'], ['Decision needed in todo t1', 'open'], ['Same key, other window', 'open'], ['Pick', 'open'], ['Q one', 'answered'],
        ], 'one row per event, newest first; asks paired per window and key; a decision open until answered; queue and todo events not shown');
        const q = rows.find((r) => r.title === 'Q one')!;
        assert.equal(q.outcome, 'answered: (b)');
        assert.ok(q.details.includes('Answer: answered: (b)') && q.details.includes('Queue item: item-7') && q.details.includes('1. Which?'));
        assert.ok(q.details.includes('From: session default, transport anthropic'));
        assert.ok(rows.find((r) => r.type === 'userTodo')!.details.includes('Todo: q/t1'));
        assert.equal(openAskCount(rows), 3, 'the open asks and the decision waiting');
        assert.deepEqual(rows.map((r) => r.icon), ['debug-pause', 'person', 'comment-discussion', 'comment-discussion', 'comment-discussion']);
    });

    test('UN-3: dismiss, kept apart from the log', () => {
        const log = path.join(SANDBOX, 'un3', 'events.jsonl');
        configureNotificationLog(log, { windowId: 'w1', quest: () => 'vscode_extension', run: () => 'default', who: () => ({ kind: 'user' }) });
        const rec = new UserInteractions();
        const stop = startUserNotificationEmitter({ interactions: rec });
        const close = rec.add({ id: 'q1', kind: 'question', run: 'default', createdAt: Date.now(), title: 'Q', data: { questions: ['Which?'] } });
        rec.add({ id: 'q2', kind: 'question', run: 'default', createdAt: Date.now(), title: 'Still open', data: {} });
        close('answered: yes');
        stop();
        const events = readNotificationEvents(log);
        const rows = userNotificationRows(events);
        assert.deepEqual(rows.map((r) => r.state).sort(), ['answered', 'open']);
        const dismissedFile = path.join(path.dirname(log), 'user-dismissed.json');
        const toDismiss = dismissibleAnsweredIds(rows);
        assert.equal(toDismiss.length, 1, 'dismiss answered leaves the open ask');
        addDismissed(dismissedFile, [...toDismiss, 'gone-id'], new Set(events.map((e) => e.id)));
        assert.deepEqual([...readDismissed(dismissedFile)], toDismiss, 'pruned to ids still in the log');
        assert.deepEqual(userNotificationRows(events, readDismissed(dismissedFile)).map((r) => r.title), ['Still open']);
        assert.equal(readNotificationEvents(log).length, events.length, 'the log is not touched');
        assert.equal(groupNotifications(filterNotifications(readNotificationEvents(log), { windows: [] })).length > 0, true, 'NOTIFICATIONS still shows them');
        assert.deepEqual([...readDismissed(path.join(SANDBOX, 'nofile.json'))], []);
        configureNotificationLog(undefined, undefined);
    });

    test('UN-4: the emitter', () => {
        const drafts: NotificationDraft[] = [];
        const rec = new UserInteractions();
        let processListener: () => void = () => undefined;
        let queueListener: () => void = () => undefined;
        let waiting = [{ run: 'r1', process: 'design', position: 'p1 › gate' }];
        let items: HoldingItem[] = [{ id: 'i1', status: 'error', run: 'default', error: 'boom', preview: 'already' }, { id: 'i2', status: 'pending', run: 'default', preview: 'two' }];
        const stop = startUserNotificationEmitter({
            interactions: rec,
            process: { onDidChange: (l) => { processListener = l; return { dispose: () => undefined }; }, decisionWaitingRuns: () => waiting },
            queue: { onDidChange: (l) => { queueListener = l; return { dispose: () => undefined }; }, holdingItems: () => items },
            emit: (d) => drafts.push(...d),
        });
        const close = rec.add({ id: 'a1', kind: 'approval', run: 'r1', queueItemId: 'i9', createdAt: 0, title: 'Tool approval: tomAi_editFile', data: { toolName: 'tomAi_editFile', inputSummary: 'x.ts' } });
        close('approved');
        assert.deepEqual(drafts.map((d) => [d.type, d.user?.key, d.user?.outcome]), [['askOpened', 'a1', undefined], ['askClosed', 'a1', 'approved']]);
        assert.deepEqual(drafts[0].user?.details, ['Tool: tomAi_editFile', 'Input: x.ts']);
        assert.equal(drafts[0].run, 'r1');
        drafts.length = 0;
        processListener();
        assert.equal(drafts.length, 0, 'waiting at the start: known, not written');
        waiting = [...waiting, { run: 'r2', process: 'design', position: 'p2 › decide' }];
        processListener();
        processListener();
        assert.deepEqual(drafts.map((d) => [d.type, d.run, d.user?.title]), [['decisionWaiting', 'r2', 'Decide how design goes on: p2 › decide']], 'once');
        drafts.length = 0;
        queueListener();
        assert.equal(drafts.length, 0, 'holding at the start: not written');
        items = [items[0], { ...items[1], status: 'decision-needed' }, { id: 'i3', status: 'sending', run: 'x', needsAttention: 'the todo was not completed', preview: 'three' }];
        queueListener();
        queueListener();
        assert.deepEqual(drafts.map((d) => [d.type, d.user?.kind, d.user?.queueItemId]), [['queueHolding', 'decision-needed', 'i2'], ['queueHolding', 'needs attention', 'i3']]);
        assert.equal(holdingState({ id: 'x', status: 'pending', run: 'd', preview: '' }), undefined);
        stop();
        // The details of each kind of ask.
        assert.deepEqual(interactionDetails({ kind: 'question', data: { questions: ['A?', 'B?'], choices: [{ label: 'yes' }, { label: 'no' }] } }), ['1. A?', '2. B?', 'Choices: yes · no']);
        assert.deepEqual(interactionDetails({ kind: 'picker', data: { prompt: 'Pick one', items: [{ label: 'x' }, { label: 'y' }], canPickMany: true } }), ['Pick one', '• x', '• y', '(several may be picked)']);
        assert.deepEqual(interactionDetails({ kind: 'mdBrowser', data: { file: 'a.md' } }), ['Document: a.md']);
        assert.deepEqual(interactionDetails({ kind: 'plan', data: { plan: 'Step 1\nStep 2' } }), ['Step 1', 'Step 2']);
        assert.equal(askClosedDraft({ interaction: { id: 'z', kind: 'plan', run: 'r', createdAt: 0, title: 't', data: {} } }).user?.outcome, 'closed', 'no outcome given: closed');
        assert.equal(askOpenedDraft({ id: 'z', kind: 'plan', run: 'r', createdAt: 0, title: 't', data: {}, session: 's' }).user?.session, 's');
    });

    test('UN-5: the sources', async () => {
        const log = path.join(SANDBOX, 'un5', 'events.jsonl');
        configureNotificationLog(log, { windowId: 'w1', quest: () => 'vscode_extension', run: () => 'default', who: () => ({ kind: 'agent', transport: 'anthropic', session: 'default' }) });
        const channels = { setStatusBarMessage: () => undefined } as Json;
        await notifyUserImpl(channels, { message: 'Decision made in todo t1: names', urgency: 'info', channel: 'statusbar' } as Json);
        await suggestSubprocessImpl({ suggest: () => ({ ok: true, state: { suggestions: [] } }), stepRunning: () => true, showSuggestions: () => undefined } as Json, { suggestions: [{ process: 'review', reason: 'the spec changed' }] });
        const events = readNotificationEvents(log);
        assert.deepEqual(events.map((e) => [e.type, e.user?.title]), [
            ['userNotified', 'Decision made in todo t1: names'],
            ['subprocessSuggested', 'A process is suggested: review'],
        ]);
        assert.deepEqual([events[0].user?.urgency, events[0].user?.channel], ['info', 'statusbar']);
        assert.deepEqual(events[1].user?.details, ['• review — the spec changed']);
        configureNotificationLog(undefined, undefined);
        // A todo for the user: filed so, or turned so; not when it already was.
        assert.equal(userTodoDraft('q', { id: 't1', title: 'T', status: 'decision-needed', decisions: [{ summary: 'Which name' }, { summary: 'done', decision: '(a)' }] })?.user?.title, 'Decision needed in todo t1: T');
        assert.deepEqual(userTodoDraft('q', { id: 't1', status: 'decision-needed', decisions: [{ summary: 'Which name' }] })?.user?.details, ['Open decisions:', '• Which name']);
        assert.equal(userTodoDraft('q', { id: 't2', status: 'not-started', user_action: true })?.user?.kind, 'user action');
        assert.equal(userTodoDraft('q', { id: 't3', status: 'not-started' }), undefined);
        assert.ok(userTodoDraft('q', { id: 't4', status: 'decision-needed' }, { status: 'in-progress' }), 'turned decision-needed by an update');
        assert.equal(userTodoDraft('q', { id: 't4', status: 'decision-needed' }, { status: 'decision-needed' }), undefined, 'already was');
        assert.equal(subprocessSuggestedDraft([{ process: 'a' }, { process: 'b' }]).user?.title, '2 processes are suggested: a, b');
        assert.equal(userNotifiedDraft({ message: 'm', title: 'T' }).user?.title, 'T: m');
        assert.equal(queueHoldingDraft({ id: 'i', status: 'error', run: 'r', error: 'x', preview: 'p' }, 'error').user?.details?.[0], 'Error: x');
        // The wiring of the writers.
        const todoManager = src('src', 'managers', 'questTodoManager.ts');
        assert.match(todoManager, /const forUser = userTodoDraft\(questId, todo as unknown/);
        assert.match(todoManager, /const forUser = userTodoDraft\(questId, after as unknown as Parameters<typeof userTodoDraft>\[1\], before/);
        assert.match(src('src', 'managers', 'promptQueueManager.ts'), /logQueue\(`Run \$\{run\} paused: \$\{why\}`\);\s*\/\/ USER NOTIFICATIONS[^\n]*\n\s*emitRunPaused\(run, why, item\?\.id\);/);
        assert.match(src('src', 'extension.ts'), /startUserNotificationEmitter\(\{\s*interactions: userInteractions,/);
        // How each ask reports its close.
        assert.match(src('src', 'handlers', 'askUser-handler.ts'), /userInteractions\.remove\(pending\.requestId, source === 'timeout' \? 'timed out'/);
        assert.match(src('src', 'tools', 'user-interaction-tools.ts'), /remove\(result === undefined \? 'dismissed' : result === QUICK_PICK_TIMED_OUT \? 'timed out'/);
        assert.match(src('src', 'tools', 'ask-in-md-browser-tool.ts'), /this\.release\(ask, source === 'click' && button \? `clicked \$\{button\.label\}`/);
        assert.match(src('src', 'handlers', 'anthropic-handler.ts'), /remove\(approved \? 'approved' : 'denied'\)/);
        assert.match(src('src', 'handlers', 'chatPanel-handler.ts'), /remove\(decision\.accepted \? 'accepted'/);
    });

    test('UN-6: the webviews', (t) => {
        const page = (name: string): Json => {
            const dom = new JSDOM(src('media', name, 'index.html').replace(/<script[\s\S]*?<\/script>/g, ''), { runScripts: 'outside-only' });
            const w = dom.window as Json;
            t.after(() => w.close());
            const posted: Json[] = [];
            w.acquireVsCodeApi = () => ({ postMessage: (m: Json) => posted.push(JSON.parse(JSON.stringify(m))) });
            w.__INIT__ = {};
            w.eval(src('media', name, 'main.js'));
            return { w, posted };
        };
        const { w, posted } = page('userNotifications');
        assert.deepEqual(posted.shift(), { type: 'ready' });
        const rows = userNotificationRows([
            ev('askOpened', 1, { user: { kind: 'question', key: 'q1', title: 'Mine, open', details: ['1. Which?'] } }),
            ev('askOpened', 2, { windowId: 'w2', quest: 'other', user: { kind: 'question', key: 'q9', title: 'Theirs, open' } }),
            ev('askOpened', 0, { user: { kind: 'picker', key: 'p1', title: 'Answered pick' } }),
            ev('askClosed', 3, { user: { kind: 'picker', key: 'p1', title: 'Answered pick', outcome: 'picked x' } }),
        ]);
        w.dispatchEvent(new w.MessageEvent('message', { data: { type: 'state', rows, open: 2, thisWindow: 'w1' } }));
        const doc = w.document;
        assert.match(doc.querySelector('#bar').textContent, /2 waiting for you/);
        const row = (title: string): Json => [...doc.querySelectorAll('.row')].find((r: Json) => r.querySelector('.title').textContent === title);
        assert.match(row('Mine, open').querySelector('.state').textContent, /^open · \d+ (min|h|d)/);
        assert.equal(row('Answered pick').querySelector('.state').textContent, 'answered');
        assert.ok(row('Mine, open').classList.contains('open'));
        // A click on this window's open ask: details, Open, and it is opened.
        row('Mine, open').querySelector('.title').click();
        assert.match(row('Mine, open').querySelector('.details').textContent, /1\. Which\?/);
        const mineId = row('Mine, open').getAttribute('data-id');
        assert.equal(mineId, rows.find((r) => r.title === 'Mine, open')!.id);
        assert.deepEqual(posted.pop(), { type: 'openAsk', id: mineId });
        row('Mine, open').querySelector('[data-answer]').click();
        assert.deepEqual(posted.pop(), { type: 'answer', id: mineId });
        // Another window's open ask: details, and Answer shows it here.
        const before = posted.length;
        row('Theirs, open').querySelector('.title').click();
        assert.equal(posted.length, before, 'no openAsk for another window on a click');
        assert.match(row('Theirs, open').querySelector('.details').textContent, /From another window \(other\): Answer shows it here/);
        assert.match(row('Theirs, open').querySelector('[data-answer]').getAttribute('title'), /^Answer it here: the ask is shown in this window, the answer goes to other$/);
        assert.equal(row('Answered pick').querySelector('[data-answer]'), null, 'no Answer on an answered ask');
        row('Answered pick').querySelector('[data-dismiss]').click();
        assert.deepEqual(posted.pop(), { type: 'dismiss', id: row('Answered pick').getAttribute('data-id') });
        doc.querySelector('[data-action="dismissAnswered"]').click();
        assert.deepEqual(posted.pop(), { type: 'dismissAnswered' });
        // NOTIFICATIONS shows the new types' toggles.
        const n2 = page('notifications');
        n2.w.dispatchEvent(new n2.w.MessageEvent('message', { data: {
            type: 'state', groups: [], windows: [], total: 0,
            filters: { windows: [], types: [...NOTIFICATION_TYPES], cleared: false },
            typeInfo: NOTIFICATION_TYPES.map((tp) => ({ type: tp, ...NOTIFICATION_TYPE_INFO[tp] })),
        } }));
        const toggles = [...n2.w.document.querySelectorAll('#bar [data-type]')].map((b: Json) => b.getAttribute('data-type'));
        assert.deepEqual(toggles, [...NOTIFICATION_TYPES]);
    });

    test('UN-7: the view', () => {
        const pkg = JSON.parse(src('package.json'));
        const ids = pkg.contributes.views['tomAi-info-sidebar'].map((v: Json) => v.id);
        assert.ok(ids.indexOf('tomAi.userNotifications') >= 0 && ids.indexOf('tomAi.userNotifications') < ids.indexOf('tomAi.notifications'), 'above NOTIFICATIONS');
        assert.match(src('src', 'extension.ts'), /registerUserNotificationsView\(context\);/);
        const handler = src('src', 'handlers', 'userNotifications-handler.ts');
        assert.match(handler, /this\.view\.badge = open \? \{ value: open, tooltip: `\$\{open\} waiting for your answer` \} : undefined;/);
        assert.match(handler, /if \(interaction\.kind === 'mdBrowser'\) \{\s*interaction\.respond\?\.\(\{\}\);/);
        assert.match(handler, /executeCommand\(SHOW_USER_INTERACTION_COMMAND, \{ run: interaction\.run \}\)/);
    });
});
