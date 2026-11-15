#!/usr/bin/env node
/**
 * One build at a time on a checkout (qrfix5): `npm test`, `npm run compile`,
 * `npm run codespecs:build` and the install scripts each wipe or rewrite what
 * the others read — the compile wipes `out/` (the tests' compiled files), the
 * install's codespecs build replaces `bin/<platform>/`. On 2026-11-08 a full
 * `npm test` ran while compile_and_install.sh ran on the same checkout: later
 * stages found no compiled tests and every CodeSpecs test failed, with nothing
 * saying why.
 *
 * So each of them holds `.build.lock` in the extension folder (pid, command,
 * start time) for its whole run. A second one refuses at once:
 *
 *   ✖ compile_and_install.sh (pid 4242) is running on this checkout since 14:05:30 — wait for it (lock: .build.lock).
 *
 * - **Nested steps pass.** The holder hands its pid down as
 *   `TOM_BUILD_LOCK_HOLDER`, so the install's own `npm run compile`, or the
 *   compile `npm test` runs, goes ahead under the holder's lock.
 * - **A stale lock is taken over.** A lock whose pid no longer runs (the
 *   holder ended without releasing it, e.g. a script that failed) is replaced,
 *   with one line saying so.
 * - **Only the holder releases.** `release` removes the lock only when its pid
 *   is the caller's.
 *
 *   node scripts/build-lock.cjs acquire --pid <pid> --command <name>   (the install scripts: their shell's pid)
 *   node scripts/build-lock.cjs release --pid <pid>
 *   node scripts/build-lock.cjs run --command <name> -- <cmd> [args…]  (npm scripts: hold it while <cmd> runs)
 *
 * Exit 0 when the lock is held (or passed to a nested step), 1 when another
 * live process holds it.
 */
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const EXT_ROOT = path.resolve(__dirname, '..');
const LOCK_NAME = '.build.lock';
const HOLDER_ENV = 'TOM_BUILD_LOCK_HOLDER';
/** Tests only: the folder the lock is kept in instead of the extension folder. */
const DIR_ENV = 'TOM_BUILD_LOCK_DIR';

function defaultRoot() { return process.env[DIR_ENV] || EXT_ROOT; }

/** Whether process `pid` runs (EPERM: it runs, under another user). */
function isAlive(pid) {
    if (!Number.isInteger(pid) || pid <= 0) { return false; }
    try { process.kill(pid, 0); return true; } catch (e) { return e && e.code === 'EPERM'; }
}

function lockFile(root) { return path.join(root, LOCK_NAME); }

/** The lock as written, or undefined (none, or unreadable). */
function readLock(root) {
    try {
        const l = JSON.parse(fs.readFileSync(lockFile(root), 'utf8'));
        return l && typeof l === 'object' && Number.isInteger(l.pid) ? l : undefined;
    } catch { return undefined; }
}

