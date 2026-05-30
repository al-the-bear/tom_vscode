/**
 * `withTiming(name, fn)` — measure the wall-clock duration of a single
 * tool-test invocation, assert it stays under 5 seconds, and flush a
 * summary report to `_ai/quests/vscode_extension/tool_timings.md` at
 * process exit.
 *
 * Usage from a tool test:
 *
 *   import { withTiming } from './_timing.js';
 *
 *   test('readGlobalGuideline typical call', async () => {
 *       const result = await withTiming('tomAi_readGlobalGuideline:typical', () =>
 *           readGlobalGuidelineImpl(tmp, { fileName: 'foo.md' }));
 *       assert.match(result, /…/);
 *   });
 *
 * Why a single shared accumulator:
 *
 *   - Every numbered family in tool_test_coverage.md owes a timing
 *     entry per tool. Without a shared accumulator each file would
 *     have to write its own slice of the report — tedious and
 *     error-prone. A process-level accumulator + exit-time flush
 *     keeps the contract uniform.
 *
 *   - The report file lives in the quest folder (not under `src/`)
 *     because it's a quest deliverable, not test source. Regenerated
 *     on every `node --test` invocation that touches `withTiming`.
 *
 *   - The 5-second ceiling is the tool_test_coverage.md §0.3 gate.
 *     Tools that genuinely need longer (network bound, kernel start,
 *     etc.) should pass `expectMaxMs` to override the default and
 *     explain in their `category` why the typical case takes that
 *     long; the report still flags any entry > 5s in the header.
 *
 * Edge cases handled:
 *
 *   - Multiple test files in one `node --test` run share the same
 *     accumulator (module is cached, so a single `Set` collects all
 *     entries before the single exit hook fires).
 *   - Re-running the same `name` (e.g. inside a `for` loop) records
 *     the last observation — earlier ones are overwritten. Tests
 *     that want to record per-iteration should append a discriminator
 *     to the name (`tool:case-1`, `tool:case-2`).
 *   - When the test process aborts before exit (uncaught throw),
 *     whatever was accumulated up to that point is still flushed.
 */

import assert from 'node:assert/strict';
import * as fs from 'fs';
import * as path from 'path';

// ---------------------------------------------------------------------------
// Config — chosen to match the §0.1 / §0.3 contract.
// ---------------------------------------------------------------------------

/** Default ceiling per the tool_test_coverage.md §0.1 contract. */
export const DEFAULT_TIMING_CEILING_MS = 5000;

/**
 * Location of the report. Resolved relative to the source-tree root so
 * `node --test out/...` writes to the canonical workspace path. The
 * workspace root is the parent of `tom_ai/` — we walk up until we hit
 * `_ai/` or run out.
 */
function resolveReportPath(): string | undefined {
    let dir = process.cwd();
    for (let i = 0; i < 12; i++) {
        const cand = path.join(dir, '_ai', 'quests', 'vscode_extension');
        if (fs.existsSync(cand)) {
            return path.join(cand, 'tool_timings.md');
        }
        const parent = path.dirname(dir);
        if (parent === dir) { break; }
        dir = parent;
    }
    return undefined;
}

// ---------------------------------------------------------------------------
// Accumulator
// ---------------------------------------------------------------------------

export interface TimingEntry {
    /** Stable identifier — typically `<tool-name>:<case>`. */
    name: string;
    /** Wall-clock duration in milliseconds (rounded to 0.1). */
    ms: number;
    /** Ceiling applied. Defaults to 5000. */
    ceilingMs: number;
    /** Free-form category for the report (e.g. 'network', 'kernel'). */
    category?: string;
    /** Optional explanatory note shown in the report. */
    note?: string;
}

const accumulator = new Map<string, TimingEntry>();
let exitHookInstalled = false;

