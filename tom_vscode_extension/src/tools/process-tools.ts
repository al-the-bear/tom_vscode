/**
 * Streaming-process tools — spawn long-running commands with a handle-based
 * read/kill protocol. Complements the one-shot `tomAi_runCommand` in
 * `tool-executors.ts`.
 *
 * A module-level **process registry** tracks spawned children so
 * `tomAi_readCommandOutput` and `tomAi_killCommand` can address them by handle.
 */

import * as vscode from 'vscode';
import * as path from 'path';
import { spawn, ChildProcess } from 'child_process';
import { SharedToolDefinition } from './shared-tool-registry';

function wsRoot(): string | undefined {
    return vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
}

function resolvePath(filePath: string): string {
    if (path.isAbsolute(filePath)) { return filePath; }
    const root = wsRoot();
    return root ? path.join(root, filePath) : filePath;
}

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

// ---------------------------------------------------------------------------
// tomAi_runCommandStream
// ---------------------------------------------------------------------------

interface RunCommandStreamInput {
    command: string;
    cwd?: string;
    shell?: boolean;
    maxBufferLines?: number;
}

async function executeRunCommandStream(input: RunCommandStreamInput): Promise<string> {
    if (!input.command) { return JSON.stringify({ error: 'command is required' }); }
    const cwd = input.cwd ? resolvePath(input.cwd) : (wsRoot() ?? process.cwd());
    const useShell = input.shell !== false;
    const maxLines = Math.max(100, input.maxBufferLines ?? MAX_BUFFER_LINES_DEFAULT);

    try {
        const child = useShell
            ? spawn(input.command, { cwd, shell: true })
            : spawn(input.command.split(/\s+/)[0], input.command.split(/\s+/).slice(1), { cwd });
        const tracked = trackProcess(input.command, cwd, child, maxLines);
        await new Promise((r) => setTimeout(r, 50));
        return JSON.stringify({
            handle: tracked.id,
            pid: child.pid ?? null,
            running: tracked.endedAt === null,
            exitCode: tracked.exitCode,
            stdoutPreview: tracked.stdoutBuf.slice(-20).join('\n'),
            stderrPreview: tracked.stderrBuf.slice(-20).join('\n'),
        });
    } catch (err: any) {
        return JSON.stringify({ error: `Spawn failed: ${err?.message ?? err}` });
    }
}

export const RUN_COMMAND_STREAM_TOOL: SharedToolDefinition<RunCommandStreamInput> = {
    name: 'tomAi_runCommandStream',
    displayName: 'Run Command (Streaming)',
    description:
        'Spawn a shell command and return a handle immediately. Use tomAi_readCommandOutput ' +
        'to poll for new stdout/stderr and exit code; tomAi_killCommand to terminate. ' +
        'Prefer tomAi_runCommand for short fire-and-forget commands.',
    tags: ['terminal', 'streaming', 'tom-ai-chat'],
    readOnly: false,
    requiresApproval: true,
    inputSchema: {
        type: 'object',
        required: ['command'],
        properties: {
            command: { type: 'string' },
            cwd: { type: 'string', description: 'Working directory. Default: workspace root.' },
            shell: { type: 'boolean', description: 'Run via shell. Default true.' },
            maxBufferLines: { type: 'number', description: 'Max buffered lines per stream. Default 2000.' },
        },
    },
    execute: executeRunCommandStream,
};

// ---------------------------------------------------------------------------
// tomAi_readCommandOutput
// ---------------------------------------------------------------------------

interface ReadCommandOutputInput { handle: string; since?: 'all' | 'new'; maxLines?: number }

async function executeReadCommandOutput(input: ReadCommandOutputInput): Promise<string> {
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
    proc.stdoutCursor = proc.stdoutBuf.length;
    proc.stderrCursor = proc.stderrBuf.length;

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

export const READ_COMMAND_OUTPUT_TOOL: SharedToolDefinition<ReadCommandOutputInput> = {
    name: 'tomAi_readCommandOutput',
    displayName: 'Read Command Output',
    description:
        'Read new or all output from a process started by tomAi_runCommandStream. ' +
        'By default returns only new lines since the last read (since=\"new\").',
    tags: ['terminal', 'streaming', 'tom-ai-chat'],
    readOnly: true,
    inputSchema: {
        type: 'object',
        required: ['handle'],
        properties: {
            handle: { type: 'string' },
            since: { type: 'string', enum: ['all', 'new'], description: 'Default "new".' },
            maxLines: { type: 'number', description: 'Max lines per stream. Default 500.' },
        },
    },
    execute: executeReadCommandOutput,
};

// ---------------------------------------------------------------------------
// tomAi_killCommand
// ---------------------------------------------------------------------------

interface KillCommandInput { handle: string; signal?: string }

async function executeKillCommand(input: KillCommandInput): Promise<string> {
    const proc = PROCESS_REGISTRY.get(input.handle);
    if (!proc) { return JSON.stringify({ error: `Unknown handle: ${input.handle}` }); }
    if (proc.endedAt !== null) {
        return JSON.stringify({ handle: proc.id, alreadyExited: true, exitCode: proc.exitCode });
    }
    try {
        proc.child.kill((input.signal as NodeJS.Signals | undefined) ?? 'SIGTERM');
        return JSON.stringify({ handle: proc.id, killed: true, signal: input.signal ?? 'SIGTERM' });
    } catch (err: any) {
        return JSON.stringify({ error: `Kill failed: ${err?.message ?? err}` });
    }
}

export const KILL_COMMAND_TOOL: SharedToolDefinition<KillCommandInput> = {
    name: 'tomAi_killCommand',
    displayName: 'Kill Streaming Command',
    description: 'Send a signal (default SIGTERM) to a process started by tomAi_runCommandStream.',
    tags: ['terminal', 'streaming', 'tom-ai-chat'],
    readOnly: false,
    requiresApproval: true,
    inputSchema: {
        type: 'object',
        required: ['handle'],
        properties: {
            handle: { type: 'string' },
            signal: { type: 'string', description: 'Signal name (e.g. SIGTERM, SIGKILL). Default SIGTERM.' },
        },
    },
    execute: executeKillCommand,
};

// ---------------------------------------------------------------------------
// Master list
// ---------------------------------------------------------------------------

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export const PROCESS_TOOLS: SharedToolDefinition<any>[] = [
    RUN_COMMAND_STREAM_TOOL,
    READ_COMMAND_OUTPUT_TOOL,
    KILL_COMMAND_TOOL,
];
