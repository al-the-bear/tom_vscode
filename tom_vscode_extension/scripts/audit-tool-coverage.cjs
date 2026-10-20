#!/usr/bin/env node
/**
 * audit-tool-coverage.cjs — CI / pre-push gate for the tool timing report.
 *
 * Contract (see _copilot_guidelines/tool_testing.md § CI gate):
 *
 *   - Every REGISTERED tool (ALL_SHARED_TOOLS) must have at least one entry
 *     in the timing report whose name starts with `<toolName>:`. The
 *     convention `<toolName>:<case>` lets a tool record several call shapes
 *     (`tomAi_findFiles:typical`, `tomAi_findFiles:large-fixture`).
 *   - No entry may exceed the default 5 000 ms ceiling. An entry with
 *     `ms > 5000` is a CI failure regardless of any per-test `expectMaxMs`
 *     override — the override silences the in-test assertion but does not
 *     waive the gate. Tools that legitimately need longer must be timed
 *     under a separate "typical" case that *is* under 5 s.
 *   - A `name: 'tomAi_…'` literal in src/tools/*.ts that is not registered
 *     fails: a tool nobody can call.
 *
 * The inventory is the registry itself, read from the compiled extension
 * (`out/`) under the shared vscode test stub, as tool-registry-parity.test.ts
 * reads it. A grep of the source used to be the inventory and missed every
 * tool defined through a factory, in a subfolder or with double quotes —
 * while reporting full coverage. `npm test` compiles and runs the tests
 * before the audit, so `out/` is current there.
 *
 * Exit codes:
 *   0  audit passed
 *   1  audit failed (missing coverage, over-ceiling entries, a defined tool not registered)
 *   2  audit could not run (missing report file, no compiled registry, an empty registry)
 */

'use strict';

const fs = require('fs');
const path = require('path');

// ---------------------------------------------------------------------------
// Paths
// ---------------------------------------------------------------------------

const EXT_ROOT = path.resolve(__dirname, '..');                              // tom_vscode_extension/
const SRC_TOOLS = path.join(EXT_ROOT, 'src', 'tools');
// Walk up to find the workspace root (the parent of `tom_ai/`).
const WORKSPACE_ROOT = findWorkspaceRoot(EXT_ROOT);
const REPORT_PATH = WORKSPACE_ROOT
    ? path.join(WORKSPACE_ROOT, '_ai', 'quests', 'vscode_extension', 'tool_timings.md')
    : null;

const DEFAULT_CEILING_MS = 5000;

/**
 * Tools defined in src/tools/ that are deliberately not registered, each with
 * the reason. An entry here that IS registered (or no longer defined) fails,
 * so the list cannot outlive what it excuses.
 */
const KNOWN_UNREGISTERED = {
    tomAi_sendQueueItem: 'dropped from ALL_SHARED_TOOLS in March 2026 (5a23df5) without a stated reason while '
        + 'doc/llm_tools.md still lists it; register it or delete it — todo vsd8',
};

// ---------------------------------------------------------------------------
// The audit
// ---------------------------------------------------------------------------

/**
 * The audit over its inputs, without IO:
 *
 * - `registered` — the tool names in ALL_SHARED_TOOLS: the inventory;
 * - `defined` — the `name: 'tomAi_…'` literals in src/tools/*.ts, a
 *   cross-check only: a defined name that is not registered is a tool
 *   nobody can call;
 * - `entries` — the rows of the timing report.
 *
 * A registered tool without a timing row fails (`missing`), whatever way it
 * was defined (a factory, a subfolder, double quotes); a row over the ceiling
 * fails; a row for a name that is not registered is an orphan (information).
 * Answers the findings, the lines to print and the exit code.
 */
