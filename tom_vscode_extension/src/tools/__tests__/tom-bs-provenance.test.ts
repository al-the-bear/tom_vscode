/**
 * Which bridge source a prebuilt tom_bs was built from (scripts/check-tom-bs-provenance.cjs, vscimpa15).
 *
 *   TP-1 the versioner stamp is read from tom_bs's start-up line (`[BSTART] Version: …`); none → null
 *   TP-2 the verdict: fresh when no bridge source changed since the stamp's commit, stale naming the files,
 *        unknown without a stamp or when the commit is not in the checkout
 *   TP-3 the comparison over a git repository: a change after the commit makes it stale; a change that only
 *        rewrites a `// Generated:` line, or the versioner stamp, does not; an unknown commit is null
 *   TP-4 the stamp is read by starting the binary with an empty stdin
 *   TP-5 the prebuilt install routes run it as a warning, after bundling
 */

import test, { describe } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { execFileSync } from 'child_process';

const EXT_ROOT = path.resolve(__dirname, '..', '..', '..');
// eslint-disable-next-line @typescript-eslint/no-require-imports
const prov = require(path.join(EXT_ROOT, 'scripts', 'check-tom-bs-provenance.cjs')) as {
    parseBridgeStamp(output: string): { version: string; build: number; commit: string; buildTime: string; dart: string | null } | null;
    judgeProvenance(o: { stamp: unknown; changedFiles: string[] | null }): { state: string; message: string };
    readStamp(binary: string): { commit: string } | null;
    changedSince(commit: string, repo: string): string[] | null;
};

const LINE = '[BSTART] Version: 1.0.0+38.42e69c0 (2026-10-02T17:21:39.880116Z) [Dart 3.12.2]';

describe('tom_bs provenance', () => {
    test('TP-1: the stamp', () => {
        assert.deepEqual(prov.parseBridgeStamp(`[D4RT] ready\n${LINE}\n[BSTART] Binary: /x`),
            { version: '1.0.0', build: 38, commit: '42e69c0', buildTime: '2026-10-02T17:21:39.880116Z', dart: '3.12.2' });
        assert.equal(prov.parseBridgeStamp('[BSTART] Version: 1.0.0+5.abcdef1 (t)')?.dart, null);
        assert.equal(prov.parseBridgeStamp('[D4RT] ready'), null);
    });

    test('TP-2: the verdict', () => {
        const stamp = prov.parseBridgeStamp(LINE);
        assert.equal(prov.judgeProvenance({ stamp, changedFiles: [] }).state, 'fresh');
        const stale = prov.judgeProvenance({ stamp, changedFiles: ['tom_vscode_bridge/lib/src/d4rt_bridges/tom_vscode_bridge_bridges.b.dart'] });
        assert.equal(stale.state, 'stale');
        assert.match(stale.message, /42e69c0/);
        assert.match(stale.message, /lib\/src\/d4rt_bridges\/tom_vscode_bridge_bridges\.b\.dart/);
        assert.match(stale.message, /compile_and_install/);
        assert.equal(prov.judgeProvenance({ stamp, changedFiles: null }).state, 'unknown');
        assert.equal(prov.judgeProvenance({ stamp: null, changedFiles: [] }).state, 'unknown');
    });

    test('TP-3: the comparison over a repository', () => {
        const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'tp-repo-'));
        const git = (...args: string[]): string => execFileSync('git', args, { cwd: repo, encoding: 'utf8' }).trim();
        const put = (rel: string, text: string): void => {
            fs.mkdirSync(path.dirname(path.join(repo, rel)), { recursive: true });
            fs.writeFileSync(path.join(repo, rel), text);
        };
        git('init', '-q');
        git('config', 'user.email', 't@t');
        git('config', 'user.name', 't');
        put('tom_vscode_bridge/lib/a.b.dart', '// Generated: 2026-10-01 by gen\nclass A {}\n');
        put('tom_vscode_bridge/lib/src/version.versioner.dart', "const gitCommit = 'x';\n");
        put('tom_vscode_bridge/pubspec.yaml', 'name: tom_vscode_bridge\n');
        put('tom_vscode_bridge/test/t.dart', 'void main() {}\n');
        git('add', '.');
        git('commit', '-qm', 'built from here');
        const built = git('rev-parse', '--short', 'HEAD');

        put('tom_vscode_bridge/lib/a.b.dart', '// Generated: 2026-10-13 by gen\nclass A {}\n');
        put('tom_vscode_bridge/lib/src/version.versioner.dart', "const gitCommit = 'y';\n");
        put('tom_vscode_bridge/test/t.dart', 'void main() { /* changed */ }\n');
        git('commit', '-qam', 'stamps and tests only');
        assert.deepEqual(prov.changedSince(built, repo), [], 'stamp lines, the versioner and tests do not count');

        put('tom_vscode_bridge/lib/a.b.dart', '// Generated: 2026-10-14 by gen\nclass A { void streamQuery() {} }\n');
        git('commit', '-qam', 'regenerated with a new member');
        assert.deepEqual(prov.changedSince(built, repo), ['tom_vscode_bridge/lib/a.b.dart']);
        assert.equal(prov.changedSince('0123456', repo), null, 'a commit the checkout does not have');
    });

    test('TP-4: the stamp from the binary', (t) => {
        if (process.platform === 'win32') { t.skip('the fake binary is a shell script'); return; }
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tp-bin-'));
        const fake = path.join(dir, 'tom_bs');
        fs.writeFileSync(fake, `#!/bin/sh\necho '[D4RT] ready'\necho '${LINE}'\ncat > /dev/null\n`);
        fs.chmodSync(fake, 0o755);
        assert.equal(prov.readStamp(fake)?.commit, '42e69c0', 'started with an empty stdin, it ends and the stamp is read');
    });

    test('TP-5: the install routes run it', () => {
        const sh = fs.readFileSync(path.join(EXT_ROOT, 'install_extension.sh'), 'utf8');
        const ps1 = fs.readFileSync(path.join(EXT_ROOT, 'install_extension.ps1'), 'utf8');
        for (const [name, text] of [['install_extension.sh', sh], ['install_extension.ps1', ps1]] as const) {
            const at = text.indexOf('check-tom-bs-provenance.cjs');
            assert.ok(at > 0, `${name} runs it`);
            assert.ok(at > text.indexOf('Bundling bridge binaries') && text.indexOf('Bundling bridge binaries') > 0, `${name}: after bundling, in the prebuilt route`);
        }
    });
});
