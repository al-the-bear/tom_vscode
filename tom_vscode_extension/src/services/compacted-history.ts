/**
 * Block-formatted compacted history (`_ai/quests/<quest>/history/compacted_history.md`).
 *
 * Each block is a section of distilled session state with two timestamps:
 *
 *   - `created`  — when the block first appeared. Never changes for the
 *                  lifetime of that block (semantic identity).
 *   - `modified` — last time the LLM rewrote the body. Used by merge logic
 *                  (`dedupAndSort`) to pick the freshest version when two
 *                  machines bring back overlapping blocks via git.
 *
 * On-disk format — one block per region between `<!-- tom:block -->` and
 * `<!-- /tom:block -->` markers, written newest-block-last so the file
 * reads top-to-bottom as a chronological narrative:
 *
 *   <!-- tom:block created="2026-05-12T10:01:23.456Z" modified="2026-05-30T15:44:01.000Z" -->
 *   - Decision: dropped the speculative `none` history mode.
 *   - File: `src/services/history-compaction.ts` (rewrote runFull).
 *   <!-- /tom:block -->
 *
 * Why two timestamps:
 *
 *   The compaction LLM may rewrite an existing block's body (e.g. correct
 *   a fact, add a follow-up entry) but it MUST NOT change the block's
 *   `created` stamp — that stamp is the block's identity. `modified`
 *   carries "how fresh this version of the body is", so when two
 *   machines compact concurrently and their pulls collide, the union
 *   (grouped by `created`) keeps the higher `modified` per group.
 *
 *   `diffAndStamp(prev, next)` enforces this. It receives the LLM's
 *   raw output (no `modified` stamps) and the previous on-disk blocks,
 *   then:
 *     - For each new block: copy `created` from prev when bodies are
 *       semantically the same; bump `modified` to "now" when bodies
 *       differ; brand-new blocks get `modified = created = now`.
 *
 * The module is intentionally side-effect-free except for the FS read
 * in `loadFromDisk` and the FS write in `saveToDisk`. Callers own the
 * in-memory state; this module just turns it into / from disk.
 */

import * as fs from 'fs';
import * as path from 'path';

/** Filename inside the quest's `history/` folder. */
export const COMPACTED_HISTORY_FILENAME = 'compacted_history.md';

/** Block markers — kept short so they don't dominate the file's reading flow. */
const BLOCK_OPEN_RE = /^<!--\s*tom:block\s+([^>]*?)-->\s*$/;
const BLOCK_CLOSE_RE = /^<!--\s*\/tom:block\s*-->\s*$/;

export interface Block {
    /** ISO-8601 timestamp the block was first created. Identity field. */
    created: string;
    /** ISO-8601 timestamp the body was last rewritten. */
    modified: string;
    /** Block body — markdown, may contain bullets, prose, code fences. */
    body: string;
}

// ---------------------------------------------------------------------------
// Parse / serialise
// ---------------------------------------------------------------------------

function parseAttrs(attrs: string): { created?: string; modified?: string } {
    const out: { created?: string; modified?: string } = {};
    // Match key="value" pairs. Quote-tolerant: accepts both " and '.
    const re = /(\w+)=("[^"]*"|'[^']*')/g;
    let m: RegExpExecArray | null;
    while ((m = re.exec(attrs)) !== null) {
        const key = m[1];
        const raw = m[2];
        const val = raw.slice(1, -1);
        if (key === 'created') {
            out.created = val;
        } else if (key === 'modified') {
            out.modified = val;
        }
    }
    return out;
}

/**
 * Parse a block-formatted file body into a `Block[]`. Blocks lacking a
 * `created` attribute are dropped (parser cannot assign identity without
 * it). Missing `modified` falls back to `created` (the block has never
 * been edited since its initial write).
 *
 * Anything outside `<!-- tom:block -->`/`<!-- /tom:block -->` markers is
 * ignored — the file can carry a top-of-file comment block without
 * confusing the parser.
 */
