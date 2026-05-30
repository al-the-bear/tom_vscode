/**
 * Past Tool Access — tools that let the model look back at earlier
 * tool calls + their full results without us having to push all of
 * that history into every outgoing prompt.
 *
 *   tomAi_listPastToolCalls    — filter/browse the in-memory buffer
 *   tomAi_searchPastToolResults — regex across past result bodies
 *   tomAi_readPastToolResult   — fetch one full result by key (ring
 *                                 buffer first, then disk store)
 *
 * ## Storage layering (the a-row's "ring-buffer + disk-store layering")
 *
 *   - **Ring buffer** (`services/tool-trail.ts`): in-memory, session-
 *     scoped, default 40 entries, never survives a window reload.
 *     `list` and `search` only read the ring buffer — that's what
 *     "available in this session" means.
 *   - **Disk store** (`services/tool-result-store.ts`): on-disk
 *     `${ai}/trail/<subsystem>/<quest>/tool_results/<key>.json` —
 *     one file per call, written on every `ToolTrail.add()`,
 *     survives ring-buffer eviction AND window reload. `read` falls
 *     back to disk when the key isn't in the ring buffer, so a stub
 *     like `[Past tool call t14 — …]` printed by an older round still
 *     resolves.
 *
 * ## Key format (the a-row's "key format (`tNN`)")
 *
 * Keys are `t<n>` strings (`t1`, `t2`, `t14`, …) assigned by the
 * `ToolTrail` in call order. The model frequently passes bare
 * numbers (`"14"`) thinking they're row numbers — `readPastToolResult`
 * **normalises bare numerics by prepending `t`** so `key: "14"` and
 * `key: "t14"` resolve to the same entry. Documented + tested.
 *
 * ## Coverage entry #32 refactor (audit notes)
 *
 *   - Old impls returned **plain-text tables and code-fenced bodies**;
 *     errors were free-form strings. Carve-out switches to consistent
 *     `{ok, ...}` / `{ok: false, error, ...}` envelopes across all
 *     three tools. The result body is exposed as a `result` string
 *     field; the LLM reads JSON fine.
 *   - **Narrow `ToolHistoryAccess` dep** wraps `getActiveToolTrail()`
 *     + `readToolResultAnySubsystem()` so unit tests can drive an
 *     in-memory `ToolTrail` + a stubbed disk lookup without touching
 *     the workspace.
 *   - **Bare-numeric key normalisation** closes the b-row trap.
 *   - **`sinceRound` is inclusive** (documented).
 *   - **Regex flags**: `gi` (case-insensitive) by default; `g` when
 *     `caseSensitive: true`. Invalid regex returns `{ok: false}`.
 *     Zero-width matches are guarded against (lastIndex bumped).
 *   - **Search snippet** preserves the around-match context (default
 *     120 chars, capped at 1000) with `…` markers when truncated.
 */

import { SharedToolDefinition } from './shared-tool-registry';

// ===========================================================================
// Cross-cut: entry shape (mirrors ToolTrailEntry + StoredToolResult)
// ===========================================================================

export interface PastToolEntry {
    key: string;
    timestamp: string;
    round: number;
    toolName: string;
    inputSummary: string;
    result: string;
    durationMs: number;
    error?: string;
}

// ===========================================================================
// Narrow dep
// ===========================================================================

export interface ToolHistoryAccess {
    /**
     * Snapshot of the in-memory ring buffer (oldest → newest). Returns
     * `undefined` when no ToolTrail is registered (e.g. fresh window,
     * no Anthropic session yet).
     */
    listRingBuffer(): PastToolEntry[] | undefined;
    /** `keepEntries` cap from the live ToolTrail (for display in headers). */
    ringBufferCapacity(): number | undefined;
    /** Read from the disk store (any subsystem). Returns undefined when missing. */
    readFromDisk(key: string): PastToolEntry | undefined;
}

// ===========================================================================
// JSON envelopes
// ===========================================================================

