/**
 * Tool-impl tests for `git-tools.ts` — coverage entry #27.
 *
 *   - tomAi_gitRead   — fixed allow-list of read subcommands
 *   - tomAi_gitShow   — historical-revision viewer (ref / ref:path)
 *   - tomAi_gitWrite  — broader allow-list of mutating subcommands
 *
 * Two-layer strategy:
 *
 *   1. **Unit tests** with a stubbed `GitExecutor` — verify
 *      subcommand routing, allow-lists, traversal guard, hook-skip
 *      policy, envelope shape, and non-zero exit handling, all
 *      without spawning git.
 *   2. **Integration tests** against a real `git init` fixture in
 *      `os.tmpdir()` — exercise the wired-up `liveExecutor` via the
 *      Impl entry points so we can be confident the executor's
 *      stdout/stderr/exitCode plumbing matches what the unit tests
 *      assert on. The c-row of the coverage doc asks for this
 *      explicitly: "exercise read at various refs, show specific
 *      paths at specific revs, write a tiny commit."
 *
 * Coverage entry #27 four-row checklist:
 *
 *   a) Description clarity — verified in the impl: gitRead vs.
 *      gitShow split rationale (`<ref>:<path>` usability cliff);
 *      gitWrite allow-list spelled out; hook-skip block explained.
 *   b) Ambiguities covered:
 *        - Repo discovery — documented as workspace-root-only for
 *          gitRead; gitShow + gitWrite accept `cwd` (traversal-
 *          guarded).
 *        - Untracked files / detached HEAD — documented as
 *          "no special handling" (git decides).
 *        - --no-verify / --no-gpg-sign rejected per workspace policy.
 *        - Non-zero git exit surfaced as `{ok: false, exitCode,
 *          stdout, stderr}` (was conflated with spawn failure).
 *   c) Tests + integration fixture per the c-row's explicit ask.
 *   d) Timing — unit tests sub-ms; integration tests <2s total
 *      (`git init` + a small commit + a few reads).
 */

import test, { after, before, describe } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { execFileSync } from 'child_process';

import { withTiming } from './_timing.js';

// `git-tools.ts` imports `vscode` at module top to build the live bridge;
// install the shared stub first.
import { installVscodeStub } from './_vscode-stub.js';
installVscodeStub({});

import {
    gitReadImpl,
    gitShowImpl,
    gitWriteImpl,
    type GitExecutor,
    type GitExecResult,
    type GitWorkspace,
} from '../git-tools.js';

// ===========================================================================
// Stubbed executor for unit tests
// ===========================================================================

interface ExecCall {
    args: string[];
    cwd: string;
    timeoutMs: number;
    maxBufferBytes: number;
}

interface FakeExecutor extends GitExecutor {
    calls: ExecCall[];
    queue: GitExecResult[];
    /** When set, the next run() throws (simulating a spawn failure). */
    throwNext?: Error;
}

function makeExecutor(): FakeExecutor {
    const calls: ExecCall[] = [];
    const queue: GitExecResult[] = [];
    const fake: FakeExecutor = {
        calls,
        queue,
        async run(args, opts) {
            calls.push({ args, ...opts });
            if (fake.throwNext) { const e = fake.throwNext; fake.throwNext = undefined; throw e; }
            return queue.shift() ?? { stdout: '', stderr: '', exitCode: 0 };
        },
    };
    return fake;
}

function makeWorkspace(root: string = '/ws'): GitWorkspace {
    return { root: () => root };
}

/** Workspace fake where `root()` returns undefined (no workspace open). */
const noWorkspace: GitWorkspace = { root: () => undefined };

// ===========================================================================
// Unit tests — gitReadImpl
// ===========================================================================

