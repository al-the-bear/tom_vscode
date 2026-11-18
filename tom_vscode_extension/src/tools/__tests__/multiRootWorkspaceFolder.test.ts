/**
 * A multi-root window: every site that means the workspace folder stays on
 * the window's first folder whatever editor is active (02_wslayout-2), and
 * the file tools resolve a relative path against the first folder while
 * accepting an absolute path in any root folder of the window.
 *
 *   MR-1 an active editor in the second folder leaves the workspace folder on the first
 *   MR-2 file tools: relative against the first folder, absolute in the second accepted
 *   MR-3 file tools: an absolute path outside every root folder is refused
 *   MR-4 the source: no local workspace-root copy left in tool-executors.ts
 */

import { test, describe } from 'node:test';
import * as assert from 'node:assert/strict';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { installVscodeStub } from './_vscode-stub.js';

const first = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'mr-first-')));
const second = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'mr-second-')));
const outside = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'mr-outside-')));
fs.writeFileSync(path.join(first, 'a.txt'), 'first file\n');
fs.writeFileSync(path.join(second, 'b.txt'), 'second file\n');
fs.writeFileSync(path.join(outside, 'c.txt'), 'outside\n');

const handle = installVscodeStub({ workspaceFolders: [first, second] });
const stub = handle.stub as { window: Record<string, unknown>; workspace: Record<string, unknown> };

// eslint-disable-next-line @typescript-eslint/no-require-imports
const shared = require('../../handlers/handler_shared.js') as typeof import('../../handlers/handler_shared.js');
// eslint-disable-next-line @typescript-eslint/no-require-imports
const tools = require('../tool-executors.js') as typeof import('../tool-executors.js');
// eslint-disable-next-line @typescript-eslint/no-require-imports
const layout = require('../../utils/workspaceLayout.js') as typeof import('../../utils/workspaceLayout.js');

function activeEditorInSecond(): void {
    stub.window.activeTextEditor = { document: { uri: { fsPath: path.join(second, 'b.txt'), scheme: 'file' } } };
    stub.workspace.getWorkspaceFolder = () => ({ uri: { fsPath: second, scheme: 'file' }, name: path.basename(second) });
}

describe('multi-root window: the workspace folder is the first folder', () => {
    test('MR-1: an active editor in the second folder changes nothing', () => {
        installVscodeStub({ workspaceFolders: [first, second] });
        layout.resetLayoutForTests();
        activeEditorInSecond();
        assert.equal((shared as Record<string, unknown>).getWorkspaceRoot, undefined, 'removed: the layout answers the workspace folder');
        assert.equal(layout.layoutWorkspaceFolder(), first);
        assert.deepEqual(layout.layoutExtraRootFolders(), [second]);
    });

    test('MR-2: file tools resolve relative paths against the first folder, accept absolute ones in the second', async () => {
        installVscodeStub({ workspaceFolders: [first, second] });
        layout.resetLayoutForTests();
        activeEditorInSecond();
        const rel = await tools.READ_FILE_TOOL.execute({ filePath: 'a.txt' });
        assert.match(String(rel), /first file/);
        const relInSecond = await tools.READ_FILE_TOOL.execute({ filePath: 'b.txt' });
        assert.doesNotMatch(String(relInSecond), /second file/, 'a relative path is not looked up in the second folder');
        const abs = await tools.READ_FILE_TOOL.execute({ filePath: path.join(second, 'b.txt') });
        assert.match(String(abs), /second file/);
        const created = await tools.CREATE_FILE_TOOL.execute({ filePath: path.join(second, 'new.txt'), content: 'x' });
        assert.doesNotMatch(String(created), /outside the workspace/);
        assert.equal(fs.existsSync(path.join(second, 'new.txt')), true);
    });

    test('MR-3: an absolute path outside every root folder is refused', async () => {
        installVscodeStub({ workspaceFolders: [first, second] });
        layout.resetLayoutForTests();
        const res = await tools.READ_FILE_TOOL.execute({ filePath: path.join(outside, 'c.txt') });
        assert.match(String(res), /outside the workspace/);
    });

    test('MR-4: tool-executors.ts has no workspace-root copy of its own', () => {
        const src = fs.readFileSync(path.join(__dirname, '..', '..', '..', 'src', 'tools', 'tool-executors.ts'), 'utf8');
        assert.doesNotMatch(src, /function getWorkspaceRoot\(/);
        assert.doesNotMatch(src, /workspaceFolders\?\.\[0\]/);
        assert.match(src, /return layoutWorkspaceFolder\(\) \?\? '';/);
    });
});
