/**
 * One build at a time on a checkout (qrfix5; scripts/build-lock.cjs): `npm test`, `npm run compile`,
 * `npm run codespecs:build` and the install scripts hold `.build.lock` (pid, command, start time).
 *
 *   BL-1 the lock is taken (the record written); a second one is refused while a live pid holds it, with the message
 *        naming the holder, its pid and since when
 *   BL-2 nested steps pass: the holder's own pid, or TOM_BUILD_LOCK_HOLDER naming it
 *   BL-3 a stale lock (its pid no longer runs) is taken over, with one line saying so; an unreadable old lock goes
 *   BL-4 only the holder releases
 *   BL-5 the command line: `run` holds the lock while its command runs (which sees TOM_BUILD_LOCK_HOLDER) and releases
 *        it, refuses (exit 1, the message) under a live holder, takes over a dead one's; `acquire` / `release`
 *   BL-6 `npm test` (run-test-stages.cjs) refuses before any stage while another build holds the lock
 *   BL-7 the wiring: compile and codespecs:build run under the lock; the three .sh install scripts take it before their
 *        work and release it on exit (install_extension.sh's traps keep the release); the three .ps1 scripts run
 *        themselves inside it; the lock file is ignored by git and left out of the VSIX
 */

/* eslint-disable @typescript-eslint/naming-convention -- environment variables as written */
import test, { describe } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'fs';
import * as path from 'path';
import { spawnSync } from 'child_process';

const EXT = path.resolve(__dirname, '..', '..', '..');
const SCRIPT = path.join(EXT, 'scripts', 'build-lock.cjs');

interface LockRecord { pid: number; command: string; startedAt: string; host?: string }
type AcquireResult = { ok: true; how: 'acquired' | 'nested' | 'took-over'; previous?: LockRecord } | { ok: false; lock: LockRecord; message: string };
// eslint-disable-next-line @typescript-eslint/no-require-imports
const lock = require(SCRIPT) as {
    acquire(o: { root: string; pid: number; command: string; env?: NodeJS.ProcessEnv; alive?: (pid: number) => boolean; now?: () => Date }): AcquireResult;
    release(o: { root: string; pid: number }): boolean;
    readLock(root: string): LockRecord | undefined;
    tookOverMessage(previous: LockRecord): string;
    LOCK_NAME: string; HOLDER_ENV: string; DIR_ENV: string;
};

function tmpDir(what: string): string {
    const base = path.join(EXT, '..', '..', '..', 'ztmp');
    fs.mkdirSync(base, { recursive: true });
    return fs.mkdtempSync(path.join(base, `vscode_extension_261115_qrfix5_${what}-`));
}

/** The environment of a child that holds no lock (the test itself may run under `npm test`'s). */
function freeEnv(dir: string): NodeJS.ProcessEnv {
    const env: NodeJS.ProcessEnv = { ...process.env, [lock.DIR_ENV]: dir };
    delete env[lock.HOLDER_ENV];
    return env;
}

/** A pid that no longer runs. */
function deadPid(): number {
    const r = spawnSync(process.execPath, ['-e', 'process.stdout.write(String(process.pid))'], { encoding: 'utf8' });
    return Number(r.stdout);
}

function writeLock(dir: string, record: LockRecord): void {
    fs.writeFileSync(path.join(dir, lock.LOCK_NAME), JSON.stringify(record));
}

const read = (rel: string): string => fs.readFileSync(path.join(EXT, rel), 'utf8');

