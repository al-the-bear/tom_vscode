/**
 * Diagnostics tools — `tomAi_getErrors` (legacy text format) and
 * `tomAi_getProblems` (structured JSON). Both read from VS Code's
 * Problems panel via `vscode.languages.getDiagnostics`.
 *
 * Refactored for coverage entry #8:
 *
 *   - **vscode-free at runtime**. The impls take a narrow
 *     `DiagnosticsSource` dep that returns plain `DiagnosticInfo[]`,
 *     so tests pass synthetic arrays without touching vscode.
 *
 *   - **`tomAi_getErrors` absorbed from `tool-executors.ts`** so
 *     both diagnostics tools live next to each other. The relationship
 *     is documented honestly: `getErrors` is the back-compat text
 *     format that surfaces only errors and warnings; `getProblems`
 *     is the richer JSON tool with filters. New code should prefer
 *     `getProblems`; the description for `getErrors` points there.
 *
 *   - **Silent truncation fixed on `getErrors`**: it now returns
 *     `(showing 100 of N — re-run with tomAi_getProblems for the full list)`
 *     so the model knows when it hit the cap, instead of getting
 *     the same response shape regardless of whether 50 or 5 000
 *     issues were dropped.
 *
 *   - **Severity scale documented**. VS Code's enum is inverted
 *     (Error=0 → Hint=3), so "minimum severity = error" means "keep
 *     only entries with severity ≤ 0" → Error only. The previous
 *     impl had this right but with no comment; future maintainers
 *     reading the `d.severity > minSeverity` line wouldn't have known
 *     why it isn't `<`. Now spelled out.
 *
 *   - **Multi-provider duplication documented**. ESLint and the TS
 *     server can both report on the same line; both diagnostics
 *     legitimately appear. The new description says so explicitly
 *     and includes a `source` filter hint for "only show me TS errors".
 */

import * as path from 'path';
import { SharedToolDefinition } from './shared-tool-registry';

// ===========================================================================
// Narrow dep interface
// ===========================================================================

export type DiagnosticSeverityName = 'error' | 'warning' | 'information' | 'hint';

export interface DiagnosticInfo {
    /** Workspace-relative when possible, else absolute. */
    file: string;
    absolutePath: string;
    severity: DiagnosticSeverityName;
    /** 0-based to match the underlying VS Code Position. */
    line: number;
    character: number;
    endLine: number;
    endCharacter: number;
    message: string;
    source?: string;
    code?: string | number;
}

export interface DiagnosticsSource {
    /** Every diagnostic across the workspace. */
    getAll(): DiagnosticInfo[];
    /**
     * Single-file diagnostics. The caller (this Impl) resolves the
     * absolute path; the source just looks it up.
     */
    getForFile(absPath: string): DiagnosticInfo[];
}

// ===========================================================================
// Severity helpers — VS Code's enum is inverted: Error=0, Hint=3.
// ===========================================================================

const SEVERITY_RANK: Record<DiagnosticSeverityName, number> = {
    error: 0,
    warning: 1,
    information: 2,
    hint: 3,
};

function passesSeverityFilter(have: DiagnosticSeverityName, min: DiagnosticSeverityName | undefined): boolean {
    if (min === undefined) { return true; }
    // "Minimum severity" inclusive means: keep `have` if it's at least as
    // severe as `min`. Lower rank number = more severe, so `have <= min`.
    return SEVERITY_RANK[have] <= SEVERITY_RANK[min];
}

function severityFromName(name: string | undefined): DiagnosticSeverityName | undefined {
    if (!name) { return undefined; }
    const k = name.toLowerCase();
    if (k === 'info') { return 'information'; }
    if (k === 'error' || k === 'warning' || k === 'information' || k === 'hint') { return k as DiagnosticSeverityName; }
    return undefined;
}

// ===========================================================================
// Shared dispatch
// ===========================================================================

function collect(
    source: DiagnosticsSource,
    filePath: string | undefined,
    wsRoot: string,
): DiagnosticInfo[] {
    if (!filePath) { return source.getAll(); }
    const abs = path.isAbsolute(filePath)
        ? filePath
        : path.join(wsRoot || process.cwd(), filePath);
    return source.getForFile(abs);
}

// ===========================================================================
// tomAi_getErrors — legacy text format (errors + warnings only)
// ===========================================================================

export interface GetErrorsInput {
    filePath?: string;
}

const GET_ERRORS_CAP = 100;

export async function getErrorsImpl(
    deps: { source: DiagnosticsSource; wsRoot: string },
    input: GetErrorsInput,
): Promise<string> {
    const all = collect(deps.source, input.filePath, deps.wsRoot);
    const interesting = all.filter((d) => d.severity === 'error' || d.severity === 'warning');
    if (interesting.length === 0) {
        return 'No errors or warnings found.';
    }
    const slice = interesting.slice(0, GET_ERRORS_CAP);
    const lines = slice.map((d) => {
        const icon = d.severity === 'error' ? '❌' : '⚠️';
        // 1-based line for human-readable output (everything else in
        // the tool surface is 1-based; the underlying line is 0-based).
        return `${icon} ${d.file}:${d.line + 1}: ${d.message}`;
    });
    if (interesting.length > GET_ERRORS_CAP) {
        lines.push('');
        lines.push(`(showing first ${GET_ERRORS_CAP} of ${interesting.length} — use tomAi_getProblems for the full list with filters)`);
    }
    return lines.join('\n');
}

