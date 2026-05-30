/**
 * Past Tool Access — tools that let the model look back at earlier tool
 * calls + their full results without us having to push all of that
 * history into every outgoing prompt.
 *
 * Source of truth: the session's in-memory ToolTrail
 * (`services/tool-trail.ts`). The Anthropic handler registers its
 * ToolTrail as the module-level active trail on construction; these
 * tools read from it via `getActiveToolTrail()`.
 *
 *   tomAi_listPastToolCalls    — filter/browse the buffer
 *   tomAi_searchPastToolResults — regex across past result bodies
 *   tomAi_readPastToolResult   — fetch one full result by its key
 *
 * All three are read-only and never prompt for approval. They operate
 * on the current session's ToolTrail only — disk-backed history
 * (`_ai/trail/anthropic/<quest>/…`) is *not* consulted, so they return
 * an informative message on a fresh session where the trail is empty.
 */

import { SharedToolDefinition } from './shared-tool-registry';
import { getActiveToolTrail, type ToolTrailEntry } from '../services/tool-trail';
import { readToolResultAnySubsystem } from '../services/tool-result-store';

// ============================================================================
// tomAi_listPastToolCalls
// ============================================================================

interface ListPastToolCallsInput {
    /** Filter by tool name (exact match). */
    toolName?: string;
    /** Only return entries from this round onwards (inclusive). */
    sinceRound?: number;
    /** Maximum rows to return (default 20, capped at 200). */
    limit?: number;
}

function formatListRow(e: ToolTrailEntry): string {
    const size = (e.result ?? '').length;
    const status = e.error ? `ERROR: ${e.error}` : `ok (${size} chars)`;
    const input = e.inputSummary.replace(/\s+/g, ' ').trim();
    return `${e.key}\t${e.timestamp}\tR${e.round}\t${e.toolName}(${input})\t${status}`;
}

async function executeListPastToolCalls(input: ListPastToolCallsInput): Promise<string> {
    const trail = getActiveToolTrail();
    if (!trail) {
        return 'No ToolTrail active — past tool results are available only during an Anthropic session.';
    }
    const all = trail.listEntries();
    if (all.length === 0) {
        return 'ToolTrail is empty — no tool calls have been recorded yet in this session.';
    }
    const toolName = input.toolName?.trim() || '';
    const sinceRound = typeof input.sinceRound === 'number' ? input.sinceRound : -Infinity;
    const limit = Math.max(1, Math.min(input.limit ?? 20, 200));
    const matches = all
        .filter((e) => !toolName || e.toolName === toolName)
        .filter((e) => e.round >= sinceRound);
    const limited = matches.slice(-limit); // newest-first-on-screen via slice(-N)

    const header = [
        `Showing ${limited.length} of ${matches.length} match(es); ToolTrail holds ${all.length} entries (last ${trail.keepEntries} kept).`,
        'Pass a key from column 1 to tomAi_readPastToolResult to fetch the full body.',
        'key\ttime\tround\ttool(input)\tstatus',
    ].join('\n');
    return [header, ...limited.map(formatListRow)].join('\n');
}

export const LIST_PAST_TOOL_CALLS_TOOL: SharedToolDefinition<ListPastToolCallsInput> = {
    name: 'tomAi_listPastToolCalls',
    displayName: 'Past Tools — List',
    description:
        'List the recent tool calls from this Anthropic session (up to ~40 most recent). Returns one line per call with a replay key you can pass to `tomAi_readPastToolResult`. Optional filters: `toolName` (exact tool name), `sinceRound` (round number inclusive), `limit` (default 20, max 200).',
    tags: ['past-tool-access', 'session'],
    readOnly: true,
    requiresApproval: false,
    inputSchema: {
        type: 'object',
        properties: {
            toolName: { type: 'string', description: 'Filter to calls of this tool name (exact match).' },
            sinceRound: { type: 'number', description: 'Only include calls from this prompt round onwards (inclusive).' },
            limit: { type: 'number', description: 'Maximum rows to return (default 20, capped at 200).' },
        },
    },
    execute: executeListPastToolCalls,
};