function ok<T extends object>(extra: T): string { return JSON.stringify({ ok: true, ...extra }); }
function err(message: string, extra: Record<string, unknown> = {}): string {
    return JSON.stringify({ ok: false, error: message, ...extra });
}

// ===========================================================================
// Key normalisation
// ===========================================================================

/**
 * Normalise a user-supplied key. Bare numerics (`"14"`) become `"t14"`
 * — closes the trap where the model passes a row number instead of a
 * key. Returns the trimmed key if it's already prefixed.
 */
export function normalisePastToolKey(raw: string): string {
    const trimmed = (raw ?? '').trim();
    if (!trimmed) { return ''; }
    if (/^\d+$/.test(trimmed)) { return `t${trimmed}`; }
    return trimmed;
}

function entrySummary(e: PastToolEntry): Record<string, unknown> {
    const size = (e.result ?? '').length;
    return {
        key: e.key,
        timestamp: e.timestamp,
        round: e.round,
        toolName: e.toolName,
        inputSummary: e.inputSummary,
        durationMs: e.durationMs,
        resultSize: size,
        status: e.error ? `ERROR: ${e.error}` : 'ok',
    };
}

// ===========================================================================
// `tomAi_listPastToolCalls`
// ===========================================================================

export interface ListPastToolCallsInput {
    /** Filter by tool name (exact match). */
    toolName?: string;
    /** Only return entries from this round onwards (inclusive). */
    sinceRound?: number;
    /** Maximum rows to return (default 20, capped at 200). */
    limit?: number;
}

export async function listPastToolCallsImpl(access: ToolHistoryAccess, input: ListPastToolCallsInput): Promise<string> {
    try {
        const all = access.listRingBuffer();
        if (all === undefined) {
            return err('No ToolTrail active.', {
                hint: 'Past-tool-access tools require an Anthropic session. Run a tool call first to populate the trail.',
            });
        }
        if (all.length === 0) {
            return ok({
                count: 0,
                totalMatches: 0,
                bufferSize: 0,
                capacity: access.ringBufferCapacity() ?? null,
                entries: [],
                note: 'ToolTrail is empty — no tool calls have been recorded yet in this session.',
            });
        }
        const toolName = input.toolName?.trim() || '';
        const sinceRound = typeof input.sinceRound === 'number' ? input.sinceRound : -Infinity;
        const limit = Math.max(1, Math.min(input.limit ?? 20, 200));
        const matches = all
            .filter((e) => !toolName || e.toolName === toolName)
            .filter((e) => e.round >= sinceRound);
        // newest-first-on-screen via slice(-N) (preserves oldest→newest order
        // within the slice; matches what the LLM expects when scrolling).
        const limited = matches.slice(-limit);
        return ok({
            count: limited.length,
            totalMatches: matches.length,
            truncated: matches.length > limited.length,
            bufferSize: all.length,
            capacity: access.ringBufferCapacity() ?? null,
            entries: limited.map(entrySummary),
            note: 'Pass a `key` to tomAi_readPastToolResult to fetch the full body.',
        });
    } catch (e) {
        return err(`listPastToolCalls failed: ${(e as Error).message}`);
    }
}

export const LIST_PAST_TOOL_CALLS_DESCRIPTION =
    'List recent tool calls from the **in-memory ring buffer** for this ' +
    'Anthropic session (does NOT read the disk store — use ' +
    '`tomAi_readPastToolResult` to fetch evicted entries by key). Returns ' +
    'one envelope `{ok, count, totalMatches, truncated, bufferSize, ' +
    'capacity, entries: [{key, timestamp, round, toolName, inputSummary, ' +
    'durationMs, resultSize, status}]}`. **Key format**: `t<n>` (e.g. ' +
    '`t14`); pass a `key` from the response to `tomAi_readPastToolResult` ' +
    'for the full body. Filters: `toolName` (exact match), `sinceRound` ' +
    '(**inclusive** lower bound on the prompt-round number), `limit` ' +
    '(default 20, capped 200). On a fresh session with no ToolTrail ' +
    'active, returns `{ok: false, hint: …}`.';

