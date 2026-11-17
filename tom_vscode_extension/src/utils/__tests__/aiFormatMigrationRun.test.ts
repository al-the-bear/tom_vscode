/**
 * Running the `_ai` format migration from the extension (utils/aiFormatMigrationRun.ts, vscimpb142).
 *
 *   MR-1 what a window needs: newer (no downgrade); migrate because the shared stamp is missing or older; migrate
 *        because only this machine's own files are behind (the machine-local stamp missing or older); current
 *   MR-2 the machine-local stamp: under `_ai/local/`, per host, round-trips; an unreadable one counts as none
 *   MR-3 a run: the dry run writes nothing; an applied run without problems writes the shared stamp and this
 *        machine's stamp; a second run lists nothing
 *   MR-4 the lock: one window at a time; another live window's lock refuses; a gone window's or a stale lock (older
 *        than 30 minutes) is taken over; this window's own is taken again; released only by its holder
 *   MR-5 the merger uses git's registered driver (base, ours, theirs in its command line); none registered: no merge
 *   MR-6 the report: per quest and step, the problems; nothing to do says so
 */

import test, { describe, after } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import {
    acquireMigrationLock,
    localStampFile,
    lockHolds,
    makeGitMerger,
    migrationLockFile,
    migrationNeed,
    migrationReportMarkdown,
    readLocalStamp,
    readMigrationLock,
    releaseMigrationLock,
    runAiFormatMigration,
    writeLocalStamp,
} from '../aiFormatMigrationRun.js';
import { AI_FORMAT_FILE, AI_FORMAT_VERSION, readAiFormatStamp, writeAiFormatStamp } from '../aiFormatVersion.js';

const SANDBOX = fs.mkdtempSync(path.join(os.tmpdir(), 'ai-format-run-'));
after(() => fs.rmSync(SANDBOX, { recursive: true, force: true }));
let n = 0;
function aiRoot(): string {
    const root = path.join(SANDBOX, `ws${++n}`, '_ai');
    fs.mkdirSync(path.join(root, 'quests', 'q1'), { recursive: true });
    return root;
}

