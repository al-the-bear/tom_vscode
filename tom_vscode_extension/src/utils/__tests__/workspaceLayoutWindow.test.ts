/**
 * The window's layout (`getLayout`) and `WsPaths` on it: the first folder is
 * the workspace folder whatever editor is active, the `tomAi.layout.*`
 * settings and the `tomAi.aiFolder` alias are honoured, `${tomRoot}` is a
 * resolver variable, and a marker file change recomputes the layout. VS Code is
 * loaded once: a `require('vscode')` that fails later (the extension folder
 * replaced by a reinstall under the running window) does not reach the layout.
 */

import { test, describe, beforeEach } from 'node:test';
import * as assert from 'node:assert/strict';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { installVscodeStub, stubFileWatchers } from '../../tools/__tests__/_vscode-stub.js';

const top = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'tomlayout-win-')));
fs.mkdirSync(path.join(top, '.tom'), { recursive: true });
fs.writeFileSync(path.join(top, '.tom', 'tom_root.yaml'), 'version: 1\n');
fs.writeFileSync(path.join(top, '.tom', 'tom_vscode_extension.json'), '{}');
fs.mkdirSync(path.join(top, '_ai', 'quests'), { recursive: true });
const ws = path.join(top, 'container');
fs.mkdirSync(ws, { recursive: true });
const second = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'tomlayout-second-')));
fs.mkdirSync(path.join(second, '_ai'), { recursive: true });
fs.mkdirSync(path.join(second, '.tom'), { recursive: true });

const handle = installVscodeStub({ workspaceFolders: [ws, second] });
const vscodeStub = handle.stub as { window: Record<string, unknown>; workspace: Record<string, unknown> };

// eslint-disable-next-line @typescript-eslint/no-require-imports
const { WsPaths } = require('../workspacePaths.js') as typeof import('../workspacePaths.js');
// eslint-disable-next-line @typescript-eslint/no-require-imports
const layoutMod = require('../workspaceLayout.js') as typeof import('../workspaceLayout.js');

describe('getLayout and WsPaths', () => {
    beforeEach(() => {
        installVscodeStub({ workspaceFolders: [ws, second], configuration: {} });
        vscodeStub.window.activeTextEditor = undefined;
        layoutMod.resetLayoutForTests();
    });

    test('VS Code is loaded once: a later require failure (a reinstall) does not reach getLayout', () => {
        assert.equal(WsPaths.aiRoot, path.join(top, '_ai'));
        // eslint-disable-next-line @typescript-eslint/no-require-imports
        const Module = require('module') as { _load: (request: string, ...rest: unknown[]) => unknown };
        const load = Module._load;
        Module._load = function (request: string, ...rest: unknown[]) {
            if (request === 'vscode') {
                throw new Error("ENOENT: no such file or directory, access '.../out/utils/workspaceLayout.js'");
            }
            return load.call(this, request, ...rest);
        };
        try {
            layoutMod.resetLayoutForTests();
            assert.equal(WsPaths.aiRoot, path.join(top, '_ai'), 'the layout is computed with the module loaded before');
            assert.equal(layoutMod.getLayout()?.root, top);
        } finally {
            Module._load = load;
        }
    });

    test('the first folder wins; an active editor in the second folder changes nothing', () => {
        const fileInSecond = path.join(second, 'x.ts');
        vscodeStub.window.activeTextEditor = { document: { uri: { fsPath: fileInSecond, scheme: 'file' } } };
        vscodeStub.workspace.getWorkspaceFolder = () => ({ uri: { fsPath: second, scheme: 'file' } });
        assert.equal(WsPaths.wsRoot, ws);
        assert.equal(WsPaths.tomRoot, top);
        assert.equal(WsPaths.aiRoot, path.join(top, '_ai'));
        assert.equal(WsPaths.ai('quests'), path.join(top, '_ai', 'quests'));
        assert.equal(WsPaths.wsConfig(WsPaths.configFileName), path.join(top, '.tom', 'tom_vscode_extension.json'));
    });

    test('getResolverVariables: ${tomRoot}, _ai and the config folder from the layout', () => {
        const v = WsPaths.getResolverVariables();
        assert.equal(v.tomRoot, top);
        assert.equal(v.aiPath, path.join(top, '_ai'));
        assert.equal(v.ai, path.join(top, '_ai'));
        assert.equal(v.questsPath, path.join(top, '_ai', 'quests'));
        assert.equal(v.wsConfigPath, path.join(top, '.tom'));
    });

    test('tomAi.layout.* settings are honoured', () => {
        installVscodeStub({ configuration: { tomAi: { 'layout.root': second, 'layout.aiFolder': path.join(second, '_ai'), 'layout.configFolder': '.cfg' } } });
        const l = layoutMod.getLayout()!;
        assert.equal(l.root, second);
        assert.equal(WsPaths.aiRoot, path.join(second, '_ai'));
        assert.deepEqual(l.configLayers, [path.join(second, '.tom'), path.join(ws, '.cfg')]);
    });

    test('the tomAi.aiFolder alias; the default _ai does not count as an override', () => {
        fs.mkdirSync(path.join(ws, 'old_ai'), { recursive: true });
        installVscodeStub({ configuration: { tomAi: { aiFolder: 'old_ai' } } });
        assert.equal(WsPaths.aiRoot, path.join(ws, 'old_ai'));
        assert.equal(WsPaths.aiFolder, 'old_ai');
        installVscodeStub({ configuration: { tomAi: { aiFolder: '_ai' } } });
        assert.equal(WsPaths.aiRoot, path.join(top, '_ai'));
    });

    test('a marker file change recomputes the layout and fires onDidChangeLayout', () => {
        const seen: string[] = [];
        const sub = layoutMod.onDidChangeLayout((l) => { if (l) { seen.push(l.root); } });
        vscodeStub.workspace.onDidChangeWorkspaceFolders ??= () => ({ dispose() { /* none */ } });
        layoutMod.registerLayoutTracking({ subscriptions: [] });
        assert.equal(layoutMod.getLayout()!.root, top);
        fs.mkdirSync(path.join(ws, '.tom'), { recursive: true });
        fs.writeFileSync(path.join(ws, '.tom', 'tom_root.yaml'), 'version: 1\n');
        const watcher = stubFileWatchers().filter((w) => !w.disposed).at(0) as unknown as { fireCreate(): void };
        watcher.fireCreate();
        assert.equal(layoutMod.getLayout()!.root, ws);
        assert.deepEqual(seen, [ws]);
        sub.dispose();
        fs.rmSync(path.join(ws, '.tom'), { recursive: true });
    });
});