export const LIST_PAST_TOOL_CALLS_TOOL: SharedToolDefinition<ListPastToolCallsInput> = {
    name: 'tomAi_listPastToolCalls',
    displayName: 'Past Tools — List',
    description: LIST_PAST_TOOL_CALLS_DESCRIPTION,
    tags: ['past-tool-access', 'session'],
    readOnly: true,
    requiresApproval: false,
    inputSchema: {
        type: 'object',
        properties: {
            toolName: { type: 'string', description: 'Filter to calls of this tool name (exact match).' },
            sinceRound: { type: 'number', description: 'Inclusive lower bound on the prompt-round number.' },
            limit: { type: 'number', description: 'Maximum rows to return (default 20, capped at 200).' },
        },
    },
    execute: async () => '{"ok":false,"error":"execute() must be installed by tool-executors.ts"}',
};

// ===========================================================================
// `tomAi_searchPastToolResults`
// ===========================================================================

export interface SearchPastToolResultsInput {
    /** Regex pattern to match against each result body. Case-insensitive unless `caseSensitive` is true. */
    pattern: string;
    /** Filter by tool name (exact match). */
    toolName?: string;
    /** Case sensitivity flag (default false). */
    caseSensitive?: boolean;
    /** Max matches returned (default 20, capped at 200). */
    limit?: number;
    /** Characters of surrounding context per match (default 120, max 1000). */
    contextChars?: number;
}

interface SearchHit {
    key: string;
    toolName: string;
    round: number;
    matchIndex: number;
    snippet: string;
}

function compileRegex(pattern: string, caseSensitive: boolean): { rx: RegExp } | { error: string } {
    try {
        return { rx: new RegExp(pattern, caseSensitive ? 'g' : 'gi') };
    } catch (e) {
        return { error: `Invalid regex: ${(e as Error).message}` };
    }
}

export async function searchPastToolResultsImpl(access: ToolHistoryAccess, input: SearchPastToolResultsInput): Promise<string> {
    try {
        const all = access.listRingBuffer();
        if (all === undefined) {
            return err('No ToolTrail active.', {
                hint: 'Past-tool-access tools require an Anthropic session.',
            });
        }
        if (!input.pattern || !input.pattern.trim()) {
            return err('`pattern` is required.');
        }
        const compiled = compileRegex(input.pattern, input.caseSensitive === true);
        if ('error' in compiled) {
            return err(compiled.error, { pattern: input.pattern });
        }
        const rx = compiled.rx;
        const toolName = input.toolName?.trim() || '';
        const limit = Math.max(1, Math.min(input.limit ?? 20, 200));
        const ctx = Math.max(0, Math.min(input.contextChars ?? 120, 1000));

        const entries = all.filter((e) => !toolName || e.toolName === toolName);
        const hits: SearchHit[] = [];
        for (const e of entries) {
            const body = e.result ?? '';
            rx.lastIndex = 0;
            let m: RegExpExecArray | null;
            while ((m = rx.exec(body))) {
                const start = Math.max(0, m.index - ctx);
                const end = Math.min(body.length, m.index + m[0].length + ctx);
                const prefix = start > 0 ? '…' : '';
                const suffix = end < body.length ? '…' : '';
                hits.push({
                    key: e.key,
                    toolName: e.toolName,
                    round: e.round,
                    matchIndex: m.index,
                    snippet: `${prefix}${body.slice(start, end).replace(/\s+/g, ' ').trim()}${suffix}`,
                });
                if (hits.length >= limit) { break; }
                // Guard against zero-width matches spinning forever.
                if (m.index === rx.lastIndex) { rx.lastIndex += 1; }
            }
            if (hits.length >= limit) { break; }
        }
        return ok({
            pattern: input.pattern,
            caseSensitive: input.caseSensitive === true,
            entriesScanned: entries.length,
            hitCount: hits.length,
            hits,
        });
    } catch (e) {
        return err(`searchPastToolResults failed: ${(e as Error).message}`);
    }
}

