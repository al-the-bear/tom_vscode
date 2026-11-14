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
 * buildkit is a tom binary, bundled with the extension as the last fallback.
 * It is looked for in every place in turn, the first that has the file wins
 * (services/buildTools.ts `resolveBuildTool`, qrfix14 / vscimpb83):
 *   1. configured: `bridge.executables.buildkit` names a file;
 *   2. the configured binaries folder `bridge.binaryPath` — unless it names an
 *      environment variable this process does not have (`${env:TOM_BINARY_PATH}`
 *      in a VS Code started from the Dock), which is noted and passed;
 *   3. the workspace's binaries layer `<workspace>/tom_binaries/tom/<platform>/`;
 *   4. `$TOM_BINARY_PATH/<platform>/` (`~/.tom/bin` is never looked at);
 *   5. `buildkit` on PATH;
 *   6. the extension's own copy, `<extension>/bin/<platform>/`.
 *
 * Without a buildkit, or when it cannot list (exits non-zero, e.g. a build
 * older than tom_build_kit 1.19.0 without `:projects`, or answers no
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
import { listProjectsJs } from './projectListingJs';
import { getCurrentPlatform } from '../utils/executableResolver';
import { currentDartBinariesConfig, dartBinariesExtensionRoot, runBinaryFile, type DartBinariesConfig } from './dartBinariesStatus';
import { resolveBuildTool } from './buildTools';

export { unsetEnvVariables } from './buildTools';

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

/**
 * Where buildkit is, for [workspaceRoot] and the `bridge` configuration
 * [config]: the file to run (the first place that has it), and every place
 * looked at, with notes. The last place is the extension's own copy
 * (`extensionRoot`, default the installed extension's; null: not looked at).
 */
export function resolveBuildkitBinary(
    workspaceRoot: string,
    config: DartBinariesConfig = {},
    env: NodeJS.ProcessEnv = process.env,
    platform: string = getCurrentPlatform(),
    extensionRoot: string | null = dartBinariesExtensionRoot(),
): { binary?: string; searched: string[] } {
    const state = resolveBuildTool('buildkit', workspaceRoot, config, env, platform, extensionRoot ?? undefined);
    return state.path ? { binary: state.path, searched: state.searched } : { searched: state.searched };
}

/** How to fix a listing that did not come from buildkit. */
export function fallbackHint(kind: ListingFallback['kind'], searched: readonly string[], binary?: string): string {
    if (kind === 'failed') {
        return `The buildkit at ${binary} could not list the projects; \`:projects --all --json\` needs tom_build_kit 1.19.0 or later. `
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
        /** The extension whose bundled buildkit is the last place (default the installed one; null: not looked at). */
        extensionRoot?: string | null;
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
    options: { config?: DartBinariesConfig; runner?: BuildkitRunner; env?: NodeJS.ProcessEnv; jsLister?: JsLister; extensionRoot?: string | null },
): Promise<ProjectListing> {
    const config = options.config ?? currentDartBinariesConfig();
    const { binary, searched } = options.extensionRoot === undefined
        ? resolveBuildkitBinary(workspaceRoot, config, options.env)
        : resolveBuildkitBinary(workspaceRoot, config, options.env, undefined, options.extensionRoot);
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

// ── The listing for the extension's own callers (vscimpb84) ───────────────────
// The one project discovery of the extension: the todo panel's project scopes,
// the prompt scopes, the active-project picker, the @WS guideline and document
// projects, the scripting bridge and the Telegram / command-line project lookups
// all read this listing (buildkit's, the JavaScript port where no buildkit is
// found). Everything they need is derived from a listed project here: its
// path, language, natures and type.

/** The listing's options, for callers that pass them through. */
export type ListingOptions = Parameters<typeof listWorkspaceProjects>[1];

/**
 * The listed projects of [workspaceRoot] (cached as listWorkspaceProjects is),
 * sorted by name; no listing (neither buildkit's nor the JavaScript port's)
 * gives none.
 */
export async function listedProjects(workspaceRoot: string, options: ListingOptions = {}): Promise<WorkspaceProject[]> {
    const listing = await listWorkspaceProjects(workspaceRoot, options);
    if (!listing.ok) { return []; }
    return [...listing.projects].sort((a, b) => a.name.localeCompare(b.name) || a.path.localeCompare(b.path));
}

/** The innermost listed project holding [dir] (the folder itself or one above it), if any. */
export function nearestListedProject(projects: readonly WorkspaceProject[], dir: string): WorkspaceProject | undefined {
    const target = pathKey(dir);
    let best: WorkspaceProject | undefined;
    for (const p of projects) {
        const root = pathKey(p.absolutePath);
        if (target === root || target.startsWith(`${root}/`)) {
            if (!best || root.length > pathKey(best.absolutePath).length) { best = p; }
        }
    }
    return best;
}

function isFileOnDisk(file: string): boolean {
    try { return fs.statSync(file).isFile(); } catch { return false; }
}

function pathKey(p: string): string {
    const normalized = p.replace(/\\/g, '/').replace(/\/+$/, '');
    return process.platform === 'win32' ? normalized.toLowerCase() : normalized;
}

/** The todo panel's coarse project kind: Dart (Flutter included), Node (TypeScript / JavaScript), other. */
export function coarseProjectType(p: WorkspaceProject): 'dart' | 'node' | 'other' {
    if (p.language === 'dart') { return 'dart'; }
    if (p.language === 'typescript' || p.language === 'javascript') { return 'node'; }
    return 'other';
}

/** The scripting API's `ProjectType` (tom_vscode_scripting_api): dart, flutter, node, python, other. */
export function scriptingProjectType(p: WorkspaceProject): 'dart' | 'flutter' | 'node' | 'python' | 'other' {
    if (p.natures.includes('flutter') || p.type.startsWith('flutter')) { return 'flutter'; }
    const coarse = coarseProjectType(p);
    if (coarse !== 'other') { return coarse; }
    return p.language === 'python' ? 'python' : 'other';
}

/**
 * Whether the project's folder is a workspace of its own (it holds a
 * `buildkit_master.yaml`) below the listed root: the scripting API's
 * `isSubWorkspace`.
 */
export function isSubWorkspace(p: WorkspaceProject, workspaceRoot: string, exists: (file: string) => boolean = isFileOnDisk): boolean {
    if (pathKey(p.absolutePath) === pathKey(workspaceRoot)) { return false; }
    return exists(`${p.absolutePath.replace(/[\\/]+$/, '')}/buildkit_master.yaml`);
}

/**
 * A listed project as the scripting bridge answers it (tom_vscode_scripting_api
 * `ProjectInfo.fromJson`): id, name, path, relativePath, type, description,
 * version, tags (the natures), isSubWorkspace; plus language and natures as the
 * listing has them.
 */
export function scriptingProjectInfo(p: WorkspaceProject, workspaceRoot: string, exists?: (file: string) => boolean): Record<string, unknown> {
    return {
        id: p.id,
        name: p.name,
        path: p.absolutePath,
        relativePath: p.path,
        type: scriptingProjectType(p),
        ...(p.description ? { description: p.description } : {}),
        ...(p.version ? { version: p.version } : {}),
        tags: [...p.natures],
        language: p.language,
        natures: [...p.natures],
        isSubWorkspace: isSubWorkspace(p, workspaceRoot, exists),
    };
}
