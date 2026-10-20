/**
 * The generated d4rt bridges of tom_vscode_bridge (vscimpa1): a from-source
 * build regenerates them, and the extension's test gate checks they are fresh.
 *
 *   BG-1  a regeneration that changed only the `// Generated:` header lines is no change
 *   BG-2  any other difference is one — a member added, removed or reworded
 *   BG-3  after a regeneration, files whose only change is the header are put back to HEAD;
 *         files with real changes stay changed (to be committed) and are named
 *   BG-4  the freshness check runs the bridge's own BRIDGE-FRESH-01 test in the bridge package
 *   BG-5  the versioner stamp and the build state are put back together when only the stamp moved (build
 *         time, commit, build number, SDK); a changed version keeps both, to be committed
 */

import test, { describe } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

const SCRIPTS = path.join(__dirname, '..', '..', '..', 'scripts');
// eslint-disable-next-line @typescript-eslint/no-require-imports
const churn = require(path.join(SCRIPTS, 'bridge-generated-churn.cjs')) as {
    onlyGeneratedHeaderChanged(before: string, after: string): boolean;
    restoreHeaderOnlyBridgeChanges(dir: string): { restored: string[]; changed: string[] };
    onlyStampChanged(before: string, after: string): boolean;
    restoreStampOnlyBuildState(dir: string): { restored: string[]; changed: string[] };
};
// eslint-disable-next-line @typescript-eslint/no-require-imports
const fresh = require(path.join(SCRIPTS, 'check-bridge-fresh.cjs')) as {
    bridgeFreshCommand(extRoot: string): { cwd: string; args: string[] };
};

const HEAD = [
    '// D4rt Bridge - Generated file, do not edit',
    '// Sources: 34 files',
    '// Generated: 2026-10-13T10:51:19.587939 by tom_d4rt_generator 1.52.0',
    '',
    'class FooBridge {',
    '  void register() {}',
    '}',
    '',
].join('\n');
const restamped = HEAD.replace('2026-10-13T10:51:19.587939', '2026-10-20T13:45:12.326748');

