/**
 * CLAUDE.md loaded as Claude Code loads it, for the transports without
 * Claude Code (ccparity_d_claudecode-4, CC-14 (a)): services/claudeMd.ts and
 * the `${claudeMd}` placeholder.
 *
 *   CM-1 the order over a fixture tree: the user-level `~/.claude/CLAUDE.md`, then every folder from the
 *        farthest ancestor down to the working folder — its CLAUDE.md, then its CLAUDE.local.md; the working
 *        folder's chain reaches the workspace root and goes on above it, as Claude Code's does
 *   CM-2 `@imports`: a path after `@` (relative to the importing file, `~/…`, absolute) that names a file is
 *        loaded right after its importer, nested up to five levels; a cycle loads each file once; a mention
 *        that is no file, and `@` inside inline code or a fenced block, import nothing
 *   CM-3 rendering: each file under "Contents of <path> (<kind>):"; nothing when there is no file
 *   CM-4 the working folder defaults to the workspace root; one outside the workspace is not used
 *   CM-5 `${claudeMd}` resolves to the rendering for the workspace folder
 */

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import test, { describe } from 'node:test';
import assert from 'node:assert/strict';

import { installVscodeStub } from '../../tools/__tests__/_vscode-stub.js';
installVscodeStub({});

// Safe to import after the stub is wired into the resolver.
import { collectClaudeMd, renderClaudeMd } from '../claudeMd';
import { resolveVariables } from '../../utils/variableResolver';

const base = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'claude-md-')));
const home = path.join(base, 'home');
const top = path.join(base, 'top');
const ws = path.join(top, 'ws');
const sub = path.join(ws, 'sub');
const write = (abs: string, text: string): void => {
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, text);
};

write(path.join(home, '.claude', 'CLAUDE.md'), 'USER rules. See @~/.claude/extra.md\n');
write(path.join(home, '.claude', 'extra.md'), 'USER EXTRA\n');
write(path.join(top, 'CLAUDE.md'), 'TOP rules\n');
write(path.join(ws, 'CLAUDE.md'), [
    'WS rules, style in @docs/style.md and @a.md.',
    'Ask @someone, not a file. Literal `@docs/inline.md` stays.',
    '```',
    '@docs/fenced.md',
    '```',
].join('\n'));
write(path.join(ws, 'CLAUDE.local.md'), 'WS LOCAL\n');
write(path.join(ws, 'docs', 'style.md'), 'STYLE, deeper: @../deep.md\n');
write(path.join(ws, 'deep.md'), 'DEEP\n');
write(path.join(ws, 'docs', 'inline.md'), 'INLINE (must not load)\n');
write(path.join(ws, 'docs', 'fenced.md'), 'FENCED (must not load)\n');
write(path.join(ws, 'a.md'), 'A imports @b.md\n');
write(path.join(ws, 'b.md'), 'B imports @a.md\n');
write(path.join(sub, 'CLAUDE.md'), 'SUB rules\n');

describe('CLAUDE.md as Claude Code loads it', () => {
    test('CM-1: the order', () => {
        const sources = collectClaudeMd({ wsRoot: ws, workingDir: sub, homeDir: home });
        const contents = sources.map((s) => s.content.trim().split(/[ ,.\n]/)[0]);
        assert.deepEqual(contents, ['USER', 'USER', 'TOP', 'WS', 'STYLE', 'DEEP', 'A', 'B', 'WS', 'SUB']);
        assert.deepEqual(sources.map((s) => s.kind), ['user', 'import', 'project', 'project', 'import', 'import', 'import', 'import', 'local', 'project']);
        assert.equal(sources[8].path, path.join(ws, 'CLAUDE.local.md'));
    });

    test('CM-2: imports', () => {
        const sources = collectClaudeMd({ wsRoot: ws, workingDir: ws, homeDir: home });
        const paths = sources.map((s) => s.path);
        assert.ok(paths.includes(path.join(home, '.claude', 'extra.md')), '~/ import');
        assert.ok(paths.includes(path.join(ws, 'deep.md')), 'nested import');
        assert.equal(paths.filter((p) => p === path.join(ws, 'a.md')).length, 1, 'a cycle loads each file once');
        assert.ok(!paths.some((p) => /inline\.md|fenced\.md/.test(p)), 'no import from code');
        assert.equal(sources.find((s) => s.path === path.join(ws, 'deep.md'))!.importedBy, path.join(ws, 'docs', 'style.md'));
        // Five levels at most.
        const chain = path.join(base, 'chain');
        for (let i = 0; i < 8; i++) { write(path.join(chain, `c${i}.md`), `C${i} @c${i + 1}.md\n`); }
        write(path.join(chain, 'CLAUDE.md'), 'ROOT @c0.md\n');
        const deep = collectClaudeMd({ wsRoot: chain, homeDir: path.join(base, 'nohome') });
        assert.deepEqual(deep.map((s) => path.basename(s.path)).filter((n) => n.startsWith('c')), ['c0.md', 'c1.md', 'c2.md', 'c3.md', 'c4.md']);
    });

    test('CM-3: rendering', () => {
        const text = renderClaudeMd(collectClaudeMd({ wsRoot: ws, workingDir: ws, homeDir: home }));
        assert.match(text, new RegExp(`^Contents of ${path.join(home, '.claude', 'CLAUDE.md').replace(/[.*+?^${}()|[\]\\]/g, '\\$&')} \\(user instructions\\):\\n\\nUSER rules`));
        assert.match(text, /\(project instructions\):\n\nWS rules/);
        assert.match(text, /CLAUDE\.local\.md \(private project instructions\):\n\nWS LOCAL/);
        assert.match(text, /style\.md \(imported by .*CLAUDE\.md\):\n\nSTYLE/);
        assert.equal(renderClaudeMd([]), '');
    });

    test('CM-4: the working folder', () => {
        const fromRoot = collectClaudeMd({ wsRoot: ws, homeDir: home }).map((s) => s.content.trim().split(/[ ,.\n]/)[0]);
        assert.ok(!fromRoot.includes('SUB'), 'default: the workspace root');
        const outside = collectClaudeMd({ wsRoot: ws, workingDir: home, homeDir: home }).map((s) => s.content.trim().split(/[ ,.\n]/)[0]);
        assert.deepEqual(outside, fromRoot, 'a folder outside the workspace is not used');
    });

    test('CM-5: the ${claudeMd} placeholder', () => {
        const text = resolveVariables('Base.\n\n${claudeMd}', { values: { workspaceFolder: ws } });
        assert.match(text, /^Base\.\n\nContents of /);
        assert.match(text, /WS rules/);
        assert.match(text, /TOP rules/, 'the chain above the workspace root');
    });
});
