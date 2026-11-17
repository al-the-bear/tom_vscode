/**
 * Registering the extension's `_ai` merge drivers in git, and checking them
 * (vscimpb142c). Git merges an `_ai` file with a driver when the `_ai`
 * repository's `.gitattributes` binds it (`merge=ai-trail`, …) and git's
 * config names the driver's command (`merge.<driver>.driver`, in the
 * repository's config or the global one). The extension's command is
 *
 *   <node> "<extension>/out/utils/aiMergeDriverCli.js" <driver> %O %A %B %L %P
 *
 * with VS Code's own Node (`ELECTRON_RUN_AS_NODE=1 "<VS Code helper>"`) in the
 * extension host, or the Node running the script elsewhere.
 *
 * A driver's state: `missing` (git has no command), `current` (this
 * extension's command), `outdated` (an extension's command, but another
 * folder or Node — e.g. after VS Code or the extension moved), `other`
 * (another tool's, e.g. the al_the_bear skills' Python drivers).
 *
 * vscode-free; git runs through an injectable runner.
 */

import { execFileSync } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';

import { AI_MERGE_DRIVER_NAMES, AI_MERGE_DRIVER_TITLES, type AiMergeDriverName } from './aiMergeDrivers';

/** Runs git with `args` in `cwd`; answers stdout, throws on a non-zero exit. */
export type GitRunner = (args: string[], cwd: string) => string;

export const defaultGitRunner: GitRunner = (args, cwd) => execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });

/** The CLI git runs (beside this module in `out/utils/`). */
export function defaultAiMergeDriverCli(): string {
    return path.join(__dirname, 'aiMergeDriverCli.js');
}

const CLI_NAME = 'aiMergeDriverCli.js';

const slash = (p: string): string => p.replace(/\\/g, '/');

/** The Node git starts the CLI with: VS Code's own in the extension host, else this process's. */
export function nodeCommandForGit(execPath = process.execPath, electron = !!process.versions.electron): string {
    return electron ? `ELECTRON_RUN_AS_NODE=1 "${slash(execPath)}"` : `"${slash(execPath)}"`;
}

/** The command line registered for `driver`. */
export function driverCommandLine(driver: AiMergeDriverName, cli = defaultAiMergeDriverCli(), node = nodeCommandForGit()): string {
    return `${node} "${slash(cli)}" ${driver} %O %A %B %L %P`;
}

export type DriverState = 'missing' | 'current' | 'outdated' | 'other';

export interface DriverStatus {
    driver: AiMergeDriverName;
    state: DriverState;
    /** The command git has, when it has one. */
    command?: string;
    /** Where it is set: `local` (the repository), `global`, `system`, … (empty when git cannot tell). */
    scope?: string;
}

export interface AiMergeDriverReport {
    /** The `_ai` folder checked. */
    aiRoot: string;
    /** The repository's top folder; undefined when `_ai` is in no git repository. */
    repoRoot?: string;
    drivers: DriverStatus[];
    /** The drivers no `merge=<driver>` line names (`<_ai>/.gitattributes`, and the repository's when `_ai` is a folder in it). */
    unboundDrivers: AiMergeDriverName[];
    /** Every driver is this extension's and bound. */
    ok: boolean;
}

/** The state of a registered command against the expected one. */
export function classifyDriverCommand(command: string | undefined, expected: string): DriverState {
    if (!command) { return 'missing'; }
    if (command.trim() === expected) { return 'current'; }
    return command.includes(CLI_NAME) ? 'outdated' : 'other';
}

function gitTry(git: GitRunner, args: string[], cwd: string): string | undefined {
    try { return git(args, cwd).trim(); } catch { return undefined; }
}

/** The repository's top folder of `dir`, or undefined. */
export function repoRootOf(dir: string, git: GitRunner = defaultGitRunner): string | undefined {
    return gitTry(git, ['rev-parse', '--show-toplevel'], dir) || undefined;
}

/** The drivers a `.gitattributes` text binds (`merge=<driver>` on a rule line). */
export function boundDrivers(gitattributes: string): Set<string> {
    const out = new Set<string>();
    for (const line of gitattributes.split(/\r?\n/)) {
        const t = line.trim();
        if (!t || t.startsWith('#')) { continue; }
        for (const m of t.matchAll(/\bmerge=([A-Za-z0-9_-]+)/g)) { out.add(m[1]); }
    }
    return out;
}

