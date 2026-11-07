/**
 * Which tools a request carries (DA-4 (b), DA-16 (a), CC-127 (a)).
 *
 * - The **core set** is always sent in full: the tools a todo walk uses in
 *   every run ({@link DEFAULT_CORE_TOOLS}), plus what the profile adds
 *   (`coreTools`).
 * - A prompt may name more tools with a directive line in its text — in the
 *   user-message template, a process step's prompt, an assist prompt or the
 *   typed prompt: `<!-- tools: tomAi_specApplyEdits, TomSpecs (edit), tomAi_spec* -->`
 *   (tool names, tool families as the profile editor groups them, or a
 *   `prefix*`). The directive is removed from the text sent.
 * - **Direct API:** the core set and the prompt's tools in full; every other
 *   tool of the profile is sent with `defer_loading: true` and found through
 *   the server-side BM25 tool search (`tool_search_tool_bm25_20251119`). A
 *   profile with `toolSearch: false` sends everything in full.
 * - **Local LLM and VS Code LM** (no tool search): with a directive, the core
 *   set plus the prompt's tools are the whole list; without one, the
 *   profile's list as before.
 * - **Agent SDK:** unchanged (it defers its tools itself).
 *
 * Only tools of the profile's own set are ever chosen. vscode-free.
 */

/** The tools a todo walk uses in every run: never deferred (DA-16 (a)). */
export const DEFAULT_CORE_TOOLS: readonly string[] = [
    'tomAi_readFile', 'tomAi_editFile', 'tomAi_multiEditFile', 'tomAi_createFile', 'tomAi_listDirectory',
    'tomAi_findFiles', 'tomAi_findTextInFiles', 'tomAi_runCommand', 'tomAi_runCommandStream', 'tomAi_readCommandOutput',
    'tomAi_gitRead', 'tomAi_gitWrite', 'tomAi_getQuestTodo', 'tomAi_updateQuestTodo', 'tomAi_createQuestTodo',
    'tomAi_generateIdPrefix', 'tomAi_askUser', 'tomAi_readPastToolResult', 'tomAi_notifyUser', 'tomAi_describeTool',
];

/** The server-side tool search the direct transport adds when it defers tools (API: ToolSearchToolBm25_20251119). */
export const TOOL_SEARCH_TOOL = { type: 'tool_search_tool_bm25_20251119', name: 'tool_search_tool_bm25' } as const;

/** `<!-- tools: a, b, Family -->`, anywhere in a text, one or more times. */
const DIRECTIVE = /<!--\s*tools\s*:([\s\S]*?)-->/gi;

export type ToolTransport = 'direct' | 'agentSdk' | 'vscodeLm' | 'localLlm';

/** The entries of every tools directive in the texts, in order, without repeats. */
export function toolsDirectiveEntries(...texts: Array<string | undefined>): string[] {
    const out: string[] = [];
    for (const text of texts) {
        if (!text) { continue; }
        for (const m of text.matchAll(DIRECTIVE)) {
            for (const raw of m[1].split(/[,\n]/)) {
                const entry = raw.trim();
                if (entry && !out.includes(entry)) { out.push(entry); }
            }
        }
    }
    return out;
}

/** The text without its tools directives (and the blank line one leaves). */
export function stripToolsDirectives(text: string): string {
    if (!/<!--\s*tools\s*:/i.test(text)) { return text; }
    return text.replace(/[ \t]*<!--\s*tools\s*:[\s\S]*?-->[ \t]*(\r?\n)?/gi, '');
}

/**
 * The tool names directive entries stand for, among `available` (the
 * profile's tools): an exact name; a family (`categories` key, any case); or a
 * `prefix*`. Entries that match nothing are returned as `unknown`.
 */
export function resolveToolEntries(
    entries: readonly string[],
    available: readonly string[],
    categories: Readonly<Record<string, readonly string[]>>,
): { names: string[]; unknown: string[] } {
    const have = new Set(available);
    const names: string[] = [];
    const unknown: string[] = [];
    const add = (n: string): void => { if (have.has(n) && !names.includes(n)) { names.push(n); } };
    const families = new Map(Object.entries(categories).map(([k, v]) => [k.toLowerCase(), v]));
    for (const entry of entries) {
        const before = names.length;
        if (have.has(entry)) {
            add(entry);
        } else if (families.has(entry.toLowerCase())) {
            families.get(entry.toLowerCase())!.forEach(add);
        } else if (entry.endsWith('*')) {
            const prefix = entry.slice(0, -1);
            available.filter((n) => n.startsWith(prefix)).forEach(add);
        }
        if (names.length === before && !(have.has(entry) || families.has(entry.toLowerCase()))) { unknown.push(entry); }
    }
    return { names, unknown };
}

/** What a request carries: the tools (names) and, on the direct transport, which of them are deferred. */
export interface ToolPlan {
    /** The tools the request may call, in the profile's order. */
    tools: string[];
    /** Direct API: the tools sent with `defer_loading: true` (found by tool search); empty elsewhere. */
    deferred: string[];
    /** The tools the prompt's directive named (resolved), for the payload dump. */
    fromPrompt: string[];
    /** Directive entries that named no tool of the profile. */
    unknown: string[];
}

export interface ToolPlanInput {
    transport: ToolTransport;
    /** The profile's tools, in order. */
    profileTools: readonly string[];
    /** The profile's additions to the core set. */
    profileCore?: readonly string[];
    /** False: the direct transport sends every tool in full. */
    toolSearch?: boolean;
    /** The directive entries of the prompt. */
    directive: readonly string[];
    categories: Readonly<Record<string, readonly string[]>>;
}

export function planRequestTools(input: ToolPlanInput): ToolPlan {
    const { names: fromPrompt, unknown } = resolveToolEntries(input.directive, input.profileTools, input.categories);
    const core = new Set([...DEFAULT_CORE_TOOLS, ...(input.profileCore ?? []), ...fromPrompt]);
    const all = [...input.profileTools];
    switch (input.transport) {
        case 'direct': {
            if (input.toolSearch === false) { return { tools: all, deferred: [], fromPrompt, unknown }; }
            const deferred = all.filter((n) => !core.has(n));
            // The API needs at least one tool sent in full; with none, nothing is deferred.
            if (deferred.length === all.length) { return { tools: all, deferred: [], fromPrompt, unknown }; }
            return { tools: all, deferred, fromPrompt, unknown };
        }
        case 'localLlm':
        case 'vscodeLm':
            if (input.directive.length === 0) { return { tools: all, deferred: [], fromPrompt, unknown }; }
            return { tools: all.filter((n) => core.has(n)), deferred: [], fromPrompt, unknown };
        default:
            return { tools: all, deferred: [], fromPrompt, unknown };
    }
}

/**
 * The `tools` of a direct request: the tools sent in full first, then the
 * search tool, then the deferred tools with `defer_loading: true` — so the
 * cache breakpoint (on the last tool sent in full, which the search tool is)
 * covers what the model reads, and a deferred schema loaded later appends.
 */
export function withToolSearch<T extends { name: string }>(tools: readonly T[], deferred: readonly string[]): Array<T | typeof TOOL_SEARCH_TOOL | (T & { defer_loading: true })> {
    if (deferred.length === 0) { return [...tools]; }
    const later = new Set(deferred);
    const full = tools.filter((t) => !later.has(t.name));
    const rest = tools.filter((t) => later.has(t.name)).map((t) => ({ ...t, defer_loading: true as const }));
    return [...full, TOOL_SEARCH_TOOL, ...rest];
}
