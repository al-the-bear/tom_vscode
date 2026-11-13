/**
 * The workspace's projects, as buildkit sees them: `buildkit :projects --json`
 * (tom_build_base's `listProjects`), run in the workspace root.
 *
 * One discovery implementation for the build tools and the extension: the
 * same traversal, the same `buildkit_master.yaml` navigation defaults, the
 * identity from each project's `buildkit.yaml` and the natures the build
 * commands select by. There is no generated workspace manifest to read.
 *
 * buildkit is a tom binary, not bundled with the extension. It is found as
 *   1. configured: `bridge.executables.buildkit` names a file that exists;
 *   2. the binaries layer: `<binaryPath>/buildkit` (`bridge.binaryPath`, else
 *      `<workspace>/tom_binaries/tom/<platform>/`, else `~/.tom/bin/<platform>/`);
 *   3. `buildkit` on PATH.
 * Without one the listing answers `ok: false` naming where it looked.
 *
 * Listings are cached per root for {@link CACHE_MS}; `fresh` skips the cache.
 *
 * vscode-free.
 */

import * as fs from 'fs';
import * as path from 'path';
import {
    buildConfigContext,
    expandHomePath,
    getCurrentPlatform,
    resolveBinaryPath,
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

export type ProjectListing =
    | { ok: true; binary: string; root: string; projects: WorkspaceProject[] }
    | { ok: false; error: string; binary?: string; searched?: string[] };

/** How the listing is described in tool answers. */
export const PROJECTS_SOURCE = 'buildkit :projects --json';

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

/**
 * Where buildkit is, for [workspaceRoot] and the `bridge` configuration
 * [config]: the file to run, or the places looked at.
 */
export function resolveBuildkitBinary(
    workspaceRoot: string,
    config: DartBinariesConfig = {},
    env: NodeJS.ProcessEnv = process.env,
    platform: string = getCurrentPlatform(),
): { binary?: string; searched: string[] } {
    const searched: string[] = [];
    const name = exeName('buildkit', platform);

    if (config.executables?.buildkit) {
        const ctx = buildConfigContext(config.binaryPath, workspaceRoot);
        const resolved = resolveNamedExecutable('buildkit', config.executables, ctx);
        if (resolved && path.dirname(resolved) !== '.') {
            const file = expandHomePath(resolved);
            searched.push(file);
            if (isFile(file)) { return { binary: file, searched }; }
        }
    }

    const layer = path.join(resolveBinaryPath(config.binaryPath, workspaceRoot), name);
    searched.push(layer);
    if (isFile(layer)) { return { binary: layer, searched }; }

    for (const dir of (env.PATH ?? env.Path ?? '').split(path.delimiter)) {
        if (!dir) { continue; }
        const candidate = path.join(dir, name);
        if (isFile(candidate)) { return { binary: candidate, searched: [...searched, candidate] }; }
    }
    searched.push(`${name} on PATH`);
    return { searched };
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
 * `buildkit :projects --json` run there.
 */
export function listWorkspaceProjects(
    workspaceRoot: string,
    options: {
        fresh?: boolean;
        config?: DartBinariesConfig;
        runner?: BuildkitRunner;
        now?: () => number;
        env?: NodeJS.ProcessEnv;
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
    options: { config?: DartBinariesConfig; runner?: BuildkitRunner; env?: NodeJS.ProcessEnv },
): Promise<ProjectListing> {
    const config = options.config ?? currentDartBinariesConfig();
    const { binary, searched } = resolveBuildkitBinary(workspaceRoot, config, options.env);
    if (!binary) {
        return {
            ok: false,
            error: 'buildkit not found: the project list comes from `buildkit :projects --json`. '
                + 'Install the tom binaries (the binaries layer, tom_binaries/tom/<platform>/) or set '
                + '`bridge.executables.buildkit` in .tom/tom_vscode_extension.json.',
            searched,
        };
    }
    try {
        const run = await (options.runner ?? defaultRunner)(binary, ['-R', workspaceRoot, ':projects', '--json'], workspaceRoot);
        if (run.exitCode !== 0) {
            return { ok: false, binary, error: `buildkit :projects exited with ${run.exitCode}: ${(run.stderr || run.stdout).trim().slice(0, 2000)}` };
        }
        const parsed = parseProjectsJson(run.stdout);
        return { ok: true, binary, root: parsed.root || workspaceRoot, projects: parsed.projects };
    } catch (e) {
        return { ok: false, binary, error: `buildkit :projects: ${(e as Error).message}` };
    }
}
