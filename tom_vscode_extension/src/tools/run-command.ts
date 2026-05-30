/**
 * `tomAi_runCommand` — one-shot shell execution.
 *
 * Carved out of `tool-executors.ts`. The previous implementation called
 * `util.promisify(exec)` with a 1 MB buffer and no timeout, surfaced
 * exit codes only when `exec` threw (so non-zero exit became
 * `Error: Command failed: ...`), and dropped `stderr` whenever
 * `stdout` was non-empty.
 *
 * This rewrite gives the LLM each piece of information it might need:
 *
 *   - **Exit code** explicit on every non-zero or otherwise-noteworthy
 *     run (success+empty stays minimal so the common case stays terse).
 *   - **stdout and stderr never lose each other** — when both have
 *     content, both are reported in labelled sections.
 *   - **Timeout** (default 30 s; pass `timeoutMs: 0` to disable). On
 *     timeout we `SIGTERM` first, escalate to `SIGKILL` after a 250 ms
 *     grace period, and report whatever output the child produced
 *     before the kill — useful for "it hung; here's where it got to".
 *   - **Buffer cap** raised to 10 MB. Hitting it appends an explicit
 *     truncation note instead of throwing — the model gets the first
 *     10 MB of output plus a clear "output truncated at N bytes" line.
 *   - **Shell semantics** documented: yes, `&&` / `||` / pipes work;
 *     `command` is passed verbatim to `/bin/sh -c`. Quoting is the
 *     caller's responsibility (same as a terminal).
 *
 * Implementation goes through `child_process.spawn('/bin/sh', ['-c',
 * cmd])` rather than `exec()` so we can drive the lifecycle directly.
 * `exec()` wraps spawn + buffered capture + maxBuffer in a way that
 * doesn't expose the underlying ChildProcess for kill-on-timeout.
 *
 * The Impl is `*Impl(deps, input)` so tests inject a fake spawner;
 * production wires the real `child_process.spawn`. The fake spawner
 * is also how the test suite forces a timeout and a truncation
 * deterministically without depending on real-clock sleep.
 */

import { spawn, ChildProcess } from 'child_process';
import * as path from 'path';
import { SharedToolDefinition } from './shared-tool-registry';
import { isInsideWorkspace } from './file-primitives';

// ---------------------------------------------------------------------------
// Input shape
// ---------------------------------------------------------------------------

export interface RunCommandInput {
    command: string;
    cwd?: string;
    /** Default 30 000 ms. Pass `0` to disable. */
    timeoutMs?: number;
    /** Merged into the parent env; does not replace it. */
    env?: Record<string, string>;
}

// ---------------------------------------------------------------------------
// Deps — production wires `child_process.spawn`; tests pass a fake.
// ---------------------------------------------------------------------------

/**
 * Minimal shape the impl needs from `spawn`. Returning `ChildProcess`
 * keeps the test fakes interchangeable with the real one (we only
 * touch the bits documented here).
 */
export type SpawnFn = (command: string, args: string[], options: { cwd: string; env: NodeJS.ProcessEnv }) => ChildProcess;

export interface RunCommandDeps {
    wsRoot: string;
    spawn?: SpawnFn;
}

const DEFAULT_TIMEOUT_MS = 30_000;
const DEFAULT_MAX_BUFFER = 10 * 1024 * 1024;  // 10 MB per stream
const KILL_GRACE_MS = 250;                    // SIGTERM → SIGKILL window

// ---------------------------------------------------------------------------
// Impl
// ---------------------------------------------------------------------------

