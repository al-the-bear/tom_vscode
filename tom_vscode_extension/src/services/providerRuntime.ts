/**
 * Loading a provider's SDK from where the extension installed it
 * (services/providerInstaller.ts): `<global storage>/providers/<id>/node_modules`.
 *
 * The VSIX carries no provider SDK. The direct Anthropic transport takes
 * `@anthropic-ai/sdk` from the installed Anthropic provider, the Agent SDK
 * transport `@anthropic-ai/claude-agent-sdk` and its Claude CLI for this
 * platform. Not installed: {@link ProviderSdkMissing}, naming the Provider
 * SDKs page that installs it.
 *
 * In a development checkout (tests, F5) the SDKs are the extension's own
 * devDependencies: when no provider is installed, they are taken from there.
 * A VSIX has none, so an installed provider is the only source there.
 *
 * vscode-free; activation names the folder ({@link setProviderRoot}).
 */

import * as fs from 'fs';
import * as path from 'path';
import { createRequire } from 'module';
import { pathToFileURL } from 'url';
import { isProviderInstalled, providerDir, readProviderState } from '../utils/providerSdks';

export const PROVIDER_SDKS_COMMAND = 'tomAi.providerSdks';
export const ANTHROPIC_PROVIDER = 'anthropic';
export const DIRECT_SDK_PACKAGE = '@anthropic-ai/sdk';
export const AGENT_SDK_MODULE = '@anthropic-ai/claude-agent-sdk';

let providerRoot: string | undefined = process.env.TOM_PROVIDER_SDKS_DIR || undefined;

/** The folder providers are installed in (activation: `<global storage>/providers`). */
export function setProviderRoot(dir: string | undefined): void {
    providerRoot = dir;
}

export function getProviderRoot(): string | undefined {
    return providerRoot;
}

/** Whether `id` is installed (recorded and its folder there). */
export function providerInstalled(id: string, root: string | undefined = providerRoot): boolean {
    return !!root && isProviderInstalled(root, id);
}

/** The installed providers' ids. */
export function installedProviders(root: string | undefined = providerRoot): string[] {
    if (!root) { return []; }
    return Object.keys(readProviderState(root).providers).filter((id) => isProviderInstalled(root, id));
}

/** A provider's SDK is not installed: the error says what to install and where. */
export class ProviderSdkMissing extends Error {
    constructor(readonly providerId: string, readonly packageName: string) {
        super(`The ${packageName} SDK is not installed. Install the ${providerId === ANTHROPIC_PROVIDER ? 'Anthropic' : providerId} provider on the Provider SDKs page (Status Page → Provider SDKs, or command ${PROVIDER_SDKS_COMMAND}).`);
        this.name = 'ProviderSdkMissing';
    }
}

/** A `require` resolving from the installed provider's folder, or undefined. */
export function providerRequire(id: string, root: string | undefined = providerRoot): NodeRequire | undefined {
    if (!providerInstalled(id, root)) { return undefined; }
    return createRequire(path.join(providerDir(root!, id), 'node_modules', '.provider-require.js'));
}

/**
 * Whether the extension's own devDependencies may stand in (a development
 * checkout). `TOM_PROVIDER_SDKS_NO_DEV_FALLBACK=1` turns it off, so a checkout
 * behaves as a VSIX does (the tests of the not-installed path).
 */
function devFallback(): boolean {
    return process.env.TOM_PROVIDER_SDKS_NO_DEV_FALLBACK !== '1';
}

/** The extension's own copy (a development checkout), or undefined in a VSIX. */
function devRequireResolve(id: string): string | undefined {
    if (!devFallback()) { return undefined; }
    try { return require.resolve(id); } catch { return undefined; }
}

/** The extension's own package folder of `name` (a development checkout), or undefined — also for ESM-only packages. */
export function devPackageDir(name: string): string | undefined {
    if (!devFallback()) { return undefined; }
    for (const base of require.resolve.paths(name) ?? []) {
        const dir = path.join(base, ...name.split('/'));
        if (fs.existsSync(path.join(dir, 'package.json'))) { return dir; }
    }
    return undefined;
}

/**
 * `@anthropic-ai/sdk`: the installed Anthropic provider's, else the
 * extension's own (a development checkout); neither → ProviderSdkMissing.
 */
export function loadDirectAnthropicSdk(): unknown {
    const req = providerRequire(ANTHROPIC_PROVIDER);
    if (req) { return req(DIRECT_SDK_PACKAGE); }
    const dev = devRequireResolve(DIRECT_SDK_PACKAGE);
    // eslint-disable-next-line @typescript-eslint/no-require-imports -- the dev checkout's devDependency
    if (dev) { return require(dev); }
    throw new ProviderSdkMissing(ANTHROPIC_PROVIDER, DIRECT_SDK_PACKAGE);
}

/** The ESM entry of a package folder: `exports["."]` (import / default), else `main`. */
export function esmEntry(packageDir: string): string {
    const pkg = JSON.parse(fs.readFileSync(path.join(packageDir, 'package.json'), 'utf8')) as {
        exports?: unknown; main?: string; module?: string;
    };
    const pick = (e: unknown): string | undefined => {
        if (typeof e === 'string') { return e; }
        if (e && typeof e === 'object') {
            const o = e as Record<string, unknown>;
            for (const k of ['import', 'node', 'default']) {
                const v = pick(o[k]);
                if (v) { return v; }
            }
        }
        return undefined;
    };
    const exp = pkg.exports;
    const dot = exp && typeof exp === 'object' && !Array.isArray(exp) && '.' in (exp as object) ? (exp as Record<string, unknown>)['.'] : exp;
    const rel = pick(dot) ?? pkg.module ?? pkg.main ?? 'index.js';
    return path.join(packageDir, rel);
}

/**
 * What `import()` loads for the Agent SDK: the installed provider's entry
 * file as a file URL, else the bare specifier (a development checkout
 * resolves it from the extension); neither → ProviderSdkMissing.
 */
export function agentSdkImportSpecifier(root: string | undefined = providerRoot): string {
    if (providerInstalled(ANTHROPIC_PROVIDER, root)) {
        const dir = path.join(providerDir(root!, ANTHROPIC_PROVIDER), 'node_modules', ...AGENT_SDK_MODULE.split('/'));
        if (fs.existsSync(path.join(dir, 'package.json'))) { return pathToFileURL(esmEntry(dir)).href; }
        throw new ProviderSdkMissing(ANTHROPIC_PROVIDER, AGENT_SDK_MODULE);
    }
    if (devPackageDir(AGENT_SDK_MODULE)) { return AGENT_SDK_MODULE; }
    throw new ProviderSdkMissing(ANTHROPIC_PROVIDER, AGENT_SDK_MODULE);
}

/** Whether the Agent SDK can be loaded here (installed, or a development checkout). */
export function agentSdkAvailable(root: string | undefined = providerRoot): boolean {
    try { agentSdkImportSpecifier(root); return true; } catch { return false; }
}
