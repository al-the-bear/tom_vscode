/**
 * Which Dart-built binaries this window can run, on the platform it runs on:
 * `tom_bs` (DartScript: the bridge) and `validate_codespecs` (CodeSpecs
 * validation).
 *
 * A VSIX carries them only for the platforms it was built with (a build
 * without a Dart SDK carries none for its host; one built on macOS has no
 * `bin/win32-x64/`). So the answer is computed here, at run time, for
 * `getCurrentPlatform()` — the same VSIX answers differently on each machine.
 *
 * A binary is available when it is
 *   - configured: `bridge.executables.<name>` (tom_bs: the executable the
 *     current bridge profile names) resolves for this platform to a file that
 *     exists — checked first, so a configured binary wins over the bundled one;
 *   - bundled: `<extension>/bin/<platform>/<name>[.exe]` exists.
 * Otherwise it is missing; a configured path that names no file is reported
 * as `configuredPath`.
 *
 * The explanation page (`resources/dart_binaries/missing_dart_binaries.md`)
 * says what is lost and how to get the binaries; {@link fillHelpPage} fills
 * its placeholders for this platform. The command tomAi.showDartBinariesHelp
 * opens it (src/handlers/dartBinariesHelp-handler.ts).
 *
 * vscode-free.
 */

import * as fs from 'fs';
import * as path from 'path';
import {
    buildConfigContext,
    expandHomePath,
    getCurrentPlatform,
    resolveBundledBinary,
    resolveNamedExecutable,
    type ExecutableConfig,
    type ExecutablesConfig,
} from '../utils/executableResolver';

export const DART_BINARIES = ['tom_bs', 'validate_codespecs'] as const;
export type DartBinaryName = typeof DART_BINARIES[number];

/** What each binary gives the extension, for the page and the Status Page. */
export const DART_BINARY_FEATURE: Record<DartBinaryName, string> = {
    tom_bs: 'DartScript', // eslint-disable-line @typescript-eslint/naming-convention -- the binary's name
    validate_codespecs: 'CodeSpecs validation', // eslint-disable-line @typescript-eslint/naming-convention -- the binary's name
};

export const HELP_COMMAND = 'tomAi.showDartBinariesHelp';
/** The `help` value tools put in an answer about a missing binary. */
export const HELP_HINT = `Run command ${HELP_COMMAND}`;

/** The extension root: this file is out/services/. */
const EXTENSION_ROOT = path.resolve(__dirname, '..', '..');

/** The page template inside the extension. */
export const HELP_PAGE_TEMPLATE = path.join('resources', 'dart_binaries', 'missing_dart_binaries.md');

export type DartBinarySource = 'configured' | 'bundled' | 'missing';

export interface DartBinaryState {
    name: DartBinaryName;
    source: DartBinarySource;
    /** The file that runs (configured or bundled); absent when missing. */
    path?: string;
    /** A configured path for this platform that names no file. */
    configuredPath?: string;
}

export interface DartBinariesStatus {
    /** VS Code's platform naming: darwin-arm64, win32-x64, … */
    platform: string;
    binaries: DartBinaryState[];
    /** The names of the missing binaries, in DART_BINARIES order. */
    missing: DartBinaryName[];
}

/** The configuration the lookup reads (the `bridge` section of tom_vscode_extension.json). */
export interface DartBinariesConfig {
    executables?: ExecutablesConfig;
    binaryPath?: ExecutableConfig;
    workspaceRoot?: string;
    /** The executable the current bridge profile names (default `tom_bs`). */
    bridgeExecutable?: string;
}

export function binaryFileName(name: DartBinaryName, platform: string = getCurrentPlatform()): string {
    return platform.startsWith('win32') ? `${name}.exe` : name;
}

/** One binary, for this platform: configured first, then bundled. */
export function resolveDartBinary(name: DartBinaryName, extensionRoot: string, config: DartBinariesConfig = {}): DartBinaryState {
    const fileName = binaryFileName(name);
    const bundled = resolveBundledBinary(fileName, extensionRoot);
    const executableName = name === 'tom_bs' ? (config.bridgeExecutable || 'tom_bs') : name;
    let configuredPath: string | undefined;
    if (config.executables?.[executableName]) {
        const ctx = buildConfigContext(config.binaryPath, config.workspaceRoot, extensionRoot);
        const resolved = resolveNamedExecutable(executableName, config.executables, ctx);
        // A bare name is a request for the bundled binary (resolveNamedExecutable already tried it).
        if (resolved && path.dirname(resolved) !== '.' && resolved !== bundled) {
            const file = expandHomePath(resolved);
            if (isFile(file)) { return { name, source: 'configured', path: file }; }
            configuredPath = file;
        }
    }
    if (bundled) { return { name, source: 'bundled', path: bundled, ...(configuredPath ? { configuredPath } : {}) }; }
    return { name, source: 'missing', ...(configuredPath ? { configuredPath } : {}) };
}

