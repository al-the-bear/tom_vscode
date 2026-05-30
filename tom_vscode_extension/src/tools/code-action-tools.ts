/**
 * Code-action tools — `tomAi_getCodeActions`, `tomAi_getCodeActionsCached`,
 * `tomAi_applyCodeAction`.
 *
 * Carved out of `language-service-tools.ts` for coverage entry #11.
 *
 * The cache that makes `getCodeActionsCached` + `applyCodeAction` work
 * lives in this file (module-level state). A test-only
 * `_resetCodeActionRegistryForTesting()` export exists so suites can
 * isolate from each other.
 *
 * Changes vs the previous impl:
 *
 *   - **vscode-free at runtime.** Impls take a narrow `CodeActionService`
 *     dep. Production wires `vscode.commands.executeCodeActionProvider`
 *     + `vscode.workspace.applyEdit`; tests pass a fake that returns
 *     synthetic snapshots and records `applyAction` calls.
 *
 *   - **1-based line/character.** The previous impl was 0-based,
 *     inconsistent with `tomAi_readFile`/`openFile`/`findSymbol` after
 *     the earlier coverage refactors. Translated at the impl boundary
 *     (the service stays 0-based, matching vscode).
 *
 *   - **Apply-result distinguishes the three outcomes.** An action can
 *     have `hasEdit && hasCommand`, `hasEdit` only, or `hasCommand`
 *     only. The previous impl just returned `success: true` whether
 *     the edit applied or not. Now: `editApplied: true|false|null`
 *     (null = no edit on the action) and `commandResult: <value>|null`
 *     (null = no command), so the model can tell.
 *
 *   - **Documented kind taxonomy.** `quickfix.*` vs `refactor.*` vs
 *     `source.*` is spelled out in the description so the model can
 *     pick the `only` filter sensibly.
 */

import { SharedToolDefinition } from './shared-tool-registry';

// ===========================================================================
// Narrow dep types
// ===========================================================================

export interface CodeActionRange0Based {
    startLine: number;
    startCharacter: number;
    endLine: number;
    endCharacter: number;
}

export interface CodeActionSnapshot {
    title: string;
    /** CodeActionKind string, e.g. `'quickfix'`, `'refactor.extract.function'`. */
    kind?: string;
    isPreferred?: boolean;
    hasEdit: boolean;
    hasCommand: boolean;
    /** Command id if `hasCommand`; otherwise undefined. */
    commandId?: string;
    diagnosticsCount: number;
}

export interface ListedCodeAction {
    snapshot: CodeActionSnapshot;
    /** Opaque payload the service needs back when `applyAction` is called. */
    token: unknown;
}

export interface ApplyActionResult {
    /** true/false when an edit was attempted; null when the action had no edit. */
    editApplied: boolean | null;
    /** Command return value, or null when no command was on the action. */
    commandResult: unknown;
}

export interface CodeActionService {
    /** Resolve a possibly-relative `filePath` to absolute, or null if missing. */
    resolveFile(filePath: string): string | null;
    list(absPath: string, range: CodeActionRange0Based, only?: string): Promise<ListedCodeAction[]>;
    apply(token: unknown): Promise<ApplyActionResult>;
}

// ===========================================================================
// In-memory cache
// ===========================================================================

interface CachedEntry {
    actionId: string;
    snapshot: CodeActionSnapshot;
    token: unknown;
    absPath: string;
    expires: number;
}

export const CODE_ACTION_TTL_MS = 5 * 60 * 1000;

const REGISTRY = new Map<string, CachedEntry>();
let registryCounter = 0;

/** Test-only: drop every cached action so suites don't leak state. */
export function _resetCodeActionRegistryForTesting(): void {
    REGISTRY.clear();
    registryCounter = 0;
}

function gcExpired(now: number): void {
    for (const [k, v] of REGISTRY.entries()) {
        if (v.expires < now) { REGISTRY.delete(k); }
    }
}

function register(snapshot: CodeActionSnapshot, token: unknown, absPath: string): string {
    const now = Date.now();
    gcExpired(now);
    const actionId = `ca_${++registryCounter}_${now.toString(36)}`;
    REGISTRY.set(actionId, { actionId, snapshot, token, absPath, expires: now + CODE_ACTION_TTL_MS });
    return actionId;
}

function lookup(actionId: string): { entry: CachedEntry; expired: boolean } | null {
    const entry = REGISTRY.get(actionId);
    if (!entry) { return null; }
    if (entry.expires < Date.now()) {
        REGISTRY.delete(actionId);
        return { entry, expired: true };
    }
    return { entry, expired: false };
}

// ===========================================================================
// Helpers — 1-based ↔ 0-based + range derivation
// ===========================================================================

function clampNonNeg(n: number): number {
    return Math.max(0, Math.floor(Number(n) || 0));
}

