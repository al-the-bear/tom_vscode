/**
 * tomAi_findTextInFiles skips what git ignores, as ripgrep does (src/tools/file-primitives.ts,
 * `walkFiles` with `gitignore`), and reads files asynchronously in batches.
 *
 *   GI-1 the root .gitignore: an ignored folder and an ignored file type are not searched;
 *        `includeIgnored: true` searches them; the no-match answer says ignored files were skipped
 *   GI-2 a nested .gitignore applies relative to its folder, and its `!` re-includes what an outer file ignores
 *   GI-3 a folder that is a repository of its own is searched though the outer .gitignore lists it — also
 *        through a symlink, as the workspace mounts `_ai` — under its own rules, not the outer ones
 *   GI-4 a repository's .git/info/exclude applies; a walk rooted below the repository root reads the
 *        .gitignore files above it up to that root
 *   GI-5 a text file longer than the binary probe is searched whole; a large binary is skipped
 *   GI-6 a regex anchored at line start matches a line in the middle of a file (the whole-file pre-check
 *        never hides a matching line); results keep walk order across read batches
 */

import test, { after, describe } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import { writeFile } from './_fixtures.js';
import { findTextInFilesImpl } from '../file-primitives.js';

const roots: string[] = [];
after(() => { for (const r of roots) { fs.rmSync(r, { recursive: true, force: true }); } });

/** A fresh folder that is a repository root (`.git` present), outside every other repository. */
function repo(): string {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'find-text-gitignore-'));
    roots.push(root);
    fs.mkdirSync(path.join(root, '.git', 'info'), { recursive: true });
    return root;
}

const files = (out: string): string[] =>
    [...new Set(out.split('\n').filter((l) => /^[^:]+:\d+:/.test(l)).map((l) => l.split(':')[0]))].sort();

