/**
 * Provider SDKs: the manifest, the rules and the installer
 * (utils/providerSdks.ts, services/providerInstaller.ts,
 * services/providerRuntime.ts, scripts/build-provider-manifest.cjs). The
 * installer runs for real against a local registry (an HTTP server on
 * 127.0.0.1 serving packuments and tarballs the test builds).
 *
 *   PS-1 the committed manifest is what package-lock.json gives (npm run providers:manifest); the Anthropic
 *        provider has both roots, zod beside them, a CLI package per platform (os / cpu, libc on Linux), every
 *        package a registry tarball with a sha512 integrity
 *   PS-2 a host takes the packages without a platform restriction and exactly its own CLI package (glibc or musl)
 *   PS-3 unpacking a tarball: the package/ prefix dropped, folders, a pax long name, the executable bit, an
 *        entry outside the folder refused; the integrity check (sha512, sha1, a mismatch)
 *   PS-4 semver: comparison, the range forms an update meets (^ ~ >= x || -), maxSatisfying, a new major
 *   PS-5 install from the registry: every package of this host unpacked where the manifest says, the record
 *        (roots, packages, versions, pinned); a download not matching its integrity fails and leaves the
 *        installed provider as it was; Check for updates (latest, newer, new major); an update resolves the new
 *        release's dependencies (a pinned version kept where it satisfies, a new one from the registry, this
 *        host's platform package only) and records it; remove deletes the folder and the record
 *   PS-6 loading: the direct SDK (require) and the Agent SDK (a file URL) from the installed provider, its CLI
 *        (source provider); without the provider and without the checkout's own copies (as in a VSIX):
 *        ProviderSdkMissing naming the Provider SDKs page
 *   PS-7 a large download streams: its progress is logged while it runs and it completes; a download that receives
 *        nothing for the stall timeout fails with an error naming the package and how far it got, and leaves no
 *        staging folder and the installed provider as it was (a stuck download no longer waits forever)
 *   PS-8 the extension's download path: tarballs fetched by a child process (providerChildDownload.ts, the
 *        worker run by the Node binary) install as with fetch, with progress; a stalled one is given up after the
 *        stall timeout and its process killed; an HTTP error names the package; no download file is left
 */

/* eslint-disable @typescript-eslint/naming-convention -- package names and registry fields as npm writes them */
import test, { after, before, describe } from 'node:test';
import assert from 'node:assert/strict';
import * as crypto from 'crypto';
import * as fs from 'fs';
import * as http from 'http';
import * as os from 'os';
import * as path from 'path';
import * as zlib from 'zlib';

import {
    compareSemver, extractTgz, integrityMatches, maxSatisfying, packagesForHost, readProviderManifest, readProviderState, satisfies,
    type ProviderManifest, type ProviderPackage,
} from '../providerSdks';
import { isMajorChange, ProviderInstaller } from '../../services/providerInstaller';
import { childProcessDownloader } from '../../services/providerChildDownload';
import * as runtime from '../../services/providerRuntime';
import { locateAgentSdkCli } from '../../services/agentSdkCli';

const EXT = path.resolve(__dirname, '..', '..', '..');
const SANDBOX = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'provider-sdks-')));
after(() => fs.rmSync(SANDBOX, { recursive: true, force: true }));

// ---------------------------------------------------------------------------
// A tarball writer (ustar, with a pax header for a long name)
// ---------------------------------------------------------------------------

interface TarEntry { name: string; data?: string | Buffer; mode?: number; type?: '0' | '5' }

function header(name: string, size: number, mode: number, type: string): Buffer {
    const h = Buffer.alloc(512);
    h.write(name.slice(0, 100), 0, 'utf8');
    h.write(mode.toString(8).padStart(7, '0'), 100);
    h.write('0000000', 108); h.write('0000000', 116);
    h.write(size.toString(8).padStart(11, '0'), 124);
    h.write('00000000000', 136);
    h.write(type, 156);
    h.write('ustar\u000000', 257);
    h.fill(' ', 148, 156);
    let sum = 0;
    for (const b of h) { sum += b; }
    h.write(sum.toString(8).padStart(6, '0') + '\u0000 ', 148);
    return h;
}