export async function runCommandImpl(deps: RunCommandDeps, input: RunCommandInput): Promise<string> {
    if (!input.command || typeof input.command !== 'string') {
        return 'Error: `command` is required and must be a non-empty string.';
    }
    const cwd = resolveCwd(input.cwd, deps.wsRoot);
    if (!isInsideWorkspace(cwd, deps.wsRoot)) {
        return `Error: cwd is outside the workspace: ${input.cwd}`;
    }
    const timeoutMs = input.timeoutMs === undefined ? DEFAULT_TIMEOUT_MS : Math.max(0, input.timeoutMs);
    const env: NodeJS.ProcessEnv = { ...process.env, ...(input.env ?? {}) };
    const spawner = deps.spawn ?? spawn;

    let child: ChildProcess;
    try {
        // `detached: true` puts the shell in its own process group so we can
        // kill the **whole tree** on timeout via `process.kill(-pid, …)`.
        // Without this, `child.kill('SIGTERM')` would only signal /bin/sh —
        // an inner `sleep 10` would survive and we'd hang waiting on `close`.
        child = spawner('/bin/sh', ['-c', input.command], { cwd, env, detached: true });
    } catch (err) {
        return `Error: failed to spawn shell: ${(err as Error).message}`;
    }

    return new Promise<string>((resolve) => {
        let stdout = '';
        let stderr = '';
        let stdoutTruncated = false;
        let stderrTruncated = false;
        let timedOut = false;
        let timeoutHandle: NodeJS.Timeout | undefined;
        let killEscalationHandle: NodeJS.Timeout | undefined;
        let settled = false;

        const settle = (output: string) => {
            if (settled) { return; }
            settled = true;
            if (timeoutHandle) { clearTimeout(timeoutHandle); }
            if (killEscalationHandle) { clearTimeout(killEscalationHandle); }
            resolve(output);
        };

        const appendBounded = (existing: string, chunk: string, alreadyTruncated: boolean): { next: string; truncated: boolean } => {
            if (alreadyTruncated) { return { next: existing, truncated: true }; }
            const remaining = DEFAULT_MAX_BUFFER - existing.length;
            if (chunk.length <= remaining) {
                return { next: existing + chunk, truncated: false };
            }
            return { next: existing + chunk.slice(0, remaining), truncated: true };
        };

        child.stdout?.on('data', (data: Buffer | string) => {
            const r = appendBounded(stdout, data.toString(), stdoutTruncated);
            stdout = r.next;
            stdoutTruncated = r.truncated;
        });
        child.stderr?.on('data', (data: Buffer | string) => {
            const r = appendBounded(stderr, data.toString(), stderrTruncated);
            stderr = r.next;
            stderrTruncated = r.truncated;
        });

        child.on('error', (err) => {
            settle(`Error: failed to run command: ${err.message}`);
        });

        child.on('close', (code, signal) => {
            settle(formatResult({
                stdout,
                stderr,
                stdoutTruncated,
                stderrTruncated,
                exitCode: code,
                signal,
                timedOut,
                timeoutMs,
            }));
        });

        if (timeoutMs > 0) {
            timeoutHandle = setTimeout(() => {
                timedOut = true;
                killTree(child, 'SIGTERM');
                killEscalationHandle = setTimeout(() => {
                    killTree(child, 'SIGKILL');
                }, KILL_GRACE_MS);
            }, timeoutMs);
        }
    });
}

// ---------------------------------------------------------------------------
// Output formatting
// ---------------------------------------------------------------------------

interface FormatInput {
    stdout: string;
    stderr: string;
    stdoutTruncated: boolean;
    stderrTruncated: boolean;
    exitCode: number | null;
    signal: NodeJS.Signals | null;
    timedOut: boolean;
    timeoutMs: number;
}

