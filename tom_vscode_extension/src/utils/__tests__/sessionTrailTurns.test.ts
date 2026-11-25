/**
 * The @CHAT Logs Trail tab's shaping (src/utils/sessionTrailTurns.ts).
 *
 *   ST-1 the turns are the session's view of the host trail (a bare `default` is `default@default`), as pairs with
 *        their header data, newest first; another session's turns are not there
 *   ST-2 OLD PLACE: an older build's pairs add only the turns older than the host trail's oldest turn whose request
 *        id the trail does not have, without duplicates; with an empty host trail all of them
 *   ST-3 the todo references of an answer, in order, without duplicates
 *   ST-4 the HTML: one block per turn, newest first, prompt then answer, the header data, the per-pair buttons and
 *        todo links; every text escaped; the cap names how many are shown; an empty session says so
 *   ST-5 the old pair files are read from the session's old place (prompt and answer by request id)
 */

import test, { after, describe } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'fs';
import * as path from 'path';
import { JSDOM } from 'jsdom';

import type { HostTrailTurn } from '../../services/hostTrail.js';
import {
    TRAIL_TURN_ACTIONS,
    readOlderSessionPairs,
    renderSessionTrailHtml,
    sessionTrailTurnMarkdown,
    sessionTrailTurnTitle,
    sessionTrailTurns,
    type OlderSessionPair,
} from '../sessionTrailTurns.js';

const turn = (id: string, time: string, session: string, answer = `answer ${id}`): HostTrailTurn => ({
    id, time, host: 'h1', session, profile: 'p1', model: 'm1', prompt: `prompt ${id}`, answer,
});
const older = (requestId: string, timestamp: string): OlderSessionPair => ({ requestId, timestamp, prompt: `old prompt ${requestId}`, answer: `old answer ${requestId}` });

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
            prompt: 'prompt c', answer: 'answer c', olderBuild: false, todoRefs: [],
        });
        assert.deepEqual(sessionTrailTurns(trail, 'chat').map((t) => t.id), ['b']);
        assert.deepEqual(sessionTrailTurns(trail, 'walk'), []);
    });

    test('ST-2: an older build\'s pairs before the trail', () => {
        const trail = [turn('t1', '2026-11-25T10:00:00.000Z', 'chat'), turn('t2', '2026-11-25T11:00:00.000Z', 'chat')];
        const pairs = [
            older('o2', '2026-11-24T09:00:00.000Z'),
            older('t1', '2026-11-24T08:00:00.000Z'), // in the trail: not again
            older('o3', '2026-11-25T10:30:00.000Z'), // not older than the trail's oldest
            older('o1', '2026-11-24T08:30:00.000Z'),
            older('o1', '2026-11-24T08:30:00.000Z'), // a duplicate
        ];
        const turns = sessionTrailTurns(trail, 'chat', pairs);
        assert.deepEqual(turns.map((t) => [t.id, t.olderBuild]), [['t2', false], ['t1', false], ['o2', true], ['o1', true]]);
        assert.equal(turns[2].prompt, 'old prompt o2');
        assert.equal(turns[2].profile, '', 'an older pair has no profile');
        // The trail's oldest is the host's, not the session's: another session's older turn bounds it too.
        const mixed = [turn('x', '2026-11-20T00:00:00.000Z', 'walk'), ...trail];
        assert.deepEqual(sessionTrailTurns(mixed, 'chat', pairs).map((t) => t.id), ['t2', 't1']);
        assert.deepEqual(sessionTrailTurns([], 'chat', pairs).map((t) => t.id), ['o3', 'o2', 'o1', 't1'], 'no host trail: every older pair, once');
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
        const turns = sessionTrailTurns(trail, 'chat', [older('o', '2026-11-24T00:00:00.000Z')]);
        const doc = new JSDOM(`<body>${renderSessionTrailHtml('chat', turns)}</body>`).window.document;
        const blocks = [...doc.querySelectorAll('.qlog-turn')];
        assert.deepEqual(blocks.map((b) => b.getAttribute('data-qlog-turn')), ['b', 'a', 'o'], 'newest first');
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
        assert.ok(blocks[2].querySelector('.qlog-turn-tag'), 'an older build\'s pair is marked');
        assert.match(doc.querySelector('.qlog-turns-head')!.textContent!, /3 turns of session chat on this machine, newest first$/);

        const capped = new JSDOM(`<body>${renderSessionTrailHtml('chat', turns, 2)}</body>`).window.document;
        assert.equal(capped.querySelectorAll('.qlog-turn').length, 2);
        assert.match(capped.querySelector('.qlog-turns-head')!.textContent!, /the newest 2 shown/);
        assert.match(renderSessionTrailHtml('walk', []), /Session "walk" has no turns on this machine yet/);
    });

    test('ST-4: the Markdown overlay\'s text and title', () => {
        const [t] = sessionTrailTurns([turn('a', '2026-11-25T10:00:00.000Z', 'chat')], 'chat');
        assert.equal(sessionTrailTurnMarkdown(t), '## Prompt\n\nprompt a\n\n## Answer\n\nanswer a');
        assert.equal(sessionTrailTurnTitle(t), '2026-11-25T10:00:00.000Z · p1 · m1');
        assert.equal(sessionTrailTurnTitle({ time: 't', profile: '', model: '' }), 't');
    });
});

describe('the older build\'s pair files', () => {
    const base = path.resolve(__dirname, '..', '..', '..', '..', '..', '..', 'ztmp');
    fs.mkdirSync(base, { recursive: true });
    const root = fs.realpathSync(fs.mkdtempSync(path.join(base, 'sessionTrailTurns-')));
    after(() => fs.rmSync(root, { recursive: true, force: true }));

    test('ST-5: read from the session\'s old place', () => {
        const historyRoot = path.join(root, 'history');
        const dir = path.join(historyRoot, 'sessions', 'chat');
        fs.mkdirSync(dir, { recursive: true });
        fs.writeFileSync(path.join(dir, 'q.anthropic.prompts.md'),
            '=== PROMPT r2 2026-11-24T02:00:00.000Z 2 ===\nsecond prompt\n\n=== PROMPT r1 2026-11-24T01:00:00.000Z 1 ===\nfirst prompt\n');
        fs.writeFileSync(path.join(dir, 'q.anthropic.answers.md'),
            '=== ANSWER r1 2026-11-24T01:00:05.000Z 1 ===\nfirst answer\n');
        assert.deepEqual(readOlderSessionPairs(historyRoot, 'q', 'chat'), [
            { requestId: 'r2', timestamp: '2026-11-24T02:00:00.000Z', prompt: 'second prompt', answer: '' },
            { requestId: 'r1', timestamp: '2026-11-24T01:00:00.000Z', prompt: 'first prompt', answer: 'first answer' },
        ]);
        assert.deepEqual(readOlderSessionPairs(historyRoot, 'q', 'walk'), [], 'a session without an old pair');
    });
});
