/**
 * Memory tools — `tomAi_saveMemory`, `tomAi_updateMemory`,
 * `tomAi_forgetMemory`, `tomAi_readMemory`, `tomAi_listMemory`.
 *
 * Carved out of `tool-executors.ts` for coverage entry #12. The five
 * tools all delegate to the `TwoTierMemoryService` in production;
 * here we take a narrow `MemoryStore` dep so tests can use an
 * in-memory Map-backed fake.
 *
 * Changes vs the previous impl:
 *
 *   - **vscode-free at runtime.** Production wires
 *     `TwoTierMemoryService.instance` to the `MemoryStore` interface.
 *
 *   - **`suffix` filter on read/list.** Production-side memory
 *     injection (`injectForSystemPrompt`) supports `suffix: 'gemma4'`
 *     to scope to `facts-<suffix>.md`, so a profile-scoped LLM gets
 *     an isolated memory bucket. The model-facing tools didn't expose
 *     this, so the LLM had no way to read what was about to be
 *     injected. Now `readMemory`/`listMemory` accept `suffix` with
 *     the same semantics (exact `facts-<suffix>.md` match per scope).
 *
 *   - **File-vs-entry distinction spelled out** in every description.
 *     The model frequently passes a section heading where a `file` is
 *     expected; the new wording makes the structure explicit
 *     ("memory is a folder of files; each file holds zero or more
 *     `## Heading` entries").
 *
 *   - **Wildcard delete explicitly NOT supported.** `forgetMemory`
 *     takes one file at a time — documented (checklist b).
 *
 *   - **saveMemory vs updateMemory relationship documented**. They
 *     overlap when `heading` is provided; the descriptions now point
 *     at each other so the model picks the more specific tool.
 *
 *   - **`(empty)` markers replaced with structured emptiness.**
 *     `listMemory` used to mix file paths with `(quest) (empty)`
 *     lines — a parser couldn't tell which was which. New output is
 *     either the file list or the explicit text "(no memory files
 *     in <scope>)" with no path-like lines mixed in.
 */

import { SharedToolDefinition } from './shared-tool-registry';
import { resolveSessionsArg, SESSIONS_PARAM_SCHEMA } from '../utils/sessionSelection';

// ===========================================================================
// Narrow dep
// ===========================================================================

/** The one memory tier: the quest's, per session. There is no shared memory (al_the_bear ai_format_migration AC-18). */
export type MemoryScope = 'quest';
const QUEST: MemoryScope = 'quest';

export interface MemoryStore {
    list(scope: MemoryScope): string[];
    read(scope: MemoryScope, file: string): string;
    append(scope: MemoryScope, file: string, content: string): void;
    replaceSection(scope: MemoryScope, file: string, heading: string, content: string): void;
    delete(scope: MemoryScope, file: string): void;
    /** The quest's sessions (for `sessions`). */
    knownSessions?(): string[];
    /** The session this call runs in. */
    callerSession?(): string | undefined;
    /** Run `fn` (synchronous) with `session` as the one the `quest` scope means. */
    inSession?<T>(session: string, fn: () => T): T;
}

// ===========================================================================
// `sessions`: quest memory is per session
// ===========================================================================

/** The tools' input field naming the sessions whose quest memory a call works on. */
export interface WithSessions {
    /** A session name, a list, or "all"; default: the session the call runs in. Quest scope only. */
    sessions?: string | string[];
}

/**
 * Run a memory call once per chosen session, each inside that session (quest
 * memory is per session: `_ai/memory/<quest>/<session>/`). Without `sessions`
 * the call runs once — in the session the call runs in. `run` is one of the Impls below: they do all their work
 * synchronously, which `inSession` relies on.
 */
async function perSession(
    store: MemoryStore,
    sessions: WithSessions['sessions'],
    scope: unknown,
    run: () => Promise<string>,
    combine: (results: Array<{ session: string; out: string }>) => string,
): Promise<string> {
    const refused = refuseSharedScope(scope);
    if (refused) { return refused; }
    if (sessions === undefined || (sessions as unknown) === '' || !store.inSession || !store.knownSessions) {
        return run();
    }
    const resolved = resolveSessionsArg(sessions, store.knownSessions(), store.callerSession?.() ?? 'default');
    if (!resolved.ok) { return JSON.stringify({ error: resolved.error, code: resolved.code, sessions: resolved.sessions }); }
    const results: Array<{ session: string; out: string }> = [];
    for (const session of resolved.sessions) {
        let pending: Promise<string> | undefined;
        store.inSession(session, () => { pending = run(); });
        results.push({ session, out: await pending! });
    }
    return combine(results);
}

/** Writes: one JSON answer per session. */
function combineWrites(results: Array<{ session: string; out: string }>): string {
    const parsed = results.map((r) => { try { return { session: r.session, ...JSON.parse(r.out) }; } catch { return { session: r.session, answer: r.out }; } });
    return JSON.stringify({ ok: parsed.every((p) => p.ok === true), sessions: parsed });
}

/** Reads: each session's text under its own heading. */
function combineReads(results: Array<{ session: string; out: string }>): string {
    return results.map((r) => `## session ${r.session}\n\n${r.out}`).join('\n\n');
}

