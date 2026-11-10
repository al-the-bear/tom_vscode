#!/usr/bin/env node
/**
 * Build tom_bs and the clitool binaries (validate_codespecs, spec_checks) on every fleet build host, each into the
 * binaries layer (create_fleetcompiled_vsix.sh / .ps1).
 *
 *   node scripts/fleet-binaries.cjs [--dry-run] [--hosts mbp,bigbeast,...]
 *   node scripts/fleet-binaries.cjs --print-platforms   (FLEET_PLATFORMS, comma-separated)
 *
 * The hosts are the `build: true` entries of the `fleet_hosts:` registry in
 * al_the_bear/repo_structure.md § 2.2 (found by walking up from this
 * extension; TOM_FLEET_REGISTRY names another file) — one per platform:
 * darwin-arm64 (mbp), linux-x64 (bigbeast), win32-x64 (legiondary01).
 *
 * 1. Preflight, read only: each host is reached (SSH as the registry says;
 *    Windows through Git Bash) and its checkouts the binaries are built from
 *    (tom_ai/vscode, tom_ai/d4rt, tom_ai/ai_build) must be at the commits this
 *    host is at. A host that is not is named, and nothing is built: bringing
 *    the fleet level is a reconcile, which the user starts. --dry-run stops
 *    here.
 * 2. Build, this host first, then the others in registry order: each runs its
 *    own compile_and_install (.sh, or .ps1 on Windows) --binaries-only with
 *    TOM_LAYER_FF=1 — it builds the two binaries, fast-forwards its binaries
 *    layer (only the layer, and only when it has no commits of its own),
 *    commits its platform's binaries and pushes, so each host's commit
 *    follows the one before. Linux hosts build at nice 10 (bigbeast also
 *    serves the websites and the VPN).
 * 3. Fast-forward this host's binaries layer, so it holds every host's
 *    binaries for the packaging that follows.
 *
 * Exit codes: 0 done (or the dry run passed), 1 a host failed or is not level,
 * 2 bad usage or no registry.
 */
'use strict';
/* eslint-disable @typescript-eslint/naming-convention -- exported constants and environment variables keep their names */

const fs = require('fs');
const path = require('path');
const { spawnSync, execFileSync } = require('child_process');

const EXT_ROOT = path.resolve(__dirname, '..');
const WORKSPACE_ROOT = path.resolve(EXT_ROOT, '..', '..', '..');
/** The checkouts the two binaries are built from, relative to the workspace. */
const SOURCE_REPOS = ['tom_ai/vscode', 'tom_ai/d4rt', 'tom_ai/ai_build'];
const WIN_BASH = 'C:\\Program Files\\Git\\bin\\bash.exe';
const SSH_OPTS = ['-o', 'BatchMode=yes', '-o', 'ConnectTimeout=10'];
/** The platforms of the fleet's build hosts: what a fleet-compiled VSIX carries binaries for (the binaries layer's default set). */
const FLEET_PLATFORMS = require('./binaries-layer.cjs').DEFAULT_PLATFORMS;

