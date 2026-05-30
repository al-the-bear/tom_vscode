/**
 * Pattern-prompt tools.
 *
 * Pattern prompts are workspace-level instruction files invoked via
 * `!<name>` in chat (e.g. `!continue`, `!commit`).  The extension
 * substitutes the file body before sending the prompt; these tools
 * let an LLM discover and read those files so it can follow the
 * canonical instructions itself.
 *
 * ## Coverage entry #28 refactor (audit notes)
 *
 *   - Old impls reached into `vscode.workspace.workspaceFolders[0]`
 *     and `fs.readdirSync` directly — untestable without a workspace.
 *     Carve-out introduces a narrow `PatternPromptStore` dep so unit
 *     tests can drive an on-disk fixture (or pure in-memory map)
 *     against the same orchestration code.
 *   - **Path traversal hole closed** in `readPatternPrompt`:
 *     `normalizePromptName` only stripped the leading `!` and the
 *     `.md` suffix; `name: "../../etc/passwd"` survived and was
 *     joined into a path that escaped the prompts dir. The new impl
 *     rejects any name containing a path separator OR `..` segment
 *     BEFORE filesystem access. This was the b-row's "same trap as
 *     guidelines" — same flag, same fix.
 *   - **Envelopes unified**: both tools now use `{ok, ...}` /
 *     `{ok: false, error, ...}` consistently. Success still includes
 *     all the per-prompt metadata (name, invocation, source, size)
 *     so callers can keep using the shape.
 *   - **Fallback chain documented at the model surface**:
 *     `_copilot_guidelines/pattern_prompts/` is searched first, then
 *     `_copilot_tomai/pattern_prompts/`; first match wins per name.
 *     This is what the implementation has always done — now it's in
 *     the description so the model doesn't have to guess.
 *   - **Naming convention spelled out**: each `.md` file's basename
 *     (sans extension) is the invocation name; bare names + `!name`
 *     + `name.md` all resolve to the same prompt.
 */

import * as path from 'path';
import { SharedToolDefinition } from './shared-tool-registry';

// ===========================================================================
// Narrow dep
// ===========================================================================

export interface PatternPromptFile {
    /** Absolute path to the .md file. */
    absolutePath: string;
    /** Workspace-relative display path (used in envelopes). */
    relativePath: string;
    /** Bytes on disk. */
    size: number;
}

export interface PatternPromptStore {
    /**
     * Return the searched-and-existing prompt directories in lookup
     * order (`_copilot_guidelines/pattern_prompts/` first,
     * `_copilot_tomai/pattern_prompts/` second).  Missing dirs are
     * filtered out by the implementation.
     */
    promptDirs(): Array<{ absolutePath: string; relativePath: string }>;
    /**
     * List the .md files inside `directory.absolutePath` (single
     * level only — no recursion).
     */
    listFiles(directoryAbsolutePath: string): PatternPromptFile[];
    /**
     * Read the file's contents.  Returns `null` when the file is
     * missing; throws on permission / I-O failure.
     */
    readFile(absolutePath: string): string | null;
}

// ===========================================================================
// JSON envelopes
// ===========================================================================

function ok<T extends object>(extra: T): string { return JSON.stringify({ ok: true, ...extra }); }
function err(message: string, extra: Record<string, unknown> = {}): string {
    return JSON.stringify({ ok: false, error: message, ...extra });
}

// ===========================================================================
// Name normalisation + traversal guard
// ===========================================================================

/**
 * Strip the leading `!` and trailing `.md` so the model can pass any
 * of `continue` / `!continue` / `continue.md` and reach the same
 * prompt.  Trims whitespace.
 */
function normalisePromptName(name: string): string {
    let n = name.trim();
    if (n.startsWith('!')) { n = n.slice(1); }
    if (n.endsWith('.md')) { n = n.slice(0, -3); }
    return n;
}

/**
 * After normalisation, the name must be a single basename — no `/`,
 * no `\`, no `..` segments.  Anything else gets rejected before any
 * filesystem call, closing the traversal hole.
 */