export const SEARCH_PAST_TOOL_RESULTS_DESCRIPTION =
    'Regex-search across the bodies of past tool results in the ring ' +
    'buffer for this session. **Regex syntax**: JavaScript regex with ' +
    'the `g` flag (always) and `i` flag when `caseSensitive: false` ' +
    '(default). Invalid regex returns `{ok: false, error}`. Each match ' +
    'becomes one snippet with up to `contextChars` (default 120, capped ' +
    '1000) of surrounding text; whitespace inside the snippet is ' +
    'collapsed to single spaces for readability; `…` markers indicate ' +
    'truncation at either end. Zero-width matches are guarded against. ' +
    'Filters: `toolName` (exact match), `limit` (default 20, capped 200). ' +
    'Response: `{ok, pattern, caseSensitive, entriesScanned, hitCount, ' +
    'hits: [{key, toolName, round, matchIndex, snippet}]}`. Pass any ' +
    '`key` to `tomAi_readPastToolResult` for the full body.';

export const SEARCH_PAST_TOOL_RESULTS_TOOL: SharedToolDefinition<SearchPastToolResultsInput> = {
    name: 'tomAi_searchPastToolResults',
    displayName: 'Past Tools — Search',
    description: SEARCH_PAST_TOOL_RESULTS_DESCRIPTION,
    tags: ['past-tool-access', 'session'],
    readOnly: true,
    requiresApproval: false,
    inputSchema: {
        type: 'object',
        required: ['pattern'],
        properties: {
            pattern: { type: 'string', description: 'JavaScript regex to match against result bodies.' },
            toolName: { type: 'string', description: 'Only consider calls of this tool name.' },
            caseSensitive: { type: 'boolean', description: 'Case-sensitive match (default false).' },
            limit: { type: 'number', description: 'Maximum snippets returned (default 20, capped at 200).' },
            contextChars: { type: 'number', description: 'Characters of surrounding context per match (default 120, capped 1000).' },
        },
    },
    execute: async () => '{"ok":false,"error":"execute() must be installed by tool-executors.ts"}',
};

// ===========================================================================
// `tomAi_readPastToolResult`
// ===========================================================================

export interface ReadPastToolResultInput {
    /** The replay key (e.g. `t14`). Bare numerics (`"14"`) are normalised to `t14`. */
    key: string;
}

export async function readPastToolResultImpl(access: ToolHistoryAccess, input: ReadPastToolResultInput): Promise<string> {
    try {
        const rawKey = (input.key ?? '').trim();
        if (!rawKey) { return err('`key` is required.'); }
        const normalised = normalisePastToolKey(rawKey);

        // 1. Prefer the active in-memory ring buffer (most recent + fastest).
        let entry: PastToolEntry | undefined;
        let source: 'memory' | 'disk' = 'memory';
        const ring = access.listRingBuffer();
        if (ring) { entry = ring.find((e) => e.key === normalised); }

        // 2. Fall back to the disk store (any subsystem).
        if (!entry) {
            const fromDisk = access.readFromDisk(normalised);
            if (fromDisk) {
                entry = fromDisk;
                source = 'disk';
            }
        }

        if (!entry) {
            const trailNote = ring
                ? 'Use tomAi_listPastToolCalls to enumerate the keys currently in scope.'
                : 'No ToolTrail active — pass an exact key from a stub like "Past tool call tX" in the conversation.';
            return err(`No past tool result with key "${normalised}".`, {
                rawKey,
                normalisedKey: normalised,
                hint: trailNote,
            });
        }

        return ok({
            key: entry.key,
            rawKey,
            source,
            round: entry.round,
            timestamp: entry.timestamp,
            durationMs: entry.durationMs,
            toolName: entry.toolName,
            inputSummary: entry.inputSummary,
            resultSize: (entry.result ?? '').length,
            errorMessage: entry.error ?? null,
            result: entry.result ?? '',
        });
    } catch (e) {
        return err(`readPastToolResult failed: ${(e as Error).message}`);
    }
}