describe('the checkout\'s build lock', () => {
    test('BL-1: taken, and refused while a live pid holds it', () => {
        const dir = tmpDir('bl1');
        try {
            const at = new Date(2026, 10, 15, 14, 5, 30);
            const r = lock.acquire({ root: dir, pid: 4242, command: 'compile_and_install.sh', env: {}, now: () => at });
            assert.deepEqual(r, { ok: true, how: 'acquired' });
            const held = lock.readLock(dir)!;
            assert.equal(held.pid, 4242);
            assert.equal(held.command, 'compile_and_install.sh');
            assert.equal(held.startedAt, at.toISOString());
            const second = lock.acquire({ root: dir, pid: 5151, command: 'npm test', env: {}, alive: () => true });
            assert.equal(second.ok, false);
            assert.equal((second as { message: string }).message,
                '✖ compile_and_install.sh (pid 4242) is running on this checkout since 14:05:30 — wait for it (lock: .build.lock).');
            assert.equal(lock.readLock(dir)!.pid, 4242, 'the holder keeps it');
        } finally {
            fs.rmSync(dir, { recursive: true, force: true });
        }
    });

    test('BL-2: nested steps pass', () => {
        const dir = tmpDir('bl2');
        try {
            lock.acquire({ root: dir, pid: 4242, command: 'compile_and_install.sh', env: {} });
            assert.equal(lock.acquire({ root: dir, pid: 4242, command: 'install_extension.ps1', env: {}, alive: () => true }).ok, true, 'the same pid');
            const nested = lock.acquire({ root: dir, pid: 6000, command: 'npm run compile', env: { [lock.HOLDER_ENV]: '4242' }, alive: () => true });
            assert.equal(nested.ok && nested.how, 'nested');
            const other = lock.acquire({ root: dir, pid: 6000, command: 'npm run compile', env: { [lock.HOLDER_ENV]: '9999' }, alive: () => true });
            assert.equal(other.ok, false, 'a holder env naming somebody else does not pass');
        } finally {
            fs.rmSync(dir, { recursive: true, force: true });
        }
    });

    test('BL-3: a stale lock is taken over', () => {
        const dir = tmpDir('bl3');
        try {
            const dead = deadPid();
            writeLock(dir, { pid: dead, command: 'compile_and_install.sh', startedAt: new Date().toISOString() });
            const r = lock.acquire({ root: dir, pid: 7000, command: 'npm test', env: {} });
            assert.equal(r.ok && r.how, 'took-over');
            assert.equal(r.ok && r.previous?.pid, dead);
            assert.equal(lock.readLock(dir)!.pid, 7000);
            assert.equal(lock.tookOverMessage({ pid: dead, command: 'compile_and_install.sh', startedAt: '' }),
                `ℹ Took over the build lock of compile_and_install.sh (pid ${dead}), which no longer runs.`);
            // An unreadable lock older than a moment goes.
            fs.writeFileSync(path.join(dir, lock.LOCK_NAME), 'garbage');
            const old = new Date(Date.now() - 60_000);
            fs.utimesSync(path.join(dir, lock.LOCK_NAME), old, old);
            assert.deepEqual(lock.acquire({ root: dir, pid: 7100, command: 'npm test', env: {} }), { ok: true, how: 'acquired' });
        } finally {
            fs.rmSync(dir, { recursive: true, force: true });
        }
    });

    test('BL-4: only the holder releases', () => {
        const dir = tmpDir('bl4');
        try {
            lock.acquire({ root: dir, pid: 4242, command: 'npm test', env: {} });
            assert.equal(lock.release({ root: dir, pid: 5151 }), false);
            assert.ok(fs.existsSync(path.join(dir, lock.LOCK_NAME)));
            assert.equal(lock.release({ root: dir, pid: 4242 }), true);
            assert.ok(!fs.existsSync(path.join(dir, lock.LOCK_NAME)));
            assert.equal(lock.release({ root: dir, pid: 4242 }), false, 'nothing held');
        } finally {
            fs.rmSync(dir, { recursive: true, force: true });
        }
    });

    test('BL-5: the command line', () => {
        const dir = tmpDir('bl5');
        try {
            const env = freeEnv(dir);
            const probe = `const fs=require('fs');const p=require('path');process.stdout.write(JSON.stringify({holder:process.env.${lock.HOLDER_ENV}||'',lock:JSON.parse(fs.readFileSync(p.join(${JSON.stringify(dir)},'.build.lock'),'utf8'))}))`;
            const ran = spawnSync(process.execPath, [SCRIPT, 'run', '--command', 'npm run compile', '--', process.execPath, '-e', probe], { env, encoding: 'utf8' });
            assert.equal(ran.status, 0, ran.stderr);
            const seen = JSON.parse(ran.stdout) as { holder: string; lock: LockRecord };
            assert.equal(seen.lock.command, 'npm run compile');
            assert.equal(seen.holder, String(seen.lock.pid), 'the command runs as a nested step');
            assert.ok(!fs.existsSync(path.join(dir, lock.LOCK_NAME)), 'released afterwards');

            const exit3 = spawnSync(process.execPath, [SCRIPT, 'run', '--command', 'x', '--', process.execPath, '-e', 'process.exit(3)'], { env, encoding: 'utf8' });
            assert.equal(exit3.status, 3, 'the command\'s exit code');
            assert.ok(!fs.existsSync(path.join(dir, lock.LOCK_NAME)), 'released after a failure too');

            writeLock(dir, { pid: process.pid, command: 'compile_and_install.sh', startedAt: new Date().toISOString() });
            const refused = spawnSync(process.execPath, [SCRIPT, 'run', '--command', 'npm run compile', '--', process.execPath, '-e', 'process.stdout.write("ran")'], { env, encoding: 'utf8' });
            assert.equal(refused.status, 1);
            assert.equal(refused.stdout, '', 'the command did not run');
            assert.match(refused.stderr, new RegExp(`compile_and_install\\.sh \\(pid ${process.pid}\\) is running on this checkout since \\d\\d:\\d\\d:\\d\\d — wait for it`));
            const acq = spawnSync(process.execPath, [SCRIPT, 'acquire', '--pid', '123', '--command', 'install_extension.sh'], { env, encoding: 'utf8' });
            assert.equal(acq.status, 1, 'acquire refused too');

            const dead = deadPid();
            writeLock(dir, { pid: dead, command: 'install_extension.sh', startedAt: new Date().toISOString() });
            const over = spawnSync(process.execPath, [SCRIPT, 'run', '--command', 'npm run compile', '--', process.execPath, '-e', ''], { env, encoding: 'utf8' });
            assert.equal(over.status, 0, over.stderr);
            assert.match(over.stdout, new RegExp(`Took over the build lock of install_extension\\.sh \\(pid ${dead}\\)`));

            assert.equal(spawnSync(process.execPath, [SCRIPT, 'acquire', '--pid', String(process.pid), '--command', 'install_extension.sh'], { env }).status, 0);
            assert.equal(lock.readLock(dir)!.command, 'install_extension.sh');
            assert.equal(spawnSync(process.execPath, [SCRIPT, 'release', '--pid', String(process.pid)], { env }).status, 0);
            assert.ok(!fs.existsSync(path.join(dir, lock.LOCK_NAME)));
        } finally {
            fs.rmSync(dir, { recursive: true, force: true });
        }
    });

    test('BL-6: npm test refuses while another build holds the lock', () => {
        const dir = tmpDir('bl6');
        try {
            writeLock(dir, { pid: process.pid, command: 'compile_and_install.sh', startedAt: new Date().toISOString() });
            const r = spawnSync(process.execPath, [path.join(EXT, 'scripts', 'run-test-stages.cjs')], { env: freeEnv(dir), encoding: 'utf8', timeout: 30_000 });
            assert.equal(r.status, 1);
            assert.match(r.stderr, new RegExp(`✖ compile_and_install\\.sh \\(pid ${process.pid}\\) is running on this checkout`));
            assert.doesNotMatch(r.stdout, /▶▶/, 'no stage ran');
            assert.equal(lock.readLock(dir)!.pid, process.pid, 'the holder keeps it');
        } finally {
            fs.rmSync(dir, { recursive: true, force: true });
        }
    });

    test('BL-7: the wiring', () => {
        const pkg = JSON.parse(read('package.json')) as { scripts: Record<string, string> };
        assert.match(pkg.scripts.compile, /^node scripts\/build-lock\.cjs run --command "npm run compile" -- npm run compile:steps$/);
        assert.match(pkg.scripts['codespecs:build'], /^node scripts\/build-lock\.cjs run --command "npm run codespecs:build" -- node scripts\/build-validate-codespecs\.cjs$/);
        for (const sh of ['compile_and_install.sh', 'install_extension.sh', 'reinstall_for_testing.sh']) {
            const text = read(sh);
            const source = text.indexOf('scripts/build_lock.sh"');
            const take = text.indexOf(`tom_build_lock_acquire "${sh}"`);
            assert.ok(source > 0 && take > source, `${sh}: sources the helper and takes the lock`);
            assert.ok(text.indexOf("trap 'tom_build_lock_release' EXIT") > take, `${sh}: releases it on exit`);
        }
        const install = read('install_extension.sh');
        assert.ok(install.includes("trap 'tom_bin_kept_on_failure $?; tom_build_lock_release' EXIT"), 'the staging trap keeps the release');
        assert.ok(!/trap - EXIT/.test(install), 'no trap reset drops the release');
        assert.ok(install.indexOf('tom_build_lock_acquire') < install.indexOf('npm run compile'), 'before the compile');
        for (const ps of ['compile_and_install.ps1', 'install_extension.ps1', 'reinstall_for_testing.ps1']) {
            const text = read(ps);
            assert.ok(text.includes(`exit (Invoke-ScriptWithBuildLock '${ps}' $PSCommandPath $PSBoundParameters $args)`), `${ps}: runs itself inside the lock`);
            const firstStep = text.search(/^\s*(?:& )?(?:npm|node|dart|code|& \$)/m);
            assert.ok(firstStep < 0 || text.indexOf('Invoke-ScriptWithBuildLock') < firstStep, `${ps}: before any build step`);
        }
        const helper = read('scripts/build_lock.ps1');
        assert.match(helper, /\$owned = -not \$env:TOM_BUILD_LOCK_HOLDER/);
        assert.match(helper, /finally \{[\s\S]*if \(\$owned\) \{[\s\S]*release --pid \$PID/);
        for (const ignore of ['.gitignore', '.vscodeignore']) {
            assert.ok(read(ignore).split(/\r?\n/).includes('.build.lock'), ignore);
        }
    });
});