function block(data: Buffer): Buffer {
    return Buffer.concat([data, Buffer.alloc((512 - (data.length % 512)) % 512)]);
}

function tgz(entries: TarEntry[]): Buffer {
    const parts: Buffer[] = [];
    for (const e of entries) {
        const data = Buffer.from(e.data ?? '');
        if (e.name.length > 100) {
            const rec = ` path=${e.name}\n`;
            let len = rec.length;
            while (String(len).length + rec.length !== len) { len = String(len).length + rec.length; }
            const pax = Buffer.from(`${len}${rec}`);
            parts.push(header('PaxHeader', pax.length, 0o644, 'x'), block(pax));
        }
        parts.push(header(e.name, e.type === '5' ? 0 : data.length, e.mode ?? 0o644, e.type ?? '0'));
        if (e.type !== '5') { parts.push(block(data)); }
    }
    parts.push(Buffer.alloc(1024));
    return zlib.gzipSync(Buffer.concat(parts));
}

const sha512 = (b: Buffer): string => `sha512-${crypto.createHash('sha512').update(b).digest('base64')}`;

// ---------------------------------------------------------------------------
// A local registry
// ---------------------------------------------------------------------------

/** name → version → { tarball, deps, optionalDeps, os, cpu } */
type RegPkg = { files: TarEntry[]; dependencies?: Record<string, string>; optionalDependencies?: Record<string, string>; os?: string[]; cpu?: string[] };
const registryPackages = new Map<string, Map<string, RegPkg>>();
const latest = new Map<string, string>();
const tarballs = new Map<string, Buffer>();
const corrupt = new Set<string>();
let server: http.Server;
let base = '';

function publish(name: string, version: string, pkg: RegPkg): void {
    if (!registryPackages.has(name)) { registryPackages.set(name, new Map()); }
    registryPackages.get(name)!.set(version, pkg);
    tarballs.set(`/${name}/-/${version}.tgz`, tgz(pkg.files.map((f) => ({ ...f, name: `package/${f.name}` }))));
    if (!latest.has(name) || compareSemver(version, latest.get(name)!) > 0) { latest.set(name, version); }
}

function tarballUrl(name: string, version: string): string { return `${base}/${name}/-/${version}.tgz`; }

function manifestPackage(name: string, version: string, extra: Partial<ProviderPackage> = {}): ProviderPackage {
    const t = tarballs.get(`/${name}/-/${version}.tgz`)!;
    return { name, version, path: `node_modules/${name}`, resolved: tarballUrl(name, version), integrity: sha512(t), ...extra };
}

/** Tarballs served slowly (in parts, a pause between) and ones that stop sending (PS-7). */
const slowTarballs = new Map<string, Buffer>();
const stallingTarballs = new Map<string, Buffer>();
const openResponses = new Set<http.ServerResponse>();

before(async () => {
    server = http.createServer((req, res) => {
        const url = decodeURIComponent(req.url ?? '');
        const slow = slowTarballs.get(url);
        if (slow) {
            res.writeHead(200, { 'content-type': 'application/octet-stream', 'content-length': String(slow.length) });
            const parts = 6;
            const size = Math.ceil(slow.length / parts);
            let i = 0;
            const next = (): void => {
                if (i >= parts) { res.end(); return; }
                res.write(slow.subarray(i * size, (i + 1) * size));
                i++;
                setTimeout(next, 40);
            };
            next();
            return;
        }
        const stalling = stallingTarballs.get(url);
        if (stalling) {
            res.writeHead(200, { 'content-type': 'application/octet-stream', 'content-length': String(stalling.length) });
            res.write(stalling.subarray(0, Math.floor(stalling.length / 3)));
            openResponses.add(res);
            return;
        }
        const t = tarballs.get(url);
        if (t) {
            res.writeHead(200, { 'content-type': 'application/octet-stream' });
            res.end(corrupt.has(url) ? Buffer.concat([t, Buffer.from('x')]) : t);
            return;
        }
        const name = url.slice(1);
        const versions = registryPackages.get(name);
        if (!versions) { res.writeHead(404); res.end(); return; }
        const doc = {
            name,
            'dist-tags': { latest: latest.get(name) },
            versions: Object.fromEntries([...versions].map(([v, p]) => [v, {
                version: v, dependencies: p.dependencies, optionalDependencies: p.optionalDependencies, os: p.os, cpu: p.cpu,
                dist: { tarball: tarballUrl(name, v), integrity: sha512(tarballs.get(`/${name}/-/${v}.tgz`)!) },
            }])),
        };
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify(doc));
    });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
    base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
});
after(() => new Promise<void>((r) => {
    for (const res of openResponses) { res.destroy(); }
    server.closeAllConnections?.();
    server.close(() => r());
}));

