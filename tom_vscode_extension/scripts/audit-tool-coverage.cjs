#!/usr/bin/env node
/**
 * audit-tool-coverage.cjs — CI / pre-push gate for the tool timing report.
 *
 * Contract (per `_ai/quests/vscode_extension/tool_test_coverage.md` §0.3):
 *
 *   - Every tool whose definition lives under `src/tools/` must have at least
 *     one entry in the timing report whose name starts with `<toolName>:`.
 *     The convention `<toolName>:<case>` lets a tool record several call
 *     shapes (`tomAi_findFiles:typical`, `tomAi_findFiles:large-fixture`).
 *   - No entry may exceed the default 5 000 ms ceiling. An entry with
 *     `ms > 5000` is a CI failure regardless of any per-test `expectMaxMs`
 *     override — the override silences the in-test assertion but does not
 *     waive the gate. Tools that legitimately need longer must be timed
 *     under a separate "typical" case that *is* under 5 s.
 *
 * Why grep the source tree instead of `require()`-ing `out/`:
 *
 *   - The compiled module imports `vscode`, which only resolves inside the
 *     extension host. Importing it in a Node script would require pulling in
 *     the test infrastructure's `_vscode-stub.js`, which would couple the
 *     audit gate to test plumbing.
 *   - The source-of-truth inventory in `tool_test_coverage.md` itself
 *     defines the canonical list with the same grep. Sharing the technique
 *     keeps the doc and the audit in lock-step — if one is wrong, both are.
 *
 * Exit codes:
 *   0  audit passed
 *   1  audit failed (missing coverage or over-ceiling entries)
 *   2  audit could not run (missing report file, source-tree malformed)
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

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

function main() {
    if (!REPORT_PATH) {
        die(2, 'Could not locate the workspace root (looking for `_ai/quests/vscode_extension/`).');
    }

    const tools = extractToolNames(SRC_TOOLS);
    if (tools.length === 0) {
        die(2, `No tools discovered under ${SRC_TOOLS}. Source tree malformed or moved?`);
    }

    if (!fs.existsSync(REPORT_PATH)) {
        die(2,
            `Timing report not found: ${REPORT_PATH}\n` +
            `  Run the test suite first to generate it:\n` +
            `    npm run compile && node --test out/tools/__tests__/*.test.js`,
        );
    }

    const entries = parseReport(fs.readFileSync(REPORT_PATH, 'utf-8'));
    const byTool = bucketByTool(entries);
    const toolSet = new Set(tools);

    // Coverage: tools without any entry.
    const missing = tools.filter((name) => !byTool.has(name)).sort();

    // Ceiling: any entry over 5 s.
    const overCeiling = entries.filter((e) => e.ms > DEFAULT_CEILING_MS);

    // Orphan: entries recorded for names not in the source tree (typo, removed tool).
    const orphans = [];
    for (const [name, es] of byTool.entries()) {
        if (!toolSet.has(name)) {
            for (const e of es) { orphans.push(e); }
        }
    }

    // ---- Header summary ----
    const total = tools.length;
    const covered = total - missing.length;
    const pct = ((covered / total) * 100).toFixed(1);
    line(`Tool timing coverage : ${covered}/${total} (${pct}%)`);
    line(`Recorded entries     : ${entries.length} across ${byTool.size} distinct tools`);
    line(`Report               : ${path.relative(EXT_ROOT, REPORT_PATH)}`);
    line('');

    // ---- Detail sections ----
    let exitCode = 0;

    if (missing.length > 0) {
        line(`✖ Missing timing entries (${missing.length}):`);
        for (const name of missing) { line(`  - ${name}`); }
        line('');
        line('  Each tool needs at least one `withTiming(\'<toolName>:<case>\', () => …)`');
        line('  call in its test file. Convention: use `:typical` for the headline case.');
        line('');
        exitCode = 1;
    }

    if (overCeiling.length > 0) {
        line(`✖ Entries exceeding the ${DEFAULT_CEILING_MS} ms ceiling (${overCeiling.length}):`);
        for (const e of overCeiling) {
            const cat = e.category ? ` [${e.category}]` : '';
            const note = e.note ? `  — ${e.note}` : '';
            line(`  - ${e.name}: ${e.ms.toFixed(1)} ms (recorded ceiling ${e.ceilingMs})${cat}${note}`);
        }
        line('');
        line('  Tools that genuinely need longer must be timed under a separate fast');
        line('  "typical" case; the slow case may still be tested but should not be');
        line('  the entry of record for coverage.');
        line('');
        exitCode = 1;
    }

    if (orphans.length > 0) {
        // Orphans are informational — they don't fail the build (the timing
        // report may legitimately retain rows from a tool that was just
        // renamed / removed; the next clean run flushes them). We surface
        // them so the next test author notices and prunes.
        line(`ℹ Orphan entries (recorded for names not in src/tools/, ${orphans.length}):`);
        for (const e of orphans) {
            line(`  - ${e.name}: ${e.ms.toFixed(1)} ms`);
        }
        line('  Delete `_ai/quests/vscode_extension/tool_timings.md` before the next');
        line('  test run to clear stale rows.');
        line('');
    }

    if (exitCode === 0) {
        line('✓ All tools have timing entries and none exceed the 5 s ceiling.');
        process.exit(0);
    }
    line('Audit failed. See `_copilot_guidelines/tool_testing.md` for the contract.');
    process.exit(exitCode);
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
 * Extract every `name: 'tomAi_<...>'` literal from the source tree.
 * Mirrors the canonical command in `tool_test_coverage.md` so the doc
 * and the audit stay in lock-step.
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

main();
