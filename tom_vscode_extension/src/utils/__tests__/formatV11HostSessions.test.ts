/**
 * Format version 11, steps `host-trail`, `host-sessions` and `untrack` (src/utils/formatV11/hostSessions.ts):
 * sessions per host, the host trail from the old summary pairs, the D / C files out of git
 * (ai_format_migration.md § 3.2).
 *
 *   HS-1 a dry run lists every conversion, move and deletion and writes nothing
 *   HS-2 apply, the first host: the pairs become turns of `history/trail.<host>.md` (session, host, prompt, answer,
 *        time order, merged with the trail by id) and go; the definitions move to `history/<host>/` (bare `default`
 *        as `default@default`, `contributesToTrailAndMemory: true` when absent, a `basedOn: default` canonical);
 *        the storages move file by file to `history/<host>/sessions/<s>/`, the old session history
 *        (`compacted_history.md`, `history.json`, `history.md`) stays; `trail/current_prompt.*.md` and the
 *        storage marker go; the session store then lists the sessions of the new place
 *   HS-3 a second run lists nothing
 *   HS-4 existing targets: an identical definition or file goes; a definition with other content is a problem and
 *        both stay; the live trail is merged (ai-trail); a scratch file keeps the newer copy; a tool result whose
 *        number is taken gets the next free one; another file with other content is a problem
 *   HS-5 a later host: its storage at the old place whose definition another host moved gets a copy of that
 *        definition without its conversation; a storage with no definition anywhere moves alone
 *   HS-6 the host trail keeps its limit (only covered turns are trimmed); the pair of the quest's `history/` is the
 *        `default@default` session's
 *   HS-7 the quest history's first build deletes the old session histories and the folders then empty
 *   HS-8 untrack in a git fixture: the tracked files of the D / C kinds the ignore rules cover leave the index (kept on
 *        disk); a file force-added of another kind stays; dry run lists them; without git nothing is reported
 *   HS-9 through migrateAiFormats (format version 11): the storage step's per-quest files land in this host's
 *        `default@default` storage and its pair in the host trail, the compacted history at `history/` stays as the
 *        quest's history; the stamp is written; a second run lists nothing
 *   HS-10 a quest history already built (with its watermark) stays where it is
 */

import test, { describe } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import { migrateAiFormats } from '../aiFormatMigration';
import { makeGitUntrack } from '../aiFormatMigrationRun';
import { isUntrackedKind, migrateV11HostSessions, untrackIgnoredV11 } from '../formatV11/hostSessions';
import type { V11Context, V11Step } from '../formatV11/context';
import { hostTrailFile, parseHostTrail, formatHostTrailTurn, type HostTrailTurn } from '../../services/hostTrail';
import { deleteOldSessionHistories } from '../../services/questHistory';

interface Entry { quest: string; step: V11Step; detail: string }

const HOST = 'mbp';

function sandbox() {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'v11-host-'));
    const ai = path.join(root, '_ai');
    fs.mkdirSync(path.join(ai, 'quests'), { recursive: true });
    const write = (rel: string, text: string): string => {
        const p = path.join(ai, rel);
        fs.mkdirSync(path.dirname(p), { recursive: true });
        fs.writeFileSync(p, text);
        return p;
    };
    const exists = (rel: string): boolean => fs.existsSync(path.join(ai, rel));
    const read = (rel: string): string => fs.readFileSync(path.join(ai, rel), 'utf8');
    const json = (rel: string): Record<string, unknown> => JSON.parse(read(rel));
    const ctxOf = (apply: boolean, host: string, out: { changes: Entry[]; problems: Entry[] }, extra: Partial<V11Context> = {}): V11Context => {
        const quests = fs.readdirSync(path.join(ai, 'quests')).sort();
        return {
            aiRoot: ai, hostSlug: host, apply, quests, allQuests: quests,
            change: (quest, s, detail) => out.changes.push({ quest, step: s, detail }),
            problem: (quest, s, detail) => out.problems.push({ quest, step: s, detail }),
            rel: (p) => path.relative(ai, p).split(path.sep).join('/'),
            ...extra,
        };
    };
    const step = (apply: boolean, host = HOST): { changes: Entry[]; problems: Entry[] } => {
        const out = { changes: [] as Entry[], problems: [] as Entry[] };
        migrateV11HostSessions(ctxOf(apply, host, out));
        return out;
    };
    return { root, ai, write, exists, read, json, step, ctxOf };
}

