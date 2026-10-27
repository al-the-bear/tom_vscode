#!/usr/bin/env node
/**
 * Before the long build: are the bridge's tom_* resolutions current?
 *
 *   node scripts/bridge-lock-preflight.cjs --fix  [bridgeDir]   (from source)
 *   node scripts/bridge-lock-preflight.cjs --warn [bridgeDir]   (prebuilt route)
 *   options: --offline (read only the local pub cache)
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
 * --fix runs `dart pub upgrade <the frozen packages>` in the bridge (the lock
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

function runDartUpgrade(bridgeDir, names) {
    const shell = process.platform === 'win32';
    const r = spawnSync(shell ? '"dart"' : 'dart', ['pub', 'upgrade', ...names], { cwd: bridgeDir, stdio: 'inherit', shell });
    return r.status === 0;
}

async function main(argv) {
    const mode = argv.includes('--fix') ? 'fix' : argv.includes('--warn') ? 'warn' : null;
    const offline = argv.includes('--offline');
    const positional = argv.filter((a) => !a.startsWith('--'));
    const bridgeDir = path.resolve(positional[0] || path.join(__dirname, '..', '..', 'tom_vscode_bridge'));
    if (!mode) {
        console.error('usage: bridge-lock-preflight.cjs --fix|--warn [--offline] [bridgeDir]');
        return 2;
    }
    const lockFile = path.join(bridgeDir, 'pubspec.lock');
    if (!fs.existsSync(lockFile)) {
        console.log('  ✔ tom_vscode_bridge has no pubspec.lock yet: the build resolves it fresh');
        return 0;
    }
    const measured = await measure(fs.readFileSync(lockFile, 'utf8'), { offline });
    const unknown = measured.filter((m) => m.source === 'unknown').map((m) => m.name);
    if (unknown.length) {
        console.log(`  ℹ not measured (pub.dev unreachable, not in the pub cache): ${unknown.join(', ')}`);
    }
    const frozen = frozenOf(measured);
    if (!frozen.length) {
        console.log(`  ✔ the bridge's ${measured.length} tom_* resolutions are current`);
        return 0;
    }
    const names = frozen.map((f) => f.name);
    const command = `cd ${bridgeDir} && dart pub upgrade ${names.join(' ')}`;
    if (mode === 'warn') {
        console.log(`  ⚠️  tom_vscode_bridge's pubspec.lock is behind: ${describe(frozen)}.`);
        console.log(`     Tests of the bridge run against these versions. To move them: ${command}`);
        return 0;
    }
    console.log(`  ⟳ tom_vscode_bridge's pubspec.lock is behind: ${describe(frozen)}. Upgrading them...`);
    if (!runDartUpgrade(bridgeDir, names)) {
        console.error(`  ❌ dart pub upgrade failed in ${bridgeDir}; the bridge would build against the old versions. Run: ${command}`);
        return 1;
    }
    const after = frozenOf(await measure(fs.readFileSync(lockFile, 'utf8'), { offline }));
    if (after.length) {
        console.log(`  ℹ still behind after the upgrade (held by a version constraint): ${describe(after)}`);
    } else {
        console.log('  ✔ the bridge\'s tom_* resolutions are current');
    }
    return 0;
}

module.exports = { parseHostedLock, parseVersion, compareVersions, pubCacheRoot, newestInCacheListing, newestInCache, measure, frozenOf };

if (require.main === module) {
    main(process.argv.slice(2)).then((code) => process.exit(code), (err) => { console.error(err); process.exit(1); });
}
