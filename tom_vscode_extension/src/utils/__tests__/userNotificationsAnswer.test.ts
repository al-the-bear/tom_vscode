/**
 * USER NOTIFICATIONS: todos waiting for decisions, and answering from the panel (src/utils/userNotifications.ts
 * decisionRows, src/services/windowRequests.ts, src/services/remoteAsks.ts, the emitter's queueHolding,
 * media/userNotifications/).
 *
 *   UA-1 a todo filed decision-needed (todoCreated) or changed into it (todoChanged) is a row, from any window,
 *        whether or not a userTodo event came with it (merged with it when it did, its title and open decisions
 *        kept); open until a todoChanged takes it out of decision-needed, then answered ("now not-started"); a
 *        second time it goes into decision-needed is a row of its own; dismissed rows stay hidden
 *   UA-2 a decision answered whose todo held a queue item (queueHolding, decision-needed, naming the todo) offers to
 *        continue that window's run; one still open, or one no queue waited for, does not
 *   UA-3 the queue's hold event names the todo the item waits at; HoldingItem.decisionTodo
 *   UA-4 the request channel: a window publishes its open asks (stand-ins left out); another reads them; a
 *        request sent to a window is taken once, carried out and deleted; unknown or failing ones do not stop
 *        the others
 *   UA-5 a stand-in for another window's ask: made from what that window published, on a tab named after it, its
 *        answer sent to that window under the real id, then gone; an MD Browser ask and a closed one refused;
 *        stand-ins leave once their ask is no longer open there; the emitter does not report stand-ins
 *   UA-6 the page: Answer on a decision row and on another window's ask, Continue queue on an answered decision
 *        with a queue; both post with the row id; "decided" on an answered decision
 *   UA-7 the host: answer opens a decision's todo in the bottom panel's Quest TODO section, an ask of this
 *        window where it waits, another window's as a stand-in; continue resumes the run here or sends resumeRun
 */

import test, { after, describe } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'fs';
import * as path from 'path';
import { JSDOM } from 'jsdom';

import type { NotificationEvent, NotificationType } from '../notificationEvents.js';
import { decisionRows, userNotificationRows } from '../userNotifications.js';
import { queueHoldingDraft, startUserNotificationEmitter } from '../../services/userNotificationEmitter.js';
import { UserInteractions } from '../../services/userInteractions.js';
import { configureWindowRequests, publishInteractions, readWindowInteractions, sendWindowRequest, takeWindowRequests } from '../../services/windowRequests.js';
import { openRemoteAsk, remoteAskId, syncRemoteAsks } from '../../services/remoteAsks.js';

const EXT = path.resolve(__dirname, '..', '..', '..');
const SANDBOX = fs.realpathSync(fs.mkdtempSync(path.join(EXT, '..', '..', '..', 'ztmp', 'vscode_extension_261119_unanswer-')));
after(() => { configureWindowRequests(undefined, undefined); fs.rmSync(SANDBOX, { recursive: true, force: true }); });
const src = (...p: string[]): string => fs.readFileSync(path.join(EXT, ...p), 'utf8');

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Json = any;
let n = 0;
const T0 = Date.parse('2026-11-19T10:00:00Z');
function ev(type: NotificationType, sec: number, extra: Partial<NotificationEvent> = {}): NotificationEvent {
    return { id: `e${++n}`, type, at: new Date(T0 + sec * 1000).toISOString(), windowId: 'w1', quest: 'webwork', run: 'default', who: { kind: 'agent' }, ...extra };
}
const todo = (id: string, status?: { old?: string; new?: string }, quest = 'webwork') => ({ id, quest, title: `Title ${id}`, fields: status ? [{ field: 'status', ...status }] : [] });