// ---------------------------------------------------------------------------

describe('provider SDKs', () => {
    test('PS-1: the committed manifest', () => {
        const m = readProviderManifest(EXT);
        // eslint-disable-next-line @typescript-eslint/no-require-imports
        const builder = require(path.join(EXT, 'scripts', 'build-provider-manifest.cjs')) as { buildManifest(): unknown; render(m: unknown): string; OUT: string };
        if (fs.existsSync(path.join(EXT, 'package-lock.json'))) {
            assert.equal(fs.readFileSync(builder.OUT, 'utf8'), builder.render(builder.buildManifest()), 'run npm run providers:manifest');
        }
        const a = m.providers.find((p) => p.id === 'anthropic')!;
        assert.deepEqual(a.roots, ['@anthropic-ai/sdk', '@anthropic-ai/claude-agent-sdk']);
        assert.deepEqual(a.alsoInstall, ['zod']);
        const names = a.packages.map((p) => p.name);
        for (const n of [...a.roots, 'zod']) { assert.ok(names.includes(n), n); }
        const clis = a.packages.filter((p) => /claude-agent-sdk-/.test(p.name));
        for (const plat of ['darwin-arm64', 'darwin-x64', 'linux-x64', 'linux-x64-musl', 'win32-x64']) {
            assert.ok(clis.some((p) => p.name.endsWith(`-${plat}`)), plat);
        }
        for (const p of clis) {
            assert.ok(p.os && p.cpu, `${p.name}: os and cpu`);
            if (p.os!.includes('linux')) { assert.deepEqual(p.libc, [/-musl$/.test(p.name) ? 'musl' : 'glibc']); }
        }
        for (const p of a.packages) {
            assert.match(p.integrity, /^sha512-/, p.name);
            assert.match(p.resolved, /^https:\/\/registry\.npmjs\.org\//, p.name);
            assert.match(p.path, /^node_modules\//, p.name);
        }
    });

    test('PS-2: what a host takes', () => {
        const a = readProviderManifest(EXT).providers[0];
        const clisFor = (host: Parameters<typeof packagesForHost>[1]): string[] =>
            packagesForHost(a.packages, host).filter((p) => /claude-agent-sdk-/.test(p.name)).map((p) => p.name);
        assert.deepEqual(clisFor({ os: 'darwin', cpu: 'arm64' }), ['@anthropic-ai/claude-agent-sdk-darwin-arm64']);
        assert.deepEqual(clisFor({ os: 'linux', cpu: 'x64', libc: 'glibc' }), ['@anthropic-ai/claude-agent-sdk-linux-x64']);
        assert.deepEqual(clisFor({ os: 'linux', cpu: 'x64', libc: 'musl' }), ['@anthropic-ai/claude-agent-sdk-linux-x64-musl']);
        assert.deepEqual(clisFor({ os: 'win32', cpu: 'x64' }), ['@anthropic-ai/claude-agent-sdk-win32-x64']);
        assert.deepEqual(clisFor({ os: 'freebsd', cpu: 'x64' }), [], 'no CLI for an unknown platform');
        const common = packagesForHost(a.packages, { os: 'darwin', cpu: 'arm64' }).filter((p) => !/claude-agent-sdk-/.test(p.name));
        assert.equal(common.length, a.packages.filter((p) => !p.os && !p.cpu).length, 'every unrestricted package');
    });

    test('PS-3: unpacking and integrity', () => {
        const longName = `package/${'deep/'.repeat(25)}file.txt`;
        const t = tgz([
            { name: 'package/', type: '5' },
            { name: 'package/package.json', data: '{"name":"x"}' },
            { name: 'package/bin/tool', data: '#!/bin/sh\n', mode: 0o755 },
            { name: longName, data: 'long' },
        ]);
        const dest = path.join(SANDBOX, 'unpack');
        assert.equal(extractTgz(t, dest), 3);
        assert.equal(fs.readFileSync(path.join(dest, 'package.json'), 'utf8'), '{"name":"x"}');
        assert.equal(fs.readFileSync(path.join(dest, longName.slice('package/'.length)), 'utf8'), 'long', 'a pax long name');
        if (process.platform !== 'win32') { assert.ok((fs.statSync(path.join(dest, 'bin', 'tool')).mode & 0o111) !== 0, 'executable'); }
        assert.throws(() => extractTgz(tgz([{ name: 'package/../../evil', data: 'x' }]), path.join(SANDBOX, 'evil')), /outside the folder/);
        assert.equal(fs.existsSync(path.join(SANDBOX, 'evil')), false);
        assert.ok(integrityMatches(t, sha512(t)));
        assert.ok(integrityMatches(t, `sha1-${crypto.createHash('sha1').update(t).digest('base64')}`));
        assert.ok(integrityMatches(t, `sha256-bogus ${sha512(t)}`), 'any of several');
        assert.equal(integrityMatches(Buffer.concat([t, Buffer.from('x')]), sha512(t)), false);
    });

    test('PS-4: semver', () => {
        assert.ok(compareSemver('1.10.0', '1.9.9') > 0);
        assert.ok(compareSemver('1.0.0', '1.0.0-rc.1') > 0);
        for (const [v, r, ok] of [
            ['1.2.3', '^1.0.0', true], ['2.0.0', '^1.0.0', false], ['0.3.5', '^0.3.1', true], ['0.4.0', '^0.3.1', false],
            ['1.2.9', '~1.2.3', true], ['1.3.0', '~1.2.3', false], ['5.0.0', '>=4.1', true], ['1.0.0', '1.x', true],
            ['3.25.0', '^3.25.0 || ^4.0.0', true], ['4.4.3', '^3.25.0 || ^4.0.0', true], ['5.0.0', '^3.25.0 || ^4.0.0', false],
            ['1.5.0', '1.2.0 - 1.6.0', true], ['1.0.0-beta', '*', false], ['7.29.2', '>= 7.18.3', true],
        ] as Array<[string, string, boolean]>) {
            assert.equal(satisfies(v, r), ok, `${v} ${r}`);
        }
        assert.equal(maxSatisfying(['1.0.0', '1.4.0', '2.0.0', '1.5.0-rc'], '^1.0.0'), '1.4.0');
        assert.equal(maxSatisfying(['2.0.0'], '^1.0.0'), undefined);
        assert.equal(isMajorChange('0.124.0', '1.6.0'), true);
        assert.equal(isMajorChange('0.3.282', '0.3.319'), false);
        assert.equal(isMajorChange('0.3.282', '0.4.0'), true, 'a 0.x minor');
        assert.equal(isMajorChange('1.2.0', '1.9.0'), false);
    });

    test('PS-5: install, update, remove from a registry', async () => {
        // The provider: two roots, a dependency, a peer beside them, a CLI package per platform.
        publish('@t/sdk', '1.0.0', { files: [{ name: 'package.json', data: '{"name":"@t/sdk","version":"1.0.0","main":"index.js"}' }, { name: 'index.js', data: 'module.exports = { v: "1.0.0" };' }], dependencies: { dep: '^2.0.0' } });
        publish('dep', '2.0.0', { files: [{ name: 'package.json', data: '{"name":"dep","version":"2.0.0"}' }] });
        publish('peer', '4.0.0', { files: [{ name: 'package.json', data: '{"name":"peer","version":"4.0.0"}' }] });
        publish('@t/agent', '0.1.0', { files: [{ name: 'package.json', data: '{"name":"@t/agent","version":"0.1.0"}' }], optionalDependencies: { '@t/agent-darwin-arm64': '0.1.0', '@t/agent-linux-x64': '0.1.0' } });
        publish('@t/agent-darwin-arm64', '0.1.0', { files: [{ name: 'cli', data: 'mac', mode: 0o755 }], os: ['darwin'], cpu: ['arm64'] });
        publish('@t/agent-linux-x64', '0.1.0', { files: [{ name: 'cli', data: 'linux', mode: 0o755 }], os: ['linux'], cpu: ['x64'] });
        const manifest: ProviderManifest = {
            formatVersion: 1,
            registry: base,
            providers: [{
                id: 'test', name: 'Test', description: '', roots: ['@t/sdk', '@t/agent'], alsoInstall: ['peer'],
                packages: [
                    manifestPackage('@t/agent', '0.1.0'),
                    manifestPackage('@t/agent-darwin-arm64', '0.1.0', { os: ['darwin'], cpu: ['arm64'] }),
                    manifestPackage('@t/agent-linux-x64', '0.1.0', { os: ['linux'], cpu: ['x64'], libc: ['glibc'] }),
                    manifestPackage('@t/sdk', '1.0.0'),
                    manifestPackage('dep', '2.0.0'),
                    manifestPackage('peer', '4.0.0'),
                ],
            }],
        };
        const root = path.join(SANDBOX, 'providers');
        const lines: string[] = [];
        const inst = new ProviderInstaller({ root, manifest, host: { os: 'darwin', cpu: 'arm64' }, log: (l) => lines.push(l) });
        const rec = await inst.install('test');
        const nm = path.join(root, 'test', 'node_modules');
        assert.equal(fs.readFileSync(path.join(nm, '@t', 'agent-darwin-arm64', 'cli'), 'utf8'), 'mac');
        assert.equal(fs.existsSync(path.join(nm, '@t', 'agent-linux-x64')), false, 'only this host\'s CLI');
        for (const n of ['@t/sdk', 'dep', 'peer', '@t/agent']) { assert.ok(fs.existsSync(path.join(nm, ...n.split('/'), 'package.json')), n); }
        assert.deepEqual(rec.roots, { '@t/sdk': '1.0.0', '@t/agent': '0.1.0' });
        assert.equal(rec.source, 'pinned');
        const state = readProviderState(root);
        assert.deepEqual(state.providers.test.packages, { '@t/agent': '0.1.0', '@t/agent-darwin-arm64': '0.1.0', '@t/sdk': '1.0.0', dep: '2.0.0', peer: '4.0.0' });
        assert.ok(lines.some((l) => /Test installed \(5 packages\)/.test(l)));

        // A download that does not match its integrity: nothing changes.
        corrupt.add('/dep/-/2.0.0.tgz');
        await assert.rejects(inst.install('test'), /dep@2\.0\.0: the download does not match its integrity/);
        corrupt.clear();
        assert.ok(fs.existsSync(path.join(nm, '@t', 'sdk', 'index.js')), 'the installed provider stays');
        assert.equal(fs.existsSync(path.join(root, 'test.staging')), false, 'no staging folder left');
        assert.deepEqual(readProviderState(root).providers.test.roots, rec.roots);

        // Newer releases: the SDK keeps its major and needs a newer dependency; the agent goes to a new 0.x minor.
        publish('dep', '2.1.0', { files: [{ name: 'package.json', data: '{"name":"dep","version":"2.1.0"}' }] });
        publish('@t/sdk', '1.1.0', { files: [{ name: 'package.json', data: '{"name":"@t/sdk","version":"1.1.0","main":"index.js"}' }, { name: 'index.js', data: 'module.exports = { v: "1.1.0" };' }], dependencies: { dep: '^2.1.0', extra: '^1.0.0' } });
        publish('extra', '1.0.0', { files: [{ name: 'package.json', data: '{"name":"extra"}' }] });
        publish('@t/agent', '0.2.0', { files: [{ name: 'package.json', data: '{"name":"@t/agent","version":"0.2.0"}' }], optionalDependencies: { '@t/agent-darwin-arm64': '0.2.0', '@t/agent-linux-x64': '0.2.0' } });
        publish('@t/agent-darwin-arm64', '0.2.0', { files: [{ name: 'cli', data: 'mac2', mode: 0o755 }], os: ['darwin'], cpu: ['arm64'] });
        publish('@t/agent-linux-x64', '0.2.0', { files: [{ name: 'cli', data: 'linux2', mode: 0o755 }], os: ['linux'], cpu: ['x64'] });
        const updates = await inst.checkUpdates();
        assert.equal(updates.length, 1);
        assert.equal(updates[0].updateAvailable, true);
        assert.equal(updates[0].majorChange, true, '0.1 → 0.2 is a new major for 0.x');
        assert.deepEqual(updates[0].roots.map((r) => [r.name, r.installed, r.latest, r.newer, r.major]), [
            ['@t/sdk', '1.0.0', '1.1.0', true, false], ['@t/agent', '0.1.0', '0.2.0', true, true],
        ]);
        assert.equal(updates[0].latestLabel, 'sdk 1.1.0, agent 0.2.0');
        const resolved = await inst.resolveLatest('test');
        assert.deepEqual(resolved.map((p) => `${p.path}@${p.version}`), [
            'node_modules/@t/agent@0.2.0', 'node_modules/@t/agent-darwin-arm64@0.2.0', 'node_modules/@t/sdk@1.1.0',
            'node_modules/dep@2.1.0', 'node_modules/extra@1.0.0', 'node_modules/peer@4.0.0',
        ]);
        const upd = await inst.update('test');
        assert.equal(upd.source, 'update');
        assert.deepEqual(upd.roots, { '@t/sdk': '1.1.0', '@t/agent': '0.2.0' });
        assert.equal(fs.readFileSync(path.join(nm, '@t', 'agent-darwin-arm64', 'cli'), 'utf8'), 'mac2');
        // eslint-disable-next-line @typescript-eslint/no-require-imports
        assert.equal(require(path.join(nm, '@t', 'sdk', 'index.js')).v, '1.1.0');
        assert.equal((await inst.checkUpdates())[0].updateAvailable, false, 'up to date');
        // A pinned version kept where it satisfies the range.
        publish('@t/sdk', '1.2.0', { files: [{ name: 'package.json', data: '{"name":"@t/sdk","version":"1.2.0"}' }], dependencies: { dep: '^2.0.0' } });
        assert.ok((await inst.resolveLatest('test')).some((p) => p.name === 'dep' && p.version === '2.0.0'), 'the pinned dep still satisfies ^2.0.0');

        inst.remove('test');
        assert.equal(fs.existsSync(path.join(root, 'test')), false);
        assert.deepEqual(readProviderState(root).providers, {});
    });

    test('PS-7: a large download streams, a stuck one is given up', async () => {
        // A tarball big enough to report progress: random (incompressible) bytes in a file.
        const big = tgz([{ name: 'package/package.json', data: '{"name":"@t/big","version":"1.0.0"}' }, { name: 'package/blob.bin', data: crypto.randomBytes(2 * 1024 * 1024).toString('base64') }]);
        slowTarballs.set('/@t/big/-/1.0.0.tgz', big);
        stallingTarballs.set('/@t/stuck/-/1.0.0.tgz', big);
        const pkg = (name: string): ProviderPackage => ({ name, version: '1.0.0', path: `node_modules/${name}`, resolved: `${base}/${name}/-/1.0.0.tgz`, integrity: sha512(big) });
        const manifest = (name: string): ProviderManifest => ({ formatVersion: 1, registry: base, providers: [{ id: 'big', name: 'Big', description: '', roots: [name], alsoInstall: [], packages: [pkg(name)] }] });
        const root = path.join(SANDBOX, 'providers-big');
        const lines: string[] = [];
        const inst = new ProviderInstaller({ root, manifest: manifest('@t/big'), host: { os: 'darwin', cpu: 'arm64' }, log: (l) => lines.push(l), progressIntervalMs: 30, stallTimeoutMs: 2000 });
        await inst.install('big');
        assert.ok(fs.existsSync(path.join(root, 'big', 'node_modules', '@t', 'big', 'blob.bin')), 'installed');
        assert.ok(lines.some((l) => /^ {3}… \d+\.\d of \d+\.\d MB$/.test(l)), `progress logged: ${lines.join(' | ')}`);
        // Stuck: no data after a third — given up after the stall timeout, the installed provider kept.
        const stuck = new ProviderInstaller({ root, manifest: manifest('@t/stuck'), host: { os: 'darwin', cpu: 'arm64' }, stallTimeoutMs: 300 });
        await assert.rejects(stuck.install('big'), /downloading @t\/stuck@1\.0\.0 \(.*\) stopped: nothing received for 0 s after \d+\.\d MB — check the network/);
        assert.equal(fs.existsSync(path.join(root, 'big.staging')), false, 'no staging folder left');
        assert.ok(fs.existsSync(path.join(root, 'big', 'node_modules', '@t', 'big')), 'the installed provider as it was');
    });

    test('PS-8: tarballs downloaded by a child process', async () => {
        const worker = path.join(__dirname, '..', '..', 'services', 'providerDownloadWorker.js');
        assert.ok(fs.existsSync(worker), `compiled worker at ${worker}`);
        const downloadFile = childProcessDownloader(process.execPath, worker);
        const big = tgz([{ name: 'package/package.json', data: '{"name":"@t/kid","version":"1.0.0"}' }, { name: 'package/blob.bin', data: crypto.randomBytes(2 * 1024 * 1024).toString('base64') }]);
        slowTarballs.set('/@t/kid/-/1.0.0.tgz', big);
        stallingTarballs.set('/@t/kidstuck/-/1.0.0.tgz', big);
        const pkg = (name: string): ProviderPackage => ({ name, version: '1.0.0', path: `node_modules/${name}`, resolved: `${base}/${name}/-/1.0.0.tgz`, integrity: sha512(big) });
        const manifest = (name: string): ProviderManifest => ({ formatVersion: 1, registry: base, providers: [{ id: 'kid', name: 'Kid', description: '', roots: [name], alsoInstall: [], packages: [pkg(name)] }] });
        const root = path.join(SANDBOX, 'providers-child');
        const lines: string[] = [];
        const inst = new ProviderInstaller({ root, manifest: manifest('@t/kid'), host: { os: 'darwin', cpu: 'arm64' }, log: (l) => lines.push(l), progressIntervalMs: 0, stallTimeoutMs: 5000, downloadFile });
        await inst.install('kid');
        assert.ok(fs.existsSync(path.join(root, 'kid', 'node_modules', '@t', 'kid', 'blob.bin')), 'installed');
        assert.ok(lines.some((l) => /^ {3}… \d+\.\d of \d+\.\d MB$/.test(l)), `progress logged: ${lines.join(' | ')}`);
        assert.deepEqual(fs.readdirSync(path.join(root, '.downloads')), [], 'no download file left');
        // Stalled: given up after the stall timeout; the installed provider stays.
        const stuck = new ProviderInstaller({ root, manifest: manifest('@t/kidstuck'), host: { os: 'darwin', cpu: 'arm64' }, stallTimeoutMs: 1500, downloadFile });
        await assert.rejects(stuck.install('kid'), /downloading @t\/kidstuck@1\.0\.0 \(.*\) stopped: nothing received for 2 s after \d+\.\d MB/);
        assert.ok(fs.existsSync(path.join(root, 'kid', 'node_modules', '@t', 'kid')), 'the installed provider as it was');
        // An HTTP error names the package.
        const missing = new ProviderInstaller({ root, manifest: manifest('@t/nowhere'), host: { os: 'darwin', cpu: 'arm64' }, downloadFile });
        await assert.rejects(missing.install('kid'), /downloading @t\/nowhere@1\.0\.0 \(.*\) failed: HTTP 404/);
        assert.deepEqual(fs.readdirSync(path.join(root, '.downloads')), [], 'no download file left after failures');
    });

    test('PS-6: loading from the installed provider', async () => {
        const root = path.join(SANDBOX, 'runtime');
        const nm = path.join(root, 'anthropic', 'node_modules', '@anthropic-ai');
        fs.mkdirSync(path.join(nm, 'sdk'), { recursive: true });
        fs.writeFileSync(path.join(nm, 'sdk', 'package.json'), '{"name":"@anthropic-ai/sdk","main":"index.js"}');
        fs.writeFileSync(path.join(nm, 'sdk', 'index.js'), 'class Anthropic { constructor(o) { this.o = o; } } module.exports = Anthropic; module.exports.default = Anthropic; module.exports.fromProvider = true;');
        fs.mkdirSync(path.join(nm, 'claude-agent-sdk'), { recursive: true });
        fs.writeFileSync(path.join(nm, 'claude-agent-sdk', 'package.json'), '{"name":"@anthropic-ai/claude-agent-sdk","type":"module","exports":{".":{"types":"./sdk.d.ts","default":"./sdk.mjs"}}}');
        fs.writeFileSync(path.join(nm, 'claude-agent-sdk', 'sdk.mjs'), 'export const query = () => "provider";');
        const cliPkg = path.join(nm, `claude-agent-sdk-${process.platform}-${process.arch}`);
        fs.mkdirSync(cliPkg, { recursive: true });
        fs.writeFileSync(path.join(cliPkg, process.platform === 'win32' ? 'claude.exe' : 'claude'), '');
        fs.writeFileSync(path.join(cliPkg, 'package.json'), `{"name":"@anthropic-ai/claude-agent-sdk-${process.platform}-${process.arch}"}`);
        fs.writeFileSync(path.join(root, 'providers-state.json'), JSON.stringify({ formatVersion: 1, providers: { anthropic: { roots: {}, packages: {}, installedAt: '', source: 'pinned' } } }));
        const before = runtime.getProviderRoot();
        try {
            runtime.setProviderRoot(root);
            assert.deepEqual(runtime.installedProviders(), ['anthropic']);
            assert.equal((runtime.loadDirectAnthropicSdk() as { fromProvider?: boolean }).fromProvider, true, 'the direct SDK from the provider');
            const spec = runtime.agentSdkImportSpecifier();
            assert.match(spec, /^file:.*\/anthropic\/node_modules\/@anthropic-ai\/claude-agent-sdk\/sdk\.mjs$/);
            const mod = await (new Function('m', 'return import(m)') as (m: string) => Promise<{ query(): string }>)(spec);
            assert.equal(mod.query(), 'provider');
            const cli = locateAgentSdkCli();
            assert.equal(cli?.source, 'provider');
            assert.ok(cli!.path.startsWith(root));
            // Not installed, and no checkout copies (as in a VSIX).
            process.env.TOM_PROVIDER_SDKS_NO_DEV_FALLBACK = '1';
            runtime.setProviderRoot(path.join(SANDBOX, 'empty'));
            assert.deepEqual(runtime.installedProviders(), []);
            assert.throws(() => runtime.loadDirectAnthropicSdk(), (e: unknown) => e instanceof runtime.ProviderSdkMissing
                && /@anthropic-ai\/sdk SDK is not installed\. Install the Anthropic provider on the Provider SDKs page \(Status Page → Provider SDKs, or command tomAi\.providerSdks\)/.test((e as Error).message));
            assert.throws(() => runtime.agentSdkImportSpecifier(), runtime.ProviderSdkMissing);
            assert.equal(runtime.agentSdkAvailable(), false);
            assert.equal(locateAgentSdkCli(), null);
            // A development checkout: its own devDependencies stand in.
            delete process.env.TOM_PROVIDER_SDKS_NO_DEV_FALLBACK;
            assert.equal(runtime.agentSdkImportSpecifier(), '@anthropic-ai/claude-agent-sdk');
            assert.equal(typeof runtime.loadDirectAnthropicSdk(), 'function');
        } finally {
            delete process.env.TOM_PROVIDER_SDKS_NO_DEV_FALLBACK;
            runtime.setProviderRoot(before);
        }
    });
});