function isSafeBasename(normalised: string): boolean {
    if (!normalised) { return false; }
    if (normalised.includes('/') || normalised.includes('\\')) { return false; }
    if (normalised === '.' || normalised === '..') { return false; }
    // Defence in depth: also reject any sequence VS Code's path layer
    // could resolve as a parent jump.
    if (normalised.split(/[/\\]/).some((seg) => seg === '..')) { return false; }
    return true;
}

// ===========================================================================
// `tomAi_listPatternPrompts`
// ===========================================================================

export interface ListPatternPromptsInput {
    // no params
}

export async function listPatternPromptsImpl(store: PatternPromptStore, _input: ListPatternPromptsInput): Promise<string> {
    try {
        const dirs = store.promptDirs();
        if (dirs.length === 0) {
            return err('No pattern_prompts folder found under _copilot_guidelines/ or _copilot_tomai/.', {
                searched: [
                    '_copilot_guidelines/pattern_prompts',
                    '_copilot_tomai/pattern_prompts',
                ],
            });
        }
        const seen = new Map<string, { name: string; invocation: string; source: string; size: number }>();
        for (const dir of dirs) {
            const files = store.listFiles(dir.absolutePath);
            for (const f of files) {
                const base = path.basename(f.absolutePath);
                if (!base.endsWith('.md')) { continue; }
                const name = base.slice(0, -3);
                // First match wins — preserves the documented "guidelines
                // overrides tomai" precedence.
                if (seen.has(name)) { continue; }
                seen.set(name, {
                    name,
                    invocation: `!${name}`,
                    source: f.relativePath,
                    size: f.size,
                });
            }
        }
        const prompts = Array.from(seen.values()).sort((a, b) => a.name.localeCompare(b.name));
        return ok({
            count: prompts.length,
            prompts,
            searchedDirs: dirs.map((d) => d.relativePath),
            note: 'Invoke in chat with `!<name>`. Use tomAi_readPatternPrompt to fetch a body.',
        });
    } catch (e) {
        return err(`listPatternPrompts failed: ${(e as Error).message}`);
    }
}

export const LIST_PATTERN_PROMPTS_DESCRIPTION =
    'List the workspace\'s pattern prompts. **Storage**: ' +
    '`_copilot_guidelines/pattern_prompts/` (searched first), then ' +
    '`_copilot_tomai/pattern_prompts/` (fallback). **First match per ' +
    'name wins** across the fallback chain — a guideline-folder prompt ' +
    'masks a tomai-folder one with the same name. **Naming**: each ' +
    '`.md` file\'s basename (sans extension) is the invocation name; ' +
    '`continue.md` → `!continue`. Response: ' +
    '`{ok, count, prompts: [{name, invocation, source, size}], ' +
    'searchedDirs, note}`. When neither folder exists, ' +
    '`{ok: false, searched: [...]}`.';

export const LIST_PATTERN_PROMPTS_TOOL: SharedToolDefinition<ListPatternPromptsInput> = {
    name: 'tomAi_listPatternPrompts',
    displayName: 'List Pattern Prompts',
    description: LIST_PATTERN_PROMPTS_DESCRIPTION,
    tags: ['patternPrompts', 'guidelines', 'tom-ai-chat'],
    readOnly: true,
    inputSchema: { type: 'object', properties: {} },
    execute: async () => '{"ok":false,"error":"execute() must be installed by tool-executors.ts"}',
};

// ===========================================================================
// `tomAi_readPatternPrompt`
// ===========================================================================

export interface ReadPatternPromptInput { name: string }

export async function readPatternPromptImpl(store: PatternPromptStore, input: ReadPatternPromptInput): Promise<string> {
    try {
        if (!input.name || !input.name.trim()) {
            return err('`name` is required (e.g. "continue", "!continue", or "continue.md").');
        }
        const normalised = normalisePromptName(input.name);
        if (!normalised) { return err('`name` resolves to an empty string after stripping `!` / `.md`.'); }
        if (!isSafeBasename(normalised)) {
            return err('`name` must be a bare prompt name — no path separators or `..` segments allowed.', {
                received: input.name,
                normalised,
            });
        }
        const dirs = store.promptDirs();
        if (dirs.length === 0) {
            return err('No pattern_prompts folder found under _copilot_guidelines/ or _copilot_tomai/.');
        }
        for (const dir of dirs) {
            const file = path.join(dir.absolutePath, `${normalised}.md`);
            const content = store.readFile(file);
            if (content !== null) {
                const relSource = path.posix.join(dir.relativePath.replace(/\\/g, '/'), `${normalised}.md`);
                return ok({
                    name: normalised,
                    invocation: `!${normalised}`,
                    source: relSource,
                    content,
                });
            }
        }
        return err(`Pattern prompt not found: "${normalised}".`, {
            hint: 'Use tomAi_listPatternPrompts to see what\'s available.',
            searchedDirs: dirs.map((d) => d.relativePath),
        });
    } catch (e) {
        return err(`readPatternPrompt failed: ${(e as Error).message}`);
    }
}

