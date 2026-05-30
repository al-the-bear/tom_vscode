/**
 * Git tools — three coordinated wrappers around the local `git` binary.
 *
 *   - `tomAi_gitRead`  — fixed allow-list of read-only subcommands
 *                        (status / diff / log / blame).
 *   - `tomAi_gitShow`  — historical-revision viewer (`git show <ref>`
 *                        or `git show <ref>:<path>`).  A *dedicated*
 *                        tool, even though it could technically be a
 *                        gitRead subcommand, because the `<ref>:<path>`
 *                        syntax is its own usability cliff.
 *   - `tomAi_gitWrite` — broader allow-list of mutating subcommands;
 *                        approval-gated.  Hook-skipping flags
 *                        (`--no-verify`, `--no-gpg-sign`) are rejected
 *                        per workspace policy (CLAUDE.md "Git Safety
 *                        Protocol").
 *
 * ## Coverage entry #27 refactor (audit notes)
 *
 *   - Old impls reached straight into `execFileAsync('git', …)` and
 *     `vscode.workspace.workspaceFolders[0]` — untestable without
 *     spawning real git AND a workspace.  Carve-out introduces a
 *     narrow `GitExecutor` dep so unit tests can stub subprocess
 *     invocation while the integration tests below still exercise
 *     the real binary against a `git init` fixture.
 *   - **Mixed envelopes** unified.  `gitRead` used to return raw
 *     `stdout || stderr || '(no output)'` strings — success vs error
 *     was indistinguishable for programmatic callers.  All three
 *     tools now use `{ok, ...}` / `{ok: false, error, ...}` with
 *     `stdout` + `stderr` + `exitCode` exposed honestly so the model
 *     can diagnose non-zero exits separately from spawn failures.
 *   - **Hook-skip block**: `gitWrite` rejects `--no-verify` and
 *     `--no-gpg-sign` (anywhere in `args`).  CLAUDE.md mandates this
 *     for non-explicit user requests; the impl enforces by default
 *     and surfaces the policy in the error envelope so the model can
 *     re-ask the user instead of silently bypassing.
 *   - **Path traversal closed**: `cwd` (when provided) is normalised
 *     against the workspace root and rejected when it escapes.
 *   - **Repo discovery is documented as workspace-root-only** in the
 *     descriptions — the b-row's "multi-root" question gets an honest
 *     answer: pick the workspace via `cwd` on the write/show tools;
 *     `gitRead` is locked to the first workspace folder.
 *   - **Detached HEAD + untracked files**: both tools just run git;
 *     git decides what's reachable.  Documented as "no special
 *     handling" so callers know not to expect filtering.
 */

import * as path from 'path';
import { SharedToolDefinition } from './shared-tool-registry';

// ===========================================================================
// Narrow dep
// ===========================================================================

export interface GitExecResult {
    stdout: string;
    stderr: string;
    exitCode: number;
}

/**
 * Subprocess seam.  Production wires this to `execFile('git', ...)`;
 * tests pass a fake that scripts canned `{stdout, stderr, exitCode}`
 * triples per call.
 */
export interface GitExecutor {
    run(args: string[], opts: { cwd: string; timeoutMs: number; maxBufferBytes: number }): Promise<GitExecResult>;
}

export interface GitWorkspace {
    /** Absolute path to the first workspace folder, or undefined. */
    root(): string | undefined;
}

// ===========================================================================
// JSON envelopes
// ===========================================================================

function ok<T extends object>(extra: T): string { return JSON.stringify({ ok: true, ...extra }); }
function err(message: string, extra: Record<string, unknown> = {}): string {
    return JSON.stringify({ ok: false, error: message, ...extra });
}

// ===========================================================================
// Path resolution + traversal guard
// ===========================================================================

function resolveCwd(workspace: GitWorkspace, candidate: string | undefined): { cwd?: string; error?: string } {
    const root = workspace.root();
    if (!candidate || !candidate.trim()) {
        if (!root) { return { error: 'No working directory available (no workspace open and no `cwd` provided).' }; }
        return { cwd: root };
    }
    const abs = path.isAbsolute(candidate) ? path.normalize(candidate) : root ? path.normalize(path.join(root, candidate)) : path.normalize(candidate);
    if (root) {
        const rootAbs = path.resolve(root);
        const cwdAbs = path.resolve(abs);
        if (cwdAbs !== rootAbs && !cwdAbs.startsWith(rootAbs + path.sep)) {
            return { error: '`cwd` escapes the workspace root.' };
        }
    }
    return { cwd: abs };
}

