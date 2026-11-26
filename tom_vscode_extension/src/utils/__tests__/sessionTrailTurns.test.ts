/**
 * The @CHAT Logs Trail tab's shaping (src/utils/sessionTrailTurns.ts).
 *
 *   ST-1 the turns are the session's view of the host trail (a bare `default` is `default@default`), as pairs with
 *        their header data, newest first; another session's turns are not there
 *   ST-3 the todo references of an answer, in order, without duplicates
 *   ST-4 the HTML: one block per turn, newest first, prompt then answer, the header data, the per-pair buttons and
 *        todo links; every text escaped; the cap names how many are shown; an empty session says so
 */

import test, { describe } from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';

import type { HostTrailTurn } from '../../services/hostTrail.js';
import {
    TRAIL_TURN_ACTIONS,
    renderSessionTrailHtml,
    sessionTrailTurnMarkdown,
    sessionTrailTurnTitle,
    sessionTrailTurns,
} from '../sessionTrailTurns.js';

const turn = (id: string, time: string, session: string, answer = `answer ${id}`): HostTrailTurn => ({
    id, time, host: 'h1', session, profile: 'p1', model: 'm1', prompt: `prompt ${id}`, answer,
});

describe('the Trail tab\'s turns', () => {
    test('ST-1: the session view, newest first', () => {
        const trail = [
            turn('a', '2026-11-25T10:00:00.000Z', 'default@default'),
            turn('b', '2026-11-25T11:00:00.000Z', 'chat'),
            turn('c', '2026-11-25T12:00:00.000Z', 'default@default'),
        ];
        const turns = sessionTrailTurns(trail, 'default');
        assert.deepEqual(turns.map((t) => t.id), ['c', 'a']);
        assert.deepEqual(turns[0], {
            id: 'c', time: '2026-11-25T12:00:00.000Z', profile: 'p1', model: 'm1',
            prompt: 'prompt c', answer: 'answer c', todoRefs: [],
        });
        assert.deepEqual(sessionTrailTurns(trail, 'chat').map((t) => t.id), ['b']);
        assert.deepEqual(sessionTrailTurns(trail, 'walk'), []);
    });

    test('ST-3: the todo references of an answer', () => {
        const answer = 'Done.\n\nvariables:\n - TODO = _ai/quests/q/todos.q.todo.yaml/q1\n - TODO2 = _ai/quests/q/todos.q.todo.yaml/q2\n - TODO3 = _ai/quests/q/todos.q.todo.yaml/q1\n';
        const [t] = sessionTrailTurns([turn('a', '2026-11-25T10:00:00.000Z', 'chat', answer)], 'chat');
        assert.deepEqual(t.todoRefs, ['_ai/quests/q/todos.q.todo.yaml/q1', '_ai/quests/q/todos.q.todo.yaml/q2']);
    });

    test('ST-4: the HTML of the pairs', () => {
        const trail = [
            turn('a', '2026-11-25T10:00:00.000Z', 'chat', 'answer a\n\nvariables:\n - TODO = _ai/quests/q/todos.q.todo.yaml/q1\n'),
            { ...turn('b', '2026-11-25T11:00:00.000Z', 'chat'), prompt: '<script>alert(1)</script>\n## heading' },
        ];
        const turns = sessionTrailTurns(trail, 'chat');
        const doc = new JSDOM(`<body>${renderSessionTrailHtml('chat', turns)}</body>`).window.document;
        const blocks = [...doc.querySelectorAll('.qlog-turn')];
        assert.deepEqual(blocks.map((b) => b.getAttribute('data-qlog-turn')), ['b', 'a'], 'newest first');
        const first = blocks[0];
        assert.equal(doc.querySelector('script'), null, 'a prompt cannot inject markup');
        assert.match(first.querySelector('.qlog-turn-prompt')!.textContent!, /<script>alert\(1\)<\/script>\n## heading/);
        assert.equal(first.querySelector('.qlog-turn-answer')!.textContent, 'answer b');
        const labels = [...first.querySelectorAll('.qlog-turn-label')].map((l) => l.textContent);
        assert.deepEqual(labels, ['Prompt', 'Answer'], 'the prompt, then its answer');
        assert.match(first.querySelector('.qlog-turn-meta')!.textContent!, /2026-11-25T11:00:00\.000Z · p1 · m1/);
        assert.deepEqual([...first.querySelectorAll('[data-qlog-turn-action]')].map((b) => [b.getAttribute('data-qlog-turn-action'), b.getAttribute('data-qlog-turn')]),
            TRAIL_TURN_ACTIONS.map((a) => [a.id, 'b']));
        assert.deepEqual([...blocks[1].querySelectorAll('[data-qlog-todo]')].map((a) => [a.getAttribute('data-qlog-todo'), a.textContent]),
            [['_ai/quests/q/todos.q.todo.yaml/q1', 'q1']]);
        assert.match(doc.querySelector('.qlog-turns-head')!.textContent!, /2 turns of session chat on this machine, newest first$/);

        const capped = new JSDOM(`<body>${renderSessionTrailHtml('chat', turns, 1)}</body>`).window.document;
        assert.equal(capped.querySelectorAll('.qlog-turn').length, 1);
        assert.match(capped.querySelector('.qlog-turns-head')!.textContent!, /the newest 1 shown/);
        assert.match(renderSessionTrailHtml('walk', []), /Session "walk" has no turns on this machine yet/);
    });

    test('ST-4: the Markdown overlay\'s text and title', () => {
        const [t] = sessionTrailTurns([turn('a', '2026-11-25T10:00:00.000Z', 'chat')], 'chat');
        assert.equal(sessionTrailTurnMarkdown(t), '## Prompt\n\nprompt a\n\n## Answer\n\nanswer a');
        assert.equal(sessionTrailTurnTitle(t), '2026-11-25T10:00:00.000Z · p1 · m1');
        assert.equal(sessionTrailTurnTitle({ time: 't', profile: '', model: '' }), 't');
    });
});