const pair = (kind: 'PROMPT' | 'ANSWER', entries: Array<[string, string, string]>): string =>
    entries.map(([id, ts, body], i) => `=== ${kind} ${id} ${ts} ${entries.length - i} ===\n\n${body}\n\n${kind === 'PROMPT' ? 'TEMPLATE: (none)\n\n' : ''}`).join('');

/** A quest `qa` as an older build left it on mbp. */
function oldQuest(s: ReturnType<typeof sandbox>): void {
    const h = 'quests/qa/history';
    s.write(`${h}/chat.session.json`, JSON.stringify({ mode: 'continue', sessionId: 'S-chat' }));
    s.write(`${h}/default.session.json`, JSON.stringify({ mode: 'continue', sessionId: 'S-def' }));
    s.write(`${h}/work.session.json`, JSON.stringify({ mode: 'continue', basedOn: 'default', contributesToTrailAndMemory: false }));
    s.write(`${h}/chat.session.json.tmp`, '{');
    s.write(`${h}/sessions/.storage-version`, '2\n');
    s.write(`${h}/sessions/chat/compacted_history.md`, 'old blocks');
    s.write(`${h}/sessions/chat/history.json`, '{"compactedSummary":"x"}');
    s.write(`${h}/sessions/chat/history.md`, '# old');
    s.write(`${h}/sessions/chat/live-trail.md`, '# live\n');
    s.write(`${h}/sessions/chat/rawTurns.json`, '{"rounds":[]}');
    s.write(`${h}/sessions/chat/session-todos.todo.yaml`, 'todos: []\n');
    s.write(`${h}/sessions/chat/trail/tool_results/t1.json`, '"r1"');
    s.write(`${h}/sessions/chat/trail/current_prompt.queue.user.md`, 'current');
    s.write(`${h}/sessions/chat/trail/20261101_prompt.userprompt.md`, 'raw');
    s.write(`${h}/sessions/chat/qa.anthropic.prompts.md`, pair('PROMPT', [
        ['c2', '2026-11-02T10:00:00.000Z', 'second chat prompt\n\n## a heading'],
        ['c1', '2026-11-01T10:00:00.000Z', 'first chat prompt'],
    ]));
    s.write(`${h}/sessions/chat/qa.anthropic.answers.md`, pair('ANSWER', [
        ['c1', '2026-11-01T10:00:05.000Z', 'first chat answer\n\nvariables:\n - TODO = _ai/quests/qa/todos.qa.todo.yaml/qa1'],
    ]));
    s.write(`${h}/sessions/default/qa.anthropic.prompts.md`, pair('PROMPT', [['d1', '2026-11-01T12:00:00.000Z', 'queue prompt']]));
    s.write(`${h}/sessions/default/qa.anthropic.answers.md`, pair('ANSWER', [['d1', '2026-11-01T12:00:09.000Z', 'queue answer']]));
    s.write(`${h}/sessions/default/rawTurns.json`, '{"rounds":[["q"]]}');
    s.write('quests/qa/overview.qa.md', '# qa\n');
}

const turn = (id: string, time: string, session: string, host = HOST): HostTrailTurn => ({
    id, time, host, session, profile: 'p', model: 'm', prompt: `prompt ${id}`, answer: `answer ${id}`,
});

