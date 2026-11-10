/**
 * The MD Browser's link resolver (src/utils/linkResolver.ts) on file links.
 *
 *   LR-1 a relative link resolves against the current file's folder
 *   LR-2 a link to a path with a space, written `%20` as Markdown renders it, resolves to the file
 *        (the href arrives URL-encoded; it was looked up literally and reported "File not found")
 *   LR-3 a file whose name really holds `%20` is still found as written
 *   LR-4 a link that names no file is an error, with the path as written
 */

import test, { describe } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import { installVscodeStub } from '../../tools/__tests__/_vscode-stub.js';

const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'link-resolver-'));
installVscodeStub({ workspaceFolders: [ROOT] });

import { resolveLink } from '../linkResolver.js';

const DOC = path.join(ROOT, 'designs', 'x', 'x.md');
fs.mkdirSync(path.join(ROOT, 'designs', 'x', '01_Intent', '01_Questions Round'), { recursive: true });
fs.writeFileSync(DOC, '# x\n');
fs.writeFileSync(path.join(ROOT, 'designs', 'x', '01_Intent', '01_Questions Round', 'answers.md'), '# a\n');
fs.writeFileSync(path.join(ROOT, 'designs', 'literal%20name.md'), '# l\n');

const ctx = { currentFilePath: DOC, workspaceRoot: ROOT };

describe('linkResolver: file links', () => {
    test('LR-1: a relative link resolves against the current file', () => {
        const r = resolveLink('../x/x.md', ctx);
        assert.notEqual(r.action, 'error', r.error);
        assert.equal(r.filePath, DOC);
    });

    test('LR-2: %20 in a link is a space', () => {
        const r = resolveLink('01_Intent/01_Questions%20Round/answers.md', ctx);
        assert.notEqual(r.action, 'error', r.error);
        assert.equal(r.filePath, path.join(ROOT, 'designs', 'x', '01_Intent', '01_Questions Round', 'answers.md'));
    });

    test('LR-3: a name that really holds %20 is found as written', () => {
        const r = resolveLink('../literal%20name.md', ctx);
        assert.equal(r.filePath, path.join(ROOT, 'designs', 'literal%20name.md'));
    });

    test('LR-4: a link to no file is an error naming the path', () => {
        const r = resolveLink('nowhere%20at%20all.md', ctx);
        assert.equal(r.action, 'error');
        assert.match(r.error ?? '', /nowhere/);
    });
});
