/**
 * Plain DocSpecs Markdown tools — documents that declare a DocSpecs schema
 * but are not SOM specs (quest documents, project specifications):
 *
 *   tomAi_docspecsValidate        the document against its schema
 *   tomAi_docspecsOutline         the section tree, with required and missing sections
 *   tomAi_docspecsGetSection      one section's own body
 *   tomAi_docspecsReplaceSection  replace one section's body (approval)
 *
 * Parsing, validation and the replace are the runtime's; files are read and
 * written through the SOM document store's text path (editor buffer when
 * open, revision checks, refusal when dirty, dry-run diff). Schema lookup is
 * docspecs-markdown.ts.
 */

import { DocSpecsDocument } from 'tom_som_typescript_runtime';

import { SharedToolDefinition } from './shared-tool-registry';
import { SpecToolDeps, failure, json, liveDeps, resolveInput, toWorkspacePath } from './spec-tool-common';
import {
    SchemaLookup,
    migrationHint,
    findSection,
    outlineOf,
    resolveDocSpecsSchema,
    validateDocSpecs,
} from '../services/docspecs-markdown';

// ---------------------------------------------------------------------------
// Inputs
// ---------------------------------------------------------------------------

export interface DocSpecsValidateInput {
    file: string;
    schema?: string;
}
export interface DocSpecsOutlineInput {
    file: string;
    schema?: string;
}
export interface DocSpecsGetSectionInput {
    file: string;
    sectionId: string;
}
export interface DocSpecsReplaceSectionInput {
    file: string;
    sectionId: string;
    body: string;
    schema?: string;
    expectedRevision?: string;
    dryRun?: boolean;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

interface Opened {
    filePath: string;
    text: string;
    revision: string;
    lookup: SchemaLookup;
}

function open(deps: SpecToolDeps, file: string, schema?: string): Opened {
    const filePath = resolveInput(deps, file);
    const { text, revision } = deps.store.readText(filePath);
    const declared = DocSpecsDocument.parse(text).declaredSchema;
    const lookup = resolveDocSpecsSchema(deps.service, filePath, declared, deps.wsRoot, schema);
    return { filePath, text, revision, lookup };
}

function schemaView(deps: SpecToolDeps, lookup: SchemaLookup): Record<string, unknown> {
    const r = lookup.resolved;
    if (!r) { return { declared: lookup.declared, found: false }; }
    return {
        declared: lookup.declared,
        found: true,
        ref: r.ref,
        source: r.source,
        ...(r.file ? { file: toWorkspacePath(deps, r.file) } : {}),
        ...(r.warnings.length > 0 ? { ignoredByRuntime: r.warnings } : {}),
    };
}

const findingKey = (f: { rule: string; sectionId: string | null; message: string }): string => `${f.rule}\u0000${f.sectionId}\u0000${f.message}`;

// ---------------------------------------------------------------------------
// Implementations
// ---------------------------------------------------------------------------

export async function docspecsValidateImpl(deps: SpecToolDeps, input: DocSpecsValidateInput): Promise<string> {
    try {
        const doc = open(deps, input.file, input.schema);
        const file = toWorkspacePath(deps, doc.filePath);
        const { findings, parsed } = validateDocSpecs(doc.text, doc.lookup, file);
        const note = migrationHint(doc.text, parsed, file);
        return json({
            ok: true,
            file: toWorkspacePath(deps, doc.filePath),
            revision: doc.revision,
            schema: schemaView(deps, doc.lookup),
            passed: findings.length === 0,
            findings,
            ...(note ? { migrationHint: note } : {}),
        });
    } catch (e) {
        return failure(e);
    }
}

export async function docspecsOutlineImpl(deps: SpecToolDeps, input: DocSpecsOutlineInput): Promise<string> {
    try {
        const doc = open(deps, input.file, input.schema);
        const file = toWorkspacePath(deps, doc.filePath);
        const { findings, parsed } = validateDocSpecs(doc.text, doc.lookup, file);
        const schema = doc.lookup.resolved?.schema;
        const note = migrationHint(doc.text, parsed, file);
        return json({
            ok: true,
            file: toWorkspacePath(deps, doc.filePath),
            revision: doc.revision,
            schema: schemaView(deps, doc.lookup),
            sections: outlineOf(parsed, doc.text.split('\n').length),
            ...(schema ? {
                requiredSections: Object.entries(schema.documentSections).filter(([, s]) => !s.optional).map(([id]) => id),
                missingSections: findings.filter((f) => f.rule === 'missingRequiredSection').map((f) => ({ line: f.line, message: f.message })),
            } : {}),
            ...(note ? { migrationHint: note } : {}),
        });
    } catch (e) {
        return failure(e);
    }
}

export async function docspecsGetSectionImpl(deps: SpecToolDeps, input: DocSpecsGetSectionInput): Promise<string> {
    try {
        const doc = open(deps, input.file);
        const parsed = DocSpecsDocument.parse(doc.text);
        const section = findSection(parsed, input.sectionId);
        if (typeof section === 'string') {
            return json({ ok: false, code: 'unknownSection', error: section });
        }
        return json({
            ok: true,
            file: toWorkspacePath(deps, doc.filePath),
            revision: doc.revision,
            id: section.id,
            title: section.title,
            level: section.level,
            line: section.line,
            body: section.text,
            children: section.children.map((c) => ({ id: c.id, title: c.title, line: c.line })),
        });
    } catch (e) {
        return failure(e);
    }
}

export async function docspecsReplaceSectionImpl(deps: SpecToolDeps, input: DocSpecsReplaceSectionInput): Promise<string> {
    try {
        const doc = open(deps, input.file, input.schema);
        const located = findSection(DocSpecsDocument.parse(doc.text), input.sectionId);
        if (typeof located === 'string') {
            return json({ ok: false, code: 'unknownSection', error: located });
        }
        let next: string;
        try {
            next = DocSpecsDocument.replaceSectionBody(doc.text, input.sectionId, input.body);
        } catch (e) {
            return json({ ok: false, code: 'refused', error: (e as Error).message });
        }
        const file = toWorkspacePath(deps, doc.filePath);
        const before = validateDocSpecs(doc.text, doc.lookup, file).findings;
        const after = validateDocSpecs(next, doc.lookup, file).findings;
        const beforeKeys = new Set(before.map(findingKey));
        const afterKeys = new Set(after.map(findingKey));
        const saved = await deps.store.writeText(doc.filePath, next, {
            baseRevision: doc.revision,
            expectedRevision: input.expectedRevision,
            dryRun: input.dryRun,
        });
        return json({
            ok: true,
            written: saved.written,
            revision: saved.revision,
            sectionId: input.sectionId,
            validation: {
                introduced: after.filter((f) => !beforeKeys.has(findingKey(f))),
                resolved: before.filter((f) => !afterKeys.has(findingKey(f))),
                total: after.length,
            },
            ...(input.dryRun ? { diff: saved.diff } : {}),
        });
    } catch (e) {
        return failure(e);
    }
}

// ---------------------------------------------------------------------------
// Tool definitions
// ---------------------------------------------------------------------------

const FILE = { type: 'string', description: 'A Markdown file with a `<!-- docspec: <id>/<version> -->` header. Workspace-relative or absolute (inside the workspace).' };
const SCHEMA = {
    type: 'string',
    description: 'Check against this schema instead of the declared one: `<id>/<version>` (looked up like a declared one) or a path to a `*.docspecs-schema.yaml`.',
};
const FORM_NOTE =
    ' The runtime reads the current DocSpecs form: `<!-- docspec: <id>/<version> -->` on the first line and `<!--[ID]-->` '
    + 'heading ids. A document in the legacy form (`# [id] Title`, `<!-- schema=… -->`) or with its declaration below the '
    + 'title is answered with a `migrationHint` naming `_bin/migrate_docspecs.py doc <file> --assign-ids --write`. For SOM specs '
    + '(`*.docspecs.yaml`, SOM Markdown) prefer the tomAi_spec* tools.';

export const DOCSPECS_VALIDATE_TOOL: SharedToolDefinition<DocSpecsValidateInput> = {
    name: 'tomAi_docspecsValidate',
    displayName: 'DocSpecs: Validate',
    description:
        'Check a DocSpecs Markdown document against its schema. The schema is the one its `<!-- docspec: <id>/<version> -->` '
        + 'header declares, looked up in `.tom/docspecs-schema/<id>/<id>.<version>.docspecs-schema.yaml` (or a suffixed folder '
        + '`<id>.<suffix>/`) in the document\'s '
        + 'folder or the nearest one above it (up to the workspace root), else among the schemas generated from the SOM model. '
        + 'A declared schema found nowhere is a finding (`unknownSchema`), a declaration below the title too (`headerNotFirst`: '
        + 'no runtime reads it there), and a missing header (`noSchemaDeclared`); '
        + '`docspec: none` means no schema. Answers `{passed, findings: [{rule, line, sectionId, message}], schema: {ref, '
        + 'source, file, ignoredByRuntime}}`; `ignoredByRuntime` lists schema keys the runtime does not support, whose '
        + 'constraints are therefore not checked.' + FORM_NOTE,
    tags: ['docspecs', 'validate', 'tom-ai-chat'],
    readOnly: true,
    inputSchema: { type: 'object', properties: { file: FILE, schema: SCHEMA }, required: ['file'] },
    execute: async (input) => docspecsValidateImpl(liveDeps(), input),
};

export const DOCSPECS_OUTLINE_TOOL: SharedToolDefinition<DocSpecsOutlineInput> = {
    name: 'tomAi_docspecsOutline',
    displayName: 'DocSpecs: Outline',
    description:
        'The section tree of a DocSpecs Markdown document, in document order: id, title, level, line range of the whole '
        + 'subtree, own text length, children. With a schema: the section types it requires and the required sections '
        + 'missing (as the validator reports them). Section ids are what tomAi_docspecsGetSection and '
        + 'tomAi_docspecsReplaceSection take.' + FORM_NOTE,
    tags: ['docspecs', 'tom-ai-chat'],
    readOnly: true,
    inputSchema: { type: 'object', properties: { file: FILE, schema: SCHEMA }, required: ['file'] },
    execute: async (input) => docspecsOutlineImpl(liveDeps(), input),
};

export const DOCSPECS_GET_SECTION_TOOL: SharedToolDefinition<DocSpecsGetSectionInput> = {
    name: 'tomAi_docspecsGetSection',
    displayName: 'DocSpecs: Get Section',
    description:
        'One section of a DocSpecs Markdown document by its id: title, level, heading line, its own body (the lines up to '
        + 'its first subsection) and its subsections. An unknown or repeated id is refused with the ids there are.' + FORM_NOTE,
    tags: ['docspecs', 'tom-ai-chat'],
    readOnly: true,
    inputSchema: {
        type: 'object',
        properties: { file: FILE, sectionId: { type: 'string', description: 'The section id, from tomAi_docspecsOutline.' } },
        required: ['file', 'sectionId'],
    },
    execute: async (input) => docspecsGetSectionImpl(liveDeps(), input),
};

export const DOCSPECS_REPLACE_SECTION_TOOL: SharedToolDefinition<DocSpecsReplaceSectionInput> = {
    name: 'tomAi_docspecsReplaceSection',
    displayName: 'DocSpecs: Replace Section',
    description:
        'Replace the body of one section of a DocSpecs Markdown document: the lines between its heading and its first '
        + 'subsection. The heading and every other byte stay as they are; a `#` line inside a fenced block is never taken '
        + 'for a heading. Refused (nothing written): an unknown or repeated id, and a body that would change the structure '
        + '(a heading outside a fence, an unclosed fence). Written like every edit: refused when the file is dirty in an '
        + 'editor or has changed since `expectedRevision`; through the editor when open. Answers `{written, revision, '
        + 'validation: {introduced, resolved, total}}` against the schema; `dryRun` adds the diff and writes nothing.' + FORM_NOTE,
    tags: ['docspecs', 'edit', 'tom-ai-chat'],
    readOnly: false,
    requiresApproval: true,
    inputSchema: {
        type: 'object',
        properties: {
            file: FILE,
            sectionId: { type: 'string', description: 'The section id, from tomAi_docspecsOutline.' },
            body: { type: 'string', description: 'The new body (Markdown, no headings outside fences). Leading and trailing blank lines are trimmed.' },
            schema: SCHEMA,
            expectedRevision: { type: 'string', description: 'The `revision` from the last read; refused when the file changed since.' },
            dryRun: { type: 'boolean', description: 'Return the result and the diff, write nothing. Default false.' },
        },
        required: ['file', 'sectionId', 'body'],
    },
    approvalSummary: (input) =>
        `Replace section ${input.sectionId} of ${input.file} (${input.body.split('\n').length} line${input.body.includes('\n') ? 's' : ''})`
        + `${input.dryRun ? ' (dry run)' : ''}`,
    execute: async (input) => docspecsReplaceSectionImpl(liveDeps(), input),
};

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export const DOCSPECS_TOOLS: SharedToolDefinition<any>[] = [
    DOCSPECS_VALIDATE_TOOL,
    DOCSPECS_OUTLINE_TOOL,
    DOCSPECS_GET_SECTION_TOOL,
    DOCSPECS_REPLACE_SECTION_TOOL,
];