describe('gitReadImpl — unit', () => {

    test('typical: status returns ok envelope with stdout', async () => {
        const exec = makeExecutor();
        exec.queue.push({ stdout: 'On branch main\nnothing to commit\n', stderr: '', exitCode: 0 });
        const raw = await withTiming('tomAi_gitRead:typical', () =>
            gitReadImpl(exec, makeWorkspace(), { subcommand: 'status' }));
        const r = JSON.parse(raw);
        assert.equal(r.ok, true);
        assert.equal(r.subcommand, 'status');
        assert.match(r.stdout, /On branch main/);
        assert.equal(r.exitCode, 0);
        // exec called with cwd = workspace root
        assert.equal(exec.calls.length, 1);
        assert.deepEqual(exec.calls[0].args, ['status']);
        assert.equal(exec.calls[0].cwd, '/ws');
    });

    test('args forwarded verbatim', async () => {
        const exec = makeExecutor();
        exec.queue.push({ stdout: '', stderr: '', exitCode: 0 });
        await gitReadImpl(exec, makeWorkspace(), { subcommand: 'log', args: ['-n', '20', '--oneline'] });
        assert.deepEqual(exec.calls[0].args, ['log', '-n', '20', '--oneline']);
    });

    test('disallowed subcommand rejected; executor NOT called', async () => {
        const exec = makeExecutor();
        const r = JSON.parse(await gitReadImpl(exec, makeWorkspace(), {
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            subcommand: 'push' as any,
        }));
        assert.equal(r.ok, false);
        assert.match(r.error, /subcommand must be one of/);
        assert.equal(r.received, 'push');
        assert.equal(exec.calls.length, 0);
    });

    test('non-zero exit code surfaces stdout + stderr + exitCode (was raw string)', async () => {
        const exec = makeExecutor();
        exec.queue.push({ stdout: '', stderr: 'fatal: not a git repository', exitCode: 128 });
        const r = JSON.parse(await gitReadImpl(exec, makeWorkspace(), { subcommand: 'status' }));
        assert.equal(r.ok, false);
        assert.match(r.error, /exited with code 128/);
        assert.equal(r.exitCode, 128);
        assert.match(r.stderr, /not a git repository/);
    });

    test('no workspace → ok:false (no cwd to run from)', async () => {
        const exec = makeExecutor();
        const r = JSON.parse(await gitReadImpl(exec, noWorkspace, { subcommand: 'status' }));
        assert.equal(r.ok, false);
        assert.match(r.error, /No working directory available/);
        assert.equal(exec.calls.length, 0);
    });

    test('executor throws (spawn failure) → ok:false, surfaced honestly', async () => {
        const exec = makeExecutor();
        exec.throwNext = new Error('ENOENT git');
        const r = JSON.parse(await gitReadImpl(exec, makeWorkspace(), { subcommand: 'status' }));
        assert.equal(r.ok, false);
        assert.match(r.error, /gitRead failed: ENOENT git/);
    });

    test('non-string args silently filtered out', async () => {
        const exec = makeExecutor();
        exec.queue.push({ stdout: '', stderr: '', exitCode: 0 });
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        await gitReadImpl(exec, makeWorkspace(), { subcommand: 'log', args: ['-n', 5 as any, '--oneline'] });
        assert.deepEqual(exec.calls[0].args, ['log', '-n', '--oneline']);
    });
});

// ===========================================================================
// Unit tests — gitShowImpl
// ===========================================================================

describe('gitShowImpl — unit', () => {

    test('typical: ref-only forwards `git show <ref>`', async () => {
        const exec = makeExecutor();
        exec.queue.push({ stdout: 'commit abc\nAuthor: x\n', stderr: '', exitCode: 0 });
        const raw = await withTiming('tomAi_gitShow:typical', () =>
            gitShowImpl(exec, makeWorkspace(), { ref: 'HEAD~1' }));
        const r = JSON.parse(raw);
        assert.equal(r.ok, true);
        assert.equal(r.ref, 'HEAD~1');
        assert.equal(r.filePath, null);
        assert.deepEqual(exec.calls[0].args, ['show', 'HEAD~1']);
    });

    test('ref + filePath uses `git show <ref>:<path>` syntax', async () => {
        const exec = makeExecutor();
        exec.queue.push({ stdout: 'file contents at rev\n', stderr: '', exitCode: 0 });
        await gitShowImpl(exec, makeWorkspace(), { ref: 'main', filePath: 'src/x.ts' });
        assert.deepEqual(exec.calls[0].args, ['show', 'main:src/x.ts']);
    });

    test('missing ref rejected', async () => {
        const exec = makeExecutor();
        const r = JSON.parse(await gitShowImpl(exec, makeWorkspace(), { ref: '   ' }));
        assert.equal(r.ok, false);
        assert.match(r.error, /`ref` is required/);
        assert.equal(exec.calls.length, 0);
    });

    test('cwd traversal rejected', async () => {
        const exec = makeExecutor();
        const r = JSON.parse(await gitShowImpl(exec, makeWorkspace('/ws'), {
            ref: 'HEAD', cwd: '../../etc',
        }));
        assert.equal(r.ok, false);
        assert.match(r.error, /escapes the workspace root/);
        assert.equal(exec.calls.length, 0);
    });

    test('cwd inside workspace accepted (relative)', async () => {
        const exec = makeExecutor();
        exec.queue.push({ stdout: '', stderr: '', exitCode: 0 });
        await gitShowImpl(exec, makeWorkspace('/ws'), { ref: 'HEAD', cwd: 'sub/pkg' });
        assert.equal(exec.calls[0].cwd, path.join('/ws', 'sub', 'pkg'));
    });

    test('non-zero exit (unknown ref) → ok:false with stderr', async () => {
        const exec = makeExecutor();
        exec.queue.push({ stdout: '', stderr: 'fatal: ambiguous argument', exitCode: 128 });
        const r = JSON.parse(await gitShowImpl(exec, makeWorkspace(), { ref: 'no-such-ref' }));
        assert.equal(r.ok, false);
        assert.equal(r.exitCode, 128);
        assert.match(r.stderr, /ambiguous argument/);
    });
});

