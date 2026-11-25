/**
 * Memory tools — `tomAi_saveMemory`, `tomAi_updateMemory`,
 * `tomAi_forgetMemory`, `tomAi_readMemory`, `tomAi_listMemory`.
 *
 * The five tools work on the files of the quest's memory folder,
 * `_ai/quests/<quest>/memory/`, by name: the curated files (`facts.md` the
 * default, a profile's `facts-<suffix>.md`, any other name) and the hosts'
 * candidates files (`candidates.<host>.md`, written by the automatic memory
 * extraction; src/services/questMemoryFiles.ts). There is no session level.
 *
 * In production they delegate to the `TwoTierMemoryService`; here they take
 * a narrow `MemoryStore` dep so tests can use an in-memory fake.
 *
 *   - **vscode-free at runtime.** Production wires
 *     `TwoTierMemoryService.instance` to the `MemoryStore` interface.
 *
 *   - **`suffix` filter on read/list.** The memory injection
 *     (`injectForSystemPrompt`) supports `suffix: 'gemma4'` to scope to
 *     `facts-<suffix>.md`, so a profile-scoped LLM gets an isolated memory
 *     bucket; `readMemory` / `listMemory` accept `suffix` with the same
 *     meaning (exactly `facts-<suffix>.md`).
 *
 *   - **File-vs-entry distinction spelled out** in every description:
 *     memory is a folder of files; each file holds zero or more
 *     `## Heading` entries.
 *
 *   - **Wildcard delete is not supported.** `forgetMemory` takes one file
 *     at a time.
 *
 *   - **saveMemory vs updateMemory**: they overlap when `heading` is
 *     provided; the descriptions point at each other.
 *
 *   - **Structured emptiness.** `listMemory` answers either the file list
 *     or the explicit text "(no memory files in <scope>)", never both.
 */

import { SharedToolDefinition } from './shared-tool-registry';
import { DEFAULT_MEMORY_FILE, candidatesHostOf, compareMemoryFiles } from '../services/questMemoryFiles';

// ===========================================================================
// Narrow dep
// ===========================================================================

/** The one memory tier: the quest's (`_ai/quests/<quest>/memory/`). There is no shared memory (al_the_bear ai_format_migration AC-18). */
export type MemoryScope = 'quest';
const QUEST: MemoryScope = 'quest';

/** The files of the quest's memory folder, by name (relative to the folder). */
export interface MemoryStore {
    list(scope: MemoryScope): string[];
    read(scope: MemoryScope, file: string): string;
    append(scope: MemoryScope, file: string, content: string): void;
    replaceSection(scope: MemoryScope, file: string, heading: string, content: string): void;
    delete(scope: MemoryScope, file: string): void;
}

/** Where the memory is and what its two kinds of file are: the tail of every tool description. */
const MEMORY_DOC = ' Memory is the quest\'s folder `_ai/quests/<quest>/memory/` (no session level, no shared memory). '
    + 'Two kinds of file: **curated** — `facts.md` (the default), `facts-<suffix>.md`, any other name — written '
    + 'deliberately; **candidates** — `candidates.<host>.md`, written by the automatic extraction, each line '
    + '`- <time> [<host>] {session=<session> file=<curated file>} <fact>`. To promote a candidate, save the fact '
    + 'into its curated file and remove its line. More: doc/llm_tools.md § 4.17.';

// ===========================================================================
// Helpers
// ===========================================================================

/**
 * The `scope` argument of older callers: `shared` is refused (there is no shared memory); `quest` and `all` mean
 * the quest memory, as every call does. Undefined when the call may go on.
 */
export function refuseSharedScope(scope: unknown): string | undefined {
    if (scope !== 'shared') { return undefined; }
    return JSON.stringify({
        error: 'There is no shared memory any more (_ai/memory/shared/ is no longer part of the workspace): memory is the '
            + 'quest\'s, _ai/quests/<quest>/memory/. Call without `scope`.',
        code: 'noSharedMemory',
    });
}

function passesSuffixFilter(file: string, suffix: string | undefined): boolean {
    if (!suffix) { return true; }
    // Mirror the injectForSystemPrompt strict policy: only the exact
    // `facts-<suffix>.md` file is in-scope for a profile.
    return file === `facts-${suffix}.md`;
}

/** How a file is named in a list or a read of everything: its kind after the name. */
function kindLabel(file: string): string {
    const host = candidatesHostOf(file);
    return host === undefined ? '[curated]' : `[candidates of host ${host}]`;
}