function formatResult(r: FormatInput): string {
    const truncationNote = (label: string, present: boolean) =>
        present ? `\n(${label} truncated at ${DEFAULT_MAX_BUFFER.toLocaleString()} bytes — re-run with a tighter scope)` : '';
    const stdoutWithNote = r.stdout + truncationNote('stdout', r.stdoutTruncated);
    const stderrWithNote = r.stderr + truncationNote('stderr', r.stderrTruncated);

    if (r.timedOut) {
        const sections = [`Command timed out after ${r.timeoutMs} ms (sent SIGTERM, then SIGKILL after ${KILL_GRACE_MS} ms).`];
        if (stdoutWithNote.trim()) { sections.push('stdout:', stdoutWithNote.trimEnd()); }
        if (stderrWithNote.trim()) { sections.push('stderr:', stderrWithNote.trimEnd()); }
        return sections.join('\n');
    }

    // Successful exit, no stderr: terse path — just the stdout, or '(no output)'.
    if (r.exitCode === 0 && !stderrWithNote.trim()) {
        const trimmed = stdoutWithNote.trimEnd();
        return trimmed.length > 0 ? trimmed : '(no output)';
    }
    // Successful exit but stderr emitted: keep both labelled.
    if (r.exitCode === 0) {
        const sections: string[] = [];
        if (stdoutWithNote.trim()) { sections.push('stdout:', stdoutWithNote.trimEnd()); }
        sections.push('stderr:', stderrWithNote.trimEnd());
        return sections.join('\n');
    }

    // Non-zero exit (or killed by signal).
    const header = r.signal && r.exitCode === null
        ? `Command terminated by signal ${r.signal}.`
        : `Command exited with code ${r.exitCode}.`;
    const sections = [header];
    if (stdoutWithNote.trim()) { sections.push('stdout:', stdoutWithNote.trimEnd()); }
    if (stderrWithNote.trim()) { sections.push('stderr:', stderrWithNote.trimEnd()); }
    return sections.join('\n');
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function resolveCwd(cwd: string | undefined, wsRoot: string): string {
    if (!cwd) { return wsRoot || process.cwd(); }
    return path.isAbsolute(cwd) ? cwd : path.join(wsRoot || process.cwd(), cwd);
}

/**
 * Kill a `detached: true`-spawned process **and its descendants** via
 * the process group. `child.kill()` would only signal the leader
 * (/bin/sh), leaving anything it forked (`sleep`, build sub-processes,
 * etc.) running — so the close event would never fire and the impl
 * would hang until the inner command finished naturally.
 *
 * `process.kill(-pid, signal)` signals the whole group. We swallow
 * errors silently because the most common reason for failure here is
 * "the group is already gone" (race with natural exit).
 */
function killTree(child: ChildProcess, signal: NodeJS.Signals): void {
    if (!child.pid) { return; }
    try {
        process.kill(-child.pid, signal);
    } catch {
        // Group already gone, or we lost the race with a natural exit.
        // Fall back to a direct kill in case the child is still here.
        try { child.kill(signal); } catch { /* truly gone */ }
    }
}

// ---------------------------------------------------------------------------
// Tool definition
// ---------------------------------------------------------------------------

export const RUN_COMMAND_DESCRIPTION =
    'Run a shell command and return its output. The command is passed verbatim ' +
    'to `/bin/sh -c`, so `&&`, `||`, pipes, env-var expansion, and quoting all ' +
    'work exactly as in a terminal. The shell inherits the parent environment ' +
    '(plus any keys passed via `env`). `cwd` defaults to the workspace root ' +
    '(workspace-relative or absolute; rejected if it escapes the workspace). ' +
    'Default timeout is 30 s — exceeding it sends SIGTERM then SIGKILL and ' +
    'returns the partial output. stdout and stderr are both captured; the ' +
    'response includes the exit code on any non-zero or signal exit. Buffer ' +
    'cap is 10 MB per stream; output past that is explicitly truncated rather ' +
    'than silently dropped.';

export const RUN_COMMAND_TOOL: SharedToolDefinition<RunCommandInput> = {
    name: 'tomAi_runCommand',
    displayName: 'Run Command',
    description: RUN_COMMAND_DESCRIPTION,
    tags: ['terminal', 'tom-ai-chat'],
    readOnly: false,
    inputSchema: {
        type: 'object',
        properties: {
            command: { type: 'string', description: 'Shell command line. Passed verbatim to `/bin/sh -c`.' },
            cwd: { type: 'string', description: 'Working directory (workspace-relative or absolute). Default: workspace root.' },
            timeoutMs: { type: 'number', description: 'Kill after N ms (default 30000, set 0 to disable).' },
            env: {
                type: 'object',
                description: 'Extra environment variables merged into the parent env.',
                additionalProperties: { type: 'string' },
            },
        },
        required: ['command'],
    },
    execute: async () => 'execute() must be installed by tool-executors.ts',
};