/** The `fleet_hosts:` entries of repo_structure.md: [{id, ssh, root, shell, build}]. */
function parseRegistry(text) {
    const start = text.indexOf('\nfleet_hosts:');
    if (start < 0) { return []; }
    const hosts = [];
    let cur = null;
    for (const line of text.slice(start + 1).split(/\r?\n/).slice(1)) {
        if (/^\S/.test(line) || /^```/.test(line)) { break; }
        const item = /^\s*-\s+id:\s*(\S+)/.exec(line);
        if (item) { cur = { id: item[1], build: false }; hosts.push(cur); continue; }
        const kv = /^\s+(\w+):\s*([^#]*?)\s*(?:#.*)?$/.exec(line);
        if (cur && kv) { cur[kv[1]] = kv[1] === 'build' || kv[1] === 'ai' ? kv[2] === 'true' : kv[2]; }
    }
    return hosts;
}

/** VS Code's platform name from `uname -s` / `uname -m` (Git Bash on Windows says MINGW64_NT-…). */
function platformFromUname(sys, machine) {
    const os = /^Darwin/.test(sys) ? 'darwin' : /^Linux/.test(sys) ? 'linux' : /^(MINGW|MSYS|CYGWIN)/.test(sys) ? 'win32' : null;
    const arch = /^(x86_64|amd64)$/.test(machine) ? 'x64' : /^(arm64|aarch64)$/.test(machine) ? 'arm64' : null;
    return os && arch ? `${os}-${arch}` : null;
}

/** `/c/Code/x` → `C:\Code\x` (the registry gives Git Bash paths for Windows hosts). */
function windowsPath(posix) {
    const m = /^\/([a-zA-Z])\/(.*)$/.exec(posix);
    return m ? `${m[1].toUpperCase()}:\\${m[2].split('/').join('\\')}` : posix.split('/').join('\\');
}

/** The probe each host runs: platform, the source checkouts' HEADs, a Dart SDK (find-dart.cjs, as the build looks for it) and Node. No `$` (PowerShell would expand it). */
function probeScript(workspace) {
    const heads = SOURCE_REPOS.map((r) => `git -C ${r} rev-parse HEAD 2>/dev/null || echo none`).join('; ');
    return `cd ${workspace} && uname -s; uname -m; ${heads}; node tom_ai/vscode/tom_vscode_extension/scripts/find-dart.cjs >/dev/null 2>&1 && echo dart || echo nodart; command -v node >/dev/null && echo node || echo nonode`;
}

/** The SSH remote command running `bashScript` on the host (Git Bash on Windows, under its PowerShell). */
function remoteBash(host, bashScript) {
    if (host.shell === 'gitbash') { return `& "${WIN_BASH}" -lc "${bashScript}"`; }
    return `bash -lc '${bashScript}'`;
}

/** The SSH remote command of the binaries-only build on the host. */
function remoteBuild(host, rel) {
    if (host.shell === 'gitbash') {
        const script = `${windowsPath(host.root)}\\${rel.split('/').join('\\')}\\tom_ai\\vscode\\tom_vscode_extension\\compile_and_install.ps1`;
        return `$env:TOM_LAYER_FF='1'; powershell -NoProfile -ExecutionPolicy Bypass -File "${script}" -BinariesOnly; exit $LASTEXITCODE`;
    }
    return `bash -lc 'cd ${host.root}/${rel}/tom_ai/vscode/tom_vscode_extension && TOM_LAYER_FF=1 nice -n 10 ./compile_and_install.sh --binaries-only'`;
}

function parseProbe(stdout) {
    const lines = stdout.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
    if (lines.length < 4 + SOURCE_REPOS.length) { return null; }
    const tail = lines.slice(-(4 + SOURCE_REPOS.length));
    const heads = {};
    SOURCE_REPOS.forEach((r, i) => { heads[r] = tail[2 + i]; });
    return {
        platform: platformFromUname(tail[0], tail[1]),
        heads,
        dart: tail[2 + SOURCE_REPOS.length] === 'dart',
        node: tail[3 + SOURCE_REPOS.length] === 'node',
    };
}

/** The repos whose HEAD differs from `local`'s, as `repo (host abc1234, here def5678)`. */
function levelDiffs(remote, local) {
    return SOURCE_REPOS.filter((r) => remote.heads[r] !== local.heads[r])
        .map((r) => `${r} (${String(remote.heads[r]).slice(0, 7)}, here ${String(local.heads[r]).slice(0, 7)})`);
}

function findRegistry() {
    if (process.env.TOM_FLEET_REGISTRY) { return path.resolve(process.env.TOM_FLEET_REGISTRY); }
    for (let dir = WORKSPACE_ROOT; ; dir = path.dirname(dir)) {
        const f = path.join(dir, 'repo_structure.md');
        if (fs.existsSync(f) && fs.readFileSync(f, 'utf8').includes('\nfleet_hosts:')) { return f; }
        if (path.dirname(dir) === dir) { return null; }
    }
}

function localProbe() {
    const r = spawnSync(process.platform === 'win32' ? WIN_BASH : 'bash', ['-c', probeScript(`'${WORKSPACE_ROOT}'`)], { encoding: 'utf8' });
    return parseProbe(r.stdout || '');
}

function sshProbe(host, rel) {
    const workspace = `${host.root}/${rel}`;
    const r = spawnSync('ssh', [...SSH_OPTS, host.ssh, remoteBash(host, probeScript(workspace))], { encoding: 'utf8', timeout: 60000 });
    if (r.status !== 0 && !r.stdout) { return { error: (r.stderr || r.error?.message || 'no answer').trim().split('\n').slice(-1)[0] }; }
    return parseProbe(r.stdout || '') || { error: 'unreadable probe answer' };
}

function main(argv) {
    if (argv.includes('--print-platforms')) { console.log(FLEET_PLATFORMS.join(',')); return 0; }
    const dryRun = argv.includes('--dry-run');
    const hi = argv.indexOf('--hosts');
    const only = hi >= 0 ? String(argv[hi + 1] || '').split(',').filter(Boolean) : null;
    const registry = findRegistry();
    if (!registry) { console.error('❌ No fleet_hosts registry (al_the_bear/repo_structure.md) above this workspace.'); return 2; }
    const root = path.dirname(registry);
    const rel = path.relative(fs.realpathSync(root), fs.realpathSync(WORKSPACE_ROOT)).split(path.sep).join('/');
    let hosts = parseRegistry(fs.readFileSync(registry, 'utf8')).filter((h) => h.build);
    const unknown = only ? only.filter((id) => !hosts.some((h) => h.id === id)) : [];
    if (unknown.length) { console.error(`❌ Not a build host in the registry: ${unknown.join(', ')}`); return 2; }
    if (only) { hosts = hosts.filter((h) => only.includes(h.id)); }
    const here = hosts.find((h) => fs.existsSync(h.root) && fs.realpathSync(h.root) === fs.realpathSync(root));

    console.log(`Fleet build hosts (${registry}): ${hosts.map((h) => h.id).join(', ')}`);
    const local = localProbe();
    if (!local) { console.error('❌ Could not read this host\'s checkouts.'); return 1; }
    const problems = [];
    const plan = [];
    for (const h of hosts) {
        const p = h === here ? local : sshProbe(h, rel);
        if (p.error) { problems.push(`${h.id}: not reached (${p.error})`); console.log(`  ✖ ${h.id}: not reached (${p.error})`); continue; }
        const diffs = levelDiffs(p, local);
        const missing = [!p.dart && 'no Dart SDK found (scripts/find-dart.cjs)', !p.node && 'no Node on PATH'].filter(Boolean);
        if (diffs.length || missing.length) {
            const why = [...(diffs.length ? [`not level with this host: ${diffs.join(', ')}`] : []), ...missing].join('; ');
            problems.push(`${h.id}: ${why}`);
            console.log(`  ✖ ${h.id} (${p.platform}): ${why}`);
            continue;
        }
        console.log(`  ✔ ${h.id} (${p.platform})${h === here ? ' — this host' : ''}: level, Dart and Node present`);
        plan.push({ host: h, platform: p.platform });
    }
    if (problems.length) {
        console.error('❌ Nothing built. A host that is not level is brought level by a reconcile (yours to start); an unreachable one needs the VPN or --hosts without it.');
        return 1;
    }
    if (dryRun) { console.log('Dry run: the preflight passed; nothing built.'); return 0; }

    const order = [...plan.filter((p) => p.host === here), ...plan.filter((p) => p.host !== here)];
    for (const { host, platform } of order) {
        console.log(`\n──────── ${host.id} (${platform}): building tom_bs, validate_codespecs and spec_checks ────────`);
        let r;
        if (host === here) {
            r = process.platform === 'win32'
                ? spawnSync('powershell', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', path.join(EXT_ROOT, 'compile_and_install.ps1'), '-BinariesOnly'], { stdio: 'inherit', env: { ...process.env, TOM_LAYER_FF: '1' } })
                : spawnSync(path.join(EXT_ROOT, 'compile_and_install.sh'), ['--binaries-only'], { stdio: 'inherit', env: { ...process.env, TOM_LAYER_FF: '1' } });
        } else {
            r = spawnSync('ssh', [...SSH_OPTS, host.ssh, remoteBuild(host, rel)], { stdio: 'inherit' });
        }
        if (r.status !== 0) {
            console.error(`❌ The build on ${host.id} failed (exit ${r.status}); the hosts before it have pushed theirs.`);
            return 1;
        }
    }
    const layerRepo = path.join(WORKSPACE_ROOT, 'tom_binaries');
    try {
        execFileSync('git', ['fetch', '--quiet', 'origin'], { cwd: layerRepo, stdio: 'inherit' });
        execFileSync('git', ['merge', '--ff-only', '--quiet', '@{u}'], { cwd: layerRepo, stdio: 'inherit' });
        console.log('\n✔ This host\'s binaries layer holds every build host\'s binaries.');
    } catch (e) {
        console.error(`❌ Fast-forwarding this host's binaries layer failed: ${e.message}`);
        return 1;
    }
    return 0;
}

module.exports = { FLEET_PLATFORMS, parseRegistry, platformFromUname, windowsPath, probeScript, remoteBash, remoteBuild, parseProbe, levelDiffs, SOURCE_REPOS };

if (require.main === module) {
    process.exitCode = main(process.argv.slice(2));
}
