/**
 * The Claude Agent SDK's native CLI on the platform this window runs on.
 *
 * The SDK runs a `claude` executable shipped in a per-platform package,
 * `@anthropic-ai/claude-agent-sdk-<platform>-<arch>[-musl]`. npm installs the
 * host's only, and a VSIX carries what was installed when it was built: the
 * build host's package. With `--all-platforms` (install_extension.*) the
 * fleet's other CLIs ({@link FLEET_CLI_PLATFORMS}) are bundled as
 * `bin/<platform>/claude[.exe]` — not as packages, which vsce's dependency
 * check refuses for another platform — and handed to the SDK as
 * `pathToClaudeCodeExecutable`. On a platform with neither, the Agent SDK
 * transport cannot run; the other transports (direct API, VS Code LM,
 * Copilot, Local LLM) are not affected.
 *
 * {@link locateAgentSdkCli} looks the package up the way the SDK does
 * (sdk.mjs: `<package>/claude[.exe]`, on Linux the glibc and the musl
 * package), then the bundled binary, so the transport can say what is
 * missing before the SDK fails with "Native CLI binary for … not found".
 *
 * vscode-free.
 */

import * as fs from 'fs';
import * as path from 'path';

export const AGENT_SDK_PACKAGE = '@anthropic-ai/claude-agent-sdk';
/** The platforms `--all-platforms` bundles the CLI for (the fleet's). */
export const FLEET_CLI_PLATFORMS = ['darwin-arm64', 'linux-x64', 'win32-x64'] as const;

export const AGENT_SDK_CLI_HELP_COMMAND = 'tomAi.showAgentSdkCliHelp';
export const AGENT_SDK_CLI_HELP_HINT = `Run command ${AGENT_SDK_CLI_HELP_COMMAND}`;
/** The page template inside the extension. */
export const AGENT_SDK_CLI_HELP_PAGE = path.join('resources', 'agent_sdk', 'missing_agent_sdk_cli.md');

/** The module ids the SDK tries for this platform, in its order (`<package>/claude[.exe]`). */
export function agentSdkCliCandidates(platform: string = process.platform, arch: string = process.arch): string[] {
    const exe = platform === 'win32' ? '.exe' : '';
    const packages = platform === 'linux'
        ? [`${AGENT_SDK_PACKAGE}-linux-${arch}`, `${AGENT_SDK_PACKAGE}-linux-${arch}-musl`]
        : [`${AGENT_SDK_PACKAGE}-${platform}-${arch}`];
    return packages.map((p) => `${p}/claude${exe}`);
}

/** The CLI's package path for this platform (what the SDK finds by itself), or null. */
export function findAgentSdkCli(
    resolve: (id: string) => string = (id) => require.resolve(id),
    exists: (file: string) => boolean = (file) => fs.existsSync(file),
    platform: string = process.platform,
    arch: string = process.arch,
): string | null {
    for (const id of agentSdkCliCandidates(platform, arch)) {
        try {
            const file = resolve(id);
            if (exists(file)) { return file; }
        } catch {
            // Not installed: try the next candidate.
        }
    }
    return null;
}

/** The extension root: this file is out/services/. */
const EXTENSION_ROOT = path.resolve(__dirname, '..', '..');

/** Where the CLI is: its package (the SDK finds it) or the binary bundled in `bin/<platform>/` (passed to the SDK). */
export interface AgentSdkCliLocation {
    path: string;
    source: 'package' | 'bundled';
}

/** The bundled binary `--all-platforms` puts into the extension for a platform. */
export function bundledAgentSdkCliPath(extensionRoot: string, platform: string = process.platform, arch: string = process.arch): string {
    return path.join(extensionRoot, 'bin', `${platform}-${arch}`, platform === 'win32' ? 'claude.exe' : 'claude');
}

/** The CLI for this platform: the package first, then the bundled binary; null when the extension has neither. */
export function locateAgentSdkCli(
    extensionRoot: string = EXTENSION_ROOT,
    resolve?: (id: string) => string,
    exists: (file: string) => boolean = (file) => fs.existsSync(file),
    platform: string = process.platform,
    arch: string = process.arch,
): AgentSdkCliLocation | null {
    const fromPackage = findAgentSdkCli(resolve, exists, platform, arch);
    if (fromPackage) { return { path: fromPackage, source: 'package' }; }
    const bundled = bundledAgentSdkCliPath(extensionRoot, platform, arch);
    return exists(bundled) ? { path: bundled, source: 'bundled' } : null;
}

export function agentSdkCliMissingMessage(platform: string = `${process.platform}-${process.arch}`): string {
    return `The Agent SDK transport needs the Claude CLI (${AGENT_SDK_PACKAGE}-${platform}), which this extension does not carry for ${platform}. `
        + 'Use another transport (direct Anthropic API, VS Code LM, Copilot, a local model) or install a VSIX built with --all-platforms.';
}

/** Thrown by the Agent SDK transport before a query when the CLI is missing on this platform. */
export class AgentSdkCliMissing extends Error {
    constructor(readonly platform: string = `${process.platform}-${process.arch}`, readonly page?: string) {
        super(`${agentSdkCliMissingMessage(platform)}${page ? ` How to get it: ${page} (command ${AGENT_SDK_CLI_HELP_COMMAND}).` : ''}`);
        this.name = 'AgentSdkCliMissing';
    }
}

/** Fill the page's placeholders: `{{platform}}` and `{{package}}` (the package this platform needs). */
export function fillAgentSdkCliPage(template: string, platform: string = `${process.platform}-${process.arch}`): string {
    return template
        .replace(/\{\{platform\}\}/g, platform)
        .replace(/\{\{package\}\}/g, `${AGENT_SDK_PACKAGE}-${platform}`);
}