/** The folder's files, curated first, then the candidates files. */
function orderedFiles(store: MemoryStore, scope: MemoryScope): string[] {
    return [...store.list(scope)].sort(compareMemoryFiles);
}

// ===========================================================================
// tomAi_saveMemory
// ===========================================================================

export interface MemorySaveInput {
    /** Older callers' tier; only `shared` matters: it is refused. */
    scope?: string;
    file?: string;
    content: string;
    heading?: string;
}

export async function saveMemoryImpl(store: MemoryStore, input: MemorySaveInput): Promise<string> {
    const refused = refuseSharedScope(input.scope);
    if (refused) { return refused; }
    try {
        const scope = QUEST;
        const file = (input.file || DEFAULT_MEMORY_FILE).trim() || DEFAULT_MEMORY_FILE;
        if (!input.content || !input.content.trim()) {
            return JSON.stringify({ error: '`content` is empty.' });
        }
        if (input.heading) {
            store.replaceSection(scope, file, input.heading, input.content);
            return JSON.stringify({
                ok: true,
                action: 'replaced-section',
                scope, file, heading: input.heading,
                bytes: input.content.length,
            });
        }
        store.append(scope, file, input.content);
        return JSON.stringify({
            ok: true,
            action: 'appended',
            scope, file,
            bytes: input.content.length,
        });
    } catch (e) {
        return JSON.stringify({ error: e instanceof Error ? e.message : String(e) });
    }
}

export const SAVE_MEMORY_DESCRIPTION =
    'Add a fact to memory. Memory is structured as **a folder of files**, ' +
    'and each file holds **zero or more `## Heading` entries**. Default ' +
    'file is `facts.md`. When `heading` is omitted the content is **appended ' +
    'to the end of the file**; when provided it **replaces the section under ' +
    'that heading** (heading auto-created if absent). `saveMemory` with ' +
    '`heading` is semantically the same as `updateMemory`; pick `updateMemory` ' +
    'when you specifically want section-replace semantics so the intent is ' +
    'obvious to the reviewer.' + MEMORY_DOC;

export const SAVE_MEMORY_TOOL: SharedToolDefinition<MemorySaveInput> = {
    name: 'tomAi_saveMemory',
    displayName: 'Memory — Save',
    description: SAVE_MEMORY_DESCRIPTION,
    tags: ['memory', 'tom-ai-chat'],
    readOnly: false,
    requiresApproval: true,
    inputSchema: {
        type: 'object',
        required: ['content'],
        properties: {
            file: { type: 'string', description: 'File name in the memory folder (default `facts.md`); a candidates file by its name, `candidates.<host>.md`.' },
            content: { type: 'string', description: 'Fact body to persist.' },
            heading: { type: 'string', description: 'Optional section heading. Omit to append at end of file.' },
        },
    },
    execute: async () => '{"error":"execute() must be installed by tool-executors.ts"}',
};

// ===========================================================================
// tomAi_updateMemory
// ===========================================================================

export interface MemoryUpdateInput {
    /** Older callers' tier; only `shared` matters: it is refused. */
    scope?: string;
    file: string;
    heading: string;
    content: string;
}

export async function updateMemoryImpl(store: MemoryStore, input: MemoryUpdateInput): Promise<string> {
    const refused = refuseSharedScope(input.scope);
    if (refused) { return refused; }
    try {
        const scope = QUEST;
        if (!input.file || !input.heading) {
            return JSON.stringify({ error: '`file` and `heading` are both required.' });
        }
        store.replaceSection(scope, input.file, input.heading, input.content ?? '');
        return JSON.stringify({
            ok: true,
            action: 'replaced-section',
            scope, file: input.file, heading: input.heading,
            bytes: (input.content ?? '').length,
        });
    } catch (e) {
        return JSON.stringify({ error: e instanceof Error ? e.message : String(e) });
    }
}

export const UPDATE_MEMORY_DESCRIPTION =
    'Replace the body of a named section in a memory file. **Section = a ' +
    '`## Heading` block**; the impl finds the heading and overwrites every ' +
    'line until the next same-or-higher-level heading. **If the heading does ' +
    'not exist**, it is appended at the end as a new `## Heading` block. ' +
    'Semantically the same as `saveMemory` with `heading` provided — prefer ' +
    'this tool when section-replace is the intent so a reviewer can tell at ' +
    'a glance. Pass empty `content` to leave a stub heading; use ' +
    '`forgetMemory` with `heading` to remove a section entirely.' + MEMORY_DOC;

