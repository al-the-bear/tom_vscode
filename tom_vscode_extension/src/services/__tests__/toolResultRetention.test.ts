/**
 * The stored tool results' retention (vscimpb49, src/services/tool-result-store.ts): every tool call of a session
 * is stored as `history/sessions/<session>/trail/tool_results/t<n>.json`; after each send the oldest are pruned.
 *
 *   TR-1 by count: a folder holding more than the per-session maximum keeps the newest; the oldest go; the
 *        marker records every key up to the last pruned; a second run prunes nothing
 *   TR-2 by age: results older than the days given go, from the oldest on; a young one ends it; the marker grows
 *   TR-3 nothing due: nothing pruned, no marker; 0 switches a limit off
 *   TR-4 a pruned key is never given out again: the next key continues past the marker, also when every file went
 *   TR-5 a whole quest: every session's folder (the backlog too) is pruned in one run; a pruned key is reported as
 *        pruned (prunedToolResultInfo), a stored one is not, a key past the marker is not
 *   TR-6 tomAi_readPastToolResult answers a pruned key with 'pruned by retention' (also with `sessions`), and an
 *        unknown key with 'not found' as before
 *   TR-7 the wiring: the defaults (30 days, 1000) and the configured values; the handler prunes after each send;
 *        the Status Page edits both limits
 */

import test, { after, describe } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'fs';
import * as path from 'path';

const EXT = path.resolve(__dirname, '..', '..', '..');
const SANDBOX = fs.realpathSync(fs.mkdtempSync(path.join(EXT, '..', '..', '..', 'ztmp', 'vscode_extension_261111_vscimpb49_retention-')));
const WS = path.join(SANDBOX, 'ws');
const QUEST = 'q1';
fs.mkdirSync(path.join(WS, '_ai', 'quests', QUEST), { recursive: true });
fs.writeFileSync(path.join(WS, '_ai', 'quests', QUEST, `overview.${QUEST}.md`), '# Q1\n');

import { installVscodeStub } from '../../tools/__tests__/_vscode-stub.js';
const stub = installVscodeStub({ workspaceFolders: [WS] });
(stub.stub.workspace as Record<string, unknown>).workspaceFile = { fsPath: path.join(WS, `${QUEST}.code-workspace`), scheme: 'file' };

import {
    DEFAULT_TOOL_RESULT_RETENTION, configuredToolResultRetention, pruneQuestToolResults, pruneToolResultFolder,
    prunedToolResultInfo, readToolResult, toolResultFolder,
} from '../tool-result-store.js';
import { TOOL_RESULT_RETENTION_MARKER, nextFreeToolResultIndex, readToolResultRetentionMarker } from '../sessionStorage.js';
import { readPastToolResultImpl, type ToolHistoryAccess } from '../../tools/past-tool-access-tools.js';

after(() => { stub.restore(); fs.rmSync(SANDBOX, { recursive: true, force: true }); });

const DAY = 24 * 60 * 60 * 1000;
const NOW = Date.parse('2026-11-11T12:00:00Z');

/** A folder with results t<from>..t<to>, each `ageDays(n)` old. */
function fill(folder: string, from: number, to: number, ageDays: (n: number) => number = () => 1): void {
    fs.mkdirSync(folder, { recursive: true });
    for (let n = from; n <= to; n++) {
        const file = path.join(folder, `t${n}.json`);
        fs.writeFileSync(file, JSON.stringify({ key: `t${n}`, timestamp: '', round: 1, toolName: 'x', inputSummary: '', result: `r${n}`, durationMs: 1 }));
        const t = new Date(NOW - ageDays(n) * DAY);
        fs.utimesSync(file, t, t);
    }
}
const keysIn = (folder: string): number[] => fs.readdirSync(folder).map((n) => /^t(\d+)\.json$/.exec(n)).filter((m): m is RegExpExecArray => !!m).map((m) => Number(m[1])).sort((a, b) => a - b);
let dirs = 0;
const freshDir = (): string => path.join(SANDBOX, `f${++dirs}`);

