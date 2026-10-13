/**
 * CodeSpecs tools — Phase 4 of TomSpecs, where a filled specification becomes
 * code-generation inputs (codespecs_mapping.md):
 *
 *   tomAi_specCodeSpecsAreas          the area catalogue: areas, slices, authoring steps
 *   tomAi_specCodeSpecsRouting        every class node's routing verdict; the unrouted ones (gate A3)
 *   tomAi_specCodeSpecsExtract        one area's extract, or a per-area summary
 *   tomAi_specCodeSpecsWriteExtracts  write every area's extract files (approval)
 *
 * All of it is the runtime's CodeSpecsExtractor over the document and the
 * packaged area catalogue (SomModelService.codeSpecsCatalog, copied into the
 * VSIX at build time).
 *
 * The concepts, in short:
 *   - an AREA is one kind of generated artefact (entity, form, API, …), code
 *     `CE-…`; a SLICE is a group of areas emitted together into one project;
 *     an AUTHORING STEP is one place in the order the artefacts are written;
 *   - every class node of the document is ROUTED by its model annotations:
 *     @CodeSpecKind (feeds code in these areas), @FollowUpKind (delivered by a
 *     process, not generated), @NoArtifact (feeds nothing) or @Document (the
 *     root). A class with none is UNROUTED, and extraction refuses the
 *     document (ROUTE-TOTAL). Routing is the model's: a heading `codeSpec=`
 *     names artefacts, it does not route;
 *   - an EXTRACT is one area's entries: section id, path, class, field,
 *     verbatim value and the routing that put it there.
 * The CodeSpecs projection document (a root carrying @CodeSpecsProjection,
 * D13 / CGP) defines what generation reaches; it is not filled and not
 * extracted, so the tools refuse it rather than return 27 empty extracts.
 */

import * as fs from 'fs';
import * as path from 'path';
import { CodeSpecsExtractError, CodeSpecsExtractor } from 'tom_som_typescript_runtime';
import type { CodeSpecsArea, CodeSpecsExtract, CodeSpecsRouting } from 'tom_som_typescript_runtime';

import { SharedToolDefinition } from './shared-tool-registry';
import { FILE_PARAM, SpecToolDeps, documentHeader, failure, json, liveDeps, loadDocument, resolveInput, toWorkspacePath } from './spec-tool-common';
import { nodeSomDocumentIo } from '../services/som-document-store';
import type { LoadedSomDocument } from '../services/som-document-store';

// ---------------------------------------------------------------------------
// Inputs
// ---------------------------------------------------------------------------

export interface CodeSpecsAreasInput {
    area?: string;
    slice?: number;
}
export interface CodeSpecsRoutingInput {
    file: string;
    verdict?: string;
    path?: string;
    limit?: number;
}
export interface CodeSpecsExtractInput {
    file: string;
    area?: string;
}
export interface CodeSpecsWriteExtractsInput {
    file: string;
    outDir?: string;
    dryRun?: boolean;
}

/** Where extracts go: `<spec-root>/generated-doc/codespecs_extracts/`, the spec root being the document's folder. */
export const EXTRACTS_DIR = path.join('generated-doc', 'codespecs_extracts');

const ROUTING_FIX =
    'Annotate the class in the TomSpecs model (tom_specs_model) with @CodeSpecKind (it feeds code), @FollowUpKind (a '
    + 'process delivers it) or @NoArtifact (it feeds nothing), then regenerate the SOM packages. A heading `codeSpec=` '
    + '(tomAi_specSetCodeSpec) does not route a class; it names artefacts for one that is routed.';

// ---------------------------------------------------------------------------
// Shared
// ---------------------------------------------------------------------------

class CodeSpecsRefusal extends Error {
    constructor(readonly code: string, message: string, readonly details: Record<string, unknown> = {}) {
        super(message);
    }
}

function codeSpecsFailure(e: unknown): string {
    if (e instanceof CodeSpecsRefusal) {
        return json({ ok: false, code: e.code, error: e.message, ...e.details });
    }
    if (e instanceof CodeSpecsExtractError) {
        return json({ ok: false, code: 'extractError', error: e.message, path: e.path, className: e.className, fix: ROUTING_FIX });
    }
    return failure(e);
}

/** The extractor for a loaded document, refusing the projection document. */
function extractorFor(deps: SpecToolDeps, loaded: LoadedSomDocument): CodeSpecsExtractor {
    const rootClass = deps.service.reflection.classNamed(loaded.root.type);
    if (rootClass?.hasAnnotation('CodeSpecsProjection')) {
        throw new CodeSpecsRefusal('projectionDocument',
            `${loaded.root.type} (${loaded.root.sectionId}) is the CodeSpecs projection: it defines what code generation `
            + 'reaches and is neither filled nor extracted. Extract from the specification document instead (e.g. a '
            + 'Solution Blueprint, SBP).');
    }
    return new CodeSpecsExtractor(deps.service.model, loaded.document, deps.service.codeSpecsCatalog, loaded.root.type);
}

