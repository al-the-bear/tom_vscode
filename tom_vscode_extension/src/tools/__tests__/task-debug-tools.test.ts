/**
 * Tool-impl tests for `task-debug-tools.ts` — `tomAi_runTask` and
 * `tomAi_runDebugConfig`.
 *
 * The impls take narrow dep interfaces (`TaskRunner`, `DebugRunner`)
 * rather than reaching into `vscode.tasks` / `vscode.debug` directly,
 * so the tests pass plain-object fakes — no vscode stub required.
 *
 * Coverage entry #5 four-row checklist:
 *
 *   a) Description clarity — verified in the impl file (read &
 *      reviewed); the output-capture limitation and ambiguity-
 *      surfacing rules are spelled out there.
 *   b) Ambiguities — covered explicitly here:
 *        - exact-vs-CI name matching (and the multi-match surfacing)
 *        - folder selector validation on debug
 *        - "name omitted means list" behaviour (saves a round-trip)
 *        - timeout default + propagation
 *   c) Real `tasks.json` / `launch.json` fixture shapes — synthesised
 *      as `TaskInfo[]` and folder-name arrays the fakes return;
 *      `executeTask` is mocked via `spawnedTasks` collector and the
 *      tests assert the right task got invoked.
 *   d) Timing — `tomAi_runTask:typical` + `tomAi_runDebugConfig:typical`
 *      both wrapped in `withTiming` (sub-ms since the fakes resolve
 *      synchronously). The real production cost is upstream in the
 *      VS Code API; this tool's own overhead is what's being measured.
 */

import test, { describe } from 'node:test';
import assert from 'node:assert/strict';

import { withTiming } from './_timing.js';
import {
    runTaskImpl,
    runDebugConfigImpl,
    type DebugRunner,
    type TaskExecResult,
    type TaskInfo,
    type TaskRunner,
} from '../task-debug-tools.js';

// ---------------------------------------------------------------------------
// Synthetic fixtures — mirror the shape `vscode.tasks.fetchTasks` would
// produce for a workspace with two folders defining overlapping task names.
// ---------------------------------------------------------------------------

const TASKS_JSON_FIXTURE: TaskInfo[] = [
    { name: 'build', source: 'Workspace', type: 'npm', scopeName: 'frontend' },
    { name: 'build', source: 'Workspace', type: 'npm', scopeName: 'backend' },
    { name: 'lint', source: 'Workspace', type: 'shell', scopeName: 'frontend' },
    { name: 'Test Frontend', source: 'Workspace', type: 'shell', scopeName: 'frontend' },
];

const LAUNCH_JSON_FOLDERS = ['frontend', 'backend'];

// ---------------------------------------------------------------------------
// Helpers: fake TaskRunner that records invocations + returns a configurable result
// ---------------------------------------------------------------------------

interface RecordedInvocation {
    task: TaskInfo;
    opts: { waitForExit: boolean; timeoutMs: number };
}

function makeFakeRunner(opts: {
    tasks?: TaskInfo[];
    listError?: Error;
    runResult?: TaskExecResult | { started: true };
    runError?: Error;
} = {}): TaskRunner & { invocations: RecordedInvocation[] } {
    const invocations: RecordedInvocation[] = [];
    return {
        invocations,
        async listTasks() {
            if (opts.listError) { throw opts.listError; }
            return opts.tasks ?? TASKS_JSON_FIXTURE;
        },
        async runTask(task, runOpts) {
            invocations.push({ task, opts: runOpts });
            if (opts.runError) { throw opts.runError; }
            return opts.runResult ?? { exitCode: 0, timedOut: false };
        },
    };
}

// ===========================================================================
// runTask
// ===========================================================================

