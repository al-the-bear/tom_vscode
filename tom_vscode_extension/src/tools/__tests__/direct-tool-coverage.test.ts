/**
 * The tools a direct-API profile works with instead of Claude Code's Read,
 * Edit, Write, Bash, Grep and Glob (ccparity_a_directapi-5).
 *
 * On the Agent SDK a todo walk reads, searches and runs commands with Claude
 * Code's built-ins; on the direct API it has only the `tomAi_*` tools. Every
 * built-in has a stand-in, but three of them fell short of what a todo of this
 * workspace needs:
 *
 *   - `tomAi_findTextInFiles` never entered a symlinked folder — the `_ai`
 *     mount of every workspace is one — and gave up after a fixed number of
 *     files (50 × maxResults), answering "No matches" for text it never read.
 *   - `tomAi_readFile` returned a whole file however large, without line
 *     numbers to cite.
 *   - `tomAi_runCommand` returned up to 10 MB of output to the model.
 *
 *   DT-1 a direct profile has a stand-in for each Claude Code built-in; only
 *        `useBuiltInTools` (Agent SDK) hides them
 *   DT-2 the text search follows a symlinked folder, and a symlink loop ends
 *   DT-3 the text search reads every file it is given (no file cap), and says how many
 *   DT-4 caseInsensitive and contextLines
 *   DT-5 a search stopped by its time budget says that not every file was read
 *   DT-6 generated `.dart_tool` folders are not searched
 *   DT-7 readFile numbers its lines on request
 *   DT-8 readFile without a range stops at 2000 lines or 200 000 characters and says so
 *   DT-9 runCommand returns at most 30 000 characters per stream: head and tail, the middle named
 */

import test, { after, before, describe } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import { installVscodeStub } from './_vscode-stub.js';
installVscodeStub({});

import { findTextInFilesImpl, readFileImpl, READ_FILE_MAX_LINES } from '../file-primitives.js';
import { runCommandImpl, RUN_COMMAND_MAX_RETURNED_CHARS } from '../run-command.js';
import { resolveProfileTools } from '../tool-executors.js';

let root: string;
let outside: string;

function write(rel: string, text: string, base = root): void {
    const abs = path.join(base, rel);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, text);
}

before(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'direct-tools-'));
    outside = fs.mkdtempSync(path.join(os.tmpdir(), 'direct-tools-ai-'));
    // The `_ai` mount: a symlink onto a folder elsewhere.
    write('quests/q/overview.q.md', '# Quest\nThe NEEDLE_IN_AI line.\n', outside);
    fs.symlinkSync(outside, path.join(root, '_ai'));
    // A loop: a folder linking back to the root.
    fs.symlinkSync(root, path.join(root, 'loop'));
    for (let i = 0; i < 300; i++) {
        write(`pkg/d${String(i).padStart(3, '0')}/f.txt`, `file ${i}\n`);
    }
    write('pkg/.dart_tool/gen.txt', 'GENERATED_NEEDLE\n');
    write('notes/case.md', 'alpha\nbeta\nMixed Case Word\ngamma\ndelta\n');
});

after(() => {
    fs.rmSync(root, { recursive: true, force: true });
    fs.rmSync(outside, { recursive: true, force: true });
});

