/**
 * Provider SDKs: the npm packages the extension installs for a model provider
 * instead of carrying them in the VSIX (services/providerInstaller.ts).
 *
 * The rules, vscode-free and without IO: the manifest the build writes
 * (resources/providers/providers.json, scripts/build-provider-manifest.cjs),
 * which of its packages this host takes (a platform package only for its own
 * os / cpu / libc), the integrity check of a downloaded tarball, unpacking a
 * `.tgz` (gzip + tar, the `package/` prefix dropped, nothing outside the
 * target), the semver ranges an update resolves dependencies with, and the
 * record of what is installed.
 */

import * as crypto from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import * as zlib from 'zlib';

// ---------------------------------------------------------------------------
// The manifest
// ---------------------------------------------------------------------------

/** One package of a provider, as package-lock.json resolved it. */
export interface ProviderPackage {
    name: string;
    version: string;
    /** Where it goes, relative to the provider folder: `node_modules/<name>` (or nested). */
    path: string;
    /** The tarball URL. */
    resolved: string;
    /** `sha512-…` (ssri). */
    integrity: string;
    os?: string[];
    cpu?: string[];
    libc?: string[];
}

export interface ProviderDefinition {
    id: string;
    name: string;
    description: string;
    /** The packages that make the provider: their versions are the provider's version. */
    roots: string[];
    /** Installed beside the roots though no root depends on them (peers such as zod); kept pinned by an update. */
    alsoInstall?: string[];
    packages: ProviderPackage[];
}

export interface ProviderManifest {
    formatVersion: number;
    registry: string;
    providers: ProviderDefinition[];
}

export const PROVIDER_MANIFEST_FILE = path.join('resources', 'providers', 'providers.json');

export function readProviderManifest(extensionRoot: string): ProviderManifest {
    return JSON.parse(fs.readFileSync(path.join(extensionRoot, PROVIDER_MANIFEST_FILE), 'utf8')) as ProviderManifest;
}

// ---------------------------------------------------------------------------
// The host
// ---------------------------------------------------------------------------

export interface HostPlatform {
    os: string;
    cpu: string;
    /** On Linux: glibc or musl; elsewhere undefined. */
    libc?: 'glibc' | 'musl';
}

/** This process's platform; on Linux, musl when Node reports no glibc. */
export function currentHost(): HostPlatform {
    const os = process.platform;
    const cpu = process.arch;
    if (os !== 'linux') { return { os, cpu }; }
    const header = (process.report?.getReport() as { header?: { glibcVersionRuntime?: string } } | undefined)?.header;
    return { os, cpu, libc: header?.glibcVersionRuntime ? 'glibc' : 'musl' };
}

/** Whether a package belongs on `host`: no os / cpu / libc restriction, or one that names it. */
export function packageFitsHost(p: ProviderPackage, host: HostPlatform): boolean {
    if (p.os && !p.os.includes(host.os)) { return false; }
    if (p.cpu && !p.cpu.includes(host.cpu)) { return false; }
    if (p.libc && host.libc && !p.libc.includes(host.libc)) { return false; }
    return true;
}

/** The packages `host` installs. */
export function packagesForHost(packages: readonly ProviderPackage[], host: HostPlatform): ProviderPackage[] {
    return packages.filter((p) => packageFitsHost(p, host));
}

/** The platform-restricted packages a provider has none of for `host` (empty: nothing missing for this platform). */
export function platformCoverage(def: ProviderDefinition, host: HostPlatform): { platformPackages: number; forHost: number } {
    const platformPackages = def.packages.filter((p) => p.os || p.cpu);
    return { platformPackages: platformPackages.length, forHost: platformPackages.filter((p) => packageFitsHost(p, host)).length };
}

// ---------------------------------------------------------------------------
// Integrity and unpacking
// ---------------------------------------------------------------------------

/** Whether `data` has the `integrity` (ssri: `<algo>-<base64>`, any of several, space-separated). */
export function integrityMatches(data: Buffer, integrity: string): boolean {
    for (const part of integrity.trim().split(/\s+/)) {
        const m = /^(sha512|sha384|sha256|sha1)-(.+)$/.exec(part);
        if (!m) { continue; }
        if (crypto.createHash(m[1]).update(data).digest('base64') === m[2]) { return true; }
    }
    return false;
}

function cString(buf: Buffer, start: number, length: number): string {
    const end = buf.indexOf(0, start);
    return buf.toString('utf8', start, end < 0 || end > start + length ? start + length : end);
}