describe('runTaskImpl — name matching + dispatch', () => {

    test('typical call: unique name → runs the right task and reports exit code', async () => {
        const runner = makeFakeRunner();
        const raw = await withTiming('tomAi_runTask:typical', () =>
            runTaskImpl(runner, { name: 'lint' }));
        const r = JSON.parse(raw);
        assert.equal(r.task, 'lint');
        assert.equal(r.exitCode, 0);
        assert.equal(r.timedOut, false);
        assert.match(r.outputNote, /integrated terminal/);
        // Asserted: the right task was invoked.
        assert.equal(runner.invocations.length, 1);
        assert.equal(runner.invocations[0].task.name, 'lint');
        assert.equal(runner.invocations[0].task.scopeName, 'frontend');
    });

    test('omitting name → returns the inventory (saves a round-trip)', async () => {
        const runner = makeFakeRunner();
        const r = JSON.parse(await runTaskImpl(runner, {}));
        assert.equal(r.listOnly, true);
        assert.equal(r.availableTasks.length, 4);
        assert.match(r.availableTasks[0], /build \(scope: frontend/);
        // No task should have been invoked.
        assert.equal(runner.invocations.length, 0);
    });

    test('unknown name → error + inventory in the response', async () => {
        const runner = makeFakeRunner();
        const r = JSON.parse(await runTaskImpl(runner, { name: 'totally-not-a-task' }));
        assert.match(r.error, /Task not found/);
        assert.ok(Array.isArray(r.availableTasks));
        assert.equal(runner.invocations.length, 0);
    });

    test('case-insensitive fallback matches when exact-case misses', async () => {
        const runner = makeFakeRunner();
        // `LINT` ≠ `lint` exactly → falls back to CI; one match → runs.
        const r = JSON.parse(await runTaskImpl(runner, { name: 'LINT' }));
        assert.equal(r.task, 'lint');
        assert.equal(runner.invocations.length, 1);
    });

    test('AMBIGUITY surfaced: multiple tasks with same name → error, no silent first-match', async () => {
        const runner = makeFakeRunner();
        const r = JSON.parse(await runTaskImpl(runner, { name: 'build' }));
        assert.match(r.error, /matched 2 tasks/);
        assert.match(r.error, /Disambiguate/);
        assert.equal(r.matches.length, 2);
        assert.match(r.matches[0], /scope: frontend/);
        assert.match(r.matches[1], /scope: backend/);
        // CRITICAL: nothing must have been invoked on the ambiguous match.
        assert.equal(runner.invocations.length, 0);
    });

    test('waitForExit: false → returns started + note pointing at the live-poll path', async () => {
        const runner = makeFakeRunner({ runResult: { started: true } });
        const r = JSON.parse(await runTaskImpl(runner, { name: 'lint', waitForExit: false }));
        assert.equal(r.task, 'lint');
        assert.equal(r.started, true);
        assert.match(r.note, /waitForExit: true/);
        assert.equal(runner.invocations[0].opts.waitForExit, false);
    });

    test('non-zero exit code is surfaced cleanly', async () => {
        const runner = makeFakeRunner({ runResult: { exitCode: 7, timedOut: false } });
        const r = JSON.parse(await runTaskImpl(runner, { name: 'lint' }));
        assert.equal(r.exitCode, 7);
        assert.equal(r.timedOut, false);
    });

    test('timeout propagates as `timedOut: true` and `exitCode: null`', async () => {
        const runner = makeFakeRunner({ runResult: { exitCode: null, timedOut: true } });
        const r = JSON.parse(await runTaskImpl(runner, { name: 'lint', timeoutMs: 1000 }));
        assert.equal(r.timedOut, true);
        assert.equal(r.exitCode, null);
        assert.equal(runner.invocations[0].opts.timeoutMs, 1000);
    });

    test('timeout < 1000 ms is clamped to 1000 ms (minimum)', async () => {
        const runner = makeFakeRunner();
        await runTaskImpl(runner, { name: 'lint', timeoutMs: 50 });
        assert.equal(runner.invocations[0].opts.timeoutMs, 1000);
    });

    test('listTasks failure returns a clean error JSON (not a thrown stack trace)', async () => {
        const runner = makeFakeRunner({ listError: new Error('vscode unreachable') });
        const r = JSON.parse(await runTaskImpl(runner, { name: 'build' }));
        assert.match(r.error, /Failed to enumerate tasks: vscode unreachable/);
    });

    test('runTask throw is wrapped as an error response, not propagated', async () => {
        const runner = makeFakeRunner({ runError: new Error('terminal exploded') });
        const r = JSON.parse(await runTaskImpl(runner, { name: 'lint' }));
        assert.match(r.error, /Run task failed: terminal exploded/);
    });
});

// ===========================================================================
// runDebugConfig
// ===========================================================================

function makeFakeDebug(opts: {
    folders?: string[];
    startResult?: { started: false; reason: string } | { started: true; sessionName: string | null; timedOut: boolean };
    startError?: Error;
} = {}): DebugRunner & { invocations: Array<{ configName: string; folder: string | undefined; opts: { waitForExit: boolean; timeoutMs: number } }> } {
    const invocations: Array<{ configName: string; folder: string | undefined; opts: { waitForExit: boolean; timeoutMs: number } }> = [];
    return {
        invocations,
        listFolders() { return opts.folders ?? LAUNCH_JSON_FOLDERS; },
        async startDebug(configName, folder, runOpts) {
            invocations.push({ configName, folder, opts: runOpts });
            if (opts.startError) { throw opts.startError; }
            return opts.startResult ?? { started: true as const, sessionName: 'My Session', timedOut: false };
        },
    };
}

describe('runDebugConfigImpl', () => {

    test('typical call: starts the named config, awaits termination, reports session name', async () => {
        const debug = makeFakeDebug();
        const raw = await withTiming('tomAi_runDebugConfig:typical', () =>
            runDebugConfigImpl(debug, { configName: 'Launch Frontend' }));
        const r = JSON.parse(raw);
        assert.equal(r.configName, 'Launch Frontend');
        assert.equal(r.sessionName, 'My Session');
        assert.equal(r.timedOut, false);
        assert.match(r.outputNote, /Debug Console/);
        assert.equal(debug.invocations.length, 1);
        assert.equal(debug.invocations[0].configName, 'Launch Frontend');
        assert.equal(debug.invocations[0].folder, undefined, 'no folder selector → undefined passed through');
    });

    test('missing configName returns an instructive error', async () => {
        const debug = makeFakeDebug();
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const r = JSON.parse(await runDebugConfigImpl(debug, {} as any));
        assert.match(r.error, /`configName` is required/);
        assert.equal(debug.invocations.length, 0);
    });

    test('unknown folder name → error with available folders, no debug started', async () => {
        const debug = makeFakeDebug();
        const r = JSON.parse(await runDebugConfigImpl(debug, {
            configName: 'X',
            folder: 'nope',
        }));
        assert.match(r.error, /Folder not found: "nope"/);
        assert.deepEqual(r.availableFolders, LAUNCH_JSON_FOLDERS);
        assert.equal(debug.invocations.length, 0);
    });

    test('known folder is forwarded to startDebug', async () => {
        const debug = makeFakeDebug();
        await runDebugConfigImpl(debug, { configName: 'X', folder: 'backend' });
        assert.equal(debug.invocations[0].folder, 'backend');
    });

    test('start failure → error with the underlying reason', async () => {
        const debug = makeFakeDebug({
            startResult: { started: false as const, reason: 'launch.json missing config "X"' },
        });
        const r = JSON.parse(await runDebugConfigImpl(debug, { configName: 'X' }));
        assert.match(r.error, /Failed to start debug config "X": launch\.json missing config/);
    });

    test('startDebug throw is wrapped as error JSON', async () => {
        const debug = makeFakeDebug({ startError: new Error('debug API died') });
        const r = JSON.parse(await runDebugConfigImpl(debug, { configName: 'X' }));
        assert.match(r.error, /Debug start failed: debug API died/);
    });

    test('waitForExit: false → started:true with note about live polling', async () => {
        const debug = makeFakeDebug();
        const r = JSON.parse(await runDebugConfigImpl(debug, { configName: 'X', waitForExit: false }));
        assert.equal(r.started, true);
        assert.match(r.note, /Run & Debug view/);
        assert.equal(debug.invocations[0].opts.waitForExit, false);
    });

    test('timeout propagates as `timedOut: true` and `sessionName: null`', async () => {
        const debug = makeFakeDebug({
            startResult: { started: true as const, sessionName: null, timedOut: true },
        });
        const r = JSON.parse(await runDebugConfigImpl(debug, { configName: 'X', timeoutMs: 5000 }));
        assert.equal(r.timedOut, true);
        assert.equal(r.sessionName, null);
        assert.equal(debug.invocations[0].opts.timeoutMs, 5000);
    });
});
