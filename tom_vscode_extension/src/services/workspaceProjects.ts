/**
 * The workspace's projects, as buildkit sees them: `buildkit :projects --all --json`
 * (tom_build_base's `listProjects`), run in the workspace root. `--all`: every
 * project of the tree, past the `navigation:` excludes of `buildkit_master.yaml`
 * that keep whole subtrees (e.g. `ai_build/**`) from the build commands.
 *
 * One discovery implementation for the build tools and the extension: the
 * same traversal, the same `buildkit_master.yaml` navigation defaults, the
 * identity from each project's `buildkit.yaml` and the natures the build
 * commands select by. There is no generated workspace manifest to read.
 *
 * buildkit is a tom binary, not bundled with the extension (yet: vscimpb83).
 * It is looked for in every place in turn, the first that has the file wins
 * (qrfix14):
 *   1. configured: `bridge.executables.buildkit` names a file;
 *   2. the configured binaries folder `bridge.binaryPath` — unless it names an
 *      environment variable this process does not have (`${env:TOM_BINARY_PATH}`
 *      in a VS Code started from the Dock), which is noted and passed;
 *   3. the workspace's binaries layer `<workspace>/tom_binaries/tom/<platform>/`;
 *   4. `$TOM_BINARY_PATH/<platform>/` (`~/.tom/bin` is never looked at);
 *   5. `buildkit` on PATH.
 *
 * Without a buildkit, or when it cannot list (exits non-zero, e.g. a build
 * older than tom_build_kit 1.18.0 without `:projects`, or answers no
 * document), the listing comes from the extension's JavaScript port of the
 * same rules (services/projectListingJs.ts), `source: 'javascript'`, with a
 * `fallback` diagnostic: what happened, where it looked and how to fix it.
 * The diagnostic goes to the registered notifier once per reason and window
 * (setProjectListingNotifier).
 *
 * Listings are cached per root for {@link CACHE_MS}; `fresh` skips the cache.
 *
 * vscode-free.
 */

import * as fs from 'fs';
import * as path from 'path';
import { listProjectsJs } from './projectListingJs';
import {
    buildConfigContext,
    expandHomePath,
    getCurrentPlatform,
    resolveNamedExecutable,
} from '../utils/executableResolver';
import { currentDartBinariesConfig, runBinaryFile, type DartBinariesConfig } from './dartBinariesStatus';

/** One project of the listing (`ListedProject.toJson()` in tom_build_base). */
export interface WorkspaceProject {
    /** `project_id` from the project's `buildkit.yaml`, else its name. */
    id: string;
    /** `name` from `buildkit.yaml`, else the project file's name, else the folder name. */
    name: string;
    /** Relative to the workspace root, `/` separators. */
    path: string;
    absolutePath: string;
    /** `dart`, `typescript`, `javascript`, `python`, `java`, `go`, `rust`, `c`, `cpp`. */
    language: string;
    /** The primary nature, e.g. `flutter`, `dart_package`, `python`. */
    type: string;
    /** Every nature, e.g. `["dart_package", "git", "buildkit"]`. */
    natures: string[];
    version?: string;
    description?: string;
}

/** Why the listing did not come from buildkit, and how to fix it (qrfix14). */
export interface ListingFallback {
    /** `notFound`: no buildkit anywhere; `failed`: buildkit ran but did not list. */
    kind: 'notFound' | 'failed';
    /** One sentence: what happened. */
    reason: string;
    /** The places looked at, with notes (an unset variable). */
    searched: string[];
    /** The buildkit that ran, when one did. */
    binary?: string;
    /** What it answered (exit code and output, cut). */
    buildkitError?: string;
    /** How to fix it. */
    hint: string;
}

export type ProjectListing =
    | { ok: true; source: 'buildkit'; binary: string; root: string; projects: WorkspaceProject[] }
    | { ok: true; source: 'javascript'; root: string; projects: WorkspaceProject[]; fallback: ListingFallback }
    | { ok: false; error: string; binary?: string; searched?: string[] };

/** How the listing is described in tool answers. */
export const PROJECTS_SOURCE = 'buildkit :projects --all --json';

/** How the fallback listing is described in tool answers. */
export const PROJECTS_SOURCE_JS = 'the extension\'s JavaScript port of buildkit :projects --all (buildkit not available)';

/** What a listing is described as: buildkit with its binary, or the JavaScript port. */
export function projectsSourceOf(listing: ProjectListing): string | null {
    if (!listing.ok) { return null; }
    return listing.source === 'buildkit' ? `${PROJECTS_SOURCE} (${listing.binary})` : PROJECTS_SOURCE_JS;
}