function octal(buf: Buffer, start: number, length: number): number {
    const s = cString(buf, start, length).trim();
    return s ? parseInt(s, 8) : 0;
}

/** A pax header's `path=` value, if any. */
function paxPath(data: Buffer): string | undefined {
    let at = 0;
    while (at < data.length) {
        const space = data.indexOf(0x20, at);
        if (space < 0) { break; }
        const len = parseInt(data.toString('utf8', at, space), 10);
        if (!Number.isFinite(len) || len <= 0) { break; }
        const record = data.toString('utf8', space + 1, at + len - 1);
        const eq = record.indexOf('=');
        if (eq > 0 && record.slice(0, eq) === 'path') { return record.slice(eq + 1); }
        at += len;
    }
    return undefined;
}

/**
 * Unpack an npm tarball into `dest`: regular files and folders; the first path
 * component (`package/`) dropped; executable bits kept; links and anything
 * that would land outside `dest` refused. Answers the number of files written.
 */
export function extractTgz(tgz: Buffer, dest: string): number {
    return extractTar(zlib.gunzipSync(tgz), dest);
}

/** Unpack an (already gunzipped) npm tarball into `dest`, as {@link extractTgz}; answers the number of files written. */
export function extractTar(tar: Buffer, dest: string): number {
    const root = path.resolve(dest);
    let files = 0;
    let longName: string | undefined;
    for (let at = 0; at + 512 <= tar.length; ) {
        const header = tar.subarray(at, at + 512);
        if (header.every((b) => b === 0)) { break; }
        const size = octal(header, 124, 12);
        const type = String.fromCharCode(header[156] || 0x30);
        const dataStart = at + 512;
        const data = tar.subarray(dataStart, dataStart + size);
        at = dataStart + Math.ceil(size / 512) * 512;
        if (type === 'x') { longName = paxPath(data) ?? longName; continue; }
        if (type === 'L') { longName = cString(data, 0, data.length); continue; }
        if (type === 'g') { continue; }
        const prefix = cString(header, 345, 155);
        const name = longName ?? (prefix ? `${prefix}/${cString(header, 0, 100)}` : cString(header, 0, 100));
        longName = undefined;
        const rel = name.split('/').slice(1).join('/');
        if (!rel) { continue; }
        const target = path.resolve(root, rel);
        if (target !== root && !target.startsWith(root + path.sep)) {
            throw new Error(`refusing a tarball entry outside the folder: ${name}`);
        }
        if (type === '5') { fs.mkdirSync(target, { recursive: true }); continue; }
        if (type !== '0' && type !== '\0' && type !== '7') { continue; } // links, devices: not in npm packages
        fs.mkdirSync(path.dirname(target), { recursive: true });
        fs.writeFileSync(target, data);
        const mode = octal(header, 100, 8);
        if (process.platform !== 'win32' && (mode & 0o111)) { fs.chmodSync(target, 0o755); }
        files++;
    }
    return files;
}

// ---------------------------------------------------------------------------
// Semver, for updates
// ---------------------------------------------------------------------------

interface SemVer { major: number; minor: number; patch: number; pre: string }