function areaSummary(a: CodeSpecsArea): Record<string, unknown> {
    return { code: a.code, canonicalId: a.canonicalId, part: a.part, active: a.active, slices: a.slices, authoringSteps: a.authoringSteps };
}

function routingView(r: CodeSpecsRouting): Record<string, unknown> {
    return {
        path: r.path,
        className: r.className,
        verdict: r.verdict,
        ...(r.values.length > 0 ? { values: r.values } : {}),
        ...(r.note ? { note: r.note } : {}),
        ...(r.declaredAt && r.declaredAt !== r.className ? { declaredAt: r.declaredAt } : {}),
    };
}

// ---------------------------------------------------------------------------
// Implementations
// ---------------------------------------------------------------------------

export async function codeSpecsAreasImpl(deps: SpecToolDeps, input: CodeSpecsAreasInput): Promise<string> {
    try {
        const catalog = deps.service.codeSpecsCatalog;
        if (input.area) {
            const area = catalog.byCode(input.area) ?? catalog.byPart(input.area)
                ?? catalog.areas.find((a) => a.canonicalId.toLowerCase() === input.area?.toLowerCase()) ?? null;
            if (!area) {
                return json({ ok: false, code: 'unknownArea', error: `No area '${input.area}'. Areas: ${catalog.areas.map((a) => a.code).join(', ')}.` });
            }
            return json({
                ok: true,
                source: catalog.source,
                area: {
                    ...areaSummary(area),
                    annotations: area.annotations,
                    builtOn: area.builtOn,
                    attributeSurface: area.attributeSurface,
                    projects: catalog.projectsFor(area),
                    citableAreaCodes: catalog.citableAreaCodes(area),
                    steps: catalog.stepsFor(area).map((s) => ({ number: s.number, title: s.title, slice: s.slice })),
                },
            });
        }
        if (input.slice !== undefined) {
            const slice = catalog.sliceNumbered(input.slice);
            if (!slice) {
                return json({ ok: false, code: 'unknownSlice', error: `No slice ${input.slice}. Slices: ${catalog.slices.map((s) => s.number).join(', ')}.` });
            }
            return json({
                ok: true,
                source: catalog.source,
                slice: { number: slice.number, title: slice.title, project: slice.project, cites: slice.cites },
                areas: catalog.areas.filter((a) => a.slices.includes(slice.number)).map(areaSummary),
                steps: catalog.steps.filter((s) => s.slice === slice.number).map((s) => ({ number: s.number, title: s.title, areaCodes: s.areaCodes })),
            });
        }
        return json({
            ok: true,
            source: catalog.source,
            counts: { areas: catalog.areas.length, active: catalog.activeAreas.length, slices: catalog.slices.length, steps: catalog.steps.length },
            areas: catalog.areas.map(areaSummary),
            slices: catalog.slices.map((s) => ({ number: s.number, title: s.title, project: s.project, cites: s.cites })),
            steps: catalog.steps.map((s) => ({ number: s.number, title: s.title, slice: s.slice, areaCodes: s.areaCodes })),
        });
    } catch (e) {
        return codeSpecsFailure(e);
    }
}

export async function codeSpecsRoutingImpl(deps: SpecToolDeps, input: CodeSpecsRoutingInput): Promise<string> {
    try {
        const loaded = loadDocument(deps, input.file);
        const routings = extractorFor(deps, loaded).routings();
        const counts: Record<string, number> = {};
        for (const r of routings) { counts[r.verdict] = (counts[r.verdict] ?? 0) + 1; }
        const unrouted = routings.filter((r) => r.verdict === 'unrouted');
        const scope = input.path;
        const filtered = routings.filter((r) =>
            (!input.verdict || r.verdict === input.verdict)
            && (!scope || r.path === scope || r.path.startsWith(`${scope}/`)));
        const limit = Math.max(1, Math.min(input.limit ?? 200, 2000));
        return json({
            ok: true,
            document: documentHeader(deps, loaded),
            passed: unrouted.length === 0,
            counts,
            unrouted: unrouted.map((r) => ({ ...routingView(r), fix: ROUTING_FIX })),
            routings: filtered.slice(0, limit).map(routingView),
            ...(filtered.length > limit ? { truncated: true, total: filtered.length } : {}),
        });
    } catch (e) {
        return codeSpecsFailure(e);
    }
}

function extractSummary(e: CodeSpecsExtract): Record<string, unknown> {
    return { area: e.area.code, canonicalId: e.area.canonicalId, entries: e.entries.length, file: e.fileStem };
}

