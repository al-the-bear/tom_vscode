/**
 * tomAi_findFiles skips what git ignores, under the same rules as tomAi_findTextInFiles (src/tools/file-primitives.ts,
 * `walkFiles` with `gitignore`), as Claude Code's Glob (ripgrep --files) does.
 *
 *   FG-1 the root .gitignore: an ignored folder and an ignored file type are not listed; `includeIgnored: true`
 *        lists them; a glob matching only ignored files says they were skipped
 *   FG-2 a glob with a fixed folder in front (`pkg/src/*.ts`, `pkg/` then `**`) walks from that folder and gives what a walk from the
 *        root gives; one whose folder git ignores lists nothing, unless `includeIgnored`
 *   FG-3 a repository of its own (reached through a symlink, as `_ai` is) is listed under its own rules
 *   FG-4 the same files as the text search: what findFiles lists for every file is what findTextInFiles searches
 *   FG-5 the registered tool walks the workspace (not VS Code's search): ignored files are not listed
 */

import test, { after, describe } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import { writeFile } from './_fixtures.js';
import { installVscodeStub } from './_vscode-stub.js';

const roots: string[] = [];
/** A fresh folder that is a repository root (`.git` present), outside every other repository. */
function repo(): string {
    const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'find-files-gitignore-')));
    roots.push(root);
    fs.mkdirSync(path.join(root, '.git', 'info'), { recursive: true });
    return root;
}
const WS = repo();
const stubbed = installVscodeStub({ workspaceFolders: [WS] });

import { findFilesImpl, findTextInFilesImpl } from '../file-primitives.js';
import { FIND_FILES_TOOL } from '../tool-executors.js';

after(() => { stubbed.restore(); for (const r of roots) { fs.rmSync(r, { recursive: true, force: true }); } });

const lines = (out: string): string[] => out.split('\n').filter((l) => l && !l.startsWith('No files') && !l.startsWith('  ')).sort();

/** The fixture: build output and scratch ignored, a log type ignored, a nested repository linked in. */
function fixture(root: string): void {
    writeFile(root, '.gitignore', 'build/\nztmp/\n*.log\n');
    writeFile(root, 'pkg/src/a.ts', 'needle');
    writeFile(root, 'pkg/src/b.ts', 'needle');
    writeFile(root, 'pkg/build/out.ts', 'needle');
    writeFile(root, 'ztmp/scratch.ts', 'needle');
    writeFile(root, 'notes.md', 'needle');
    writeFile(root, 'debug.log', 'needle');
    const own = repo();
    writeFile(own, '.gitignore', 'secret/\n');
    writeFile(own, 'state.md', 'needle');
    writeFile(own, 'secret/x.md', 'needle');
    fs.symlinkSync(own, path.join(root, 'mounted'));
    fs.appendFileSync(path.join(root, '.gitignore'), 'mounted\n');
}
fixture(WS);

describe('findFiles honours .gitignore', () => {
    test('FG-1: the root .gitignore, and includeIgnored', async () => {
        assert.deepEqual(lines(await findFilesImpl({ wsRoot: WS }, { pattern: '**/*.ts' })), ['pkg/src/a.ts', 'pkg/src/b.ts']);
        assert.deepEqual(lines(await findFilesImpl({ wsRoot: WS }, { pattern: '**/*.ts', includeIgnored: true })),
            ['pkg/build/out.ts', 'pkg/src/a.ts', 'pkg/src/b.ts', 'ztmp/scratch.ts']);
        const none = await findFilesImpl({ wsRoot: WS }, { pattern: '**/*.log' });
        assert.match(none, /No files found matching: \*\*\/\*\.log/);
        assert.match(none, /git ignores were skipped — `includeIgnored: true`/);
        assert.deepEqual(lines(await findFilesImpl({ wsRoot: WS }, { pattern: '**/*.log', includeIgnored: true })), ['debug.log']);
    });

    test('FG-2: a fixed folder in front of the glob', async () => {
        assert.deepEqual(lines(await findFilesImpl({ wsRoot: WS }, { pattern: 'pkg/**/*.ts' })), ['pkg/src/a.ts', 'pkg/src/b.ts']);
        assert.deepEqual(lines(await findFilesImpl({ wsRoot: WS }, { pattern: 'pkg/src/*.ts' })), ['pkg/src/a.ts', 'pkg/src/b.ts']);
        assert.match(await findFilesImpl({ wsRoot: WS }, { pattern: 'ztmp/**/*.ts' }), /No files found/, 'an ignored folder');
        assert.deepEqual(lines(await findFilesImpl({ wsRoot: WS }, { pattern: 'ztmp/**/*.ts', includeIgnored: true })), ['ztmp/scratch.ts']);
        assert.match(await findFilesImpl({ wsRoot: WS }, { pattern: 'nope/**/*.ts' }), /No files found/, 'a folder that is not there');
    });

    test('FG-3: a repository of its own, through a symlink', async () => {
        assert.deepEqual(lines(await findFilesImpl({ wsRoot: WS }, { pattern: '**/*.md' })), ['mounted/state.md', 'notes.md']);
        assert.deepEqual(lines(await findFilesImpl({ wsRoot: WS }, { pattern: 'mounted/**' })), ['mounted/.gitignore', 'mounted/state.md']);
    });

    test('FG-4: the same files as the text search', async () => {
        for (const includeIgnored of [false, true]) {
            const listed = lines(await findFilesImpl({ wsRoot: WS }, { pattern: '**/*', includeIgnored, maxResults: 1000 }))
                .filter((p) => !p.endsWith('.gitignore'));
            const text = await findTextInFilesImpl({ wsRoot: WS }, { searchText: 'needle', includeIgnored, maxResults: 1000 });
            const searched = [...new Set(text.split('\n').filter((l) => /^[^:]+:\d+:/.test(l)).map((l) => l.split(':')[0]))].sort();
            assert.deepEqual(listed, searched, `includeIgnored: ${includeIgnored}`);
        }
    });

    test('FG-5: the registered tool walks the workspace', async () => {
        const out = await FIND_FILES_TOOL.execute({ pattern: '**/*.ts' });
        assert.deepEqual(lines(out), ['pkg/src/a.ts', 'pkg/src/b.ts']);
    });
});