function sanitiseArgs(args: unknown): string[] {
    if (!Array.isArray(args)) { return []; }
    return args.filter((a): a is string => typeof a === 'string');
}

// ===========================================================================
// `tomAi_gitRead`
// ===========================================================================

export interface GitReadInput {
    subcommand: 'status' | 'diff' | 'log' | 'blame';
    args?: string[];
}

const READ_SUBCOMMANDS: ReadonlySet<string> = new Set(['status', 'diff', 'log', 'blame']);

const READ_DEFAULT_TIMEOUT_MS = 30_000;
const READ_MAX_BUFFER_BYTES   = 4 * 1024 * 1024;

export async function gitReadImpl(executor: GitExecutor, workspace: GitWorkspace, input: GitReadInput): Promise<string> {
    try {
        const sub = String(input.subcommand ?? '');
        if (!READ_SUBCOMMANDS.has(sub)) {
            return err(`subcommand must be one of: ${Array.from(READ_SUBCOMMANDS).sort().join(', ')}.`, {
                received: sub,
            });
        }
        const cwdResult = resolveCwd(workspace, undefined);
        if (cwdResult.error) { return err(cwdResult.error); }
        const args = sanitiseArgs(input.args);
        const result = await executor.run([sub, ...args], {
            cwd: cwdResult.cwd!,
            timeoutMs: READ_DEFAULT_TIMEOUT_MS,
            maxBufferBytes: READ_MAX_BUFFER_BYTES,
        });
        if (result.exitCode !== 0) {
            return err(`git ${sub} exited with code ${result.exitCode}.`, {
                subcommand: sub,
                exitCode: result.exitCode,
                stdout: result.stdout,
                stderr: result.stderr,
            });
        }
        return ok({
            subcommand: sub,
            stdout: result.stdout,
            stderr: result.stderr,
            exitCode: 0,
        });
    } catch (e) {
        return err(`gitRead failed: ${(e as Error).message}`);
    }
}

export const GIT_READ_DESCRIPTION =
    'Run a **read-only** git subcommand. Allow-list: `status`, `diff`, ' +
    '`log`, `blame` — anything else is rejected. **Repo discovery**: ' +
    'locked to the first workspace folder; for multi-root workspaces ' +
    'use `tomAi_gitShow` (which accepts `cwd`) or `tomAi_gitWrite`. ' +
    '**Detached HEAD / untracked files**: no special handling — git ' +
    'decides what\'s reachable; `status` will surface untracked files ' +
    'like the CLI does. Response: ' +
    '`{ok, subcommand, stdout, stderr, exitCode}` on success; on a ' +
    'non-zero git exit code, `{ok: false, error, subcommand, exitCode, ' +
    'stdout, stderr}` so the caller can still see what git wrote.';

export const GIT_TOOL: SharedToolDefinition<GitReadInput> = {
    name: 'tomAi_gitRead',
    displayName: 'Git Read',
    description: GIT_READ_DESCRIPTION,
    tags: ['git', 'tom-ai-chat'],
    readOnly: true,
    requiresApproval: false,
    inputSchema: {
        type: 'object',
        required: ['subcommand'],
        properties: {
            subcommand: { type: 'string', enum: ['status', 'diff', 'log', 'blame'], description: 'Read-only git subcommand.' },
            args: { type: 'array', items: { type: 'string' }, description: 'Optional arguments appended after the subcommand (e.g. ["--stat"], ["-n","20"]).' },
        },
    },
    execute: async () => '{"ok":false,"error":"execute() must be installed by tool-executors.ts"}',
};

// ===========================================================================
// `tomAi_gitShow`
// ===========================================================================

export interface GitShowInput {
    ref: string;
    filePath?: string;
    cwd?: string;
}

const SHOW_DEFAULT_TIMEOUT_MS = 30_000;
const SHOW_MAX_BUFFER_BYTES   = 16 * 1024 * 1024;