/** The `formatVersion` this reader understands. */
export const PROJECTS_FORMAT_VERSION = 1;

/** How long a listing is reused. */
export const CACHE_MS = 30_000;

const TIMEOUT_MS = 120_000;

function isFile(p: string): boolean {
    try { return fs.statSync(p).isFile(); } catch { return false; }
}

function exeName(name: string, platform: string): string {
    return platform.startsWith('win32') ? `${name}.exe` : name;
}

/** The `${env:NAME}` variables `value` names that `env` does not have (or has empty). */
export function unsetEnvVariables(value: string, env: NodeJS.ProcessEnv): string[] {
    const names: string[] = [];
    for (const m of value.matchAll(/\$\{env:([^}]+)\}/g)) {
        if (!env[m[1]]) { names.push(m[1]); }
    }
    return names;
}

/** `${env:NAME}` expanded from `env` (left as it is when unset). */
function expandEnv(value: string, env: NodeJS.ProcessEnv): string {
    return value.replace(/\$\{env:([^}]+)\}/g, (whole, name: string) => env[name] || whole);
}

/** The configured value for `platform` of a per-platform map (exact, then os prefix, then `*`). */
function forPlatform(config: unknown, platform: string): string | undefined {
    if (typeof config === 'string') { return config; }
    if (!config || typeof config !== 'object') { return undefined; }
    const map = config as Record<string, unknown>;
    const os = platform.split('-')[0];
    const pick = map[platform] ?? Object.entries(map).find(([k]) => k === os || k.startsWith(`${os}-`))?.[1] ?? map['*'];
    return typeof pick === 'string' ? pick : undefined;
}

/**
 * Where buildkit is, for [workspaceRoot] and the `bridge` configuration
 * [config]: the file to run (the first place that has it), and every place
 * looked at, with notes.
 */
export function resolveBuildkitBinary(
    workspaceRoot: string,
    config: DartBinariesConfig = {},
    env: NodeJS.ProcessEnv = process.env,
    platform: string = getCurrentPlatform(),
): { binary?: string; searched: string[] } {
    const searched: string[] = [];
    const name = exeName('buildkit', platform);
    const tryFile = (file: string, note?: string): string | undefined => {
        searched.push(note ? `${file} (${note})` : file);
        return isFile(file) ? file : undefined;
    };

    // 1. bridge.executables.buildkit
    if (config.executables?.buildkit) {
        const ctx = buildConfigContext(config.binaryPath, workspaceRoot);
        const resolved = resolveNamedExecutable('buildkit', config.executables, ctx);
        if (resolved && path.dirname(resolved) !== '.') {
            const unset = unsetEnvVariables(resolved, env);
            if (unset.length) {
                searched.push(`${resolved} (bridge.executables.buildkit: ${unset.map((n) => `\${env:${n}}`).join(', ')} not set in this process)`);
            } else {
                const hit = tryFile(expandHomePath(expandEnv(resolved, env)), 'bridge.executables.buildkit');
                if (hit) { return { binary: hit, searched }; }
            }
        }
    }

    // 2. bridge.binaryPath, when its variables are set
    const configured = forPlatform(config.binaryPath, platform);
    if (configured) {
        const unset = unsetEnvVariables(configured, env);
        if (unset.length) {
            searched.push(`${path.join(configured, name)} (bridge.binaryPath: ${unset.map((n) => `\${env:${n}}`).join(', ')} not set in this process)`);
        } else {
            const hit = tryFile(path.join(expandHomePath(expandEnv(configured, env)), name), 'bridge.binaryPath');
            if (hit) { return { binary: hit, searched }; }
        }
    }

    // 3. the workspace's binaries layer
    const inLayer = tryFile(path.join(workspaceRoot, 'tom_binaries', 'tom', platform, name), 'the workspace\'s binaries layer');
    if (inLayer) { return { binary: inLayer, searched }; }

    // 4. $TOM_BINARY_PATH/<platform>/ - the binaries layer as the shell names it. ~/.tom/bin is not looked at:
    // binaries are not installed there, and an old copy left there must not run (build_tom build_cleanup1002).
    if (env.TOM_BINARY_PATH) {
        const hit = tryFile(path.join(expandHomePath(env.TOM_BINARY_PATH), platform, name), '$TOM_BINARY_PATH/<platform>');
        if (hit) { return { binary: hit, searched }; }
    } else {
        searched.push(`${path.join('$TOM_BINARY_PATH', platform, name)} (TOM_BINARY_PATH not set in this process)`);
    }

    // 5. PATH
    for (const dir of (env.PATH ?? env.Path ?? '').split(path.delimiter)) {
        if (!dir) { continue; }
        const candidate = path.join(dir, name);
        if (isFile(candidate)) { return { binary: candidate, searched: [...searched, `${candidate} (PATH)`] }; }
    }
    searched.push(`${name} on PATH`);
    return { searched };
}