// git's identity variables are SCREAMING_CASE by definition.
// eslint-disable-next-line @typescript-eslint/naming-convention
const GIT_ENV = { GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t' };
const git = (cwd: string, ...args: string[]): string =>
    execFileSync('git', args, { cwd, encoding: 'utf8', env: { ...process.env, ...GIT_ENV } });

describe('generated bridges', () => {
    test('BG-1: only the header changed', () => {
        assert.equal(churn.onlyGeneratedHeaderChanged(HEAD, restamped), true);
        assert.equal(churn.onlyGeneratedHeaderChanged(HEAD.replace(/\n/g, '\r\n'), restamped), true, 'line endings are not a change');
    });

    test('BG-2: a real change', () => {
        assert.equal(churn.onlyGeneratedHeaderChanged(HEAD, restamped.replace('void register() {}', 'void register() {}\n  void streamQuery() {}')), false);
        assert.equal(churn.onlyGeneratedHeaderChanged(HEAD, restamped.replace('// Sources: 34 files', '// Sources: 35 files')), false, 'the source count is content');
        assert.equal(churn.onlyGeneratedHeaderChanged(HEAD, HEAD), false, 'identical is no change at all');
    });

    test('BG-3: putting header-only regenerations back', () => {
        const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'bridge-churn-'));
        git(repo, 'init', '-q');
        fs.mkdirSync(path.join(repo, 'lib'));
        fs.writeFileSync(path.join(repo, 'lib', 'a.b.dart'), HEAD);
        fs.writeFileSync(path.join(repo, 'lib', 'b.b.dart'), HEAD);
        fs.writeFileSync(path.join(repo, 'lib', 'plain.dart'), 'void main() {}\n');
        git(repo, 'add', '.');
        git(repo, 'commit', '-q', '-m', 'init');

        fs.writeFileSync(path.join(repo, 'lib', 'a.b.dart'), restamped);
        fs.writeFileSync(path.join(repo, 'lib', 'b.b.dart'), restamped.replace('}\n', '  void more() {}\n}\n'));
        fs.writeFileSync(path.join(repo, 'lib', 'plain.dart'), 'void main() { print(1); }\n');

        const r = churn.restoreHeaderOnlyBridgeChanges(repo);
        assert.deepEqual([...r.restored], ['lib/a.b.dart']);
        assert.deepEqual([...r.changed], ['lib/b.b.dart']);
        assert.equal(fs.readFileSync(path.join(repo, 'lib', 'a.b.dart'), 'utf8'), HEAD, 'back to what is committed');
        assert.match(fs.readFileSync(path.join(repo, 'lib', 'b.b.dart'), 'utf8'), /void more/, 'a real regeneration stays');
        assert.match(fs.readFileSync(path.join(repo, 'lib', 'plain.dart'), 'utf8'), /print\(1\)/, 'only generated bridge files are touched');
    });

    test('BG-4: the freshness check', () => {
        const ext = path.join(__dirname, '..', '..', '..');
        const cmd = fresh.bridgeFreshCommand(ext);
        assert.equal(path.basename(cmd.cwd), 'tom_vscode_bridge');
        assert.deepEqual(cmd.args, ['test', 'test/bridges_fresh_test.dart']);
        assert.ok(fs.existsSync(path.join(cmd.cwd, 'test', 'bridges_fresh_test.dart')), 'the bridge\'s own test');
    });

    test('BG-5: the versioner stamp and the build state', () => {
        const stamp = (time: string, commit: string, build: number, version = '1.0.0'): string => [
            '// GENERATED FILE - DO NOT EDIT',
            `// Generated by versioner at ${time}`,
            '',
            'class VscodeBridgeVersionInfo {',
            `  static const String version = '${version}';`,
            `  static const String buildTime = '${time}';`,
            `  static const String gitCommit = '${commit}';`,
            `  static const int buildNumber = ${build};`,
            "  static const String dartSdkVersion = '3.12.2';",
            '}',
            '',
        ].join('\n');
        const state = (build: number, time: string): string => `{\n  "buildNumber": ${build},\n  "lastBuild": "${time}"\n}`;
        const old = stamp('2026-10-13T08:50:49Z', 'cd4e670', 45);
        assert.equal(churn.onlyStampChanged(old, stamp('2026-10-20T11:44:59Z', '8edc00d', 65)), true);
        assert.equal(churn.onlyStampChanged(old, stamp('2026-10-20T11:44:59Z', '8edc00d', 65, '1.1.0')), false, 'a new version is a change');
        assert.equal(churn.onlyStampChanged(old, old), false);

        const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'bridge-stamp-'));
        git(repo, 'init', '-q');
        fs.mkdirSync(path.join(repo, 'lib', 'src'), { recursive: true });
        const versioner = path.join(repo, 'lib', 'src', 'version.versioner.dart');
        const buildState = path.join(repo, 'tom_build_state.json');
        fs.writeFileSync(versioner, old);
        fs.writeFileSync(buildState, state(45, '2026-10-13T08:50:49Z'));
        git(repo, 'add', '.');
        git(repo, 'commit', '-q', '-m', 'init');

        fs.writeFileSync(versioner, stamp('2026-10-20T11:44:59Z', '8edc00d', 65));
        fs.writeFileSync(buildState, state(65, '2026-10-20T11:44:59Z'));
        assert.deepEqual([...churn.restoreStampOnlyBuildState(repo).restored], ['lib/src/version.versioner.dart', 'tom_build_state.json']);
        assert.equal(fs.readFileSync(versioner, 'utf8'), old);
        assert.match(fs.readFileSync(buildState, 'utf8'), /"buildNumber": 45/, 'the build state goes back with it');

        fs.writeFileSync(versioner, stamp('2026-10-20T11:44:59Z', '8edc00d', 66, '1.1.0'));
        fs.writeFileSync(buildState, state(66, '2026-10-20T11:44:59Z'));
        const kept = churn.restoreStampOnlyBuildState(repo);
        assert.deepEqual([...kept.restored], []);
        assert.deepEqual([...kept.changed], ['lib/src/version.versioner.dart', 'tom_build_state.json'], 'a version bump stays, both files');
    });
});
