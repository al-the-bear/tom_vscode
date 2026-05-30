/**
 * Tool-impl tests for `run-command.ts` — `tomAi_runCommand`.
 *
 * Strategy: drive the real `/bin/sh` via the production `spawn` for
 * almost every test. The exec surface is small enough that a fake
 * spawner buys very little — most of the value is in the shell
 * actually parsing the command line, expanding env vars, and running
 * the binaries. Tests assume a POSIX shell environment (macOS / Linux);
 * Windows is out of scope for now.
 *
 * One injected-spawner test covers the spawn-failure path (so we don't
 * have to find a system where `/bin/sh` is missing).
 *
 * Timing: the typical-call test runs `echo` and is wrapped in
 * `withTiming` for audit coverage. The timeout test takes ~300 ms by
 * construction (timeout + SIGTERM→SIGKILL window); the large-output
 * test reads 2 MB of stdout (~50 ms on SSD).
 */

import test, { after, before, describe } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { spawn } from 'child_process';

import { withTiming } from './_timing.js';
import { runCommandImpl, type RunCommandDeps } from '../run-command.js';

// ---------------------------------------------------------------------------
// Scratch workspace — shared across the cheap tests.
// ---------------------------------------------------------------------------

let ws: string;

before(() => {
    ws = fs.mkdtempSync(path.join(os.tmpdir(), 'run-command-'));
    fs.writeFileSync(path.join(ws, 'marker.txt'), 'present', 'utf8');
});

after(() => {
    try { fs.rmSync(ws, { recursive: true, force: true }); } catch { /* best-effort */ }
});

const realDeps: RunCommandDeps = { wsRoot: '' };  // wsRoot set per-call below; lets us reuse one deps obj

// ---------------------------------------------------------------------------
// Typical / output formatting
// ---------------------------------------------------------------------------

describe('runCommandImpl — typical paths', () => {

    test('typical call returns just stdout when exit=0 and stderr is empty', async () => {
        const out = await withTiming('tomAi_runCommand:typical', () =>
            runCommandImpl({ wsRoot: ws }, { command: 'echo hello' }));
        assert.equal(out, 'hello');
    });

    test('(no output) is returned when stdout is empty and exit=0', async () => {
        const out = await runCommandImpl({ wsRoot: ws }, { command: 'true' });
        assert.equal(out, '(no output)');
    });

    test('stderr is NOT silently dropped when stdout is also present', async () => {
        // Both streams have content; both must appear, labelled.
        const out = await runCommandImpl({ wsRoot: ws }, {
            command: 'echo out-line; echo err-line >&2',
        });
        assert.match(out, /stdout:[\s\S]*out-line/);
        assert.match(out, /stderr:[\s\S]*err-line/);
    });

    test('stderr-only success keeps the stderr label', async () => {
        const out = await runCommandImpl({ wsRoot: ws }, { command: 'echo warn >&2' });
        assert.doesNotMatch(out, /stdout:/);
        assert.match(out, /stderr:[\s\S]*warn/);
    });
});

// ---------------------------------------------------------------------------
// Exit codes
// ---------------------------------------------------------------------------

describe('runCommandImpl — exit codes', () => {

    test('non-zero exit surfaces the code explicitly', async () => {
        const out = await runCommandImpl({ wsRoot: ws }, { command: 'exit 7' });
        assert.match(out, /Command exited with code 7/);
    });

    test('non-zero exit with stderr surfaces both', async () => {
        const out = await runCommandImpl({ wsRoot: ws }, {
            command: 'echo "bad input" >&2; exit 2',
        });
        assert.match(out, /Command exited with code 2/);
        assert.match(out, /stderr:[\s\S]*bad input/);
    });
});

// ---------------------------------------------------------------------------
// Large output (the 1 MB+ regression)
// ---------------------------------------------------------------------------

describe('runCommandImpl — large output', () => {

    test('1 MB of stdout is NOT silently truncated (the old 1 MB buffer trap)', async () => {
        // The old impl used exec() with maxBuffer=1MB, which threw
        // ERR_CHILD_PROCESS_STDIO_MAXBUFFER and dropped everything.
        // Now we have a 10 MB cap and explicit truncation.
        const out = await runCommandImpl({ wsRoot: ws }, {
            // ~ 1.5 MB of 'a's. dd is portable and fast.
            command: 'head -c 1500000 /dev/zero | tr "\\0" "a"',
        });
        // Should be just the 1.5M 'a's, no truncation note (under the 10 MB cap).
        assert.equal(out.length, 1500000, `expected exactly 1 500 000 bytes, got ${out.length}`);
        assert.doesNotMatch(out, /truncated/);
    });

    test('output above the 10 MB cap is reported with an explicit truncation note', async () => {
        // 12 MB > 10 MB cap → first 10 MB kept + note appended.
        const out = await runCommandImpl({ wsRoot: ws }, {
            command: 'head -c 12000000 /dev/zero | tr "\\0" "a"',
        });
        assert.match(out, /truncated at 10,485,760 bytes/);
        // The 'a' run plus the note: the run is exactly the cap.
        const aRun = out.match(/^a+/)?.[0] ?? '';
        assert.equal(aRun.length, 10 * 1024 * 1024, 'truncation must cut at the cap, not earlier');
    });
});