function auditToolCoverage({ registered, defined, entries, ceilingMs = DEFAULT_CEILING_MS, knownUnregistered = KNOWN_UNREGISTERED }) {
    const tools = Array.from(new Set(registered)).sort();
    const toolSet = new Set(tools);
    const byTool = bucketByTool(entries);
    const missing = tools.filter((name) => !byTool.has(name));
    const overCeiling = entries.filter((e) => e.ms > ceilingMs);
    const definedSet = new Set(defined);
    const unregistered = Array.from(definedSet).filter((name) => !toolSet.has(name) && !(name in knownUnregistered)).sort();
    const staleExceptions = Object.keys(knownUnregistered).filter((name) => toolSet.has(name) || !definedSet.has(name)).sort();
    const excused = Object.keys(knownUnregistered).filter((name) => !staleExceptions.includes(name)).sort();
    const orphans = [];
    for (const [name, es] of byTool.entries()) {
        if (!toolSet.has(name)) { for (const e of es) { orphans.push(e); } }
    }
    const out = [];
    const total = tools.length;
    const covered = total - missing.length;
    const pct = total === 0 ? '0.0' : ((covered / total) * 100).toFixed(1);
    out.push(`Tool timing coverage : ${covered}/${total} (${pct}%)`);
    out.push(`Recorded entries     : ${entries.length} across ${byTool.size} distinct tools`);
    let exitCode = 0;
    if (total === 0) {
        out.push('✖ The registry holds no tool: nothing was audited.');
        exitCode = 2;
    }
    if (missing.length > 0) {
        out.push('', `✖ Missing timing entries (${missing.length}):`, ...missing.map((n) => `  - ${n}`), '',
            '  Each tool needs at least one `withTiming(\'<toolName>:<case>\', () => …)`',
            '  call in its test file. Convention: use `:typical` for the headline case.');
        exitCode = exitCode || 1;
    }
    if (overCeiling.length > 0) {
        out.push('', `✖ Entries exceeding the ${ceilingMs} ms ceiling (${overCeiling.length}):`);
        for (const e of overCeiling) {
            const cat = e.category ? ` [${e.category}]` : '';
            const note = e.note ? `  — ${e.note}` : '';
            out.push(`  - ${e.name}: ${e.ms.toFixed(1)} ms (recorded ceiling ${e.ceilingMs})${cat}${note}`);
        }
        out.push('', '  Tools that genuinely need longer must be timed under a separate fast',
            '  "typical" case; the slow case may still be tested but should not be',
            '  the entry of record for coverage.');
        exitCode = exitCode || 1;
    }
    if (unregistered.length > 0) {
        out.push('', `✖ Defined in src/tools/ but not registered in ALL_SHARED_TOOLS (${unregistered.length}):`,
            ...unregistered.map((n) => `  - ${n}`), '',
            '  Add the tool to ALL_SHARED_TOOLS (tool-executors.ts), or remove the definition.');
        exitCode = exitCode || 1;
    }
    if (staleExceptions.length > 0) {
        out.push('', `✖ KNOWN_UNREGISTERED entries that no longer apply (${staleExceptions.length}):`,
            ...staleExceptions.map((n) => `  - ${n}: ${toolSet.has(n) ? 'registered now' : 'no longer defined'}`), '',
            '  Remove them from KNOWN_UNREGISTERED in scripts/audit-tool-coverage.cjs.');
        exitCode = exitCode || 1;
    }
    if (excused.length > 0) {
        out.push('', `ℹ Defined but deliberately not registered (${excused.length}):`,
            ...excused.map((n) => `  - ${n}: ${knownUnregistered[n]}`));
    }
    if (orphans.length > 0) {
        // Information only: the report may keep rows of a tool that was just
        // renamed or removed; the next clean run drops them.
        out.push('', `ℹ Orphan entries (recorded for names that are not registered, ${orphans.length}):`,
            ...orphans.map((e) => `  - ${e.name}: ${e.ms.toFixed(1)} ms`),
            '  Delete `_ai/quests/vscode_extension/tool_timings.md` before the next',
            '  test run to clear stale rows.');
    }
    out.push('');
    out.push(exitCode === 0
        ? '✓ All registered tools have timing entries and none exceed the 5 s ceiling.'
        : 'Audit failed. See `_copilot_guidelines/tool_testing.md` for the contract.');
    return { tools, missing, overCeiling, unregistered, staleExceptions, orphans, exitCode, lines: out };
}

/**
 * The names in ALL_SHARED_TOOLS, read from the compiled extension under the
 * shared vscode test stub (as tool-registry-parity.test.ts does): the
 * registry is the truth, however a tool is defined.
 */
