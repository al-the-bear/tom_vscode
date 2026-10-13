/**
 * TomSpecs (SOM) read-only tools — what a spec document holds and what the
 * model allows there, answered by the runtime instead of guessed from the raw
 * file:
 *
 *   tomAi_specListDocuments  the model's document roots + the SOM documents in the workspace
 *   tomAi_specOutline        the instance tree under a path, paged
 *   tomAi_specGetSection     one node with its values, forms and children
 *   tomAi_specReflect        the model at a path or class; with a file, what may be added there
 *
 * They mirror the TomSpecs editor's tools (model_list_documents, doc_outline,
 * doc_get_content / doc_get_form_field / doc_section_meta, doc_reflect /
 * model_get_section / model_children), under the extension's naming.
 *
 * All four are read-only, so they also reach unauthenticated MCP clients
 * through the server's read-only floor. Files are read through the shared
 * SomDocumentStore (a file open in an editor is read from its buffer); the
 * model is the cached SomModelService one.
 *
 * Each tool has a pure `*Impl(deps, input)` taking the workspace root, store
 * and model explicitly; the `execute` wrapper supplies the live ones.
 */

import * as fs from 'fs';
import * as path from 'path';

import { SharedToolDefinition } from './shared-tool-registry';
import {
    FILE_PARAM,
    PATH_PARAM_HINT,
    SpecToolDeps,
    UNRESOLVED_NOTE,
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

export type { SpecToolDeps } from './spec-tool-common';

// ---------------------------------------------------------------------------
// Dependencies and inputs
// ---------------------------------------------------------------------------

export interface SpecListDocumentsInput {
    dir?: string;
    maxResults?: number;
}

export interface SpecOutlineInput {
    file: string;
    path?: string;
    depth?: number;
    offset?: number;
    limit?: number;
    filledOnly?: boolean;
}

export interface SpecGetSectionInput {
    file: string;
    path: string;
}

export interface SpecReflectInput {
    path?: string;
    className?: string;
    file?: string;
    brief?: boolean;
}

// ---------------------------------------------------------------------------
// specListDocuments
// ---------------------------------------------------------------------------

/** Directories never searched: dependencies, VCS and tool state, build output, scratch space. */
const SKIPPED_DIRS = new Set(['node_modules', 'out', 'dist', 'build', 'ztmp']);
/**
 * The walk stops at whichever comes first and says which: a call must stay
 * well inside the 5 s tool budget, and a large workspace (measured: 17 600
 * directories, 3.1 s to walk on mbp) does not fit. Narrowing `dir` is the fix.
 */
export const SPEC_LIST_MAX_DIRS = 20000;
export const SPEC_LIST_TIME_BUDGET_MS = 2500;

function isCandidate(name: string): boolean {
    return name.endsWith('.docspecs.yaml') || name.endsWith('.md');
}

export async function specListDocumentsImpl(deps: SpecToolDeps, input: SpecListDocumentsInput): Promise<string> {
    try {
        const start = input.dir ? resolveInput(deps, input.dir) : deps.wsRoot;
        const maxResults = Math.max(1, Math.min(input.maxResults ?? 200, 2000));
        const documents: Record<string, unknown>[] = [];
        const stack = [start];
        const deadline = Date.now() + (deps.listTimeBudgetMs ?? SPEC_LIST_TIME_BUDGET_MS);
        let dirs = 0;
        let stoppedBy: 'maxResults' | 'directories' | 'time' | null = null;
        while (stack.length > 0 && stoppedBy === null) {
            if (documents.length >= maxResults) { stoppedBy = 'maxResults'; break; }
            if (++dirs > SPEC_LIST_MAX_DIRS) { stoppedBy = 'directories'; break; }
            if (Date.now() > deadline) { stoppedBy = 'time'; break; }
            const dir = stack.pop() as string;
            let entries: fs.Dirent[];
            try {
                entries = fs.readdirSync(dir, { withFileTypes: true });
            } catch {
                continue;
            }
            entries.sort((a, b) => b.name.localeCompare(a.name)); // popped in ascending order
            for (const entry of entries) {
                const abs = path.join(dir, entry.name);
                if (entry.isDirectory()) {
                    if (!entry.name.startsWith('.') && !SKIPPED_DIRS.has(entry.name)) { stack.push(abs); }
                } else if (entry.isFile() && isCandidate(entry.name)) {
                    const summary = deps.store.peek(abs);
                    if (!summary) { continue; }
                    documents.push({
                        file: toWorkspacePath(deps, abs),
                        format: summary.format,
                        root: summary.root.sectionId ?? summary.root.type,
                        stamp: summary.stamp,
                        editability: summary.editability,
                        ...(summary.versionReason ? { readOnlyReason: summary.versionReason } : {}),
                    });
                    if (documents.length >= maxResults) { stoppedBy = 'maxResults'; break; }
                }
            }
        }
        documents.sort((a, b) => String(a.file).localeCompare(String(b.file)));
        return json({
            ok: true,
            modelVersion: deps.service.modelVersion,
            roots: deps.service.model.roots.map((r) => ({ sectionId: r.sectionId, type: r.type, title: r.title })),
            searched: toWorkspacePath(deps, start) || '.',
            documents,
            ...(stoppedBy ? { truncated: true, stoppedBy } : {}),
            note: 'editability here is the model-version rule only; tomAi_specOutline / tomAi_specGetSection report readOnlyReason after a full load, including Markdown that does not import faithfully.',
        });
    } catch (e) {
        return failure(e);
    }
}

// ---------------------------------------------------------------------------
// specOutline / specGetSection
// ---------------------------------------------------------------------------

export async function specOutlineImpl(deps: SpecToolDeps, input: SpecOutlineInput): Promise<string> {
    try {
        const loaded = loadDocument(deps, input.file);
        const inspector = new SomSpecInspector(deps.service, loaded.document);
        const outline = inspector.outline(input.path || (loaded.root.sectionId ?? loaded.root.type), {
            depth: input.depth,
            offset: input.offset,
            limit: input.limit,
            filledOnly: input.filledOnly,
        });
        return json({ ok: true, document: documentHeader(deps, loaded), ...outline });
    } catch (e) {
        return failure(e);
    }
}

export async function specGetSectionImpl(deps: SpecToolDeps, input: SpecGetSectionInput): Promise<string> {
    try {
        const loaded = loadDocument(deps, input.file);
        const inspector = new SomSpecInspector(deps.service, loaded.document);
        return json({ ok: true, document: documentHeader(deps, loaded), section: inspector.section(input.path) });
    } catch (e) {
        return failure(e);
    }
}

// ---------------------------------------------------------------------------
// specReflect
// ---------------------------------------------------------------------------

export async function specReflectImpl(deps: SpecToolDeps, input: SpecReflectInput): Promise<string> {
    try {
        if (!input.path === !input.className) {
            return json({ ok: false, error: 'Pass exactly one of `path` or `className`.' });
        }
        const loaded = input.file ? loadDocument(deps, input.file) : null;
        const inspector = new SomSpecInspector(deps.service, loaded?.document ?? null);
        const view = input.path
            ? inspector.reflectPath(input.path, { brief: input.brief })
            : inspector.reflectClass(input.className as string, { brief: input.brief });
        return json({ ok: true, ...(loaded ? { document: documentHeader(deps, loaded) } : {}), ...view });
    } catch (e) {
        return failure(e);
    }
}

// ---------------------------------------------------------------------------
// Tool definitions
// ---------------------------------------------------------------------------

export const SPEC_LIST_DOCUMENTS_TOOL: SharedToolDefinition<SpecListDocumentsInput> = {
    name: 'tomAi_specListDocuments',
    displayName: 'Spec: List Documents',
    description:
        'List the TomSpecs (SOM) document roots the model defines (section id, type, title) and the SOM documents found under '
        + '`dir` (default: the workspace): `*.docspecs.yaml`, and `*.md` whose headings carry `<!--[SECTIONID]-->`. Each document '
        + 'comes with its root, model-version stamp and editability under the SOM §4.2 version rules. Skips dot-folders, '
        + 'node_modules, out, dist, build and ztmp. Stops at `maxResults` (default 200), a directory cap or a 2.5 s walk '
        + 'budget and then says `truncated: true` with `stoppedBy` — narrow `dir` in that case (a whole large workspace '
        + 'may not fit). Next: tomAi_specOutline on a document for its paths and editability, tomAi_specReflect for what the '
        + 'model allows. Editor counterpart: model_list_documents.',
    tags: ['tomspecs', 'som', 'docspecs', 'tom-ai-chat'],
    readOnly: true,
    inputSchema: {
        type: 'object',
        properties: {
            dir: { type: 'string', description: 'Folder to search (workspace-relative or absolute). Default: the workspace root.' },
            maxResults: { type: 'number', description: 'Most documents to return. Default 200, max 2000.' },
        },
    },
    execute: async (input) => specListDocumentsImpl(liveDeps(), input),
};

export const SPEC_OUTLINE_TOOL: SharedToolDefinition<SpecOutlineInput> = {
    name: 'tomAi_specOutline',
    displayName: 'Spec: Outline',
    description:
        'The instance tree of a TomSpecs document under `path` (default: the root), pre-order, `depth` levels deep (default 2, '
        + 'max 12). Per node: path, kind (root/complex/section/list/listItemComplex/listItemScalar/form/content/scalar/enumValue), '
        + 'section id, headline, codeSpec, filled, and the item count for lists. Every declared child appears, filled or not, '
        + 'so the outline also shows where content can go; `filledOnly: true` leaves empty subtrees out. Paged: `limit` '
        + '(default 200) and `offset`; `nextOffset` is set when more follow. Also returns the document\'s format, stamp, '
        + 'editability, readOnlyReason and revision. ' + UNRESOLVED_NOTE + ' Editor counterpart: doc_outline.',
    tags: ['tomspecs', 'som', 'docspecs', 'tom-ai-chat'],
    readOnly: true,
    inputSchema: {
        type: 'object',
        properties: {
            file: FILE_PARAM,
            path: { type: 'string', description: `Start node. Default: the document root. ${PATH_PARAM_HINT}` },
            depth: { type: 'number', description: 'Levels below `path` to include. Default 2, max 12.' },
            offset: { type: 'number', description: 'Index of the first node to return (paging). Default 0.' },
            limit: { type: 'number', description: 'Most nodes to return. Default 200.' },
            filledOnly: { type: 'boolean', description: 'Leave out subtrees that hold no value. Default false.' },
        },
        required: ['file'],
    },
    execute: async (input) => specOutlineImpl(liveDeps(), input),
};

export const SPEC_GET_SECTION_TOOL: SharedToolDefinition<SpecGetSectionInput> = {
    name: 'tomAi_specGetSection',
    displayName: 'Spec: Get Section',
    description:
        'One node of a TomSpecs document with its values. A value leaf (content, scalar, enum, scalar list item) returns '
        + '`value`; a form returns `fields`, each with its declared type, enum domain, required flag and typed value; a list '
        + 'returns its `items` (path, section id, headline); a section returns its own `values`, its `forms` (every field, '
        + 'value or null) and its structural `children` with list items. Always: kind, section id, headline, codeSpec. '
        + UNRESOLVED_NOTE + FIRST_LOOK + ' Editor counterparts: doc_get_content, doc_get_form_field, doc_section_meta.',
    tags: ['tomspecs', 'som', 'docspecs', 'tom-ai-chat'],
    readOnly: true,
    inputSchema: {
        type: 'object',
        properties: {
            file: FILE_PARAM,
            path: { type: 'string', description: PATH_PARAM_HINT },
        },
        required: ['file', 'path'],
    },
    execute: async (input) => specGetSectionImpl(liveDeps(), input),
};

export const SPEC_REFLECT_TOOL: SharedToolDefinition<SpecReflectInput> = {
    name: 'tomAi_specReflect',
    displayName: 'Spec: Reflect',
    description:
        'What the TomSpecs model says, no document needed. By `path`: the node kind, its field (kind, type, section-id pattern, '
        + 'form fields with types and enum domains, headline, doc comment, annotations such as @MapsTo, @DetailedIn and '
        + '@CodeSpecKind) and its class with every child field; for a list, the item class. By `className`: that class. '
        + 'With `file`, also `addable` / `notAddable`: the child segments the runtime\'s add rule (checkAddNode) accepts '
        + 'under `path` in that document now, and why the others are refused (e.g. a single child already present). '
        + '`brief: true` drops doc comments and annotations. ' + UNRESOLVED_NOTE
        + ' Editor counterparts: doc_reflect, model_get_section, model_children.',
    tags: ['tomspecs', 'som', 'docspecs', 'tom-ai-chat'],
    readOnly: true,
    inputSchema: {
        type: 'object',
        properties: {
            path: { type: 'string', description: `A model path. ${PATH_PARAM_HINT} Exactly one of path / className.` },
            className: { type: 'string', description: 'A model class name, e.g. `FunctionalRequirementEntry`. Exactly one of path / className.' },
            file: { ...FILE_PARAM, description: `${FILE_PARAM.description} Optional: adds addable / notAddable, and makes list items resolve only when the document holds them.` },
            brief: { type: 'boolean', description: 'Leave out doc comments and annotations. Default false.' },
        },
    },
    execute: async (input) => specReflectImpl(liveDeps(), input),
};

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export const SPEC_TOOLS: SharedToolDefinition<any>[] = [
    SPEC_LIST_DOCUMENTS_TOOL,
    SPEC_OUTLINE_TOOL,
    SPEC_GET_SECTION_TOOL,
    SPEC_REFLECT_TOOL,
];
