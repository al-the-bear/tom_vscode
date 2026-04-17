/**
 * Git tools — read + write variants, plus `git show`.
 *
 * `tomAi_gitRead` is the read-only companion (status / diff / log / blame).
 * `tomAi_gitShow` exposes historical revisions.
 * `tomAi_gitWrite` gates git write commands behind an allow-list and approval.
 */

import * as vscode from 'vscode';
import * as path from 'path';
import { execFile } from 'child_process';
import { promisify } from 'util';
import { SharedToolDefinition } from './shared-tool-registry';

const execFileAsync = promisify(execFile);

function wsRoot(): string | undefined {
    return vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
}

function resolvePath(filePath: string): string {
    if (path.isAbsolute(filePath)) { return filePath; }
    const root = wsRoot();
    return root ? path.join(root, filePath) : filePath;
}

// ---------------------------------------------------------------------------
// tomAi_gitRead — read-only subcommands
// ---------------------------------------------------------------------------

export interface GitInput {
    subcommand: 'status' | 'diff' | 'log' | 'blame';
    args?: string[];
}

const ALLOWED_GIT_READ_SUBCOMMANDS = new Set(['status', 'diff', 'log', 'blame']);

async function executeGit(input: GitInput): Promise<string> {
    const sub = (input.subcommand || '').toString();
    if (!ALLOWED_GIT_READ_SUBCOMMANDS.has(sub)) {
        return `Error: subcommand must be one of status, diff, log, blame.`;
    }
    const args = Array.isArray(input.args)
        ? input.args.filter((a): a is string => typeof a === 'string')
        : [];
    const cwd = wsRoot() ?? '';
    try {
        const { stdout, stderr } = await execFileAsync('git', [sub, ...args], {
            cwd,
            maxBuffer: 4 * 1024 * 1024,
        });
        return stdout || stderr || '(no output)';
    } catch (error: any) {
        const stderr = error?.stderr ? `\n${error.stderr}` : '';
        return `Error: ${error?.message ?? String(error)}${stderr}`;
    }
}

export const GIT_TOOL: SharedToolDefinition<GitInput> = {
    name: 'tomAi_gitRead',
    displayName: 'Git',
    description: 'Run a structured read-only git command (status, diff, log, blame) and return its output.',
    tags: ['git', 'tom-ai-chat'],
    readOnly: true,
    requiresApproval: false,
    inputSchema: {
        type: 'object',
        properties: {
            subcommand: {
                type: 'string',
                enum: ['status', 'diff', 'log', 'blame'],
                description: 'Git subcommand to run.',
            },
            args: {
                type: 'array',
                description: 'Optional arguments appended after the subcommand (e.g. ["--stat"], ["-n","20"]).',
                items: { type: 'string' },
            },
        },
        required: ['subcommand'],
    },
    execute: executeGit,
};

// ---------------------------------------------------------------------------
// tomAi_gitWrite — write subcommands (allow-listed, approval-gated)
// ---------------------------------------------------------------------------

const GIT_WRITE_ALLOWLIST: ReadonlySet<string> = new Set([
    'add', 'commit', 'push', 'pull', 'fetch', 'checkout', 'branch', 'merge',
    'rebase', 'reset', 'restore', 'stash', 'tag', 'cherry-pick', 'revert',
    'switch', 'rm', 'mv', 'clean', 'apply', 'am', 'config',
]);

interface GitExecInput { subcommand: string; args?: string[]; cwd?: string; timeoutMs?: number }

