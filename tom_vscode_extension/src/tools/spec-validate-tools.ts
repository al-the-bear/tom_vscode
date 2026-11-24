/**
 * TomSpecs (SOM) validate, render and convert:
 *
 *   tomAi_specValidate  is it valid now? decode, DocSpecs schema and instance tiers, one report
 *   tomAi_specRender    the document (or one subtree) as the DocSpecs Markdown a reader sees
 *   tomAi_specConvert   write the other format (YAML ↔ Markdown) beside or over the source
 *
 * Validation is the same three tiers, in the same report shape, as tom_specs'
 * `tomspecs :spec-validate` (SomSpecValidation); each finding also carries the path
 * to fix in the form the edit tools take.
 */

import { execFileSync } from 'child_process';
import * as path from 'path';

import {
    SpecDocumentStrip,
    SpecReadableSource,
    SpecStripOptions,
    SpecStripUsageError,
    specStripKindNames,
    type DocSpecsSchema,
    type SpecStripResult,
} from 'tom_som_typescript_runtime';

import { SharedToolDefinition } from './shared-tool-registry';
import {
    FILE_PARAM,
    PATH_PARAM_HINT,
    SpecToolDeps,
    documentHeader,
    failure,
    json,
    liveDeps,
    loadDocument,
    resolveInput,
    toWorkspacePath,
    FIRST_LOOK,
} from './spec-tool-common';
import { SomSpecInspector } from '../services/som-spec-inspector';
import { SomSpecValidation, subtreeOf } from '../services/som-spec-validation';

// ---------------------------------------------------------------------------
// Inputs
// ---------------------------------------------------------------------------

export interface SpecValidateInput {
    file?: string;
    files?: string[];
    path?: string;
}

export interface SpecRenderInput {
    file: string;
    path?: string;
    /** Render as the document reads with every mark accepted and every comment and question removed: `drop: ["comments"]`. */
    withoutAnnotations?: boolean;
    /** Kind names removed with their content (`-drop:`): a list, items possibly comma-joined, or one comma-joined string. */
    drop?: string[] | string;
    /** Kind names whose markers go and whose content stays (`-unmark:`). */
    unmark?: string[] | string;
    /** Kind names moved, with their content, into the appendix *Notes* (`-appendix:`). */
    appendix?: string[] | string;
    /** Each moved element leaves a link `[n]` to its appendix entry (`--appendix-references`). */
    appendixReferences?: boolean;
    /** Sections deeper than level 6 as styled-div headings (`--heading-divs`). */
    headingDivs?: boolean;
}

export interface SpecConvertInput {
    file: string;
    target?: string;
    overwrite?: boolean;
    dropReview?: boolean;
    dryRun?: boolean;
}

// ---------------------------------------------------------------------------
// Implementations
// ---------------------------------------------------------------------------

export async function specValidateImpl(deps: SpecToolDeps, input: SpecValidateInput): Promise<string> {
    try {
        const names = input.files ?? (input.file ? [input.file] : []);
        if ((input.file && input.files) || names.length === 0) {
            return json({ ok: false, code: 'invalidInput', error: 'Pass `file` (one document) or `files` (fragments of one document), not both.' });
        }
        const files = names.map((name) => ({ filePath: resolveInput(deps, name), name }));
        const report = new SomSpecValidation(deps.service, deps.store).validate(files, { scope: input.path });
        return json({ ok: true, ...report });
    } catch (e) {
        return failure(e);
    }
}

/** A usage error of the render switches: the CLI's message, as `tomspecs :spec-render` gives it. */
class RenderUsageError extends Error {}

/** A kind switch's names: a list (items possibly comma-joined) or one string; null when it is not given. */
function kindNames(value: unknown, name: string): string[] | null {
    if (value === undefined || value === null) { return null; }
    const items = typeof value === 'string' ? [value] : value;
    if (!Array.isArray(items) || items.some((i) => typeof i !== 'string')) {
        throw new RenderUsageError(`\`${name}\` takes kind names: a list of strings or one comma-joined string`);
    }
    if (items.length === 0) { return null; }
    if (items.some((i: string) => i.trim() === '')) { throw new RenderUsageError(`-${name}: needs kind names`); }
    return items as string[];
}

