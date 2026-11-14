/**
 * The tom build tools the VSIX bundles as the last fallback (vscimpb83):
 * `buildkit` (builds, the versioner as `buildkit :versioner`, the project
 * listing `buildkit :projects`), `d4rtgen` (D4rt bridges), `reflectiongenerator`
 * (reflection code) and `testkit` (test runs and baselines, which the TomSpecs
 * process records). They are built by their own repositories into the
 * binaries layer `tom_binaries/tom/<platform>/`; a VSIX copies them from there
 * into `bin/<platform>/` (scripts/binaries-layer.cjs `tools`), with a
 * `<name>.bundle.json` stamp.
 *
 * One lookup for every caller, the first place that has the file wins:
 *   1. configured: `bridge.executables.<name>` names a file;
 *   2. the configured binaries folder `bridge.binaryPath` — unless it names an
 *      environment variable this process does not have (`${env:TOM_BINARY_PATH}`
 *      in a VS Code started from the Dock), which is noted and passed;
 *   3. the workspace's binaries layer `<workspace>/tom_binaries/tom/<platform>/`;
 *   4. `$TOM_BINARY_PATH/<platform>/` (`~/.tom/bin` is never looked at);
 *   5. the tool on PATH;
 *   6. bundled: `<extension>/bin/<platform>/<name>[.exe]`.
 * So a workspace's own, newer binaries win, and the bundled copy makes a tom
 * repository usable with the extension alone.
 *
 * vscode-free.
 */

import * as fs from 'fs';
import * as path from 'path';
import {
    buildConfigContext,
    expandHomePath,
    getCurrentPlatform,
    resolveNamedExecutable,
    type ExecutableConfig,
    type ExecutablesConfig,
} from '../utils/executableResolver';

export const BUILD_TOOLS = ['buildkit', 'd4rtgen', 'reflectiongenerator', 'testkit'] as const;
export type BuildToolName = typeof BUILD_TOOLS[number];

/** What each tool is for, for the Status Page and the Missing Dart Binaries page. */
export const BUILD_TOOL_PURPOSE: Record<BuildToolName, string> = {
    buildkit: 'builds, versions (:versioner) and lists the projects (:projects)',
    d4rtgen: 'D4rt bridge generation',
    reflectiongenerator: 'reflection code generation',
    testkit: 'test runs and baselines (the TomSpecs process)',
};

/** Where a tool was found: configured, the binaries layer, PATH, the extension's copy, or nowhere. */
export type BuildToolSource = 'configured' | 'layer' | 'path' | 'bundled' | 'missing';

export interface BuildToolState {
    name: BuildToolName;
    source: BuildToolSource;
    /** The file that runs; absent when missing. */
    path?: string;
    /** Every place looked at, in order, with notes. */
    searched: string[];
}

/** The configuration the lookup reads (the `bridge` section of tom_vscode_extension.json). */
export interface BuildToolsConfig {
    executables?: ExecutablesConfig;
    binaryPath?: ExecutableConfig;
}

function isFile(p: string): boolean {
    try { return fs.statSync(p).isFile(); } catch { return false; }
}

/** The tool's file name on `platform` (`.exe` on Windows). */
export function buildToolFileName(name: string, platform: string = getCurrentPlatform()): string {
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
 * Where the tool `name` is for [workspaceRoot]: the file to run (the first
 * place that has it), where it was found, and every place looked at.
 * `extensionRoot` is the installed extension (its `bin/<platform>/`); without
 * it the bundled copy is not looked at.
 */
export function resolveBuildTool(
    name: BuildToolName,
    workspaceRoot: string,
    config: BuildToolsConfig = {},
    env: NodeJS.ProcessEnv = process.env,
    platform: string = getCurrentPlatform(),
    extensionRoot?: string,
): BuildToolState {
    const searched: string[] = [];
    const file = buildToolFileName(name, platform);
    const tryFile = (candidate: string, note?: string): string | undefined => {
        searched.push(note ? `${candidate} (${note})` : candidate);
        return isFile(candidate) ? candidate : undefined;
    };
    const found = (source: BuildToolSource, p: string): BuildToolState => ({ name, source, path: p, searched });

    // 1. bridge.executables.<name>
    if (config.executables?.[name]) {
        const ctx = buildConfigContext(config.binaryPath, workspaceRoot);
        const resolved = resolveNamedExecutable(name, config.executables, ctx);
        if (resolved && path.dirname(resolved) !== '.') {
            const unset = unsetEnvVariables(resolved, env);
            if (unset.length) {
                searched.push(`${resolved} (bridge.executables.${name}: ${unset.map((n) => `\${env:${n}}`).join(', ')} not set in this process)`);
            } else {
                const hit = tryFile(expandHomePath(expandEnv(resolved, env)), `bridge.executables.${name}`);
                if (hit) { return found('configured', hit); }
            }
        }
    }

    // 2. bridge.binaryPath, when its variables are set
    const configured = forPlatform(config.binaryPath, platform);
    if (configured) {
        const unset = unsetEnvVariables(configured, env);
        if (unset.length) {
            searched.push(`${path.join(configured, file)} (bridge.binaryPath: ${unset.map((n) => `\${env:${n}}`).join(', ')} not set in this process)`);
        } else {
            const hit = tryFile(path.join(expandHomePath(expandEnv(configured, env)), file), 'bridge.binaryPath');
            if (hit) { return found('configured', hit); }
        }
    }

    // 3. the workspace's binaries layer
    const inLayer = tryFile(path.join(workspaceRoot, 'tom_binaries', 'tom', platform, file), 'the workspace\'s binaries layer');
    if (inLayer) { return found('layer', inLayer); }

    // 4. $TOM_BINARY_PATH/<platform>/ - the binaries layer as the shell names it. ~/.tom/bin is not looked at:
    // binaries are not installed there, and an old copy left there must not run (build_tom build_cleanup1002).
    if (env.TOM_BINARY_PATH) {
        const hit = tryFile(path.join(expandHomePath(env.TOM_BINARY_PATH), platform, file), '$TOM_BINARY_PATH/<platform>');
        if (hit) { return found('layer', hit); }
    } else {
        searched.push(`${path.join('$TOM_BINARY_PATH', platform, file)} (TOM_BINARY_PATH not set in this process)`);
    }

    // 5. PATH
    let onPath: string | undefined;
    for (const dir of (env.PATH ?? env.Path ?? '').split(path.delimiter)) {
        if (!dir) { continue; }
        const candidate = path.join(dir, file);
        if (isFile(candidate)) { onPath = candidate; break; }
    }
    searched.push(onPath ? `${onPath} (PATH)` : `${file} on PATH`);
    if (onPath) { return found('path', onPath); }

    // 6. the extension's own copy, the last fallback
    if (extensionRoot) {
        const bundled = tryFile(path.join(extensionRoot, 'bin', platform, file), 'bundled with the extension');
        if (bundled) { return found('bundled', bundled); }
    }
    return { name, source: 'missing', searched };
}

/** Every build tool, resolved for this window. */
export function buildToolsStatus(
    workspaceRoot: string,
    config: BuildToolsConfig = {},
    extensionRoot?: string,
    env: NodeJS.ProcessEnv = process.env,
    platform: string = getCurrentPlatform(),
): BuildToolState[] {
    return BUILD_TOOLS.map((name) => resolveBuildTool(name, workspaceRoot, config, env, platform, extensionRoot));
}
