/**
 * The SECRETS view's IO (src/handlers/prerequisitesView-handler.ts): finding
 * the workspace's `prerequisites.yaml` files, and running the presence checks
 * of src/utils/prerequisites.ts with real effects.
 *
 * - **Discovery:** the projects of the workspace listing
 *   (services/workspaceProjects.ts, buildkit `:projects --all`), each with the
 *   repository it is in (nearest folder holding `.git`); a project's file at its
 *   root, a repository's file at the repository root when that is no project.
 * - **Checks:** every program a check runs gets a timeout and runs one at a
 *   time (one queue per program; different programs run side by side). Output is
 *   discarded unless a check needs it (status lines, key fingerprints), so no
 *   secret value is read into the extension. The login shell is asked once per
 *   run (an interactive login shell, as a terminal starts it), for every
 *   variable and command at once, presence only.
 *
 * vscode-free; the handler passes VS Code's SecretStorage in.
 */

import * as childProcess from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import {
    PREREQUISITES_FILE, checkOption, checkProgram, checkTool, onPath, optionKey, parsePrerequisites, toolKey,
    type CheckResult, type CheckStatus, type PrerequisiteCheckDeps, type RunResult,
} from '../utils/prerequisites';
import type { DiscoveredFile, DiscoveredProject } from '../utils/prerequisitesTree';

export const CHECK_TIMEOUT_MS = 10_000;
const SHELL_TIMEOUT_MS = 15_000;

/** The nearest folder at or above `dir` holding `.git` (a folder or a file), else `fallback`. */
export function repositoryOf(dir: string, fallback: string, exists: (p: string) => boolean = fs.existsSync): string {
    let d = dir;
    for (;;) {
        if (exists(path.join(d, '.git'))) { return d; }
        const up = path.dirname(d);
        if (up === d) { return fallback; }
        d = up;
    }
}

/** The files and the projects without one, from the project list. */
export function discoverPrerequisites(
    workspaceRoot: string,
    projects: ReadonlyArray<{ name: string; absolutePath: string }>,
    io: { exists: (p: string) => boolean; read: (p: string) => string | null } = {
        exists: fs.existsSync,
        read: (p) => { try { return fs.readFileSync(p, 'utf8'); } catch { return null; } },
    },
): { files: DiscoveredFile[]; without: DiscoveredProject[] } {
    const files: DiscoveredFile[] = [];
    const without: DiscoveredProject[] = [];
    const projectDirs = new Set(projects.map((p) => path.resolve(p.absolutePath)));
    const repoDirs = new Set<string>();
    const load = (file: string): DiscoveredFile['parsed'] => {
        const text = io.read(file);
        return text === null ? { ok: false, error: 'cannot be read', problems: [] } : parsePrerequisites(text);
    };
    for (const p of projects) {
        const dir = path.resolve(p.absolutePath);
        const repoDir = repositoryOf(dir, workspaceRoot, io.exists);
        repoDirs.add(repoDir);
        const file = path.join(dir, PREREQUISITES_FILE);
        if (io.exists(file)) {
            files.push({ file, kind: 'project', name: p.name, dir, repoDir, parsed: load(file) });
        } else {
            without.push({ name: p.name, dir, repoDir });
        }
    }
    for (const repoDir of repoDirs) {
        if (projectDirs.has(repoDir)) { continue; }
        const file = path.join(repoDir, PREREQUISITES_FILE);
        if (io.exists(file)) {
            files.push({ file, kind: 'repository', name: `${path.basename(repoDir)} (repository)`, dir: repoDir, repoDir, parsed: load(file) });
        }
    }
    return { files, without };
}

/** One check to run: a secret's option or a tool. */
export interface PendingCheck {
    key: string;
    /** The queue it waits in (a program name); null: no program, runs at once. */
    program: string | null;
    run: (deps: PrerequisiteCheckDeps) => Promise<CheckResult>;
}

/** Every check of the files, with its key and program. */
export function pendingChecks(files: readonly DiscoveredFile[], platform: NodeJS.Platform, hostPath: string | undefined): PendingCheck[] {
    const out: PendingCheck[] = [];
    for (const f of files) {
        if (!f.parsed.ok) { continue; }
        const baseDir = path.dirname(f.file);
        for (const s of f.parsed.file.sections) {
            for (const secret of s.secrets) {
                secret.options.forEach((o, i) => {
                    out.push({ key: optionKey(f.file, s.id, secret.id, i, o.via), program: checkProgram(o, platform), run: (deps) => checkOption(o, baseDir, deps) });
                });
            }
            for (const t of s.tools) {
                out.push({
                    key: toolKey(f.file, s.id, t.id), program: t.check ? 'shell' : null,
                    run: (deps) => checkTool(t, baseDir, deps, (c) => onPath(c, hostPath, deps.platform, deps.stat)),
                });
            }
        }
    }
    return out;
}

/** The variable and command names a login-shell probe may ask about (no shell syntax). */
const SAFE_ENV = /^[A-Za-z_][A-Za-z0-9_]*$/;
const SAFE_CMD = /^[A-Za-z0-9._+-]+$/;

/** The probe script: one line per variable set (`env:NAME`) and command found (`cmd:NAME`); never a value. */
export function shellProbeScript(envNames: readonly string[], commands: readonly string[]): string {
    const e = envNames.filter((n) => SAFE_ENV.test(n));
    const c = commands.filter((n) => SAFE_CMD.test(n));
    return [
        ...e.map((n) => `[ -n "\${${n}:-}" ] && echo "env:${n}"`),
        ...c.map((n) => `command -v ${n} >/dev/null 2>&1 && echo "cmd:${n}"`),
        'true',
    ].join('; ');
}

