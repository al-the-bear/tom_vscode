/**
 * TomAiConfiguration in layers (02_wslayout-4): defaults < user-global < the
 * root's `.tom/tom_vscode_extension.json` < the workspace folder's, deep
 * merged; saves write only what changed, into the root's file.
 *
 *   TL-1 the deep merge across every layer: objects merged, arrays replaced, a
 *        scalar of the workspace layer winning over the root's
 *   TL-2 the user-global file fills in only what the shared files leave out
 *   TL-3 configPath is the root's file (a container shape: the workspace folder
 *        two levels below the root marker)
 *   TL-4 updateSection writes only the changed key into the root file: its other
 *        keys stay, nothing of the workspace layer, the user-global file or the
 *        defaults is copied in; the workspace file is untouched; an unchanged
 *        section writes nothing
 *   TL-5 saveSendToChatConfig after loadSendToChatConfig writes only the change
 *   TL-6 a workspace file that is a symlink to the root's is read once
 *   TL-7 a root file that does not parse: saves refused, the file left as it is
 */

import test, { describe } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

const tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'tomaicfg-layers-')));
const root = path.join(tmp, 'al_the_bear');
const ws = path.join(root, 'inhouse', 'tom_agent_container');
const home = path.join(tmp, 'home');
fs.mkdirSync(path.join(root, '.tom'), { recursive: true });
fs.mkdirSync(path.join(ws, '.tom'), { recursive: true });
fs.mkdirSync(path.join(home, '.tom', 'vscode'), { recursive: true });
fs.writeFileSync(path.join(root, '.tom', 'tom_root.yaml'), 'version: 1\n');
process.env.HOME = home;
process.env.USERPROFILE = home;

import { installVscodeStub } from '../../tools/__tests__/_vscode-stub.js';
installVscodeStub({ workspaceFolders: [ws] });

import { TomAiConfiguration } from '../tomAiConfiguration.js';
import { loadSendToChatConfig, saveSendToChatConfig } from '../sendToChatConfig.js';

const rootFile = path.join(root, '.tom', 'tom_vscode_extension.json');
const wsFile = path.join(ws, '.tom', 'tom_vscode_extension.json');
const userFile = path.join(home, '.tom', 'vscode', 'tom_vscode_extension.user.yaml');

let tick = 0;
function write(file: string, value: unknown): void {
    fs.writeFileSync(file, typeof value === 'string' ? value : JSON.stringify(value, null, 2));
    tick += 10;
    const t = new Date(Date.now() + tick * 1000);
    fs.utimesSync(file, t, t);
}
const read = (file: string): unknown => JSON.parse(fs.readFileSync(file, 'utf8'));

function cfg(): TomAiConfiguration {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    TomAiConfiguration.init({} as any);
    const c = TomAiConfiguration.instance;
    c.reload();
    return c;
}

function layers(): void {
    write(rootFile, { bridge: { requestTimeout: 1000, own: 'root' }, todo: { defaultColumns: ['a', 'b'] }, extra: { mode: 'root', x: 1 }, rootOnly: 1 });
    write(wsFile, { bridge: { restartDelay: 7 }, todo: { defaultColumns: ['ws'] }, extra: { mode: 'ws' } });
    write(userFile, 'bridge:\n  maxRestarts: 3\n  requestTimeout: 99\nfavorites:\n  - name: mine\n');
}

describe('TomAiConfiguration in layers', () => {
    test('TL-1: the deep merge across every layer', () => {
        layers();
        const c = cfg();
        assert.deepEqual(c.getBridge(), { requestTimeout: 1000, restartDelay: 7, maxRestarts: 3, own: 'root' });
        assert.deepEqual(c.getTodo(), { defaultColumns: ['ws'] }, 'an array of the workspace layer replaces the root one');
        assert.deepEqual(c.getSection('extra'), { mode: 'ws', x: 1 }, 'a scalar of the workspace layer wins');
    });

    test('TL-2: the user-global file fills in only what the shared files leave out', () => {
        layers();
        const c = cfg();
        assert.equal(c.getBridge().requestTimeout, 1000, 'the root file wins over the user-global file');
        assert.equal(c.getBridge().maxRestarts, 3, 'a key the shared files leave out comes from the user-global file');
        assert.deepEqual(c.getFavorites(), [{ name: 'mine' }]);
    });

    test('TL-3: configPath is the root\'s file', () => {
        layers();
        const c = cfg();
        assert.equal(fs.realpathSync(c.configPath), fs.realpathSync(rootFile));
        assert.deepEqual(c.layerPaths(), [rootFile, wsFile]);
    });

    test('TL-4: updateSection writes only the changed key into the root file', async () => {
        layers();
        const c = cfg();
        const wsBefore = fs.readFileSync(wsFile, 'utf8');
        await c.saveBridge({ ...c.getBridge(), requestTimeout: 2000 });
        assert.deepEqual(read(rootFile), { bridge: { requestTimeout: 2000, own: 'root' }, todo: { defaultColumns: ['a', 'b'] }, extra: { mode: 'root', x: 1 }, rootOnly: 1 });
        assert.equal(fs.readFileSync(wsFile, 'utf8'), wsBefore, 'the workspace layer is never written');
        assert.equal(c.getBridge().requestTimeout, 2000);
        const before = fs.readFileSync(rootFile, 'utf8');
        await c.saveTrail(c.getTrail());
        assert.equal(fs.readFileSync(rootFile, 'utf8'), before, 'an unchanged section (here: the defaults) writes nothing');
    });

    test('TL-5: saveSendToChatConfig writes only the change', () => {
        layers();
        cfg();
        const loaded = loadSendToChatConfig() as unknown as Record<string, Record<string, unknown>>;
        assert.equal(loaded.extra.mode, 'ws', 'the loaded view is the merged one');
        assert.equal(loaded.bridge.maxRestarts, 3, 'with the user-global file under it');
        loaded.extra.x = 2;
        loaded.added = { k: true };
        assert.equal(saveSendToChatConfig(loaded as never), true);
        assert.deepEqual(read(rootFile), { bridge: { requestTimeout: 1000, own: 'root' }, todo: { defaultColumns: ['a', 'b'] }, extra: { mode: 'root', x: 2 }, rootOnly: 1, added: { k: true } });
    });

    test('TL-6: a workspace file that is a symlink to the root\'s is read once', () => {
        layers();
        fs.rmSync(wsFile);
        fs.symlinkSync(path.relative(path.dirname(wsFile), rootFile), wsFile);
        try {
            const c = cfg();
            assert.deepEqual(c.getTodo(), { defaultColumns: ['a', 'b'] });
            const loaded = loadSendToChatConfig() as unknown as Record<string, Record<string, unknown>>;
            loaded.extra.x = 9;
            saveSendToChatConfig(loaded as never);
            assert.equal(fs.lstatSync(wsFile).isSymbolicLink(), true, 'the link stays a link');
            assert.equal((read(rootFile) as Record<string, Record<string, unknown>>).extra.x, 9);
        } finally {
            fs.rmSync(wsFile);
        }
    });

    test('TL-7: a root file that does not parse: saves refused', async () => {
        layers();
        write(rootFile, '{ "bridge": ');
        const c = cfg();
        await assert.rejects(() => c.saveBridge({ requestTimeout: 1 }), /does not parse/);
        assert.equal(saveSendToChatConfig({} as never), false);
        assert.equal(fs.readFileSync(rootFile, 'utf8'), '{ "bridge": ', 'the file is left as it is');
    });
});