export function parseBlocks(text: string): Block[] {
    const blocks: Block[] = [];
    if (!text) { return blocks; }
    const lines = text.split(/\r?\n/);
    let i = 0;
    while (i < lines.length) {
        const openMatch = lines[i].match(BLOCK_OPEN_RE);
        if (!openMatch) { i++; continue; }
        const attrs = parseAttrs(openMatch[1] ?? '');
        const created = attrs.created;
        if (!created) { i++; continue; }
        const modified = attrs.modified ?? created;
        // Collect body lines until the matching close marker (or EOF).
        const body: string[] = [];
        i++;
        while (i < lines.length && !BLOCK_CLOSE_RE.test(lines[i])) {
            body.push(lines[i]);
            i++;
        }
        // Skip the close marker line if we found one.
        if (i < lines.length) { i++; }
        blocks.push({
            created,
            modified,
            body: stripBoundaryBlankLines(body.join('\n')),
        });
    }
    return blocks;
}

/** Strip leading/trailing blank lines from a body but preserve internal
 *  blank lines (markdown rendering depends on them). */
function stripBoundaryBlankLines(s: string): string {
    return s.replace(/^(?:[ \t]*\r?\n)+/, '').replace(/(?:[ \t]*\r?\n)+$/, '');
}

/**
 * Serialise a `Block[]` back to disk format. Output is one block per
 * region, separated by a single blank line so the file reads cleanly
 * when opened directly in an editor. Bodies are emitted with a leading
 * + trailing newline so the close marker sits on its own line.
 */
export function serialiseBlocks(blocks: Block[]): string {
    return blocks
        .map((b) => (
            `<!-- tom:block created="${b.created}" modified="${b.modified}" -->\n` +
            `${b.body}\n` +
            `<!-- /tom:block -->`
        ))
        .join('\n\n') + (blocks.length > 0 ? '\n' : '');
}

// ---------------------------------------------------------------------------
// Dedup + sort
// ---------------------------------------------------------------------------

/**
 * Dedup blocks by `created` (the identity field) and sort chronologically
 * by `created`. When two blocks share a `created` timestamp, the one with
 * the higher (newer) `modified` wins — this is the post-merge fixup that
 * collapses parallel edits to the same block from two machines.
 *
 * Tie-break when `modified` is also equal: the input's later entry wins
 * (stable behaviour for caller-controlled ordering).
 */
export function dedupAndSort(blocks: Block[]): Block[] {
    const byCreated = new Map<string, Block>();
    for (const b of blocks) {
        const prev = byCreated.get(b.created);
        if (!prev) {
            byCreated.set(b.created, b);
            continue;
        }
        if (b.modified >= prev.modified) {
            byCreated.set(b.created, b);
        }
    }
    return Array.from(byCreated.values()).sort((a, b) => a.created.localeCompare(b.created));
}

// ---------------------------------------------------------------------------
// Diff + stamp
// ---------------------------------------------------------------------------

/**
 * Compute the new `modified` timestamps for an LLM-emitted block set.
 *
 * The LLM is shown the existing blocks WITH their `created` stamps but
 * WITHOUT `modified` stamps, and is asked to emit the FULL updated set
 * in chronological order. Its output therefore carries `created` (the
 * block's identity) but no `modified` field; this function fills it in.
 *
 * Rules:
 *   - A block whose `created` matches a prior block AND whose body is
 *     byte-identical to the prior body → keep the prior `modified`.
 *   - A block whose `created` matches a prior block but whose body
 *     differs → stamp `modified = now`.
 *   - A block with a new `created` (not in `prev`) → stamp
 *     `modified = now` (same as `created` for brand-new blocks).
 *
 * Returns a NEW array — does not mutate inputs.
 */
