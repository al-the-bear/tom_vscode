/**
 * The host's compact trail of a quest (src/services/hostTrail.ts): `history/trail.<host>.md`.
 *
 *   HT-1 the block format round-trips a turn exactly, Markdown headings, fenced code, empty and trailing lines and a
 *        line that looks like a marker included; a quoted block of the format itself stays text
 *   HT-2 a damaged block (no end marker, a header that does not read) is skipped, the turns around it are read
 *   HT-3 appending keeps file order (oldest first); every host's file is read; a session's view is its turns
 *   HT-4 the limit trims only turns the history watermark covers: no watermark, nothing goes; the watermark covers a
 *        prefix, only those go even when the file stays over the limit; another host's time covers nothing here
 *   HT-5 a turn in flight: its prompt is noted, the turn is written once with its answer; a session whose trail
 *        setting is off writes nothing; an answer without a noted prompt writes nothing
 */

import test, { describe } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import {
    appendHostTrailTurn,
    beginHostTrailTurn,
    completeHostTrailTurn,
    formatHostTrailTurn,
    formatSessionTrailView,
    hostTrailFile,
    parseHostTrail,
    readHostTrail,
    readHostTrails,
    findHostTrailTurn,
    newestHostTrailTurns,
    sessionView,
    type HostTrailTurn,
} from '../hostTrail.js';

/** A sandbox workspace with its own `.tom/tom_root.yaml`, and its quest folder. */
function sandbox(): { root: string; quest: string } {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'host-trail-'));
    fs.mkdirSync(path.join(root, '.tom'), { recursive: true });
    fs.writeFileSync(path.join(root, '.tom', 'tom_root.yaml'), 'name: sandbox\n');
    const quest = path.join(root, '_ai', 'quests', 'q');
    fs.mkdirSync(quest, { recursive: true });
    return { root, quest };
}

function turn(n: number, over: Partial<HostTrailTurn> = {}): HostTrailTurn {
    return {
        id: `req-${n}`,
        time: new Date(Date.UTC(2026, 10, 25, 10, 0, n)).toISOString(),
        host: 'mbp',
        session: 'default@default',
        profile: 'opus',
        model: 'claude-opus-5-5',
        prompt: `prompt ${n}`,
        answer: `answer ${n}`,
        ...over,
    };
}