export const READ_PAST_TOOL_RESULT_DESCRIPTION =
    'Return the full result body for a past tool call by its replay key. ' +
    '**Key format**: `t<n>` (e.g. `t14`). **Bare numerics are normalised**: ' +
    'passing `key: "14"` resolves the same as `key: "t14"` — the response ' +
    'echoes both `rawKey` (input) and `key` (normalised). **Lookup order**: ' +
    '(1) in-memory ring buffer (fast, session-scoped, ~40 most recent); ' +
    '(2) disk store at `${ai}/trail/<subsystem>/<quest>/tool_results/' +
    '<key>.json` (tried for `anthropic` then `localLlm` subsystems, ' +
    'survives ring eviction + window reload). Response reports `source: ' +
    '"memory" | "disk"` so the caller knows which layer answered. Stub ' +
    'blocks in the conversation like `[Past tool call tX — …]` remain ' +
    'resolvable here even after eviction.';

export const READ_PAST_TOOL_RESULT_TOOL: SharedToolDefinition<ReadPastToolResultInput> = {
    name: 'tomAi_readPastToolResult',
    displayName: 'Past Tools — Read',
    description: READ_PAST_TOOL_RESULT_DESCRIPTION,
    tags: ['past-tool-access', 'session'],
    readOnly: true,
    requiresApproval: false,
    inputSchema: {
        type: 'object',
        required: ['key'],
        properties: {
            key: { type: 'string', description: 'Replay key from a tool history block (e.g. `t14`). Bare numerics like `"14"` are normalised to `t14`.' },
        },
    },
    execute: async () => '{"ok":false,"error":"execute() must be installed by tool-executors.ts"}',
};

// ===========================================================================
// Live bridge
// ===========================================================================

import { getActiveToolTrail, type ToolTrailEntry } from '../services/tool-trail';
import { readToolResultAnySubsystem } from '../services/tool-result-store';

function toPastToolEntry(e: ToolTrailEntry): PastToolEntry {
    return {
        key: e.key,
        timestamp: e.timestamp,
        round: e.round,
        toolName: e.toolName,
        inputSummary: e.inputSummary,
        result: e.result,
        durationMs: e.durationMs,
        error: e.error,
    };
}

const liveAccess: ToolHistoryAccess = {
    listRingBuffer() {
        const trail = getActiveToolTrail();
        if (!trail) { return undefined; }
        return trail.listEntries().map(toPastToolEntry);
    },
    ringBufferCapacity() {
        const trail = getActiveToolTrail();
        return trail?.keepEntries;
    },
    readFromDisk(key) {
        const fromDisk = readToolResultAnySubsystem(key);
        if (!fromDisk) { return undefined; }
        return {
            key: fromDisk.entry.key,
            timestamp: fromDisk.entry.timestamp,
            round: fromDisk.entry.round,
            toolName: fromDisk.entry.toolName,
            inputSummary: fromDisk.entry.inputSummary,
            result: fromDisk.entry.result,
            durationMs: fromDisk.entry.durationMs,
            error: fromDisk.entry.error,
        };
    },
};

LIST_PAST_TOOL_CALLS_TOOL.execute      = (input) => listPastToolCallsImpl(liveAccess, input);
SEARCH_PAST_TOOL_RESULTS_TOOL.execute  = (input) => searchPastToolResultsImpl(liveAccess, input);
READ_PAST_TOOL_RESULT_TOOL.execute     = (input) => readPastToolResultImpl(liveAccess, input);

// ===========================================================================
// Family export
// ===========================================================================

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export const PAST_TOOL_ACCESS_TOOLS: SharedToolDefinition<any>[] = [
    LIST_PAST_TOOL_CALLS_TOOL,
    SEARCH_PAST_TOOL_RESULTS_TOOL,
    READ_PAST_TOOL_RESULT_TOOL,
];
