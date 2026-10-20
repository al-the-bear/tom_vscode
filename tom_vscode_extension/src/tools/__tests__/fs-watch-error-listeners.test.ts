/**
 * Every fs.watch in the extension handles its watcher failing (vscimpa19).
 *
 * A watcher can fail after it started — macOS runs out of watch handles when
 * many windows watch files (EMFILE). An FSWatcher without an 'error' listener
 * then throws the error as an uncaught exception in the extension host; the
 * queue's answer watcher did exactly that on 2026-10-20 (vsd6).
 *
 *   FW-1 every `fs.watch(` in src/ (tests excluded) is followed, within the same function, by an 'error'
 *        listener on the watcher it created
 */

import test, { describe } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'fs';
import * as path from 'path';

const SRC = path.resolve(__dirname, '..', '..', '..', 'src');
/** How far below the fs.watch( call its error listener may be. */
const WINDOW_LINES = 60;

function sourceFiles(dir: string): string[] {
    const out: string[] = [];
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
        const abs = path.join(dir, e.name);
        if (e.isDirectory()) { if (e.name !== '__tests__') { out.push(...sourceFiles(abs)); } }
        else if (e.name.endsWith('.ts')) { out.push(abs); }
    }
    return out;
}

describe('fs.watch error listeners', () => {
    test('FW-1: every fs.watch has an error listener', () => {
        const missing: string[] = [];
        let watches = 0;
        for (const file of sourceFiles(SRC)) {
            const lines = fs.readFileSync(file, 'utf8').split('\n');
            lines.forEach((line, i) => {
                if (!/\bfs\.watch\(/.test(line) || /^\s*(\/\/|\*)/.test(line)) { return; }
                watches++;
                const below = lines.slice(i, i + WINDOW_LINES).join('\n');
                if (!/\.on\(\s*'error'/.test(below)) { missing.push(`${path.relative(SRC, file)}:${i + 1}`); }
            });
        }
        assert.ok(watches >= 5, `the scan finds the watchers (${watches})`);
        assert.deepEqual(missing, [], 'fs.watch without an error listener');
    });
});
