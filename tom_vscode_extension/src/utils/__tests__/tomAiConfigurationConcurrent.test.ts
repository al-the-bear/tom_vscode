/**
 * The shared configuration saved by several windows at once (02_wslayout-5; utils/lockedConfigWrite.ts and
 * TomAiConfiguration's saves). The writers are Node child processes running the real TomAiConfiguration
 * (_configWriter.worker.ts) on a temporary workspace.
 *
 *   CW-1 two writers saving different sections 1 ms, 50 ms and 1 s apart: every section of both kept, every time
 *        (200 saves each at 1 ms and 50 ms, 5 at 1 s); a reader polling meanwhile never sees a partial file, the
 *        defaults or an unreadable target
 *   CW-2 a save from a view that predates a hand edit of another key: the hand edit is kept
 *   CW-3 the target as a symlink: the link stays a link, the file it points to gets the change
 *   CW-4 a lock older than 5 s is taken over; a fresh one is waited for (the save lands once it is released)
 *   CW-5 two writers on the same section: the last one wins, the file parses, the other sections stay
 *   CW-6 a failed save is reported: the file named in an error message, the promise rejects, nothing written;
 *        a reader meeting a file that does not parse reads it once more before treating it as unreadable
 */

import test, { after, describe } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';

const EXT = path.resolve(__dirname, '..', '..', '..');
const SANDBOX = fs.realpathSync(fs.mkdtempSync(path.join(EXT, '..', '..', '..', 'ztmp', 'vscode_extension_261118_02_wslayout-5_cw-')));
after(() => fs.rmSync(SANDBOX, { recursive: true, force: true }));
const WORKER = path.join(__dirname, '_configWriter.worker.js');

const HOME = path.join(SANDBOX, 'home');
fs.mkdirSync(path.join(HOME, '.tom', 'vscode'), { recursive: true });
process.env.HOME = HOME;
process.env.USERPROFILE = HOME;

import { installVscodeStub } from '../../tools/__tests__/_vscode-stub.js';
installVscodeStub({ workspaceFolders: [path.join(SANDBOX, 'none')] });

import { TomAiConfiguration } from '../tomAiConfiguration.js';
import { resetLayoutForTests } from '../workspaceLayout.js';
import { CONFIG_LOCK_STALE_MS, acquireConfigLock, configLockPath, readConfigFileOnce } from '../lockedConfigWrite.js';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Json = any;
let wsCount = 0;
/**
 * A fresh standalone workspace: its own root (`.tom/tom_root.yaml`, so the layout never finds the root of the tree
 * the sandbox lies in) with a config file holding `content`.
 */
function workspace(content: Record<string, unknown> = { marker: { here: true } }): { ws: string; file: string } {
    const ws = path.join(SANDBOX, `ws${++wsCount}`);
    const file = path.join(ws, '.tom', 'tom_vscode_extension.json');
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(path.join(ws, '.tom', 'tom_root.yaml'), 'version: 1\n');
    fs.writeFileSync(file, JSON.stringify(content, null, 2));
    return { ws, file };
}
/** TomAiConfiguration of this process on `ws`. */
function config(ws: string): TomAiConfiguration {
    installVscodeStub({ workspaceFolders: [ws] });
    resetLayoutForTests();
    (TomAiConfiguration as Json)._instance = undefined;
    TomAiConfiguration.init({} as Json);
    const tc = TomAiConfiguration.instance;
    // Never a save into a real configuration: the target must lie in the sandbox.
    assert.ok(tc.configPath.startsWith(ws + path.sep), `the target ${tc.configPath} is not in ${ws}`);
    return tc;
}
function readFile(file: string): Json { return JSON.parse(fs.readFileSync(file, 'utf8')); }

