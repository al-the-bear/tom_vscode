/**
 * Write a file so that no reader ever sees it empty or half written.
 *
 * `fs.writeFileSync` truncates the file and then writes it; a reader in another
 * process — another window on the shared `_ai` clone, git, a merge driver, a
 * script — can read in between. Measured on a 400 KB todo file rewritten for
 * 1.5 s: a polling reader saw it empty 3 097 times and partial 330 times. A
 * read-modify-write by such a reader then writes back what it saw: a script
 * that appended to `todos-deleted.vscode_extension.todo.yaml` read it empty and
 * would have erased its 125 todos (2026-11-06).
 *
 * Here the text goes to a temporary file in the same folder (the same file
 * system, so the rename is atomic) and is renamed over the target: a reader
 * sees the old file or the new one. The target's permission bits are kept.
 */

import * as fs from 'fs';
import * as path from 'path';

let counter = 0;

/** Write `text` to `filePath` atomically; throws (leaving no temporary file) when it cannot. */
export function writeFileAtomic(filePath: string, text: string): void {
    const dir = path.dirname(filePath);
    // Unique per process and call: two writers never share a temporary file.
    const temp = path.join(dir, `.${path.basename(filePath)}.${process.pid}.${++counter}.tmp`);
    let mode: number | undefined;
    try { mode = fs.statSync(filePath).mode & 0o777; } catch { mode = undefined; }
    try {
        fs.writeFileSync(temp, text, mode === undefined ? 'utf8' : { encoding: 'utf8', mode });
        if (mode !== undefined) { fs.chmodSync(temp, mode); }
        renameOver(temp, filePath, text);
    } catch (err) {
        try { fs.unlinkSync(temp); } catch { /* never written */ }
        throw err;
    }
}

/** Codes a rename over a file another program holds open gives on Windows. */
const BUSY = new Set(['EPERM', 'EACCES', 'EBUSY']);

/**
 * Rename `temp` over `target`. On Windows a program that has the target open
 * without delete sharing makes the rename fail for a moment: try a few times,
 * then write the target in place (not atomic, but the save is not lost) and
 * drop the temporary file.
 */
function renameOver(temp: string, target: string, text: string): void {
    for (let attempt = 0; ; attempt++) {
        try {
            fs.renameSync(temp, target);
            return;
        } catch (err) {
            const code = (err as NodeJS.ErrnoException).code ?? '';
            if (process.platform !== 'win32' || !BUSY.has(code)) { throw err; }
            if (attempt >= 4) {
                fs.writeFileSync(target, text, 'utf8');
                try { fs.unlinkSync(temp); } catch { /* already gone */ }
                return;
            }
            Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 25);
        }
    }
}