describe('direct tool coverage', () => {
    test('DT-1: a direct profile has a stand-in for each Claude Code built-in', () => {
        const names = new Set(resolveProfileTools({ toolsEnabled: true }).map((t) => t.name));
        const standIns = {
            read: ['tomAi_readFile'],
            edit: ['tomAi_editFile', 'tomAi_multiEditFile'],
            write: ['tomAi_createFile'],
            bash: ['tomAi_runCommand', 'tomAi_runCommandStream', 'tomAi_readCommandOutput', 'tomAi_killCommand'],
            grep: ['tomAi_findTextInFiles'],
            glob: ['tomAi_findFiles', 'tomAi_listDirectory'],
            git: ['tomAi_gitRead', 'tomAi_gitShow', 'tomAi_gitWrite'],
        };
        for (const [builtIn, tools] of Object.entries(standIns)) {
            for (const t of tools) { assert.ok(names.has(t), `${builtIn}: ${t} missing`); }
        }
        const handler = fs.readFileSync(path.join(__dirname, '..', '..', '..', 'src', 'handlers', 'anthropic-handler.ts'), 'utf-8');
        assert.match(handler, /const effectiveTools = profile\.useBuiltInTools\s*\n?\s*\?/,
            'only an Agent SDK profile with useBuiltInTools drops the duplicates');
    });

    test('DT-2: the search follows the _ai symlink; a loop ends', async () => {
        const out = await findTextInFilesImpl({ wsRoot: root }, { searchText: 'NEEDLE_IN_AI' });
        assert.match(out, /^_ai\/quests\/q\/overview\.q\.md:2:The NEEDLE_IN_AI line\.$/m);
        assert.equal(out.split('\n').filter((l) => l.includes('NEEDLE_IN_AI')).length, 1, 'the loop does not repeat a file');
    });

    test('DT-3: every file is read, and the answer says how many', async () => {
        const out = await findTextInFilesImpl({ wsRoot: root }, { searchText: 'NOT_THERE', filePattern: 'pkg/**/*.txt', maxResults: 1 });
        assert.match(out, /scanned 300 files/);
    });

    test('DT-4: caseInsensitive and contextLines', async () => {
        const ci = await findTextInFilesImpl({ wsRoot: root }, { searchText: 'mixed case', caseInsensitive: true, filePattern: 'notes/**' });
        assert.match(ci, /^notes\/case\.md:3:Mixed Case Word$/m);
        const ciRe = await findTextInFilesImpl({ wsRoot: root }, { searchText: 'mixed\\s+case', isRegex: true, caseInsensitive: true, filePattern: 'notes/**' });
        assert.match(ciRe, /notes\/case\.md:3:/);
        const ctx = await findTextInFilesImpl({ wsRoot: root }, { searchText: 'Mixed', contextLines: 1, filePattern: 'notes/**' });
        assert.deepEqual(ctx.split('\n'), ['notes/case.md-2-beta', 'notes/case.md:3:Mixed Case Word', 'notes/case.md-4-gamma']);
    });

    test('DT-5: a search stopped by its time budget says so', async () => {
        const out = await findTextInFilesImpl({ wsRoot: root, timeBudgetMs: 0 }, { searchText: 'NOT_THERE' });
        assert.match(out, /time budget/);
        assert.match(out, /not every file was searched/);
    });

    test('DT-6: .dart_tool is not searched', async () => {
        const out = await findTextInFilesImpl({ wsRoot: root }, { searchText: 'GENERATED_NEEDLE' });
        assert.match(out, /No matches/);
    });

    test('DT-7: line numbers on request', async () => {
        const out = await readFileImpl(root, { filePath: 'notes/case.md', startLine: 2, endLine: 3, lineNumbers: true });
        assert.deepEqual(out.split('\n'), ['     2\tbeta', '     3\tMixed Case Word']);
    });

    test('DT-8: an unbounded read stops at the caps and says so', async () => {
        write('big/lines.txt', Array.from({ length: READ_FILE_MAX_LINES + 500 }, (_, i) => `line ${i + 1}`).join('\n'));
        const out = await readFileImpl(root, { filePath: 'big/lines.txt' });
        const lines = out.split('\n');
        assert.equal(lines[READ_FILE_MAX_LINES - 1], `line ${READ_FILE_MAX_LINES}`);
        assert.match(lines.slice(READ_FILE_MAX_LINES).join('\n'), /lines 1–2000 of 2500 .*startLine/);
        const ranged = await readFileImpl(root, { filePath: 'big/lines.txt', startLine: 2401, endLine: 2500 });
        assert.equal(ranged.split('\n').length, 100, 'an explicit range is returned as asked');
        write('big/wide.txt', 'x'.repeat(300_000));
        const wide = await readFileImpl(root, { filePath: 'big/wide.txt' });
        assert.ok(wide.length < 201_000, `got ${wide.length} characters`);
        assert.match(wide, /200,000 of 300,000 characters/);
    });

    test('DT-9: runCommand returns head and tail of a long output', async () => {
        const out = await runCommandImpl({ wsRoot: root }, {
            command: `node -e "process.stdout.write('HEAD' + 'a'.repeat(100000) + 'TAIL')"`,
        });
        assert.ok(out.length < RUN_COMMAND_MAX_RETURNED_CHARS + 500, `got ${out.length} characters`);
        assert.ok(out.startsWith('HEAD'));
        assert.ok(out.trimEnd().endsWith('TAIL'));
        assert.match(out, /stdout: 100,008 characters, the middle [\d,]+ left out/);
    });
});
