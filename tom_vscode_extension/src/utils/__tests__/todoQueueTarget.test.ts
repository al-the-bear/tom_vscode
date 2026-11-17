/**
 * The queue-target flow's picks (utils/todoQueueTarget.ts) and the stored targets (utils/todoPanelRunSession.ts),
 * vscimpb139.
 *
 *   QT-1 the default quest: the todo's own when it has an open window, else the window's
 *   QT-2 the quest pick: "Last: …" first while its quest has a window (preselected), then the default quest, then the
 *        others; without Last the default is preselected
 *   QT-3 the run pick: `default` first, busy / paused / idle states, the last run (else this window's) preselected
 *   QT-4 the sessions of a run: that run's names, `chat` only where asked, never `default`; the session pick: the
 *        free ones, the queue default, a new session; the last choice preselected
 *   QT-5 the position pick: next or end, end by default
 *   QT-6 the direct send's pick: "Last: …" first while that session is free
 *   QT-7 busy sessions from queue entries on disk: sending and chat items hold their session (or the run's queue default)
 *   QT-8 the texts; the stored targets checked; the keys per panel instance
 */

import test, { describe } from 'node:test';
import assert from 'node:assert/strict';

import {
    busySessionsOfEntries,
    defaultTargetQuest,
    positionPickItems,
    questPickItems,
    queueTargetSentence,
    queueTargetText,
    runPickItems,
    runSessionCandidates,
    runStateText,
    sendSessionPickItems,
    sessionPickItems,
} from '../todoQueueTarget.js';
import { storedQueueTarget, storedSendTarget, todoPanelLastQueueTargetKey, todoPanelLastSendTargetKey } from '../todoPanelRunSession.js';

const active = (items: Array<{ label: string; active?: boolean }>): string | undefined => items.find((i) => i.active)?.label;

