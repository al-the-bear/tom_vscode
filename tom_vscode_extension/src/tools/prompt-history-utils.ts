/**
 * Pure helpers for the prompt-history tools.
 *
 * Reads the summary trail files (`<quest>.<subsystem>.prompts.md` and
 * `<quest>.<subsystem>.answers.md`) under `_ai/quests/<quest>/` — the
 * same files `loadLastNTrailExchanges` uses to rebuild history when
 * the snapshot is missing. Pairs prompt + answer by `requestId`.
 *
 * No vscode dependency — every function takes the workspace root (or
 * the quest folder) explicitly so it can be unit-tested against a
 * temp on-disk fixture.
 */

import * as fs from 'fs';
import * as path from 'path';

/**
 * Header on every entry in a summary trail file.
 * Both prompts and answers use the same shape; the keyword
 * (`PROMPT` / `ANSWER`) is what differs.
 *
 * Example: `=== PROMPT req-abc 2026-05-30T10:11:12.345Z 17 ===`
 */
export const TRAIL_HEADER_RE = /^===\s*(PROMPT|ANSWER)\s+(\S+)\s+(\S+)\s+(\d+)\s*===$/;

/** Parsed entry from a summary trail file. */
export interface TrailEntry {
    /** PROMPT or ANSWER. */
    kind: 'PROMPT' | 'ANSWER';
    /** Pairing key — same value appears on both the prompt and the answer entry. */
    requestId: string;
    /** ISO-8601 timestamp at which the entry was emitted. */
    timestamp: string;
    /** File-local monotonic counter, useful for tie-breaking. */
    sequence: number;
    /** Entry body (everything after the header, with trailing TEMPLATE: footer stripped). */
    body: string;
}

/**
 * Parse a summary trail file (newest-first, prepended entries).
 * Returns entries in file order (i.e. newest first).
 *
 * Tolerates:
 *   - missing file (returns []),
 *   - empty file (returns []),
 *   - stray text between entries (treated as body of preceding entry),
 *   - duplicate requestIds (keeps the first / newest occurrence).
 */
export function parseTrailFile(content: string): TrailEntry[] {
    const entries: TrailEntry[] = [];
    if (!content) { return entries; }
    const lines = content.split(/\r?\n/);
    let current: { kind: 'PROMPT' | 'ANSWER'; requestId: string; timestamp: string; sequence: number; buf: string[] } | undefined;
    const flush = (): void => {
        if (!current) { return; }
        const rawBody = current.buf.join('\n');
        // Strip the `TEMPLATE: …` / `ANSWER-WRAPPER: …` footer prompt
        // entries get from writeSummaryPrompt. Match starts at the
        // first occurrence of a newline followed by "TEMPLATE:" on its
        // own line (or end of body) to be safe.
        const body = rawBody.replace(/\n+TEMPLATE:\s.*(?:\n.*)*$/m, '').trim();
        entries.push({
            kind: current.kind,
            requestId: current.requestId,
            timestamp: current.timestamp,
            sequence: current.sequence,
            body,
        });
        current = undefined;
    };
    for (const line of lines) {
        const m = line.match(TRAIL_HEADER_RE);
        if (m) {
            flush();
            current = {
                kind: m[1] as 'PROMPT' | 'ANSWER',
                requestId: m[2],
                timestamp: m[3],
                sequence: parseInt(m[4], 10),
                buf: [],
            };
        } else if (current) {
            current.buf.push(line);
        }
    }
    flush();
    return entries;
}

/** Read + parse a summary trail file. Silently returns [] on read error. */
export function readTrailFile(filePath: string): TrailEntry[] {
    try {
        if (!fs.existsSync(filePath)) { return []; }
        const text = fs.readFileSync(filePath, 'utf-8');
        return parseTrailFile(text);
    } catch {
        return [];
    }
}