interface Job { ws: string; start: number; period: number; count: number; offset: number; section: string; writer: string }
function writer(job: Job): Promise<{ code: number | null; out: string; err: string }> {
    return new Promise((resolve) => {
        const child = spawn(process.execPath, [WORKER, JSON.stringify({ ...job, home: HOME })], { stdio: ['ignore', 'pipe', 'pipe'] });
        let out = ''; let err = '';
        child.stdout.on('data', (d) => { out += String(d); });
        child.stderr.on('data', (d) => { err += String(d); });
        child.on('exit', (code) => resolve({ code, out, err }));
    });
}
/** Poll `file` until `done` settles: the raw text always parses and the reader's view never loses the marker. */
async function pollWhile<T>(file: string, ws: string, done: Promise<T>): Promise<{ result: T; reads: number; bad: string[] }> {
    const tc = config(ws);
    let finished = false;
    const result = done.then((r) => { finished = true; return r; });
    const bad: string[] = [];
    let reads = 0;
    while (!finished) {
        reads += 1;
        const raw = fs.readFileSync(file, 'utf8');
        try { JSON.parse(raw); } catch { bad.push(`partial: ${raw.length} bytes`); }
        if ((tc.getSection<Json>('marker') ?? {}).here !== true) { bad.push('defaults'); }
        if ((tc as Json).targetUnreadable) { bad.push('unreadable'); }
        await new Promise((r) => setTimeout(r, 1));
    }
    return { result: await result, reads, bad };
}

