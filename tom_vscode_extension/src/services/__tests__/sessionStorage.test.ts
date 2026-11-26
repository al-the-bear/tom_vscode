/**
 * Per-session storage (src/services/sessionStorage.ts).
 *
 *   SS-1 every artefact of a session is under its own root, this host's `history/<host>/sessions/<name>/`: history
 *        files, live trail, raw trail with its categories, tool results; two sessions (and `chat` / `default`) never
 *        share a path
 *   SS-7 only this host's place: a folder `history/sessions/<name>/` (the old session history the `_ai` format
 *        migration leaves) is neither a session's root nor listed, and removing a session leaves it
 *   SS-2 tool-result keys continue past what a session stored: a second ToolTrail (a reload, a clear) and another
 *        session never overwrite a stored result
 *   SS-3 removing a session removes its whole storage, nothing of another session
 *   SS-5 the .gitignore rules: a host's session storage, the quest's derived history, the refresh notes and every
 *        live trail are ignored; the session files of a host, the host trails and the old place's session history
 *        are not (checked with git itself)
 */

import test, { describe } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import {
    SESSION_STORAGE_GITIGNORE_RULES,
    nextFreeToolResultIndex,
    removeSessionStorage,
    sessionLiveTrailFile,
    sessionRoot,
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

function pathsOf(root: string, session: string): string[] {
    return [
        sessionRoot(root, session),
        sessionLiveTrailFile(root, session),
        sessionTrailFolder(root, session),
        sessionTrailFolder(root, session, 'compaction'),
        sessionTrailFolder(root, session, 'memory'),
        sessionToolResultsFolder(root, session),
    ];
}

describe('per-session storage', () => {
    test('SS-1: one root per session', () => {
        const root = path.join('ai', 'quests', 'q', 'history');
        const at = path.join(root, HOST, 'sessions', 'walk');
        assert.deepEqual(pathsOf(root, 'walk'), [
            at,
            path.join(at, 'live-trail.md'),
            path.join(at, 'trail'),
            path.join(at, 'trail', 'compaction'),
            path.join(at, 'trail', 'memory'),
            path.join(at, 'trail', 'tool_results'),
        ]);
        const sessions = ['chat', 'default', 'walk', 'prep'];
        for (const a of sessions) {
            for (const b of sessions) {
                if (a === b) { continue; }
                const theirs = new Set(pathsOf(root, b));
                assert.deepEqual(pathsOf(root, a).filter((p) => theirs.has(p)), [], `${a} and ${b} share nothing`);
            }
        }
        const real = tmp();
        fs.mkdirSync(sessionRoot(real, 'walk'), { recursive: true });
        fs.mkdirSync(sessionRoot(real, 'chat'), { recursive: true });
        put(path.join(real, 'sessions', '.storage-version'), '2');
        assert.deepEqual(sessionsWithStorage(real), ['chat', 'walk'], 'folders only');
        assert.deepEqual(sessionsWithStorage(path.join(real, 'none')), []);
    });

    test('SS-7: only this host\'s place', () => {
        const root = tmp();
        // The old session history the format migration leaves for the quest history's first build.
        const old = path.join(root, 'sessions', 'walk');
        put(path.join(old, 'compacted_history.md'), 'old');
        assert.equal(sessionRoot(root, 'walk'), path.join(root, HOST, 'sessions', 'walk'));
        assert.equal(sessionLiveTrailFile(root, 'walk'), path.join(root, HOST, 'sessions', 'walk', 'live-trail.md'));
        assert.deepEqual(sessionsWithStorage(root), [], 'the old folder is no session storage');
        fs.mkdirSync(sessionRoot(root, 'walk'), { recursive: true });
        assert.deepEqual(sessionsWithStorage(root), ['walk']);
        removeSessionStorage(root, 'walk');
        assert.equal(fs.existsSync(path.join(root, HOST, 'sessions', 'walk')), false);
        assert.equal(fs.readFileSync(path.join(old, 'compacted_history.md'), 'utf8'), 'old', 'the old session history stays');
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
        for (const s of ['tmp-261027-120000-a1', 'walk']) {
            put(sessionLiveTrailFile(root, s));
            put(path.join(sessionToolResultsFolder(root, s), 't1.json'));
        }
        removeSessionStorage(root, 'tmp-261027-120000-a1');
        assert.equal(fs.existsSync(sessionRoot(root, 'tmp-261027-120000-a1')), false);
        assert.equal(fs.existsSync(sessionLiveTrailFile(root, 'walk')), true, 'another session keeps everything');
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
        for (const rel of [`${s}/live-trail.md`, `${h}/sessions/walk/live-trail.md`, `${h}/sessions/walk/trail/tool_results/t1.json`,
            `${h}/sessions/.storage-version`, `${h}/sessions/walk/rawTurns.json`, `${h}/sessions/walk/session-todos.todo.yaml`,
            'quests/q/history/compacted_history.md', 'quests/q/history/history.json', 'quests/q/history/history.md',
            'quests/q/history/history.watermark.json', 'quests/q/quest_refresh.q.md']) {
            assert.equal(ignored(rel), true, `ignored: ${rel}`);
        }
    });
});
