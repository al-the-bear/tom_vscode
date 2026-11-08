/**
 * CodeSpecs query and trace — the questions asked during and after Phase 4:
 * which spec value a generated declaration comes from, what was generated
 * from a section, where a token is used.
 *
 *   tomAi_specCodeSpecsQueryExtracts  entries of a written run, filtered by area, token, path or text
 *   tomAi_specCodeSpecsTrace          spec path / token / code location → the other end, and the
 *                                     tokens the two ends disagree on
 *
 * Extracts are read from a written run (any writer: these tools, the Dart CLI)
 * through the runtime's reader. The code side is the back-link index
 * `validate_codespecs --backlinks` writes; see services/codespecs-trace.ts.
 */

import * as fs from 'fs';
import * as path from 'path';

import { SharedToolDefinition } from './shared-tool-registry';
import { FILE_PARAM, SpecToolDeps, json, liveDeps, loadDocument, resolveInput, toWorkspacePath } from './spec-tool-common';
import { EXTRACTS_DIR, codeSpecsFailure } from './codespecs-tools';
import { CodeSpecsBinaryMissing, CodeSpecsUsageError, noteValidationSkipped, validatorMissingWarning } from '../services/codespecs-validator';
import { dartBinariesHelp } from '../services/dartBinariesStatus';
import {
    BacklinkIndex,
    ExtractDirectory,
    declarationAt,
    declarationView,
    entryView,
    parseBacklinkIndex,
    queryEntries,
    readExtractDirectory,
    tokenAgreement,
} from '../services/codespecs-trace';

// ---------------------------------------------------------------------------
// Inputs and shared steps
// ---------------------------------------------------------------------------

/** Where the extracts are: explicitly, or beside the spec document. */
export interface ExtractsLocator {
    extractsDir?: string;
    file?: string;
}

export interface CodeSpecsQueryInput extends ExtractsLocator {
    area?: string;
    token?: string;
    path?: string;
    text?: string;
    limit?: number;
}

export interface CodeDirs {
    shared?: string;
    client?: string;
    server?: string;
}

export interface CodeSpecsTraceInput extends ExtractsLocator {
    /** A `codespecs-backlinks` JSON file. */
    backlinks?: string;
    /** The generated trio's package folders, read through the bundled validate_codespecs. */
    codeDirs?: CodeDirs;
    specPath?: string;
    token?: string;
    codeFile?: string;
    line?: number;
    declaration?: string;
}

/**
 * Produces the back-link index for a trio. The extension installs the bundled
 * validate_codespecs binary (`backlinkIndexJson`) at activation; a test may
 * install its own. `null`: the binary is missing on this platform, so there
 * are no back-links (the trace goes on without them and says so).
 */
export type BacklinkProvider = (dirs: CodeDirs) => Promise<string | null>;
let backlinkProvider: BacklinkProvider | null = null;

/** Install (or clear) the back-link provider: the bundled validate_codespecs binary. */
export function setBacklinkProvider(provider: BacklinkProvider | null): void {
    backlinkProvider = provider;
}

class TraceInputError extends Error {
    constructor(readonly code: string, message: string) {
        super(message);
    }
}

export function extractsDirOf(deps: SpecToolDeps, input: ExtractsLocator): string {
    if (input.extractsDir) { return resolveInput(deps, input.extractsDir); }
    if (input.file) { return path.join(path.dirname(resolveInput(deps, input.file)), EXTRACTS_DIR); }
    throw new TraceInputError('invalidInput', 'Pass `extractsDir` (a written run) or `file` (the spec document, whose run sits beside it).');
}

function directoryHeader(deps: SpecToolDeps, dir: ExtractDirectory): Record<string, unknown> {
    return {
        extractsDir: toWorkspacePath(deps, dir.dir),
        areas: dir.files.length,
        ...(dir.gate ? { gateRecord: true, outOfScope: dir.files.filter((f) => !f.inScope).map((f) => f.extract.area.code) } : {}),
        ...(dir.gateError ? { gateRecordError: dir.gateError } : {}),
        ...(dir.unreadable.length > 0 ? { unreadable: dir.unreadable } : {}),
    };
}

