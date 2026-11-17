/**
 * Upgrade the workspace — the `_ai` format migration page (handlers/aiFormatMigration-handler.ts,
 * media/aiFormatMigration, services/aiFormatCheckService.ts; vscimpb142), under the vscode stub and in a JSDOM.
 *
 *   FP-1 the page's states: review (the dry run, the other windows), current ("done already"), newer, locked
 *        ("already running in another window")
 *   FP-2 Migrate now: the lock taken and released, the shared and the local stamp written, done; a second window then
 *        finds it done already; while another live window holds the lock it is refused
 *   FP-3 the page: Migrate now only after "I understand it cannot be undone"; the warning names everyone sharing the
 *        workspace; done offers Reload; locked says it runs elsewhere
 *   FP-4 the start-up check: the command registered, the page opened by itself, the reload overlay after another
 *        window's migration (reloadOverlay.test.ts), the package.json command
 */

import test, { after, describe } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { JSDOM } from 'jsdom';

import { installVscodeStub } from '../../tools/__tests__/_vscode-stub.js';
const vscodeStub = installVscodeStub({ workspaceFolders: [os.tmpdir()] });

import { applyMigration, migrationPageState, type MigrationPageDeps } from '../aiFormatMigration-handler.js';
import { acquireMigrationLock, migrationLockFile, migrationNeed, readLocalStamp } from '../../utils/aiFormatMigrationRun.js';
import { AI_FORMAT_VERSION, readAiFormatStamp, writeAiFormatStamp } from '../../utils/aiFormatVersion.js';

const EXT = path.resolve(__dirname, '..', '..', '..');
const SANDBOX = fs.mkdtempSync(path.join(os.tmpdir(), 'ai-format-page-'));
after(() => { vscodeStub.restore(); fs.rmSync(SANDBOX, { recursive: true, force: true }); });

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Json = any;
let n = 0;
function workspace(): { ws: string; ai: string } {
    const ws = path.join(SANDBOX, `ws${++n}`);
    fs.mkdirSync(path.join(ws, '_ai', 'quests', 'q1'), { recursive: true });
    return { ws, ai: path.join(ws, '_ai') };
}
function deps(ws: string, windowId: string, alive: Set<string>, migrated: number[] = []): MigrationPageDeps {
    return {
        aiRoot: () => path.join(ws, '_ai'),
        workspaceRoot: () => ws,
        host: () => 'mbp',
        windowId: () => windowId,
        isAlive: (id) => alive.has(id),
        otherWindows: () => [{ label: 'tom_core — tom_agent_container' }],
        onMigrated: (v) => { migrated.push(v); },
    };
}

