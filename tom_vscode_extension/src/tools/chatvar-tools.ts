/**
 * Chat-variable tools — `tomAi_readChatVariable` and
 * `tomAi_writeChatVariable`.
 *
 * Carved out of `tool-executors.ts` for coverage entry #14.
 *
 * Changes vs the previous impl:
 *
 *   - **vscode-free at runtime.** Impls take a narrow
 *     `ChatVariablesAccess` dep. Production wires
 *     `ChatVariablesStore.instance`; tests pass a plain-object fake.
 *
 *   - **Documented built-in name list.** The descriptions now enumerate
 *     every built-in key (`quest`, `role`, `activeProjects`, `todo`,
 *     `todoFile`) and the `custom.*` namespace, so the model doesn't
 *     have to discover them experimentally.
 *
 *   - **Persistence spelled out.** Variables live in a per-VS-Code-
 *     window YAML file; they survive window reload, not VS Code
 *     restart with a fresh window.
 *
 *   - **Explicit-delete contract.** Passing an empty string for a
 *     custom value **deletes the variable** (the store treats empty
 *     as "remove"). Previously undocumented; now in the description
 *     and the response distinguishes `created`, `updated`, `deleted`.
 *
 *   - **JSON envelope responses.** Both tools now return JSON with
 *     structured fields — `{ok, accepted: {created, updated, deleted},
 *     rejected: [...]}` for writes; the read snapshot is unchanged
 *     (already JSON).
 *
 *   - **Unknown custom key is distinguishable.** `readChatVariable`
 *     with an unknown custom key used to return `""` — same as a key
 *     that exists with empty value. The new response wraps every
 *     single-key read in `{key, value, exists}` so the model can tell.
 */

import { SharedToolDefinition } from './shared-tool-registry';

// ===========================================================================
// Narrow dep
// ===========================================================================

export interface ChatVariablesPublicSnapshot {
    quest: string;
    role: string;
    activeProjects: string[];
    todo: string;
    todoFile: string;
    custom: Record<string, string>;
}

export interface ChatVariablesAccess {
    /** Raw value for `key` — built-in (typed) or custom (string). */
    getRaw(key: string): unknown;
    /** Whether `key` is currently set (distinguishes empty-set from unset). */
    has(key: string): boolean;
    /** Full read-only snapshot for the "give me everything" path. */
    snapshot(): ChatVariablesPublicSnapshot;
    /** Bulk-set custom variables. Empty-string values delete. */
    setCustomBulk(values: Record<string, string>): void;
}

// ===========================================================================
// Built-in names (shared)
// ===========================================================================

export const BUILT_IN_CHATVAR_KEYS: ReadonlySet<string> = new Set([
    'quest', 'role', 'activeProjects', 'todo', 'todoFile',
]);

/** Idempotently strip the `custom.` prefix the model may send. */
function stripCustomPrefix(key: string): string {
    return key.startsWith('custom.') ? key.slice('custom.'.length) : key;
}

// ===========================================================================
// tomAi_readChatVariable
// ===========================================================================

export interface ChatvarReadInput {
    key?: string;
}

export async function readChatVariableImpl(deps: ChatVariablesAccess, input: ChatvarReadInput): Promise<string> {
    try {
        if (input.key) {
            const key = stripCustomPrefix(input.key);
            const value = deps.getRaw(key);
            // For built-ins, `has()` is always true (they always have a
            // value — possibly empty). For custom keys, `has()` tells
            // the model whether the key was ever written.
            const isBuiltIn = BUILT_IN_CHATVAR_KEYS.has(key);
            return JSON.stringify({
                key,
                value,
                exists: isBuiltIn || deps.has(key),
                isBuiltIn,
            }, null, 2);
        }
        const snap = deps.snapshot();
        return JSON.stringify({
            quest: snap.quest,
            role: snap.role,
            activeProjects: snap.activeProjects,
            todo: snap.todo,
            todoFile: snap.todoFile,
            custom: snap.custom,
        }, null, 2);
    } catch (e) {
        return JSON.stringify({ error: e instanceof Error ? e.message : String(e) });
    }
}

export const READ_CHATVAR_DESCRIPTION =
    'Read chat variables. **Built-in keys**: `quest` (active quest id), ' +
    '`role` (active role name), `activeProjects` (string[]), `todo` ' +
    '(selected todo id), `todoFile` (selected file name or `"all"`). ' +
    '**Custom keys** are stored under the `custom.*` namespace; you can ' +
    'address them as `custom.myKey` or just `myKey` — both forms resolve ' +
    'to the same value. Omit `key` to return the full snapshot ' +
    '(`{quest, role, activeProjects, todo, todoFile, custom}`); pass ' +
    '`key` to get `{key, value, exists, isBuiltIn}` for one variable — ' +
    '`exists: false` distinguishes an unknown custom key from one with ' +
    'an empty value. **Persistence**: per VS Code window, written to a ' +
    'YAML file under the workspace metadata folder; survives window ' +
    'reload, but a fresh window starts empty.';