/** A paired prompt + answer, with metadata for listing. */
export interface PromptPair {
    /** Newest-first index in the source file (0 = most recent). */
    index: number;
    /** Stable id shared by prompt + answer entries. */
    requestId: string;
    /** From the prompt header — the time the prompt was emitted. */
    timestamp: string;
    /** Per-file monotonic sequence number. */
    sequence: number;
    /** Subsystem the pair belongs to ('anthropic', 'localllm-<config>', …). */
    subsystem: string;
    /** Quest the pair belongs to. */
    questId: string;
    /** Character count of the prompt body. */
    promptChars: number;
    /** Character count of the answer body. 0 when no matching answer exists yet. */
    answerChars: number;
    /** Whether a paired answer was found for this prompt. */
    hasAnswer: boolean;
    /** First N characters of the prompt body (default 120). */
    promptPreview: string;
    /** First N characters of the answer body. Empty when hasAnswer=false. */
    answerPreview: string;
}

/** A full pair fetch — same as PromptPair but with the full bodies attached. */
export interface PromptPairFull extends PromptPair {
    promptBody: string;
    answerBody: string;
}

/**
 * Pair prompt entries with answer entries by `requestId`. Returns the
 * pairs in the order the prompt entries appear (which is newest-first
 * for prepend-style trail files).
 *
 * Duplicate requestIds in either input are deduped (first wins) so a
 * malformed file with a repeated header still yields a clean result.
 */
export function pairPromptsAndAnswers(
    promptEntries: TrailEntry[],
    answerEntries: TrailEntry[],
    subsystem: string,
    questId: string,
    previewChars: number = 120,
): PromptPair[] {
    const answerById = new Map<string, TrailEntry>();
    for (const a of answerEntries) {
        if (!answerById.has(a.requestId)) { answerById.set(a.requestId, a); }
    }
    const seenPrompts = new Set<string>();
    const out: PromptPair[] = [];
    let i = 0;
    for (const p of promptEntries) {
        if (seenPrompts.has(p.requestId)) { continue; }
        seenPrompts.add(p.requestId);
        const a = answerById.get(p.requestId);
        out.push({
            index: i++,
            requestId: p.requestId,
            timestamp: p.timestamp,
            sequence: p.sequence,
            subsystem,
            questId,
            promptChars: p.body.length,
            answerChars: a ? a.body.length : 0,
            hasAnswer: Boolean(a),
            promptPreview: previewSlice(p.body, previewChars),
            answerPreview: a ? previewSlice(a.body, previewChars) : '',
        });
    }
    return out;
}

/** Re-pair with full bodies for the get-by-id flow. */
export function buildFullPair(
    summary: PromptPair,
    promptEntries: TrailEntry[],
    answerEntries: TrailEntry[],
): PromptPairFull {
    const p = promptEntries.find((e) => e.requestId === summary.requestId);
    const a = answerEntries.find((e) => e.requestId === summary.requestId);
    return {
        ...summary,
        promptBody: p?.body ?? '',
        answerBody: a?.body ?? '',
    };
}

function previewSlice(body: string, max: number): string {
    if (!body) { return ''; }
    // max=0 is the explicit "disable previews" knob — return empty
    // instead of slicing to "" and adding an ellipsis (which would
    // produce the misleading "…" string).
    if (max <= 0) { return ''; }
    // Collapse internal whitespace runs to single spaces for the preview;
    // the body is also clipped by length. The full body is reachable via
    // tomAi_getPromptPair.
    const flat = body.replace(/\s+/g, ' ').trim();
    return flat.length <= max ? flat : flat.slice(0, max) + '…';
}

// ---------------------------------------------------------------------------
// Subsystem file discovery
// ---------------------------------------------------------------------------

