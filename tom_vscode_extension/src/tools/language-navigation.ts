/**
 * Language-server navigation tools — `tomAi_findSymbol`,
 * `tomAi_gotoDefinition`, `tomAi_findReferences`.
 *
 * Carved out of `language-service-tools.ts` for coverage entry #10
 * so they can be tested vscode-free. The remaining four tools in
 * that file (`getCodeActions`, `getCodeActionsCached`,
 * `applyCodeAction`, `rename`) belong to entry #11 and stay where
 * they are for now.
 *
 * Changes vs the previous impl:
 *
 *   - **vscode-free at runtime.** Impls take a narrow
 *     `LanguageNavigator` dep that returns plain `SymbolInfo` /
 *     `LocationInfo` records. The bridge to vscode lives in
 *     `tool-executors.ts`.
 *
 *   - **1-based line/character everywhere.** The previous impl was
 *     0-based in both inputs and outputs, inconsistent with
 *     `tomAi_readFile` / `tomAi_openFile` / `tomAi_getActiveEditor`
 *     (all 1-based after entries #1 / #6 / #9). Converted at the
 *     boundary; the dep interface stays 0-based to match vscode.
 *
 *   - **Overload surfacing.** `gotoDefinition` returning more than
 *     one location is a useful signal — the response now includes
 *     a `note` field when `count > 1` reminding the model that
 *     multiple definitions exist (overloads, interface + impl,
 *     decl + def in C++-land, etc.).
 *
 *   - **`includeDeclaration` actually works** on `findReferences`.
 *     The previous impl declared the param in the schema but never
 *     used it; vscode's reference provider always includes the
 *     declaration. We now post-filter: when `includeDeclaration: false`,
 *     we drop locations whose range overlaps the requested position.
 *     Not perfect (a perfect solution would require also calling
 *     `executeDefinitionProvider` to identify the declaration site),
 *     but it works for the common case where the model asks
 *     "where is this symbol used" and doesn't want the cursor's own
 *     position back as the first hit.
 *
 *   - **Tighter descriptions.** The previous one-sentence descriptions
 *     left "fuzzy vs exact" and "workspace-wide vs file-scoped"
 *     unsaid. Now spelled out, with example queries.
 */

import { SharedToolDefinition } from './shared-tool-registry';

// ===========================================================================
// Narrow dep types
// ===========================================================================

/**
 * Workspace-symbol search result. The string fields are formatted by
 * the bridge so the impl doesn't have to know about `vscode.Uri`.
 *
 * `line` / `character` are **0-based** to match vscode's native
 * `Position`; the impl converts to 1-based for the user-facing
 * response.
 */
export interface SymbolInfo {
    name: string;
    /** Symbol kind name (e.g. `'Class'`, `'Function'`, `'Method'`). */
    kind: string;
    containerName?: string;
    /** Workspace-relative when possible, else absolute. */
    file: string;
    absolutePath: string;
    line: number;
    character: number;
}

/**
 * Location result for `gotoDefinition` / `findReferences`. The bridge
 * normalises `vscode.Location` and `vscode.LocationLink` into this
 * single shape so the impl doesn't have to know about either.
 */
export interface LocationInfo {
    file: string;
    absolutePath: string;
    startLine: number;
    startCharacter: number;
    endLine: number;
    endCharacter: number;
}

export interface LanguageNavigator {
    findSymbol(query: string): Promise<SymbolInfo[]>;
    /** absPath, line, character are 0-based (vscode-native). */
    gotoDefinition(absPath: string, line: number, character: number): Promise<LocationInfo[]>;
    findReferences(absPath: string, line: number, character: number): Promise<LocationInfo[]>;
    /** Resolve a filePath input to an absolute path, returning null when missing. */
    resolveFile(filePath: string): string | null;
}

// ===========================================================================
// Conversion helpers — 1-based (user) ↔ 0-based (vscode)
// ===========================================================================

function locTo1Based(loc: LocationInfo): LocationInfo {
    return {
        file: loc.file,
        absolutePath: loc.absolutePath,
        startLine: loc.startLine + 1,
        startCharacter: loc.startCharacter + 1,
        endLine: loc.endLine + 1,
        endCharacter: loc.endCharacter + 1,
    };
}

function symbolTo1Based(s: SymbolInfo): SymbolInfo {
    return { ...s, line: s.line + 1, character: s.character + 1 };
}

function clampNonNegative(n: number): number {
    return Math.max(0, Math.floor(Number(n) || 0));
}

// ===========================================================================
// findSymbol — workspace-wide, fuzzy
// ===========================================================================

export interface FindSymbolInput {
    query: string;
    maxResults?: number;
    /** Optional kind filter — case-insensitive substring match against the kind name. */
    kind?: string;
}

