/**
 * Tool-impl tests for `process-tools.ts` — the three streaming
 * primitives `tomAi_runCommandStream`, `tomAi_readCommandOutput`,
 * `tomAi_killCommand`.
 *
 * Strategy: drive the real `/bin/sh` for the round-trip tests so we
 * exercise the actual process-group + signal handling. A separate
 * test for the cursor-on-`all` regression doesn't need a real shell.
 *
 * The registry is module-level state. `beforeEach` calls
 * `_resetRegistryForTesting()` so tests don't leak handles into each
 * other (and any in-flight processes from a previous test get
 * SIGKILL'd so they don't hold the suite up).
 *
 * Coverage entry #4 four-row checklist:
 *
 *   a) Description clarity — verified by reading the descriptions in
 *      the impl file; no test assertion needed here.
 *   b) Ambiguities — covered by the cursor-on-`all`, kill-the-group,
 *      cwd-outside-workspace, and unknown-handle tests below.
 *   c) Lifecycle — `start → stream chunks → read → kill mid-stream`
 *      and `start → complete → read → confirm exit code` both have
 *      dedicated tests.
 *   d) Timing — `tomAi_runCommandStream:typical` (echo handle),
 *      `tomAi_readCommandOutput:typical` (read once), and
 *      `tomAi_killCommand:typical` (kill an idle child) are each
 *      wrapped in `withTiming`. The `runStream + 50ms settling +
 *      killTree + 250ms grace` total is well under 5 s.
 */

import test, { after, before, beforeEach, describe } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import { withTiming } from './_timing.js';
import {
    _resetRegistryForTesting,
    killCommandImpl,
    readCommandOutputImpl,
    runCommandStreamImpl,
    type RunCommandStreamDeps,
} from '../process-tools.js';

// ---------------------------------------------------------------------------
// Scratch workspace
// ---------------------------------------------------------------------------

let ws: string;

before(() => {
    ws = fs.mkdtempSync(path.join(os.tmpdir(), 'process-tools-'));
    fs.writeFileSync(path.join(ws, 'inside.txt'), 'inside', 'utf8');
});

after(() => {
    try { fs.rmSync(ws, { recursive: true, force: true }); } catch { /* best-effort */ }
});

beforeEach(() => {
    _resetRegistryForTesting();
});

const deps = (): RunCommandStreamDeps => ({ wsRoot: ws });

async function sleep(ms: number): Promise<void> {
    await new Promise((r) => setTimeout(r, ms));
}

// Helper: poll readCommandOutput until `running` is false or `attempts` exhausted.
async function waitForExit(handle: string, attempts = 20, intervalMs = 50): Promise<{ running: boolean; exitCode: number | null; signal: NodeJS.Signals | null }> {
    for (let i = 0; i < attempts; i++) {
        const raw = await readCommandOutputImpl({}, { handle, since: 'all' });
        const parsed = JSON.parse(raw);
        if (!parsed.running) { return parsed; }
        await sleep(intervalMs);
    }
    const raw = await readCommandOutputImpl({}, { handle, since: 'all' });
    return JSON.parse(raw);
}

// ===========================================================================
// runCommandStream
// ===========================================================================

describe('runCommandStreamImpl', () => {

    test('typical call returns a handle, pid, and initial state', async () => {
        const raw = await withTiming('tomAi_runCommandStream:typical', () =>
            runCommandStreamImpl(deps(), { command: 'echo hello' }));
        const r = JSON.parse(raw);
        assert.match(r.handle, /^proc_\d+_/);
        assert.equal(typeof r.pid, 'number');
        // Within the 50ms settling window `echo hello` typically exits;
        // running may be true or false depending on timing. Either is fine.
        assert.ok('running' in r);
        // Preview should have caught the echo if the process exited
        // during settling; if not, it'll appear on the next read.
        if (!r.running) {
            assert.match(r.stdoutPreview, /hello/);
        }
    });

    test('missing command returns an error JSON', async () => {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const r = JSON.parse(await runCommandStreamImpl(deps(), { command: '' as any }));
        assert.match(r.error, /`command` is required/);
    });

    test('cwd outside the workspace is rejected', async () => {
        const r = JSON.parse(await runCommandStreamImpl(deps(), {
            command: 'echo escape',
            cwd: '../../../tmp',
        }));
        assert.match(r.error, /cwd is outside the workspace/);
    });

    test('cwd accepts workspace-relative paths', async () => {
        const r = JSON.parse(await runCommandStreamImpl(deps(), {
            command: 'cat inside.txt',
            // workspace root contains inside.txt
            cwd: '.',
        }));
        assert.ok(r.handle, `expected handle, got: ${JSON.stringify(r)}`);
        const final = await waitForExit(r.handle);
        assert.equal(final.exitCode, 0);
        const raw = await readCommandOutputImpl({}, { handle: r.handle, since: 'all' });
        assert.match(JSON.parse(raw).stdout, /inside/);
    });

    test('spawn failure surfaces a clean error JSON', async () => {
        const failing: RunCommandStreamDeps['spawn'] = () => {
            throw new Error('mocked spawn failure');
        };
        const r = JSON.parse(await runCommandStreamImpl({ wsRoot: ws, spawn: failing }, {
            command: 'whatever',
        }));
        assert.match(r.error, /Spawn failed: mocked spawn failure/);
    });
});

// ===========================================================================
// readCommandOutput
// ===========================================================================

