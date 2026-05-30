/**
 * Streaming-process tools — `tomAi_runCommandStream` /
 * `tomAi_readCommandOutput` / `tomAi_killCommand`. Spawns long-running
 * commands and exposes a handle-based read/kill protocol;
 * complements the one-shot `tomAi_runCommand` in `run-command.ts`.
 *
 * A module-level **process registry** tracks spawned children so
 * `readCommandOutput` and `killCommand` can address them by handle.
 *
 * ## Refactor for coverage entry #4
 *
 * Pulled in three fixes the LLM kept tripping over:
 *
 *   1. **Kill the process group, not just the leader.** The previous
 *      `child.kill()` only signalled `/bin/sh`; an inner `sleep 10`
 *      survived, the registry never marked `endedAt`, and the model
 *      had no way to actually stop the run. We now `spawn(...,
 *      { detached: true })` and signal the whole group via
 *      `process.kill(-pid, …)` — same pattern as run-command.ts.
 *
 *   2. **`since: 'all'` no longer eats the cursor.** The old code
 *      advanced `proc.stdoutCursor` on every read regardless of mode,
 *      so a model that did one "give me everything so far" call lost
 *      the ability to follow up with "anything new?" without re-reading
 *      the full transcript. Only `since: 'new'` advances the cursor now.
 *
 *   3. **`cwd` honours the workspace boundary.** A streamed `cwd:
 *      '../../etc'` used to escape silently. Same `isInsideWorkspace`
 *      guard the file-primitive tools use.
 *
 * Each tool exposes an `*Impl(deps, input)` overload so tests can drive
 * it without vscode (the executor wrappers grab `wsRoot` from
 * `vscode.workspace.workspaceFolders` at call time). The registry is
 * module-level state shared across all callers — tests reset it via
 * `_resetRegistryForTesting()`.
 */

import * as path from 'path';
import { spawn, ChildProcess, SpawnOptions } from 'child_process';
import { SharedToolDefinition } from './shared-tool-registry';
import { isInsideWorkspace } from './file-primitives';

// ---------------------------------------------------------------------------
// Shared dep type
// ---------------------------------------------------------------------------

/** Minimal `spawn` surface — production wires `child_process.spawn`. */
export type StreamSpawnFn = (command: string, args: readonly string[], options: SpawnOptions) => ChildProcess;

// ---------------------------------------------------------------------------
// Process registry
// ---------------------------------------------------------------------------

interface TrackedProcess {
    id: string;
    command: string;
    cwd: string;
    child: ChildProcess;
    stdoutBuf: string[];
    stderrBuf: string[];
    stdoutCursor: number;
    stderrCursor: number;
    exitCode: number | null;
    signal: NodeJS.Signals | null;
    startedAt: number;
    endedAt: number | null;
    maxBufferLines: number;
}

const PROCESS_REGISTRY = new Map<string, TrackedProcess>();
let processCounter = 0;
const MAX_BUFFER_LINES_DEFAULT = 2000;
const STREAM_KILL_GRACE_MS = 250;

/** Test-only: drop every tracked process so suites don't leak state. */
export function _resetRegistryForTesting(): void {
    for (const proc of PROCESS_REGISTRY.values()) {
        if (proc.endedAt === null) {
            killTree(proc.child, 'SIGKILL');
        }
    }
    PROCESS_REGISTRY.clear();
    processCounter = 0;
}

function appendBounded(buf: string[], chunk: string, max: number): void {
    const lines = chunk.split('\n');
    if (lines.length && buf.length) {
        buf[buf.length - 1] += lines.shift()!;
    }
    for (const l of lines) { buf.push(l); }
    const overflow = buf.length - max;
    if (overflow > 0) { buf.splice(0, overflow); }
}

