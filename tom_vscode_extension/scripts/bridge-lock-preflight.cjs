#!/usr/bin/env node
/**
 * Before the long build: are the tom_* resolutions of the build's locks current?
 *
 *   node scripts/bridge-lock-preflight.cjs --fix  [packageDir]   (from source)
 *   node scripts/bridge-lock-preflight.cjs --warn [packageDir]   (prebuilt route)
 *   options: --offline (read only the local pub cache)
 *   Without packageDir: tom_vscode_bridge's lock and, when the checkout is
 *   there, tom_d4rt_generator's — the build runs the generator with its own.
 *
 * Why: `dart pub get` keeps a pubspec.lock as it is. tom_vscode_bridge's lock
 * is gitignored and per machine, so on a host that last resolved it months ago
 * it can hold a tom_* package that satisfies every declared lower bound and
 * still lacks an API the regenerated bridges call. That surfaced only when
 * `dart compile exe` failed, after the whole install had run (legiondary01,
 * tom_d4rt 1.224.0 locked, 1.225.0 needed).
 *
 * A hosted tom_* package is FROZEN when its locked version is older than the
 * newest release: pub.dev's `latest` (PUB_HOSTED_URL when set), or, when
 * pub.dev cannot be reached, the newest version in the local pub cache — which
 * under-reports on a cold cache, so every offline answer is a floor.
 *
 * --fix runs `dart pub upgrade` in the bridge — the whole lock, since a tom_*
 *       package can be held by what the bridge's own dev dependencies pin (the lock
 *       is machine-local; the from-source build uses the newest sources anyway)
 *       and names what is still behind afterwards — a constraint can cap a
 *       package legitimately, so that is reported, not fatal. Exit 1 only when
 *       the upgrade itself fails.
 * --warn names the frozen packages and the command, and exits 0.
 *
 * No pubspec.lock yet: nothing to check, the build resolves fresh.
 * Runs before `npm install`, so it uses Node's standard library only.
 */
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const https = require('https');
const http = require('http');
const { spawnSync } = require('child_process');

/** The packages this preflight looks at. */
const TOM_PACKAGE = /^tom_/;

/**
 * The hosted packages of a pubspec.lock: `[{name, version}]`. A small reader
 * of the shape pub writes (two-space package keys under `packages:`, four-space
 * fields), so it needs no YAML library.
 */
function parseHostedLock(text) {
    const out = [];
    let inPackages = false;
    let current = null;
    const flush = () => { if (current && current.source === 'hosted' && current.version) { out.push({ name: current.name, version: current.version }); } };
    for (const raw of text.split(/\r?\n/)) {
        if (/^\S/.test(raw)) { flush(); current = null; inPackages = raw.startsWith('packages:'); continue; }
        if (!inPackages) { continue; }
        const pkg = /^ {2}([A-Za-z0-9_]+):\s*$/.exec(raw);
        if (pkg) { flush(); current = { name: pkg[1] }; continue; }
        const field = /^ {4}(source|version):\s*"?([^"\s]+)"?\s*$/.exec(raw);
        if (field && current) { current[field[1]] = field[2]; }
    }
    flush();
    return out;
}

/** `[major, minor, patch, pre]` of a version, or null when it is none. */
function parseVersion(v) {
    const m = /^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$/.exec(String(v).trim());
    return m ? [Number(m[1]), Number(m[2]), Number(m[3]), m[4] || ''] : null;
}

/** Semver order; a pre-release sorts before its release. Unparseable versions compare equal. */
function compareVersions(a, b) {
    const x = parseVersion(a);
    const y = parseVersion(b);
    if (!x || !y) { return 0; }
    for (let i = 0; i < 3; i++) { if (x[i] !== y[i]) { return x[i] - y[i]; } }
    if (x[3] === y[3]) { return 0; }
    if (!x[3]) { return 1; }
    if (!y[3]) { return -1; }
    return x[3] < y[3] ? -1 : 1;
}