/** How to fix a listing that did not come from buildkit. */
export function fallbackHint(kind: ListingFallback['kind'], searched: readonly string[], binary?: string): string {
    if (kind === 'failed') {
        return `The buildkit at ${binary} could not list the projects; \`:projects --all --json\` needs tom_build_kit 1.18.0 or later. `
            + 'Update the tom binaries (rebuild buildkit, or pull the binaries layer), or point `bridge.executables.buildkit` '
            + 'in .tom/tom_vscode_extension.json at a newer one.';
    }
    const unset = [...new Set(searched.flatMap((s) => [...s.matchAll(/\$\{env:([^}]+)\} not set/g)].map((m) => m[1])))];
    const envHint = unset.length
        ? `The configuration names ${unset.map((n) => `\${env:${n}}`).join(', ')}, which VS Code's environment does not have `
            + '(VS Code started from the Dock or Finder does not read your shell profile): set it for GUI apps '
            + `(macOS: \`launchctl setenv ${unset[0]} <path>\`, then restart VS Code) or start VS Code from a shell. `
        : '';
    return `${envHint}Or pull the tom binaries into the workspace's binaries layer (tom_binaries/tom/<platform>/, also `
        + 'found through TOM_BINARY_PATH), or set `bridge.executables.buildkit` in .tom/tom_vscode_extension.json to the file. '
        + 'Until then the extension lists the projects with its own JavaScript port of the same rules.';
}

/** The notification's one line for a fallback listing. */
export function projectListingNoticeLine(fallback: ListingFallback): string {
    return fallback.kind === 'notFound'
        ? 'Tom AI: buildkit was not found — the project list comes from the extension\'s JavaScript port for now.'
        : 'Tom AI: buildkit could not list the projects — the project list comes from the extension\'s JavaScript port for now.';
}

/** The details the notification opens: what happened, where it looked, how to fix it. */
export function projectListingNoticeMarkdown(fallback: ListingFallback, workspaceRoot: string): string {
    return [
        '# Project list: buildkit not available',
        '',
        fallback.reason,
        '',
        'The projects are listed by the extension\'s JavaScript port of `buildkit :projects --all --json` '
            + '(the same walk, natures, identities and build order), so `tomAi_listProjects`, `tomAi_getWorkspaceInfo` '
            + 'and the project pickers keep working.',
        '',
        '## Where buildkit was looked for',
        '',
        ...fallback.searched.map((s) => `- \`${s}\``),
        ...(fallback.buildkitError ? ['', '## What buildkit answered', '', '```text', fallback.buildkitError, '```'] : []),
        '',
        '## How to fix it',
        '',
        fallback.hint,
        '',
        `Workspace: \`${workspaceRoot}\``,
        '',
    ].join('\n');
}

/** Told once per reason and window when a listing falls back (the extension shows a notification). */
let notifier: ((fallback: ListingFallback) => void) | undefined;
const notified = new Set<string>();

/** Register what is told about a fallback listing; undefined unregisters. */
export function setProjectListingNotifier(fn: ((fallback: ListingFallback) => void) | undefined): void {
    notifier = fn;
}

/** Forget which fallbacks were told (tests). */
export function resetProjectListingNotices(): void {
    notified.clear();
}

function notifyFallback(fallback: ListingFallback): void {
    const key = `${fallback.kind}:${fallback.binary ?? ''}:${fallback.searched.join('|')}`;
    if (notified.has(key)) { return; }
    notified.add(key);
    try { notifier?.(fallback); } catch { /* a notifier must not break the listing */ }
}