function trackProcess(command: string, cwd: string, child: ChildProcess, maxBufferLines: number): TrackedProcess {
    const id = `proc_${++processCounter}_${Date.now().toString(36)}`;
    const proc: TrackedProcess = {
        id, command, cwd, child,
        stdoutBuf: [''],
        stderrBuf: [''],
        stdoutCursor: 0,
        stderrCursor: 0,
        exitCode: null,
        signal: null,
        startedAt: Date.now(),
        endedAt: null,
        maxBufferLines,
    };
    child.stdout?.setEncoding('utf8');
    child.stderr?.setEncoding('utf8');
    child.stdout?.on('data', (d: string) => appendBounded(proc.stdoutBuf, d, maxBufferLines));
    child.stderr?.on('data', (d: string) => appendBounded(proc.stderrBuf, d, maxBufferLines));
    child.on('exit', (code, signal) => {
        proc.exitCode = code;
        proc.signal = signal;
        proc.endedAt = Date.now();
    });
    child.on('error', (err) => {
        appendBounded(proc.stderrBuf, `\n[spawn error] ${err.message}\n`, maxBufferLines);
        if (proc.endedAt === null) {
            proc.exitCode = -1;
            proc.endedAt = Date.now();
        }
    });
    PROCESS_REGISTRY.set(id, proc);
    return proc;
}

/**
 * Kill a `detached: true` child and every process in its group.
 * `child.kill()` would only signal the leader (`/bin/sh`); inner
 * commands (`sleep`, `make`, …) would survive and the close event
 * would never fire.
 */
function killTree(child: ChildProcess, signal: NodeJS.Signals): boolean {
    if (!child.pid) { return false; }
    try {
        process.kill(-child.pid, signal);
        return true;
    } catch {
        try { return child.kill(signal); } catch { return false; }
    }
}

// ---------------------------------------------------------------------------
// tomAi_runCommandStream
// ---------------------------------------------------------------------------

export interface RunCommandStreamInput {
    command: string;
    cwd?: string;
    shell?: boolean;
    maxBufferLines?: number;
}

export interface RunCommandStreamDeps {
    wsRoot: string;
    spawn?: StreamSpawnFn;
}

export async function runCommandStreamImpl(deps: RunCommandStreamDeps, input: RunCommandStreamInput): Promise<string> {
    if (!input.command) {
        return JSON.stringify({ error: '`command` is required.' });
    }
    const cwd = input.cwd ? resolveCwd(input.cwd, deps.wsRoot) : (deps.wsRoot || process.cwd());
    if (!isInsideWorkspace(cwd, deps.wsRoot)) {
        return JSON.stringify({ error: `cwd is outside the workspace: ${input.cwd}` });
    }
    const useShell = input.shell !== false;
    const maxLines = Math.max(100, input.maxBufferLines ?? MAX_BUFFER_LINES_DEFAULT);
    const spawner = deps.spawn ?? spawn;

    let child: ChildProcess;
    try {
        // `detached: true` puts the child in its own process group so
        // `tomAi_killCommand` can take down the WHOLE tree (descendants
        // included) via `process.kill(-pid, …)`.
        const opts: SpawnOptions = { cwd, detached: true };
        if (useShell) {
            child = spawner('/bin/sh', ['-c', input.command], opts);
        } else {
            // shell:false path — splitting on whitespace is documented as
            // a limitation: quoted arguments will break. The recommended
            // path for anything with quoting is `shell: true` (default).
            const parts = input.command.split(/\s+/);
            child = spawner(parts[0], parts.slice(1), opts);
        }
    } catch (err) {
        return JSON.stringify({ error: `Spawn failed: ${(err as Error).message}` });
    }

    const tracked = trackProcess(input.command, cwd, child, maxLines);
    // 50 ms settling window lets fast commands (echo, true) populate
    // stdoutPreview in the immediate response — the model otherwise
    // would have to do a follow-up `readCommandOutput` for trivial
    // commands. Trade-off documented in the tool description.
    await new Promise((r) => setTimeout(r, 50));
    return JSON.stringify({
        handle: tracked.id,
        pid: child.pid ?? null,
        running: tracked.endedAt === null,
        exitCode: tracked.exitCode,
        stdoutPreview: tracked.stdoutBuf.slice(-20).join('\n'),
        stderrPreview: tracked.stderrBuf.slice(-20).join('\n'),
    });
}

export const RUN_COMMAND_STREAM_DESCRIPTION =
    'Spawn a long-running shell command and return a handle immediately. ' +
    'The command runs in its own process group (so `tomAi_killCommand` can ' +
    'kill the whole tree, including `sleep`/`make`/child processes). The ' +
    'response includes the handle, pid, current `running` state, exit code ' +
    '(null if still running), and a preview of the last 20 stdout/stderr ' +
    'lines captured during a 50 ms settling window. Poll progress with ' +
    '`tomAi_readCommandOutput` (handle), terminate with `tomAi_killCommand`. ' +
    'Prefer `tomAi_runCommand` for short fire-and-forget commands. With ' +
    '`shell: false` the command is split on whitespace — quoted arguments ' +
    'will break; keep the default `shell: true` for anything non-trivial.';

