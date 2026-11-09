/**
 * Installs, updates and removes provider SDKs (utils/providerSdks.ts) in a
 * folder outside the VSIX — the extension's global storage, `providers/` —
 * so they survive extension updates.
 *
 * An install downloads each package's tarball straight from the npm registry
 * (no npm, no Node on the user's machine), checks its integrity, unpacks it
 * into `<root>/<id>.staging/<path>` and, when every package is in, swaps the
 * staging folder for the provider's folder (`<root>/<id>`), then records
 * what it installed (`providers-state.json`: the roots' versions and every
 * package with its version). A failure leaves the installed provider as it
 * was.
 *
 * Versions: an install takes the manifest's — the ones this build is tested
 * with. **Check for updates** asks the registry for each root's latest
 * release; an update installs those, with the dependencies resolved from the
 * registry (a pinned version is kept where it satisfies the new range), and
 * the platform package of the new Agent SDK for this host. Nothing updates by
 * itself.
 *
 * vscode-free: `fetch` and the host are injected (tests use a local registry).
 */

import * as fs from 'fs';
import * as path from 'path';
import {
    currentHost,
    extractTgz,
    integrityMatches,
    maxSatisfying,
    compareSemver,
    parseSemver,
    packagesForHost,
    providerDir,
    readProviderState,
    writeProviderState,
    type HostPlatform,
    type InstalledProvider,
    type ProviderDefinition,
    type ProviderManifest,
    type ProviderPackage,
    type ProviderState,
} from '../utils/providerSdks';

/** The part of `fetch` the installer uses. */
export type FetchLike = (url: string) => Promise<{ ok: boolean; status: number; arrayBuffer(): Promise<ArrayBuffer>; json(): Promise<unknown> }>;

export interface ProviderInstallerOptions {
    /** The folder the providers are installed in. */
    root: string;
    manifest: ProviderManifest;
    fetch?: FetchLike;
    host?: HostPlatform;
    /** The registry for packuments (default: the manifest's). */
    registry?: string;
    /** Progress lines (the page shows them). */
    log?: (line: string) => void;
}

/**
 * A root's installed and latest version (Check for updates). `major`: the
 * latest is a new major release (for 0.x a new minor) — it may change the
 * API the extension is built against.
 */
export interface RootUpdate { name: string; installed?: string; latest: string; newer: boolean; major: boolean }

export interface ProviderUpdateInfo {
    id: string;
    roots: RootUpdate[];
    /** A root has a release newer than the installed one. */
    updateAvailable: boolean;
    /** A newer root release is a new major version (see RootUpdate.major). */
    majorChange: boolean;
    /** The version label to show ("update to …"). */
    latestLabel: string;
}

interface Packument {
    // eslint-disable-next-line @typescript-eslint/naming-convention -- the registry's field
    'dist-tags'?: Record<string, string>;
    versions?: Record<string, {
        version: string;
        dependencies?: Record<string, string>;
        optionalDependencies?: Record<string, string>;
        os?: string[];
        cpu?: string[];
        libc?: string[];
        dist: { tarball: string; integrity?: string };
    }>;
}

export class ProviderInstaller {
    private readonly root: string;
    private readonly manifest: ProviderManifest;
    private readonly fetchFn: FetchLike;
    private readonly host: HostPlatform;
    private readonly registry: string;
    private readonly log: (line: string) => void;
    private readonly packuments = new Map<string, Packument>();

    constructor(opts: ProviderInstallerOptions) {
        this.root = opts.root;
        this.manifest = opts.manifest;
        this.fetchFn = opts.fetch ?? (globalThis.fetch as unknown as FetchLike);
        this.host = opts.host ?? currentHost();
        this.registry = (opts.registry ?? opts.manifest.registry).replace(/\/+$/, '');
        this.log = opts.log ?? (() => undefined);
    }

    definition(id: string): ProviderDefinition {
        const def = this.manifest.providers.find((p) => p.id === id);
        if (!def) { throw new Error(`Unknown provider: ${id}`); }
        return def;
    }