/** Check the drivers for the `_ai` folder `aiRoot`. */
export function checkAiMergeDrivers(aiRoot: string, opts: { git?: GitRunner; cli?: string; node?: string } = {}): AiMergeDriverReport {
    const git = opts.git ?? defaultGitRunner;
    const repoRoot = fs.existsSync(aiRoot) ? repoRootOf(aiRoot, git) : undefined;
    const cwd = repoRoot ?? (fs.existsSync(aiRoot) ? aiRoot : path.dirname(aiRoot));
    const drivers = AI_MERGE_DRIVER_NAMES.map((driver): DriverStatus => {
        const scoped = gitTry(git, ['config', '--show-scope', '--get', `merge.${driver}.driver`], cwd);
        let scope: string | undefined;
        let command: string | undefined;
        if (scoped) {
            const tab = scoped.indexOf('\t');
            scope = tab >= 0 ? scoped.slice(0, tab) : undefined;
            command = tab >= 0 ? scoped.slice(tab + 1) : scoped;
        } else {
            command = gitTry(git, ['config', '--get', `merge.${driver}.driver`], cwd) || undefined;
        }
        const state = classifyDriverCommand(command, driverCommandLine(driver, opts.cli, opts.node));
        return { driver, state, ...(command ? { command } : {}), ...(scope ? { scope } : {}) };
    });
    const bound = boundDrivers(gitattributesTexts(aiRoot, repoRoot));
    const unboundDrivers = AI_MERGE_DRIVER_NAMES.filter((d) => !bound.has(d));
    return { aiRoot, repoRoot, drivers, unboundDrivers, ok: drivers.every((d) => d.state === 'current') && !unboundDrivers.length };
}

/**
 * Register the extension's drivers: in the repository's config (`local`, the `_ai` repository only) or the
 * global one. `only` limits it to some drivers. Answers the drivers written.
 */
export function installAiMergeDrivers(aiRoot: string, scope: 'local' | 'global', opts: { git?: GitRunner; cli?: string; node?: string; only?: AiMergeDriverName[] } = {}): AiMergeDriverName[] {
    const git = opts.git ?? defaultGitRunner;
    const repoRoot = repoRootOf(aiRoot, git);
    if (scope === 'local' && !repoRoot) { throw new Error(`${aiRoot} is in no git repository: register the drivers globally, or make it a repository first.`); }
    const cwd = repoRoot ?? aiRoot;
    const where = scope === 'global' ? ['--global'] : ['--local'];
    const drivers = opts.only ?? AI_MERGE_DRIVER_NAMES;
    for (const d of drivers) {
        git(['config', ...where, `merge.${d}.name`, AI_MERGE_DRIVER_TITLES[d]], cwd);
        git(['config', ...where, `merge.${d}.driver`, driverCommandLine(d, opts.cli, opts.node)], cwd);
    }
    return drivers;
}

/** The `.gitattributes` rules of the `_ai` repository for the five drivers (paths relative to `_ai`). */
export const AI_GITATTRIBUTES_RULES: ReadonlyArray<{ pattern: string; driver: AiMergeDriverName }> = [
    { pattern: 'quests/*/history/compacted_history.md', driver: 'ai-block-history' },
    { pattern: 'quests/*/history/sessions/*/compacted_history.md', driver: 'ai-block-history' },
    { pattern: 'quests/*/live-trail.md', driver: 'ai-trail' },
    { pattern: 'quests/*/history/sessions/*/live-trail.md', driver: 'ai-trail' },
    { pattern: 'quests/*/todos*.todo.yaml', driver: 'ai-yaml-smart' },
    { pattern: 'memory/**/*.yaml', driver: 'ai-yaml-smart' },
    { pattern: 'quests/*/extension_config*.yaml', driver: 'ai-yaml-smart' },
    { pattern: 'quests/*/history/history.json', driver: 'ai-history-json' },
    { pattern: 'quests/*/history/sessions/*/history.json', driver: 'ai-history-json' },
    { pattern: 'quests/*/history/history.md', driver: 'ai-history-md' },
    { pattern: 'quests/*/history/sessions/*/history.md', driver: 'ai-history-md' },
];