describe('findTextInFiles honours .gitignore', () => {
    test('GI-1: the root .gitignore, and includeIgnored', async () => {
        const root = repo();
        writeFile(root, '.gitignore', 'build/\n*.log\nztmp/\n');
        writeFile(root, 'src/a.ts', 'NEEDLE in source\n');
        writeFile(root, 'build/out.js', 'NEEDLE in build output\n');
        writeFile(root, 'src/run.log', 'NEEDLE in a log\n');
        writeFile(root, 'ztmp/scratch.md', 'NEEDLE in scratch\n');
        assert.deepEqual(files(await findTextInFilesImpl({ wsRoot: root }, { searchText: 'NEEDLE' })), ['src/a.ts']);
        assert.deepEqual(files(await findTextInFilesImpl({ wsRoot: root }, { searchText: 'NEEDLE', includeIgnored: true })),
            ['build/out.js', 'src/a.ts', 'src/run.log', 'ztmp/scratch.md']);
        const none = await findTextInFilesImpl({ wsRoot: root }, { searchText: 'in build output', filePattern: 'build/**' });
        assert.match(none, /No matches .*files git ignores were skipped — `includeIgnored: true` searches them/);
        const noneAll = await findTextInFilesImpl({ wsRoot: root }, { searchText: 'not anywhere', includeIgnored: true });
        assert.doesNotMatch(noneAll, /git ignores/);
    });

    test('GI-2: nested .gitignore files, and re-including', async () => {
        const root = repo();
        writeFile(root, '.gitignore', '*.gen\n');
        writeFile(root, 'pkg/.gitignore', '/local.txt\n!keep.gen\n');
        writeFile(root, 'pkg/local.txt', 'NEEDLE local\n');
        writeFile(root, 'pkg/sub/local.txt', 'NEEDLE anchored rule only at pkg/\n');
        writeFile(root, 'pkg/keep.gen', 'NEEDLE re-included\n');
        writeFile(root, 'pkg/drop.gen', 'NEEDLE generated\n');
        writeFile(root, 'local.txt', 'NEEDLE outside pkg\n');
        assert.deepEqual(files(await findTextInFilesImpl({ wsRoot: root }, { searchText: 'NEEDLE' })),
            ['local.txt', 'pkg/keep.gen', 'pkg/sub/local.txt']);
    });

    test('GI-3: a repository of its own, also through a symlink', async () => {
        const root = repo();
        writeFile(root, '.gitignore', '/inner\n/mounted\n*.log\n');
        writeFile(root, 'inner/.git/HEAD', 'ref: refs/heads/main\n');
        writeFile(root, 'inner/.gitignore', 'secret/\n');
        writeFile(root, 'inner/notes.md', 'NEEDLE inner\n');
        writeFile(root, 'inner/run.log', 'NEEDLE log in inner (outer rule does not apply)\n');
        writeFile(root, 'inner/secret/x.md', 'NEEDLE ignored by inner\n');
        // Like `_ai`: a clone elsewhere, mounted by a symlink the outer .gitignore lists.
        const elsewhere = fs.mkdtempSync(path.join(os.tmpdir(), 'find-text-gitignore-mount-'));
        roots.push(elsewhere);
        writeFile(elsewhere, '.git/HEAD', 'ref: refs/heads/main\n');
        writeFile(elsewhere, '.gitignore', 'queue/\n');
        writeFile(elsewhere, 'quests/q/todo.yaml', 'NEEDLE quest\n');
        writeFile(elsewhere, 'queue/entry.yaml', 'NEEDLE queue entry\n');
        fs.symlinkSync(elsewhere, path.join(root, 'mounted'), 'dir');
        writeFile(root, 'top.log', 'NEEDLE outer log\n');
        assert.deepEqual(files(await findTextInFilesImpl({ wsRoot: root }, { searchText: 'NEEDLE' })),
            ['inner/notes.md', 'inner/run.log', 'mounted/quests/q/todo.yaml']);
    });

    test('GI-4: .git/info/exclude, and the .gitignore files above the walk root', async () => {
        const root = repo();
        fs.writeFileSync(path.join(root, '.git', 'info', 'exclude'), '*.private\n');
        writeFile(root, '.gitignore', 'cache/\n');
        writeFile(root, 'ws/.gitignore', 'out/\n');
        writeFile(root, 'ws/a.md', 'NEEDLE a\n');
        writeFile(root, 'ws/me.private', 'NEEDLE excluded\n');
        writeFile(root, 'ws/cache/c.md', 'NEEDLE cache\n');
        writeFile(root, 'ws/out/o.md', 'NEEDLE out\n');
        assert.deepEqual(files(await findTextInFilesImpl({ wsRoot: path.join(root, 'ws') }, { searchText: 'NEEDLE' })), ['a.md']);
    });

    test('GI-5: long text files are searched whole; large binaries skipped', async () => {
        const root = repo();
        writeFile(root, 'long.txt', `${'x'.repeat(100)}\n`.repeat(500) + 'NEEDLE at the end\n');
        const bin = Buffer.alloc(200_000, 0x41);
        bin[10] = 0;
        bin.write('NEEDLE', 150_000);
        fs.writeFileSync(path.join(root, 'big.bin'), bin);
        const out = await findTextInFilesImpl({ wsRoot: root }, { searchText: 'NEEDLE' });
        assert.deepEqual(files(out), ['long.txt']);
        assert.match(out, /^long\.txt:501:NEEDLE at the end$/m);
    });

    test('GI-6: an anchored regex in mid-file; walk order across batches', async () => {
        const root = repo();
        writeFile(root, 'mid.md', 'first line\n  indented NEEDLE\nNEEDLE starts this line\nlast\n');
        const out = await findTextInFilesImpl({ wsRoot: root }, { searchText: '^NEEDLE', isRegex: true });
        assert.equal(out, 'mid.md:3:NEEDLE starts this line');
        const many = repo();
        const names = Array.from({ length: 100 }, (_, i) => `f${String(i).padStart(3, '0')}.txt`);
        for (const name of names) { writeFile(many, name, `NEEDLE ${name}\n`); }
        assert.deepEqual((await findTextInFilesImpl({ wsRoot: many }, { searchText: 'NEEDLE', maxResults: 1000 })).split('\n').map((l) => l.split(':')[0]), names);
        assert.equal((await findTextInFilesImpl({ wsRoot: many }, { searchText: 'NEEDLE', maxResults: 40 })).split('\n').length, 40);
    });
});