export const UPDATE_MEMORY_TOOL: SharedToolDefinition<MemoryUpdateInput> = {
    name: 'tomAi_updateMemory',
    displayName: 'Memory — Update section',
    description: UPDATE_MEMORY_DESCRIPTION,
    tags: ['memory', 'tom-ai-chat'],
    readOnly: false,
    requiresApproval: true,
    inputSchema: {
        type: 'object',
        required: ['file', 'heading', 'content'],
        properties: {
            file: { type: 'string', description: 'File name in the memory folder, e.g. `facts.md`.' },
            heading: { type: 'string', description: 'Heading text without the leading `#`.' },
            content: { type: 'string', description: 'New body for the section.' },
        },
    },
    execute: async () => '{"error":"execute() must be installed by tool-executors.ts"}',
};

// ===========================================================================
// tomAi_forgetMemory
// ===========================================================================

export interface MemoryForgetInput {
    /** Older callers' tier; only `shared` matters: it is refused. */
    scope?: string;
    file: string;
    heading?: string;
}

export async function forgetMemoryImpl(store: MemoryStore, input: MemoryForgetInput): Promise<string> {
    const refused = refuseSharedScope(input.scope);
    if (refused) { return refused; }
    try {
        const scope = QUEST;
        if (!input.file) {
            return JSON.stringify({ error: '`file` is required.' });
        }
        if (input.file.includes('*') || input.file.includes('?')) {
            return JSON.stringify({
                error: 'Wildcard delete is not supported — pass an exact file name. ' +
                       'Call `tomAi_listMemory` first if you need to enumerate matching files.',
            });
        }
        if (input.heading) {
            store.replaceSection(scope, input.file, input.heading, '');
            return JSON.stringify({
                ok: true,
                action: 'cleared-section',
                scope, file: input.file, heading: input.heading,
                note: 'Heading is preserved (with empty body). To remove the heading too, replace the whole file via `saveMemory` or call `forgetMemory` without `heading`.',
            });
        }
        store.delete(scope, input.file);
        return JSON.stringify({
            ok: true,
            action: 'deleted-file',
            scope, file: input.file,
        });
    } catch (e) {
        return JSON.stringify({ error: e instanceof Error ? e.message : String(e) });
    }
}

export const FORGET_MEMORY_DESCRIPTION =
    'Remove memory. **Without `heading`**: deletes the entire file. **With ' +
    '`heading`**: clears the section\'s body but **keeps the heading itself** ' +
    '(empty section). To wipe a section heading and all, delete the file ' +
    'and re-create it via `saveMemory`. **Wildcards (`*`, `?`) are NOT ' +
    'supported** — pass a literal file name. Use `tomAi_listMemory` to ' +
    'enumerate files first if you need to clean up several at once.' + MEMORY_DOC;

export const FORGET_MEMORY_TOOL: SharedToolDefinition<MemoryForgetInput> = {
    name: 'tomAi_forgetMemory',
    displayName: 'Memory — Forget',
    description: FORGET_MEMORY_DESCRIPTION,
    tags: ['memory', 'tom-ai-chat'],
    readOnly: false,
    requiresApproval: true,
    inputSchema: {
        type: 'object',
        required: ['file'],
        properties: {
            file: { type: 'string', description: 'Exact file name in the memory folder (no wildcards).' },
            heading: { type: 'string', description: 'Optional heading to clear instead of deleting the whole file.' },
        },
    },
    execute: async () => '{"error":"execute() must be installed by tool-executors.ts"}',
};

// ===========================================================================
// tomAi_readMemory
// ===========================================================================

export interface MemoryReadInput {
    /** Older callers' tier; only `shared` matters: it is refused. */
    scope?: string;
    file?: string;
    /**
     * Profile suffix. When provided, restricts the read to
     * `facts-<suffix>.md` only — matches the strict policy of
     * `injectForSystemPrompt(suffix)` so the model sees exactly
     * what would be injected into its system prompt.
     */
    suffix?: string;
}

export async function readMemoryImpl(store: MemoryStore, input: MemoryReadInput): Promise<string> {
    const refused = refuseSharedScope(input.scope);
    if (refused) { return refused; }
    try {
        const scope = QUEST;
        const suffix = input.suffix?.trim() || undefined;

        if (input.file) {
            // Explicit file path: ignore suffix (model asked for a specific file).
            const body = store.read(scope, input.file);
            return body ? body : '(empty)';
        }

        // No explicit file → concatenate every file (filtered by suffix if set).
        const parts: string[] = [];
        for (const file of orderedFiles(store, scope)) {
            if (!passesSuffixFilter(file, suffix)) { continue; }
            const body = store.read(scope, file);
            if (!body.trim()) { continue; }
            parts.push(`### ${scope}/${file} ${kindLabel(file)}\n${body.trimEnd()}`);
        }
        if (parts.length === 0) {
            return suffix
                ? `(no memory files matching facts-${suffix}.md in ${scope})`
                : `(no memory files in ${scope})`;
        }
        return parts.join('\n\n');
    } catch (e) {
        return JSON.stringify({ error: e instanceof Error ? e.message : String(e) });
    }
}