export async function codeSpecsExtractImpl(deps: SpecToolDeps, input: CodeSpecsExtractInput): Promise<string> {
    try {
        const loaded = loadDocument(deps, input.file);
        // extractFor re-runs extractAll, so the whole set is computed once here.
        const all = extractorFor(deps, loaded).extractAll();
        if (!input.area) {
            return json({
                ok: true,
                document: documentHeader(deps, loaded),
                totalEntries: all.reduce((n, e) => n + e.entries.length, 0),
                areas: all.map(extractSummary),
            });
        }
        const extract = all.find((e) => e.area.code === input.area || e.area.canonicalId.toLowerCase() === input.area?.toLowerCase());
        if (!extract) {
            return json({ ok: false, code: 'unknownArea', error: `No area '${input.area}'. Areas: ${all.map((e) => e.area.code).join(', ')}.` });
        }
        return json({
            ok: true,
            document: documentHeader(deps, loaded),
            ...extractSummary(extract),
            provenance: extract.entries.map((x) => ({
                sectionId: x.sectionId,
                path: x.path,
                className: x.className,
                field: x.formField ? `${x.fieldName}.${x.formField}` : x.fieldName,
                routedBy: x.routedBy,
                routedAt: x.routedAt,
            })),
            markdown: extract.toMarkdown(),
        });
    } catch (e) {
        return codeSpecsFailure(e);
    }
}

export async function codeSpecsWriteExtractsImpl(deps: SpecToolDeps, input: CodeSpecsWriteExtractsInput): Promise<string> {
    try {
        const loaded = loadDocument(deps, input.file);
        const all = extractorFor(deps, loaded).extractAll(); // throws before anything is written
        const outDir = input.outDir ? resolveInput(deps, input.outDir) : path.join(path.dirname(loaded.filePath), EXTRACTS_DIR);
        const files: Array<{ file: string; status: 'new' | 'changed' | 'unchanged'; text: string; abs: string }> = [];
        for (const e of all) {
            for (const [ext, text] of [['yaml', e.toYaml()], ['md', e.toMarkdown()]] as const) {
                const abs = path.join(outDir, `${e.fileStem}.${ext}`);
                const before = fs.existsSync(abs) ? fs.readFileSync(abs, 'utf8') : null;
                files.push({ file: toWorkspacePath(deps, abs), abs, text, status: before === null ? 'new' : before === text ? 'unchanged' : 'changed' });
            }
        }
        if (!input.dryRun) {
            fs.mkdirSync(outDir, { recursive: true });
            for (const f of files.filter((x) => x.status !== 'unchanged')) {
                await nodeSomDocumentIo.write(f.abs, f.text);
            }
        }
        const count = (s: string): number => files.filter((f) => f.status === s).length;
        return json({
            ok: true,
            written: !input.dryRun,
            outDir: toWorkspacePath(deps, outDir),
            areas: all.length,
            counts: { new: count('new'), changed: count('changed'), unchanged: count('unchanged') },
            files: files.map(({ file, status }) => ({ file, status })),
        });
    } catch (e) {
        return codeSpecsFailure(e);
    }
}

// ---------------------------------------------------------------------------
// Tool definitions
// ---------------------------------------------------------------------------

const CONCEPTS =
    'An area (`CE-…`) is one kind of generated artefact; a slice groups areas emitted into one project; an authoring '
    + 'step is a place in the order artefacts are written. ';
const ROUTING_NOTE =
    'Every class node is routed by its model annotations: @CodeSpecKind (feeds code), @FollowUpKind (a process delivers '
    + 'it), @NoArtifact (feeds nothing), @Document (the root); a class with none is unrouted, and extraction refuses the '
    + 'document (ROUTE-TOTAL, gate A3). ';
const PROJECTION_NOTE = 'The CodeSpecs projection document (D13, CGP) is refused: it is not filled and not extracted.';

export const CODESPECS_AREAS_TOOL: SharedToolDefinition<CodeSpecsAreasInput> = {
    name: 'tomAi_specCodeSpecsAreas',
    displayName: 'CodeSpecs: Areas',
    description:
        'The CodeSpecs area catalogue (Phase 4 of TomSpecs: a filled spec becomes code-generation inputs). ' + CONCEPTS
        + 'Without arguments: every area (code, canonical id, part, active, slices, authoring steps), the slices with the '
        + 'slices they cite, and the authoring steps. With `area` (a code like `CE-EN`, a part or a canonical id): that '
        + 'area in full: annotations, what it is built on, its projects, the areas it may cite, its steps. With `slice`: '
        + 'that slice, its areas and steps.',
    tags: ['tomspecs', 'codespecs', 'tom-ai-chat'],
    readOnly: true,
    inputSchema: {
        type: 'object',
        properties: {
            area: { type: 'string', description: 'An area code (`CE-EN`), part or canonical id.' },
            slice: { type: 'number', description: 'A slice number (1–7).' },
        },
    },
    execute: async (input) => codeSpecsAreasImpl(liveDeps(), input),
};

