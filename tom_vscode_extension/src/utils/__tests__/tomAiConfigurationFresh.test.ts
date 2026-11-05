/**
 * TomAiConfiguration follows its files: a hand edit of the workspace config
 * (`.tom/tom_vscode_extension.json`) or of the user-global overlay is seen by
 * the next `getSection` read, without the reload-config command or a window
 * reload. Reads go through a stat cache, so an unchanged file is not parsed
 * again.
 *
 *   TC-1 a hand edit of a section is seen by its getSection readers
 *   TC-2 an unchanged file is not read again (one stat per call, no parse)
 *   TC-3 a file that disappears falls back to the defaults; one that appears is read
 *   TC-4 a save through updateSection, then a hand edit: both are seen, in order
 *   TC-5 a hand edit of the user-global overlay is seen too
 *   TC-6 a hand edit that leaves the file unparsable keeps nothing stale: the
 *        section reads as the defaults until the file parses again
 *   TC-7 a save writes only the saved section into the workspace file: the
 *        defaults and the user-global overlay's sections stay out of it, and the
 *        file's other sections stay as they were
 *   TC-8 after a save, a later edit of the overlay is still seen for a section
 *        the workspace file does not define
 *   TC-9 a save while the workspace file does not parse is refused and leaves
 *        the file as it is (a half-finished hand edit is not overwritten)
 */

import test, { describe, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'tomaicfg-'));
const wsRoot = path.join(tmpRoot, 'ws');
const home = path.join(tmpRoot, 'home');
fs.mkdirSync(path.join(wsRoot, '.tom'), { recursive: true });
fs.mkdirSync(path.join(home, '.tom', 'vscode'), { recursive: true });
process.env.HOME = home;
process.env.USERPROFILE = home;

import { installVscodeStub } from '../../tools/__tests__/_vscode-stub.js';
installVscodeStub({ workspaceFolders: [wsRoot] });

import { TomAiConfiguration } from '../tomAiConfiguration.js';
import { FsUtils } from '../fsUtils.js';

const wsConfig = path.join(wsRoot, '.tom', 'tom_vscode_extension.json');
const userConfig = path.join(home, '.tom', 'vscode', 'tom_vscode_extension.user.yaml');

let tick = 0;
/** Write `text` and give the file an mtime no earlier write had, as a later hand edit would. */
function handEdit(file: string, text: string): void {
    fs.writeFileSync(file, text);
    tick += 10;
    const t = new Date(Date.now() + tick * 1000);
    fs.utimesSync(file, t, t);
}

function cfg(): TomAiConfiguration {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    TomAiConfiguration.init({} as any);
    return TomAiConfiguration.instance;
}