/**
 * The summary file pattern from TrailService is
 * `${ai}/quests/${quest}/${quest}.${subsystem}.{prompts,answers}.md`,
 * where `subsystem` is one of:
 *
 *   - `anthropic`
 *   - `copilot`
 *   - `localllm-<configName>`
 *   - `lm-api-<modelName>`
 *
 * `findSubsystemFiles` looks for every matching pair under a quest
 * folder. Filters by subsystem prefix if provided (so callers can ask
 * for just `anthropic` or just `localllm-*`).
 */
export interface SubsystemFiles {
    subsystem: string;
    promptsFile: string;
    answersFile: string;
}

export function findSubsystemFiles(
    questFolder: string,
    questId: string,
    subsystemFilter?: string,
): SubsystemFiles[] {
    let entries: string[];
    try {
        entries = fs.readdirSync(questFolder);
    } catch {
        return [];
    }
    const promptSuffix = '.prompts.md';
    const answerSuffix = '.answers.md';
    const questDot = `${questId}.`;
    const promptsBySubsystem = new Map<string, string>();
    const answersBySubsystem = new Map<string, string>();
    for (const name of entries) {
        if (!name.startsWith(questDot)) { continue; }
        if (name.endsWith(promptSuffix)) {
            const subsystem = name.slice(questDot.length, -promptSuffix.length);
            if (subsystem) { promptsBySubsystem.set(subsystem, path.join(questFolder, name)); }
        } else if (name.endsWith(answerSuffix)) {
            const subsystem = name.slice(questDot.length, -answerSuffix.length);
            if (subsystem) { answersBySubsystem.set(subsystem, path.join(questFolder, name)); }
        }
    }
    const subsystems = new Set<string>([...promptsBySubsystem.keys(), ...answersBySubsystem.keys()]);
    const out: SubsystemFiles[] = [];
    for (const subsystem of [...subsystems].sort()) {
        if (subsystemFilter && !matchesSubsystemFilter(subsystem, subsystemFilter)) { continue; }
        out.push({
            subsystem,
            promptsFile: promptsBySubsystem.get(subsystem) ?? '',
            answersFile: answersBySubsystem.get(subsystem) ?? '',
        });
    }
    return out;
}

/**
 * Subsystem filter accepts:
 *   - exact match: `'anthropic'`
 *   - prefix with trailing `*`: `'localllm-*'`
 *   - bare prefix that's *also* the family name (no hyphen variant): `'localllm'` matches `localllm-*` too
 */
export function matchesSubsystemFilter(subsystem: string, filter: string): boolean {
    if (!filter) { return true; }
    if (filter === subsystem) { return true; }
    if (filter.endsWith('*') && subsystem.startsWith(filter.slice(0, -1))) { return true; }
    if (subsystem.startsWith(`${filter}-`)) { return true; }
    return false;
}

// ---------------------------------------------------------------------------
// Full-pair listing/fetching helpers (call sites use these directly)
// ---------------------------------------------------------------------------

export interface ListResult {
    questId: string;
    subsystemsScanned: string[];
    totalAvailable: number;
    returned: number;
    offset: number;
    limit: number;
    pairs: PromptPair[];
}

/**
 * List paired prompt+answer summaries for a quest, optionally filtered
 * by subsystem. Returns newest-first.
 */
export function listPromptPairs(
    questFolder: string,
    questId: string,
    options: {
        subsystem?: string;
        limit?: number;
        offset?: number;
        previewChars?: number;
    } = {},
): ListResult {
    const limit = Math.max(1, Math.min(options.limit ?? 50, 500));
    const offset = Math.max(0, options.offset ?? 0);
    const previewChars = Math.max(0, options.previewChars ?? 120);
    const files = findSubsystemFiles(questFolder, questId, options.subsystem);
    // Build pairs per subsystem so the index/sequence per file is meaningful.
    const all: PromptPair[] = [];
    for (const f of files) {
        const promptEntries = readTrailFile(f.promptsFile);
        const answerEntries = readTrailFile(f.answersFile);
        all.push(...pairPromptsAndAnswers(promptEntries, answerEntries, f.subsystem, questId, previewChars));
    }
    // Sort newest-first by timestamp (string compare on ISO-8601 = chronological);
    // tiebreak by sequence within the same subsystem.
    all.sort((a, b) => {
        if (a.timestamp !== b.timestamp) { return b.timestamp.localeCompare(a.timestamp); }
        return b.sequence - a.sequence;
    });
    // Re-stamp index after merging so callers can refer back by position.
    all.forEach((p, i) => { p.index = i; });
    const slice = all.slice(offset, offset + limit);
    return {
        questId,
        subsystemsScanned: files.map((f) => f.subsystem),
        totalAvailable: all.length,
        returned: slice.length,
        offset,
        limit,
        pairs: slice,
    };
}

