/**
 * The done-notification of a queue item (src/utils/doneNotification.ts) and the window heartbeat
 * (src/utils/windowHeartbeat.ts).
 *
 *   DN-1 queued ahead of every other pending item, with the item's transport, profile and session;
 *        ${itemOutcome} reads `done` or `error: <message>`
 *   DN-2 nothing to queue: no prompt, a blank one, a disabled one, already queued for this run; a new run notifies again
 *   DN-3 "pause after this" moves to the notification; a temporary session is handed over, else deleted at once
 *   DN-4 the fields round-trip through an entry's meta, and an untouched item writes nothing
 *   DN-5 a template iteration carries transport, profile, session and the notification to the next iteration
 *   DN-6 the target (vscimpb71): by default the item's own run; another run of this quest gets the session's base
 *        name (the queue makes it `<session>@<run>`) and keeps transport, profile, pause and temporary session; another
 *        quest gets the text only, run `default` unless named, no pause or temporary session handed over (deleted at
 *        once); ${senderQuest} / ${senderRun} filled; this quest named is the default; the target fields round-trip
 *   DN-7 the queue editor's pickers: this quest first, then quests with a running window, then the others (their
 *        notification waits in the inbox); the runs with the default first
 *   HB-1 the stale rule: a heartbeat within 90 s is alive, an older one or none is not
 *   HB-2 the live windows of a quest; the server summary; a heartbeat merged into a state file keeps its fields
 */

import test, { describe } from 'node:test';
import assert from 'node:assert/strict';

import {
    applyPlanToItem,
    deletesTemporarySession,
    doneNotificationMetaFromYaml,
    doneNotificationMetaToYaml,
    outcomeText,
    planDoneNotification,
    type DoneNotificationItem,
} from '../doneNotification.js';
import { questPicks, runPicks } from '../doneNotificationTargets.js';
import { HEARTBEAT_STALE_MS, isWindowAlive, liveWindowsOf, serverSummary, withHeartbeat } from '../windowHeartbeat.js';
import { buildNextTemplateIterationParams } from '../queueStep3Utils.js';

const FROM = { quest: 'tom_uam', windowId: 'w1', host: 'mbp', sentAt: '2026-10-27T12:00:00.000Z' };

function item(extra: Partial<DoneNotificationItem> = {}): DoneNotificationItem {
    return {
        id: 'it-1',
        status: 'sent',
        runId: 'r1',
        transport: 'anthropic',
        anthropicProfileId: 'opus-direct',
        session: 'walk',
        doneNotificationPrompt: 'Report to ${senderQuest}: ${itemOutcome}',
        ...extra,
    };
}