describe('readCommandOutputImpl', () => {

    test('lifecycle: start → complete → read → exit code', async () => {
        const start = JSON.parse(await runCommandStreamImpl(deps(), { command: 'echo line-a; echo line-b' }));
        await waitForExit(start.handle);
        const raw = await withTiming('tomAi_readCommandOutput:typical', () =>
            readCommandOutputImpl({}, { handle: start.handle, since: 'all' }));
        const r = JSON.parse(raw);
        assert.equal(r.running, false);
        assert.equal(r.exitCode, 0);
        assert.match(r.stdout, /line-a/);
        assert.match(r.stdout, /line-b/);
        assert.ok(r.endedAt, 'endedAt should be populated after completion');
    });

    test('cursor semantics: `new` advances, `all` does not (the LLM trap)', async () => {
        const start = JSON.parse(await runCommandStreamImpl(deps(), { command: 'echo first; echo second' }));
        await waitForExit(start.handle);

        // First `all` read — should NOT advance the cursor.
        const allRead = JSON.parse(await readCommandOutputImpl({}, { handle: start.handle, since: 'all' }));
        assert.match(allRead.stdout, /first[\s\S]*second/);

        // Subsequent `new` read — must still see the lines (cursor wasn't moved).
        const newAfterAll = JSON.parse(await readCommandOutputImpl({}, { handle: start.handle, since: 'new' }));
        assert.match(newAfterAll.stdout, /first/, 'cursor must not have advanced on the `all` read');

        // Next `new` read — cursor has now advanced; should return empty.
        const second = JSON.parse(await readCommandOutputImpl({}, { handle: start.handle, since: 'new' }));
        // The buffer is `['', 'first', 'second']` (empty leading entry from
        // the initial split). After the first `new` read, the cursor moves
        // to the end and there's nothing left to return.
        assert.equal(second.stdout.trim(), '');
    });

    test('unknown handle returns error JSON', async () => {
        const r = JSON.parse(await readCommandOutputImpl({}, { handle: 'proc_99999_nope' }));
        assert.match(r.error, /Unknown handle/);
    });

    test('truncatedStdout is true when maxLines clips the output', async () => {
        const start = JSON.parse(await runCommandStreamImpl(deps(), {
            command: 'for i in $(seq 1 50); do echo "line-$i"; done',
        }));
        await waitForExit(start.handle);
        const r = JSON.parse(await readCommandOutputImpl({}, { handle: start.handle, since: 'all', maxLines: 10 }));
        assert.equal(r.truncatedStdout, true);
        assert.equal(r.stdoutLinesReturned, 10);
        // Most-recent kept: must include line-50, must NOT include line-1.
        assert.match(r.stdout, /line-50/);
        assert.doesNotMatch(r.stdout, /line-1\b/);
    });
});

// ===========================================================================
// killCommand
// ===========================================================================

describe('killCommandImpl', () => {

    test('lifecycle: start → kill mid-stream → confirm running:false', async () => {
        // `sleep 30` runs as a child of /bin/sh. The kill-the-group fix
        // is what makes this test pass — without it the SIGTERM only
        // hits the shell and the inner sleep survives.
        const start = JSON.parse(await runCommandStreamImpl(deps(), {
            command: 'echo started; sleep 30',
        }));
        assert.ok(start.handle, `expected handle, got: ${JSON.stringify(start)}`);
        // Wait briefly so the echo lands.
        await sleep(100);

        const killRaw = await withTiming('tomAi_killCommand:typical', () =>
            killCommandImpl({}, { handle: start.handle }));
        const kill = JSON.parse(killRaw);
        assert.equal(kill.killed, true);
        assert.equal(kill.signal, 'SIGTERM');
        assert.equal(kill.escalatesToSigkillAfterMs, 250);

        const final = await waitForExit(start.handle, 30, 50);
        assert.equal(final.running, false, 'process must actually be dead after the group kill');
        // SIGTERM may yield exitCode=null + signal='SIGTERM', or after
        // escalation signal='SIGKILL'. Either proves the kill propagated.
        assert.ok(
            final.signal === 'SIGTERM' || final.signal === 'SIGKILL' || final.exitCode !== null,
            `expected signal-killed, got: ${JSON.stringify(final)}`,
        );
    });

    test('killing an already-exited handle reports `alreadyExited` rather than erroring', async () => {
        const start = JSON.parse(await runCommandStreamImpl(deps(), { command: 'echo done' }));
        await waitForExit(start.handle);
        const r = JSON.parse(await killCommandImpl({}, { handle: start.handle }));
        assert.equal(r.alreadyExited, true);
        assert.equal(r.exitCode, 0);
    });

    test('unknown handle returns error JSON', async () => {
        const r = JSON.parse(await killCommandImpl({}, { handle: 'proc_nope' }));
        assert.match(r.error, /Unknown handle/);
    });

    test('explicit SIGKILL skips the escalation timer', async () => {
        const start = JSON.parse(await runCommandStreamImpl(deps(), {
            command: 'sleep 30',
        }));
        await sleep(50);
        const r = JSON.parse(await killCommandImpl({}, { handle: start.handle, signal: 'SIGKILL' }));
        assert.equal(r.killed, true);
        assert.equal(r.signal, 'SIGKILL');
        assert.equal(r.escalatesToSigkillAfterMs, 0);
        const final = await waitForExit(start.handle, 30, 50);
        assert.equal(final.running, false);
    });
});
