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
import * as vscode from 'vscode';

import { SharedToolDefinition } from './shared-tool-registry';
import { isInsideWorkspace, resolveAgainstWsRoot } from './file-primitives';
import { SomDocumentError, SomDocumentStore } from '../services/som-document-store';
import type { LoadedSomDocument } from '../services/som-document-store';
import { SomModelService } from '../services/som-model-service';
import { SomSpecInspector, SpecPathError } from '../services/som-spec-inspector';
import { somDocumentStore } from '../services/som-document-io-vscode';

// ---------------------------------------------------------------------------
// Dependencies and inputs
// ---------------------------------------------------------------------------

export interface SpecToolDeps {
    /** Workspace root; relative `file` / `dir` inputs resolve against it, and nothing outside it is read. */
    wsRoot: string;
    store: SomDocumentStore;
    service: SomModelService;
}

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
// Shared helpers
// ---------------------------------------------------------------------------

const json = (value: unknown): string => JSON.stringify(value);

/** A failure answer: the message, plus the error code and recovery hint when there is one. */
function failure(e: unknown): string {
    if (e instanceof SomDocumentError) {
        return json({ ok: false, code: e.code, error: e.message });
    }
    if (e instanceof SpecPathError) {
        return json({ ok: false, code: 'unresolvedPath', error: e.message, ...(e.nearest ? { nearest: e.nearest } : {}) });
    }
    return json({ ok: false, error: (e as Error).message });
}

function toWorkspacePath(deps: SpecToolDeps, absolute: string): string {
    return path.relative(deps.wsRoot, absolute).split(path.sep).join('/');
}

function resolveInput(deps: SpecToolDeps, file: string): string {
    const resolved = resolveAgainstWsRoot(file, deps.wsRoot);
    if (!isInsideWorkspace(resolved, deps.wsRoot)) {
        throw new Error(`Path is outside the workspace: ${file}`);
    }
    return resolved;
}

function loadDocument(deps: SpecToolDeps, file: string): LoadedSomDocument {
    return deps.store.load(resolveInput(deps, file));
}

/** The document-level facts every document answer carries. */
function documentHeader(deps: SpecToolDeps, loaded: LoadedSomDocument): Record<string, unknown> {
    return {
        file: toWorkspacePath(deps, loaded.filePath),
        format: loaded.format,
        root: loaded.root.sectionId ?? loaded.root.type,
        stamp: loaded.stamp,
        editability: loaded.editability,
        readOnlyReason: loaded.readOnlyReason,
        revision: loaded.revision,
    };
}

// ---------------------------------------------------------------------------
// specListDocuments
// ---------------------------------------------------------------------------

/** Directories never searched: dependencies, VCS and tool state, build output, scratch space. */
const SKIPPED_DIRS = new Set(['node_modules', 'out', 'dist', 'build', 'ztmp']);
/** The walk stops after this many directories and says so, so one call stays within its budget. */
export const SPEC_LIST_MAX_DIRS = 20000;

function isCandidate(name: string): boolean {
    return name.endsWith('.docspecs.yaml') || name.endsWith('.md');
}

export async function specListDocumentsImpl(deps: SpecToolDeps, input: SpecListDocumentsInput): Promise<string> {
    try {
        const start = input.dir ? resolveInput(deps, input.dir) : deps.wsRoot;
        const maxResults = Math.max(1, Math.min(input.maxResults ?? 200, 2000));
        const documents: Record<string, unknown>[] = [];
        const stack = [start];
        let dirs = 0;
        let truncated = false;
        while (stack.length > 0) {
            if (++dirs > SPEC_LIST_MAX_DIRS || documents.length >= maxResults) { truncated = true; break; }
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
                    if (documents.length >= maxResults) { truncated = true; break; }
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
            ...(truncated ? { truncated: true } : {}),
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

function liveDeps(): SpecToolDeps {
    return {
        wsRoot: vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? '',
        store: somDocumentStore(),
        service: SomModelService.instance,
    };
}

const FILE_PARAM = {
    type: 'string',
    description: 'A TomSpecs document: `*.docspecs.yaml` or a SOM-rendered `*.md`. Workspace-relative or absolute (inside the workspace).',
};
const PATH_PARAM_HINT =
    'A document path: the root section id, then field segments (a field\'s @SectionId, else its name) and list items `<LIST>-<n>`, '
    + 'e.g. `SBP/introductionAndScope/requirements/functionalRequirements/FRE-REQU-LST-1`. Take paths from tomAi_specOutline rather than composing them.';
const UNRESOLVED_NOTE =
    'A path that does not resolve returns `{ok:false, code:"unresolvedPath", nearest:{path, kind, children}}`: the nearest node that does, with its child paths.';

export const SPEC_LIST_DOCUMENTS_TOOL: SharedToolDefinition<SpecListDocumentsInput> = {
    name: 'tomAi_specListDocuments',
    displayName: 'Spec: List Documents',
    description:
        'List the TomSpecs (SOM) document roots the model defines (section id, type, title) and the SOM documents found under '
        + '`dir` (default: the workspace): `*.docspecs.yaml`, and `*.md` whose headings carry `<!--[SECTIONID]-->`. Each document '
        + 'comes with its root, model-version stamp and editability under the SOM §4.2 version rules. Skips dot-folders, '
        + 'node_modules, out, dist, build and ztmp; stops at `maxResults` (default 200) or a directory cap and then says '
        + '`truncated: true` — narrow `dir` in that case. Editor counterpart: model_list_documents.',
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
        + UNRESOLVED_NOTE + ' Editor counterparts: doc_get_content, doc_get_form_field, doc_section_meta.',
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