function rangeFromInput(input: {
    startLine: number;
    startCharacter: number;
    endLine?: number;
    endCharacter?: number;
}): CodeActionRange0Based {
    const startLine = clampNonNeg(input.startLine) - 1;
    const startCharacter = clampNonNeg(input.startCharacter) - 1;
    const endLine = clampNonNeg(input.endLine ?? input.startLine) - 1;
    const endCharacter = clampNonNeg(input.endCharacter ?? input.startCharacter) - 1;
    return {
        startLine: Math.max(0, startLine),
        startCharacter: Math.max(0, startCharacter),
        endLine: Math.max(startLine, endLine),
        endCharacter: Math.max(0, endCharacter),
    };
}

// ===========================================================================
// tomAi_getCodeActions (preview only, no cache)
// ===========================================================================

export interface GetCodeActionsInput {
    filePath: string;
    /** 1-based. */
    startLine: number;
    /** 1-based. */
    startCharacter: number;
    endLine?: number;
    endCharacter?: number;
    only?: string;
}

export async function getCodeActionsImpl(service: CodeActionService, input: GetCodeActionsInput): Promise<string> {
    if (!input.filePath) { return JSON.stringify({ error: '`filePath` is required.' }); }
    const abs = service.resolveFile(input.filePath);
    if (!abs) { return JSON.stringify({ error: `File not found: ${input.filePath}` }); }
    const range = rangeFromInput(input);
    let listed: ListedCodeAction[];
    try {
        listed = await service.list(abs, range, input.only);
    } catch (err) {
        return JSON.stringify({ error: `Code actions failed: ${(err as Error).message}` });
    }
    return JSON.stringify({
        count: listed.length,
        actions: listed.map((l) => l.snapshot),
    }, null, 2);
}

export const GET_CODE_ACTIONS_DESCRIPTION =
    'List available code actions (quick fixes / refactors) at a file ' +
    'range — read-only preview, no apply. Use `tomAi_getCodeActionsCached` ' +
    '+ `tomAi_applyCodeAction` when you actually want to run one. The ' +
    '`only` filter accepts a `CodeActionKind` string; common values are ' +
    '`"quickfix"` (red squiggle fixes), `"refactor"` (any refactor), ' +
    '`"refactor.extract"`, `"refactor.inline"`, `"refactor.rewrite"`, ' +
    '`"source"` (source-level actions like "Organize Imports"), ' +
    '`"source.fixAll"`. Pass the broadest prefix to get every matching ' +
    'subkind. Each result reports `title`, `kind`, `isPreferred`, ' +
    '`hasEdit`/`hasCommand`/`commandId`, and `diagnosticsCount` (which ' +
    'red squiggles the action would resolve). **Positions are 1-based** ' +
    '(consistent with the rest of the tool surface).';

export const GET_CODE_ACTIONS_TOOL: SharedToolDefinition<GetCodeActionsInput> = {
    name: 'tomAi_getCodeActions',
    displayName: 'Get Code Actions',
    description: GET_CODE_ACTIONS_DESCRIPTION,
    tags: ['refactor', 'context', 'tom-ai-chat'],
    readOnly: true,
    inputSchema: {
        type: 'object',
        required: ['filePath', 'startLine', 'startCharacter'],
        properties: {
            filePath: { type: 'string', description: 'File to query (workspace-relative or absolute).' },
            startLine: { type: 'number', description: '1-based start line.' },
            startCharacter: { type: 'number', description: '1-based start column.' },
            endLine: { type: 'number', description: '1-based end line. Defaults to startLine.' },
            endCharacter: { type: 'number', description: '1-based end column. Defaults to startCharacter.' },
            only: { type: 'string', description: 'CodeActionKind prefix filter, e.g. `"quickfix"`, `"refactor.extract"`.' },
        },
    },
    execute: async () => '{"error":"execute() must be installed by tool-executors.ts"}',
};

// ===========================================================================
// tomAi_getCodeActionsCached
// ===========================================================================

export interface GetCodeActionsCachedInput extends GetCodeActionsInput {}

export async function getCodeActionsCachedImpl(service: CodeActionService, input: GetCodeActionsCachedInput): Promise<string> {
    if (!input.filePath) { return JSON.stringify({ error: '`filePath` is required.' }); }
    const abs = service.resolveFile(input.filePath);
    if (!abs) { return JSON.stringify({ error: `File not found: ${input.filePath}` }); }
    const range = rangeFromInput(input);
    let listed: ListedCodeAction[];
    try {
        listed = await service.list(abs, range, input.only);
    } catch (err) {
        return JSON.stringify({ error: `Code actions failed: ${(err as Error).message}` });
    }
    const items = listed.map((l) => ({
        actionId: register(l.snapshot, l.token, abs),
        ...l.snapshot,
    }));
    return JSON.stringify({ count: items.length, actions: items }, null, 2);
}