function ensureExitHook(): void {
    if (exitHookInstalled) { return; }
    exitHookInstalled = true;
    process.on('exit', () => {
        try { flushReport(); } catch { /* never block process exit on a write failure */ }
    });
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export interface WithTimingOptions {
    /** Override the 5-second default for this entry (e.g. network-bound). */
    expectMaxMs?: number;
    /** Free-form tag shown in the report ('network', 'kernel', 'fixture-heavy'). */
    category?: string;
    /** Why this entry needs the override / what 'typical' means here. */
    note?: string;
}

/**
 * Run `fn`, time it, record `{ name, ms }`, assert under the ceiling.
 * Returns whatever `fn` returns so call sites can chain assertions on
 * the same line:
 *
 *   const out = await withTiming('foo:typical', () => fooImpl(input));
 *   assert.equal(out.kind, 'ok');
 */
export async function withTiming<T>(
    name: string,
    fn: () => Promise<T> | T,
    options: WithTimingOptions = {},
): Promise<T> {
    ensureExitHook();
    const ceiling = options.expectMaxMs ?? DEFAULT_TIMING_CEILING_MS;
    const t0 = process.hrtime.bigint();
    try {
        const result = await fn();
        const ms = Number(process.hrtime.bigint() - t0) / 1_000_000;
        record(name, Math.round(ms * 10) / 10, ceiling, options);
        assert.ok(
            ms < ceiling,
            `Timing ceiling exceeded for ${name}: ${ms.toFixed(1)}ms (ceiling ${ceiling}ms). ` +
            `If this is expected (network-bound, kernel start, etc.), pass { expectMaxMs, category, note } ` +
            `to withTiming so the report header explains the override.`,
        );
        return result;
    } catch (err) {
        // Still record the timing on failure so the report shows the
        // slow path even when the assertion fails. The error then
        // propagates to the test runner.
        const ms = Number(process.hrtime.bigint() - t0) / 1_000_000;
        record(name, Math.round(ms * 10) / 10, ceiling, { ...options, note: `${options.note ?? ''} [errored]`.trim() });
        throw err;
    }
}

/** Drop accumulated entries — useful when re-running a suite inside one process. */
export function resetTimings(): void { accumulator.clear(); }

/** Read-only view of the current accumulator. Mostly for tests of this module. */
export function getTimings(): TimingEntry[] { return Array.from(accumulator.values()); }

/**
 * Force the report to be written now (also fires automatically at
 * process exit).
 *
 * **Multi-process merge**: `node --test` runs each test file in a
 * separate process, so each process's accumulator only sees its own
 * subset of entries. To get a single combined report we read whatever
 * is already on disk, merge with the in-memory accumulator (the
 * in-process value wins for the same name), and write back. The
 * merge is idempotent: re-running the same test from a fresh process
 * just refreshes that file's entries.
 *
 * A `node --test --test-reporter=spec` invocation that wants a
 * **fresh** report each run should `rm` the file before invoking
 * `node --test`. We deliberately do not auto-clear: that would lose
 * entries from other test files that ran in the same `--test` batch.
 */
export function flushReport(): void {
    const reportPath = resolveReportPath();
    if (!reportPath) { return; }  // Can't find quest folder — silently skip.
    if (accumulator.size === 0) { return; } // Nothing to write.
    fs.mkdirSync(path.dirname(reportPath), { recursive: true });
    // Merge with existing on-disk report (other test processes may
    // have written their own entries since `node --test` started).
    const merged = mergeWithExistingReport(reportPath, accumulator);
    fs.writeFileSync(reportPath, renderReportFromMap(merged), 'utf-8');
}

function mergeWithExistingReport(reportPath: string, current: Map<string, TimingEntry>): Map<string, TimingEntry> {
    const merged = new Map<string, TimingEntry>();
    // Seed with anything already in the report.
    try {
        if (fs.existsSync(reportPath)) {
            const existing = parseExistingReport(fs.readFileSync(reportPath, 'utf-8'));
            for (const e of existing) { merged.set(e.name, e); }
        }
    } catch { /* corrupt report → just start fresh from in-process state */ }
    // In-process accumulator wins for name collisions — we trust the
    // run that just finished over a stale row from a previous run.
    for (const [name, entry] of current) { merged.set(name, entry); }
    return merged;
}

/**
 * Parse the rows of an existing tool_timings.md so we can round-trip
 * the report across separate test processes. Only the canonical
 * "All recorded timings" table is parsed — the flagged section is
 * regenerated from the merged data on every write.
 */
function parseExistingReport(content: string): TimingEntry[] {
    const out: TimingEntry[] = [];
    const lines = content.split(/\r?\n/);
    let inTable = false;
    let pastHeader = false;
    for (const line of lines) {
        if (line.startsWith('## All recorded timings')) { inTable = true; continue; }
        if (!inTable) { continue; }
        if (line.startsWith('## ')) { break; } // next section
        if (!line.startsWith('|')) { continue; }
        if (!pastHeader) {
            // Skip the table header row and the separator row
            if (line.includes('---')) { pastHeader = true; }
            continue;
        }
        // Row: `| name | ms | ceiling | category | note |`
        const cells = line.split('|').map((c) => c.trim());
        // After split, first + last are empty (border bars), so cells are 1..5
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

// ---------------------------------------------------------------------------
// Internals
// ---------------------------------------------------------------------------

function record(name: string, ms: number, ceilingMs: number, options: WithTimingOptions): void {
    accumulator.set(name, { name, ms, ceilingMs, category: options.category, note: options.note });
}

function renderReport(): string {
    return renderReportFromMap(accumulator);
}

function renderReportFromMap(map: Map<string, TimingEntry>): string {
    const entries = Array.from(map.values()).sort((a, b) => b.ms - a.ms);
    const flagged = entries.filter((e) => e.ms > DEFAULT_TIMING_CEILING_MS);
    const generatedAt = new Date().toISOString();
    const lines: string[] = [];
    lines.push('# Tool Timing Report');
    lines.push('');
    lines.push(`Generated by \`withTiming()\` from \`src/tools/__tests__/_timing.ts\` on ${generatedAt}.`);
    lines.push('');
    lines.push(`Default ceiling: **${DEFAULT_TIMING_CEILING_MS} ms** (per tool_test_coverage.md §0.1).`);
    lines.push('');
    if (flagged.length > 0) {
        lines.push('## ⚠️ Entries exceeding the default 5 s ceiling');
        lines.push('');
        lines.push('| Name | ms | Ceiling | Category | Note |');
        lines.push('|---|---:|---:|---|---|');
        for (const e of flagged) {
            lines.push(`| ${e.name} | ${e.ms.toFixed(1)} | ${e.ceilingMs} | ${e.category ?? ''} | ${e.note ?? ''} |`);
        }
        lines.push('');
    }
    lines.push('## All recorded timings');
    lines.push('');
    lines.push(`Total entries: ${entries.length}. Sorted by ms descending — the slowest tools surface at the top.`);
    lines.push('');
    lines.push('| Name | ms | Ceiling | Category | Note |');
    lines.push('|---|---:|---:|---|---|');
    for (const e of entries) {
        lines.push(`| ${e.name} | ${e.ms.toFixed(1)} | ${e.ceilingMs} | ${e.category ?? ''} | ${e.note ?? ''} |`);
    }
    lines.push('');
    return lines.join('\n');
}