// ============================================================================
// tomAi_searchPastToolResults
// ============================================================================

interface SearchPastToolResultsInput {
    /** Regex pattern to match against each result body. Case-insensitive unless `caseSensitive` is true. */
    pattern: string;
    /** Filter by tool name (exact match). */
    toolName?: string;
    /** Case sensitivity flag (default false). */
    caseSensitive?: boolean;
    /** Max matches returned (default 20, capped at 200). */
    limit?: number;
    /** Characters of surrounding context per match (default 120). */
    contextChars?: number;
}

function safeRegex(pattern: string, caseSensitive: boolean): RegExp | string {
    try {
        return new RegExp(pattern, caseSensitive ? 'g' : 'gi');
    } catch (e) {
        return `Invalid regex: ${e instanceof Error ? e.message : String(e)}`;
    }
}

async function executeSearchPastToolResults(input: SearchPastToolResultsInput): Promise<string> {
    const trail = getActiveToolTrail();
    if (!trail) {
        return 'No ToolTrail active — past tool results are available only during an Anthropic session.';
    }
    if (!input.pattern || !input.pattern.trim()) {
        return 'Error: `pattern` is required.';
    }
    const rx = safeRegex(input.pattern, input.caseSensitive === true);
    if (typeof rx === 'string') {
        return rx;
    }
    const toolName = input.toolName?.trim() || '';
    const limit = Math.max(1, Math.min(input.limit ?? 20, 200));
    const ctx = Math.max(0, Math.min(input.contextChars ?? 120, 1000));

    const entries = trail.listEntries().filter((e) => !toolName || e.toolName === toolName);
    type Hit = { key: string; toolName: string; round: number; snippet: string };
    const hits: Hit[] = [];
    for (const e of entries) {
        const body = e.result ?? '';
        // Reset lastIndex so the global regex continues fresh per entry.
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
                snippet: `${prefix}${body.slice(start, end).replace(/\s+/g, ' ').trim()}${suffix}`,
            });
            if (hits.length >= limit) { break; }
            // Guard against zero-width matches spinning forever.
            if (m.index === rx.lastIndex) { rx.lastIndex += 1; }
        }
        if (hits.length >= limit) { break; }
    }
    if (hits.length === 0) {
        return `No matches for /${input.pattern}/ across ${entries.length} past tool result(s).`;
    }
    return [
        `${hits.length} match(es) for /${input.pattern}/ across ${entries.length} past tool result(s).`,
        'key\tround\ttool\tsnippet',
        ...hits.map((h) => `${h.key}\tR${h.round}\t${h.toolName}\t${h.snippet}`),
    ].join('\n');
}

export const SEARCH_PAST_TOOL_RESULTS_TOOL: SharedToolDefinition<SearchPastToolResultsInput> = {
    name: 'tomAi_searchPastToolResults',
    displayName: 'Past Tools — Search',
    description:
        'Regex-search across the bodies of past tool results in this session. Returns one snippet per match with the replay key so you can pass it to `tomAi_readPastToolResult`. Arguments: `pattern` (required, JS regex), `toolName` (optional exact filter), `caseSensitive` (default false), `limit` (default 20, max 200), `contextChars` (default 120).',
    tags: ['past-tool-access', 'session'],
    readOnly: true,
    requiresApproval: false,
    inputSchema: {
        type: 'object',
        properties: {
            pattern: { type: 'string', description: 'JavaScript regex to match against result bodies.' },
            toolName: { type: 'string', description: 'Only consider calls of this tool name.' },
            caseSensitive: { type: 'boolean', description: 'Case-sensitive match (default false).' },
            limit: { type: 'number', description: 'Maximum snippets returned (default 20, capped at 200).' },
            contextChars: { type: 'number', description: 'Characters of surrounding context per match (default 120).' },
        },
        required: ['pattern'],
    },
    execute: executeSearchPastToolResults,
};