/** The warning a trace over `codeDirs` carries when validate_codespecs is missing. */
export const NO_AGREEMENT = 'no back-link agreement (checks 35, 36)';

/** No back-links from `codeDirs`: validate_codespecs is missing on this platform. */
class BacklinksUnavailable extends Error {}

async function loadBacklinks(deps: SpecToolDeps, input: CodeSpecsTraceInput): Promise<BacklinkIndex | null> {
    if (input.backlinks) {
        const file = resolveInput(deps, input.backlinks);
        if (!fs.existsSync(file)) { throw new TraceInputError('notFound', `No back-link index at ${input.backlinks}.`); }
        return parseBacklinkIndex(fs.readFileSync(file, 'utf8'), input.backlinks);
    }
    if (input.codeDirs) {
        if (!backlinkProvider) {
            throw new TraceInputError('noBacklinkSource',
                'No back-link provider is installed: the extension installs the bundled validate_codespecs at activation. '
                + 'Pass `backlinks` instead: the JSON `validate_codespecs --backlinks --shared … --client … --server …` writes.');
        }
        const resolved: CodeDirs = {};
        for (const k of ['shared', 'client', 'server'] as const) {
            if (input.codeDirs[k]) { resolved[k] = resolveInput(deps, input.codeDirs[k] as string); }
        }
        let indexJson: string | null;
        try {
            indexJson = await backlinkProvider(resolved);
        } catch (e) {
            if (e instanceof CodeSpecsBinaryMissing) { throw new BacklinksUnavailable(e.message); }
            throw e;
        }
        if (indexJson === null) { throw new BacklinksUnavailable(); }
        return parseBacklinkIndex(indexJson, 'validate_codespecs --backlinks');
    }
    return null;
}

/**
 * The back-links, or — when `codeDirs` needs validate_codespecs and it is
 * missing — none, with the warning the answer carries (the user is told once).
 */
async function loadBacklinksOrWarn(deps: SpecToolDeps, input: CodeSpecsTraceInput): Promise<{ index: BacklinkIndex | null; warnings: string[] }> {
    try {
        return { index: await loadBacklinks(deps, input), warnings: [] };
    } catch (e) {
        if (!(e instanceof BacklinksUnavailable)) { throw e; }
        noteValidationSkipped('tomAi_specCodeSpecsTrace');
        return { index: null, warnings: [validatorMissingWarning(NO_AGREEMENT)] };
    }
}

function traceFailure(e: unknown): string {
    if (e instanceof TraceInputError) {
        return json({ ok: false, code: e.code, error: e.message });
    }
    if (e instanceof CodeSpecsBinaryMissing) {
        return json({ ok: false, code: 'binaryMissing', error: e.message });
    }
    if (e instanceof CodeSpecsUsageError) {
        return json({ ok: false, code: 'usageError', error: e.message });
    }
    return codeSpecsFailure(e);
}

// ---------------------------------------------------------------------------
// Implementations
// ---------------------------------------------------------------------------

export async function codeSpecsQueryImpl(deps: SpecToolDeps, input: CodeSpecsQueryInput): Promise<string> {
    try {
        const dir = readExtractDirectory(extractsDirOf(deps, input));
        const hits = queryEntries(dir, input);
        const limit = Math.max(1, Math.min(input.limit ?? 200, 2000));
        return json({
            ok: true,
            ...directoryHeader(deps, dir),
            total: hits.length,
            entries: hits.slice(0, limit).map(({ entry, inScope }) => ({ ...entryView(entry), ...(inScope ? {} : { outOfScope: true }) })),
            ...(hits.length > limit ? { truncated: true } : {}),
        });
    } catch (e) {
        return traceFailure(e);
    }
}