export const CODESPECS_ROUTING_TOOL: SharedToolDefinition<CodeSpecsRoutingInput> = {
    name: 'tomAi_specCodeSpecsRouting',
    displayName: 'CodeSpecs: Routing',
    description:
        'Gate A3 of CodeSpecs, readable: how each class node of a TomSpecs document is routed. ' + ROUTING_NOTE
        + 'Answers `{passed, counts by verdict, unrouted: [{path, className, fix}], routings: [{path, className, verdict, '
        + 'values (area kinds), note}]}`; filter `routings` by `verdict` (feedsCode, feedsProcess, feedsNothing, '
        + 'documentRoot, unrouted) or `path` (that node and below), at most `limit` (default 200). An unrouted class is '
        + 'fixed in the model, not the document. ' + PROJECTION_NOTE,
    tags: ['tomspecs', 'codespecs', 'tom-ai-chat'],
    readOnly: true,
    inputSchema: {
        type: 'object',
        properties: {
            file: FILE_PARAM,
            verdict: { type: 'string', enum: ['feedsCode', 'feedsProcess', 'feedsNothing', 'documentRoot', 'unrouted'], description: 'Keep only routings with this verdict.' },
            path: { type: 'string', description: 'Keep only routings at or below this document path.' },
            limit: { type: 'number', description: 'Most routings to list. Default 200, max 2000.' },
        },
        required: ['file'],
    },
    execute: async (input) => codeSpecsRoutingImpl(liveDeps(), input),
};

export const CODESPECS_EXTRACT_TOOL: SharedToolDefinition<CodeSpecsExtractInput> = {
    name: 'tomAi_specCodeSpecsExtract',
    displayName: 'CodeSpecs: Extract',
    description:
        'The CodeSpecs extract of a TomSpecs document: what each area receives from it. ' + CONCEPTS
        + 'Without `area`: one line per area (entries, extract file name) and the total. With `area`: that extract as '
        + 'Markdown (the `.extract.md` the extract files hold) plus each entry\'s provenance (section id, path, class, '
        + 'field, which routing put it there). An unrouted class or a document with no filled root is refused with the '
        + 'path to fix (`code: "extractError"`). ' + PROJECTION_NOTE,
    tags: ['tomspecs', 'codespecs', 'tom-ai-chat'],
    readOnly: true,
    inputSchema: {
        type: 'object',
        properties: {
            file: FILE_PARAM,
            area: { type: 'string', description: 'An area code (`CE-EN`) or canonical id.' },
        },
        required: ['file'],
    },
    execute: async (input) => codeSpecsExtractImpl(liveDeps(), input),
};

export const CODESPECS_WRITE_EXTRACTS_TOOL: SharedToolDefinition<CodeSpecsWriteExtractsInput> = {
    name: 'tomAi_specCodeSpecsWriteExtracts',
    displayName: 'CodeSpecs: Write Extracts',
    description:
        'Write every area\'s CodeSpecs extract of a TomSpecs document as `<CE-…>.extract.yaml` and `.extract.md`, by '
        + 'default to `<document folder>/generated-doc/codespecs_extracts/` (codespecs_mapping.md: rooted at the folder '
        + 'that holds the specification). Unchanged files are left alone. Answers each file\'s status (new, changed, '
        + 'unchanged); `dryRun` reports them and writes nothing. An unrouted class or a document with no filled root '
        + 'writes nothing and names the path to fix. ' + PROJECTION_NOTE,
    tags: ['tomspecs', 'codespecs', 'edit', 'tom-ai-chat'],
    readOnly: false,
    requiresApproval: true,
    inputSchema: {
        type: 'object',
        properties: {
            file: FILE_PARAM,
            outDir: { type: 'string', description: 'Folder to write to, inside the workspace. Default: beside the document, generated-doc/codespecs_extracts/.' },
            dryRun: { type: 'boolean', description: 'Report what would be written, write nothing. Default false.' },
        },
        required: ['file'],
    },
    approvalSummary: (input) => `Write the CodeSpecs extracts of ${input.file} to ${input.outDir ?? `its folder's ${EXTRACTS_DIR.split(path.sep).join('/')}`}${input.dryRun ? ' (dry run)' : ''}`,
    execute: async (input) => codeSpecsWriteExtractsImpl(liveDeps(), input),
};

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export const CODESPECS_TOOLS: SharedToolDefinition<any>[] = [
    CODESPECS_AREAS_TOOL,
    CODESPECS_ROUTING_TOOL,
    CODESPECS_EXTRACT_TOOL,
    CODESPECS_WRITE_EXTRACTS_TOOL,
];