export function dartBinariesStatus(extensionRoot: string, config: DartBinariesConfig = {}): DartBinariesStatus {
    const binaries = DART_BINARIES.map((name) => resolveDartBinary(name, extensionRoot, config));
    return {
        platform: getCurrentPlatform(),
        binaries,
        missing: binaries.filter((b) => b.source === 'missing').map((b) => b.name),
    };
}

/** The short form windows report (heartbeat, tomAi_getWorkspaceInfo): each binary's source, and what is missing. */
export interface DartBinariesSummary {
    platform: string;
    binaries: Record<DartBinaryName, DartBinarySource>;
    missing: DartBinaryName[];
}

export function summarizeDartBinaries(status: DartBinariesStatus): DartBinariesSummary {
    const binaries = {} as Record<DartBinaryName, DartBinarySource>;
    for (const b of status.binaries) { binaries[b.name] = b.source; }
    return { platform: status.platform, binaries, missing: status.missing };
}

function isFile(p: string): boolean {
    try { return fs.statSync(p).isFile(); } catch { return false; }
}

// ── The configuration source (set by the extension at activation) ─────────────

let configSource: () => DartBinariesConfig = () => ({});
let filledPagePath: string | undefined;

/** Where the extension reads the `bridge` configuration from; set at activation. */
export function setDartBinariesConfigSource(source: () => DartBinariesConfig): void {
    configSource = source;
}

/** The status for this window, read now (the configuration may have changed). */
export function currentDartBinariesStatus(extensionRoot: string = EXTENSION_ROOT): DartBinariesStatus {
    let config: DartBinariesConfig = {};
    try { config = configSource(); } catch { /* an unreadable config configures nothing */ }
    return dartBinariesStatus(extensionRoot, config);
}

/** One binary for this window, read now. */
export function currentDartBinary(name: DartBinaryName, extensionRoot: string = EXTENSION_ROOT): DartBinaryState {
    let config: DartBinariesConfig = {};
    try { config = configSource(); } catch { /* an unreadable config configures nothing */ }
    return resolveDartBinary(name, extensionRoot, config);
}

/** The filled page, once the extension has written it (src/handlers/dartBinariesHelp-handler.ts). */
export function setFilledHelpPagePath(file: string): void {
    filledPagePath = file;
}

/** What a tool answer about a missing binary carries: the command and the page to read. */
export function dartBinariesHelp(extensionRoot: string = EXTENSION_ROOT): { help: string; page: string } {
    return { help: HELP_HINT, page: filledPagePath ?? path.join(extensionRoot, HELP_PAGE_TEMPLATE) };
}

// ── The once-per-build-and-platform rule ──────────────────────────────────────

/** The key the page is remembered under: one per extension build and platform. */
export function helpPageKey(build: { commit?: string; builtAt: string } | undefined, platform: string): string {
    return `${build?.commit ?? 'unknown'}@${build?.builtAt ?? 'unknown'}|${platform}`;
}

/** Whether the page opens at activation: something is missing and this build has not shown it on this platform. */
export function shouldOpenHelpPage(status: DartBinariesStatus, shown: ReadonlyArray<string> | undefined, key: string): boolean {
    return status.missing.length > 0 && !(shown ?? []).includes(key);
}

/** The remembered keys after showing the page under `key` (the last 20 kept). */
export function rememberHelpPage(shown: ReadonlyArray<string> | undefined, key: string): string[] {
    return [...(shown ?? []).filter((k) => k !== key), key].slice(-20);
}

// ── The page ──────────────────────────────────────────────────────────────────

const SOURCE_LABEL: Record<DartBinarySource, string> = {
    configured: 'configured',
    bundled: 'bundled',
    missing: '**missing**',
};

/**
 * Fill the page's placeholders: `{{platform}}`, `{{missing}}` (the missing
 * binaries and what they give, or "none"), `{{statusTable}}` (a Markdown
 * table of both binaries) and `{{binDir}}` (this platform's folder in the
 * installed extension).
 */
export function fillHelpPage(template: string, status: DartBinariesStatus, extensionRoot: string): string {
    const missing = status.missing.length === 0
        ? 'none — both binaries are available on this platform'
        : status.missing.map((n) => `\`${binaryFileName(n, status.platform)}\` (${DART_BINARY_FEATURE[n]})`).join(' and ');
    const rows = status.binaries.map((b) => {
        const where = b.path ? `\`${b.path}\`` : b.configuredPath ? `configured as \`${b.configuredPath}\`, which does not exist` : '—';
        return `| \`${binaryFileName(b.name, status.platform)}\` | ${DART_BINARY_FEATURE[b.name]} | ${SOURCE_LABEL[b.source]} | ${where} |`;
    });
    const table = ['| Binary | Gives | Status | File |', '| --- | --- | --- | --- |', ...rows].join('\n');
    return template
        .replace(/\{\{platform\}\}/g, status.platform)
        .replace(/\{\{missing\}\}/g, missing)
        .replace(/\{\{statusTable\}\}/g, table)
        .replace(/\{\{binDir\}\}/g, path.join(extensionRoot, 'bin', status.platform));
}