export const READ_PATTERN_PROMPT_DESCRIPTION =
    'Read the body of a pattern prompt by name. Accepts `continue`, ' +
    '`!continue`, or `continue.md` — the impl strips the leading `!` ' +
    'and trailing `.md` and then expects a **bare basename** (no path ' +
    'separators, no `..`). The fallback chain is the same as ' +
    '`tomAi_listPatternPrompts`: `_copilot_guidelines/pattern_prompts/` ' +
    'first, `_copilot_tomai/pattern_prompts/` second; first match wins. ' +
    'Response: `{ok, name, invocation, source, content}` on success; ' +
    '`{ok: false, error, hint, searchedDirs}` when not found.';

export const READ_PATTERN_PROMPT_TOOL: SharedToolDefinition<ReadPatternPromptInput> = {
    name: 'tomAi_readPatternPrompt',
    displayName: 'Read Pattern Prompt',
    description: READ_PATTERN_PROMPT_DESCRIPTION,
    tags: ['patternPrompts', 'guidelines', 'tom-ai-chat'],
    readOnly: true,
    inputSchema: {
        type: 'object',
        required: ['name'],
        properties: {
            name: { type: 'string', description: 'Prompt name (with or without the leading `!` and `.md`). Must be a bare basename — `/`, `\\`, and `..` are rejected.' },
        },
    },
    execute: async () => '{"ok":false,"error":"execute() must be installed by tool-executors.ts"}',
};

// ===========================================================================
// Live vscode bridge
// ===========================================================================

import * as vscode from 'vscode';
import * as fs from 'fs';

const PATTERN_SUBDIRS: ReadonlyArray<string> = [
    '_copilot_guidelines/pattern_prompts',
    '_copilot_tomai/pattern_prompts',
];

const liveStore: PatternPromptStore = {
    promptDirs() {
        const root = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
        if (!root) { return []; }
        return PATTERN_SUBDIRS
            .map((sub) => ({ absolutePath: path.join(root, sub), relativePath: sub }))
            .filter((d) => {
                try { return fs.existsSync(d.absolutePath) && fs.statSync(d.absolutePath).isDirectory(); }
                catch { return false; }
            });
    },
    listFiles(absoluteFolder) {
        try {
            const entries = fs.readdirSync(absoluteFolder, { withFileTypes: true });
            const root = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? '';
            const out: PatternPromptFile[] = [];
            for (const e of entries) {
                if (!e.isFile() || !e.name.endsWith('.md')) { continue; }
                const abs = path.join(absoluteFolder, e.name);
                let size = 0;
                try { size = fs.statSync(abs).size; } catch { /* ignore */ }
                out.push({
                    absolutePath: abs,
                    relativePath: path.relative(root, abs),
                    size,
                });
            }
            return out;
        } catch { return []; }
    },
    readFile(absolutePath) {
        if (!fs.existsSync(absolutePath)) { return null; }
        try { return fs.readFileSync(absolutePath, 'utf8'); }
        catch (e) { throw e; }
    },
};

LIST_PATTERN_PROMPTS_TOOL.execute = (input) => listPatternPromptsImpl(liveStore, input);
READ_PATTERN_PROMPT_TOOL.execute  = (input) => readPatternPromptImpl(liveStore, input);

// ===========================================================================
// Master list
// ===========================================================================

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export const PATTERN_PROMPTS_TOOLS: SharedToolDefinition<any>[] = [
    LIST_PATTERN_PROMPTS_TOOL,
    READ_PATTERN_PROMPT_TOOL,
];