function loadRegisteredTools(outDir = path.join(EXT_ROOT, 'out')) {
    const stubPath = path.join(outDir, 'tools', '__tests__', '_vscode-stub.js');
    const executorsPath = path.join(outDir, 'tools', 'tool-executors.js');
    if (!fs.existsSync(stubPath) || !fs.existsSync(executorsPath)) {
        throw new Error(`The compiled extension is missing (${path.relative(EXT_ROOT, executorsPath)}). Run \`npm run compile\` first.`);
    }
    require(stubPath).installVscodeStub({});
    const { ALL_SHARED_TOOLS } = require(executorsPath);
    return ALL_SHARED_TOOLS.map((t) => t.name);
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

function main() {
    if (!REPORT_PATH) {
        die(2, 'Could not locate the workspace root (looking for `_ai/quests/vscode_extension/`).');
    }
    if (!fs.existsSync(REPORT_PATH)) {
        die(2,
            `Timing report not found: ${REPORT_PATH}\n` +
            `  Run the test suite first to generate it:\n` +
            `    npm run compile && npm run test:tools`,
        );
    }
    let registered;
    try {
        registered = loadRegisteredTools();
    } catch (e) {
        die(2, `Could not read the tool registry: ${e.message}`);
    }
    const result = auditToolCoverage({
        registered,
        defined: extractToolNames(SRC_TOOLS),
        entries: parseReport(fs.readFileSync(REPORT_PATH, 'utf-8')),
    });
    result.lines.splice(2, 0, `Report               : ${path.relative(EXT_ROOT, REPORT_PATH)}`);
    for (const l of result.lines) { line(l); }
    // Exit through the event loop's end: the registry's modules may hold timers.
    process.exit(result.exitCode);
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Walk up from `start` looking for the workspace root marker
 * (`_ai/quests/vscode_extension/`). Cap the walk at 12 levels so we
 * fail fast instead of climbing past `/`.
 */
function findWorkspaceRoot(start) {
    let dir = start;
    for (let i = 0; i < 12; i++) {
        if (fs.existsSync(path.join(dir, '_ai', 'quests', 'vscode_extension'))) {
            return dir;
        }
        const parent = path.dirname(dir);
        if (parent === dir) { break; }
        dir = parent;
    }
    return null;
}

/**
 * Every `name: 'tomAi_<...>'` literal in src/tools/*.ts — the cross-check
 * against the registry (a tool defined there but never registered), not the
 * inventory: a tool built by a factory or kept elsewhere is not found by it.
 */
function extractToolNames(srcDir) {
    const NAME_RE = /name:\s*'(tomAi_[A-Za-z0-9_]+)'/g;
    const names = new Set();
    for (const entry of fs.readdirSync(srcDir)) {
        if (!entry.endsWith('.ts')) { continue; }
        // Skip the test folder — its tools are fakes.
        if (entry === '__tests__') { continue; }
        const abs = path.join(srcDir, entry);
        if (!fs.statSync(abs).isFile()) { continue; }
        const content = fs.readFileSync(abs, 'utf-8');
        let m;
        while ((m = NAME_RE.exec(content)) !== null) {
            names.add(m[1]);
        }
    }
    return Array.from(names).sort();
}

/**
 * Parse the "All recorded timings" table from a tool_timings.md file.
 * Returns `{ name, ms, ceilingMs, category, note }[]`. Robust to extra
 * whitespace and missing optional cells. Shares the parsing shape with
 * `src/tools/__tests__/_timing.ts#parseExistingReport` — keep them in
 * sync if the report format changes.
 */
function parseReport(content) {
    const out = [];
    const lines = content.split(/\r?\n/);
    let inTable = false;
    let pastHeader = false;
    for (const line of lines) {
        if (line.startsWith('## All recorded timings')) { inTable = true; pastHeader = false; continue; }
        if (!inTable) { continue; }
        if (line.startsWith('## ')) { break; }
        if (!line.startsWith('|')) { continue; }
        if (!pastHeader) {
            if (line.includes('---')) { pastHeader = true; }
            continue;
        }
        const cells = line.split('|').map((c) => c.trim());
        // Border bars produce empty first + last cells; useful cells are 1..5.
        if (cells.length < 6) { continue; }
        const name = cells[1];
        const ms = parseFloat(cells[2]);
        const ceiling = parseFloat(cells[3]);
        if (!name || !Number.isFinite(ms) || !Number.isFinite(ceiling)) { continue; }
        out.push({
            name,
            ms,
            ceilingMs: ceiling,
            category: cells[4] || undefined,
            note: cells[5] || undefined,
        });
    }
    return out;
}

/** Group entries by the part of `name` before the first colon. */
function bucketByTool(entries) {
    const map = new Map();
    for (const e of entries) {
        const sep = e.name.indexOf(':');
        const toolName = sep === -1 ? e.name : e.name.slice(0, sep);
        if (!map.has(toolName)) { map.set(toolName, []); }
        map.get(toolName).push(e);
    }
    return map;
}

function line(s) { process.stdout.write(`${s}\n`); }

function die(code, msg) {
    process.stderr.write(`✖ ${msg}\n`);
    process.exit(code);
}

// ---------------------------------------------------------------------------

module.exports = { auditToolCoverage, loadRegisteredTools, extractToolNames, parseReport, DEFAULT_CEILING_MS, KNOWN_UNREGISTERED };

if (require.main === module) { main(); }