describe('the queue-target flow\'s picks', () => {
    test('QT-1: the default quest', () => {
        assert.equal(defaultTargetQuest('q2', 'q1', ['q1', 'q2']), 'q2');
        assert.equal(defaultTargetQuest('q3', 'q1', ['q1', 'q2']), 'q1', 'no window: the window\'s quest');
        assert.equal(defaultTargetQuest(undefined, '', ['q2']), 'q2');
    });

    test('QT-2: the quest pick', () => {
        const items = questPickItems(['q2', 'q1', 'q3'], 'q1', 'q1');
        assert.deepEqual(items.map((i) => i.label), ['q1', 'q2', 'q3']);
        assert.equal(active(items), 'q1');
        assert.match(items[0].description!, /this window · default/);
        assert.match(items[1].description!, /inbox/);
        const last = { quest: 'q2', run: 'r', session: 's@r', position: 'next' as const };
        const withLast = questPickItems(['q1', 'q2'], 'q1', 'q1', last);
        assert.equal(withLast[0].label, '$(history) Last: q2 / r / s@r / next');
        assert.deepEqual(withLast[0].value, { last });
        assert.equal(active(withLast), withLast[0].label);
        assert.equal(questPickItems(['q1'], 'q1', 'q1', last)[0].label, 'q1', 'its quest has no window: no Last');
    });

    test('QT-3: the run pick', () => {
        const runs = [{ run: 'r2', state: 'running', detail: 'item x', pending: 2 }, { run: 'default', state: 'idle', current: true }, { run: 'r1', state: 'paused' }];
        const items = runPickItems(runs);
        assert.deepEqual(items.map((i) => i.label), ['default', 'r1', 'r2']);
        assert.equal(active(items), 'default', 'this window\'s run');
        assert.equal(items[0].description, 'idle · this window\'s run');
        assert.equal(items[1].description, 'paused');
        assert.equal(items[2].description, 'busy — running: item x, 2 pending');
        assert.equal(active(runPickItems(runs, 'r2')), 'r2', 'the last run');
        assert.equal(runStateText({ run: 'x', state: 'waiting for user', detail: 'a question' }), 'busy — waiting for user: a question');
        assert.equal(runStateText({ run: 'x' }), '');
    });

    test('QT-4: the sessions', () => {
        const names = ['default', 'work', 'work@r2', 'other@r2', 'x@r3'];
        assert.deepEqual(runSessionCandidates(names, 'default', true), ['chat', 'work']);
        assert.deepEqual(runSessionCandidates(names, 'r2', false), ['work@r2', 'other@r2']);
        assert.deepEqual(runSessionCandidates(names, 'r2', true), ['chat', 'work@r2', 'other@r2'], 'chat is shared by every run');
        const items = sessionPickItems(['work@r2'], 'r2');
        assert.deepEqual(items.map((i) => i.label), ['work@r2', '$(list-ordered) Queue default', '$(add) New session…']);
        assert.equal(active(items), 'work@r2');
        assert.deepEqual(items[1].value, {});
        assert.deepEqual(items[2].value, { newSession: true });
        assert.equal(active(sessionPickItems(['a', 'b'], 'r', { session: 'b' })), 'b');
        assert.equal(active(sessionPickItems(['a'], 'r', {})), '$(list-ordered) Queue default', 'last: the queue default');
        assert.equal(active(sessionPickItems(['a'], 'r', { session: 'gone' })), 'a', 'a last session no longer free: the first');
    });

    test('QT-5: the position pick', () => {
        assert.equal(active(positionPickItems()), '$(arrow-down) End of the queue');
        assert.equal(active(positionPickItems('next')), '$(arrow-up) Next');
        assert.deepEqual(positionPickItems().map((i) => i.value), ['next', 'end']);
    });

    test('QT-6: the direct send\'s pick', () => {
        const free = [{ run: 'default', session: 'work' }, { run: 'r2', session: 'work@r2' }];
        const items = sendSessionPickItems(free);
        assert.deepEqual(items.map((i) => [i.label, i.description]), [['work', 'run default · free'], ['work@r2', 'run r2 · free']]);
        assert.equal(active(items), 'work');
        const withLast = sendSessionPickItems(free, { run: 'r2', session: 'work@r2' });
        assert.equal(withLast[0].label, '$(history) Last: work@r2 — run r2');
        assert.equal(active(withLast), withLast[0].label);
        assert.equal(sendSessionPickItems(free, { run: 'r2', session: 'busy@r2' })[0].label, 'work', 'a busy last session: no Last');
    });

    test('QT-7: busy sessions from queue entries', () => {
        const busy = busySessionsOfEntries([
            { status: 'sending', session: 'a', run: 'default' },
            { status: 'chat', session: 'chat' },
            { status: 'sending', run: 'r2' },
            { status: 'sending' },
            { status: 'pending', session: 'p' },
            { status: 'sent', session: 's' },
        ]);
        assert.deepEqual([...busy].sort(), ['a', 'chat', 'default', 'default@r2']);
    });

    test('QT-8: texts and stored targets', () => {
        const t = { quest: 'q', run: 'r', position: 'end' as const };
        assert.equal(queueTargetText(t), 'q / r / queue default / end');
        assert.equal(queueTargetSentence(t), 'quest q, run r, session the queue default, at the end of the queue');
        assert.equal(queueTargetSentence({ ...t, session: 'n@r', newSession: true, position: 'next' }), 'quest q, run r, session n@r (new), next in the queue');
        assert.deepEqual(storedQueueTarget({ quest: 'q', run: 'r', session: 's', position: 'next', junk: 1 }), { quest: 'q', run: 'r', session: 's', position: 'next' });
        assert.deepEqual(storedQueueTarget({ quest: 'q', run: 'r', position: 'odd' }), { quest: 'q', run: 'r', position: 'end' });
        assert.equal(storedQueueTarget({ quest: 'q' }), undefined);
        assert.equal(storedQueueTarget('x'), undefined);
        assert.deepEqual(storedSendTarget({ run: 'r', session: 's' }), { run: 'r', session: 's' });
        assert.equal(storedSendTarget({ run: 'r' }), undefined);
        assert.equal(todoPanelLastQueueTargetKey('tom-todo'), 'tomAi.todoPanel.lastQueueTarget.tom-todo');
        assert.equal(todoPanelLastSendTargetKey('ws'), 'tomAi.todoPanel.lastSendTarget.ws');
    });
});