export const RUN_COMMAND_STREAM_TOOL: SharedToolDefinition<RunCommandStreamInput> = {
    name: 'tomAi_runCommandStream',
    displayName: 'Run Command (Streaming)',
    description: RUN_COMMAND_STREAM_DESCRIPTION,
    tags: ['terminal', 'streaming', 'tom-ai-chat'],
    readOnly: false,
    requiresApproval: true,
    inputSchema: {
        type: 'object',
        required: ['command'],
        properties: {
            command: { type: 'string', description: 'Shell command line. Passed verbatim to `/bin/sh -c` when `shell: true` (default).' },
            cwd: { type: 'string', description: 'Working directory (workspace-relative or absolute). Default: workspace root.' },
            shell: { type: 'boolean', description: 'Run via `/bin/sh -c`. Default true. Set false to spawn without a shell (no quoting/pipes).' },
            maxBufferLines: { type: 'number', description: 'Max buffered lines per stream (oldest dropped at the cap). Default 2000.' },
        },
    },
    execute: async () => '{"error":"execute() must be installed by tool-executors.ts"}',
};

// ---------------------------------------------------------------------------
// tomAi_readCommandOutput
// ---------------------------------------------------------------------------

export interface ReadCommandOutputInput {
    handle: string;
    since?: 'all' | 'new';
    maxLines?: number;
}

export async function readCommandOutputImpl(_unusedDeps: unknown, input: ReadCommandOutputInput): Promise<string> {
    const proc = PROCESS_REGISTRY.get(input.handle);
    if (!proc) { return JSON.stringify({ error: `Unknown handle: ${input.handle}` }); }
    const mode = input.since ?? 'new';
    const max = Math.max(10, input.maxLines ?? 500);

    const startOut = mode === 'new' ? proc.stdoutCursor : 0;
    const startErr = mode === 'new' ? proc.stderrCursor : 0;
    const out = proc.stdoutBuf.slice(startOut);
    const err = proc.stderrBuf.slice(startErr);
    const outSlice = out.slice(-max);
    const errSlice = err.slice(-max);

    // Only `since: 'new'` advances the cursor — a `since: 'all'` read is
    // for *inspection* and shouldn't eat the unread queue. The previous
    // unconditional advance turned the first `all` call into a silent
    // "skip everything I haven't seen yet" trap.
    if (mode === 'new') {
        proc.stdoutCursor = proc.stdoutBuf.length;
        proc.stderrCursor = proc.stderrBuf.length;
    }

    return JSON.stringify({
        handle: proc.id,
        running: proc.endedAt === null,
        exitCode: proc.exitCode,
        signal: proc.signal,
        startedAt: new Date(proc.startedAt).toISOString(),
        endedAt: proc.endedAt ? new Date(proc.endedAt).toISOString() : null,
        stdout: outSlice.join('\n'),
        stderr: errSlice.join('\n'),
        stdoutLinesReturned: outSlice.length,
        stderrLinesReturned: errSlice.length,
        truncatedStdout: out.length > outSlice.length,
        truncatedStderr: err.length > errSlice.length,
    });
}

export const READ_COMMAND_OUTPUT_DESCRIPTION =
    'Read output from a process started by `tomAi_runCommandStream`. ' +
    '`since: "new"` (default) returns only lines added since the last `new` ' +
    'read for this handle, and advances the per-stream cursor. `since: "all"` ' +
    'returns the full buffered transcript and does NOT advance the cursor — ' +
    'inspection mode. `maxLines` caps each stream at the most recent N lines ' +
    '(default 500); `truncatedStdout` / `truncatedStderr` flag when the cap ' +
    'dropped older content. The response also includes `running`, `exitCode`, ' +
    '`signal`, `startedAt`, and `endedAt` so you can tell whether to poll again.';