describe('the _ai format migration page', () => {
    test('FP-1: the page\'s states', () => {
        const { ws, ai } = workspace();
        const d = deps(ws, 'w1', new Set(['w1']));
        writeAiFormatStamp(ai, { version: AI_FORMAT_VERSION - 1, date: '2026-11-01' });
        const review = migrationPageState(d, migrationNeed(ai, 'mbp'));
        assert.equal(review.phase, 'review');
        assert.deepEqual([review.from, review.to, review.reason], [AI_FORMAT_VERSION - 1, AI_FORMAT_VERSION, 'shared']);
        assert.match(review.reportHtml!, /dry run/);
        assert.deepEqual(review.windows, [{ label: 'tom_core — tom_agent_container' }]);
        assert.equal(fs.existsSync(path.join(ai, 'local')), false, 'the dry run wrote nothing');
        assert.deepEqual(migrationPageState(d, { kind: 'current' }), { phase: 'current', to: AI_FORMAT_VERSION, message: 'The migration has been done already.' });
        writeAiFormatStamp(ai, { version: AI_FORMAT_VERSION + 1, date: '2026-12-01' });
        assert.equal(migrationPageState(d, migrationNeed(ai, 'mbp')).phase, 'newer');
        writeAiFormatStamp(ai, { version: AI_FORMAT_VERSION - 1, date: '2026-11-01' });
        assert.deepEqual(acquireMigrationLock(ai, { windowId: 'w2', host: 'mbp', pid: 2 }, new Date(), () => true), { ok: true });
        const locked = migrationPageState(deps(ws, 'w1', new Set(['w1', 'w2'])), migrationNeed(ai, 'mbp'));
        assert.equal(locked.phase, 'locked');
        assert.equal(locked.message, 'Migration is already running in another window.');
        fs.rmSync(migrationLockFile(ai));
    });

    test('FP-2: Migrate now', () => {
        const { ws, ai } = workspace();
        const migrated: number[] = [];
        const alive = new Set(['w1', 'w2']);
        const done = applyMigration(deps(ws, 'w1', alive, migrated));
        assert.equal(done.phase, 'done', JSON.stringify(done));
        assert.equal(readAiFormatStamp(ai)?.version, AI_FORMAT_VERSION, 'the shared stamp');
        assert.equal(readLocalStamp(ai, 'mbp')?.version, AI_FORMAT_VERSION, 'this machine\'s stamp');
        assert.equal(fs.existsSync(migrationLockFile(ai)), false, 'the lock released');
        assert.deepEqual(migrated, [AI_FORMAT_VERSION]);
        const scratch = path.join(ws, 'ztmp');
        assert.ok(!fs.existsSync(scratch) || fs.readdirSync(scratch).length === 0, 'no scratch left');
        const second = applyMigration(deps(ws, 'w2', alive));
        assert.deepEqual([second.phase, second.message], ['current', 'The migration has been done already.']);
        // Another live window holds the lock: refused.
        const other = workspace();
        assert.deepEqual(acquireMigrationLock(other.ai, { windowId: 'w2', host: 'mbp', pid: 2 }, new Date(), () => true), { ok: true });
        const refused = applyMigration(deps(other.ws, 'w1', alive));
        assert.deepEqual([refused.phase, refused.message], ['locked', 'Migration is already running in another window.']);
        assert.equal(readAiFormatStamp(other.ai), undefined, 'nothing migrated');
    });

    test('FP-3: the page', () => {
        const read = (f: string): string => fs.readFileSync(path.join(EXT, 'media', 'aiFormatMigration', f), 'utf8');
        const html = read('index.html').replace(/<script[\s\S]*?<\/script>/g, '').replace(/\{\{[a-zA-Z]+\}\}/g, '');
        const w = new JSDOM(html, { runScripts: 'outside-only' }).window as Json;
        const posted: Json[] = [];
        w.acquireVsCodeApi = () => ({ postMessage: (m: Json) => posted.push(m) });
        w.__INIT__ = { phase: 'review', from: 8, to: 9, reason: 'shared', reportHtml: '<h1>report</h1>', changes: 3, problems: 0, windows: [{ label: 'tom_core — ws' }] };
        w.eval(read('main.js'));
        const $ = (id: string): Json => w.document.getElementById(id);
        assert.match($('fmTitle').textContent, /format version 9/);
        assert.match($('fmIntro').textContent, /format version 8; this Tom AI build works with version 9/);
        assert.equal($('fmWarning').hidden, false);
        assert.match($('fmWarning').textContent, /cannot be undone[\s\S]*everyone who shares this\s+workspace/);
        assert.equal($('fmWindows').hidden, false);
        assert.equal($('fmApply').disabled, true, 'only after the confirmation');
        $('fmConfirm').checked = true;
        $('fmConfirm').dispatchEvent(new w.Event('change'));
        assert.equal($('fmApply').disabled, false);
        $('fmApply').click();
        assert.deepEqual(posted.filter((m) => m.type === 'apply').map((m) => JSON.stringify(m)), ['{"type":"apply"}']);
        w.dispatchEvent(new w.MessageEvent('message', { data: { type: 'state', state: { phase: 'done', to: 9, changes: 3, problems: 0, reportHtml: '' } } }));
        assert.equal($('fmReload').hidden, false, 'done: Reload');
        assert.equal($('fmWarning').hidden, true);
        $('fmReload').click();
        assert.ok(posted.some((m) => m.type === 'reload'));
        w.dispatchEvent(new w.MessageEvent('message', { data: { type: 'state', state: { phase: 'locked', to: 9, holder: 'window w2', message: 'Migration is already running in another window.' } } }));
        assert.match($('fmIntro').textContent, /already running in another window/);
        assert.equal($('fmApply').hidden, true);
        w.close();
    });

    test('FP-4: the start-up check and the command', () => {
        const service = fs.readFileSync(path.join(EXT, 'src', 'services', 'aiFormatCheckService.ts'), 'utf8');
        assert.match(service, /registerAiFormatMigrationCommand\(context\);/);
        assert.match(service, /pauseAllRuns\(\);[\s\S]{0,200}showReloadOverlay\(/, 'another window\'s migration pauses this one and shows the reload overlay');
        assert.match(service, /Migration is already running in another window/);
        const pkg = JSON.parse(fs.readFileSync(path.join(EXT, 'package.json'), 'utf8'));
        assert.ok(pkg.contributes.commands.some((c: Json) => c.command === 'tomAi.migrateAiFormats' && c.title === '@T: Migrate _ai Formats'));
        const cli = fs.readFileSync(path.join(EXT, 'scripts', 'migrate-ai-formats.cjs'), 'utf8');
        assert.match(cli, /runAiFormatMigration\(\{/, 'the npm script writes the local stamp too');
    });
});