/** The strip options of the render switches, or null when none is given (a plain render). */
export function renderStripOptions(input: SpecRenderInput): SpecStripOptions | null {
    const drop = kindNames(input.drop, 'drop');
    const unmark = kindNames(input.unmark, 'unmark');
    const appendix = kindNames(input.appendix, 'appendix');
    const comments = input.withoutAnnotations === true;
    if (!drop && !unmark && !appendix && !comments && input.appendixReferences !== true && input.headingDivs !== true) { return null; }
    try {
        return SpecStripOptions.fromNames({
            drop: [...(drop ?? []), ...(comments ? ['comments'] : [])],
            unmark: unmark ?? [],
            appendix: appendix ?? [],
            appendixReferences: input.appendixReferences === true,
            headingDivs: input.headingDivs === true,
        });
    } catch (e) {
        if (e instanceof SpecStripUsageError) { throw new RenderUsageError(e.message); }
        throw e;
    }
}

/** The source line of the readable header: the file, its revision, and the commit that last changed it (`+dirty`). */
function readableSource(filePath: string, revision: string): SpecReadableSource {
    let commit: string | null = null;
    let dirty = false;
    const cwd = path.dirname(filePath);
    const name = path.basename(filePath);
    try {
        const sha = execFileSync('git', ['log', '-1', '--format=%H', '--', name], { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], timeout: 5000 }).trim();
        if (/^[0-9a-f]{40}$/.test(sha)) {
            commit = sha;
            dirty = execFileSync('git', ['status', '--porcelain', '--', name], { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], timeout: 5000 }).trim() !== '';
        }
    } catch {
        commit = null;
    }
    return new SpecReadableSource(name, revision, commit, dirty);
}

/** What a strip did, per kind and in all, for the answer. */
function stripSummary(result: SpecStripResult): Record<string, unknown> {
    const perKind: Record<string, { dropped: number; unmarked: number; moved: number }> = {};
    for (const k of specStripKindNames) {
        perKind[k] = { dropped: result.dropped.get(k) ?? 0, unmarked: result.unmarked.get(k) ?? 0, moved: result.appended.get(k) ?? 0 };
    }
    return {
        stripped: perKind,
        kept: result.kept.map((k) => ({ path: k.ref.path, ...(k.ref.field ? { field: k.ref.field } : {}), ...(k.ref.headline ? { headline: true } : {}), finding: k.finding })),
        ...(result.marksDropped > 0 ? { marksDropped: result.marksDropped } : {}),
        ...(result.removedItems.length > 0 ? { removedItems: result.removedItems } : {}),
        appendixEntries: result.appendix.length,
        valuesChanged: result.values.length,
        report: result.report,
        valid: result.ok,
        ...(result.findings.length > 0 ? { findings: result.findings.map((f) => ({ kind: f.kind, message: f.message, ...(f.ref ? { path: f.ref.path } : {}) })) } : {}),
    };
}

export async function specRenderImpl(deps: SpecToolDeps, input: SpecRenderInput): Promise<string> {
    try {
        const options = renderStripOptions(input);
        const loaded = loadDocument(deps, input.file);
        if (options) { return json(renderStripped(deps, loaded, options, input)); }
        const document = loaded.document;
        // Rendered as the document stands, so the header keeps the document's own model version.
        let markdown = deps.store.render({ ...loaded, format: 'markdown', document }, { stamp: loaded.stamp });
        if (input.path) {
            new SomSpecInspector(deps.service, document).resolve(input.path);
            markdown = deps.store.render({ ...loaded, format: 'markdown', document: subtreeOf(document, input.path) }, { stamp: loaded.stamp });
        }
        return json({
            ok: true,
            document: documentHeader(deps, loaded),
            ...(input.path ? { path: input.path } : {}),
            lines: markdown.split('\n').length,
            markdown,
        });
    } catch (e) {
        if (e instanceof RenderUsageError) { return json({ ok: false, code: 'usageError', error: e.message }); }
        return failure(e);
    }
}