export async function codeSpecsTraceImpl(deps: SpecToolDeps, input: CodeSpecsTraceInput): Promise<string> {
    try {
        const starts = [input.specPath, input.token, input.codeFile, input.declaration].filter((x) => x !== undefined);
        if (starts.length !== 1) {
            throw new TraceInputError('invalidInput', 'Trace from exactly one of `specPath`, `token`, `codeFile` (+ `line`) or `declaration`.');
        }
        const dir = readExtractDirectory(extractsDirOf(deps, input));
        const { index, warnings } = await loadBacklinksOrWarn(deps, input);
        if ((input.codeFile || input.declaration) && !index) {
            if (warnings.length > 0) {
                // Tracing from code has nothing to start from without the back-links.
                return json({ ok: false, code: 'binaryMissing', error: `Tracing from code needs the back-links, and ${warnings[0]}. Pass \`backlinks\` (an index written where the binary runs).`, warnings, ...dartBinariesHelp() });
            }
            throw new TraceInputError('noBacklinkSource', 'Tracing from code needs the back-links: pass `backlinks` (or `codeDirs`).');
        }
        const citedBy = (token: string): Array<Record<string, unknown>> =>
            index ? index.declarations.filter((d) => d.tokens.includes(token)).map(declarationView) : [];
        const tokensWithLinks = (tokens: string[]): Array<Record<string, unknown>> => tokens.map((token) => {
            const entries = queryEntries(dir, { token });
            return {
                token,
                entries: entries.map(({ entry, inScope }) => ({ ...entryView(entry), ...(inScope ? {} : { outOfScope: true }) })),
                ...(index ? { citedBy: citedBy(token) } : {}),
            };
        });

        let trace: Record<string, unknown>;
        if (input.specPath) {
            const hits = queryEntries(dir, { path: input.specPath });
            const tokens = [...new Set(hits.map((h) => h.entry.sectionId))];
            const forward: Array<{ path: string; codeSpec: string }> = [];
            if (input.file) {
                // The heading `codeSpec=` forward link of the node and its ancestors.
                const doc = loadDocument(deps, input.file).document;
                const segs = input.specPath.split('/');
                for (let i = segs.length; i >= 1; i--) {
                    const p = segs.slice(0, i).join('/');
                    const cs = doc.codeSpec(p);
                    if (cs) { forward.push({ path: p, codeSpec: cs }); }
                }
            }
            trace = {
                from: { specPath: input.specPath },
                ...(input.file ? { headingCodeSpec: forward } : {}),
                tokens: tokensWithLinks(tokens).map((t) => ({ ...t, entries: (t.entries as Array<{ path: string }>).filter((e) => e.path === input.specPath || e.path.startsWith(`${input.specPath}/`)) })),
            };
        } else if (input.token) {
            trace = { from: { token: input.token }, tokens: tokensWithLinks([input.token]) };
        } else {
            const idx = index as BacklinkIndex;
            const decl = input.declaration
                ? idx.declarations.find((d) => d.codeSpec?.id === input.declaration || d.name === input.declaration
                    || `${d.owner ?? ''}.${d.name}` === input.declaration) ?? null
                : declarationAt(idx, input.codeFile as string, input.line ?? Number.MAX_SAFE_INTEGER);
            if (!decl) {
                throw new TraceInputError('notFound', `No declaration in the back-link index matches ${input.declaration ?? `${input.codeFile}:${input.line ?? ''}`}.`);
            }
            trace = {
                from: { declaration: declarationView(decl) },
                ...(decl.codeSpec ? { codeSpec: { id: decl.codeSpec.id, source: decl.codeSpec.source } } : {}),
                ...(decl.docSpec ? { docSpec: decl.docSpec } : {}),
                tokens: tokensWithLinks(decl.tokens).map((t) => ({ ...t, ...((t.entries as unknown[]).length === 0 ? { dangling: true } : {}) })),
            };
        }

        const agreement = index ? tokenAgreement(dir, index) : null;
        return json({
            ok: true,
            ...directoryHeader(deps, dir),
            ...(index ? { backlinks: { declarations: index.declarations.length, inputs: index.inputs } } : { backlinks: null }),
            ...trace,
            ...(agreement ? {
                agreement: {
                    passed: agreement.uncited.length === 0 && agreement.dangling.length === 0,
                    uncited: agreement.uncited,
                    dangling: agreement.dangling,
                },
            } : {}),
            ...(warnings.length > 0 ? { warnings, ...dartBinariesHelp() } : {}),
        });
    } catch (e) {
        return traceFailure(e);
    }
}

// ---------------------------------------------------------------------------
// Tool definitions
// ---------------------------------------------------------------------------