describe('stored tool results: retention', () => {
    test('TR-1: by count', () => {
        const dir = freshDir();
        fill(dir, 1, 1200);
        const r = pruneToolResultFolder(dir, { maxAgeDays: 30, maxPerSession: 1000 }, NOW);
        assert.deepEqual([r.pruned, r.kept, r.prunedThrough], [200, 1000, 200]);
        const left = keysIn(dir);
        assert.deepEqual([left[0], left.at(-1), left.length], [201, 1200, 1000], 'the newest are kept');
        assert.equal(readToolResultRetentionMarker(dir)?.prunedThrough, 200);
        assert.deepEqual(pruneToolResultFolder(dir, { maxAgeDays: 30, maxPerSession: 1000 }, NOW).pruned, 0, 'a second run: nothing');
    });

    test('TR-2: by age', () => {
        const dir = freshDir();
        fill(dir, 1, 10, (n) => (n <= 4 ? 40 : n === 5 ? 31 : 2));
        const r = pruneToolResultFolder(dir, { maxAgeDays: 30, maxPerSession: 1000 }, NOW);
        assert.deepEqual([r.pruned, r.prunedThrough], [5, 5]);
        assert.deepEqual(keysIn(dir), [6, 7, 8, 9, 10]);
        // Later: more turn old; the marker grows.
        const later = pruneToolResultFolder(dir, { maxAgeDays: 1, maxPerSession: 1000 }, NOW);
        assert.equal(later.prunedThrough, 10);
        assert.deepEqual(keysIn(dir), []);
        const marker = JSON.parse(fs.readFileSync(path.join(dir, TOOL_RESULT_RETENTION_MARKER), 'utf8'));
        assert.deepEqual([marker.prunedThrough, marker.maxAgeDays, marker.maxPerSession, marker.prunedAt], [10, 1, 1000, new Date(NOW).toISOString()]);
    });

    test('TR-3: nothing due, limits off', () => {
        const dir = freshDir();
        fill(dir, 1, 20, () => 100);
        assert.equal(pruneToolResultFolder(dir, { maxAgeDays: 0, maxPerSession: 0 }, NOW).pruned, 0, 'both off');
        assert.equal(pruneToolResultFolder(dir, { maxAgeDays: 0, maxPerSession: 50 }, NOW).pruned, 0, 'under the count, no age limit');
        assert.equal(fs.existsSync(path.join(dir, TOOL_RESULT_RETENTION_MARKER)), false, 'no marker');
        assert.equal(pruneToolResultFolder(path.join(SANDBOX, 'missing'), DEFAULT_TOOL_RESULT_RETENTION, NOW).pruned, 0, 'no folder');
    });

    test('TR-4: a pruned key is never given out again', () => {
        const dir = freshDir();
        fill(dir, 1, 30, () => 60);
        pruneToolResultFolder(dir, { maxAgeDays: 30, maxPerSession: 1000 }, NOW);
        assert.deepEqual(keysIn(dir), []);
        assert.equal(nextFreeToolResultIndex(dir), 31, 'past the marker, though no file is left');
        fill(dir, 31, 32);
        assert.equal(nextFreeToolResultIndex(dir), 33);
    });

    test('TR-5: a whole quest', () => {
        const a = toolResultFolder('anthropic', QUEST, 'work');
        const b = toolResultFolder('anthropic', QUEST, 'chat');
        assert.ok(a.includes(path.join('history', 'sessions', 'work', 'trail', 'tool_results')), a);
        fill(a, 1, 1500, (n) => (n <= 100 ? 90 : 1));
        fill(b, 1, 50, () => 1);
        const runs = pruneQuestToolResults(QUEST, { maxAgeDays: 30, maxPerSession: 1000 }, NOW);
        assert.deepEqual(runs.map((r) => [path.basename(path.dirname(path.dirname(r.folder))), r.pruned]), [['work', 500]], 'only what is due');
        assert.deepEqual([keysIn(a).length, keysIn(b).length], [1000, 50]);
        assert.ok(prunedToolResultInfo('t3', QUEST, 'work'), 't3 was pruned');
        assert.equal(prunedToolResultInfo('t1200', QUEST, 'work'), undefined, 'a stored one');
        assert.ok(readToolResult('anthropic', 't1200', QUEST, 'work'));
        assert.equal(prunedToolResultInfo('t9999', QUEST, 'work'), undefined, 'past the marker');
        assert.equal(prunedToolResultInfo('t3', QUEST, 'chat'), undefined, 'another session: nothing pruned there');
    });

    test('TR-6: tomAi_readPastToolResult', async () => {
        const info = { prunedAt: '2026-11-11T12:00:00.000Z', maxAgeDays: 30, maxPerSession: 1000 };
        const access: ToolHistoryAccess = {
            listRingBuffer: () => [],
            ringBufferCapacity: () => 40,
            readFromDisk: () => undefined,
            knownSessions: () => ['work', 'chat'],
            callerSession: () => 'work',
            listStoredResults: () => [],
            prunedInfo: (key, session) => (key === 't3' && (session === undefined || session === 'work') ? info : undefined),
        };
        const pruned = JSON.parse(await readPastToolResultImpl(access, { key: '3' }));
        assert.equal(pruned.ok, false);
        assert.equal(pruned.pruned, true);
        assert.match(pruned.error, /The past tool result "t3" was pruned by retention \(2026-11-11T12:00:00\.000Z\): stored results older than 30 days or beyond the newest 1000 per session are removed/);
        const viaSessions = JSON.parse(await readPastToolResultImpl(access, { key: 't3', sessions: ['work'] } as never));
        assert.match(viaSessions.error, /"t3" of session work was pruned by retention/);
        const unknown = JSON.parse(await readPastToolResultImpl(access, { key: 't77' }));
        assert.match(unknown.error, /No past tool result with key "t77"/);
        assert.equal(unknown.pruned, undefined);
    });

    test('TR-7: the wiring', () => {
        assert.deepEqual(DEFAULT_TOOL_RESULT_RETENTION, { maxAgeDays: 30, maxPerSession: 1000 });
        assert.deepEqual(configuredToolResultRetention(), DEFAULT_TOOL_RESULT_RETENTION, 'not configured: the defaults');
        const src = (...p: string[]): string => fs.readFileSync(path.join(EXT, ...p), 'utf8');
        const handler = src('src', 'handlers', 'anthropic-handler.ts');
        assert.match(handler, /return await runAsAskOwner\(\(\) => this\.sendMessageOwned\(options\)\);\n\s+\} finally \{[\s\S]{0,300}scheduleToolResultRetention\(\);/, 'after each send');
        assert.match(handler, /store\.pruneQuestToolResults\(undefined\)/);
        const page = src('src', 'handlers', 'statusPage-handler.ts');
        assert.match(page, /id="sp-trailToolResultsMaxAgeDays"/);
        assert.match(page, /id="sp-trailToolResultsMaxPerSession"/);
        assert.match(page, /stcConfig\.trail\.toolResultsMaxAgeDays = message\.toolResultsMaxAgeDays/);
        assert.match(page, /stcConfig\.trail\.toolResultsMaxPerSession = message\.toolResultsMaxPerSession/);
        assert.match(src('media', 'statusPage', 'listeners.js'), /msgData\.toolResultsMaxAgeDays = parseInt/);
        const schema = JSON.parse(src('src', 'config', 'tom_vscode_extension.schema.json'));
        assert.match(JSON.stringify(schema), /"toolResultsMaxAgeDays":\{"type":"integer","minimum":0,"default":30/);
    });
});