/** A render with the switches: the runtime's strip of the whole document, then the readable rendition or a subtree of it. */
function renderStripped(deps: SpecToolDeps, loaded: ReturnType<typeof loadDocument>, options: SpecStripOptions, input: SpecRenderInput): Record<string, unknown> {
    const model = deps.service.model;
    const plain = loaded.document.toMarkdown(model, loaded.root.type);
    const schemaId = /^<!-- docspec: ([^/\s]+)\/\S+ -->/.exec(plain)?.[1] ?? null;
    const schema: DocSpecsSchema | null = schemaId && deps.service.schemaIds.includes(schemaId) ? deps.service.schema(schemaId) : null;
    const result = SpecDocumentStrip.strip(loaded.document, options, {
        model, schema, rootType: loaded.root.type, source: readableSource(loaded.filePath, loaded.revision),
    });
    const summary = stripSummary(result);
    let markdown: string | null = result.readable;
    if (input.path) {
        new SomSpecInspector(deps.service, result.document).resolve(input.path);
        markdown = deps.store.render({ ...loaded, format: 'markdown', document: subtreeOf(result.document, input.path) }, { stamp: loaded.stamp });
    }
    if (markdown === null) {
        return { ok: false, code: 'renderFailed', error: 'The stripped document has no rendition; nothing to show.', document: documentHeader(deps, loaded), readableHeader: result.readableHeader, ...summary };
    }
    return {
        ok: true,
        document: documentHeader(deps, loaded),
        ...(input.path ? { path: input.path, note: 'A subtree is rendered from the stripped document without the readable header, appendix or heading divs.' } : {}),
        ...(input.withoutAnnotations ? { withoutAnnotations: true } : {}),
        readableHeader: result.readableHeader,
        ...summary,
        lines: markdown.split('\n').length,
        markdown,
    };
}

/** `X.tomspecs.yaml` ↔ `X.tomspecs.md`, beside the source. */
export function defaultConvertTarget(file: string): string {
    const lower = file.toLowerCase();
    if (lower.endsWith('.tomspecs.yaml')) { return `${file.slice(0, -'.tomspecs.yaml'.length)}.tomspecs.md`; }
    if (lower.endsWith('.tomspecs.md')) { return `${file.slice(0, -'.tomspecs.md'.length)}.tomspecs.yaml`; }
    if (lower.endsWith('.md')) { return `${file.slice(0, -'.md'.length)}.tomspecs.yaml`; }
    return `${file}.tomspecs.md`;
}

export async function specConvertImpl(deps: SpecToolDeps, input: SpecConvertInput): Promise<string> {
    try {
        const loaded = loadDocument(deps, input.file);
        const target = resolveInput(deps, input.target ?? defaultConvertTarget(input.file));
        const result = await deps.store.convert(loaded, target, {
            overwrite: input.overwrite, dropReview: input.dropReview, dryRun: input.dryRun,
        });
        return json({
            ok: true,
            written: result.written,
            source: toWorkspacePath(deps, loaded.filePath),
            target: toWorkspacePath(deps, target),
            format: result.format,
            revision: result.revision,
            ...(result.droppedReviewEntries > 0 ? { droppedReviewEntries: result.droppedReviewEntries } : {}),
            ...(input.dryRun ? { diff: result.diff } : {}),
        });
    } catch (e) {
        return failure(e);
    }
}

// ---------------------------------------------------------------------------
// Tool definitions
// ---------------------------------------------------------------------------

export const SPEC_VALIDATE_TOOL: SharedToolDefinition<SpecValidateInput> = {
    name: 'tomAi_specValidate',
    displayName: 'Spec: Validate',
    description:
        'Is a TomSpecs document valid? The three tiers of `tomspecs :spec-validate`: decode, schema (the root\'s DocSpecs schema over the Markdown rendition) and instance (types, enums, references, stated counts). Answers `{passed, summary, tiers, notRun, violations: [{tier, code, file, line, path, message}]}`, `path` the document path to fix. `files` validates fragments of one document as one; `path` keeps findings at or below it.' + FIRST_LOOK,
    tags: ['tomspecs', 'som', 'docspecs', 'validate', 'tom-ai-chat'],
    readOnly: true,
    inputSchema: {
        type: 'object',
        properties: {
            file: { ...FILE_PARAM, description: `${FILE_PARAM.description} Or pass \`files\`.` },
            files: { type: 'array', items: { type: 'string' }, description: 'Fragments of ONE document (same root), validated as one.' },
            path: { type: 'string', description: `Keep only findings at or below this path. ${PATH_PARAM_HINT}` },
        },
    },
    execute: async (input) => specValidateImpl(liveDeps(), input),
};