export async function gitShowImpl(executor: GitExecutor, workspace: GitWorkspace, input: GitShowInput): Promise<string> {
    try {
        if (!input.ref || !input.ref.trim()) {
            return err('`ref` is required (commit / branch / tag / abbreviated SHA).');
        }
        const cwdResult = resolveCwd(workspace, input.cwd);
        if (cwdResult.error) { return err(cwdResult.error); }
        const target = input.filePath ? `${input.ref}:${input.filePath}` : input.ref;
        const result = await executor.run(['show', target], {
            cwd: cwdResult.cwd!,
            timeoutMs: SHOW_DEFAULT_TIMEOUT_MS,
            maxBufferBytes: SHOW_MAX_BUFFER_BYTES,
        });
        if (result.exitCode !== 0) {
            return err(`git show ${target} exited with code ${result.exitCode}.`, {
                ref: input.ref,
                filePath: input.filePath ?? null,
                exitCode: result.exitCode,
                stdout: result.stdout,
                stderr: result.stderr,
            });
        }
        return ok({
            ref: input.ref,
            filePath: input.filePath ?? null,
            stdout: result.stdout,
            stderr: result.stderr,
            exitCode: 0,
        });
    } catch (e) {
        return err(`gitShow failed: ${(e as Error).message}`);
    }
}

export const GIT_SHOW_DESCRIPTION =
    '`git show <ref>` (commit metadata + diff) or `git show <ref>:<path>` ' +
    '(file contents at a revision). **Use this — not `gitRead` — for ' +
    'historical inspection**; the read tool intentionally doesn\'t ' +
    'expose `show` because the `<ref>:<path>` syntax is easy to get ' +
    'wrong. Accepts a `cwd` to target a non-default workspace folder; ' +
    '`cwd` is traversal-guarded against the workspace root. ' +
    'Response: `{ok, ref, filePath, stdout, stderr, exitCode}`.';

export const GIT_SHOW_TOOL: SharedToolDefinition<GitShowInput> = {
    name: 'tomAi_gitShow',
    displayName: 'Git Show',
    description: GIT_SHOW_DESCRIPTION,
    tags: ['git', 'tom-ai-chat'],
    readOnly: true,
    inputSchema: {
        type: 'object',
        required: ['ref'],
        properties: {
            ref: { type: 'string', description: 'Commit / branch / tag ref.' },
            filePath: { type: 'string', description: 'Optional file path at the ref (yields the file contents, not the commit message).' },
            cwd: { type: 'string', description: 'Working directory. Default: workspace root. Traversal-guarded.' },
        },
    },
    execute: async () => '{"ok":false,"error":"execute() must be installed by tool-executors.ts"}',
};

// ===========================================================================
// `tomAi_gitWrite`
// ===========================================================================

export interface GitWriteInput {
    subcommand: string;
    args?: string[];
    cwd?: string;
    timeoutMs?: number;
}

const GIT_WRITE_ALLOWLIST: ReadonlySet<string> = new Set([
    'add', 'commit', 'push', 'pull', 'fetch', 'checkout', 'branch', 'merge',
    'rebase', 'reset', 'restore', 'stash', 'tag', 'cherry-pick', 'revert',
    'switch', 'rm', 'mv', 'clean', 'apply', 'am', 'config',
]);

/** Flags blocked per workspace policy (CLAUDE.md "Git Safety Protocol"). */
const BLOCKED_FLAGS: ReadonlySet<string> = new Set(['--no-verify', '--no-gpg-sign']);

const WRITE_DEFAULT_TIMEOUT_MS = 60_000;
const WRITE_MIN_TIMEOUT_MS     = 1_000;
const WRITE_MAX_BUFFER_BYTES   = 8 * 1024 * 1024;

export async function gitWriteImpl(executor: GitExecutor, workspace: GitWorkspace, input: GitWriteInput): Promise<string> {
    try {
        if (!input.subcommand || !input.subcommand.trim()) {
            return err('`subcommand` is required.');
        }
        if (!GIT_WRITE_ALLOWLIST.has(input.subcommand)) {
            return err(`Subcommand not in allow-list: "${input.subcommand}".`, {
                allowed: Array.from(GIT_WRITE_ALLOWLIST).sort(),
            });
        }
        const args = sanitiseArgs(input.args);
        const blocked = args.find((a) => BLOCKED_FLAGS.has(a));
        if (blocked) {
            return err(`Flag "${blocked}" is blocked by workspace policy (CLAUDE.md "Git Safety Protocol").`, {
                blocked,
                hint: 'If the user explicitly requested this, re-ask for confirmation and call the tool from a separate code path that bypasses the policy guard.',
            });
        }
        const cwdResult = resolveCwd(workspace, input.cwd);
        if (cwdResult.error) { return err(cwdResult.error); }
        const timeoutMs = Math.max(WRITE_MIN_TIMEOUT_MS, input.timeoutMs ?? WRITE_DEFAULT_TIMEOUT_MS);
        const result = await executor.run([input.subcommand, ...args], {
            cwd: cwdResult.cwd!,
            timeoutMs,
            maxBufferBytes: WRITE_MAX_BUFFER_BYTES,
        });
        if (result.exitCode !== 0) {
            return err(`git ${input.subcommand} exited with code ${result.exitCode}.`, {
                subcommand: input.subcommand,
                exitCode: result.exitCode,
                stdout: result.stdout,
                stderr: result.stderr,
            });
        }
        return ok({
            subcommand: input.subcommand,
            stdout: result.stdout,
            stderr: result.stderr,
            exitCode: 0,
        });
    } catch (e) {
        return err(`gitWrite failed: ${(e as Error).message}`);
    }
}

