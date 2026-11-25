/**
 * Per-session storage (src/services/sessionStorage.ts).
 *
 *   SS-1 every artefact of a session is under its own root, this host's `history/<host>/sessions/<name>/`: history
 *        files, live trail, raw trail with its categories, tool results; the summary pair of an older build and the
 *        memory folder are at their old places; two sessions (and `chat` / `default`) never share a path
 *   SS-7 the old place `history/sessions/<name>/`: a session folder there is read and written there; a folder at the
 *        new place wins; a session at neither is made at the new place; the listing names both places' sessions;
 *        removing a session removes it at both places
 *   SS-2 tool-result keys continue past what a session stored: a second ToolTrail (a reload, a clear) and another
 *        session never overwrite a stored result
 *   SS-3 removing a session removes its whole storage and its memory, nothing of another session
 *   SS-4 the migration of a quest in the per-quest layout: history files, the Anthropic pair, the live trail, the
 *        raw trail and the quest memory become the `default@default` session's; Local LLM and other subsystems' files stay;
 *        the current-prompt and last-request files stay where the Logs tab reads them; a second run does nothing;
 *        a file whose target exists stays (named)
 *   SS-6 the bare `default` session becomes `default@default` (vscimpb151): its session file, storage root and
 *        quest memory move (into what is there entry by entry, an existing file kept and named), the sessions
 *        based on it are rebased, the path helpers read `default` as `default@default`; a second run does nothing
 *   SS-5 the .gitignore rules: a host's session storage, the quest's derived history, the refresh notes and every
 *        live trail are ignored, as the old place's machine-local files; the session files of a host, the host
 *        trails and the old place's compacted history are not (checked with git itself)
 */

import test, { describe } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import {
    SESSION_STORAGE_GITIGNORE_RULES,
    migrateDefaultSessionName,
    migrateQuestToSessionStorage,
    nextFreeToolResultIndex,
    removeSessionStorage,
    sessionLiveTrailFile,
    sessionMemoryFolder,
    sessionRoot,
    sessionSummaryFile,
    sessionToolResultsFolder,
    sessionTrailFolder,
    sessionsWithStorage,
} from '../sessionStorage.js';
import { ToolTrail } from '../tool-trail.js';
import { hostSlugOf } from '../../utils/hostSlug.js';

const HOST = hostSlugOf();

function tmp(): string {
    return fs.mkdtempSync(path.join(os.tmpdir(), 'session-storage-'));
}

function put(file: string, text = 'x'): void {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, text);
}

function pathsOf(root: string, memoryRoot: string, session: string): string[] {
    return [
        sessionRoot(root, session),
        sessionSummaryFile(root, session, 'q', 'anthropic', 'prompts'),
        sessionSummaryFile(root, session, 'q', 'anthropic', 'answers'),
        sessionLiveTrailFile(root, session),
        sessionTrailFolder(root, session),
        sessionTrailFolder(root, session, 'compaction'),
        sessionTrailFolder(root, session, 'memory'),
        sessionToolResultsFolder(root, session),
        sessionMemoryFolder(memoryRoot, 'q', session),
    ];
}