export const SPEC_RENDER_TOOL: SharedToolDefinition<SpecRenderInput> = {
    name: 'tomAi_specRender',
    displayName: 'Spec: Render',
    description:
        'A TomSpecs document as the DocSpecs Markdown a reader sees. `path`: only that subtree, under its ancestors\' '
        + 'headings. The switches of `tomspecs :spec-render` strip it (SOM §11.10): `drop` (removed with their content), '
        + '`unmark` (markers removed, content kept), `appendix` (moved into the appendix *Notes*) take kind names — '
        + '`provenance`, `trace`, `editorial`, `aside`, `comments` (drop only), `all` — as a list or comma-joined; '
        + '`appendixReferences` links each moved element to its entry, `headingDivs` writes sections deeper than level 6 as styled '
        + 'divs. `refs`, `records` and `rejected` are never dropped or unmarked. `withoutAnnotations: true` is '
        + '`drop: ["comments"]` and combines with `drop`. The CLI\'s usage errors answer `code: "usageError"`. A switch '
        + 'adds `readableHeader`, `stripped` (dropped / unmarked / moved per kind), `kept`, `appendixEntries`, `report` and '
        + '`valid`. Answers `{document, markdown, lines}`; writes nothing (tomAi_specConvert writes a file).' + FIRST_LOOK,
    tags: ['tomspecs', 'som', 'docspecs', 'tom-ai-chat'],
    readOnly: true,
    inputSchema: {
        type: 'object',
        properties: {
            file: FILE_PARAM,
            path: { type: 'string', description: `Render only this subtree. ${PATH_PARAM_HINT}` },
            withoutAnnotations: { type: 'boolean', description: 'Render with every mark accepted and every comment and question removed: `drop: ["comments"]`, combined with `drop`. Default false.' },
            drop: { type: ['array', 'string'], items: { type: 'string' }, description: 'Kinds removed with their content (`-drop:`): provenance, trace, editorial, aside, comments, all. A list or comma-joined.' },
            unmark: { type: ['array', 'string'], items: { type: 'string' }, description: 'Kinds whose markers go and whose content stays (`-unmark:`): provenance, trace, editorial, aside, all.' },
            appendix: { type: ['array', 'string'], items: { type: 'string' }, description: 'Kinds moved, with their content, into the appendix *Notes* (`-appendix:`): provenance, trace, editorial, aside, all.' },
            appendixReferences: { type: 'boolean', description: 'Each moved element leaves a link `[n]` to its appendix entry (`--appendix-references`); needs `appendix`. Default false.' },
            headingDivs: { type: 'boolean', description: 'Sections deeper than level 6 as styled-div headings (`--heading-divs`). Default false.' },
        },
        required: ['file'],
    },
    execute: async (input) => specRenderImpl(liveDeps(), input),
};

export const SPEC_CONVERT_TOOL: SharedToolDefinition<SpecConvertInput> = {
    name: 'tomAi_specConvert',
    displayName: 'Spec: Convert',
    description:
        'Write a TomSpecs document in the other format: `*.tomspecs.yaml` → `*.tomspecs.md` or `*.tomspecs.md` → `*.tomspecs.yaml`, stamped '
        + 'with the current model version. `target` defaults to the same name beside the source; an existing target needs '
        + '`overwrite`. Refused: a source that is read-only (Markdown whose import is not faithful or has parse '
        + 'rejections, or a model version that cannot be edited), a target in the source\'s format, a target dirty in an '
        + 'editor. Markdown has no review pass: a YAML source with review entries is refused (`reviewWouldBeDropped`) '
        + 'unless `dropReview: true`, and the answer then says how many were left behind (the source keeps them). '
        + '`dryRun` returns the diff against the target and writes nothing.' + FIRST_LOOK,
    tags: ['tomspecs', 'som', 'docspecs', 'edit', 'tom-ai-chat'],
    readOnly: false,
    requiresApproval: true,
    inputSchema: {
        type: 'object',
        properties: {
            file: FILE_PARAM,
            target: { type: 'string', description: 'The file to write; its name says the format. Default: beside the source.' },
            overwrite: { type: 'boolean', description: 'Replace an existing target. Default false.' },
            dropReview: { type: 'boolean', description: 'Convert YAML with review entries to Markdown anyway (they are not carried). Default false.' },
            dryRun: { type: 'boolean', description: 'Return the diff, write nothing. Default false.' },
        },
        required: ['file'],
    },
    approvalSummary: (input) =>
        `Convert ${input.file} → ${input.target ?? defaultConvertTarget(input.file)}`
        + `${input.overwrite ? ' (overwrites it)' : ''}${input.dropReview ? ', dropping review entries' : ''}${input.dryRun ? ' (dry run)' : ''}`,
    execute: async (input) => specConvertImpl(liveDeps(), input),
};

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export const SPEC_VALIDATE_TOOLS: SharedToolDefinition<any>[] = [
    SPEC_VALIDATE_TOOL,
    SPEC_RENDER_TOOL,
    SPEC_CONVERT_TOOL,
];