describe('the _ai format migration from the extension', () => {
    test('MR-1: what a window needs', () => {
        const ai = aiRoot();
        let need = migrationNeed(ai, 'mbp');
        assert.deepEqual([need.kind, need.kind === 'migrate' && need.reason, need.kind === 'migrate' && need.from], ['migrate', 'shared', undefined], 'no stamp');
        writeAiFormatStamp(ai, { version: AI_FORMAT_VERSION - 1, date: '2026-11-01' });
        need = migrationNeed(ai, 'mbp');
        assert.deepEqual([need.kind, need.kind === 'migrate' && need.reason, need.kind === 'migrate' && need.from], ['migrate', 'shared', AI_FORMAT_VERSION - 1]);
        writeAiFormatStamp(ai, { version: AI_FORMAT_VERSION, date: '2026-11-17' });
        need = migrationNeed(ai, 'mbp');
        assert.deepEqual([need.kind, need.kind === 'migrate' && need.reason], ['migrate', 'local'], 'the shared stamp is current, this machine\'s files are not stamped');
        writeLocalStamp(ai, 'mbp', { version: AI_FORMAT_VERSION - 1, date: '2026-11-01' });
        assert.equal(migrationNeed(ai, 'mbp').kind, 'migrate', 'an older local stamp');
        writeLocalStamp(ai, 'mbp', { version: AI_FORMAT_VERSION, date: '2026-11-17' });
        assert.equal(migrationNeed(ai, 'mbp').kind, 'current');
        assert.equal(migrationNeed(ai, 'bomber').kind, 'migrate', 'another machine has its own stamp');
        writeAiFormatStamp(ai, { version: AI_FORMAT_VERSION + 1, date: '2026-12-01' });
        assert.equal(migrationNeed(ai, 'mbp').kind, 'newer');
    });

    test('MR-2: the machine-local stamp', () => {
        const ai = aiRoot();
        assert.equal(localStampFile(ai, 'mbp'), path.join(ai, 'local', 'format-version.mbp.yaml'));
        assert.equal(readLocalStamp(ai, 'mbp'), undefined);
        writeLocalStamp(ai, 'mbp', { version: 7, date: '2026-11-17' });
        assert.deepEqual(readLocalStamp(ai, 'mbp'), { version: 7, date: '2026-11-17' });
        fs.writeFileSync(localStampFile(ai, 'mbp'), 'version: x\n');
        assert.equal(readLocalStamp(ai, 'mbp'), undefined);
    });

    test('MR-3: a run', () => {
        const ai = aiRoot();
        const opts = { aiRoot: ai, hostSlug: 'mbp', merge: () => undefined, today: '2026-11-17' };
        const dry = runAiFormatMigration({ ...opts, apply: false });
        assert.ok(dry.changes.some((c) => c.step === 'format-version'), 'it would stamp');
        assert.equal(fs.existsSync(path.join(ai, AI_FORMAT_FILE)), false, 'a dry run writes nothing');
        assert.equal(readLocalStamp(ai, 'mbp'), undefined);
        const applied = runAiFormatMigration({ ...opts, apply: true });
        assert.deepEqual(applied.problems, []);
        assert.equal(readAiFormatStamp(ai)?.version, AI_FORMAT_VERSION);
        assert.deepEqual(readLocalStamp(ai, 'mbp'), { version: AI_FORMAT_VERSION, date: '2026-11-17' });
        assert.equal(migrationNeed(ai, 'mbp').kind, 'current');
        assert.deepEqual(runAiFormatMigration({ ...opts, apply: false }).changes, [], 'a second run lists nothing');
    });

    test('MR-4: the lock', () => {
        const ai = aiRoot();
        const now = new Date('2026-11-17T10:00:00Z');
        const alive = new Set(['w1', 'w2']);
        const isAlive = (id: string): boolean => alive.has(id);
        assert.deepEqual(acquireMigrationLock(ai, { windowId: 'w1', host: 'mbp', pid: 1 }, now, isAlive), { ok: true });
        assert.equal(readMigrationLock(ai)?.windowId, 'w1');
        const refused = acquireMigrationLock(ai, { windowId: 'w2', host: 'mbp', pid: 2 }, now, isAlive);
        assert.equal(refused.ok, false);
        assert.equal(!refused.ok && refused.holder.windowId, 'w1', 'held by a live window');
        assert.deepEqual(acquireMigrationLock(ai, { windowId: 'w1', host: 'mbp', pid: 1 }, now, isAlive), { ok: true }, 'its own again');
        releaseMigrationLock(ai, 'w2');
        assert.ok(fs.existsSync(migrationLockFile(ai)), 'only its holder releases it');
        alive.delete('w1');
        assert.deepEqual(acquireMigrationLock(ai, { windowId: 'w2', host: 'mbp', pid: 2 }, now, isAlive), { ok: true }, 'a gone window\'s lock is taken over');
        const later = new Date(now.getTime() + 31 * 60_000);
        assert.equal(lockHolds(readMigrationLock(ai)!, later, isAlive), false, 'stale after 30 minutes');
        assert.deepEqual(acquireMigrationLock(ai, { windowId: 'w3', host: 'mbp', pid: 3 }, later, isAlive), { ok: true });
        releaseMigrationLock(ai, 'w3');
        assert.equal(fs.existsSync(migrationLockFile(ai)), false);
    });

    test('MR-5: the merger', () => {
        const dir = path.join(SANDBOX, 'merge');
        fs.mkdirSync(dir, { recursive: true });
        const target = path.join(dir, 'live-trail.md');
        const legacy = path.join(dir, 'legacy.md');
        fs.writeFileSync(target, 'ours\n');
        fs.writeFileSync(legacy, 'theirs\n');
        const calls: string[] = [];
        const merge = makeGitMerger(path.join(dir, 'scratch'), (command) => {
            calls.push(command);
            if (command.startsWith('git config')) { return 'driver %O %A %B %P\n'; }
            const ours = /driver "[^"]+" "([^"]+)"/.exec(command)![1];
            fs.writeFileSync(ours, 'merged\n');
            return '';
        });
        assert.equal(merge('ai-trail', target, legacy), 'merged\n');
        assert.match(calls[0], /git config --global --get merge\.ai-trail\.driver/);
        assert.match(calls[1], /^driver "[^"]+base" "[^"]+ours" ".*legacy\.md" "live-trail\.md"$/);
        const none = makeGitMerger(path.join(dir, 'scratch2'), () => { throw new Error('not set'); });
        assert.equal(none('ai-trail', target, legacy), undefined);
    });

    test('MR-6: the report', () => {
        const when = new Date('2026-11-17T10:00:00Z');
        assert.match(migrationReportMarkdown({ changes: [], problems: [] }, false, when), /dry run, 2026-11-17T10:00:00.000Z[\s\S]*Nothing to migrate/);
        const text = migrationReportMarkdown({
            changes: [{ quest: 'q1', step: 'sessions', detail: 'a' }, { quest: 'q1', step: 'sessions', detail: 'b' }, { quest: '(workspace)', step: 'format-version', detail: 'stamp' }],
            problems: [{ quest: 'q1', step: 'storage', detail: 'no merge driver' }],
        }, true, when);
        assert.match(text, /^# _ai format migration \(applied/);
        assert.match(text, /## q1\n\nsessions: 2\n\n- sessions: a\n- sessions: b/);
        assert.match(text, /## Problems[\s\S]*- q1 \(storage\): no merge driver/);
    });
});