export function parseSemver(v: string): SemVer | null {
    const m = /^v?(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?(?:\+.*)?$/.exec(v.trim());
    return m ? { major: +m[1], minor: +m[2], patch: +m[3], pre: m[4] ?? '' } : null;
}

export function compareSemver(a: string, b: string): number {
    const x = parseSemver(a);
    const y = parseSemver(b);
    if (!x || !y) { return a.localeCompare(b); }
    for (const k of ['major', 'minor', 'patch'] as const) {
        if (x[k] !== y[k]) { return x[k] - y[k]; }
    }
    if (x.pre === y.pre) { return 0; }
    if (!x.pre) { return 1; }
    if (!y.pre) { return -1; }
    return x.pre.localeCompare(y.pre);
}

/** One comparator (`>=1.2.3`, `^1.2.3`, `~1.2`, `1.x`, `*`, `1.2.3`) against a release version. */
function satisfiesOne(version: SemVer, raw: string): boolean {
    const c = raw.trim();
    if (c === '' || c === '*' || c === 'x' || c === 'latest') { return true; }
    const m = /^(\^|~|>=|<=|>|<|=)?\s*v?(\d+|x|\*)(?:\.(\d+|x|\*))?(?:\.(\d+|x|\*))?(?:-([0-9A-Za-z.-]+))?$/.exec(c);
    if (!m) { return false; }
    const op = m[1] ?? '';
    const num = (s: string | undefined): number | null => (s === undefined || s === 'x' || s === '*' ? null : +s);
    const [maj, min, pat] = [num(m[2]), num(m[3]), num(m[4])];
    const v = `${version.major}.${version.minor}.${version.patch}`;
    const base = `${maj ?? 0}.${min ?? 0}.${pat ?? 0}`;
    const cmp = compareSemver(v, base);
    switch (op) {
        case '>=': return cmp >= 0;
        case '>': return cmp > 0;
        case '<=': return cmp <= 0;
        case '<': return cmp < 0;
        case '^': {
            if (cmp < 0 || maj === null) { return cmp >= 0; }
            if (maj > 0) { return version.major === maj; }
            if ((min ?? 0) > 0) { return version.major === 0 && version.minor === min; }
            return version.major === 0 && version.minor === 0 && (pat === null || version.patch === pat);
        }
        case '~': return cmp >= 0 && version.major === maj && (min === null || version.minor === min);
        default:
            if (maj === null) { return true; }
            if (version.major !== maj) { return false; }
            if (min !== null && version.minor !== min) { return false; }
            return pat === null || version.patch === pat;
    }
}

/** Whether `version` satisfies `range` (`||` alternatives of space-separated comparators; prereleases never). */
export function satisfies(version: string, range: string): boolean {
    const v = parseSemver(version);
    if (!v || v.pre) { return false; }
    return range.split('||').some((alt) => {
        const parts = alt.trim().replace(/(>=|<=|>|<|=|\^|~)\s+/g, '$1').split(/\s+/).filter(Boolean);
        if (parts.length === 3 && parts[1] === '-') { return satisfiesOne(v, `>=${parts[0]}`) && satisfiesOne(v, `<=${parts[2]}`); }
        return parts.length === 0 ? true : parts.every((p) => satisfiesOne(v, p));
    });
}

/** The highest of `versions` that satisfies `range`, or undefined. */
export function maxSatisfying(versions: readonly string[], range: string): string | undefined {
    return versions.filter((v) => satisfies(v, range)).sort(compareSemver).pop();
}

// ---------------------------------------------------------------------------
// What is installed
// ---------------------------------------------------------------------------

export interface InstalledProvider {
    /** The root packages' versions: the provider's version. */
    roots: Record<string, string>;
    /** Every package installed, name → version. */
    packages: Record<string, string>;
    installedAt: string;
    /** pinned: the manifest's versions; update: newer ones taken from the registry. */
    source: 'pinned' | 'update';
}

export interface ProviderState {
    formatVersion: 1;
    providers: Record<string, InstalledProvider>;
}

export const PROVIDER_STATE_FILE = 'providers-state.json';

export function emptyProviderState(): ProviderState {
    return { formatVersion: 1, providers: {} };
}

export function readProviderState(root: string): ProviderState {
    try {
        const s = JSON.parse(fs.readFileSync(path.join(root, PROVIDER_STATE_FILE), 'utf8')) as ProviderState;
        return s && s.providers && typeof s.providers === 'object' ? s : emptyProviderState();
    } catch {
        return emptyProviderState();
    }
}

export function writeProviderState(root: string, state: ProviderState): void {
    fs.mkdirSync(root, { recursive: true });
    const file = path.join(root, PROVIDER_STATE_FILE);
    fs.writeFileSync(`${file}.tmp`, `${JSON.stringify(state, null, 2)}\n`);
    fs.renameSync(`${file}.tmp`, file);
}

/** A provider's folder: its packages under `<root>/<id>/node_modules/`. */
export function providerDir(root: string, id: string): string {
    return path.join(root, id);
}

/** Whether `id` is recorded as installed and its folder is there. */
export function isProviderInstalled(root: string, id: string, state: ProviderState = readProviderState(root)): boolean {
    return !!state.providers[id] && fs.existsSync(path.join(providerDir(root, id), 'node_modules'));
}

/** The provider's version for display: its roots' versions (one when they agree). */
export function providerVersionLabel(roots: Record<string, string>): string {
    const versions = Object.entries(roots);
    return versions.map(([name, v]) => `${name.replace(/^@[^/]+\//, '')} ${v}`).join(', ');
}