describe('the host trail', () => {
    test('HT-1: the block format round-trips', () => {
        const tricky: HostTrailTurn = turn(1, {
            session: 'walk@chg1',
            profile: 'p--x',
            prompt: '## A heading\n\n```ts\nconst x = 1;\n```\n<!--tom-trail-answer-->\n\\<!--tom-trail-end-->\n=== PROMPT a 2026 1 ===\n',
            answer: '# Done\n\n<!--tom-trail-turn {"id":"fake"}-->\n<!--tom-trail-prompt-->\nquoted\n<!--tom-trail-end-->\n\n',
        });
        const plain = turn(2, { prompt: '', answer: 'one line' });
        const text = formatHostTrailTurn(tricky) + formatHostTrailTurn(plain);
        assert.deepEqual(parseHostTrail(text), [tricky, plain]);
        // The structure lines are the markers only; the escaped text lines are not markers.
        const markers = text.split('\n').filter((l) => l.startsWith('<!--tom-trail-'));
        assert.equal(markers.length, 8, 'four markers per turn, none from the texts');
        assert.ok(text.includes('### '), 'a heading for a reader');
        assert.doesNotMatch(text.split('\n')[0], /p--x/, 'no "--" inside the header comment');
    });

    test('HT-2: a damaged block is skipped', () => {
        const a = formatHostTrailTurn(turn(1));
        const cut = formatHostTrailTurn(turn(2)).replace('<!--tom-trail-end-->\n', '');
        const badHead = formatHostTrailTurn(turn(3)).replace(/^<!--tom-trail-turn \{/, '<!--tom-trail-turn {broken');
        const c = formatHostTrailTurn(turn(4));
        assert.deepEqual(parseHostTrail(`stray text\n${a}${cut}${badHead}${c}`).map((t) => t.id), ['req-1', 'req-4']);
        assert.deepEqual(parseHostTrail(''), []);
    });

    test('HT-3: append, read, every host, a session\'s view', () => {
        const { root, quest } = sandbox();
        appendHostTrailTurn(quest, turn(1), 2000);
        appendHostTrailTurn(quest, turn(2, { session: 'review' }), 2000);
        appendHostTrailTurn(quest, turn(3), 2000);
        appendHostTrailTurn(quest, turn(9, { host: 'bigbeast' }), 2000);
        assert.equal(hostTrailFile(quest, 'mbp'), path.join(quest, 'history', 'trail.mbp.md'));
        assert.deepEqual(readHostTrail(quest, 'mbp').map((t) => t.id), ['req-1', 'req-2', 'req-3'], 'oldest first');
        const all = readHostTrails(quest);
        assert.deepEqual([...all.keys()], ['bigbeast', 'mbp']);
        assert.deepEqual(all.get('bigbeast')?.map((t) => t.id), ['req-9']);
        assert.deepEqual(sessionView(readHostTrail(quest, 'mbp'), 'default').map((t) => t.id), ['req-1', 'req-3'], 'a bare default is default@default');
        assert.deepEqual(sessionView(readHostTrail(quest, 'mbp'), 'review').map((t) => t.id), ['req-2']);
        const view = formatSessionTrailView('default@default', sessionView(readHostTrail(quest, 'mbp'), 'default@default'));
        assert.ok(view.indexOf('prompt 3') < view.indexOf('prompt 1'), 'the view: newest first');
        assert.deepEqual([...readHostTrails(path.join(root, 'none')).keys()], []);
        fs.rmSync(root, { recursive: true, force: true });
    });

    test('HT-4: the limit trims covered turns only', () => {
        const { root, quest } = sandbox();
        for (let n = 1; n <= 6; n++) { appendHostTrailTurn(quest, turn(n), 4); }
        assert.equal(readHostTrail(quest, 'mbp').length, 6, 'no watermark: nothing goes');
        const watermark = path.join(quest, 'history', 'history.watermark.json');
        fs.writeFileSync(watermark, JSON.stringify({ hosts: { bigbeast: turn(6).time }, lastArchivedTodo: null, builtAt: turn(6).time }));
        appendHostTrailTurn(quest, turn(7), 4);
        assert.equal(readHostTrail(quest, 'mbp').length, 7, 'another host\'s time covers nothing of this host');
        fs.writeFileSync(watermark, JSON.stringify({ hosts: { mbp: turn(1).time }, lastArchivedTodo: null, builtAt: turn(1).time }));
        appendHostTrailTurn(quest, turn(8), 4);
        assert.deepEqual(readHostTrail(quest, 'mbp').map((t) => t.id), ['req-2', 'req-3', 'req-4', 'req-5', 'req-6', 'req-7', 'req-8'],
            'only the covered turn goes; the file stays over the limit');
        fs.writeFileSync(watermark, JSON.stringify({ hosts: { mbp: turn(8).time }, lastArchivedTodo: null, builtAt: turn(8).time }));
        appendHostTrailTurn(quest, turn(9), 4);
        assert.deepEqual(readHostTrail(quest, 'mbp').map((t) => t.id), ['req-6', 'req-7', 'req-8', 'req-9'], 'covered: back at the limit');
        fs.rmSync(root, { recursive: true, force: true });
    });

    test('HT-5: a turn in flight', () => {
        const { root, quest } = sandbox();
        const off = new Set(['quiet']);
        const opts = { maxEntries: 2000, contributes: (_q: string, s: string) => !off.has(s) };
        const begin = (id: string, session: string): void => {
            const { answer: _a, ...head } = turn(1, { id, session, prompt: `the prompt of ${id}` });
            beginHostTrailTurn({ ...head, questFolder: quest });
        };
        begin('a', 'work');
        assert.equal(readHostTrail(quest, 'mbp').length, 0, 'nothing before the answer');
        assert.equal(completeHostTrailTurn('a', 'the answer of a', opts), true);
        assert.equal(completeHostTrailTurn('a', '(error: again)', opts), false, 'written once');
        begin('b', 'quiet');
        assert.equal(completeHostTrailTurn('b', 'the answer of b', opts), false, 'the setting off: nothing');
        assert.equal(completeHostTrailTurn('never-begun', 'x', opts), false);
        const turns = readHostTrail(quest, 'mbp');
        assert.deepEqual(turns.map((t) => [t.id, t.session, t.prompt, t.answer]), [['a', 'work', 'the prompt of a', 'the answer of a']]);
        fs.rmSync(root, { recursive: true, force: true });
    });

    test('HT-7: newest turns and a turn by its id (the scripting API\'s trail operations)', () => {
        const { root, quest } = sandbox();
        for (let n = 1; n <= 4; n++) { appendHostTrailTurn(quest, turn(n), 2000); }
        appendHostTrailTurn(quest, turn(9, { id: 'other-9', host: 'bomber' }), 2000);
        const all = newestHostTrailTurns(quest, 'mbp');
        assert.deepEqual(all.turns.map((t) => t.id), ['req-4', 'req-3', 'req-2', 'req-1'], 'newest first, this host only');
        assert.equal(all.total, 4);
        const limited = newestHostTrailTurns(quest, 'mbp', { limit: 2 });
        assert.deepEqual([limited.turns.map((t) => t.id), limited.total], [['req-4', 'req-3'], 4], 'the limit cuts, total counts all');
        const since = newestHostTrailTurns(quest, 'mbp', { since: turn(2).time });
        assert.deepEqual([since.turns.map((t) => t.id), since.total], [['req-4', 'req-3'], 2], 'only after since');
        assert.deepEqual(newestHostTrailTurns(quest, 'nohost'), { turns: [], total: 0 });

        const own = findHostTrailTurn(quest, 'req-3', 'mbp');
        assert.equal(own?.turn.prompt, 'prompt 3');
        assert.equal(own?.file, hostTrailFile(quest, 'mbp'));
        const other = findHostTrailTurn(quest, 'other-9', 'mbp');
        assert.equal(other?.turn.host, 'bomber', 'another host\'s trail is searched too');
        assert.equal(other?.file, hostTrailFile(quest, 'bomber'));
        assert.equal(findHostTrailTurn(quest, 'nope', 'mbp'), undefined);
        fs.rmSync(root, { recursive: true, force: true });
    });
});
