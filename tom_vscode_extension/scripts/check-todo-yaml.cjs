#!/usr/bin/env node
/**
 * check-todo-yaml.cjs — sweep every `*.todo.yaml` for illegal YAML.
 *
 * The failure this finds is the one nothing else reports: a duplicate map key.
 * It is legal enough for the parser to hand back a usable document (the problem
 * lands in `doc.errors` instead of an exception), so every reader carries on —
 * but the file can no longer be *written*: `doc.toString()` refuses. A todo
 * archive corrupted today therefore surfaces as an unexplained archive failure
 * weeks later, in whichever quest happens to archive next.
 *
 * The extension itself cannot produce this: its writes go through the yaml
 * Document API, which replaces a key rather than repeating it. It arrives from
 * outside — a hand edit, or a text merge of two archives that diverged across
 * the fleet. The `_ai` layer is shared by every machine, so "no writer of mine
 * does this" is not the same as "this cannot happen", and that is what this
 * sweep is for.
 *
 * Deliberately *not* part of `npm test`: it reads the machine's `_ai` state,
 * which is not part of the extension's own repository and is absent on a fresh
 * checkout. Run it after a reconcile, or when an archive fails.
 *
 * Usage:
 *   node scripts/check-todo-yaml.cjs [root ...]     # default: <ws>/_ai
 *
 * Exit codes:
 *   0  every file parses clean
 *   1  at least one file is malformed (path, line and reason are printed)
 *   2  could not run (no root to scan)
 */

const fs = require('fs');
const path = require('path');
const { parseDocument } = require('yaml');

const SKIP_DIRS = new Set(['node_modules', 'out', 'build', '.git']);

/** Every `*.todo.yaml` under `dir`, following no symlinks. */
function collect(dir, found = []) {
    let entries;
    try {
        entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
        return found;
    }
    for (const entry of entries) {
        if (entry.isSymbolicLink()) { continue; }
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) {
            if (entry.name.startsWith('.') || SKIP_DIRS.has(entry.name)) { continue; }
            collect(full, found);
        } else if (entry.name.endsWith('.todo.yaml')) {
            found.push(full);
        }
    }
    return found;
}

/** Workspace-root `_ai` folder, derived from this script's location. */
function defaultRoot() {
    // <ws>/inhouse/.../tom_ai/vscode/tom_vscode_extension/scripts → walk up to a
    // directory holding `_ai`.
    let dir = __dirname;
    while (dir !== path.dirname(dir)) {
        const candidate = path.join(dir, '_ai');
        if (fs.existsSync(candidate)) { return candidate; }
        dir = path.dirname(dir);
    }
    return undefined;
}

function main() {
    const roots = process.argv.slice(2);
    if (roots.length === 0) {
        const fallback = defaultRoot();
        if (!fallback) {
            console.error('check-todo-yaml: no `_ai` folder found above this script; pass a root explicitly.');
            process.exit(2);
        }
        roots.push(fallback);
    }

    const files = roots.flatMap(root => collect(path.resolve(root)));
    let broken = 0;

    for (const file of files) {
        const doc = parseDocument(fs.readFileSync(file, 'utf8'));
        if (doc.errors.length === 0) { continue; }
        broken++;
        console.error(file);
        for (const err of doc.errors) {
            const at = err.linePos?.[0];
            const where = at ? `line ${at.line}, column ${at.col}` : 'unknown position';
            console.error(`  [${err.code}] ${where}: ${err.message.split(' at line ')[0].trim()}`);
        }
    }

    const archived = files.filter(f => /todos-(archived|deleted)\./.test(path.basename(f))).length;
    console.log(
        `check-todo-yaml: ${files.length} file(s) scanned (${archived} archived/deleted), ` +
        `${broken} malformed.`,
    );
    process.exit(broken === 0 ? 0 : 1);
}

main();
