/**
 * Prompt-history tools — let the LLM inspect past prompt+answer pairs
 * from the per-quest summary trail files (the same files the
 * Anthropic history-rebuild path reads when no snapshot exists).
 *
 * Source of truth: each Anthropic session's
 * `_ai/quests/<quest>/history/sessions/<session>/<quest>.anthropic.{prompts,answers}.md`
 * and the other subsystems' `_ai/quests/<quest>/history/<quest>.<subsystem>.{prompts,answers}.md`
 * (TrailService.writeSummaryPrompt / writeSummaryAnswer); `sessions` chooses
 * the Anthropic sessions (src/tools/session-param.ts). Pairs are
 * matched by `requestId` (the shared key on both files' headers).
 *
 * Two tools:
 *
 *   tomAi_listPromptPairs   — list pairs with metadata + previews
 *   tomAi_getPromptPair     — fetch full bodies for one or more pairs
 *
 * Both have a wsRoot-explicit `*Impl` overload for unit testing
 * without spinning up vscode.
 */

import * as vscode from 'vscode';
import * as path from 'path';
import { SharedToolDefinition } from './shared-tool-registry';
import { resolveToolSessions, SESSIONS_PARAM_SCHEMA } from './session-param';
import {
    getPromptPairs,
    listPromptPairs,
    matchesSubsystemFilter,
} from './prompt-history-utils';

function wsRoot(): string | undefined {
    return vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
}

/** Resolve the per-quest folder. Mirrors TrailService's pattern. */
function questFolder(root: string | undefined, questId: string): string | undefined {
    if (!root || !questId) { return undefined; }
    return path.join(root, '_ai', 'quests', questId);
}

/** Resolve the active quest id without importing the workspace utils
 *  module (which itself imports vscode at the top). The two callers
 *  pass questId explicitly when they have one; this is the default. */
function defaultQuestId(): string {
    // Use ChatVariablesStore if available, else fall back to 'default'.
    try {
        // eslint-disable-next-line @typescript-eslint/no-require-imports
        const mod = require('../managers/chatVariablesStore') as typeof import('../managers/chatVariablesStore.js');
        return mod.ChatVariablesStore.instance.quest || 'default';
    } catch {
        return 'default';
    }
}

// ---------------------------------------------------------------------------
// tomAi_listPromptPairs
// ---------------------------------------------------------------------------

interface ListPromptPairsInput {
    questId?: string;
    subsystem?: string;
    sessions?: string | string[];
    limit?: number;
    offset?: number;
    previewChars?: number;
}

export async function listPromptPairsImpl(
    root: string | undefined,
    input: ListPromptPairsInput,
): Promise<string> {
    const questId = input.questId || defaultQuestId();
    const folder = questFolder(root, questId);
    if (!folder) {
        return JSON.stringify({ error: 'Workspace root not available or questId missing' });
    }
    const chosen = resolveToolSessions(input.sessions, path.join(folder, 'history'));
    if (!chosen.ok) { return JSON.stringify(chosen); }
    const result = listPromptPairs(folder, questId, {
        subsystem: input.subsystem,
        sessions: chosen.sessions,
        limit: input.limit,
        offset: input.offset,
        previewChars: input.previewChars,
    });
    return JSON.stringify({ sessions: chosen.sessions, ...result }, null, 2);
}

async function executeListPromptPairs(input: ListPromptPairsInput): Promise<string> {
    return listPromptPairsImpl(wsRoot(), input);
}

export const LIST_PROMPT_PAIRS_TOOL: SharedToolDefinition<ListPromptPairsInput> = {
    name: 'tomAi_listPromptPairs',
    displayName: 'List Prompt Pairs',
    description:
        `List past prompt+answer pairs for a quest, with metadata (requestId, ISO timestamp, sequence, ` +
        `subsystem, prompt/answer character counts, previews). Newest first.\n\n` +
        `Reads the summary trail pairs: each Anthropic session's own \`_ai/quests/<quest>/history/sessions/<session>/<quest>.anthropic.{prompts,answers}.md\` ` +
        `(listed as subsystem \`anthropic:<session>\`; the filter \`anthropic\` matches them all) and the other subsystems' ` +
        `\`_ai/quests/<quest>/history/<quest>.<subsystem>.{prompts,answers}.md\` — the same source a history rebuild reads. ` +
        `Pairs are matched by \`requestId\`.\n\n` +
        `**Inputs (all optional):**\n` +
        `  - questId      — defaults to the current quest\n` +
        `  - subsystem    — e.g. "anthropic", "copilot", "localllm-<configName>", or a prefix like "localllm" or "localllm-*". ` +
        `Omit to scan every subsystem the quest has files for.\n` +
        `  - limit        — page size (default 50, max 500)\n` +
        `  - offset       — page offset (default 0; newest=0)\n` +
        `  - previewChars — preview length per body (default 120; set 0 to disable)\n` +
        `  - sessions     — the Anthropic sessions whose pairs to include: a name, a list, or "all"; default the session ` +
        `this call runs in (every session when it runs in none). Other subsystems are always included. An unknown session ` +
        `is refused (code unknownSession) with the sessions there are.\n\n` +
        `Use the returned \`requestId\` (or the merged-list \`index\`) with \`tomAi_getPromptPair\` to fetch full bodies.`,
    tags: ['history', 'tom-ai-chat'],
    readOnly: true,
    inputSchema: {
        type: 'object',
        properties: {
            questId: { type: 'string', description: 'Quest id. Defaults to current.' },
            subsystem: { type: 'string', description: 'Exact name, prefix-glob ("localllm-*"), or family ("localllm"). Omit = all.' },
            limit: { type: 'number', description: 'Default 50, max 500.' },
            offset: { type: 'number', description: 'Newest-first index of first returned pair. Default 0.' },
            previewChars: { type: 'number', description: 'Preview body length. Default 120, set 0 to disable.' },
            sessions: SESSIONS_PARAM_SCHEMA,
        },
    },
    execute: executeListPromptPairs,
};