/** The pub cache root: PUB_CACHE, else the platform default. */
function pubCacheRoot(env = process.env, platform = process.platform) {
    if (env.PUB_CACHE) { return env.PUB_CACHE; }
    if (platform === 'win32') { return path.join(env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local'), 'Pub', 'Cache'); }
    return path.join(os.homedir(), '.pub-cache');
}

/** The newest release (no pre-release) of `name` among the cache's `<name>-<version>` folders. */
function newestInCacheListing(name, entries) {
    let best = null;
    for (const e of entries) {
        if (!e.startsWith(name + '-')) { continue; }
        const v = e.slice(name.length + 1);
        const p = parseVersion(v);
        if (!p || p[3]) { continue; }
        if (!best || compareVersions(v, best) > 0) { best = v; }
    }
    return best;
}

function newestInCache(name, cacheRoot) {
    try { return newestInCacheListing(name, fs.readdirSync(path.join(cacheRoot, 'hosted', 'pub.dev'))); } catch { return null; }
}

/** pub.dev's latest version of `name`, or null when it cannot be had in `timeoutMs`. */
function latestFromPubDev(name, timeoutMs = 5000, env = process.env) {
    const base = (env.PUB_HOSTED_URL || 'https://pub.dev').replace(/\/+$/, '');
    const url = `${base}/api/packages/${encodeURIComponent(name)}`;
    const client = url.startsWith('http:') ? http : https;
    return new Promise((resolve) => {
        const req = client.get(url, { headers: { Accept: 'application/vnd.pub.v2+json' }, timeout: timeoutMs }, (res) => {
            if (res.statusCode !== 200) { res.resume(); resolve(null); return; }
            let body = '';
            res.setEncoding('utf8');
            res.on('data', (c) => { body += c; });
            res.on('end', () => { try { resolve(JSON.parse(body)?.latest?.version ?? null); } catch { resolve(null); } });
        });
        req.on('timeout', () => { req.destroy(); resolve(null); });
        req.on('error', () => resolve(null));
    });
}

/**
 * The tom_* packages of a lock and the newest version of each: from pub.dev
 * unless `offline`, from the cache when pub.dev gives no answer.
 * @returns {Promise<Array<{name, locked, newest, source}>>} source: 'pub.dev' | 'pub cache' | 'unknown'
 */
async function measure(lockText, opts = {}) {
    const cacheRoot = opts.cacheRoot || pubCacheRoot();
    const lookupOnline = opts.latest || ((n) => latestFromPubDev(n));
    const tom = parseHostedLock(lockText).filter((p) => TOM_PACKAGE.test(p.name));
    return Promise.all(tom.map(async (p) => {
        const online = opts.offline ? null : await lookupOnline(p.name);
        if (online) { return { name: p.name, locked: p.version, newest: online, source: 'pub.dev' }; }
        const cached = newestInCache(p.name, cacheRoot);
        return { name: p.name, locked: p.version, newest: cached, source: cached ? 'pub cache' : 'unknown' };
    }));
}

/** The measured packages whose lock is older than the newest release. */
function frozenOf(measured) {
    return measured.filter((m) => m.newest && compareVersions(m.locked, m.newest) < 0);
}

function describe(frozen) {
    return frozen.map((f) => `${f.name} ${f.locked} (newest ${f.newest}, ${f.source})`).join(', ');
}

/**
 * The `dart` arguments that move the frozen packages: the whole lock. Naming
 * them is not enough, not even with `--unlock-transitive`: tom_d4rt_generator
 * 1.53.0 needs analyzer 14, and the bridge's own build_runner and test held
 * analyzer 10 in the lock, so the generator stayed at 1.52.0 — reported as
 * "held by a version constraint" when no constraint held it. The lock is
 * machine-local, and the from-source build takes the newest sources anyway.
 */
function upgradeArgs() {
    return ['pub', 'upgrade'];
}

function runDartUpgrade(bridgeDir) {
    const shell = process.platform === 'win32';
    const r = spawnSync(shell ? '"dart"' : 'dart', upgradeArgs(), { cwd: bridgeDir, stdio: 'inherit', shell });
    return r.status === 0;
}

/**
 * The locks the from-source build uses: the bridge's, and the d4rt
 * generator checkout's — the build runs the generator from its source with
 * that checkout's lock (`dart --packages=<generator>/.dart_tool/...`), so a
 * tom_* package frozen there (tom_analyzer_shared, say) is what generates the
 * bridges. `extensionDir` is this extension's folder.
 */
function defaultDirs(extensionDir) {
    const bridge = path.resolve(extensionDir, '..', 'tom_vscode_bridge');
    const generator = path.resolve(extensionDir, '..', '..', 'd4rt', 'tom_d4rt_generator');
    return fs.existsSync(generator) ? [bridge, generator] : [bridge];
}

/** Check (and with `fix` upgrade) one package's lock; the exit code. */
async function checkLock(dir, mode, offline) {
    const name = path.basename(dir);
    const lockFile = path.join(dir, 'pubspec.lock');
    if (!fs.existsSync(lockFile)) {
        console.log(`  ✔ ${name} has no pubspec.lock yet: the build resolves it fresh`);
        return 0;
    }
    const measured = await measure(fs.readFileSync(lockFile, 'utf8'), { offline });
    const unknown = measured.filter((m) => m.source === 'unknown').map((m) => m.name);
    if (unknown.length) {
        console.log(`  ℹ ${name}, not measured (pub.dev unreachable, not in the pub cache): ${unknown.join(', ')}`);
    }
    const frozen = frozenOf(measured);
    if (!frozen.length) {
        console.log(`  ✔ ${name}: its ${measured.length} tom_* resolutions are current`);
        return 0;
    }
    const command = `cd ${dir} && dart ${upgradeArgs().join(' ')}`;
    if (mode === 'warn') {
        console.log(`  ⚠️  ${name}'s pubspec.lock is behind: ${describe(frozen)}.`);
        console.log(`     The build and its tests run against these versions. To move them: ${command}`);
        return 0;
    }
    console.log(`  ⟳ ${name}'s pubspec.lock is behind: ${describe(frozen)}. Upgrading the lock...`);
    if (!runDartUpgrade(dir)) {
        console.error(`  ❌ dart pub upgrade failed in ${dir}; the build would use the old versions. Run: ${command}`);
        return 1;
    }
    const after = frozenOf(await measure(fs.readFileSync(lockFile, 'utf8'), { offline }));
    if (after.length) {
        console.log(`  ℹ ${name}, still behind after the upgrade (held by a version constraint): ${describe(after)}`);
    } else {
        console.log(`  ✔ ${name}: its tom_* resolutions are current`);
    }
    return 0;
}

async function main(argv) {
    const mode = argv.includes('--fix') ? 'fix' : argv.includes('--warn') ? 'warn' : null;
    const offline = argv.includes('--offline');
    const positional = argv.filter((a) => !a.startsWith('--'));
    if (!mode) {
        console.error('usage: bridge-lock-preflight.cjs --fix|--warn [--offline] [packageDir]');
        return 2;
    }
    const dirs = positional.length ? [path.resolve(positional[0])] : defaultDirs(path.join(__dirname, '..'));
    let code = 0;
    for (const dir of dirs) {
        code = Math.max(code, await checkLock(dir, mode, offline));
    }
    return code;
}

module.exports = { parseHostedLock, parseVersion, compareVersions, pubCacheRoot, newestInCacheListing, newestInCache, measure, frozenOf, upgradeArgs, defaultDirs };

if (require.main === module) {
    main(process.argv.slice(2)).then((code) => process.exit(code), (err) => { console.error(err); process.exit(1); });
}
