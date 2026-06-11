/**
 * Pure helpers that make the `history.json` / `history.md` snapshot pair
 * **mergeable** across machines.
 *
 * Why this exists: the snapshot is rewritten in full on every turn by
 * {@link TwoTierMemoryService.persistHistorySnapshot}. Two machines working the
 * same quest each rewrite their own copy, and `_ai` is synced via git — so the
 * files conflict. To let a git merge driver union the turns from both sides
 * without losing or duplicating any, every raw turn carries a per-entry ISO
 * timestamp (`ts`):
 *
 *   - On merge, the driver unions turns from both branches and sorts by `ts`.
 *   - For that to work the **same logical turn must carry the same `ts` on both
 *     sides**, so {@link stampRawTurns} preserves an existing turn's timestamp
 *     (matched by role+content) on every rewrite instead of re-stamping it.
 *   - Genuinely new turns (appended at the tail) get a fresh timestamp strictly
 *     after the newest existing one.
 *
 * Legacy snapshots predate the `ts` field. They are migrated on the next write:
 * because none of their entries carry a timestamp, {@link stampRawTurns} stamps
 * the whole set from "now" backwards at 1-second steps (oldest first), giving
 * the existing history a stable chronological order to build on.
 *
 * This module is **pure** (no `vscode`, no I/O beyond the caller passing data
 * in) so it is unit-testable under `node:test`.
 */

/** A raw conversation turn as persisted in the history snapshot. */
export interface SnapshotTurn {
    role: string;
    content: string;
    /** Per-entry ISO timestamp; absent in the legacy (pre-mergeable) format. */
    ts?: string;
}

/** The canonical `messages` payload shape written into the snapshot. */
export interface HistorySnapshotMessages {
    compactedSummary?: string;
    rawTurns?: SnapshotTurn[];
}

export interface HistoryMarkdownInput {
    messages: unknown;
    savedAt: string;
    questId: string;
}

/** Identity key for matching a turn across rewrites: role + content. */
function turnKey(role: string, content: string): string {
    return `${role}\u0000${content}`;
}

/**
 * A snapshot is "legacy" (needs timestamp migration) when it has at least one
 * turn and any turn is missing a non-empty `ts`.
 */
export function isLegacyHistoryFormat(turns: SnapshotTurn[]): boolean {
    return turns.length > 0 && turns.some((t) => typeof t.ts !== 'string' || t.ts.length === 0);
}

/**
 * Safely pull the raw turns out of an arbitrary persisted `messages` payload.
 * Drops anything that isn't a `{ role: string, content: string }` object;
 * preserves a present string `ts`.
 */
export function extractRawTurns(messages: unknown): SnapshotTurn[] {
    if (!messages || typeof messages !== 'object' || Array.isArray(messages)) {
        return [];
    }
    const raw = (messages as { rawTurns?: unknown }).rawTurns;
    if (!Array.isArray(raw)) {
        return [];
    }
    const out: SnapshotTurn[] = [];
    for (const m of raw) {
        if (!m || typeof m !== 'object') { continue; }
        const role = (m as { role?: unknown }).role;
        const content = (m as { content?: unknown }).content;
        if (typeof role !== 'string' || typeof content !== 'string') { continue; }
        const ts = (m as { ts?: unknown }).ts;
        out.push(typeof ts === 'string' && ts.length > 0
            ? { role, content, ts }
            : { role, content });
    }
    return out;
}

/**
 * Assign a stable per-entry `ts` to every turn in `next`.
 *
 * - Turns that already exist in `prev` (matched by role+content, in order, so
 *   duplicates are consumed left-to-right) keep their previous timestamp.
 * - When **no** previous turn carried a timestamp (a fresh or legacy snapshot),
 *   the whole set is stamped from `nowMs` backwards at 1-second steps, oldest
 *   first — this is the one-shot migration of the legacy format.
 * - Otherwise, unmatched turns (new tail entries) are stamped strictly after
 *   the newest preserved timestamp, 1 ms apart, so ordering is total.
 */