export interface GetResult {
    questId: string;
    subsystemsScanned: string[];
    notFoundRequestIds: string[];
    pairs: PromptPairFull[];
}

/**
 * Fetch full prompt+answer bodies. Resolution order for selecting pairs:
 *
 *   1. `requestIds` (one or more explicit ids), OR
 *   2. `index` + optional `count` — newest-first ordinal.
 *
 * Returns the full body, no truncation. Caller is responsible for
 * picking a sensible number of pairs (the runtime ceiling is 50).
 */
export function getPromptPairs(
    questFolder: string,
    questId: string,
    options: {
        subsystem?: string;
        requestIds?: string[];
        index?: number;
        count?: number;
    } = {},
): GetResult {
    const files = findSubsystemFiles(questFolder, questId, options.subsystem);
    // Parse everything up front so we can resolve both id-based and
    // index-based lookups from the same canonical ordering.
    const perSubsystem: Array<{ subsystem: string; prompts: TrailEntry[]; answers: TrailEntry[]; summary: PromptPair[] }> = [];
    for (const f of files) {
        const prompts = readTrailFile(f.promptsFile);
        const answers = readTrailFile(f.answersFile);
        const summary = pairPromptsAndAnswers(prompts, answers, f.subsystem, questId);
        perSubsystem.push({ subsystem: f.subsystem, prompts, answers, summary });
    }
    // Merged + sorted newest-first by timestamp (same ordering as listPromptPairs).
    const allSummaries: Array<PromptPair & { _subsystem: string }> = [];
    for (const s of perSubsystem) {
        for (const summary of s.summary) {
            allSummaries.push({ ...summary, _subsystem: s.subsystem });
        }
    }
    allSummaries.sort((a, b) => {
        if (a.timestamp !== b.timestamp) { return b.timestamp.localeCompare(a.timestamp); }
        return b.sequence - a.sequence;
    });
    allSummaries.forEach((p, i) => { p.index = i; });

    const requested: Array<PromptPair & { _subsystem: string }> = [];
    const notFound: string[] = [];

    if (options.requestIds && options.requestIds.length > 0) {
        const wanted = new Set(options.requestIds);
        const byId = new Map<string, PromptPair & { _subsystem: string }>();
        for (const s of allSummaries) {
            if (wanted.has(s.requestId) && !byId.has(s.requestId)) {
                byId.set(s.requestId, s);
            }
        }
        for (const id of options.requestIds) {
            const hit = byId.get(id);
            if (hit) { requested.push(hit); }
            else { notFound.push(id); }
        }
    } else {
        const start = Math.max(0, options.index ?? 0);
        const count = Math.max(1, Math.min(options.count ?? 1, 50));
        requested.push(...allSummaries.slice(start, start + count));
    }

    const fulls: PromptPairFull[] = [];
    for (const r of requested) {
        const bucket = perSubsystem.find((s) => s.subsystem === r._subsystem);
        if (!bucket) { continue; }
        fulls.push(buildFullPair(r, bucket.prompts, bucket.answers));
    }

    return {
        questId,
        subsystemsScanned: files.map((f) => f.subsystem),
        notFoundRequestIds: notFound,
        pairs: fulls,
    };
}