const SESSIONS_DOC = ' Memory is the quest\'s, per session (`_ai/memory/<quest>/<session>/`; there is no shared memory): '
    + '`sessions` — a session name, a list, or `"all"` — works on those sessions\' memory (writes: each of them; '
    + 'reads and lists: each under a `## session <name>` heading); default the session the call runs in. An unknown '
    + 'session is refused (code unknownSession) naming the sessions there are.';

// ===========================================================================
// Helpers
// ===========================================================================

/**
 * The `scope` argument of older callers: `shared` is refused (the shared memory is gone); `quest` and `all` mean
 * the quest memory, as every call does now. Undefined when the call may go on.
 */
export function refuseSharedScope(scope: unknown): string | undefined {
    if (scope !== 'shared') { return undefined; }
    return JSON.stringify({
        error: 'There is no shared memory any more (_ai/memory/shared/ is no longer part of the workspace): memory is the '
            + 'quest\'s, per session. Call without `scope`.',
        code: 'noSharedMemory',
    });
}

function passesSuffixFilter(file: string, suffix: string | undefined): boolean {
    if (!suffix) { return true; }
    // Mirror the injectForSystemPrompt strict policy: only the exact
    // `facts-<suffix>.md` file in each scope is in-scope for a profile.
    return file === `facts-${suffix}.md`;
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

export async function saveMemoryImpl(store: MemoryStore, input: MemorySaveInput & WithSessions): Promise<string> {
    return perSession(store, input.sessions, input.scope, () => saveMemoryOne(store, input), combineWrites);
}

async function saveMemoryOne(store: MemoryStore, input: MemorySaveInput): Promise<string> {
    try {
        const scope = QUEST;
        const file = (input.file || 'facts.md').trim() || 'facts.md';
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
    'obvious to the reviewer.' + SESSIONS_DOC;

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
            sessions: SESSIONS_PARAM_SCHEMA,
            file: { type: 'string', description: 'File name in the memory folder (default `facts.md`).' },
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

export async function updateMemoryImpl(store: MemoryStore, input: MemoryUpdateInput & WithSessions): Promise<string> {
    return perSession(store, input.sessions, input.scope, () => updateMemoryOne(store, input), combineWrites);
}

async function updateMemoryOne(store: MemoryStore, input: MemoryUpdateInput): Promise<string> {
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
    '`forgetMemory` with `heading` to remove a section entirely.' + SESSIONS_DOC;

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
            sessions: SESSIONS_PARAM_SCHEMA,
            file: { type: 'string' },
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

export async function forgetMemoryImpl(store: MemoryStore, input: MemoryForgetInput & WithSessions): Promise<string> {
    return perSession(store, input.sessions, input.scope, () => forgetMemoryOne(store, input), combineWrites);
}

async function forgetMemoryOne(store: MemoryStore, input: MemoryForgetInput): Promise<string> {
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
    'enumerate files first if you need to clean up several at once.' + SESSIONS_DOC;

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
            sessions: SESSIONS_PARAM_SCHEMA,
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

export async function readMemoryImpl(store: MemoryStore, input: MemoryReadInput & WithSessions): Promise<string> {
    return perSession(store, input.sessions, input.scope, () => readMemoryOne(store, input), combineReads);
}

async function readMemoryOne(store: MemoryStore, input: MemoryReadInput): Promise<string> {
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
        for (const file of store.list(scope)) {
            if (!passesSuffixFilter(file, suffix)) { continue; }
            const body = store.read(scope, file);
            if (!body.trim()) { continue; }
            parts.push(`### ${scope}/${file}\n${body.trimEnd()}`);
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
    '`(empty)` if missing). **Omit `file`** to read every file ' +
    'concatenated as `### quest/file\\n<body>` blocks. **Pass `suffix`** ' +
    '(e.g. `"gemma4"`) to restrict to `facts-<suffix>.md` only — matches ' +
    'the per-profile memory bucket that gets injected into the system ' +
    'prompt for that profile, so you can verify exactly what the LLM will ' +
    'see. `suffix` is ignored when an explicit `file` is given.' + SESSIONS_DOC;

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
            sessions: SESSIONS_PARAM_SCHEMA,
            file: { type: 'string', description: 'Optional file name in the memory folder.' },
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

export async function listMemoryImpl(store: MemoryStore, input: MemoryListInput & WithSessions): Promise<string> {
    return perSession(store, input.sessions, input.scope, () => listMemoryOne(store, input), combineReads);
}

async function listMemoryOne(store: MemoryStore, input: MemoryListInput): Promise<string> {
    try {
        const scope = QUEST;
        const suffix = input.suffix?.trim() || undefined;
        const lines: string[] = [];
        for (const f of store.list(scope)) {
            if (passesSuffixFilter(f, suffix)) {
                lines.push(`${scope}/${f}`);
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
    'List the memory files. Returns one `quest/file` per ' +
    'line. **No files return a single explicit `(no memory files in ' +
    'quest)` line** — never mixed with path-like lines, so the output ' +
    'is safe to split-parse. **Pass `suffix`** to restrict to `facts-<suffix>.md` only ' +
    '(matches the per-profile injection policy).' + SESSIONS_DOC;

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
            sessions: SESSIONS_PARAM_SCHEMA,
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
