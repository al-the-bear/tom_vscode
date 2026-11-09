/**
 * The Claude Agent SDK's native CLI on the platform this window runs on.
 *
 * The SDK runs a `claude` executable shipped in a per-platform package,
 * `@anthropic-ai/claude-agent-sdk-<platform>-<arch>[-musl]`. The extension
 * does not carry it: the Anthropic provider (Provider SDKs page,
 * services/providerInstaller.ts) installs the SDK with this platform's CLI
 * package into the extension's global storage, and the transport hands the
 * CLI to the SDK as `pathToClaudeCodeExecutable`. In a development checkout
 * the extension's own devDependency is used. On a platform the SDK ships no
 * CLI for, the Agent SDK transport cannot run; the other transports (direct
 * API, VS Code LM, Copilot, Local LLM) are not affected.
 *
 * {@link locateAgentSdkCli} looks the package up the way the SDK does
 * (sdk.mjs: `<package>/claude[.exe]`, on Linux the glibc and the musl
 * package), so the transport can say what is missing before the SDK fails
 * with "Native CLI binary for … not found".
 *
 * vscode-free.
 */

import * as fs from 'fs';
import * as path from 'path';
import { ANTHROPIC_PROVIDER, PROVIDER_SDKS_COMMAND, providerRequire } from './providerRuntime';

export const AGENT_SDK_PACKAGE = '@anthropic-ai/claude-agent-sdk';

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

/** The CLI's package path for this platform through `resolve`, or null. */
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

/** Where the CLI is: in the installed Anthropic provider, or the development checkout's own package. */
export interface AgentSdkCliLocation {
    path: string;
    source: 'provider' | 'package';
}

/** The CLI for this platform: the installed provider's, else the extension's own (a development checkout); null when neither has one. */
export function locateAgentSdkCli(
    providerResolve: ((id: string) => string) | undefined = providerRequire(ANTHROPIC_PROVIDER)?.resolve,
    devResolve?: (id: string) => string,
    exists: (file: string) => boolean = (file) => fs.existsSync(file),
    platform: string = process.platform,
    arch: string = process.arch,
): AgentSdkCliLocation | null {
    if (providerResolve) {
        const installed = findAgentSdkCli(providerResolve, exists, platform, arch);
        return installed ? { path: installed, source: 'provider' } : null;
    }
    if (process.env.TOM_PROVIDER_SDKS_NO_DEV_FALLBACK === '1') { return null; }
    const dev = findAgentSdkCli(devResolve, exists, platform, arch);
    return dev ? { path: dev, source: 'package' } : null;
}

export function agentSdkCliMissingMessage(platform: string = `${process.platform}-${process.arch}`): string {
    return `The Agent SDK transport needs the Claude CLI (${AGENT_SDK_PACKAGE}-${platform}), which the installed Anthropic provider does not have for ${platform}. `
        + `Use another transport (direct Anthropic API, VS Code LM, Copilot, a local model), or install the Anthropic provider again on the Provider SDKs page (command ${PROVIDER_SDKS_COMMAND}).`;
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