async function executeGitExec(input: GitExecInput): Promise<string> {
    if (!input.subcommand) { return JSON.stringify({ error: 'subcommand is required' }); }
    if (!GIT_WRITE_ALLOWLIST.has(input.subcommand)) {
        return JSON.stringify({
            error: `Subcommand not in allow-list: "${input.subcommand}".`,
            allowed: Array.from(GIT_WRITE_ALLOWLIST).sort(),
        });
    }
    const cwd = input.cwd ? resolvePath(input.cwd) : wsRoot();
    if (!cwd) { return JSON.stringify({ error: 'No working directory available.' }); }
    const args = Array.isArray(input.args)
        ? input.args.filter((a): a is string => typeof a === 'string')
        : [];
    const timeout = Math.max(1000, input.timeoutMs ?? 60_000);
    try {
        const { stdout, stderr } = await execFileAsync('git', [input.subcommand, ...args], {
            cwd, maxBuffer: 8 * 1024 * 1024, timeout,
        });
        return JSON.stringify({ success: true, subcommand: input.subcommand, stdout, stderr }, null, 2);
    } catch (err: any) {
        return JSON.stringify({
            success: false,
            subcommand: input.subcommand,
            error: err?.message ?? String(err),
            stdout: err?.stdout ?? '',
            stderr: err?.stderr ?? '',
            exitCode: err?.code ?? null,
        });
    }
}

export const GIT_EXEC_TOOL: SharedToolDefinition<GitExecInput> = {
    name: 'tomAi_gitWrite',
    displayName: 'Git Exec (Write)',
    description:
        'Run a git write command (add/commit/push/branch/checkout/merge/rebase/etc.). ' +
        'Allow-listed subcommands only. Approval required.',
    tags: ['git', 'execution', 'tom-ai-chat'],
    readOnly: false,
    requiresApproval: true,
    inputSchema: {
        type: 'object',
        required: ['subcommand'],
        properties: {
            subcommand: { type: 'string', description: 'Git subcommand (see allow-list in error message).' },
            args: { type: 'array', items: { type: 'string' } },
            cwd: { type: 'string', description: 'Working directory. Default: workspace root.' },
            timeoutMs: { type: 'number', description: 'Timeout in ms. Default 60000.' },
        },
    },
    execute: executeGitExec,
};

// ---------------------------------------------------------------------------
// tomAi_gitShow
// ---------------------------------------------------------------------------

interface GitShowInput { ref: string; filePath?: string; cwd?: string }

async function executeGitShow(input: GitShowInput): Promise<string> {
    if (!input.ref) { return JSON.stringify({ error: 'ref is required' }); }
    const cwd = input.cwd ? resolvePath(input.cwd) : wsRoot();
    if (!cwd) { return JSON.stringify({ error: 'No working directory available.' }); }
    const target = input.filePath ? `${input.ref}:${input.filePath}` : input.ref;
    try {
        const { stdout, stderr } = await execFileAsync('git', ['show', target], {
            cwd, maxBuffer: 16 * 1024 * 1024, timeout: 30_000,
        });
        return JSON.stringify({ ref: input.ref, filePath: input.filePath, stdout, stderr }, null, 2);
    } catch (err: any) {
        return JSON.stringify({ error: err?.message ?? String(err), stderr: err?.stderr ?? '' });
    }
}

export const GIT_SHOW_TOOL: SharedToolDefinition<GitShowInput> = {
    name: 'tomAi_gitShow',
    displayName: 'Git Show',
    description:
        'Run `git show <ref>` or `git show <ref>:<path>` to inspect a commit or a file at a revision.',
    tags: ['git', 'tom-ai-chat'],
    readOnly: true,
    inputSchema: {
        type: 'object',
        required: ['ref'],
        properties: {
            ref: { type: 'string', description: 'Commit / branch / tag ref.' },
            filePath: { type: 'string', description: 'Optional file path at the ref.' },
            cwd: { type: 'string', description: 'Working directory. Default: workspace root.' },
        },
    },
    execute: executeGitShow,
};

// ---------------------------------------------------------------------------
// Master list
// ---------------------------------------------------------------------------

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export const GIT_TOOLS: SharedToolDefinition<any>[] = [
    GIT_TOOL,
    GIT_SHOW_TOOL,
    GIT_EXEC_TOOL,
];
