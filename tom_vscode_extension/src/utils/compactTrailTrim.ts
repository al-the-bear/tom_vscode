/**
 * The compact trail's limit: every writer of the summary pair
 * (`<quest>.<subsystem>.prompts.md` / `.answers.md`) trims through these
 * functions, so no file grows past `trail.compact.maxEntries`.
 *
 * A compact trail file holds one entry per prompt or answer turn, newest
 * first, each opening with a header line
 * `=== PROMPT|ANSWER <requestId> <timestamp> <sequence> ===`. The limit counts
 * turns: the distinct request ids, so a turn written twice (an answer after an
 * error, a resend) counts once. Inner steps (tool calls, rounds) are never
 * entries of this file. The trim keeps the newest turns and drops every older
 * entry at once, however far the file is over the limit (a file grown by an
 * older build, or merged from two copies, is brought back in one write).
 *
 * `trail.raw.maxEntries` is not read here: the raw trail is limited by
 * `trail.raw.maxRawFiles`.
 */

import * as fs from 'fs';

/** The default of `trail.compact.maxEntries`. */
export const COMPACT_TRAIL_DEFAULT_MAX_ENTRIES = 2000;

/** A compact trail entry's header line; group 1 the kind, 2 the request id. */
const HEADER = /^=== (PROMPT|ANSWER) (\S+) \S+ \d+ ===\s*$/;

/** `trail.compact.maxEntries` of a trail config section, else the default. */
export function compactTrailMaxEntries(trail: unknown): number {
    const compact = (trail as { compact?: { maxEntries?: unknown } } | undefined)?.compact;
    const value = compact?.maxEntries;
    return typeof value === 'number' && Number.isFinite(value) && value >= 1 ? Math.floor(value) : COMPACT_TRAIL_DEFAULT_MAX_ENTRIES;
}

/** The turns (distinct request ids) of a compact trail text. */
export function countCompactTrailTurns(content: string): number {
    const ids = new Set<string>();
    for (const line of content.split('\n')) {
        const m = HEADER.exec(line);
        if (m) { ids.add(m[2]); }
    }
    return ids.size;
}

/**
 * The text with only its newest `maxEntries` turns, or `undefined` when it is
 * within the limit. Text before the first header (none in a file the writers
 * made) is kept.
 */
export function trimCompactTrailContent(content: string, maxEntries: number): string | undefined {
    const max = Math.max(1, Math.floor(maxEntries));
    const lines = content.split('\n');
    const ids = new Set<string>();
    for (let i = 0; i < lines.length; i++) {
        const m = HEADER.exec(lines[i]);
        if (!m) { continue; }
        if (!ids.has(m[2]) && ids.size === max) {
            return lines.slice(0, i).join('\n').trimEnd() + '\n';
        }
        ids.add(m[2]);
    }
    return undefined;
}

/** Trim a compact trail file in place to its newest `maxEntries` turns; true when it was written. */
export function trimCompactTrailFile(filePath: string, maxEntries: number): boolean {
    let content: string;
    try { content = fs.readFileSync(filePath, 'utf-8'); } catch { return false; }
    const trimmed = trimCompactTrailContent(content, maxEntries);
    if (trimmed === undefined) { return false; }
    fs.writeFileSync(filePath, trimmed, 'utf-8');
    return true;
}
