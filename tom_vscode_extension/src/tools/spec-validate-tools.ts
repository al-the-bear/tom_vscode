/**
 * TomSpecs (SOM) validate, render and convert:
 *
 *   tomAi_specValidate  is it valid now? decode, DocSpecs schema and instance tiers, one report
 *   tomAi_specRender    the document (or one subtree) as the DocSpecs Markdown a reader sees
 *   tomAi_specConvert   write the other format (YAML ↔ Markdown) beside or over the source
 *
 * Validation is the same three tiers, in the same report shape, as tom_specs'
 * `validate_spec` CLI (SomSpecValidation); each finding also carries the path
 * to fix in the form the edit tools take.
 */

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

export async function specRenderImpl(deps: SpecToolDeps, input: SpecRenderInput): Promise<string> {
    try {
        const loaded = loadDocument(deps, input.file);
        // Rendered as the document stands, so the header keeps the document's own model version.
        let markdown = deps.store.render({ ...loaded, format: 'markdown' }, { stamp: loaded.stamp });
        if (input.path) {
            new SomSpecInspector(deps.service, loaded.document).resolve(input.path);
            markdown = deps.store.render({ ...loaded, format: 'markdown', document: subtreeOf(loaded.document, input.path) }, { stamp: loaded.stamp });
        }
        return json({
            ok: true,
            document: documentHeader(deps, loaded),
            ...(input.path ? { path: input.path } : {}),
            lines: markdown.split('\n').length,
            markdown,
        });
    } catch (e) {
        return failure(e);
    }
}

/** `X.docspecs.yaml` ↔ `X.md`, beside the source. */
export function defaultConvertTarget(file: string): string {
    if (file.toLowerCase().endsWith('.docspecs.yaml')) { return `${file.slice(0, -'.docspecs.yaml'.length)}.md`; }
    if (file.toLowerCase().endsWith('.md')) { return `${file.slice(0, -'.md'.length)}.docspecs.yaml`; }
    return `${file}.md`;
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
        'Is a TomSpecs document valid? Runs the three tiers tom_specs\' validate_spec CLI runs and answers in its report '
        + 'shape (`spec-validation`/1): decode (Markdown parse rejections; with `files`, fragments of different roots and '
        + 'values written by more than one fragment, each overlap naming every writer), schema (the DocSpecs schema of the '
        + 'root, generated from the model, over the document\'s Markdown rendition), and instance (typed values, enum '
        + 'domains, references, stated counts). Answers `{passed, summary, root {type, schemaId, schemaVersion}, tiers, '
        + 'notRun, violations: [{tier, code, severity, file, line, location, path, message}]}`; `path` is the document path '
        + 'to fix, as the edit tools take it (for a schema finding, the section its line falls under). `files` validates '
        + 'fragments of one document as one, so references between them resolve. `path` keeps only findings at or below '
        + 'it. Known limit: on a few rare shapes the schema and instance tiers still disagree (tom_specs vsctsa32), and the '
        + 'schema tier has not been checked against every model shape (qrb3); schema findings name the schema id and '
        + 'version so such a case can be traced.' + FIRST_LOOK,
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
        'A TomSpecs document as the DocSpecs Markdown a reader sees — how to read a YAML-stored spec as prose. With '
        + '`path`, only that subtree, under its ancestors\' headings. The header keeps the document\'s own model version. '
        + 'Answers `{document, markdown, lines}`. Writes nothing; tomAi_specConvert writes a file.' + FIRST_LOOK,
    tags: ['tomspecs', 'som', 'docspecs', 'tom-ai-chat'],
    readOnly: true,
    inputSchema: {
        type: 'object',
        properties: {
            file: FILE_PARAM,
            path: { type: 'string', description: `Render only this subtree. ${PATH_PARAM_HINT}` },
        },
        required: ['file'],
    },
    execute: async (input) => specRenderImpl(liveDeps(), input),
};

export const SPEC_CONVERT_TOOL: SharedToolDefinition<SpecConvertInput> = {
    name: 'tomAi_specConvert',
    displayName: 'Spec: Convert',
    description:
        'Write a TomSpecs document in the other format: `*.docspecs.yaml` → `*.md` or `*.md` → `*.docspecs.yaml`, stamped '
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