describe('done-notification', () => {
    test('DN-1: what is queued, and where', () => {
        const queue = [
            { id: 'old', status: 'sent' }, { id: 'it-1', status: 'sent' }, { id: 'a', status: 'staged' },
            { id: 'b', status: 'pending' }, { id: 'c', status: 'pending' },
        ];
        const plan = planDoneNotification(item(), { kind: 'done' }, queue, 'vscode_extension');
        assert.deepEqual(plan, {
            text: 'Report to vscode_extension: done',
            position: 3,
            transport: 'anthropic',
            anthropicProfileId: 'opus-direct',
            session: 'walk',
            pauseAfter: false,
            temporarySession: false,
            notificationOf: 'it-1',
            run: 'r1',
            targetRun: 'default',
            explicitRun: false,
        }, 'ahead of the first pending item; a staged one is not waiting to run; ${senderQuest} is this quest');
        assert.equal(planDoneNotification(item(), { kind: 'done' }, [{ id: 'it-1', status: 'sent' }])?.position, -1, 'nothing pending: appended');
        const failed = planDoneNotification(item({ status: 'error' }), { kind: 'error', message: 'Invalid\n  request (400)' }, queue, 'vscode_extension');
        assert.equal(failed?.text, 'Report to vscode_extension: error: Invalid request (400)');
        assert.equal(outcomeText({ kind: 'error', message: '' }), 'error: unknown error');
    });

    test('DN-2: nothing to queue', () => {
        const queue = [{ id: 'it-1', status: 'sent' }];
        assert.equal(planDoneNotification(item({ doneNotificationPrompt: undefined }), { kind: 'done' }, queue), null);
        assert.equal(planDoneNotification(item({ doneNotificationPrompt: '   ' }), { kind: 'done' }, queue), null);
        assert.equal(planDoneNotification(item({ doneNotificationDisabled: true }), { kind: 'done' }, queue), null, 'switched off');
        const finished = item();
        const plan = planDoneNotification(finished, { kind: 'error', message: 'retries exhausted' }, queue)!;
        applyPlanToItem(finished, plan);
        assert.equal(planDoneNotification(finished, { kind: 'done' }, queue), null, 'the error was retried by hand and then succeeded: once per run');
        finished.runId = 'r2';
        assert.ok(planDoneNotification(finished, { kind: 'done' }, queue), 'Send Now starts a new run: notified again');
        assert.equal(planDoneNotification(item({ runId: undefined }), { kind: 'done' }, queue)?.run, 'run');
    });

    test('DN-3: pause after and the temporary session', () => {
        const queue = [{ id: 'it-1', status: 'sent' }];
        const paused = item({ pauseAfter: true, temporarySession: true });
        const plan = planDoneNotification(paused, { kind: 'done' }, queue)!;
        assert.deepEqual([plan.pauseAfter, plan.temporarySession], [true, true]);
        assert.equal(deletesTemporarySession(paused, plan), false, 'the notification runs in it');
        applyPlanToItem(paused, plan);
        assert.deepEqual([paused.pauseAfter, paused.temporarySession, paused.doneNotificationQueuedFor], [false, false, 'r1'],
            'the item no longer pauses the queue; the notification does');
        const notification = item({ id: 'n-1', doneNotificationPrompt: undefined, temporarySession: true, notificationOf: 'it-1' });
        assert.equal(deletesTemporarySession(notification, planDoneNotification(notification, { kind: 'done' }, queue)), true,
            'the notification is done: its temporary session goes');
        const silent = item({ doneNotificationPrompt: undefined, temporarySession: true });
        assert.equal(deletesTemporarySession(silent, null), true, 'no notification: deleted with the item');
        assert.equal(deletesTemporarySession(item(), null), false, 'a lasting session stays');
    });

    test('DN-4: entry meta', () => {
        const full: Partial<DoneNotificationItem> = {
            doneNotificationPrompt: 'tell me',
            doneNotificationDisabled: true,
            doneNotificationQueuedFor: 'r1',
            notificationOf: 'it-0',
            from: FROM,
            temporarySession: true,
        };
        const meta = doneNotificationMetaToYaml(full);
        assert.deepEqual(meta, {
            'done-notification': { prompt: 'tell me', disabled: true, 'queued-for-run': 'r1' },
            'notification-of': 'it-0',
            from: { quest: 'tom_uam', 'window-id': 'w1', host: 'mbp', 'sent-at': '2026-10-27T12:00:00.000Z' },
            'temporary-session': true,
        });
        assert.deepEqual(doneNotificationMetaFromYaml(meta), full);
        assert.deepEqual(doneNotificationMetaToYaml({}), {}, 'an untouched item writes nothing');
        assert.deepEqual(doneNotificationMetaFromYaml({ id: 'x', status: 'sent' }), {});
    });

    test('DN-5: template iterations carry where they run and what they report', () => {
        const params = buildNextTemplateIterationParams({
            originalText: 'Body',
            templateRepeatCount: 3,
            templateRepeatIndex: 0,
            transport: 'anthropic',
            anthropicProfileId: 'opus-direct',
            session: 'walk',
            doneNotificationPrompt: 'tell ${senderQuest}',
            from: FROM,
            temporarySession: true,
        }, 3)!;
        assert.deepEqual(
            [params.transport, params.anthropicProfileId, params.session, params.doneNotificationPrompt, params.from, params.temporarySession],
            ['anthropic', 'opus-direct', 'walk', 'tell ${senderQuest}', FROM, true],
        );
        const plain = buildNextTemplateIterationParams({ originalText: 'Body', templateRepeatCount: 2, templateRepeatIndex: 0 }, 2)!;
        assert.equal('transport' in plain, false, 'unset stays unset (the queue default applies)');
    });

    test('DN-6: the target quest and run', () => {
        const base: DoneNotificationItem = {
            id: 'i1', status: 'sent', run: 'r1', transport: 'anthropic', anthropicProfileId: 'p', session: 'sa@r1',
            pauseAfter: true, temporarySession: false, doneNotificationPrompt: '${senderQuest}/${senderRun}: ${itemOutcome}',
        };
        const pending = [{ id: 'i1', status: 'sent' }, { id: 'i2', status: 'pending' }];
        const own = planDoneNotification({ ...base }, { kind: 'done' }, pending, 'q1')!;
        assert.deepEqual([own.targetRun, own.targetQuest, own.explicitRun, own.session, own.position, own.text],
            ['r1', undefined, false, 'sa@r1', 1, 'q1/r1: done'], 'the default: the item\'s own run and session');
        const otherRun = planDoneNotification({ ...base, doneNotificationRun: 'r2' }, { kind: 'done' }, pending, 'q1')!;
        assert.deepEqual([otherRun.targetRun, otherRun.explicitRun, otherRun.session, otherRun.pauseAfter, otherRun.transport, otherRun.anthropicProfileId],
            ['r2', true, 'sa', true, 'anthropic', 'p'], 'another run: the session\'s base name, the rest as before');
        const sameRunNamed = planDoneNotification({ ...base, doneNotificationRun: 'r1' }, { kind: 'done' }, pending, 'q1')!;
        assert.equal(sameRunNamed.session, 'sa@r1');
        const ownNamed = planDoneNotification({ ...base, doneNotificationQuest: 'q1' }, { kind: 'done' }, pending, 'q1')!;
        assert.equal(ownNamed.targetQuest, undefined, 'this quest named is the default');
        const tmp = { ...base, session: 'tmp-261113-120000-abc', temporarySession: true };
        const other = planDoneNotification({ ...tmp, doneNotificationQuest: 'q2' }, { kind: 'error', message: 'x' }, pending, 'q1')!;
        assert.deepEqual(other, {
            text: 'q1/r1: error: x', position: -1, pauseAfter: false, temporarySession: false, notificationOf: 'i1', run: 'run',
            targetQuest: 'q2', targetRun: 'default', explicitRun: true,
        }, 'another quest: the text only, its queue\'s defaults');
        assert.equal(deletesTemporarySession(tmp, other), true, 'a temporary session is not handed over to another quest');
        assert.equal(planDoneNotification({ ...base, doneNotificationQuest: 'q2', doneNotificationRun: 'rx' }, { kind: 'done' }, pending, 'q1')!.targetRun, 'rx');
        const applied = { ...base, doneNotificationQuest: 'q2' };
        applyPlanToItem(applied, planDoneNotification(applied, { kind: 'done' }, pending, 'q1')!);
        assert.equal(applied.pauseAfter, true, 'the pause stays with the item');
        const fields = { doneNotificationPrompt: 'x', doneNotificationQuest: 'q2', doneNotificationRun: 'rx',
            doneNotificationPosted: { quest: 'q2', run: 'rx', file: 'f.inbox.queue.yaml', waiting: true, at: '2026-11-13T20:00:00.000Z' } };
        assert.deepEqual(doneNotificationMetaFromYaml(doneNotificationMetaToYaml(fields)), fields, 'round-trips');
        assert.deepEqual(doneNotificationMetaToYaml({ doneNotificationRun: 'r2' }), { 'done-notification': { prompt: '', run: 'r2' } });
    });

    test('DN-7: the editor\'s pickers', () => {
        assert.deepEqual(questPicks('q1', ['q3', 'q1', 'q2', 'q4'], new Set(['q4', 'q2'])).map((p) => [p.label, p.value, p.description]), [
            ['q1', '', 'this quest (default)'],
            ['q2', 'q2', 'a window is running'],
            ['q4', 'q4', 'a window is running'],
            ['q3', 'q3', 'no window running: waits in its inbox until one starts'],
        ]);
        assert.deepEqual(runPicks(['r2', 'default', 'r1'], true, 'r1').map((p) => [p.label, p.value]),
            [['r1', ''], ['default', 'default'], ['r2', 'r2']], 'this quest: the item\'s run is the default');
        assert.deepEqual(runPicks(['rx'], false, 'r1').map((p) => [p.label, p.value]), [['default', ''], ['rx', 'rx']], 'another quest: default');
    });
});

