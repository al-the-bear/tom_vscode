/**
 * No test writes outside its sandbox. The tests build their sandbox workspaces under the container's `ztmp/`,
 * inside the real Tom root's tree: without a root marker of its own, the layout's walk up from such a sandbox
 * reaches the real root, and the configuration (`.tom/tom_vscode_extension.json`), `_ai` and the guidelines
 * resolve there. A test once wrote an `editorListOrder` entry into the real configuration that way.
 *
 *   SI-1 a sandbox workspace folder under `ztmp/` without a marker becomes a root of its own when the vscode stub
 *        takes it (`isolateSandboxWorkspace`): the layout's root, the workspace configuration and `_ai` resolve
 *        inside it; a sandbox with a root of its own (a marker above the folder, inside the sandbox) is left as it
 *        is, and a folder outside a `ztmp/` directory is never touched
 *   SI-2 a representative sandbox test (chatPanelRuns, whose sandbox has no marker of its own) run in a child
 *        process leaves the real root's configuration and the home fallback configuration
 *        (`~/.tom/vscode/tom_vscode_extension.json`) byte for byte as they were
 *   SI-3 a configuration save from a sandbox without a marker of its own (the layout that wrote the real file)
 *        lands in the sandbox's `.tom/tom_vscode_extension.json`; the real files are unchanged
 */

import test, { after, describe } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import { installVscodeStub, isolateSandboxWorkspace } from '../../tools/__tests__/_vscode-stub.js';

const EXT = path.join(__dirname, '..', '..', '..');

/** The real root: the nearest folder above the checkout holding `.tom/tom_root.yaml`. */
function realRoot(): string | undefined {
    let dir = EXT;
    for (;;) {
        if (fs.existsSync(path.join(dir, '.tom', 'tom_root.yaml'))) { return dir; }
        const up = path.dirname(dir);
        if (up === dir) { return undefined; }
        dir = up;
    }
}

const ROOT = realRoot();
const SANDBOX = fs.realpathSync(fs.mkdtempSync(path.join(EXT, '..', '..', '..', 'ztmp', 'vscode_extension_261126_01_aifmt-7_isolation-')));
after(() => fs.rmSync(SANDBOX, { recursive: true, force: true }));

describe('test sandboxes stay inside', () => {
    test('SI-1: a sandbox under ztmp/ is a root of its own', { skip: ROOT ? false : 'no Tom root around this checkout' }, async () => {
        const ws = path.join(SANDBOX, 'plain');
        fs.mkdirSync(path.join(ws, '_ai'), { recursive: true });
        installVscodeStub({ workspaceFolders: [ws] });
        assert.ok(fs.existsSync(path.join(ws, '.tom', 'tom_root.yaml')), 'the stub wrote the marker');
        const { recomputeLayout } = await import('../workspaceLayout.js');
        const { WsPaths } = await import('../workspacePaths.js');
        const layout = recomputeLayout();
        assert.equal(layout?.root, ws, 'the root is the sandbox, not the real root');
        assert.ok(WsPaths.wsConfig(WsPaths.configFileName)!.startsWith(ws + path.sep), 'the configuration is inside the sandbox');
        assert.ok(WsPaths.aiRoot!.startsWith(ws + path.sep), '_ai is inside the sandbox');

        // A sandbox with a root of its own inside is left as it is.
        const own = path.join(SANDBOX, 'own');
        fs.mkdirSync(path.join(own, '.tom'), { recursive: true });
        fs.writeFileSync(path.join(own, '.tom', 'tom_root.yaml'), 'root: true\n');
        fs.mkdirSync(path.join(own, 'ws'), { recursive: true });
        assert.equal(isolateSandboxWorkspace(path.join(own, 'ws')), false);
        assert.equal(fs.existsSync(path.join(own, 'ws', '.tom')), false);

        // A folder outside a ztmp/ directory is never touched (the extension's own folder, for one).
        assert.equal(isolateSandboxWorkspace(EXT), false);
        assert.equal(fs.existsSync(path.join(EXT, '.tom', 'tom_root.yaml')), false);
    });

    test('SI-2: a sandbox test leaves the real configuration as it was', { skip: ROOT ? false : 'no Tom root around this checkout', timeout: 300_000 }, () => {
        const guarded = [
            path.join(ROOT!, '.tom', 'tom_vscode_extension.json'),
            path.join(os.homedir(), '.tom', 'vscode', 'tom_vscode_extension.json'),
        ];
        const snapshot = (): Array<string | undefined> => guarded.map((f) => (fs.existsSync(f) ? fs.readFileSync(f, 'utf8') : undefined));
        const before = snapshot();
        const representative = path.join(EXT, 'out', 'handlers', '__tests__', 'chatPanelRuns.test.js');
        assert.ok(fs.existsSync(representative), 'the representative test is compiled');
        const run = spawnSync(process.execPath, ['--test', representative], { cwd: EXT, encoding: 'utf8', timeout: 240_000 });
        assert.equal(run.status, 0, `the representative test passes:\n${run.stdout}\n${run.stderr}`);
        const afterRun = snapshot();
        guarded.forEach((file, i) => {
            assert.equal(afterRun[i], before[i], `${file} was changed by a test run`);
        });
    });

    test('SI-3: a configuration save from a marker-less sandbox stays in the sandbox', { skip: ROOT ? false : 'no Tom root around this checkout' }, async () => {
        const guarded = [
            path.join(ROOT!, '.tom', 'tom_vscode_extension.json'),
            path.join(os.homedir(), '.tom', 'vscode', 'tom_vscode_extension.json'),
        ];
        const snapshot = (): Array<string | undefined> => guarded.map((f) => (fs.existsSync(f) ? fs.readFileSync(f, 'utf8') : undefined));
        const before = snapshot();
        const ws = path.join(SANDBOX, 'writer');
        fs.mkdirSync(path.join(ws, '.tom'), { recursive: true });
        fs.writeFileSync(path.join(ws, '.tom', 'tom_vscode_extension.json'), '{}\n');
        installVscodeStub({ workspaceFolders: [ws] });
        const { recomputeLayout } = await import('../workspaceLayout.js');
        recomputeLayout();
        const { TomAiConfiguration } = await import('../tomAiConfiguration.js');
        const storage = path.join(SANDBOX, 'storage');
        fs.mkdirSync(storage, { recursive: true });
        TomAiConfiguration.init({ subscriptions: [], globalStorageUri: { fsPath: storage }, extensionPath: EXT } as never);
        await TomAiConfiguration.instance.updateSection('sandboxIsolationProbe', { written: true });
        const own = JSON.parse(fs.readFileSync(path.join(ws, '.tom', 'tom_vscode_extension.json'), 'utf8')) as Record<string, unknown>;
        assert.deepEqual(own.sandboxIsolationProbe, { written: true }, 'the save went into the sandbox');
        const afterSave = snapshot();
        guarded.forEach((file, i) => {
            assert.equal(afterSave[i], before[i], `${file} was changed by a sandbox save`);
        });
    });
});