describe('the shared configuration, several writers', () => {
    for (const [offset, count] of [[1, 200], [50, 200], [1000, 5]] as const) {
        test(`CW-1: two writers ${offset} ms apart (${count} saves each), a reader polling`, { timeout: 120_000 }, async () => {
            const { ws, file } = workspace();
            const start = Date.now() + 800;
            const period = Math.max(offset * 2, 20);
            const both = Promise.all([
                writer({ ws, start, period, count, offset: 0, section: 'a*', writer: 'A' }),
                writer({ ws, start, period, count, offset, section: 'b*', writer: 'B' }),
            ]);
            const { result, reads, bad } = await pollWhile(file, ws, both);
            for (const r of result) { assert.equal(r.code, 0, r.err); assert.match(r.out, /done 0/, r.err); }
            const final = readFile(file);
            const missing: string[] = [];
            for (let i = 0; i < count; i++) {
                if (final[`a${i}`] !== i) { missing.push(`a${i}`); }
                if (final[`b${i}`] !== i) { missing.push(`b${i}`); }
            }
            assert.deepEqual(missing, [], 'every section of both writers kept');
            assert.deepEqual(final.marker, { here: true });
            assert.ok(reads > 10, `the reader polled (${reads})`);
            assert.deepEqual(bad.slice(0, 5), [], 'the reader never saw a partial file, the defaults or an unreadable target');
            assert.equal(fs.existsSync(configLockPath(file)), false, 'no lock left');
            assert.deepEqual(fs.readdirSync(path.dirname(file)).filter((n) => n.endsWith('.tmp')), [], 'no temporary file left');
        });
    }

    test('CW-2: a hand edit of another key is kept', async () => {
        const { ws, file } = workspace({ copilot: { answerFolder: 'x' } });
        const tc = config(ws);
        assert.equal(tc.getCopilot().answerFolder, 'x');
        // The view predates the hand edit (as in a window that has not read since).
        (tc as Json).refreshIfChanged = () => undefined;
        fs.writeFileSync(file, JSON.stringify({ copilot: { answerFolder: 'x' }, hand: { edited: 1 } }, null, 2));
        await tc.saveTrail({ raw: { enabled: false } });
        const final = readFile(file);
        assert.deepEqual(final.hand, { edited: 1 }, 'the hand edit kept');
        assert.equal(final.trail.raw.enabled, false);
        assert.deepEqual(Object.keys(final.trail), ['raw'], 'only the change written');
    });

    test('CW-3: a symlinked target stays a link', async () => {
        const real = path.join(SANDBOX, 'rootcfg', '.tom', 'tom_vscode_extension.json');
        fs.mkdirSync(path.dirname(real), { recursive: true });
        fs.writeFileSync(real, JSON.stringify({ marker: { here: true } }));
        const ws = path.join(SANDBOX, 'linked');
        fs.mkdirSync(path.join(ws, '.tom'), { recursive: true });
        fs.writeFileSync(path.join(ws, '.tom', 'tom_root.yaml'), 'version: 1\n');
        const link = path.join(ws, '.tom', 'tom_vscode_extension.json');
        fs.symlinkSync(real, link);
        const tc = config(ws);
        await tc.updateSection('todo', { defaultColumns: ['l'] });
        assert.equal(fs.lstatSync(link).isSymbolicLink(), true, 'the link stays a link');
        assert.deepEqual(readFile(real).todo, { defaultColumns: ['l'] }, 'the file it points to has the change');
        assert.equal(fs.existsSync(`${link}.lock`), false);
        assert.deepEqual(fs.readdirSync(path.dirname(link)).sort(), ['tom_root.yaml', 'tom_vscode_extension.json'], 'nothing written beside the link');
    });

    test('CW-4: a stale lock is taken over, a fresh one waited for', async () => {
        const { ws, file } = workspace();
        const lock = configLockPath(file);
        fs.writeFileSync(lock, JSON.stringify({ pid: 1, host: 'gone', at: 'long ago', token: 'old' }));
        const old = new Date(Date.now() - CONFIG_LOCK_STALE_MS - 2000);
        fs.utimesSync(lock, old, old);
        const tc = config(ws);
        const t0 = Date.now();
        await tc.updateSection('stale', 1);
        assert.ok(Date.now() - t0 < 1000, 'taken over at once');
        assert.equal(readFile(file).stale, 1);
        assert.equal(fs.existsSync(lock), false);

        const release = acquireConfigLock(fs.realpathSync(file));
        const started = Date.now();
        const w = writer({ ws, start: started, period: 1, count: 1, offset: 0, section: 'fresh', writer: 'W' });
        await new Promise((r) => setTimeout(r, 1500));
        assert.equal(readFile(file).fresh, undefined, 'not written while the lock is held');
        release();
        const r = await w;
        assert.match(r.out, /done 0/, r.err);
        assert.deepEqual(readFile(file).fresh, { writer: 'W', i: 0 }, 'written once it is released');
        assert.equal(readFile(file).stale, 1);
    });

    test('CW-5: two writers on the same section: the last one wins', { timeout: 60_000 }, async () => {
        const { ws, file } = workspace();
        const start = Date.now() + 800;
        const [a, b] = await Promise.all([
            writer({ ws, start, period: 10, count: 100, offset: 0, section: 'same', writer: 'A' }),
            writer({ ws, start, period: 10, count: 100, offset: 3, section: 'same', writer: 'B' }),
        ]);
        assert.match(a.out, /done 0/, a.err);
        assert.match(b.out, /done 0/, b.err);
        const final = readFile(file);
        assert.equal(final.same.i, 99, 'a writer\'s last save');
        assert.ok(['A', 'B'].includes(final.same.writer));
        assert.deepEqual(final.marker, { here: true });
    });

    test('CW-6: a failed save is reported; a file that does not parse is read once more', async () => {
        const { ws, file } = workspace();
        const tc = config(ws);
        fs.writeFileSync(file, '{ "half": ');
        const handle = installVscodeStub({ workspaceFolders: [ws] });
        handle.spies.clear();
        await assert.rejects(tc.saveTodo({ defaultColumns: ['z'] }), new RegExp(`Not saved: ${file.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`));
        const shown = handle.spies.byMethod('window.showErrorMessage').map((c) => String(c.args[0]));
        assert.ok(shown.some((m) => m.includes(file) && /does not parse/.test(m)), shown.join('\n'));
        assert.equal(fs.readFileSync(file, 'utf8'), '{ "half": ', 'nothing written');

        // A hand edit finishing while the reader waits: the second read succeeds.
        const format = { parse: (raw: string) => { try { return JSON.parse(raw); } catch { return undefined; } }, stringify: (c: unknown) => JSON.stringify(c) };
        // (another process: this one sleeps synchronously between the two reads)
        const finisher = spawn(process.execPath, ['-e', `require('fs').writeFileSync(${JSON.stringify(file)}, '{"done":1}')`]);
        const read = readConfigFileOnce(file, format, 3000);
        await new Promise((resolve) => finisher.on('exit', resolve));
        assert.deepEqual(read, { exists: true, content: { done: 1 } });
    });
});