/** Ask the login shell once; null when there is none or it failed (every answer then `unknown`). */
export async function probeLoginShell(envNames: readonly string[], commands: readonly string[], platform: NodeJS.Platform = process.platform, env: NodeJS.ProcessEnv = process.env): Promise<{ env: Set<string>; cmd: Set<string> } | null> {
    if (platform === 'win32' || (envNames.length === 0 && commands.length === 0)) { return null; }
    const shell = env.SHELL || '/bin/sh';
    // Interactive login shell, as a terminal window starts it (and as VS Code resolves the shell environment):
    // ~/.zshrc / ~/.bashrc are read too. stdin is closed; only the probe's own prefixed lines are read.
    const r = await execRun(shell, ['-ilc', shellProbeScript(envNames, commands)], { captureStdout: true, timeoutMs: SHELL_TIMEOUT_MS });
    if (r.exitCode === null) { return null; }
    const lines = (r.stdout ?? '').split('\n').map((l) => l.trim());
    return {
        env: new Set(lines.filter((l) => l.startsWith('env:')).map((l) => l.slice(4))),
        cmd: new Set(lines.filter((l) => l.startsWith('cmd:')).map((l) => l.slice(4))),
    };
}

/** Run a program: stdin closed, stdout kept only when asked for, stderr dropped, killed after the timeout. */
export function execRun(command: string, args: string[], opts: { captureStdout?: boolean; cwd?: string; timeoutMs?: number; shell?: boolean } = {}): Promise<RunResult> {
    return new Promise((resolve) => {
        let child: childProcess.ChildProcess;
        try {
            child = childProcess.spawn(command, args, {
                cwd: opts.cwd, shell: opts.shell ?? false, windowsHide: true,
                stdio: ['ignore', opts.captureStdout ? 'pipe' : 'ignore', 'ignore'],
            });
        } catch {
            resolve({ exitCode: null });
            return;
        }
        let out = '';
        let timedOut = false;
        child.stdout?.on('data', (d: Buffer) => { if (out.length < 64_000) { out += d.toString('utf8'); } });
        const timer = setTimeout(() => { timedOut = true; child.kill('SIGKILL'); }, opts.timeoutMs ?? CHECK_TIMEOUT_MS);
        child.on('error', () => { clearTimeout(timer); resolve({ exitCode: null }); });
        child.on('close', (code) => {
            clearTimeout(timer);
            resolve({ exitCode: timedOut ? null : code, ...(timedOut ? { timedOut } : {}), ...(opts.captureStdout ? { stdout: out } : {}) });
        });
    });
}

/** The real effects, with the login shell's answer computed beforehand. */
export function liveCheckDeps(shell: { env: Set<string>; cmd: Set<string> } | null, vscodeSecretHas: (key: string) => Promise<boolean>): PrerequisiteCheckDeps {
    return {
        platform: process.platform,
        homedir: os.homedir(),
        env: process.env,
        shellHasEnv: async (name): Promise<CheckStatus> => (shell ? (shell.env.has(name) ? 'set' : 'missing') : 'unknown'),
        shellHasCommand: async (cmd): Promise<CheckStatus> => (shell ? (shell.cmd.has(cmd) ? 'set' : 'missing') : 'unknown'),
        stat: (file) => {
            try {
                const st = fs.statSync(file);
                if (st.isFile()) { fs.accessSync(file, fs.constants.R_OK); }
                return { size: st.size, mode: st.mode, isFile: st.isFile() };
            } catch {
                return null;
            }
        },
        readText: (file) => { try { return fs.readFileSync(file, 'utf8'); } catch { return null; } },
        run: (command, args, opts) => execRun(command, args, opts),
        runShell: (line, cwd) => execRun(line, [], { cwd, shell: true }),
        vscodeSecretHas,
        now: () => new Date(),
    };
}

/** The env names and commands the login shell is asked about. */
export function shellQuestions(files: readonly DiscoveredFile[]): { env: string[]; cmd: string[] } {
    const env = new Set<string>();
    const cmd = new Set<string>();
    for (const f of files) {
        if (!f.parsed.ok) { continue; }
        for (const s of f.parsed.file.sections) {
            for (const secret of s.secrets) { for (const o of secret.options) { if (o.via === 'env' && !o.check && o.name) { env.add(o.name); } } }
            for (const t of s.tools) { if (!t.check) { cmd.add(t.command); } }
        }
    }
    return { env: [...env], cmd: [...cmd] };
}

/**
 * Run every check: one queue per program (the checks of one program one after
 * another), the queues side by side. `onResult` is told each result.
 */
export async function runChecks(
    checks: readonly PendingCheck[],
    deps: PrerequisiteCheckDeps,
    onResult: (key: string, result: CheckResult, done: number) => void = () => undefined,
): Promise<Record<string, CheckResult>> {
    const results: Record<string, CheckResult> = {};
    let done = 0;
    const queues = new Map<string, PendingCheck[]>();
    for (const c of checks) {
        const q = c.program ?? `__none:${c.key}`;
        const list = queues.get(q) ?? [];
        list.push(c);
        queues.set(q, list);
    }
    await Promise.all([...queues.values()].map(async (list) => {
        for (const c of list) {
            let r: CheckResult;
            try {
                r = await c.run(deps);
            } catch (e) {
                r = { status: 'unknown', detail: `check failed: ${(e as Error).message}`, checkedAt: deps.now().toISOString() };
            }
            results[c.key] = r;
            onResult(c.key, r, ++done);
        }
    }));
    return results;
}