export function stampRawTurns(
    next: SnapshotTurn[],
    prev: SnapshotTurn[],
    nowMs: number,
): SnapshotTurn[] {
    // Queue of available prior timestamps per identity, in document order.
    const available = new Map<string, string[]>();
    for (const p of prev) {
        if (typeof p.ts !== 'string' || p.ts.length === 0) { continue; }
        const key = turnKey(p.role, p.content);
        const list = available.get(key);
        if (list) { list.push(p.ts); } else { available.set(key, [p.ts]); }
    }

    // First pass: preserve matched timestamps, leave the rest undefined.
    const result: SnapshotTurn[] = next.map((t) => {
        const list = available.get(turnKey(t.role, t.content));
        const ts = list && list.length > 0 ? list.shift() : undefined;
        return { role: t.role, content: t.content, ts };
    });

    const missing = result.filter((r) => !r.ts);
    if (missing.length === 0) {
        return result;
    }

    const anyPreserved = result.some((r) => !!r.ts);
    if (!anyPreserved) {
        // Migration / fresh: stamp backwards from now, 1s apart, oldest first.
        const n = result.length;
        for (let i = 0; i < n; i++) {
            result[i].ts = new Date(nowMs - (n - 1 - i) * 1000).toISOString();
        }
        return result;
    }

    // Forward-assign new turns strictly after the newest preserved timestamp.
    const newestPreserved = result.reduce((max, r) => {
        if (!r.ts) { return max; }
        const ms = Date.parse(r.ts);
        return Number.isNaN(ms) ? max : Math.max(max, ms);
    }, Number.NEGATIVE_INFINITY);
    let base = Math.max(nowMs, newestPreserved + 1);
    for (const r of result) {
        if (!r.ts) {
            r.ts = new Date(base).toISOString();
            base += 1;
        }
    }
    return result;
}

/**
 * Render a persisted session history payload as human-readable Markdown.
 *
 * Handles the canonical shape (`{ compactedSummary, rawTurns }`) with nicely
 * formatted sections; anything else falls through to a raw-JSON code block so
 * the file is still openable without a parser. Each raw-turn heading carries
 * its per-entry timestamp so the `.md` itself records the mergeable ordering.
 *
 * Written next to every `history.json` (see `persistHistorySnapshot`) so the
 * "Open session history" button in the chat panels has a single stable path to
 * open in the MD Browser.
 */
export function formatHistoryAsMarkdown(input: HistoryMarkdownInput): string {
    const { messages, savedAt, questId } = input;
    const lines: string[] = [];
    lines.push(`# Session history — \`${questId}\``);
    lines.push('');
    lines.push(`_Saved at ${savedAt}._`);
    lines.push('');

    // --- Canonical shape: { compactedSummary, rawTurns } ---
    if (messages && typeof messages === 'object' && !Array.isArray(messages)) {
        const obj = messages as { compactedSummary?: unknown };
        const summary = typeof obj.compactedSummary === 'string' ? obj.compactedSummary : '';
        const rawTurns = extractRawTurns(messages);

        lines.push(`## Compacted summary — ${summary.length} chars`);
        lines.push('');
        if (!summary) {
            lines.push('_(empty — no turns have been compacted into the summary yet.)_');
        } else {
            lines.push(summary);
        }
        lines.push('');
        lines.push(`## Raw turns — ${rawTurns.length} messages`);
        lines.push('');
        if (rawTurns.length === 0) {
            lines.push('_(empty — fresh session or just after a clear.)_');
        } else {
            for (let i = 0; i < rawTurns.length; i++) {
                const m = rawTurns[i];
                const stamp = m.ts ? ` — ${m.ts}` : '';
                lines.push(`### [${i + 1}] ${m.role} — ${m.content.length} chars${stamp}`);
                lines.push('');
                lines.push(m.content);
                lines.push('');
            }
        }
        return lines.join('\n');
    }

    // --- Fallback: raw JSON dump so the file is still inspectable ---
    lines.push('## Raw payload');
    lines.push('');
    lines.push('```json');
    lines.push(JSON.stringify(messages, null, 2));
    lines.push('```');
    return lines.join('\n');
}