// ============================================================================
// tomAi_readPastToolResult
// ============================================================================

interface ReadPastToolResultInput {
    /** The replay key shown in the ToolTrail summary (e.g. `t14`). */
    key: string;
}

async function executeReadPastToolResult(input: ReadPastToolResultInput): Promise<string> {
    const key = (input.key ?? '').trim();
    if (!key) { return 'Error: `key` is required.'; }

    // 1. Prefer the active in-memory ring buffer (most recent + fastest).
    const trail = getActiveToolTrail();
    let e: ToolTrailEntry | undefined = trail?.getByKey(key);
    let source: 'memory' | 'disk' = 'memory';

    // 2. Fall back to disk: the tool-result store keeps every result by
    //    key across the quest, surviving ring-buffer eviction and window
    //    reloads. This is what makes the toolTrailKeepRounds policy
    //    workable — older inline blocks are stubbed out, the model fetches
    //    the body via this tool, and the body has to actually be there.
    if (!e) {
        const fromDisk = readToolResultAnySubsystem(key);
        if (fromDisk) {
            e = {
                key: fromDisk.entry.key,
                timestamp: fromDisk.entry.timestamp,
                round: fromDisk.entry.round,
                toolName: fromDisk.entry.toolName,
                inputSummary: fromDisk.entry.inputSummary,
                result: fromDisk.entry.result,
                durationMs: fromDisk.entry.durationMs,
                error: fromDisk.entry.error,
            };
            source = 'disk';
        }
    }

    if (!e) {
        const trailNote = trail
            ? 'Use tomAi_listPastToolCalls to enumerate the keys currently in scope.'
            : 'No ToolTrail active — pass an exact key from a stub like "Past tool call tX" in the conversation.';
        return `No past tool result with key "${key}". ${trailNote}`;
    }

    const lines: string[] = [];
    lines.push(`Key: ${e.key}  |  Round: R${e.round}  |  Time: ${e.timestamp}  |  Duration: ${e.durationMs}ms  |  Source: ${source}`);
    lines.push(`Tool: ${e.toolName}(${e.inputSummary})`);
    if (e.error) {
        lines.push(`Error: ${e.error}`);
    }
    lines.push(`Result (${(e.result ?? '').length} chars):`);
    lines.push('```');
    lines.push(e.result ?? '');
    lines.push('```');
    return lines.join('\n');
}

export const READ_PAST_TOOL_RESULT_TOOL: SharedToolDefinition<ReadPastToolResultInput> = {
    name: 'tomAi_readPastToolResult',
    displayName: 'Past Tools — Read',
    description:
        'Return the full result body for a past tool call by its replay key (e.g. `t14`). Reads from the in-memory ring buffer first, then falls back to the per-quest disk store under `_ai/trail/<subsystem>/<quest>/tool_results/<key>.json` — so keys printed in stub blocks (`[Past tool call tX — ... Use tomAi_readPastToolResult({"key":"tX"})]`) remain resolvable after the ring buffer evicts them or the window reloads.',
    tags: ['past-tool-access', 'session'],
    readOnly: true,
    requiresApproval: false,
    inputSchema: {
        type: 'object',
        properties: {
            key: { type: 'string', description: 'The replay key from the tool history block (e.g. `t14`).' },
        },
        required: ['key'],
    },
    execute: executeReadPastToolResult,
};

// ============================================================================
// Family export
// ============================================================================

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export const PAST_TOOL_ACCESS_TOOLS: SharedToolDefinition<any>[] = [
    LIST_PAST_TOOL_CALLS_TOOL,
    SEARCH_PAST_TOOL_RESULTS_TOOL,
    READ_PAST_TOOL_RESULT_TOOL,
];