// ---------------------------------------------------------------------------
// Timeout
// ---------------------------------------------------------------------------

describe('runCommandImpl — timeout', () => {

    test('exceeding timeoutMs kills the child and reports partial output', async () => {
        const t0 = Date.now();
        const out = await runCommandImpl({ wsRoot: ws }, {
            // Print one line then sleep forever; timeout cuts it.
            command: 'echo "before sleep"; sleep 10',
            timeoutMs: 200,
        });
        const elapsed = Date.now() - t0;
        assert.match(out, /Command timed out after 200 ms/);
        assert.match(out, /SIGTERM.*SIGKILL/);
        assert.match(out, /before sleep/);
        // 200ms timeout + 250ms grace ≈ 450ms; allow some slack on a busy CI.
        assert.ok(elapsed < 3000, `timeout took too long: ${elapsed}ms`);
    });

    test('timeoutMs=0 disables the timeout (control test — runs short cmd)', async () => {
        // We can't easily test "infinite timeout" — but we can confirm the
        // timeout=0 path doesn't break a normal fast command.
        const out = await runCommandImpl({ wsRoot: ws }, {
            command: 'echo no-timeout',
            timeoutMs: 0,
        });
        assert.equal(out, 'no-timeout');
    });
});

// ---------------------------------------------------------------------------
// Shell semantics
// ---------------------------------------------------------------------------

describe('runCommandImpl — shell semantics', () => {

    test('&& chains commands (only second runs if first succeeds)', async () => {
        const out = await runCommandImpl({ wsRoot: ws }, { command: 'echo one && echo two' });
        assert.equal(out, 'one\ntwo');
    });

    test('|| short-circuits on success', async () => {
        const out = await runCommandImpl({ wsRoot: ws }, { command: 'true || echo never-runs' });
        assert.equal(out, '(no output)');
    });

    test('pipes work', async () => {
        const out = await runCommandImpl({ wsRoot: ws }, { command: 'echo "a\nb\nc" | wc -l | tr -d " "' });
        assert.equal(out, '3');
    });

    test('env-var expansion via $VAR', async () => {
        const out = await runCommandImpl({ wsRoot: ws }, {
            command: 'echo "value is $MY_TEST_VAR"',
            env: { MY_TEST_VAR: 'forty-two' },
        });
        assert.equal(out, 'value is forty-two');
    });
});

// ---------------------------------------------------------------------------
// cwd handling
// ---------------------------------------------------------------------------

describe('runCommandImpl — cwd handling', () => {

    test('default cwd is the workspace root', async () => {
        // marker.txt was written to ws root in `before()`.
        const out = await runCommandImpl({ wsRoot: ws }, { command: 'cat marker.txt' });
        assert.equal(out, 'present');
    });

    test('cwd accepts workspace-relative paths', async () => {
        fs.mkdirSync(path.join(ws, 'sub'));
        fs.writeFileSync(path.join(ws, 'sub/leaf.txt'), 'inside-sub', 'utf8');
        const out = await runCommandImpl({ wsRoot: ws }, { command: 'cat leaf.txt', cwd: 'sub' });
        assert.equal(out, 'inside-sub');
    });

    test('cwd outside the workspace is rejected', async () => {
        const out = await runCommandImpl({ wsRoot: ws }, { command: 'echo escape', cwd: '../../../tmp' });
        assert.match(out, /cwd is outside the workspace/);
    });

    test('empty command returns an instructive error', async () => {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const out = await runCommandImpl({ wsRoot: ws }, { command: '' as any });
        assert.match(out, /`command` is required/);
    });
});

// ---------------------------------------------------------------------------
// Spawner-injection (single test — covers the spawn-failure path)
// ---------------------------------------------------------------------------

describe('runCommandImpl — injected spawner', () => {

    test('spawn failure is surfaced cleanly', async () => {
        const failing: RunCommandDeps['spawn'] = () => {
            throw new Error('mocked spawn failure');
        };
        const out = await runCommandImpl(
            { wsRoot: ws, spawn: failing },
            { command: 'echo hi' },
        );
        assert.match(out, /failed to spawn shell: mocked spawn failure/);
    });

    test('the real production spawn is used when none is injected (smoke)', async () => {
        // Sanity: explicitly pass the real `spawn` and confirm it works.
        const out = await runCommandImpl({ wsRoot: ws, spawn }, { command: 'echo via-real-spawn' });
        assert.equal(out, 'via-real-spawn');
    });
});

// Silence unused-import warning for the realDeps placeholder (kept for future use).
void realDeps;