describe('format version 11: sessions per host', () => {
    test('HS-1: a dry run lists, writes nothing', () => {
        const s = sandbox();
        oldQuest(s);
        const before = execFileSync('find', ['.', '-type', 'f'], { cwd: s.ai, encoding: 'utf8' }).split('\n').sort();
        const { changes, problems } = s.step(false);
        assert.deepEqual(problems, []);
        const details = changes.map((c) => `${c.step}: ${c.detail}`);
        const has = (re: RegExp): void => assert.ok(details.some((d) => re.test(d)), `${re} in\n${details.join('\n')}`);
        has(/^host-trail: quests\/qa\/history\/sessions\/chat\/qa\.anthropic\.prompts\.md \+ .*answers\.md: 2 turn\(s\) of session chat into quests\/qa\/history\/trail\.mbp\.md/);
        has(/^host-trail: .*sessions\/default\/qa\.anthropic\.prompts\.md .*: 1 turn\(s\) of session default@default/);
        has(/^host-sessions: move quests\/qa\/history\/chat\.session\.json -> quests\/qa\/history\/mbp\/chat\.session\.json \(contributes/);
        has(/^host-sessions: move quests\/qa\/history\/default\.session\.json -> quests\/qa\/history\/mbp\/default@default\.session\.json/);
        has(/^host-sessions: remove quests\/qa\/history\/chat\.session\.json\.tmp/);
        has(/^host-sessions: move quests\/qa\/history\/sessions\/chat\/live-trail\.md -> quests\/qa\/history\/mbp\/sessions\/chat\/live-trail\.md$/);
        has(/^host-sessions: move .*sessions\/default\/rawTurns\.json -> quests\/qa\/history\/mbp\/sessions\/default@default\/rawTurns\.json$/);
        has(/^host-sessions: remove quests\/qa\/history\/sessions\/chat\/trail\/current_prompt\.queue\.user\.md/);
        has(/^host-sessions: remove quests\/qa\/history\/sessions\/\.storage-version$/);
        assert.ok(!details.some((d) => /compacted_history|history\.json|history\.md|anthropic\.(prompts|answers)\.md ->/.test(d)), 'the old session history stays; the pairs are converted, not moved');
        const after = execFileSync('find', ['.', '-type', 'f'], { cwd: s.ai, encoding: 'utf8' }).split('\n').sort();
        assert.deepEqual(after, before, 'nothing written');
        assert.equal(s.read('quests/qa/history/chat.session.json'), JSON.stringify({ mode: 'continue', sessionId: 'S-chat' }));
    });

    test('HS-2 / HS-3: apply on the first host, then nothing', () => {
        const s = sandbox();
        oldQuest(s);
        const { problems } = s.step(true);
        assert.deepEqual(problems, []);
        // The host trail.
        const turns = parseHostTrail(s.read('quests/qa/history/trail.mbp.md'));
        assert.deepEqual(turns.map((t) => [t.id, t.session, t.host, t.time]), [
            ['c1', 'chat', HOST, '2026-11-01T10:00:00.000Z'],
            ['d1', 'default@default', HOST, '2026-11-01T12:00:00.000Z'],
            ['c2', 'chat', HOST, '2026-11-02T10:00:00.000Z'],
        ]);
        assert.equal(turns[0].prompt, 'first chat prompt');
        assert.match(turns[0].answer, /^first chat answer\n\nvariables:\n - TODO = /);
        assert.equal(turns[2].prompt, 'second chat prompt\n\n## a heading');
        assert.equal(turns[2].answer, '', 'a prompt without its answer');
        for (const f of ['sessions/chat/qa.anthropic.prompts.md', 'sessions/chat/qa.anthropic.answers.md', 'sessions/default/qa.anthropic.prompts.md']) {
            assert.equal(s.exists(`quests/qa/history/${f}`), false, `${f} deleted`);
        }
        // The definitions.
        assert.deepEqual(s.json('quests/qa/history/mbp/chat.session.json'), { mode: 'continue', sessionId: 'S-chat', contributesToTrailAndMemory: true });
        assert.equal(s.json('quests/qa/history/mbp/default@default.session.json').sessionId, 'S-def');
        assert.deepEqual(s.json('quests/qa/history/mbp/work.session.json'), { mode: 'continue', basedOn: 'default@default', contributesToTrailAndMemory: false });
        for (const f of ['chat.session.json', 'default.session.json', 'work.session.json', 'chat.session.json.tmp']) {
            assert.equal(s.exists(`quests/qa/history/${f}`), false, `${f} gone`);
        }
        // The storages.
        const n = 'quests/qa/history/mbp/sessions';
        assert.equal(s.read(`${n}/chat/live-trail.md`), '# live\n');
        assert.equal(s.read(`${n}/chat/session-todos.todo.yaml`), 'todos: []\n');
        assert.equal(s.read(`${n}/chat/trail/tool_results/t1.json`), '"r1"');
        assert.equal(s.read(`${n}/chat/trail/20261101_prompt.userprompt.md`), 'raw');
        assert.equal(s.read(`${n}/default@default/rawTurns.json`), '{"rounds":[["q"]]}');
        assert.equal(s.exists(`${n}/chat/trail/current_prompt.queue.user.md`), false);
        assert.equal(s.exists('quests/qa/history/sessions/chat/trail'), false);
        assert.equal(s.exists('quests/qa/history/sessions/default'), false, 'an emptied folder goes');
        assert.equal(s.exists('quests/qa/history/sessions/.storage-version'), false);
        for (const f of ['compacted_history.md', 'history.json', 'history.md']) {
            assert.ok(s.exists(`quests/qa/history/sessions/chat/${f}`), `${f} stays for the first build`);
        }
        assert.deepEqual(fs.readdirSync(path.join(s.ai, 'quests/qa/history/sessions/chat')).sort(), ['compacted_history.md', 'history.json', 'history.md']);
        // HS-3
        assert.deepEqual(s.step(true), { changes: [], problems: [] });
        assert.deepEqual(s.step(false), { changes: [], problems: [] });
    });

    test('HS-4: existing targets', () => {
        const s = sandbox();
        const h = 'quests/qa/history';
        s.write(`${h}/same.session.json`, JSON.stringify({ mode: 'continue' }));
        s.write(`${h}/mbp/same.session.json`, JSON.stringify({ mode: 'continue', contributesToTrailAndMemory: true }));
        s.write(`${h}/other.session.json`, JSON.stringify({ mode: 'continue', sessionId: 'A' }));
        s.write(`${h}/mbp/other.session.json`, JSON.stringify({ mode: 'continue', sessionId: 'B' }));
        s.write(`${h}/sessions/w/same.txt`, 'same');
        s.write(`${h}/mbp/sessions/w/same.txt`, 'same');
        s.write(`${h}/sessions/w/live-trail.md`, '# Live\n\n## 🚀 PROMPT 20261101_100000 a\n\nold\n');
        s.write(`${h}/mbp/sessions/w/live-trail.md`, '# Live\n\n## 🚀 PROMPT 20261102_100000 b\n\nnew\n');
        const oldTail = s.write(`${h}/sessions/w/rawTurns.json`, 'old tail');
        s.write(`${h}/mbp/sessions/w/rawTurns.json`, 'new tail');
        fs.utimesSync(oldTail, new Date('2026-01-01'), new Date('2026-01-01'));
        s.write(`${h}/sessions/w/trail/tool_results/t1.json`, '"old"');
        s.write(`${h}/mbp/sessions/w/trail/tool_results/t1.json`, '"new"');
        s.write(`${h}/sessions/w/notes.txt`, 'a');
        s.write(`${h}/mbp/sessions/w/notes.txt`, 'b');
        const { problems } = s.step(true);
        assert.deepEqual(problems.map((p) => p.detail), [
            'quests/qa/history/other.session.json: quests/qa/history/mbp/other.session.json exists with other content; both kept',
            'quests/qa/history/sessions/w/notes.txt: quests/qa/history/mbp/sessions/w/notes.txt exists with other content, and no merge rule applies; both kept',
        ]);
        assert.equal(s.exists(`${h}/same.session.json`), false, 'identical: the old one goes');
        assert.equal(s.json(`${h}/mbp/other.session.json`).sessionId, 'B');
        assert.equal(s.json(`${h}/other.session.json`).sessionId, 'A');
        assert.equal(s.exists(`${h}/sessions/w/same.txt`), false);
        const live = s.read(`${h}/mbp/sessions/w/live-trail.md`);
        assert.ok(live.indexOf('20261101_100000') >= 0 && live.indexOf('20261101_100000') < live.indexOf('20261102_100000'), 'merged, oldest first');
        assert.equal(s.read(`${h}/mbp/sessions/w/rawTurns.json`), 'new tail', 'the newer copy wins');
        assert.equal(s.read(`${h}/mbp/sessions/w/trail/tool_results/t1.json`), '"new"');
        assert.equal(s.read(`${h}/mbp/sessions/w/trail/tool_results/t2.json`), '"old"', 'the next free number');
        assert.equal(s.read(`${h}/sessions/w/notes.txt`), 'a', 'a problem: kept');
        // Again: only the problems.
        const again = s.step(true);
        assert.deepEqual(again.changes, []);
        assert.equal(again.problems.length, 2);
    });

    test('HS-5: a later host', () => {
        const s = sandbox();
        const h = 'quests/qa/history';
        // mbp moved the definitions; bomber's own storage is still at the old place.
        s.write(`${h}/mbp/walk.session.json`, JSON.stringify({ mode: 'continue', sessionId: 'S-mbp', model: 'reported', iteration: { key: 'k', sessionId: 'S-it' }, createdAt: 't0' }));
        s.write(`${h}/mbp/prof.session.json`, JSON.stringify({ mode: 'continue', sessionId: 'S-p', profileId: 'opus', model: 'claude-opus' }));
        s.write(`${h}/sessions/walk/rawTurns.json`, '[1]');
        s.write(`${h}/sessions/prof/live-trail.md`, '# live\n');
        s.write(`${h}/sessions/lonely/live-trail.md`, '# lonely\n');
        s.write(`${h}/sessions/walk/compacted_history.md`, 'tracked, came with the reconcile');
        const dry = s.step(false, 'bomber');
        assert.ok(dry.changes.some((c) => c.detail === 'copy quests/qa/history/mbp/walk.session.json -> quests/qa/history/bomber/walk.session.json (without its conversation)'));
        assert.ok(dry.changes.some((c) => c.detail === 'storage of lonely moved; no definition (its next prompt writes one)'));
        assert.equal(s.exists(`${h}/bomber`), false, 'a dry run writes nothing');
        const { problems } = s.step(true, 'bomber');
        assert.deepEqual(problems, []);
        assert.deepEqual(s.json(`${h}/bomber/walk.session.json`), { mode: 'continue', createdAt: 't0', contributesToTrailAndMemory: true });
        assert.deepEqual(s.json(`${h}/bomber/prof.session.json`), { mode: 'continue', profileId: 'opus', model: 'claude-opus', contributesToTrailAndMemory: true }, 'a profile\'s model stays');
        assert.equal(s.exists(`${h}/bomber/lonely.session.json`), false);
        assert.equal(s.read(`${h}/bomber/sessions/lonely/live-trail.md`), '# lonely\n');
        assert.equal(s.read(`${h}/bomber/sessions/walk/rawTurns.json`), '[1]');
        assert.equal(s.json(`${h}/mbp/walk.session.json`).sessionId, 'S-mbp', 'the other host\'s file is not touched');
        assert.ok(s.exists(`${h}/sessions/walk/compacted_history.md`));
        assert.deepEqual(s.step(true, 'bomber'), { changes: [], problems: [] });
    });

    test('HS-6: the trail limit and the quest folder\'s pair', () => {
        const s = sandbox();
        const q = path.join(s.ai, 'quests', 'qa');
        // An existing trail of three turns, the first two covered by the history.
        s.write('quests/qa/history/trail.mbp.md', [turn('t1', '2026-11-10T00:00:00.000Z', 'chat'), turn('t2', '2026-11-11T00:00:00.000Z', 'chat'), turn('t3', '2026-11-12T00:00:00.000Z', 'chat')].map(formatHostTrailTurn).join(''));
        s.write('quests/qa/history/history.watermark.json', JSON.stringify({ hosts: { mbp: '2026-11-11T00:00:00.000Z' } }));
        s.write('.config.json', JSON.stringify({ trail: { compact: { maxEntries: 2 } } }));
        s.write('quests/qa/history/qa.anthropic.prompts.md', pair('PROMPT', [['t2', '2026-11-11T00:00:00.000Z', 'dup'], ['o1', '2026-11-01T00:00:00.000Z', 'older']]));
        const out = { changes: [] as Entry[], problems: [] as Entry[] };
        migrateV11HostSessions(s.ctxOf(true, HOST, out, { workspaceConfigPath: path.join(s.ai, '.config.json') }));
        assert.deepEqual(out.problems, []);
        assert.match(out.changes[0].detail, /qa\.anthropic\.prompts\.md: 1 turn\(s\) of session default@default/);
        // o1, t1, t2, t3: over 2, the covered o1, t1, t2 may go — down to 2.
        assert.deepEqual(parseHostTrail(fs.readFileSync(hostTrailFile(q, HOST), 'utf8')).map((t) => t.id), ['t2', 't3']);
        assert.equal(s.exists('quests/qa/history/qa.anthropic.prompts.md'), false);
    });

    test('HS-7: the first build deletes the old session histories', () => {
        const s = sandbox();
        const h = 'quests/qa/history';
        s.write(`${h}/sessions/chat/compacted_history.md`, 'x');
        s.write(`${h}/sessions/chat/history.json`, '{}');
        s.write(`${h}/sessions/chat/history.md`, '#');
        s.write(`${h}/sessions/walk/history.json`, '{}');
        s.write(`${h}/sessions/keep/other.txt`, 'not a history file');
        s.write(`${h}/mbp/sessions/chat/compacted_history.md`, 'y');
        s.write(`${h}/mbp/sessions/chat/rawTurns.json`, '[]');
        const deleted = deleteOldSessionHistories(path.join(s.ai, 'quests', 'qa'), HOST).map((f) => path.relative(s.ai, f).split(path.sep).join('/')).sort();
        assert.deepEqual(deleted, [
            `${h}/mbp/sessions/chat/compacted_history.md`,
            `${h}/sessions/chat/compacted_history.md`, `${h}/sessions/chat/history.json`, `${h}/sessions/chat/history.md`,
            `${h}/sessions/walk/history.json`,
        ]);
        assert.equal(s.exists(`${h}/sessions/chat`), false, 'an emptied folder goes');
        assert.equal(s.exists(`${h}/sessions/walk`), false);
        assert.ok(s.exists(`${h}/sessions/keep/other.txt`), 'another file stays');
        assert.ok(s.exists(`${h}/mbp/sessions/chat/rawTurns.json`));
        fs.rmSync(path.join(s.ai, h, 'sessions', 'keep'), { recursive: true });
        deleteOldSessionHistories(path.join(s.ai, 'quests', 'qa'), HOST);
        assert.equal(s.exists(`${h}/sessions`), false, 'history/sessions/ goes once empty');
    });

    test('HS-8: untrack', () => {
        assert.deepEqual([
            'quests/q/history/sessions/chat/live-trail.md', 'quests/q/live-trail.md', 'quests/q/quest_refresh.q.md',
            'quests/q/history/mbp/sessions/chat/rawTurns.json', 'quests/q/history/compacted_history.md', 'quests/q/history/history.json',
            'quests/q/history/history.md', 'quests/q/history/history.watermark.json',
            'quests/q/history/sessions/chat/compacted_history.md', 'quests/q/history/mbp/chat.session.json', 'quests/q/history/trail.mbp.md',
            'queue/x.yaml', 'quests/q/overview.q.md',
        ].map(isUntrackedKind), [true, true, true, true, true, true, true, true, false, false, false, false, false]);

        const s = sandbox();
        const git = (...args: string[]): string => execFileSync('git', args, { cwd: s.ai, encoding: 'utf8' });
        git('init', '-q');
        git('config', 'user.email', 't@t');
        git('config', 'user.name', 't');
        s.write('quests/q/history/sessions/chat/live-trail.md', 'live');
        s.write('quests/q/history/sessions/chat/compacted_history.md', 'old');
        s.write('quests/q/history/mbp/sessions/chat/rawTurns.json', '[]');
        s.write('quests/q/history/history.json', '{}');
        s.write('quests/q/quest_refresh.q.md', 'r');
        s.write('quests/q/keep.local.md', 'forced on purpose');
        s.write('quests/q/overview.q.md', '# q');
        git('add', '-A');
        git('commit', '-q', '-m', 'old');
        s.write('.gitignore', 'quests/*/history/*/sessions/\nquests/*/history/history.json\nquests/*/quest_refresh.*.md\nquests/*/history/**/live-trail.md\nquests/*/*.local.md\n');
        const run = (apply: boolean) => {
            const out = { changes: [] as Entry[], problems: [] as Entry[] };
            untrackIgnoredV11(s.ctxOf(apply, HOST, out, makeGitUntrack(s.ai)));
            return out;
        };
        const dry = run(false);
        assert.deepEqual(dry.problems, []);
        assert.equal(dry.changes.length, 1);
        assert.match(dry.changes[0].detail, /^untrack 4 file\(s\) .*quests\/q\/history\/history\.json, quests\/q\/history\/mbp\/sessions\/chat\/rawTurns\.json, quests\/q\/history\/sessions\/chat\/live-trail\.md, quests\/q\/quest_refresh\.q\.md$/);
        assert.match(git('ls-files'), /quest_refresh/, 'a dry run untracks nothing');
        const done = run(true);
        assert.deepEqual(done.problems, []);
        assert.match(done.changes[0].detail, /^untracked 4 file\(s\)/);
        const tracked = git('ls-files').split('\n').filter((l) => l).sort();
        assert.deepEqual(tracked, ['quests/q/history/sessions/chat/compacted_history.md', 'quests/q/keep.local.md', 'quests/q/overview.q.md']);
        assert.ok(s.exists('quests/q/quest_refresh.q.md'), 'kept on disk');
        assert.deepEqual(run(true), { changes: [], problems: [] }, 'a second run lists nothing');
        // Without git: nothing reported.
        const none = { changes: [] as Entry[], problems: [] as Entry[] };
        untrackIgnoredV11(s.ctxOf(true, HOST, none));
        assert.deepEqual(none, { changes: [], problems: [] });
    });

    test('HS-9: through migrateAiFormats', () => {
        const s = sandbox();
        s.write('quests/qa/history/rawTurns.json', '[1]');
        s.write('quests/qa/history/compacted_history.md', 'per-quest blocks');
        s.write('quests/qa/history/qa.anthropic.prompts.md', pair('PROMPT', [['p1', '2026-10-01T00:00:00.000Z', 'per-quest prompt']]));
        s.write('quests/qa/history/qa.anthropic.answers.md', pair('ANSWER', [['p1', '2026-10-01T00:00:01.000Z', 'per-quest answer']]));
        s.write('quests/qa/history/chat.session.json', JSON.stringify({ mode: 'fork-from-base', basedOn: 'default' }));
        const opts = { aiRoot: s.ai, hostSlug: HOST, merge: () => undefined, formatVersion: 11, today: '2026-11-25' };
        const dry = migrateAiFormats({ ...opts, apply: false });
        assert.deepEqual(dry.problems, []);
        assert.ok(dry.changes.some((c) => c.step === 'storage' && c.detail === 'move quests/qa/history/rawTurns.json -> quests/qa/history/mbp/sessions/default@default/rawTurns.json'));
        assert.equal(dry.changes.some((c) => /compacted_history\.md/.test(c.detail)), false, 'the quest\'s history stays');
        const res = migrateAiFormats({ ...opts, apply: true });
        assert.deepEqual(res.problems, []);
        assert.equal(s.read('quests/qa/history/mbp/sessions/default@default/rawTurns.json'), '[1]');
        assert.equal(s.read('quests/qa/history/compacted_history.md'), 'per-quest blocks', 'the quest\'s own history, in place');
        const turns = parseHostTrail(s.read('quests/qa/history/trail.mbp.md'));
        assert.deepEqual(turns.map((t) => [t.id, t.session, t.prompt, t.answer]), [['p1', 'default@default', 'per-quest prompt', 'per-quest answer']]);
        assert.deepEqual(s.json('quests/qa/history/mbp/chat.session.json'), { mode: 'per-prompt', basedOn: 'default@default', contributesToTrailAndMemory: true });
        assert.equal(s.exists('quests/qa/history/qa.anthropic.prompts.md'), false);
        assert.equal(s.exists('quests/qa/history/mbp/sessions/default@default/qa.anthropic.prompts.md'), false);
        assert.match(s.read('format-version.yaml'), /version: 11/);
        const again = migrateAiFormats({ ...opts, apply: true });
        assert.deepEqual(again, { changes: [], problems: [] });
    });

    test('HS-10: a quest history already built stays where it is', () => {
        const s = sandbox();
        s.write('quests/qa/history/compacted_history.md', 'the quest\'s own history');
        s.write('quests/qa/history/history.json', '{}');
        s.write('quests/qa/history/history.watermark.json', '{"hosts":{}}');
        const res = migrateAiFormats({ aiRoot: s.ai, hostSlug: HOST, merge: () => undefined, formatVersion: 11, today: '2026-11-25', apply: true });
        assert.deepEqual(res.problems, []);
        assert.equal(s.read('quests/qa/history/compacted_history.md'), 'the quest\'s own history');
        assert.ok(s.exists('quests/qa/history/history.json'));
    });
});
