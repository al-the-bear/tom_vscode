/**
 * The MD Browser's link resolver (src/utils/linkResolver.ts) on file links.
 *
 *   LR-1 a relative link resolves against the current file's folder
 *   LR-2 a link to a path with a space, written `%20` as Markdown renders it, resolves to the file
 *        (the href arrives URL-encoded; it was looked up literally and reported "File not found")
 *   LR-3 a file whose name really holds `%20` is still found as written
 *   LR-4 a link that names no file is an error, with the path as written
 *   LR-5 the fragment-by-id step (05b_rdv1): a link whose fragment is a section id the target Markdown carries — a
 *        heading's `<!--[ID]-->`, an element's `id="ID"`, a table row's first cell — is marked `anchorById`, in
 *        another file (`file.tomspecs.md#ID`) and in the same one (`#ID`); a fragment that is no section id, or not
 *        in the target, stays a plain anchor; `markdownHasSectionId` on its own
 */

import test, { describe } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import { installVscodeStub } from '../../tools/__tests__/_vscode-stub.js';

const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'link-resolver-'));
installVscodeStub({ workspaceFolders: [ROOT] });

import { markdownHasSectionId, resolveLink } from '../linkResolver.js';

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

    test('LR-5: fragments by section id', () => {
        const spec = path.join(ROOT, 'designs', 'x', 'grant.tomspecs.md');
        fs.writeFileSync(spec, [
            '###### <!--[DAENT-ENTI-GRANT]--> Grant', '',
            '<div class="heading7"><!--[RQDEP-ITEM-1]--> <a id="RQDEP-ITEM-1"></a> Dependency</div>', '',
            '::: {.records}', '| Id | Mandatory |', '| --- | --- |', '| DATAA-CONS-ROLE | For role grants |', ':::', '',
            '## Intro', '',
        ].join('\n'));
        for (const id of ['DAENT-ENTI-GRANT', 'RQDEP-ITEM-1', 'DATAA-CONS-ROLE']) {
            const r = resolveLink(`grant.tomspecs.md#${id}`, ctx);
            assert.equal(r.action, 'navigate-md-anchor', id);
            assert.equal(r.anchorById, true, `${id}: by id`);
        }
        assert.equal(resolveLink('grant.tomspecs.md#intro', ctx).anchorById, undefined, 'a slug stays a plain anchor');
        assert.equal(resolveLink('grant.tomspecs.md#NOT-THERE', ctx).anchorById, undefined, 'an id the target does not carry too');
        const inSpec = { currentFilePath: spec, workspaceRoot: ROOT };
        assert.deepEqual(resolveLink('#DATAA-CONS-ROLE', inSpec), { type: 'anchor', action: 'scroll-to-anchor', anchor: 'DATAA-CONS-ROLE', anchorById: true }, 'in the same file');
        assert.deepEqual(resolveLink('#intro', inSpec), { type: 'anchor', action: 'scroll-to-anchor', anchor: 'intro' });
        assert.equal(markdownHasSectionId('| ACE-CRIT-3 | x |', 'ACE-CRIT-3'), true, 'a row\'s first cell');
        assert.equal(markdownHasSectionId('| x | ACE-CRIT-3 |', 'ACE-CRIT-3'), false, 'not another cell');
        assert.equal(markdownHasSectionId('text ACE-CRIT-3', 'ACE-CRIT-3'), false, 'a mention is no anchor');
        assert.equal(markdownHasSectionId('<!--[intro]-->', 'intro'), false, 'no section id');
    });
});