export const GET_CODE_ACTIONS_CACHED_DESCRIPTION =
    'Like `tomAi_getCodeActions` but registers each action in a 5-minute ' +
    'in-memory cache and returns an `actionId` per result. Pass that ' +
    '`actionId` to `tomAi_applyCodeAction` to actually run it. Use this ' +
    'tool when you intend to apply, the bare `getCodeActions` when you ' +
    'just want to see what\'s available. **Cache is per extension-host ' +
    'process** — reloading the window invalidates every id. Expired ids ' +
    'return an instructive error from `applyCodeAction`. Same `only` ' +
    'filter values as `getCodeActions`.';

export const GET_CODE_ACTIONS_CACHED_TOOL: SharedToolDefinition<GetCodeActionsCachedInput> = {
    name: 'tomAi_getCodeActionsCached',
    displayName: 'Get Code Actions (Cached)',
    description: GET_CODE_ACTIONS_CACHED_DESCRIPTION,
    tags: ['refactor', 'edit', 'tom-ai-chat'],
    readOnly: true,
    inputSchema: {
        type: 'object',
        required: ['filePath', 'startLine', 'startCharacter'],
        properties: {
            filePath: { type: 'string' },
            startLine: { type: 'number', description: '1-based.' },
            startCharacter: { type: 'number', description: '1-based.' },
            endLine: { type: 'number', description: '1-based. Defaults to startLine.' },
            endCharacter: { type: 'number', description: '1-based. Defaults to startCharacter.' },
            only: { type: 'string' },
        },
    },
    execute: async () => '{"error":"execute() must be installed by tool-executors.ts"}',
};

// ===========================================================================
// tomAi_applyCodeAction
// ===========================================================================

export interface ApplyCodeActionInput { actionId: string }

export async function applyCodeActionImpl(service: CodeActionService, input: ApplyCodeActionInput): Promise<string> {
    if (!input.actionId) { return JSON.stringify({ error: '`actionId` is required.' }); }
    const found = lookup(input.actionId);
    if (!found) {
        return JSON.stringify({
            error: `Action not found: ${input.actionId}. Re-run \`tomAi_getCodeActionsCached\` and use a fresh actionId.`,
        });
    }
    if (found.expired) {
        return JSON.stringify({
            error: `Action expired (${CODE_ACTION_TTL_MS / 1000} s TTL): ${input.actionId}. Re-run \`tomAi_getCodeActionsCached\` and use a fresh actionId.`,
        });
    }
    let result: ApplyActionResult;
    try {
        result = await service.apply(found.entry.token);
    } catch (err) {
        return JSON.stringify({ error: `Apply code action failed: ${(err as Error).message}` });
    }
    return JSON.stringify({
        actionId: input.actionId,
        title: found.entry.snapshot.title,
        editApplied: result.editApplied,
        commandResult: result.commandResult,
        // Convenience flags so the model doesn't have to check both:
        success: result.editApplied !== false,
    }, null, 2);
}

export const APPLY_CODE_ACTION_DESCRIPTION =
    'Apply a code action previously returned by `tomAi_getCodeActionsCached` ' +
    'by its `actionId`. The action may have an edit, a command, or both — ' +
    'the response distinguishes: `editApplied` is `true`/`false`/`null` ' +
    '(`null` means the action had no edit; `false` means the edit was ' +
    'rejected by `vscode.workspace.applyEdit`), and `commandResult` is the ' +
    'command return value or `null` when no command was on the action. ' +
    'Ids expire 5 minutes after `tomAi_getCodeActionsCached` returned them; ' +
    'expired ids surface an explicit "expired" error so the model knows to ' +
    're-list rather than retry. Requires user approval.';

export const APPLY_CODE_ACTION_TOOL: SharedToolDefinition<ApplyCodeActionInput> = {
    name: 'tomAi_applyCodeAction',
    displayName: 'Apply Code Action',
    description: APPLY_CODE_ACTION_DESCRIPTION,
    tags: ['refactor', 'edit', 'tom-ai-chat'],
    readOnly: false,
    requiresApproval: true,
    inputSchema: {
        type: 'object',
        required: ['actionId'],
        properties: {
            actionId: { type: 'string', description: 'Id returned by `tomAi_getCodeActionsCached`. Expires after 5 min.' },
        },
    },
    execute: async () => '{"error":"execute() must be installed by tool-executors.ts"}',
};

// ===========================================================================
// Master list (for re-export)
// ===========================================================================

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export const CODE_ACTION_TOOLS: SharedToolDefinition<any>[] = [
    GET_CODE_ACTIONS_TOOL,
    GET_CODE_ACTIONS_CACHED_TOOL,
    APPLY_CODE_ACTION_TOOL,
];
