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
    /** How long the search may take, in ms (default SPEC_LIST_TIME_BUDGET_MS, at most SPEC_LIST_MAX_BUDGET_MS). */
    timeBudgetMs?: number;
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
 * The search stops at whichever comes first and says which. Candidates come
 * from vscode.workspace.findFiles in the extension (ripgrep: measured on mbp,
 * the whole workspace's 4 888 candidates in under 1 s from a shell; in the
 * extension host the whole call — search, reading the candidates, the
 * listing — took 1.0–1.5 s: untruncated with a 1.5 s budget, truncated at
 * 1 s, 2026-10-27; `_ai` symlink followed); the Node walk is the fallback, and it is slow on a large tree
 * (17 600 directories, 3.1 s on mbp), which is why the budget is generous and
 * can be raised per call.
 */
export const SPEC_LIST_MAX_DIRS = 20000;
export const SPEC_LIST_TIME_BUDGET_MS = 10000;
export const SPEC_LIST_MAX_BUDGET_MS = 120000;
/** At most this many candidate files from the finder. */
export const SPEC_LIST_MAX_CANDIDATES = 50000;

function isCandidate(name: string): boolean {
    return name.endsWith('.docspecs.yaml') || name.endsWith('.md');
}

/** Whether `abs`, under `start`, sits in a folder the search skips (a finder may not know the rule). */
function inSkippedDir(start: string, abs: string): boolean {
    const dirs = path.relative(start, abs).split(path.sep).slice(0, -1);
    return dirs.some((d) => d.startsWith('.') || SKIPPED_DIRS.has(d)) || dirs[0] === '..';
}

export type StoppedBy = 'maxResults' | 'directories' | 'candidates' | 'time';

interface Collected {
    documents: Record<string, unknown>[];
    stoppedBy: StoppedBy | null;
}

function documentEntry(deps: SpecToolDeps, abs: string): Record<string, unknown> | null {
    const summary = deps.store.peek(abs);
    if (!summary) { return null; }
    return {
        file: toWorkspacePath(deps, abs),
        format: summary.format,
        root: summary.root.sectionId ?? summary.root.type,
        stamp: summary.stamp,
        editability: summary.editability,
        ...(summary.versionReason ? { readOnlyReason: summary.versionReason } : {}),
    };
}

/** The documents among the finder's candidates, in path order. */
async function collectFound(deps: SpecToolDeps, start: string, deadline: number, maxResults: number): Promise<Collected> {
    const found = await deps.findCandidates!(start, { deadline, cap: SPEC_LIST_MAX_CANDIDATES });
    const files = found.files.filter((f) => isCandidate(path.basename(f)) && !inSkippedDir(start, f)).sort();
    const documents: Record<string, unknown>[] = [];
    let stoppedBy: StoppedBy | null = found.stoppedBy ?? null;
    for (const abs of files) {
        if (documents.length >= maxResults) { stoppedBy = 'maxResults'; break; }
        if (Date.now() > deadline) { stoppedBy = 'time'; break; }
        const entry = documentEntry(deps, abs);
        if (entry) { documents.push(entry); }
    }
    return { documents, stoppedBy };
}

/** The documents under `start`, walking the folders with Node (no symlinks followed). */
function collectWalked(deps: SpecToolDeps, start: string, deadline: number, maxResults: number): Collected {
    const documents: Record<string, unknown>[] = [];
    const stack = [start];
    let dirs = 0;
    let stoppedBy: StoppedBy | null = null;
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
                const doc = documentEntry(deps, abs);
                if (!doc) { continue; }
                documents.push(doc);
                if (documents.length >= maxResults) { stoppedBy = 'maxResults'; break; }
            }
        }
    }
    return { documents, stoppedBy };
}

/** The SOM documents found under a folder, in path order, and why the search stopped early when it did. */
export interface SpecDocumentSearch {
    /** Workspace-relative path of the folder searched (`.` for the root). */
    searched: string;
    search: 'findFiles' | 'walk';
    documents: Record<string, unknown>[];
    stoppedBy: StoppedBy | null;
    /** When the call's time budget runs out (ms since the epoch); later work by the caller shares it. */
    deadline: number;
}

/**
 * Find the SOM documents under `dir` (default the workspace) within the time
 * budget: VS Code's file search when the deps have one, else a walk. Shared by
 * tomAi_specListDocuments and tomAi_specAnnotations' `dir` form.
 */
export async function findSpecDocuments(
    deps: SpecToolDeps,
    input: { dir?: string; maxResults?: number; timeBudgetMs?: number },
): Promise<SpecDocumentSearch> {
    const start = input.dir ? resolveInput(deps, input.dir) : deps.wsRoot;
    const maxResults = Math.max(1, Math.min(input.maxResults ?? 200, 2000));
    const budget = input.timeBudgetMs !== undefined
        ? Math.max(1, Math.min(input.timeBudgetMs, SPEC_LIST_MAX_BUDGET_MS))
        : (deps.listTimeBudgetMs ?? SPEC_LIST_TIME_BUDGET_MS);
    const deadline = Date.now() + budget;
    let search: 'findFiles' | 'walk' = 'walk';
    let collected: Collected | null = null;
    if (deps.findCandidates) {
        try {
            collected = await collectFound(deps, start, deadline, maxResults);
            search = 'findFiles';
        } catch {
            collected = null; // no search provider (or it failed): walk instead
        }
    }
    collected ??= collectWalked(deps, start, deadline, maxResults);
    const { documents, stoppedBy } = collected;
    documents.sort((a, b) => String(a.file).localeCompare(String(b.file)));
    return { searched: toWorkspacePath(deps, start) || '.', search, documents, stoppedBy, deadline };
}

export async function specListDocumentsImpl(deps: SpecToolDeps, input: SpecListDocumentsInput): Promise<string> {
    try {
        const found = await findSpecDocuments(deps, input);
        return json({
            ok: true,
            modelVersion: deps.service.modelVersion,
            roots: deps.service.model.roots.map((r) => ({ sectionId: r.sectionId, type: r.type, title: r.title })),
            searched: found.searched,
            search: found.search,
            documents: found.documents,
            ...(found.stoppedBy ? { truncated: true, stoppedBy: found.stoppedBy } : {}),
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
        + 'node_modules, out, dist, build and ztmp. Candidates come from VS Code\'s file search (`search: "findFiles"`, '
        + 'symlinked folders followed; measured on mbp in the extension host: the whole workspace in 1–1.5 s), else from walking the '
        + 'folders (`search: "walk"`, slower on a large tree). Stops at `maxResults` (default 200), the time budget '
        + '(`timeBudgetMs`, default 10 s, at most 120 s) or a directory / candidate cap, and then says `truncated: true` '
        + 'with `stoppedBy` (`maxResults`, `time`, `directories`, `candidates`) — raise `timeBudgetMs` or narrow `dir`. Next: tomAi_specOutline on a document for its paths and editability, tomAi_specReflect for what the '
        + 'model allows. Editor counterpart: model_list_documents.',
    tags: ['tomspecs', 'som', 'docspecs', 'tom-ai-chat'],
    readOnly: true,
    inputSchema: {
        type: 'object',
        properties: {
            dir: { type: 'string', description: 'Folder to search (workspace-relative or absolute). Default: the workspace root.' },
            maxResults: { type: 'number', description: 'Most documents to return. Default 200, max 2000.' },
            timeBudgetMs: { type: 'number', description: 'How long the search may take, in ms. Default 10000, max 120000.' },
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