describe('TomAiConfiguration follows hand edits', () => {
    beforeEach(() => {
        fs.rmSync(userConfig, { force: true });
        handEdit(wsConfig, JSON.stringify({ copilot: { answerFolder: 'http://one' } }));
    });

    test('TC-1: a hand edit of a section is seen without a reload', () => {
        const c = cfg();
        assert.equal(c.getCopilot().answerFolder, 'http://one');
        handEdit(wsConfig, JSON.stringify({ copilot: { answerFolder: 'http://two' }, todo: { defaultColumns: ['x'] } }));
        assert.equal(c.getCopilot().answerFolder, 'http://two');
        assert.deepEqual(c.getSection<Record<string, unknown>>('todo')?.defaultColumns, ['x']);
    });

    test('TC-2: an unchanged file is not read again', (t) => {
        const c = cfg();
        c.getCopilot();
        const read = t.mock.method(FsUtils, 'safeReadFile');
        for (let i = 0; i < 5; i++) { c.getCopilot(); c.getTrail(); }
        assert.equal(read.mock.callCount(), 0, 'no read while neither file changed');
        handEdit(wsConfig, JSON.stringify({ copilot: { answerFolder: 'http://three' } }));
        assert.equal(c.getCopilot().answerFolder, 'http://three');
        assert.equal(read.mock.callCount(), 1, 'one read for the one change');
    });

    test('TC-3: a file that disappears or appears', () => {
        const c = cfg();
        assert.equal(c.getCopilot().answerFolder, 'http://one');
        fs.rmSync(wsConfig);
        assert.equal(c.getCopilot().answerFolder, TomAiConfiguration.defaults.copilot.answerFolder, 'defaults once it is gone');
        handEdit(wsConfig, JSON.stringify({ copilot: { answerFolder: 'http://back' } }));
        assert.equal(c.getCopilot().answerFolder, 'http://back');
    });

    test('TC-4: a save, then a hand edit', async () => {
        const c = cfg();
        await c.saveCopilot({ answerFolder: 'http://saved' });
        assert.equal(c.getCopilot().answerFolder, 'http://saved');
        assert.equal(JSON.parse(fs.readFileSync(wsConfig, 'utf-8')).copilot.answerFolder, 'http://saved');
        handEdit(wsConfig, JSON.stringify({ copilot: { answerFolder: 'http://edited' } }));
        assert.equal(c.getCopilot().answerFolder, 'http://edited');
    });

    test('TC-5: a hand edit of the user-global overlay', () => {
        const c = cfg();
        assert.equal(c.getSection('bridge') !== undefined, true);
        handEdit(userConfig, 'todo:\n  defaultColumns: [a, b]\n');
        assert.deepEqual(c.getTodo().defaultColumns, ['a', 'b']);
        fs.rmSync(userConfig);
        assert.deepEqual(c.getTodo().defaultColumns, TomAiConfiguration.defaults.todo.defaultColumns);
    });

    test('TC-6: an unparsable hand edit', () => {
        const c = cfg();
        handEdit(wsConfig, '{ "copilot": ');
        assert.equal(c.getCopilot().answerFolder, TomAiConfiguration.defaults.copilot.answerFolder);
        handEdit(wsConfig, JSON.stringify({ copilot: { answerFolder: 'http://fixed' } }));
        assert.equal(c.getCopilot().answerFolder, 'http://fixed');
    });

    test('TC-7: a save writes only the saved section', async () => {
        handEdit(userConfig, 'todo:\n  defaultColumns: [mine]\n');
        handEdit(wsConfig, JSON.stringify({ copilot: { answerFolder: 'http://one' }, custom: { keep: 1 } }));
        const c = cfg();
        await c.saveTrail({ raw: { enabled: false } });
        const onDisk = JSON.parse(fs.readFileSync(wsConfig, 'utf-8'));
        assert.deepEqual(Object.keys(onDisk).sort(), ['copilot', 'custom', 'trail']);
        assert.deepEqual(onDisk.trail, { raw: { enabled: false } });
        assert.deepEqual(onDisk.custom, { keep: 1 }, 'another section the file had');
        assert.deepEqual(c.getTrail(), { raw: { enabled: false } });
        assert.deepEqual(c.getTodo().defaultColumns, ['mine'], 'the overlay still serves its section');
    });

    test('TC-8: after a save, an overlay edit is still seen', async () => {
        handEdit(userConfig, 'todo:\n  defaultColumns: [first]\n');
        const c = cfg();
        await c.saveCopilot({ answerFolder: 'http://saved' });
        handEdit(userConfig, 'todo:\n  defaultColumns: [second]\n');
        assert.deepEqual(c.getTodo().defaultColumns, ['second']);
        assert.equal(JSON.parse(fs.readFileSync(wsConfig, 'utf-8')).todo, undefined);
    });

    test('TC-9: a save while the file does not parse is refused', async () => {
        const c = cfg();
        handEdit(wsConfig, '{ "copilot": { "answerFolder": "http://half"');
        await assert.rejects(() => c.saveTrail({ raw: { enabled: false } }), /does not parse/);
        assert.equal(fs.readFileSync(wsConfig, 'utf-8'), '{ "copilot": { "answerFolder": "http://half"');
    });
});