describe('window heartbeat', () => {
    test('HB-1: the stale rule', () => {
        const now = Date.parse('2026-10-27T12:00:00.000Z');
        assert.equal(isWindowAlive({ heartbeat: '2026-10-27T11:59:00.000Z' }, now), true);
        assert.equal(isWindowAlive({ heartbeat: new Date(now - HEARTBEAT_STALE_MS).toISOString() }, now), true, 'exactly 90 s');
        assert.equal(isWindowAlive({ heartbeat: new Date(now - HEARTBEAT_STALE_MS - 1).toISOString() }, now), false);
        assert.equal(isWindowAlive({}, now), false, 'no heartbeat (an older build): not known to run');
        assert.equal(isWindowAlive({ heartbeat: 'garbage' }, now), false);
    });

    test('HB-2: live windows, servers, merging', () => {
        const now = Date.parse('2026-10-27T12:00:00.000Z');
        const fresh = '2026-10-27T11:59:45.000Z';
        const states = [
            { windowId: 'a', workspace: 'tom_uam', activeQuest: 'tom_uam', heartbeat: fresh },
            { windowId: 'b', workspace: 'tom_uam', activeQuest: 'tom_uam', heartbeat: '2026-10-27T11:00:00.000Z' },
            { windowId: 'c', workspace: 'other', activeQuest: 'other', heartbeat: fresh },
            { windowId: 'd', workspace: 'tom_uam', activeQuest: '' , heartbeat: fresh },
        ];
        assert.deepEqual(liveWindowsOf(states, 'tom_uam', now).map((s) => s.windowId), ['a', 'd']);
        assert.equal(serverSummary({ cliServer: { running: true, port: 19901 }, mcpServer: { running: true, host: '0.0.0.0', port: 19921 } }), 'CLI :19901 · MCP :19921');
        assert.equal(serverSummary({ cliServer: { running: false }, mcpServer: { running: true } }), 'MCP');
        assert.equal(serverSummary({}), '');
        const merged = withHeartbeat({ windowId: 'a', status: [{ subsystem: 'queue' }] }, { pid: 42, mcpServer: { running: true, port: 19920 } }, new Date(now));
        assert.deepEqual(merged, {
            windowId: 'a',
            status: [{ subsystem: 'queue' }],
            heartbeat: '2026-10-27T12:00:00.000Z',
            pid: 42,
            cliServer: { running: false },
            mcpServer: { running: true, port: 19920 },
        });
    });
});