// ---------------------------------------------------------------------------
// tomAi_getPromptPair
// ---------------------------------------------------------------------------

interface GetPromptPairInput {
    questId?: string;
    subsystem?: string;
    sessions?: string | string[];
    requestId?: string;
    requestIds?: string[];
    index?: number;
    count?: number;
}

export async function getPromptPairImpl(
    root: string | undefined,
    input: GetPromptPairInput,
): Promise<string> {
    const questId = input.questId || defaultQuestId();
    const folder = questFolder(root, questId);
    if (!folder) {
        return JSON.stringify({ error: 'Workspace root not available or questId missing' });
    }
    // Normalise the selector: accept either `requestId` (singular) or
    // `requestIds` (array). Both null/empty falls through to index-based.
    const ids: string[] | undefined =
        input.requestIds && input.requestIds.length > 0
            ? input.requestIds
            : (input.requestId ? [input.requestId] : undefined);
    if (!ids && input.index === undefined && input.count === undefined) {
        return JSON.stringify({
            error: 'Provide requestId / requestIds / index (with optional count). ' +
                'Call tomAi_listPromptPairs first to discover available ids.',
        });
    }
    const chosen = resolveToolSessions(input.sessions, path.join(folder, 'history'));
    if (!chosen.ok) { return JSON.stringify(chosen); }
    const result = getPromptPairs(folder, questId, {
        subsystem: input.subsystem,
        sessions: chosen.sessions,
        requestIds: ids,
        index: input.index,
        count: input.count,
    });
    return JSON.stringify(result, null, 2);
}

async function executeGetPromptPair(input: GetPromptPairInput): Promise<string> {
    return getPromptPairImpl(wsRoot(), input);
}

export const GET_PROMPT_PAIR_TOOL: SharedToolDefinition<GetPromptPairInput> = {
    name: 'tomAi_getPromptPair',
    displayName: 'Get Prompt Pair',
    description:
        `Fetch full prompt + answer bodies for one or more pairs.\n\n` +
        `**Selector (mutually exclusive — use exactly one shape):**\n` +
        `  - requestId: "req-abc"                    — single pair by id\n` +
        `  - requestIds: ["req-abc", "req-def"]     — multiple pairs by id\n` +
        `  - index: 0                                — newest pair (use index:1 for second-newest, …)\n` +
        `  - index: 3, count: 5                      — five pairs starting from the 4th-newest\n\n` +
        `**Common args:**\n` +
        `  - questId    — defaults to current quest\n` +
        `  - subsystem  — narrow the scan (same shape as tomAi_listPromptPairs)\n` +
        `  - sessions   — the Anthropic sessions to look in, as for tomAi_listPromptPairs (default: this call's session)\n\n` +
        `Returns full bodies (no truncation) for up to 50 pairs per call. Use tomAi_listPromptPairs ` +
        `first when you don't know the requestIds.`,
    tags: ['history', 'tom-ai-chat'],
    readOnly: true,
    inputSchema: {
        type: 'object',
        properties: {
            requestId: { type: 'string', description: 'Single pair by id.' },
            requestIds: { type: 'array', items: { type: 'string' }, description: 'Multiple pairs by id.' },
            index: { type: 'number', description: 'Newest-first index. 0 = most recent.' },
            count: { type: 'number', description: 'How many pairs starting from index. Default 1, max 50.' },
            questId: { type: 'string', description: 'Quest id. Defaults to current.' },
            subsystem: { type: 'string', description: 'Exact name, prefix-glob, or family. Omit = all.' },
            sessions: SESSIONS_PARAM_SCHEMA,
        },
    },
    execute: executeGetPromptPair,
};

// ---------------------------------------------------------------------------
// Re-exports + master list
// ---------------------------------------------------------------------------

export { matchesSubsystemFilter };

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export const PROMPT_HISTORY_TOOLS: SharedToolDefinition<any>[] = [
    LIST_PROMPT_PAIRS_TOOL,
    GET_PROMPT_PAIR_TOOL,
];