/** The projects of a `buildkit :projects --json` document; throws on anything else. */
export function parseProjectsJson(stdout: string): { root: string; projects: WorkspaceProject[] } {
    const start = stdout.indexOf('{');
    if (start < 0) { throw new Error('no JSON document in the output'); }
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const doc = JSON.parse(stdout.slice(start)) as any;
    if (doc?.formatVersion !== PROJECTS_FORMAT_VERSION) {
        throw new Error(`formatVersion ${doc?.formatVersion} is not ${PROJECTS_FORMAT_VERSION}: buildkit and the extension disagree on the listing`);
    }
    if (!Array.isArray(doc.projects)) { throw new Error('the document has no projects array'); }
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const projects: WorkspaceProject[] = doc.projects.map((p: any) => ({
        id: String(p.id),
        name: String(p.name),
        path: String(p.path),
        absolutePath: String(p.absolutePath),
        language: String(p.language),
        type: String(p.type),
        natures: Array.isArray(p.natures) ? p.natures.map(String) : [],
        ...(p.version !== undefined ? { version: String(p.version) } : {}),
        ...(p.description !== undefined ? { description: String(p.description) } : {}),
    }));
    return { root: String(doc.root ?? ''), projects };
}

/** Runs buildkit; a seam for tests. */
export type BuildkitRunner = (binary: string, args: string[], cwd: string) => Promise<{ exitCode: number; stdout: string; stderr: string }>;

const defaultRunner: BuildkitRunner = (binary, args, cwd) =>
    runBinaryFile(binary, args, 'buildkit :projects', { cwd, timeoutMs: TIMEOUT_MS });

const cache = new Map<string, { at: number; listing: Promise<ProjectListing> }>();

/** Forget every cached listing. */
export function clearProjectListingCache(): void {
    cache.clear();
}

/**
 * The projects of the workspace at [workspaceRoot], from
 * `buildkit :projects --all --json` run there.
 */
export function listWorkspaceProjects(
    workspaceRoot: string,
    options: {
        fresh?: boolean;
        config?: DartBinariesConfig;
        runner?: BuildkitRunner;
        now?: () => number;
        env?: NodeJS.ProcessEnv;
        jsLister?: JsLister;
    } = {},
): Promise<ProjectListing> {
    const now = (options.now ?? Date.now)();
    const cached = cache.get(workspaceRoot);
    if (!options.fresh && cached && now - cached.at < CACHE_MS) { return cached.listing; }
    const listing = runListing(workspaceRoot, options);
    cache.set(workspaceRoot, { at: now, listing });
    // A failed listing is not kept: the next call tries again.
    void listing.then((l) => { if (!l.ok) { cache.delete(workspaceRoot); } });
    return listing;
}

async function runListing(
    workspaceRoot: string,
    options: { config?: DartBinariesConfig; runner?: BuildkitRunner; env?: NodeJS.ProcessEnv; jsLister?: JsLister },
): Promise<ProjectListing> {
    const config = options.config ?? currentDartBinariesConfig();
    const { binary, searched } = resolveBuildkitBinary(workspaceRoot, config, options.env);
    if (!binary) {
        return fallBack(workspaceRoot, options.jsLister, {
            kind: 'notFound',
            reason: 'buildkit was not found, so the project list does not come from `buildkit :projects --all --json`.',
            searched,
            hint: fallbackHint('notFound', searched),
        });
    }
    let buildkitError: string;
    try {
        const run = await (options.runner ?? defaultRunner)(binary, ['-R', workspaceRoot, ':projects', '--all', '--json'], workspaceRoot);
        if (run.exitCode === 0) {
            const parsed = parseProjectsJson(run.stdout);
            return { ok: true, source: 'buildkit', binary, root: parsed.root || workspaceRoot, projects: parsed.projects };
        }
        buildkitError = `exit ${run.exitCode}: ${(run.stderr || run.stdout).trim().slice(0, 2000)}`;
    } catch (e) {
        buildkitError = (e as Error).message;
    }
    return fallBack(workspaceRoot, options.jsLister, {
        kind: 'failed',
        reason: `buildkit (${binary}) could not list the projects: ${buildkitError.split('\n')[0].slice(0, 300)}`,
        searched,
        binary,
        buildkitError,
        hint: fallbackHint('failed', searched, binary),
    });
}

/** Lists the projects without buildkit; a seam for tests. */
export type JsLister = (root: string) => { projects: WorkspaceProject[] };

/** The JavaScript listing, with the diagnostic told to the notifier. */
function fallBack(workspaceRoot: string, jsLister: JsLister | undefined, fallback: ListingFallback): ProjectListing {
    try {
        const { projects } = (jsLister ?? listProjectsJs)(workspaceRoot);
        notifyFallback(fallback);
        return { ok: true, source: 'javascript', root: workspaceRoot, projects, fallback };
    } catch (e) {
        notifyFallback(fallback);
        return { ok: false, error: `${fallback.reason} The JavaScript listing failed too: ${(e as Error).message}`, ...(fallback.binary ? { binary: fallback.binary } : {}), searched: fallback.searched };
    }
}