function clock(iso) {
    const d = new Date(iso);
    if (Number.isNaN(d.getTime())) { return String(iso); }
    const p = (n) => String(n).padStart(2, '0');
    return `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}

/** The refusal: who holds the lock and since when. */
function heldMessage(lock) {
    return `✖ ${lock.command} (pid ${lock.pid}) is running on this checkout since ${clock(lock.startedAt)} — wait for it (lock: ${LOCK_NAME}).`;
}

/**
 * Take the lock for `pid` running `command`. Answers
 *   { ok: true, how: 'acquired' | 'nested' | 'took-over', previous? }
 *   { ok: false, lock, message }
 * `env[HOLDER_ENV]` naming the current holder's pid lets a nested step pass.
 * Injectable `alive` and `now` for tests.
 */
function acquire({ root = defaultRoot(), pid, command, env = process.env, alive = isAlive, now = () => new Date() }) {
    for (let attempt = 0; attempt < 3; attempt++) {
        const record = { pid, command, startedAt: now().toISOString(), host: os.hostname() };
        try {
            fs.writeFileSync(lockFile(root), `${JSON.stringify(record, null, 2)}\n`, { flag: 'wx' });
            return { ok: true, how: 'acquired' };
        } catch (e) {
            if (!e || e.code !== 'EEXIST') { throw e; }
        }
        const held = readLock(root);
        if (!held) {
            // Written a moment ago and not readable yet, or garbage: garbage goes, a fresh one gets a retry.
            try { if (Date.now() - fs.statSync(lockFile(root)).mtimeMs > 2000) { fs.rmSync(lockFile(root), { force: true }); } } catch { /* gone */ }
            continue;
        }
        if (held.pid === pid || String(held.pid) === String(env[HOLDER_ENV] || '')) {
            return { ok: true, how: 'nested', holder: held };
        }
        if (alive(held.pid)) {
            return { ok: false, lock: held, message: heldMessage(held) };
        }
        // Its holder no longer runs: take it over.
        try { fs.rmSync(lockFile(root), { force: true }); } catch { /* raced away */ }
        const again = acquire({ root, pid, command, env, alive, now });
        return again.ok && again.how === 'acquired' ? { ok: true, how: 'took-over', previous: held } : again;
    }
    return { ok: false, lock: { pid: 0, command: 'another build', startedAt: now().toISOString() }, message: `✖ The build lock ${LOCK_NAME} could not be taken — retry.` };
}

/** Remove the lock when `pid` holds it; answers whether it did. */
function release({ root = defaultRoot(), pid }) {
    const held = readLock(root);
    if (!held || held.pid !== pid) { return false; }
    try { fs.rmSync(lockFile(root), { force: true }); return true; } catch { return false; }
}

/** The line a takeover prints. */
function tookOverMessage(previous) {
    return `ℹ Took over the build lock of ${previous.command} (pid ${previous.pid}), which no longer runs.`;
}

function argValue(args, name) {
    const i = args.indexOf(name);
    return i >= 0 ? args[i + 1] : undefined;
}

function main(argv) {
    const [verb, ...rest] = argv;
    if (verb === 'acquire') {
        const pid = Number(argValue(rest, '--pid'));
        const command = argValue(rest, '--command') || 'a build';
        const r = acquire({ pid, command });
        if (!r.ok) { process.stderr.write(`${r.message}\n`); return 1; }
        if (r.how === 'took-over') { process.stdout.write(`${tookOverMessage(r.previous)}\n`); }
        return 0;
    }
    if (verb === 'release') {
        release({ pid: Number(argValue(rest, '--pid')) });
        return 0;
    }
    if (verb === 'run') {
        const sep = rest.indexOf('--');
        const command = argValue(rest.slice(0, sep < 0 ? rest.length : sep), '--command') || 'a build';
        const cmd = sep >= 0 ? rest.slice(sep + 1) : [];
        if (cmd.length === 0) { process.stderr.write('build-lock run: no command after --\n'); return 2; }
        const r = acquire({ pid: process.pid, command });
        if (!r.ok) { process.stderr.write(`${r.message}\n`); return 1; }
        if (r.how === 'took-over') { process.stdout.write(`${tookOverMessage(r.previous)}\n`); }
        const env = r.how === 'nested' ? process.env : { ...process.env, [HOLDER_ENV]: String(process.pid) };
        try {
            const res = spawnSync(cmd[0], cmd.slice(1), { stdio: 'inherit', env, shell: process.platform === 'win32' });
            return res.status === null ? 1 : res.status;
        } finally {
            if (r.how !== 'nested') { release({ pid: process.pid }); }
        }
    }
    process.stderr.write('usage: build-lock.cjs acquire --pid <pid> --command <name> | release --pid <pid> | run --command <name> -- <cmd> [args…]\n');
    return 2;
}

module.exports = { acquire, release, readLock, isAlive, heldMessage, tookOverMessage, LOCK_NAME, HOLDER_ENV, DIR_ENV };

if (require.main === module) {
    process.exitCode = main(process.argv.slice(2));
}