export async function findSymbolImpl(deps: LanguageNavigator, input: FindSymbolInput): Promise<string> {
    if (!input.query) {
        return JSON.stringify({ error: '`query` is required.' });
    }
    const max = Math.max(1, Math.floor(input.maxResults ?? 100));
    let symbols: SymbolInfo[];
    try {
        symbols = await deps.findSymbol(input.query);
    } catch (err) {
        return JSON.stringify({ error: `Symbol search failed: ${(err as Error).message}` });
    }
    let filtered = symbols;
    if (input.kind) {
        const needle = input.kind.toLowerCase();
        filtered = filtered.filter((s) => s.kind.toLowerCase().includes(needle));
    }
    const slice = filtered.slice(0, max);
    return JSON.stringify({
        query: input.query,
        count: slice.length,
        totalMatched: filtered.length,
        truncated: filtered.length > slice.length,
        symbols: slice.map(symbolTo1Based),
    }, null, 2);
}

export const FIND_SYMBOL_DESCRIPTION =
    'Workspace-wide symbol search via the language server. **The match is ' +
    'fuzzy** — VS Code\'s workspace symbol provider returns symbols whose ' +
    'name contains, prefixes, or fuzzy-matches the query (provider-dependent). ' +
    'Pass `kind` to filter by symbol kind (case-insensitive substring match: ' +
    '`"class"`, `"function"`, `"method"`, `"interface"`, …). Default cap 100; ' +
    'the response includes `totalMatched` so the model can tell when the cap ' +
    'is the cause of `truncated: true` vs a genuinely small result. **Line/' +
    'character are 1-based** (consistent with `tomAi_readFile`, `tomAi_openFile`, ' +
    '`tomAi_getActiveEditor`). Returns `{query, count, totalMatched, truncated, ' +
    'symbols[]}` where each symbol has `name`, `kind`, `containerName`, ' +
    '`file`, `absolutePath`, `line`, `character`.';

export const FIND_SYMBOL_TOOL: SharedToolDefinition<FindSymbolInput> = {
    name: 'tomAi_findSymbol',
    displayName: 'Find Symbol',
    description: FIND_SYMBOL_DESCRIPTION,
    tags: ['symbols', 'navigation', 'tom-ai-chat'],
    readOnly: true,
    inputSchema: {
        type: 'object',
        required: ['query'],
        properties: {
            query: { type: 'string', description: 'Symbol name or substring to search for (fuzzy match).' },
            kind: { type: 'string', description: 'Filter by kind name (case-insensitive substring). Examples: "class", "function", "method".' },
            maxResults: { type: 'number', description: 'Max results returned (default 100).' },
        },
    },
    execute: async () => '{"error":"execute() must be installed by tool-executors.ts"}',
};

// ===========================================================================
// gotoDefinition
// ===========================================================================

export interface GotoDefinitionInput {
    filePath: string;
    /** 1-based. */
    line: number;
    /** 1-based. */
    character: number;
}

export async function gotoDefinitionImpl(deps: LanguageNavigator, input: GotoDefinitionInput): Promise<string> {
    if (!input.filePath) {
        return JSON.stringify({ error: '`filePath` is required.' });
    }
    if (typeof input.line !== 'number' || typeof input.character !== 'number') {
        return JSON.stringify({ error: '`line` and `character` are required (1-based).' });
    }
    const abs = deps.resolveFile(input.filePath);
    if (!abs) {
        return JSON.stringify({ error: `File not found: ${input.filePath}` });
    }
    let locs: LocationInfo[];
    try {
        // Convert 1-based input → 0-based for the underlying provider.
        locs = await deps.gotoDefinition(abs, clampNonNegative(input.line) - 1, clampNonNegative(input.character) - 1);
    } catch (err) {
        return JSON.stringify({ error: `Goto definition failed: ${(err as Error).message}` });
    }
    const out: Record<string, unknown> = {
        count: locs.length,
        definitions: locs.map(locTo1Based),
    };
    if (locs.length > 1) {
        out.note = `${locs.length} definitions found — likely overloads, interface+implementation, or declaration+definition.`;
    } else if (locs.length === 0) {
        out.note = 'No definition found. The position may not point at a renameable/navigable symbol, or the language server isn\'t ready yet.';
    }
    return JSON.stringify(out, null, 2);
}

export const GOTO_DEFINITION_DESCRIPTION =
    'Resolve the definition(s) of the symbol at a given file position via ' +
    'the language server. Returns ALL matching definitions — when `count > 1` ' +
    'the result is typically overloads, an interface+implementation pair, or ' +
    'a declaration+definition split (e.g. C++ headers + .cpp). The response ' +
    '`note` field flags this so you don\'t accidentally treat the first hit ' +
    'as canonical. **Line/character are 1-based** (consistent with the rest ' +
    'of the tool surface). Returns `{count, definitions[], note?}` where ' +
    'each definition has `file`, `absolutePath`, `startLine`/`startCharacter`, ' +
    '`endLine`/`endCharacter` — all 1-based.';