    state(): ProviderState {
        return readProviderState(this.root);
    }

    /** The manifest's (pinned) packages of `id` for this host. */
    pinnedPackages(id: string): ProviderPackage[] {
        return packagesForHost(this.definition(id).packages, this.host);
    }

    /** Install `id` at the manifest's versions (or the given package set); replaces what is installed. */
    async install(id: string, packages: ProviderPackage[] = this.pinnedPackages(id), source: InstalledProvider['source'] = 'pinned'): Promise<InstalledProvider> {
        const def = this.definition(id);
        const finalDir = providerDir(this.root, id);
        const staging = `${finalDir}.staging`;
        fs.rmSync(staging, { recursive: true, force: true });
        fs.mkdirSync(staging, { recursive: true });
        try {
            let n = 0;
            for (const p of packages) {
                n++;
                this.log(`(${n}/${packages.length}) ${p.name}@${p.version}`);
                const res = await this.fetchFn(p.resolved);
                if (!res.ok) { throw new Error(`downloading ${p.name}@${p.version} failed: HTTP ${res.status} (${p.resolved})`); }
                const data = Buffer.from(await res.arrayBuffer());
                if (!integrityMatches(data, p.integrity)) {
                    throw new Error(`${p.name}@${p.version}: the download does not match its integrity (${p.integrity.slice(0, 20)}…)`);
                }
                extractTgz(data, path.join(staging, p.path));
            }
            // Every root must be there, or the provider cannot load.
            for (const r of def.roots) {
                if (!packages.some((p) => p.name === r)) { throw new Error(`${id}: the package set has no ${r}`); }
            }
        } catch (e) {
            fs.rmSync(staging, { recursive: true, force: true });
            throw e;
        }
        const old = `${finalDir}.old`;
        fs.rmSync(old, { recursive: true, force: true });
        if (fs.existsSync(finalDir)) { fs.renameSync(finalDir, old); }
        fs.renameSync(staging, finalDir);
        fs.rmSync(old, { recursive: true, force: true });
        const record: InstalledProvider = {
            roots: Object.fromEntries(def.roots.map((r) => [r, packages.find((p) => p.name === r)!.version])),
            packages: Object.fromEntries(packages.map((p) => [p.name, p.version])),
            installedAt: new Date().toISOString(),
            source,
        };
        const state = this.state();
        state.providers[id] = record;
        writeProviderState(this.root, state);
        this.log(`✔ ${def.name} installed (${packages.length} packages)`);
        return record;
    }

    /** Remove `id`: its folder and its record. */
    remove(id: string): void {
        this.definition(id);
        fs.rmSync(providerDir(this.root, id), { recursive: true, force: true });
        const state = this.state();
        delete state.providers[id];
        writeProviderState(this.root, state);
        this.log(`✔ ${this.definition(id).name} removed`);
    }

    private async packument(name: string): Promise<Packument> {
        const cached = this.packuments.get(name);
        if (cached) { return cached; }
        const url = `${this.registry}/${name.replace('/', '%2f')}`;
        const res = await this.fetchFn(url);
        if (!res.ok) { throw new Error(`the registry has no ${name} (HTTP ${res.status})`); }
        const p = await res.json() as Packument;
        this.packuments.set(name, p);
        return p;
    }

    /** For every installed provider (or `ids`): its roots' installed and latest versions. */
    async checkUpdates(ids: string[] = Object.keys(this.state().providers)): Promise<ProviderUpdateInfo[]> {
        const state = this.state();
        this.packuments.clear();
        const out: ProviderUpdateInfo[] = [];
        for (const id of ids) {
            const def = this.definition(id);
            const roots: RootUpdate[] = [];
            for (const name of def.roots) {
                const latest = (await this.packument(name))['dist-tags']?.latest;
                if (!latest) { throw new Error(`the registry names no latest release of ${name}`); }
                const installed = state.providers[id]?.roots[name];
                const newer = !!installed && compareSemver(latest, installed) > 0;
                roots.push({ name, installed, latest, newer, major: newer && isMajorChange(installed!, latest) });
            }
            out.push({
                id,
                roots,
                updateAvailable: roots.some((r) => r.newer),
                majorChange: roots.some((r) => r.major),
                latestLabel: roots.map((r) => `${r.name.replace(/^@[^/]+\//, '')} ${r.latest}`).join(', '),
            });
        }
        return out;
    }