// ===========================================================================
// Unit tests — gitWriteImpl
// ===========================================================================

describe('gitWriteImpl — unit', () => {

    test('typical: commit + args succeeds with ok envelope', async () => {
        const exec = makeExecutor();
        exec.queue.push({ stdout: '[main abc] msg\n', stderr: '', exitCode: 0 });
        const raw = await withTiming('tomAi_gitWrite:typical', () =>
            gitWriteImpl(exec, makeWorkspace(), { subcommand: 'commit', args: ['-m', 'hi'] }));
        const r = JSON.parse(raw);
        assert.equal(r.ok, true);
        assert.equal(r.subcommand, 'commit');
        assert.deepEqual(exec.calls[0].args, ['commit', '-m', 'hi']);
    });

    test('subcommand outside the allow-list rejected with full allowed list', async () => {
        const exec = makeExecutor();
        const r = JSON.parse(await gitWriteImpl(exec, makeWorkspace(), { subcommand: 'gc' }));
        assert.equal(r.ok, false);
        assert.match(r.error, /not in allow-list/);
        assert.ok(Array.isArray(r.allowed));
        assert.ok(r.allowed.includes('commit'));
        assert.equal(exec.calls.length, 0);
    });

    test('--no-verify blocked (anywhere in args)', async () => {
        const exec = makeExecutor();
        const r = JSON.parse(await gitWriteImpl(exec, makeWorkspace(), {
            subcommand: 'commit', args: ['-m', 'msg', '--no-verify'],
        }));
        assert.equal(r.ok, false);
        assert.match(r.error, /blocked by workspace policy/);
        assert.equal(r.blocked, '--no-verify');
        assert.equal(exec.calls.length, 0);
    });

    test('--no-gpg-sign also blocked', async () => {
        const exec = makeExecutor();
        const r = JSON.parse(await gitWriteImpl(exec, makeWorkspace(), {
            subcommand: 'commit', args: ['--no-gpg-sign', '-m', 'msg'],
        }));
        assert.equal(r.ok, false);
        assert.equal(r.blocked, '--no-gpg-sign');
    });

    test('cwd traversal rejected; executor NOT called', async () => {
        const exec = makeExecutor();
        const r = JSON.parse(await gitWriteImpl(exec, makeWorkspace('/ws'), {
            subcommand: 'add', cwd: '../../escape',
        }));
        assert.equal(r.ok, false);
        assert.match(r.error, /escapes the workspace root/);
        assert.equal(exec.calls.length, 0);
    });

    test('timeoutMs clamped to 1000 minimum', async () => {
        const exec = makeExecutor();
        exec.queue.push({ stdout: '', stderr: '', exitCode: 0 });
        await gitWriteImpl(exec, makeWorkspace(), { subcommand: 'fetch', timeoutMs: 100 });
        assert.equal(exec.calls[0].timeoutMs, 1_000);
    });

    test('timeoutMs above floor passed through verbatim', async () => {
        const exec = makeExecutor();
        exec.queue.push({ stdout: '', stderr: '', exitCode: 0 });
        await gitWriteImpl(exec, makeWorkspace(), { subcommand: 'fetch', timeoutMs: 5_000 });
        assert.equal(exec.calls[0].timeoutMs, 5_000);
    });

    test('non-zero exit propagated with stdout + stderr', async () => {
        const exec = makeExecutor();
        exec.queue.push({ stdout: '', stderr: 'CONFLICT', exitCode: 1 });
        const r = JSON.parse(await gitWriteImpl(exec, makeWorkspace(), { subcommand: 'merge', args: ['feature'] }));
        assert.equal(r.ok, false);
        assert.equal(r.exitCode, 1);
        assert.match(r.stderr, /CONFLICT/);
    });

    test('empty subcommand rejected', async () => {
        const exec = makeExecutor();
        const r = JSON.parse(await gitWriteImpl(exec, makeWorkspace(), { subcommand: '   ' }));
        assert.equal(r.ok, false);
        assert.match(r.error, /`subcommand` is required/);
    });
});

// ===========================================================================
// Integration tests — real `git init` fixture
// ===========================================================================

let repoDir: string;
let liveExecutor: GitExecutor;
let liveWorkspace: GitWorkspace;