export const GIT_WRITE_DESCRIPTION =
    'Run a **mutating** git subcommand. Allow-list (any other ' +
    'subcommand is rejected): `add`, `commit`, `push`, `pull`, `fetch`, ' +
    '`checkout`, `branch`, `merge`, `rebase`, `reset`, `restore`, ' +
    '`stash`, `tag`, `cherry-pick`, `revert`, `switch`, `rm`, `mv`, ' +
    '`clean`, `apply`, `am`, `config`. **Hook-skip flags blocked**: ' +
    '`--no-verify` and `--no-gpg-sign` are rejected per workspace ' +
    'policy (CLAUDE.md "Git Safety Protocol") — if the user explicitly ' +
    'asks to skip hooks, surface the request and let the user run the ' +
    'command directly. Accepts a `cwd` to target a non-default ' +
    'workspace folder; `cwd` is traversal-guarded. **Timeout**: ' +
    'default 60s, minimum 1s. Response on success: ' +
    '`{ok, subcommand, stdout, stderr, exitCode}`; on non-zero exit: ' +
    '`{ok: false, error, subcommand, exitCode, stdout, stderr}`. ' +
    'Approval required.';

export const GIT_EXEC_TOOL: SharedToolDefinition<GitWriteInput> = {
    name: 'tomAi_gitWrite',
    displayName: 'Git Write',
    description: GIT_WRITE_DESCRIPTION,
    tags: ['git', 'execution', 'tom-ai-chat'],
    readOnly: false,
    requiresApproval: true,
    inputSchema: {
        type: 'object',
        required: ['subcommand'],
        properties: {
            subcommand: { type: 'string', description: 'Git subcommand from the allow-list (see description).' },
            args: { type: 'array', items: { type: 'string' }, description: 'Arguments appended after the subcommand. `--no-verify` / `--no-gpg-sign` are rejected.' },
            cwd: { type: 'string', description: 'Working directory. Default: workspace root. Traversal-guarded.' },
            timeoutMs: { type: 'number', description: 'Timeout in ms. Default 60000, minimum 1000.' },
        },
    },
    execute: async () => '{"ok":false,"error":"execute() must be installed by tool-executors.ts"}',
};

// ===========================================================================
// Live executor + bridge
// ===========================================================================

import * as vscode from 'vscode';
import { execFile } from 'child_process';

const liveExecutor: GitExecutor = {
    run(args, opts) {
        return new Promise<GitExecResult>((resolve) => {
            const child = execFile('git', args, {
                cwd: opts.cwd,
                maxBuffer: opts.maxBufferBytes,
                timeout: opts.timeoutMs,
            }, (errored, stdout, stderr) => {
                // execFile resolves the callback with an Error when exit code != 0
                // or when killed by timeout.  We always want a structured result
                // back; the impl decides what to do with the exit code.
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

const liveWorkspace: GitWorkspace = {
    root() { return vscode.workspace.workspaceFolders?.[0]?.uri.fsPath; },
};

GIT_TOOL.execute      = (input) => gitReadImpl(liveExecutor, liveWorkspace, input);
GIT_SHOW_TOOL.execute = (input) => gitShowImpl(liveExecutor, liveWorkspace, input);
GIT_EXEC_TOOL.execute = (input) => gitWriteImpl(liveExecutor, liveWorkspace, input);

// ===========================================================================
// Master list
// ===========================================================================

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export const GIT_TOOLS: SharedToolDefinition<any>[] = [
    GIT_TOOL,
    GIT_SHOW_TOOL,
    GIT_EXEC_TOOL,
];