const LOCATOR = {
    extractsDir: { type: 'string', description: 'A written run\'s extract folder (holding `CE-….extract.yaml`, maybe `gate.verdicts.yaml`). Or pass `file`.' },
    file: { ...FILE_PARAM, description: 'The specification document; its run is `generated-doc/codespecs_extracts/` beside it. Or pass `extractsDir`.' },
};

export const CODESPECS_QUERY_TOOL: SharedToolDefinition<CodeSpecsQueryInput> = {
    name: 'tomAi_specCodeSpecsQueryExtracts',
    displayName: 'CodeSpecs: Query Extracts',
    description:
        'Query the entries of a written CodeSpecs run (any writer: tomAi_specCodeSpecsWriteExtracts or the Dart CLI), read '
        + 'through the runtime\'s reader. Filters, AND-combined: `area` (CE-…), `token` (a section id — the unit back-links '
        + 'cite), `path` (that spec path and below), `text` (substring of the value, any case). Each entry: area, token, '
        + 'path, class, field, instance id, headline, the routing that placed it, the verbatim value; `outOfScope` when '
        + 'the gate record puts its area out of this pass. An extract in a format this runtime does not read is listed '
        + 'under `unreadable`, never misread.',
    tags: ['tomspecs', 'codespecs', 'tom-ai-chat'],
    readOnly: true,
    inputSchema: {
        type: 'object',
        properties: {
            ...LOCATOR,
            area: { type: 'string', description: 'An area code, e.g. `CE-DB`.' },
            token: { type: 'string', description: 'A section-id token, e.g. `DAENT-IDEN`.' },
            path: { type: 'string', description: 'A document path; entries at or below it.' },
            text: { type: 'string', description: 'A substring of the value.' },
            limit: { type: 'number', description: 'Most entries to return. Default 200, max 2000.' },
        },
    },
    execute: async (input) => codeSpecsQueryImpl(liveDeps(), input),
};

export const CODESPECS_TRACE_TOOL: SharedToolDefinition<CodeSpecsTraceInput> = {
    name: 'tomAi_specCodeSpecsTrace',
    displayName: 'CodeSpecs: Trace',
    description:
        'Trace between a specification and its generated code by section-id TOKEN (what `@CodeSpec(source: […])` / `@DocSpec` back-links cite). Start from exactly one of `specPath`, `token`, `codeFile` + `line`, `declaration`; each token comes with its extract entries. With back-links (`codeDirs`, read by the bundled validate_codespecs, or a `backlinks` index) `agreement` lists uncited and dangling tokens (checks 35, 36). Without validate_codespecs on this platform, `codeDirs` gives no `agreement`: the answer carries `warnings` and `help` instead.',
    tags: ['tomspecs', 'codespecs', 'tom-ai-chat'],
    readOnly: true,
    inputSchema: {
        type: 'object',
        properties: {
            ...LOCATOR,
            backlinks: { type: 'string', description: 'A `codespecs-backlinks` JSON file (validate_codespecs --backlinks).' },
            codeDirs: {
                type: 'object',
                properties: { shared: { type: 'string' }, client: { type: 'string' }, server: { type: 'string' } },
                description: 'The generated trio\'s package folders, read by the bundled validate_codespecs. client and server default to the shared folder\'s siblings (name ending `client` / `server` instead of `shared`).',
            },
            specPath: { type: 'string', description: 'Trace from this spec path.' },
            token: { type: 'string', description: 'Trace this section-id token.' },
            codeFile: { type: 'string', description: 'Trace from this generated file (package-relative as in the index, e.g. `lib/src/x.dart`).' },
            line: { type: 'number', description: 'With codeFile: the line; the declaration at or above it is taken.' },
            declaration: { type: 'string', description: 'Trace from a declaration: its @CodeSpec id (e.g. `dataAccess.Customer`) or name.' },
        },
    },
    execute: async (input) => codeSpecsTraceImpl(liveDeps(), input),
};

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export const CODESPECS_TRACE_TOOLS: SharedToolDefinition<any>[] = [
    CODESPECS_QUERY_TOOL,
    CODESPECS_TRACE_TOOL,
];