before(() => {
    repoDir = fs.mkdtempSync(path.join(os.tmpdir(), 'git-tools-int-'));
    // Initial repo + a small commit so we have a HEAD to query.
    const env = {
        ...process.env,
        GIT_AUTHOR_NAME: 'Test', GIT_AUTHOR_EMAIL: 't@e',
        GIT_COMMITTER_NAME: 'Test', GIT_COMMITTER_EMAIL: 't@e',
        // Avoid GPG signing the integration test commits.
        GIT_CONFIG_GLOBAL: '/dev/null',
    };
    execFileSync('git', ['init', '-b', 'main'], { cwd: repoDir, env });
    fs.writeFileSync(path.join(repoDir, 'README.md'), '# Hello\n');
    execFileSync('git', ['add', 'README.md'], { cwd: repoDir, env });
    execFileSync('git', ['commit', '-m', 'first commit'], { cwd: repoDir, env });

    // Build the same live executor + workspace the production module
    // exports — but inline so the tests don't have to import the
    // module's private singletons.  Mirrors the bridge contract.
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const { execFile } = require('child_process');
    liveExecutor = {
        run(args, opts) {
            return new Promise<GitExecResult>((resolve) => {
                const child = execFile('git', args, {
                    cwd: opts.cwd,
                    maxBuffer: opts.maxBufferBytes,
                    timeout: opts.timeoutMs,
                    env,
                }, (errored: unknown, stdout: string | Buffer, stderr: string | Buffer) => {
                    if (errored) {
                        // eslint-disable-next-line @typescript-eslint/no-explicit-any
                        const e = errored as any;
                        resolve({
                            stdout: stdout?.toString() ?? '',
                            stderr: stderr?.toString() ?? '',
                            exitCode: typeof e.code === 'number' ? e.code : (child.exitCode ?? -1),
                        });
                        return;
                    }
                    resolve({
                        stdout: stdout.toString(),
                        stderr: stderr.toString(),
                        exitCode: child.exitCode ?? 0,
                    });
                });
            });
        },
    };
    liveWorkspace = { root: () => repoDir };
});
after(() => { try { fs.rmSync(repoDir, { recursive: true, force: true }); } catch { /* ignore */ } });

describe('git-tools — integration against real `git init` fixture', () => {

    test('gitRead status shows the clean repo', async () => {
        const r = JSON.parse(await gitReadImpl(liveExecutor, liveWorkspace, { subcommand: 'status' }));
        assert.equal(r.ok, true);
        assert.match(r.stdout, /On branch main/);
        assert.match(r.stdout, /nothing to commit/);
    });

    test('gitRead log -n 1 shows the first commit', async () => {
        const r = JSON.parse(await gitReadImpl(liveExecutor, liveWorkspace, {
            subcommand: 'log', args: ['-n', '1', '--oneline'],
        }));
        assert.equal(r.ok, true);
        assert.match(r.stdout, /first commit/);
    });

    test('gitShow HEAD returns commit metadata', async () => {
        const r = JSON.parse(await gitShowImpl(liveExecutor, liveWorkspace, { ref: 'HEAD' }));
        assert.equal(r.ok, true);
        assert.match(r.stdout, /first commit/);
        assert.match(r.stdout, /README.md/);
    });

    test('gitShow HEAD:README.md returns the file at the revision', async () => {
        const r = JSON.parse(await gitShowImpl(liveExecutor, liveWorkspace, {
            ref: 'HEAD', filePath: 'README.md',
        }));
        assert.equal(r.ok, true);
        assert.match(r.stdout, /^# Hello/);
    });

    test('gitWrite: stage + commit a tiny change end-to-end', async () => {
        fs.writeFileSync(path.join(repoDir, 'notes.txt'), 'second\n');
        const addR = JSON.parse(await gitWriteImpl(liveExecutor, liveWorkspace, {
            subcommand: 'add', args: ['notes.txt'],
        }));
        assert.equal(addR.ok, true);
        const commitR = JSON.parse(await gitWriteImpl(liveExecutor, liveWorkspace, {
            subcommand: 'commit', args: ['-m', 'add notes'],
        }));
        assert.equal(commitR.ok, true);
        assert.match(commitR.stdout, /add notes/);

        // Verify the log now has 2 commits
        const logR = JSON.parse(await gitReadImpl(liveExecutor, liveWorkspace, {
            subcommand: 'log', args: ['--oneline'],
        }));
        assert.equal(logR.ok, true);
        assert.match(logR.stdout, /add notes/);
        assert.match(logR.stdout, /first commit/);
    });

    test('gitShow on an unknown ref reports non-zero exit code', async () => {
        const r = JSON.parse(await gitShowImpl(liveExecutor, liveWorkspace, {
            ref: 'no-such-ref-zzzz',
        }));
        assert.equal(r.ok, false);
        assert.equal(typeof r.exitCode, 'number');
        assert.ok(r.exitCode !== 0);
    });
});