describe('USER NOTIFICATIONS: decisions and answering', () => {
    test('UA-1: decision rows from the todo events', () => {
        const events = [
            ev('todoCreated', 0, { todo: todo('a1', { new: 'decision-needed' }) }),
            ev('todoCreated', 10, { todo: todo('b1', { new: 'not-started' }) }),
            ev('todoChanged', 20, { todo: todo('b1', { old: 'not-started', new: 'decision-needed' }), windowId: 'w2', quest: 'tom_forge' }),
            // A window with userTodo: the same change, merged.
            ev('todoCreated', 30, { todo: todo('c1', { new: 'decision-needed' }) }),
            ev('userTodo', 31, { todo: todo('c1'), user: { kind: 'decision-needed', title: 'Decision needed in todo c1: Title c1', details: ['Open decisions:', '• Which store'] } }),
            ev('todoChanged', 40, { todo: todo('a1', { old: 'decision-needed', new: 'not-started' }), who: { kind: 'user' } }),
            ev('todoChanged', 50, { todo: todo('a1', { old: 'in-progress', new: 'decision-needed' }) }),
            ev('todoUpdated', 60, { todo: todo('b1') }),
        ];
        const rows = decisionRows(events);
        assert.deepEqual(rows.map((r) => [r.todo!.id, r.state, r.outcome ?? '']), [
            ['a1', 'answered', 'now not-started'], ['b1', 'open', ''], ['c1', 'open', ''], ['a1', 'open', ''],
        ]);
        const c1 = rows.find((r) => r.todo!.id === 'c1')!;
        assert.equal(c1.title, 'Decision needed in todo c1: Title c1', 'the userTodo title');
        assert.ok(c1.details.includes('• Which store'));
        assert.equal(rows.find((r) => r.todo!.id === 'b1')!.title, 'Decision needed in todo b1: Title b1');
        assert.equal(rows.find((r) => r.todo!.id === 'b1')!.windowId, 'w2', 'from any window');
        assert.equal(rows[0].kind, 'decision-needed');
        assert.equal(rows[0].type, 'userTodo');
        // In the full list: one row per decision, the userTodo not twice.
        const all = userNotificationRows(events);
        assert.equal(all.filter((r) => r.todo?.id === 'c1').length, 1);
        assert.equal(all.length, 4);
        const hidden = userNotificationRows(events, new Set([events[0].id]));
        assert.equal(hidden.length, 3, 'a dismissed decision row stays hidden');
    });

    test('UA-2: continue the queue it held', () => {
        const events = [
            ev('todoChanged', 0, { todo: todo('w3', { old: 'not-started', new: 'decision-needed' }) }),
            ev('queueHolding', 5, { windowId: 'wq', quest: 'webwork', run: 'redesign', todo: todo('w3'), user: { kind: 'decision-needed', title: 'Queue item decision-needed: "walk"', queueItemId: 'item-9' } }),
            ev('todoChanged', 9, { todo: todo('x1', { old: 'not-started', new: 'decision-needed' }) }),
        ];
        assert.equal(decisionRows(events).find((r) => r.todo!.id === 'w3')!.continueQueue, undefined, 'still open: nothing to continue');
        const answered = [...events, ev('todoChanged', 20, { todo: todo('w3', { old: 'decision-needed', new: 'not-started' }) }), ev('todoChanged', 21, { todo: todo('x1', { old: 'decision-needed', new: 'not-started' }) })];
        const rows = decisionRows(answered);
        assert.deepEqual(rows.find((r) => r.todo!.id === 'w3')!.continueQueue, { windowId: 'wq', run: 'redesign', itemId: 'item-9' });
        assert.ok(rows.find((r) => r.todo!.id === 'w3')!.details.includes('Held queue item item-9 in run redesign (webwork)'));
        assert.equal(rows.find((r) => r.todo!.id === 'x1')!.continueQueue, undefined, 'no queue waited for x1');
    });

    test('UA-3: the hold event names the todo', () => {
        const d = queueHoldingDraft({ id: 'i1', status: 'decision-needed', run: 'r', preview: 'walk', decisionTodo: { quest: 'webwork', id: 'w3' } }, 'decision-needed');
        assert.deepEqual(d.todo, { id: 'w3', quest: 'webwork', fields: [] });
        assert.equal(queueHoldingDraft({ id: 'i1', status: 'error', run: 'r', preview: 'x', error: 'boom' }, 'error').todo, undefined);
        const mgr = src('src', 'managers', 'promptQueueManager.ts');
        assert.match(mgr, /const decisionTodo = i\.status === 'decision-needed' \? this\._decisionTodoOf\(i\) : undefined;/);
    });

    test('UA-4: the request channel', () => {
        const root = path.join(SANDBOX, 'windows');
        configureWindowRequests(root, 'owner');
        publishInteractions([
            { id: 'q1', kind: 'question', run: 'default', createdAt: 1, title: 'Which?', data: { questions: ['Which?'] } },
            { id: 'remote:x:y', kind: 'question', run: 'other · default', createdAt: 2, title: 'stand-in', data: {}, proxyOf: { windowId: 'x', id: 'y' } },
        ]);
        configureWindowRequests(root, 'helper');
        assert.deepEqual(readWindowInteractions('owner').map((v) => v.id), ['q1'], 'stand-ins are not published');
        assert.deepEqual(readWindowInteractions('nobody'), []);
        assert.equal(sendWindowRequest('owner', { type: 'answerAsk', id: 'q1', response: { type: 'submit', text: 'b' } }), true);
        assert.equal(sendWindowRequest('owner', { type: 'resumeRun', run: 'redesign' }), true);
        fs.writeFileSync(path.join(root, 'requests', 'owner', 'zzz-broken.json'), '{not json');
        configureWindowRequests(root, 'owner');
        const done: string[] = [];
        const handlers = {
            answerAsk: (id: string, r: Record<string, unknown>) => { done.push(`answer ${id} ${String(r.text)}`); return true; },
            resumeRun: (run: string) => { done.push(`resume ${run}`); throw new Error('a failing handler'); },
        };
        assert.equal(takeWindowRequests(handlers), 1, 'one carried out; the failing one and the broken file do not stop it');
        assert.deepEqual(done, ['answer q1 b', 'resume redesign']);
        assert.deepEqual(fs.readdirSync(path.join(root, 'requests', 'owner')), [], 'every file taken');
        assert.equal(takeWindowRequests(handlers), 0, 'taken once');
    });

    test('UA-5: a stand-in for another window\'s ask', () => {
        const root = path.join(SANDBOX, 'windows2');
        configureWindowRequests(root, 'owner');
        publishInteractions([
            { id: 'q1', kind: 'question', run: 'chg1', createdAt: 1, title: 'Which store?', data: { questions: ['Which store?'] }, queueItemId: 'item-3' },
            { id: 'm1', kind: 'mdBrowser', run: 'default', createdAt: 2, title: 'Review', data: { file: 'a.md' } },
        ]);
        configureWindowRequests(root, 'helper');
        const here = new UserInteractions();
        const emitted: Json[] = [];
        const stop = startUserNotificationEmitter({ interactions: here, emit: (d) => emitted.push(...d) });
        const opened = openRemoteAsk(here, 'owner', 'q1', 'webwork', 100) as Json;
        assert.deepEqual(opened, { ok: true, id: remoteAskId('owner', 'q1'), run: 'webwork · chg1' });
        const proxy = here.get(opened.id)!;
        assert.equal(proxy.title, 'Which store? (webwork)');
        assert.deepEqual(proxy.data, { questions: ['Which store?'] });
        assert.deepEqual(proxy.proxyOf, { windowId: 'owner', id: 'q1' });
        assert.equal(emitted.length, 0, 'a stand-in is not reported');
        assert.deepEqual(openRemoteAsk(here, 'owner', 'q1', 'webwork'), opened, 'opened twice: the same stand-in');
        assert.match((openRemoteAsk(here, 'owner', 'm1', 'webwork') as Json).reason, /MD Browser ask/);
        assert.match((openRemoteAsk(here, 'owner', 'gone', 'webwork') as Json).reason, /no longer open in webwork/);
        proxy.respond!({ type: 'answers', requestId: opened.id, answers: ['b'] });
        assert.equal(here.get(opened.id), undefined, 'gone once answered');
        assert.equal(emitted.length, 0);
        configureWindowRequests(root, 'owner');
        const got: Json[] = [];
        takeWindowRequests({ answerAsk: (id, r) => { got.push({ id, r }); return true; }, resumeRun: () => false });
        assert.deepEqual(got, [{ id: 'q1', r: { type: 'answers', requestId: 'q1', answers: ['b'], id: 'q1' } }], 'the real id');
        // Settled in its window: the stand-in leaves.
        configureWindowRequests(root, 'helper');
        openRemoteAsk(here, 'owner', 'q1', 'webwork');
        configureWindowRequests(root, 'owner');
        publishInteractions([]);
        configureWindowRequests(root, 'helper');
        assert.equal(syncRemoteAsks(here), 1);
        assert.equal(here.list().length, 0);
        stop();
    });

    test('UA-6: the page', (t) => {
        const dom = new JSDOM(src('media', 'userNotifications', 'index.html').replace(/<script[\s\S]*?<\/script>/g, ''), { runScripts: 'outside-only' });
        const w = dom.window as Json;
        t.after(() => w.close());
        const posted: Json[] = [];
        w.acquireVsCodeApi = () => ({ postMessage: (m: Json) => posted.push(JSON.parse(JSON.stringify(m))) });
        w.__INIT__ = {};
        w.eval(src('media', 'userNotifications', 'main.js'));
        const rows = decisionRows([
            ev('todoChanged', 0, { todo: todo('open1', { old: 'not-started', new: 'decision-needed' }) }),
            ev('todoChanged', 1, { todo: todo('done1', { old: 'not-started', new: 'decision-needed' }) }),
            ev('queueHolding', 2, { windowId: 'wq', run: 'redesign', todo: todo('done1'), user: { kind: 'decision-needed', title: 'held', queueItemId: 'i9' } }),
            ev('todoChanged', 3, { todo: todo('done1', { old: 'decision-needed', new: 'not-started' }) }),
        ]);
        w.dispatchEvent(new w.MessageEvent('message', { data: { type: 'state', rows, open: 1, thisWindow: 'w1' } }));
        const row = (id: string): Json => [...w.document.querySelectorAll('.row')].find((r: Json) => r.querySelector('.title').textContent.includes(id));
        const answer = row('open1').querySelector('[data-answer]');
        assert.match(answer.getAttribute('title'), /^Answer the decisions of todo webwork\/open1 in the Quest TODO panel \(bottom panel\)$/);
        answer.click();
        assert.deepEqual(posted.pop(), { type: 'answer', id: row('open1').getAttribute('data-id') });
        assert.equal(row('done1').querySelector('[data-answer]'), null);
        assert.equal(row('done1').querySelector('.state').textContent, 'decided');
        const cont = row('done1').querySelector('[data-continue]');
        assert.match(cont.getAttribute('title'), /continue run redesign/);
        cont.click();
        assert.deepEqual(posted.pop(), { type: 'continueQueue', id: row('done1').getAttribute('data-id') });
        assert.equal(row('open1').querySelector('[data-continue]'), null);
    });

    test('UA-7: the host', () => {
        const host = src('src', 'handlers', 'userNotifications-handler.ts');
        assert.match(host, /if \(row\.todo\) \{[\s\S]{0,200}selectTodoInBottomPanel\(row\.todo\.id, undefined, row\.todo\.quest\)/);
        assert.match(host, /if \(row\.windowId === me\) \{\s*return await openAskOfRow\(row, me\)/);
        assert.match(host, /openRemoteAsk\(userInteractions, row\.windowId, row\.key, label\)/);
        assert.match(host, /PromptQueueManager\.instance\.setRunAutoSend\(target\.run, true\)/);
        assert.match(host, /sendWindowRequest\(target\.windowId, \{ type: 'resumeRun', run: target\.run \}\)/);
        assert.match(host, /msg\.type === 'answer' \? await answerRow\(row\) : await continueQueueOfRow\(row\)/);
        const ext = src('src', 'extension.ts');
        assert.match(ext, /configureWindowRequests\(path\.join\(context\.globalStorageUri\.fsPath, 'windows'\)/);
        assert.match(ext, /resumeRun: \(run\) => \{\s*PromptQueueManager\.instance\.setRunAutoSend\(run, true\);/);
        assert.match(ext, /\(\) => \{ syncRemoteAsks\(userInteractions\); \}/);
    });
});