export const GOTO_DEFINITION_TOOL: SharedToolDefinition<GotoDefinitionInput> = {
    name: 'tomAi_gotoDefinition',
    displayName: 'Go To Definition',
    description: GOTO_DEFINITION_DESCRIPTION,
    tags: ['symbols', 'navigation', 'tom-ai-chat'],
    readOnly: true,
    inputSchema: {
        type: 'object',
        required: ['filePath', 'line', 'character'],
        properties: {
            filePath: { type: 'string', description: 'File containing the symbol (workspace-relative or absolute).' },
            line: { type: 'number', description: '1-based line number.' },
            character: { type: 'number', description: '1-based column.' },
        },
    },
    execute: async () => '{"error":"execute() must be installed by tool-executors.ts"}',
};

// ===========================================================================
// findReferences
// ===========================================================================

export interface FindReferencesInput {
    filePath: string;
    /** 1-based. */
    line: number;
    /** 1-based. */
    character: number;
    /** Default true — include the declaration site in the results. */
    includeDeclaration?: boolean;
    maxResults?: number;
}

export async function findReferencesImpl(deps: LanguageNavigator, input: FindReferencesInput): Promise<string> {
    if (!input.filePath) {
        return JSON.stringify({ error: '`filePath` is required.' });
    }
    if (typeof input.line !== 'number' || typeof input.character !== 'number') {
        return JSON.stringify({ error: '`line` and `character` are required (1-based).' });
    }
    const abs = deps.resolveFile(input.filePath);
    if (!abs) {
        return JSON.stringify({ error: `File not found: ${input.filePath}` });
    }
    const max = Math.max(1, Math.floor(input.maxResults ?? 500));
    const includeDecl = input.includeDeclaration !== false;
    // 1-based → 0-based for the dep.
    const line0 = clampNonNegative(input.line) - 1;
    const char0 = clampNonNegative(input.character) - 1;
    let locs: LocationInfo[];
    try {
        locs = await deps.findReferences(abs, line0, char0);
    } catch (err) {
        return JSON.stringify({ error: `Find references failed: ${(err as Error).message}` });
    }
    let filtered = locs;
    if (!includeDecl) {
        // Drop locations whose range straddles the requested cursor — that's
        // the declaration (or the cursor's own usage). Best-effort: in
        // multi-line situations this still does the right thing.
        filtered = filtered.filter((l) => !(
            l.absolutePath === abs &&
            (line0 >= l.startLine && line0 <= l.endLine) &&
            (line0 !== l.startLine || char0 >= l.startCharacter) &&
            (line0 !== l.endLine || char0 <= l.endCharacter)
        ));
    }
    const slice = filtered.slice(0, max);
    return JSON.stringify({
        count: slice.length,
        totalMatched: filtered.length,
        truncated: filtered.length > slice.length,
        includeDeclaration: includeDecl,
        references: slice.map(locTo1Based),
    }, null, 2);
}

export const FIND_REFERENCES_DESCRIPTION =
    'Find all references to the symbol at a given file position via the ' +
    'language server. `includeDeclaration` defaults to true — set it to false ' +
    'to drop the declaration site from the results (useful for "where is ' +
    'this used outside its definition" workflows). The exclude check is ' +
    'best-effort (matches the location whose range contains the cursor). ' +
    '**Line/character are 1-based** (consistent with the rest of the tool ' +
    'surface). Default cap 500; the response includes `totalMatched` so ' +
    'truncation by the cap is distinguishable from a small genuine result set.';

export const FIND_REFERENCES_TOOL: SharedToolDefinition<FindReferencesInput> = {
    name: 'tomAi_findReferences',
    displayName: 'Find References',
    description: FIND_REFERENCES_DESCRIPTION,
    tags: ['symbols', 'navigation', 'tom-ai-chat'],
    readOnly: true,
    inputSchema: {
        type: 'object',
        required: ['filePath', 'line', 'character'],
        properties: {
            filePath: { type: 'string', description: 'File containing the symbol (workspace-relative or absolute).' },
            line: { type: 'number', description: '1-based line number.' },
            character: { type: 'number', description: '1-based column.' },
            includeDeclaration: { type: 'boolean', description: 'Include the declaration site. Default true.' },
            maxResults: { type: 'number', description: 'Max references (default 500).' },
        },
    },
    execute: async () => '{"error":"execute() must be installed by tool-executors.ts"}',
};

// ===========================================================================
// Master list
// ===========================================================================

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export const LANGUAGE_NAVIGATION_TOOLS: SharedToolDefinition<any>[] = [
    FIND_SYMBOL_TOOL,
    GOTO_DEFINITION_TOOL,
    FIND_REFERENCES_TOOL,
];