export function diffAndStamp(
    prev: Block[],
    next: Array<{ created: string; body: string }>,
    nowIso: string = new Date().toISOString(),
): Block[] {
    const prevByCreated = new Map(prev.map((b) => [b.created, b] as const));
    return next.map((n) => {
        const before = prevByCreated.get(n.created);
        if (before && normaliseBody(before.body) === normaliseBody(n.body)) {
            // Unchanged content — preserve `modified`.
            return { created: n.created, modified: before.modified, body: n.body };
        }
        // Edited or brand-new — stamp fresh `modified`.
        return { created: n.created, modified: nowIso, body: n.body };
    });
}

/** Normalise a body for content equality: collapse trailing whitespace
 *  on each line + drop leading/trailing blank lines. Mid-paragraph
 *  whitespace stays intact so a meaningful edit isn't masked by it. */
function normaliseBody(s: string): string {
    return stripBoundaryBlankLines(
        s.split(/\r?\n/).map((line) => line.replace(/[ \t]+$/, '')).join('\n'),
    );
}

// ---------------------------------------------------------------------------
// Concat bodies (for outgoing-message `${compactedSummary}` placeholder)
// ---------------------------------------------------------------------------

/**
 * Concatenate every block's body in chronological order, separated by
 * blank lines. The result is what callers pass to the model as the
 * `${compactedSummary}` placeholder — block markers + timestamps are
 * stripped so the model sees pure summary prose. The serialised file
 * with markers stays on disk for the next compaction round.
 */
export function concatenateBodies(blocks: Block[]): string {
    return blocks.map((b) => stripBoundaryBlankLines(b.body)).join('\n\n');
}

/**
 * Render an LLM-facing view of the existing blocks with `created`
 * stamps preserved but `modified` stamps stripped. The compaction
 * prompt's `${existingBlocks}` placeholder consumes this so the model
 * sees the identity of each block (and can't accidentally change it)
 * but isn't tempted to copy a stale `modified` stamp back.
 */
export function renderBlocksForLlm(blocks: Block[]): string {
    return blocks
        .map((b) => (
            `<!-- tom:block created="${b.created}" -->\n` +
            `${b.body}\n` +
            `<!-- /tom:block -->`
        ))
        .join('\n\n');
}

// ---------------------------------------------------------------------------
// Disk IO
// ---------------------------------------------------------------------------

/** Absolute path to `compacted_history.md` inside the given history folder. */
export function compactedHistoryPath(historyFolder: string): string {
    return path.join(historyFolder, COMPACTED_HISTORY_FILENAME);
}

/**
 * Read + parse `compacted_history.md`. Returns `[]` when the file is
 * absent or unreadable — callers treat that as "no compacted state yet"
 * and may fall back to the legacy `history.json` migration path.
 */
export function loadFromDisk(historyFolder: string): Block[] {
    const target = compactedHistoryPath(historyFolder);
    try {
        if (!fs.existsSync(target)) { return []; }
        const text = fs.readFileSync(target, 'utf-8');
        return parseBlocks(text);
    } catch {
        return [];
    }
}

/**
 * Atomic-ish write of `compacted_history.md`. Writes via `*.tmp` +
 * rename so a crash mid-write leaves either the old file or the new
 * file — never a half-written file that fails to parse on the next
 * session start.
 *
 * Returns true on a successful write, false on I/O error. Persistence
 * failure must never affect the user-visible turn result, so the
 * normal failure path is "log + continue" (callers swallow false).
 */
export function saveToDisk(historyFolder: string, blocks: Block[]): boolean {
    try {
        if (!fs.existsSync(historyFolder)) {
            fs.mkdirSync(historyFolder, { recursive: true });
        }
        const target = compactedHistoryPath(historyFolder);
        const tmp = target + '.tmp';
        fs.writeFileSync(tmp, serialiseBlocks(blocks), 'utf-8');
        fs.renameSync(tmp, target);
        return true;
    } catch {
        return false;
    }
}