describe('per-session storage', () => {
    test('SS-1: one root per session', () => {
        const root = path.join('ai', 'quests', 'q', 'history');
        const mem = path.join('ai', 'memory');
        const at = path.join(root, HOST, 'sessions', 'walk');
        assert.deepEqual(pathsOf(root, mem, 'walk'), [
            at,
            path.join(root, 'sessions', 'walk', 'q.anthropic.prompts.md'),
            path.join(root, 'sessions', 'walk', 'q.anthropic.answers.md'),
            path.join(at, 'live-trail.md'),
            path.join(at, 'trail'),
            path.join(at, 'trail', 'compaction'),
            path.join(at, 'trail', 'memory'),
            path.join(at, 'trail', 'tool_results'),
            path.join(mem, 'q', 'walk'),
        ]);
        const sessions = ['chat', 'default', 'walk', 'prep'];
        for (const a of sessions) {
            for (const b of sessions) {
                if (a === b) { continue; }
                const theirs = new Set(pathsOf(root, mem, b));
                assert.deepEqual(pathsOf(root, mem, a).filter((p) => theirs.has(p)), [], `${a} and ${b} share nothing`);
            }
        }
        const real = tmp();
        fs.mkdirSync(sessionRoot(real, 'walk'), { recursive: true });
        fs.mkdirSync(sessionRoot(real, 'chat'), { recursive: true });
        put(path.join(real, 'sessions', '.storage-version'), '2');
        assert.deepEqual(sessionsWithStorage(real), ['chat', 'walk'], 'folders only');
        assert.deepEqual(sessionsWithStorage(path.join(real, 'none')), []);
    });

    test('SS-7: the old place', () => {
        const root = tmp();
        // A session whose folder is at the old place: read and written there.
        const old = path.join(root, 'sessions', 'walk');
        put(path.join(old, 'live-trail.md'), 'old');
        assert.equal(sessionRoot(root, 'walk'), old);
        assert.equal(sessionLiveTrailFile(root, 'walk'), path.join(old, 'live-trail.md'));
        assert.equal(sessionTrailFolder(root, 'walk'), path.join(old, 'trail'));
        // A new session: the new place.
        assert.equal(sessionRoot(root, 'fresh'), path.join(root, HOST, 'sessions', 'fresh'));
        fs.mkdirSync(sessionRoot(root, 'fresh'), { recursive: true });
        // Both places: the new place wins.
        fs.mkdirSync(path.join(root, 'sessions', 'fresh'), { recursive: true });
        assert.equal(sessionRoot(root, 'fresh'), path.join(root, HOST, 'sessions', 'fresh'));
        fs.mkdirSync(path.join(root, HOST, 'sessions', 'walk'), { recursive: true });
        assert.equal(sessionRoot(root, 'walk'), path.join(root, HOST, 'sessions', 'walk'), 'once the new place has it');
        // The listing names both places' sessions, each once.
        put(path.join(root, 'sessions', 'only-old', 'live-trail.md'));
        assert.deepEqual(sessionsWithStorage(root), ['fresh', 'only-old', 'walk']);
        // Removing removes both places.
        removeSessionStorage(root, tmp(), 'q', 'walk');
        assert.equal(fs.existsSync(old), false);
        assert.equal(fs.existsSync(path.join(root, HOST, 'sessions', 'walk')), false);
        assert.deepEqual(sessionsWithStorage(root), ['fresh', 'only-old']);
        fs.rmSync(root, { recursive: true, force: true });
    });

    test('SS-2: tool-result keys are never reused', () => {
        const root = tmp();
        const folderOf = (session: string): string => sessionToolResultsFolder(root, session);
        const trailFor = (session: string): ToolTrail => {
            const trail = new ToolTrail({ session, firstFreeKeyIndex: () => nextFreeToolResultIndex(folderOf(session)) });
            trail.setPersistHook((e) => put(path.join(folderOf(session), `${e.key}.json`), JSON.stringify(e)));
            return trail;
        };
        const entry = (n: number) => ({ timestamp: '12:00:00', round: 1, toolName: 'tomAi_readFile', inputSummary: `call ${n}`, result: `result ${n}`, durationMs: 1 });
        const first = trailFor('walk');
        assert.deepEqual([first.add(entry(1)).key, first.add(entry(2)).key], ['t1', 't2']);
        const reloaded = trailFor('walk');
        assert.equal(reloaded.add(entry(3)).key, 't3', 'a new trail continues past the stored results');
        reloaded.clear();
        assert.equal(reloaded.add(entry(4)).key, 't4', 'so does a cleared one');
        assert.equal(JSON.parse(fs.readFileSync(path.join(folderOf('walk'), 't1.json'), 'utf8')).inputSummary, 'call 1', 't1 is still the first result');
        const other = trailFor('chat');
        assert.equal(other.add(entry(5)).key, 't1', 'another session has its own keys ...');
        assert.equal(JSON.parse(fs.readFileSync(path.join(folderOf('walk'), 't1.json'), 'utf8')).inputSummary, 'call 1', '... in its own folder');
        assert.equal(nextFreeToolResultIndex(path.join(root, 'nothing')), 1);
        assert.equal(other.session, 'chat');
    });

    test('SS-3: removing a session', () => {
        const root = tmp();
        const mem = tmp();
        for (const s of ['tmp-261027-120000-a1', 'walk']) {
            put(sessionLiveTrailFile(root, s));
            put(path.join(sessionToolResultsFolder(root, s), 't1.json'));
            put(path.join(sessionMemoryFolder(mem, 'q', s), 'facts.md'));
        }
        removeSessionStorage(root, mem, 'q', 'tmp-261027-120000-a1');
        assert.equal(fs.existsSync(sessionRoot(root, 'tmp-261027-120000-a1')), false);
        assert.equal(fs.existsSync(sessionMemoryFolder(mem, 'q', 'tmp-261027-120000-a1')), false);
        assert.equal(fs.existsSync(sessionLiveTrailFile(root, 'walk')), true, 'another session keeps everything');
        assert.equal(fs.existsSync(path.join(sessionMemoryFolder(mem, 'q', 'walk'), 'facts.md')), true);
    });

    test('SS-4: the migration of a quest', () => {
        const ai = tmp();
        const questFolder = path.join(ai, 'quests', 'q');
        const historyRoot = path.join(questFolder, 'history');
        const memoryRoot = path.join(ai, 'memory');
        const rawTrailFolder = path.join(ai, 'trail', 'anthropic', 'q');
        const legacy = {
            [path.join(historyRoot, 'compacted_history.md')]: 'blocks',
            [path.join(historyRoot, 'rawTurns.json')]: 'tail',
            [path.join(historyRoot, 'compaction_rounds.json')]: 'acc',
            [path.join(historyRoot, 'history.json')]: 'snap',
            [path.join(historyRoot, 'history.md')]: 'snap md',
            [path.join(historyRoot, '20261027_120000.history.json')]: 'archive',
            [path.join(historyRoot, 'q.anthropic.prompts.md')]: 'prompts',
            [path.join(historyRoot, 'q.anthropic.answers.md')]: 'answers',
            [path.join(questFolder, 'live-trail.md')]: 'live',
            [path.join(rawTrailFolder, '20261027_120000000_prompt_r1.userprompt.md')]: 'raw',
            [path.join(rawTrailFolder, 'compaction', 'c1.md')]: 'compaction',
            [path.join(rawTrailFolder, 'tool_results', 't7.json')]: 'tool',
            [path.join(memoryRoot, 'q', 'facts.md')]: 'facts',
        };
        const staying = {
            [path.join(historyRoot, 'history-gemma4-bomber.json')]: 'local llm snapshot',
            [path.join(historyRoot, 'q.copilot.prompts.md')]: 'copilot pair',
            [path.join(historyRoot, 'q.localllm-gemma.answers.md')]: 'local llm pair',
            [path.join(historyRoot, 'walk.session.json')]: '{}',
            [path.join(questFolder, 'live-trail-localLLM.md')]: 'local live',
            [path.join(questFolder, 'overview.q.md')]: 'overview',
            [path.join(rawTrailFolder, 'current_prompt.queue.user.md')]: 'current',
            [path.join(rawTrailFolder, 'last_request.json')]: '{}',
            [path.join(memoryRoot, 'shared', 'facts.md')]: 'shared',
        };
        for (const [f, t] of Object.entries({ ...legacy, ...staying })) { put(f, t); }
        const layout = { quest: 'q', questFolder, historyRoot, memoryRoot, rawTrailFolder };
        const report = migrateQuestToSessionStorage(layout);
        assert.equal(report.migrated, true);
        assert.deepEqual(report.kept, []);
        const def = sessionRoot(historyRoot, 'default');
        const moved = {
            'compacted_history.md': 'blocks', 'rawTurns.json': 'tail', 'compaction_rounds.json': 'acc', 'history.json': 'snap',
            'history.md': 'snap md', '20261027_120000.history.json': 'archive', 'q.anthropic.prompts.md': 'prompts',
            'q.anthropic.answers.md': 'answers', 'live-trail.md': 'live',
            'trail/20261027_120000000_prompt_r1.userprompt.md': 'raw', 'trail/compaction/c1.md': 'compaction', 'trail/tool_results/t7.json': 'tool',
        };
        for (const [rel, text] of Object.entries(moved)) {
            assert.equal(fs.readFileSync(path.join(def, rel), 'utf8'), text, rel);
        }
        assert.equal(fs.readFileSync(path.join(memoryRoot, 'q', 'default@default', 'facts.md'), 'utf8'), 'facts', 'the default run\'s default session (vscimpb151)');
        for (const f of Object.keys(legacy)) { assert.equal(fs.existsSync(f), false, `moved away: ${f}`); }
        for (const [f, t] of Object.entries(staying)) { assert.equal(fs.readFileSync(f, 'utf8'), t, `stays: ${f}`); }
        assert.equal(report.moved.length, Object.keys(legacy).length, 'one move each (the raw trail\'s folders move as folders)');

        // Idempotent: the marker stops a second run, even with a new legacy file.
        put(path.join(questFolder, 'live-trail.md'), 'written by an older build');
        assert.deepEqual(migrateQuestToSessionStorage(layout), { migrated: false, moved: [], kept: [] });
        assert.equal(fs.readFileSync(path.join(def, 'live-trail.md'), 'utf8'), 'live');

        // Without the marker (another machine), an existing target is not overwritten.
        fs.rmSync(path.join(historyRoot, 'sessions', '.storage-version'));
        const again = migrateQuestToSessionStorage(layout);
        assert.deepEqual(again.kept, [path.join(questFolder, 'live-trail.md')]);
        assert.equal(fs.readFileSync(path.join(def, 'live-trail.md'), 'utf8'), 'live', 'not overwritten');

        // A quest that never had files: only the marker.
        const empty = path.join(ai, 'quests', 'e');
        const none = migrateQuestToSessionStorage({ quest: 'e', questFolder: empty, historyRoot: path.join(empty, 'history'), memoryRoot, rawTrailFolder: path.join(ai, 'trail', 'anthropic', 'e') });
        assert.deepEqual([none.migrated, none.moved], [true, []]);
    });

    test('SS-6: the bare default session becomes default@default', () => {
        const ai = tmp();
        const historyRoot = path.join(ai, 'quests', 'q', 'history');
        const memoryRoot = path.join(ai, 'memory');
        put(path.join(historyRoot, 'default.session.json'), JSON.stringify({ sessionId: 'abc', model: 'm' }));
        put(path.join(historyRoot, 'work.session.json'), JSON.stringify({ mode: 'continue', basedOn: 'default' }));
        put(path.join(historyRoot, 'other.session.json'), JSON.stringify({ mode: 'continue', basedOn: 'work' }));
        put(path.join(historyRoot, 'sessions', 'default', 'live-trail.md'), 'old live');
        put(path.join(historyRoot, 'sessions', 'default', 'trail', 'tool_results', 't1.json'), 'tool');
        put(path.join(historyRoot, 'sessions', 'default', 'history.md'), 'old history');
        // Something of the new name already there (another machine, an earlier start): kept.
        put(path.join(historyRoot, 'sessions', 'default@default', 'history.md'), 'new history');
        put(path.join(memoryRoot, 'q', 'default', 'facts.md'), 'facts');

        const report = migrateDefaultSessionName({ quest: 'q', historyRoot, memoryRoot });
        assert.equal(report.migrated, true);
        assert.equal(JSON.parse(fs.readFileSync(path.join(historyRoot, 'default@default.session.json'), 'utf8')).sessionId, 'abc');
        assert.equal(fs.existsSync(path.join(historyRoot, 'default.session.json')), false);
        const root = path.join(historyRoot, 'sessions', 'default@default');
        assert.equal(fs.readFileSync(path.join(root, 'live-trail.md'), 'utf8'), 'old live');
        assert.equal(fs.readFileSync(path.join(root, 'trail', 'tool_results', 't1.json'), 'utf8'), 'tool');
        assert.equal(fs.readFileSync(path.join(root, 'history.md'), 'utf8'), 'new history', 'an existing file is kept');
        assert.deepEqual(report.kept, [path.join(historyRoot, 'sessions', 'default', 'history.md')], 'and named');
        assert.equal(fs.readFileSync(path.join(historyRoot, 'sessions', 'default', 'history.md'), 'utf8'), 'old history', 'the kept file stays where it was');
        assert.equal(fs.readFileSync(path.join(memoryRoot, 'q', 'default@default', 'facts.md'), 'utf8'), 'facts');
        assert.equal(JSON.parse(fs.readFileSync(path.join(historyRoot, 'work.session.json'), 'utf8')).basedOn, 'default@default', 'rebased');
        assert.equal(JSON.parse(fs.readFileSync(path.join(historyRoot, 'other.session.json'), 'utf8')).basedOn, 'work', 'another base kept');
        // The path helpers read a bare default as default@default.
        assert.equal(sessionRoot(historyRoot, 'default'), root);
        assert.equal(sessionMemoryFolder(memoryRoot, 'q', 'default'), path.join(memoryRoot, 'q', 'default@default'));
        // Again: only the kept file is still there; nothing moves.
        fs.rmSync(path.join(historyRoot, 'sessions', 'default'), { recursive: true, force: true });
        const again = migrateDefaultSessionName({ quest: 'q', historyRoot, memoryRoot });
        assert.deepEqual([again.migrated, again.moved, again.kept, again.rebased], [false, [], [], []]);
        fs.rmSync(ai, { recursive: true, force: true });
    });

    test('SS-5: what git tracks', () => {
        const repo = tmp();
        execFileSync('git', ['init', '-q'], { cwd: repo });
        fs.writeFileSync(path.join(repo, '.gitignore'), SESSION_STORAGE_GITIGNORE_RULES.join('\n') + '\n');
        const ignored = (rel: string): boolean => {
            try { execFileSync('git', ['check-ignore', '-q', rel], { cwd: repo }); return true; } catch { return false; }
        };
        const s = 'quests/q/history/sessions/walk';
        const h = 'quests/q/history/mbp';
        for (const rel of [`${s}/compacted_history.md`, `${s}/history.json`, `${s}/history.md`, 'memory/q/walk/facts.md',
            `${h}/walk.session.json`, 'quests/q/history/trail.mbp.md', 'quests/q/qa.mbp.q.md', 'quests/q/overview.q.md']) {
            assert.equal(ignored(rel), false, `tracked: ${rel}`);
        }
        for (const rel of [`${s}/rawTurns.json`, `${s}/compaction_rounds.json`, `${s}/iteration.json`, `${s}/q.anthropic.prompts.md`,
            `${s}/q.anthropic.answers.md`, `${s}/trail/x.userprompt.md`, `${s}/trail/tool_results/t1.json`, 'quests/q/history/sessions/.storage-version',
            `${s}/live-trail.md`, `${h}/sessions/walk/live-trail.md`, `${h}/sessions/walk/rawTurns.json`, `${h}/sessions/walk/session-todos.todo.yaml`,
            'quests/q/history/compacted_history.md', 'quests/q/history/history.json', 'quests/q/history/history.md',
            'quests/q/history/history.watermark.json', 'quests/q/quest_refresh.q.md']) {
            assert.equal(ignored(rel), true, `ignored: ${rel}`);
        }
    });
});