export const READ_CHATVAR_TOOL: SharedToolDefinition<ChatvarReadInput> = {
    name: 'tomAi_readChatVariable',
    displayName: 'Chat Variable — Read',
    description: READ_CHATVAR_DESCRIPTION,
    tags: ['chat-variables', 'tom-ai-chat'],
    readOnly: true,
    requiresApproval: false,
    inputSchema: {
        type: 'object',
        properties: {
            key: {
                type: 'string',
                description: 'Optional variable name. Built-in (`quest`, `role`, …) or custom (with or without `custom.` prefix). Omit to return all variables.',
            },
        },
    },
    execute: async () => '{"error":"execute() must be installed by tool-executors.ts"}',
};

// ===========================================================================
// tomAi_writeChatVariable
// ===========================================================================

export interface ChatvarWriteInput {
    variables: Record<string, string>;
}

export interface ChatvarWriteResult {
    ok: boolean;
    accepted: {
        created: string[];
        updated: string[];
        deleted: string[];
    };
    rejected: Array<{ key: string; reason: string }>;
}

export async function writeChatVariableImpl(deps: ChatVariablesAccess, input: ChatvarWriteInput): Promise<string> {
    try {
        const entries = Object.entries(input.variables ?? {});
        const accepted: Record<string, string> = {};
        const created: string[] = [];
        const updated: string[] = [];
        const deleted: string[] = [];
        const rejected: ChatvarWriteResult['rejected'] = [];

        for (const [rawKey, rawValue] of entries) {
            const key = stripCustomPrefix(rawKey);
            if (!key) {
                rejected.push({ key: rawKey, reason: 'empty name' });
                continue;
            }
            if (BUILT_IN_CHATVAR_KEYS.has(key)) {
                rejected.push({ key, reason: 'built-in keys are user-only — set them from the Chat Variables panel' });
                continue;
            }
            // Coerce non-string values explicitly. Document the rules:
            //   null/undefined → '' (which means delete)
            //   number/boolean → String(value) — `String(true)` = `"true"`
            //   object/array   → String(value) — usually `"[object Object]"`, model should JSON.stringify itself
            const coerced = typeof rawValue === 'string' ? rawValue : String(rawValue ?? '');
            const wasPresent = deps.has(key);
            accepted[key] = coerced;
            if (coerced === '') {
                if (wasPresent) { deleted.push(key); }
                else {
                    // Setting an unknown key to '' is effectively a no-op; classify as rejected
                    // so the model knows nothing was actually persisted.
                    rejected.push({ key, reason: 'empty value would set/delete-nothing — pass a non-empty value to write, or call again on an existing key to delete' });
                    delete accepted[key];
                }
            } else if (wasPresent) {
                updated.push(key);
            } else {
                created.push(key);
            }
        }

        if (Object.keys(accepted).length > 0) {
            deps.setCustomBulk(accepted);
        }

        const result: ChatvarWriteResult = {
            ok: rejected.length === 0,
            accepted: { created, updated, deleted },
            rejected,
        };
        return JSON.stringify(result, null, 2);
    } catch (e) {
        return JSON.stringify({ error: e instanceof Error ? e.message : String(e) });
    }
}

export const WRITE_CHATVAR_DESCRIPTION =
    'Update one or more custom chat variables. Keys are stored under the ' +
    '`custom.*` namespace; passing `myKey` or `custom.myKey` is equivalent ' +
    '(the `custom.` prefix is stripped idempotently). **Built-in keys** ' +
    '(`quest`, `role`, `activeProjects`, `todo`, `todoFile`) are rejected ' +
    'with `reason: "built-in keys are user-only..."` — set those from the ' +
    'Chat Variables panel. **Empty-string value DELETES the variable** when ' +
    'the key currently exists; writing an empty string to an unknown key is ' +
    'rejected as "would set/delete nothing" so the model knows nothing was ' +
    'persisted. **Coercion rules**: strings pass through; null/undefined → ' +
    'empty string (= delete); numbers/booleans → `String(value)`; objects → ' +
    '`String(value)` (usually `"[object Object]"` — JSON-stringify yourself ' +
    'first if you want the JSON form). Response is `{ok, accepted: {created, ' +
    'updated, deleted}, rejected: [{key, reason}, ...]}`. No approval ' +
    'required — every write is visible live in the Chat Variables Editor.';

export const WRITE_CHATVAR_TOOL: SharedToolDefinition<ChatvarWriteInput> = {
    name: 'tomAi_writeChatVariable',
    displayName: 'Chat Variable — Write',
    description: WRITE_CHATVAR_DESCRIPTION,
    tags: ['chat-variables', 'tom-ai-chat'],
    readOnly: false,
    requiresApproval: false,
    inputSchema: {
        type: 'object',
        required: ['variables'],
        properties: {
            variables: {
                type: 'object',
                description: 'Map of name → string. `custom.` prefix optional (stripped). Empty value deletes when the key exists.',
                additionalProperties: { type: 'string' },
            },
        },
    },
    execute: async () => '{"error":"execute() must be installed by tool-executors.ts"}',
};

// ===========================================================================
// Master list
// ===========================================================================

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export const CHATVAR_TOOLS: SharedToolDefinition<any>[] = [
    READ_CHATVAR_TOOL,
    WRITE_CHATVAR_TOOL,
];