    /**
     * The package set of `id` at its roots' latest releases: each root at
     * `latest`, its dependencies and this host's platform packages resolved
     * from the registry — a pinned version where it satisfies the range, else
     * the highest that does — hoisted to `node_modules/<name>`, nested under
     * the package needing it when two versions clash.
     */
    async resolveLatest(id: string): Promise<ProviderPackage[]> {
        // What the registry says now, not at the last check.
        this.packuments.clear();
        const def = this.definition(id);
        const pinned = new Map(def.packages.map((p) => [p.name, p.version]));
        const chosen = new Map<string, ProviderPackage>(); // path → package
        const hoisted = new Map<string, string>(); // name → version at node_modules/<name>
        const add = async (name: string, range: string, parentPath: string, optional: boolean): Promise<void> => {
            const doc = await this.packument(name);
            const versions = Object.keys(doc.versions ?? {});
            const pin = pinned.get(name);
            const version = range === 'latest'
                ? doc['dist-tags']?.latest
                : (pin && versions.includes(pin) && maxSatisfying([pin], range) ? pin : maxSatisfying(versions, range));
            if (!version) { throw new Error(`no release of ${name} satisfies ${range}`); }
            const meta = doc.versions![version];
            const pkg: ProviderPackage = { name, version, path: '', resolved: meta.dist.tarball, integrity: meta.dist.integrity ?? '' };
            if (meta.os) { pkg.os = meta.os; }
            if (meta.cpu) { pkg.cpu = meta.cpu; }
            if (meta.libc) { pkg.libc = meta.libc; } else if (/-musl$/.test(name)) { pkg.libc = ['musl']; } else if (meta.os?.includes('linux') && meta.cpu) { pkg.libc = ['glibc']; }
            if (optional && packagesForHost([pkg], this.host).length === 0) { return; }
            if (!pkg.integrity) { throw new Error(`${name}@${version} has no integrity in the registry`); }
            const top = hoisted.get(name);
            if (top === version) { return; }
            pkg.path = top === undefined ? `node_modules/${name}` : `${parentPath}/node_modules/${name}`;
            if (top === undefined) { hoisted.set(name, version); }
            if (chosen.has(pkg.path)) { return; }
            chosen.set(pkg.path, pkg);
            for (const [dep, r] of Object.entries(meta.dependencies ?? {})) { await add(dep, r, pkg.path, false); }
            for (const [dep, r] of Object.entries(meta.optionalDependencies ?? {})) { await add(dep, r, pkg.path, true); }
        };
        for (const r of def.roots) { await add(r, 'latest', '', false); }
        // What the manifest installs beside the roots (a peer such as zod) stays at its pinned version.
        for (const name of def.alsoInstall ?? []) {
            const p = def.packages.find((q) => q.name === name && q.path === `node_modules/${name}`);
            if (p && !hoisted.has(name)) { chosen.set(p.path, p); hoisted.set(name, p.version); }
        }
        return [...chosen.values()].sort((a, b) => a.path.localeCompare(b.path));
    }

    /** Install the roots' latest releases of `id`. */
    async update(id: string): Promise<InstalledProvider> {
        const packages = await this.resolveLatest(id);
        return this.install(id, packages, 'update');
    }
}

/** Whether `latest` is a new major release of `installed` (for 0.x: a new minor). */
export function isMajorChange(installed: string, latest: string): boolean {
    const a = parseSemver(installed);
    const b = parseSemver(latest);
    if (!a || !b) { return false; }
    return a.major !== b.major || (a.major === 0 && a.minor !== b.minor);
}