export const READ_MEMORY_DESCRIPTION =
    'Read memory. **Pass `file`** to read one file (returns its raw body, or ' +
    '`(empty)` if missing). **Omit `file`** to read every file, the curated ' +
    'ones first, concatenated as `### quest/<file> [curated]\\n<body>` blocks ' +
    '(a candidates file: `[candidates of host <host>]`). **Pass `suffix`** ' +
    '(e.g. `"gemma4"`) to restrict to `facts-<suffix>.md` only — matches ' +
    'the per-profile memory bucket that gets injected into the system ' +
    'prompt for that profile, so you can verify exactly what the LLM will ' +
    'see. `suffix` is ignored when an explicit `file` is given.' + MEMORY_DOC;

export const READ_MEMORY_TOOL: SharedToolDefinition<MemoryReadInput> = {
    name: 'tomAi_readMemory',
    displayName: 'Memory — Read',
    description: READ_MEMORY_DESCRIPTION,
    tags: ['memory', 'tom-ai-chat'],
    readOnly: true,
    requiresApproval: false,
    inputSchema: {
        type: 'object',
        properties: {
            file: { type: 'string', description: 'Optional file name in the memory folder (a curated file or a candidates file, `candidates.<host>.md`).' },
            suffix: { type: 'string', description: 'Optional profile suffix. Restricts to `facts-<suffix>.md`. Ignored when `file` is set.' },
        },
    },
    execute: async () => '{"error":"execute() must be installed by tool-executors.ts"}',
};

// ===========================================================================
// tomAi_listMemory
// ===========================================================================

export interface MemoryListInput {
    /** Older callers' tier; only `shared` matters: it is refused. */
    scope?: string;
    suffix?: string;
}

export async function listMemoryImpl(store: MemoryStore, input: MemoryListInput): Promise<string> {
    const refused = refuseSharedScope(input.scope);
    if (refused) { return refused; }
    try {
        const scope = QUEST;
        const suffix = input.suffix?.trim() || undefined;
        const lines: string[] = [];
        for (const f of orderedFiles(store, scope)) {
            if (passesSuffixFilter(f, suffix)) {
                lines.push(`${scope}/${f} ${kindLabel(f)}`);
            }
        }
        if (lines.length === 0) {
            return suffix
                ? `(no memory files matching facts-${suffix}.md in ${scope})`
                : `(no memory files in ${scope})`;
        }
        return lines.join('\n');
    } catch (e) {
        return JSON.stringify({ error: e instanceof Error ? e.message : String(e) });
    }
}

export const LIST_MEMORY_DESCRIPTION =
    'List the memory files, the curated ones first: one `quest/<file> [curated]` ' +
    'or `quest/<file> [candidates of host <host>]` per ' +
    'line. **No files return a single explicit `(no memory files in ' +
    'quest)` line** — never mixed with path-like lines, so the output ' +
    'is safe to split-parse. **Pass `suffix`** to restrict to `facts-<suffix>.md` only ' +
    '(matches the per-profile injection policy).' + MEMORY_DOC;

export const LIST_MEMORY_TOOL: SharedToolDefinition<MemoryListInput> = {
    name: 'tomAi_listMemory',
    displayName: 'Memory — List',
    description: LIST_MEMORY_DESCRIPTION,
    tags: ['memory', 'tom-ai-chat'],
    readOnly: true,
    requiresApproval: false,
    inputSchema: {
        type: 'object',
        properties: {
            suffix: { type: 'string', description: 'Optional profile suffix. Restricts to `facts-<suffix>.md`.' },
        },
    },
    execute: async () => '{"error":"execute() must be installed by tool-executors.ts"}',
};

// ===========================================================================
// Master list
// ===========================================================================

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export const MEMORY_TOOLS: SharedToolDefinition<any>[] = [
    SAVE_MEMORY_TOOL,
    UPDATE_MEMORY_TOOL,
    FORGET_MEMORY_TOOL,
    READ_MEMORY_TOOL,
    LIST_MEMORY_TOOL,
];
