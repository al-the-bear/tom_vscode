/**
 * The `_ai` format-version stamp (src/utils/aiFormatVersion.ts), written by the
 * format migration (aiFormatMigration.ts) and checked by the extension at start
 * (services/aiFormatCheckService.ts).
 *
 *   FV-1 no stamp: `missing`, naming the migration command
 *   FV-2 an older stamp: `older`, naming the migration command
 *   FV-3 a newer stamp: `newer`, naming the build to install; the equal one is `current`
 *   FV-4 a stamp without a version is `unreadable`, never `current`
 *   FV-5 the migration writes the stamp when applied (version, date), lists it in a dry run without
 *        writing, and lists nothing once it is current
 *   FV-6 a problem left by another step: no stamp is written, and that is a problem too
 *   FV-7 a stamp newer than the migrating build is left as it is, as a problem
 *   FV-8 the extension checks at start and offers the command
 */

import test, { describe } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import { AI_FORMAT_FILE, AI_FORMAT_VERSION, checkAiFormatVersion, readAiFormatStamp, writeAiFormatStamp } from '../aiFormatVersion';
import { migrateAiFormats } from '../aiFormatMigration';

function aiRoot(): string {
    const ai = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'ai-format-version-')), '_ai');
    fs.mkdirSync(path.join(ai, 'quests', 'qa'), { recursive: true });
    return ai;
}

const migrate = (ai: string, apply: boolean, formatVersion = 3) =>
    migrateAiFormats({ aiRoot: ai, hostSlug: 'mbp', apply, merge: () => undefined, formatVersion, today: '2026-11-05' });

describe('ai format version', () => {
    test('FV-1: no stamp', () => {
        const c = checkAiFormatVersion(aiRoot());
        assert.equal(c.kind, 'missing');
        assert.match((c as { message: string }).message, /npm run migrate:ai-formats -- --apply/);
    });

    test('FV-2: an older stamp', () => {
        const ai = aiRoot();
        writeAiFormatStamp(ai, { version: 1, date: '2026-11-01' });
        const c = checkAiFormatVersion(ai, 2);
        assert.equal(c.kind, 'older');
        assert.match((c as { message: string }).message, /version 1 \(migrated 2026-11-01\).*expects version 2.*npm run migrate:ai-formats -- --apply/);
    });

    test('FV-3: a newer stamp; the equal one', () => {
        const ai = aiRoot();
        writeAiFormatStamp(ai, { version: 3, date: '2026-11-05' });
        const c = checkAiFormatVersion(ai, 2);
        assert.equal(c.kind, 'newer');
        assert.match((c as { message: string }).message, /understands version 2.*Install the newer build/);
        assert.equal(checkAiFormatVersion(ai, 3).kind, 'current');
        writeAiFormatStamp(ai, { version: AI_FORMAT_VERSION, date: '2026-11-05' });
        assert.equal(checkAiFormatVersion(ai).kind, 'current', 'the build checks against its own version by default');
    });

    test('FV-4: a stamp without a version', () => {
        const ai = aiRoot();
        fs.writeFileSync(path.join(ai, AI_FORMAT_FILE), 'date: 2026-11-05\n');
        assert.equal(readAiFormatStamp(ai), null);
        assert.equal(checkAiFormatVersion(ai).kind, 'unreadable');
    });

    test('FV-5: the migration writes the stamp', () => {
        const ai = aiRoot();
        const dry = migrate(ai, false);
        assert.ok(dry.changes.some((c) => c.step === 'format-version' && /version 3/.test(c.detail)));
        assert.equal(fs.existsSync(path.join(ai, AI_FORMAT_FILE)), false, 'a dry run writes nothing');
        migrate(ai, true);
        assert.deepEqual(readAiFormatStamp(ai), { version: 3, date: '2026-11-05' });
        assert.deepEqual(migrate(ai, false).changes, [], 'current: nothing to do');
        const raised = migrate(ai, false, 4);
        assert.ok(raised.changes.some((c) => c.step === 'format-version' && /version 4 \(was 3\)/.test(c.detail)));
    });

    test('FV-6: no stamp while a problem remains', () => {
        const ai = aiRoot();
        const q = path.join(ai, 'quests', 'qa', 'history');
        fs.mkdirSync(path.join(q, 'sessions', 'default'), { recursive: true });
        fs.writeFileSync(path.join(q, 'history.json'), '{"old":1}');
        fs.writeFileSync(path.join(q, 'sessions', 'default', 'history.json'), '{"new":1}');
        const r = migrate(ai, true); // the merge fails
        assert.ok(r.problems.some((p) => p.step === 'format-version'));
        assert.equal(fs.existsSync(path.join(ai, AI_FORMAT_FILE)), false);
    });

    test('FV-7: a newer stamp stays', () => {
        const ai = aiRoot();
        writeAiFormatStamp(ai, { version: 9, date: '2026-12-01' });
        const r = migrate(ai, true);
        assert.ok(r.problems.some((p) => p.step === 'format-version' && /newer than this build/.test(p.detail)));
        assert.deepEqual(readAiFormatStamp(ai), { version: 9, date: '2026-12-01' });
    });

    test('FV-8: checked at start', () => {
        const src = (rel: string) => fs.readFileSync(path.join(__dirname, '..', '..', '..', 'src', rel), 'utf8');
        assert.match(src('extension.ts'), /initBuildStatus\(context\);\n[\s\S]{0,200}warnAboutAiFormatVersion\(\);/);
        const service = src('services/aiFormatCheckService.ts');
        assert.match(service, /checkAiFormatVersion\(aiRoot\)/);
        assert.match(service, /check\.kind === 'newer' \? \[\] : \[COPY\]/);
    });
});