/** The `.gitattributes` texts that apply to `_ai`: its own, and the repository's when that is above it. */
function gitattributesTexts(aiRoot: string, repoRoot: string | undefined): string {
    const files = [path.join(aiRoot, '.gitattributes')];
    if (repoRoot && path.resolve(repoRoot) !== path.resolve(aiRoot)) {
        try { if (fs.realpathSync(repoRoot) !== fs.realpathSync(aiRoot)) { files.push(path.join(repoRoot, '.gitattributes')); } } catch { /* gone */ }
    }
    return files.map((f) => { try { return fs.readFileSync(f, 'utf8'); } catch { return ''; } }).join('\n');
}

/**
 * Bind the drivers no `.gitattributes` binds yet: append their rules to `<_ai>/.gitattributes` (created when
 * missing; a `.gitattributes` in a folder applies to the paths below it, so this holds whether `_ai` is the
 * repository or a folder in it, and before it is a repository at all). Answers the lines added.
 */
export function bindAiMergeDrivers(aiRoot: string, repoRoot?: string): string[] {
    const file = path.join(aiRoot, '.gitattributes');
    let text = '';
    try { text = fs.readFileSync(file, 'utf8'); } catch { /* new file */ }
    const bound = boundDrivers(gitattributesTexts(aiRoot, repoRoot));
    const lines = AI_GITATTRIBUTES_RULES.filter((r) => !bound.has(r.driver)).map((r) => `${r.pattern}  merge=${r.driver}`);
    if (!lines.length) { return []; }
    const head = text ? (text.endsWith('\n') ? `${text}\n` : `${text}\n\n`) : '';
    const block = ['# The _ai merge drivers (Tom AI; registered from @T: Migrate _ai Formats or Setup New Workspace Folder).', ...lines].join('\n');
    fs.writeFileSync(file, `${head}${block}\n`, 'utf8');
    return lines;
}

/**
 * Register the extension's drivers for `aiRoot` and bind them: `local` (the `_ai` repository only; needs one)
 * or `global`. Answers the drivers registered and the `.gitattributes` lines added.
 */
export function setUpAiMergeDrivers(aiRoot: string, scope: 'local' | 'global', opts: { git?: GitRunner; cli?: string; node?: string } = {}): { drivers: AiMergeDriverName[]; bound: string[] } {
    const drivers = installAiMergeDrivers(aiRoot, scope, opts);
    const bound = bindAiMergeDrivers(aiRoot, repoRootOf(aiRoot, opts.git ?? defaultGitRunner));
    return { drivers, bound };
}

/** One line per driver for a report or a page. */
export function aiMergeDriverSummary(report: AiMergeDriverReport): string[] {
    const word: Record<DriverState, string> = { missing: 'not registered', current: "this extension's", outdated: "an older extension's (to update)", other: "another tool's" };
    const lines = report.drivers.map((d) => `${d.driver}: ${word[d.state]}${d.scope ? ` (${d.scope})` : ''}`);
    if (!report.repoRoot) { lines.push('The _ai folder is in no git repository yet: git merges nothing there until it is one.'); }
    if (report.unboundDrivers.length) {
        lines.push(`.gitattributes binds no file to: ${report.unboundDrivers.join(', ')}.`);
    }
    return lines;
}

/**
 * The update a start-up check offers (the extension moved, VS Code's Node moved): the drivers pointing to an
 * older install, re-registered where they are set (`global` when set globally, else the repository).
 * Undefined when none is outdated.
 */
export function outdatedDriverUpdate(report: AiMergeDriverReport): { scope: 'local' | 'global'; drivers: AiMergeDriverName[] } | undefined {
    const outdated = report.drivers.filter((d) => d.state === 'outdated');
    if (!outdated.length) { return undefined; }
    const scope = outdated.some((d) => d.scope === 'global') || !report.repoRoot ? 'global' : 'local';
    return { scope, drivers: outdated.map((d) => d.driver) };
}
