#!/usr/bin/env node
/**
 * Is every module of `src/` named in the module catalogue of
 * `_copilot_guidelines/architecture.md` (qrfix13)?
 *
 * The catalogue is a table, one row per folder of `src/` (`handlers/`,
 * `utils/`, …) and per top-level file (`extension.ts`, …). A module counts as
 * named when its file name without `.ts` stands as a word in its folder's row
 * (`askUserRegistry` for `src/services/askUserRegistry.ts`; a module in a
 * subfolder by its name or `sub/name`). Reported:
 *   - missing: a module of `src/` (tests excluded) its row does not name, or a
 *     folder / top-level file without a row;
 *   - removed: a backticked name in a row that was a module of `src/` (git
 *     history: deleted `.ts` files) and is no module now;
 *   - misplaced: a backticked name in a row that is a module of another folder
 *     only (the row names a module it does not hold).
 *
 *   node scripts/check-module-catalogue.cjs          (exit 1 when anything is reported)
 *   node scripts/check-module-catalogue.cjs --json   (the report as JSON)
 */
'use strict';

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const EXT_ROOT = path.resolve(__dirname, '..');
const CATALOGUE = path.join('_copilot_guidelines', 'architecture.md');

/** Every module of `src/`: folder (`handlers/`) or top-level file (`extension.ts`) → module names. */
function srcModules(root = EXT_ROOT) {
    const src = path.join(root, 'src');
    const out = new Map();
    for (const entry of fs.readdirSync(src, { withFileTypes: true })) {
        if (entry.isFile()) {
            if (/\.ts$/.test(entry.name) && !/\.d\.ts$/.test(entry.name)) { out.set(entry.name, []); }
            continue;
        }
        if (!entry.isDirectory() || entry.name === '__tests__') { continue; }
        const names = [];
        const walk = (dir, prefix) => {
            for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
                if (e.isDirectory()) { if (e.name !== '__tests__') { walk(path.join(dir, e.name), `${prefix}${e.name}/`); } continue; }
                if (/\.ts$/.test(e.name) && !/\.d\.ts$/.test(e.name)) { names.push(`${prefix}${e.name.replace(/\.ts$/, '')}`); }
                else if (/\.json$/.test(e.name)) { names.push(`${prefix}${e.name}`); }
            }
        };
        walk(path.join(src, entry.name), '');
        out.set(`${entry.name}/`, names.sort());
    }
    return out;
}

/** The catalogue's rows: the first cell without its backticks → the row's text. */
function catalogueRows(text) {
    const start = text.indexOf('## Module catalogue');
    if (start < 0) { throw new Error(`${CATALOGUE} has no "## Module catalogue" section`); }
    const end = text.indexOf('\n## ', start + 1);
    const rows = new Map();
    for (const line of text.slice(start, end < 0 ? undefined : end).split('\n')) {
        const m = /^\|\s*`([^`]+)`\s*\|(.*)\|\s*$/.exec(line);
        if (m) { rows.set(m[1], m[2]); }
    }
    return rows;
}

const escape = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
/** `name` stands as a word in `row` (not part of a longer name). */
function names(row, name) {
    return new RegExp(`(?<![\\w-])${escape(name)}(?![\\w-])`).test(row);
}

/** Module names deleted from `src/` in git history (no tests), by base name. */
function removedModuleNames(root = EXT_ROOT) {
    try {
        const out = execFileSync('git', ['log', '--diff-filter=D', '--name-only', '--pretty=format:', '--', 'src'], { cwd: root, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
        return new Set(out.split('\n').filter((f) => /\.ts$/.test(f) && !f.includes('__tests__')).map((f) => path.basename(f, '.ts')));
    } catch {
        return new Set();
    }
}

/** The report: `{missing: [{folder, module}], removed: [{folder, name}], misplaced: [{folder, name, in}]}`. */
function check({ root = EXT_ROOT, text = fs.readFileSync(path.join(root, CATALOGUE), 'utf8'), modules = srcModules(root), removed = removedModuleNames(root) } = {}) {
    const rows = catalogueRows(text);
    const missing = [];
    for (const [folder, list] of modules) {
        const row = rows.get(folder);
        if (row === undefined) { missing.push({ folder, module: null }); continue; }
        for (const m of list) {
            const base = m.split('/').pop();
            if (!names(row, m) && !names(row, base) && !names(row, base.replace(/\.json$/, ''))) { missing.push({ folder, module: m }); }
        }
    }
    const allBases = new Map();
    for (const [folder, list] of modules) {
        for (const m of list) { const b = m.split('/').pop(); allBases.set(b, [...(allBases.get(b) ?? []), folder]); }
        if (!folder.endsWith('/')) { allBases.set(folder.replace(/\.ts$/, ''), [folder]); }
    }
    const removedNames = [];
    const misplaced = [];
    for (const [folder, row] of rows) {
        const own = new Set((modules.get(folder) ?? []).map((m) => m.split('/').pop()));
        for (const t of row.matchAll(/`([A-Za-z][\w.-]*?)(?:\.ts)?`/g)) {
            const name = t[1];
            if (own.has(name)) { continue; }
            const elsewhere = allBases.get(name);
            if (elsewhere) {
                if (folder.endsWith('/') && !elsewhere.includes(folder)) { misplaced.push({ folder, name, in: elsewhere }); }
                continue;
            }
            if (removed.has(name)) { removedNames.push({ folder, name }); }
        }
    }
    return { missing, removed: removedNames, misplaced };
}

module.exports = { check, srcModules, catalogueRows, removedModuleNames, CATALOGUE };

if (require.main === module) {
    const report = check();
    if (process.argv.includes('--json')) {
        process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
    } else {
        for (const m of report.missing) { process.stdout.write(m.module ? `missing    ${m.folder}${m.module}\n` : `missing    row for ${m.folder}\n`); }
        for (const r of report.removed) { process.stdout.write(`removed    ${r.folder} names ${r.name}, no module of src/ now\n`); }
        for (const r of report.misplaced) { process.stdout.write(`misplaced  ${r.folder} names ${r.name}, a module of ${r.in.join(', ')}\n`); }
        const n = report.missing.length + report.removed.length + report.misplaced.length;
        process.stdout.write(n ? `✖ ${n} finding(s) in ${CATALOGUE}\n` : `✔ ${CATALOGUE} names every module of src/\n`);
    }
    process.exitCode = report.missing.length + report.removed.length + report.misplaced.length ? 1 : 0;
}