export const READ_COMMAND_OUTPUT_TOOL: SharedToolDefinition<ReadCommandOutputInput> = {
    name: 'tomAi_readCommandOutput',
    displayName: 'Read Command Output',
    description: READ_COMMAND_OUTPUT_DESCRIPTION,
    tags: ['terminal', 'streaming', 'tom-ai-chat'],
    readOnly: true,
    inputSchema: {
        type: 'object',
        required: ['handle'],
        properties: {
            handle: { type: 'string', description: 'The handle returned by `tomAi_runCommandStream`.' },
            since: {
                type: 'string',
                enum: ['all', 'new'],
                description: '"new" advances the cursor; "all" leaves it alone (inspection mode). Default "new".',
            },
            maxLines: { type: 'number', description: 'Max lines per stream (most recent kept). Default 500.' },
        },
    },
    execute: async () => '{"error":"execute() must be installed by tool-executors.ts"}',
};

// ---------------------------------------------------------------------------
// tomAi_killCommand
// ---------------------------------------------------------------------------

export interface KillCommandInput {
    handle: string;
    signal?: string;
}

export async function killCommandImpl(_unusedDeps: unknown, input: KillCommandInput): Promise<string> {
    const proc = PROCESS_REGISTRY.get(input.handle);
    if (!proc) { return JSON.stringify({ error: `Unknown handle: ${input.handle}` }); }
    if (proc.endedAt !== null) {
        return JSON.stringify({ handle: proc.id, alreadyExited: true, exitCode: proc.exitCode });
    }
    const signal = (input.signal as NodeJS.Signals | undefined) ?? 'SIGTERM';
    const sent = killTree(proc.child, signal);
    if (!sent) {
        return JSON.stringify({ handle: proc.id, error: `Kill failed (could not signal process group ${proc.child.pid}).` });
    }
    // SIGTERM gets a 250 ms grace window then SIGKILL — same escalation
    // run-command.ts uses for one-shot timeouts. The escalation is fire-
    // and-forget; the caller can poll `readCommandOutput` to confirm
    // `running: false` after the grace period.
    if (signal === 'SIGTERM') {
        setTimeout(() => {
            if (proc.endedAt === null) { killTree(proc.child, 'SIGKILL'); }
        }, STREAM_KILL_GRACE_MS);
    }
    return JSON.stringify({
        handle: proc.id,
        killed: true,
        signal,
        escalatesToSigkillAfterMs: signal === 'SIGTERM' ? STREAM_KILL_GRACE_MS : 0,
    });
}

export const KILL_COMMAND_DESCRIPTION =
    'Send a signal to a process started by `tomAi_runCommandStream`. Default ' +
    'signal is SIGTERM with automatic SIGKILL escalation after a 250 ms grace ' +
    'window (so a stuck shell can\'t survive). Signals the WHOLE process group ' +
    '(not just the leader), so inner `sleep`/`make`/child processes die too. ' +
    'Returns immediately — poll `tomAi_readCommandOutput` to confirm `running: ' +
    'false`. If the process has already exited, the response reports ' +
    '`alreadyExited: true` with the exit code instead of erroring.';

export const KILL_COMMAND_TOOL: SharedToolDefinition<KillCommandInput> = {
    name: 'tomAi_killCommand',
    displayName: 'Kill Streaming Command',
    description: KILL_COMMAND_DESCRIPTION,
    tags: ['terminal', 'streaming', 'tom-ai-chat'],
    readOnly: false,
    requiresApproval: true,
    inputSchema: {
        type: 'object',
        required: ['handle'],
        properties: {
            handle: { type: 'string', description: 'The handle returned by `tomAi_runCommandStream`.' },
            signal: { type: 'string', description: 'Signal name. Default SIGTERM (auto-escalates to SIGKILL after 250 ms).' },
        },
    },
    execute: async () => '{"error":"execute() must be installed by tool-executors.ts"}',
};

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function resolveCwd(cwd: string, wsRoot: string): string {
    return path.isAbsolute(cwd) ? cwd : path.join(wsRoot || process.cwd(), cwd);
}

// ---------------------------------------------------------------------------
// Master list — execute() closures are installed by tool-executors.ts via
// clone-and-override (same pattern as the file-primitive families).
// ---------------------------------------------------------------------------

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export const PROCESS_TOOLS: SharedToolDefinition<any>[] = [
    RUN_COMMAND_STREAM_TOOL,
    READ_COMMAND_OUTPUT_TOOL,
    KILL_COMMAND_TOOL,
];
