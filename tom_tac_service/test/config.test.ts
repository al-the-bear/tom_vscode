import { strict as assert } from 'node:assert';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { after, test } from 'node:test';
import { DEFAULT_PORT, ensureKeyFile, readConfigFile, readKeyFile, resolveConfig } from '../src/local';
import { removeDir, scratchDir } from './helpers';

const dirs: string[] = [];
after(() => dirs.forEach(removeDir));

test('CF-1 the machine config: flat YAML or JSON, unknown settings refused', () => {
    const dir = scratchDir('cf1');
    dirs.push(dir);
    const yaml = path.join(dir, 'config.yaml');
    fs.writeFileSync(yaml, '# the local service\nport: 19891\nkeepRunning: true   # until the machine restarts\nidleMinutes: 30\nhost: "127.0.0.1"\n');
    assert.deepEqual(readConfigFile(yaml), { port: 19891, keepRunning: true, idleMinutes: 30, host: '127.0.0.1' });
    const json = path.join(dir, 'c.json');
    fs.writeFileSync(json, '{"idleMinutes": 5}');
    assert.deepEqual(readConfigFile(json), { idleMinutes: 5 });
    fs.writeFileSync(yaml, 'portt: 1\n');
    assert.throws(() => readConfigFile(yaml), /unknown setting portt/);
    fs.writeFileSync(yaml, 'nested:\n  a: 1\n');
    assert.throws(() => readConfigFile(yaml), /top-level/);
});

test('CF-2 resolveConfig: defaults, then <store>/config.yaml, then the flags; the store path made absolute', () => {
    const dir = scratchDir('cf2');
    dirs.push(dir);
    fs.writeFileSync(path.join(dir, 'config.yaml'), 'idleMinutes: 30\nkeepRunning: true\n');
    const c = resolveConfig({ storeDir: dir, idleMinutes: 2 });
    assert.equal(c.port, DEFAULT_PORT);
    assert.equal(c.keepRunning, true, 'from the file');
    assert.equal(c.idleMinutes, 2, 'the flag wins');
    const rel = path.relative(process.cwd(), dir);
    assert.equal(resolveConfig({ storeDir: rel }).storeDir, path.resolve(dir));
    assert.throws(() => resolveConfig({ storeDir: dir }, path.join(dir, 'missing.yaml')), /does not exist/);
});

test('CF-3 the key file: created once, mode 0600, read back', () => {
    const dir = scratchDir('cf3');
    dirs.push(dir);
    const k1 = ensureKeyFile(dir);
    const k2 = ensureKeyFile(dir);
    assert.equal(k1, k2);
    assert.match(k1, /^[0-9a-f]{64}$/);
    assert.equal(readKeyFile(dir), k1);
    if (process.platform !== 'win32') {
        assert.equal(fs.statSync(path.join(dir, 'local.key')).mode & 0o777, 0o600);
    }
});
