/**
 * Writing a file so no reader ever sees it empty or half written (src/utils/atomicWrite.ts), and the todo
 * files' writes going through it (src/utils/todoBlockingSync.ts).
 *
 *   AW-1 a reader in another process, polling the file while it is rewritten many times, only ever reads
 *        one whole version: never an empty or a partial file
 *   AW-2 the file keeps its permission bits; no temporary file is left behind; a missing folder is an error
 *        and leaves nothing
 *   AW-3 the todo file writes use it: `writeTodoFileText` and the blocking sync's own write go through
 *        writeFileAtomic, no raw writeFileSync is left in todoBlockingSync.ts
 */

import test, { describe } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { writeFileAtomic } from '../atomicWrite.js';

/** A whole version: one letter repeated, so a partial read shows as too short or mixed. */
const SIZE = 400_000;
const version = (letter: string): string => letter.repeat(SIZE);

/** Poll `file` from a child process until `stopFile` exists; answer the counts of what it saw. */
function pollInChild(file: string, stopFile: string): Promise<{ reads: number; empty: number; partial: number }> {
    const script = `
        const fs = require('fs');
        let reads = 0, empty = 0, partial = 0;
        while (!fs.existsSync(${JSON.stringify(stopFile)})) {
            let text;
            try { text = fs.readFileSync(${JSON.stringify(file)}, 'utf8'); } catch { continue; }
            reads++;
            if (text.length === 0) { empty++; }
            else if (text.length !== ${SIZE} || text !== text[0].repeat(${SIZE})) { partial++; }
        }
        process.stdout.write(JSON.stringify({ reads, empty, partial }));
    `;
    return new Promise((resolve, reject) => {
        const child = spawn(process.execPath, ['-e', script]);
        let out = '';
        child.stdout.on('data', (d) => { out += d; });
        child.on('error', reject);
        child.on('close', () => { try { resolve(JSON.parse(out)); } catch (e) { reject(e); } });
    });
}

describe('atomic write', () => {
    test('AW-1: a reader never sees the file empty or partial', async (t) => {
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'atomic-write-'));
        t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
        const file = path.join(dir, 'todos.demo.todo.yaml');
        const stop = path.join(dir, 'stop');
        writeFileAtomic(file, version('a'));
        const reader = pollInChild(file, stop);
        await new Promise((r) => setTimeout(r, 300)); // the child is reading
        const until = Date.now() + 1500;
        let writes = 0;
        while (Date.now() < until) {
            writeFileAtomic(file, version(writes % 2 ? 'a' : 'b'));
            writes++;
            if (writes % 50 === 0) { await new Promise((r) => setImmediate(r)); }
        }
        fs.writeFileSync(stop, '');
        const seen = await reader;
        assert.ok(writes > 100, `enough writes (${writes})`);
        assert.ok(seen.reads > 50, `the reader read while the file was written (${seen.reads})`);
        assert.deepEqual({ empty: seen.empty, partial: seen.partial }, { empty: 0, partial: 0 });
    });

    test('AW-2: mode kept, nothing left behind, a missing folder', (t) => {
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'atomic-write-'));
        t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
        const file = path.join(dir, 'f.yaml');
        fs.writeFileSync(file, 'old');
        if (process.platform !== 'win32') { fs.chmodSync(file, 0o640); }
        writeFileAtomic(file, 'new');
        assert.equal(fs.readFileSync(file, 'utf8'), 'new');
        if (process.platform !== 'win32') { assert.equal(fs.statSync(file).mode & 0o777, 0o640); }
        writeFileAtomic(path.join(dir, 'fresh.yaml'), 'x');
        assert.deepEqual(fs.readdirSync(dir).sort(), ['f.yaml', 'fresh.yaml'], 'no temporary file left');
        assert.throws(() => writeFileAtomic(path.join(dir, 'no', 'such', 'f.yaml'), 'x'));
        assert.deepEqual(fs.readdirSync(dir).sort(), ['f.yaml', 'fresh.yaml']);
    });

    test('AW-3: the todo writes use it', () => {
        const source = fs.readFileSync(path.join(__dirname, '..', '..', '..', 'src', 'utils', 'todoBlockingSync.ts'), 'utf8');
        assert.equal((source.match(/fs\.writeFileSync\(/g) ?? []).length, 0, 'no raw write of a todo file');
        assert.equal((source.match(/writeFileAtomic\(/g) ?? []).length, 2, 'writeTodoFileText and the blocking sync');
    });
});