export const GET_ERRORS_DESCRIPTION =
    'Return errors and warnings from VS Code\'s Problems panel as a flat ' +
    'text list — one line per diagnostic, prefixed with ❌ (error) or ⚠️ ' +
    '(warning). Information/Hint entries are excluded. Capped at 100 entries; ' +
    'the response makes the cap visible with a "(showing first 100 of N)" ' +
    'note when triggered. This is the back-compat text format — for the ' +
    'structured JSON variant with severity / source / file filters and a ' +
    'higher cap, prefer `tomAi_getProblems`. Multiple providers (ESLint, ' +
    'TypeScript, dart_analyzer, …) can legitimately report on the same line; ' +
    'both diagnostics appear in the output — use `source` filtering on ' +
    '`tomAi_getProblems` to scope to one provider.';

export const GET_ERRORS_TOOL: SharedToolDefinition<GetErrorsInput> = {
    name: 'tomAi_getErrors',
    displayName: 'Get Errors',
    description: GET_ERRORS_DESCRIPTION,
    tags: ['diagnostics', 'tom-ai-chat'],
    readOnly: true,
    inputSchema: {
        type: 'object',
        properties: {
            filePath: { type: 'string', description: 'Optional file (workspace-relative or absolute). Omit for workspace-wide.' },
        },
    },
    execute: async () => 'execute() must be installed by tool-executors.ts',
};

// ===========================================================================
// tomAi_getProblems — structured JSON with filters
// ===========================================================================

export interface GetProblemsInput {
    filePath?: string;
    severity?: DiagnosticSeverityName;
    source?: string;
    maxResults?: number;
}

export async function getProblemsImpl(
    deps: { source: DiagnosticsSource; wsRoot: string },
    input: GetProblemsInput,
): Promise<string> {
    const all = collect(deps.source, input.filePath, deps.wsRoot);
    const min = severityFromName(input.severity);
    const maxResults = Math.max(1, input.maxResults ?? 500);

    const filtered: DiagnosticInfo[] = [];
    let scanned = 0;
    for (const d of all) {
        scanned += 1;
        if (!passesSeverityFilter(d.severity, min)) { continue; }
        if (input.source && d.source !== input.source) { continue; }
        filtered.push(d);
        if (filtered.length >= maxResults) { break; }
    }

    return JSON.stringify({
        count: filtered.length,
        scanned,
        truncated: scanned < all.length || filtered.length >= maxResults && all.length > maxResults,
        problems: filtered,
    }, null, 2);
}

export const GET_PROBLEMS_DESCRIPTION =
    'Return VS Code Problems panel entries as structured JSON. Supports ' +
    'filters: `filePath` to scope to one file (workspace-relative or absolute), ' +
    '`severity` for an inclusive minimum (`error` only / `warning`+ / `information`+ ' +
    '/ all incl. `hint`), and `source` to limit to one provider (e.g. ' +
    '`"eslint"`, `"ts"`, `"dart"`). Response: `{count, scanned, truncated, problems[]}` ' +
    'where each problem has `file`, `absolutePath`, `severity`, `line`/`character` ' +
    '(0-based to match VS Code), `endLine`/`endCharacter`, `message`, `source`, ' +
    '`code`. Default cap 500; the `truncated` flag fires when the cap clips ' +
    'the result set. Multi-provider duplication (ESLint + TS reporting the ' +
    'same line) is preserved — both diagnostics legitimately exist and are ' +
    'returned; combine with `source` to scope to one if you want a single voice.';

export const GET_PROBLEMS_TOOL: SharedToolDefinition<GetProblemsInput> = {
    name: 'tomAi_getProblems',
    displayName: 'Get Problems',
    description: GET_PROBLEMS_DESCRIPTION,
    tags: ['diagnostics', 'context', 'tom-ai-chat'],
    readOnly: true,
    inputSchema: {
        type: 'object',
        properties: {
            filePath: { type: 'string', description: 'Optional file to limit to. Workspace-relative or absolute.' },
            severity: {
                type: 'string',
                enum: ['error', 'warning', 'information', 'hint'],
                description: 'Inclusive minimum severity. `error` = only errors; `warning` = errors+warnings; `hint` = everything.',
            },
            source: { type: 'string', description: 'Filter by diagnostic source (e.g. `"eslint"`, `"ts"`, `"dart"`). Exact match.' },
            maxResults: { type: 'number', description: 'Cap on returned items. Default 500.' },
        },
    },
    execute: async () => 'execute() must be installed by tool-executors.ts',
};

// ===========================================================================
// Master list
// ===========================================================================

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export const DIAGNOSTICS_TOOLS: SharedToolDefinition<any>[] = [
    GET_ERRORS_TOOL,
    GET_PROBLEMS_TOOL,
];
