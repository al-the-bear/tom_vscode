/**
 * TomSpecs (SOM) edit tools — every change goes through the runtime's
 * SpecEditor, SpecNodeCreator and SpecDocument, so an edit cannot produce a
 * document the model rejects: a wrong path, a value of the wrong type, an
 * enum name outside its domain, a list item where none is allowed, a section
 * id that breaks its pattern or collides.
 *
 *   tomAi_specCreateDocument    a new, empty document for one model root
 *   tomAi_specSetContent        a content / scalar value
 *   tomAi_specSetFormField      one typed form field
 *   tomAi_specSetHeadline       a section's stored headline
 *   tomAi_specSetCodeSpec       the heading-level codeSpec routing marker
 *   tomAi_specAddNode           a child or list item, optionally populated
 *   tomAi_specSetItemSectionId  rename a list item's section id
 *   tomAi_specMoveListItem      reorder within a list, or move to a sibling list
 *   tomAi_specRemoveListItem    remove a list item
 *   tomAi_specClearSection      remove every value under a path
 *
 * Editor counterparts: doc_set_content, doc_set_form_field, doc_add_node,
 * doc_add_list_item, doc_remove_list_item.
 *
 * Each call is stateless: load, edit in memory, save through the store. The
 * store refuses read-only documents (SOM §4.2 versions, unfaithful Markdown),
 * files changed since the agent last read them (`expectedRevision`) and files
 * dirty in an editor. A refused edit writes nothing. Every answer reports the
 * new revision, what validation the edit introduced or resolved — anywhere in
 * the document, since a stated count (countOf) usually sits outside the list
 * that changed — and, for YAML, review entries left without a node.
 *
 * All ten write files: `readOnly: false`, `requiresApproval: true`, so they
 * pass the approval gate and the MCP server offers them only to
 * authenticated clients.
 */

import {
    SpecCreationError,
    SpecEditor,
    SpecNodeCreator,
    SpecNodeKind,
    SpecSectionIdCollision,
    checkAddNode,
    rekeyReview,
    specParentPath,
    specPathJoin,
    specPathSegments,
    splitListItemSegment,
    validateDocument,
} from 'tom_som_typescript_runtime';
import type { SomValue, SpecResolution, SpecValidationError } from 'tom_som_typescript_runtime';

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
} from './spec-tool-common';
import { SomSpecInspector } from '../services/som-spec-inspector';
import type { LoadedSomDocument } from '../services/som-document-store';

// ---------------------------------------------------------------------------
// Inputs
// ---------------------------------------------------------------------------

/** What every edit takes besides its own arguments. */
export interface SpecEditOptions {
    file: string;
    /** Refuse unless the file is still at this revision (the one the agent read). */
    expectedRevision?: string;
    /** Compute the result and the diff; write nothing. */
    dryRun?: boolean;
}

export interface SpecCreateDocumentInput {
    file: string;
    root: string;
}
export interface SpecSetContentInput extends SpecEditOptions {
    path: string;
    text: SomValue;
}
export interface SpecSetFormFieldInput extends SpecEditOptions {
    path: string;
    field: string;
    value: SomValue;
}
export interface SpecSetHeadlineInput extends SpecEditOptions {
    path: string;
    headline: string | null;
}
export interface SpecSetCodeSpecInput extends SpecEditOptions {
    path: string;
    codeSpec: string | null;
}
export interface SpecAddNodeInput extends SpecEditOptions {
    parentPath: string;
    childSegment: string;
    itemId?: string;
    month?: number;
    day?: number;
    content?: SomValue;
    /** Form values to set on the new node: relative form path ('' = the node itself) → field → value. */
    fields?: Record<string, Record<string, SomValue>>;
}
export interface SpecSetItemSectionIdInput extends SpecEditOptions {
    itemPath: string;
    sectionId: string;
}
export interface SpecMoveListItemInput extends SpecEditOptions {
    itemPath: string;
    toIndex: number;
    toList?: string;
}
export interface SpecRemoveListItemInput extends SpecEditOptions {
    itemPath: string;
}
export interface SpecClearSectionInput extends SpecEditOptions {
    path: string;
}

// ---------------------------------------------------------------------------
// The edit cycle
// ---------------------------------------------------------------------------

/** A refused edit: the runtime's code and reason, plus what helps the agent correct it. */
export class SpecEditRefusal extends Error {
    constructor(readonly code: string, message: string, readonly details: Record<string, unknown> = {}) {
        super(message);
        this.name = 'SpecEditRefusal';
    }
}

interface EditContext {
    loaded: LoadedSomDocument;
    editor: SpecEditor;
    inspector: SomSpecInspector;
}

const errorKey = (e: SpecValidationError): string => `${e.code}\u0000${e.path}\u0000${e.message}`;
const errorView = (e: SpecValidationError): { path: string; code: string; message: string } => ({ path: e.path, code: e.code, message: e.message });

function under(errorPath: string, touched: string): boolean {
    return errorPath === touched || errorPath.startsWith(`${touched}/`);
}

/**
 * Load, check the document may be edited, run `mutate`, then save. `mutate`
 * returns the tool-specific part of the answer and the path the edit touched.
 * Anything it throws is a refusal, and nothing is written.
 */
async function runEdit(
    deps: SpecToolDeps,
    options: SpecEditOptions,
    mutate: (ctx: EditContext) => { touched: string; result?: Record<string, unknown> },
): Promise<string> {
    try {
        const loaded = loadDocument(deps, options.file);
        if (loaded.readOnlyReason) {
            return json({ ok: false, code: 'readOnly', error: loaded.readOnlyReason });
        }
        if (options.expectedRevision !== undefined && options.expectedRevision !== loaded.revision) {
            return json({
                ok: false,
                code: 'revisionConflict',
                error: `The file is at revision ${loaded.revision}, not the expected ${options.expectedRevision}. Read it again and redo the edit.`,
                revision: loaded.revision,
            });
        }
        const model = deps.service.model;
        const before = validateDocument(model, loaded.document);
        const ctx: EditContext = {
            loaded,
            editor: SpecEditor.forModel(loaded.document, model),
            inspector: new SomSpecInspector(deps.service, loaded.document),
        };
        const { touched, result } = mutate(ctx);
        const after = validateDocument(model, loaded.document);
        const beforeKeys = new Set(before.map(errorKey));
        const afterKeys = new Set(after.map(errorKey));
        const saved = await deps.store.save(loaded, { expectedRevision: options.expectedRevision, dryRun: options.dryRun });
        return json({
            ok: true,
            written: saved.written,
            revision: saved.revision,
            ...(result ?? {}),
            validation: {
                introduced: after.filter((e) => !beforeKeys.has(errorKey(e))).map(errorView),
                resolved: before.filter((e) => !afterKeys.has(errorKey(e))).map(errorView),
                underPath: after.filter((e) => under(e.path, touched)).map(errorView),
                total: after.length,
            },
            ...(saved.staleReviewPaths.length > 0 ? { staleReviewPaths: saved.staleReviewPaths } : {}),
            ...(options.dryRun ? { diff: saved.diff } : {}),
        });
    } catch (e) {
        return editFailure(e);
    }
}

function editFailure(e: unknown): string {
    if (e instanceof SpecEditRefusal) {
        return json({ ok: false, code: e.code, error: e.message, ...e.details });
    }
    if (e instanceof SpecCreationError) {
        return json({ ok: false, code: e.code, error: e.message });
    }
    if (e instanceof SpecSectionIdCollision) {
        return json({ ok: false, code: 'sectionIdCollision', error: e.message });
    }
    if (e instanceof RangeError) {
        return json({ ok: false, code: 'outOfRange', error: e.message });
    }
    const handled = failure(e);
    const parsed = JSON.parse(handled) as { code?: string };
    // Anything else the runtime threw is its refusal of the edit, stated in its own words.
    return parsed.code ? handled : json({ ok: false, code: 'refused', error: (e as Error).message });
}

function requireKind(res: SpecResolution, path: string, kinds: readonly string[], what: string): void {
    if (!kinds.includes(res.kind)) {
        throw new SpecEditRefusal('wrongKind', `'${path}' is a ${res.kind} node, not ${what}.`, { kind: res.kind });
    }
}

const VALUE_LEAVES: readonly string[] = [SpecNodeKind.CONTENT, SpecNodeKind.SCALAR, SpecNodeKind.ENUM_VALUE, SpecNodeKind.LIST_ITEM_SCALAR];
const LIST_ITEMS: readonly string[] = [SpecNodeKind.LIST_ITEM_COMPLEX, SpecNodeKind.LIST_ITEM_SCALAR];

/** Set one typed form field; a stored text its declared type cannot read back is refused too. */
function setFormField(ctx: EditContext, formPath: string, field: string, value: SomValue): void {
    const spec = ctx.editor.formFields(formPath).find((f) => f.name === field);
    if (!spec) {
        throw new SpecEditRefusal('unknownField', `'${field}' is not a field of the form at ${formPath}.`, {
            fields: ctx.editor.formFields(formPath).map((f) => f.name),
        });
    }
    const declared = { type: spec.type, ...(spec.enumValues.length > 0 ? { enumValues: spec.enumValues } : {}) };
    const previous = ctx.loaded.document.formField(formPath, field);
    let problem: string | null = null;
    try {
        ctx.editor.setFormValue(formPath, field, value);
        // The runtime's own parse of what was stored. A text its type cannot read
        // parses to null rather than throwing, so a stored text that reads back
        // as nothing is the same refusal.
        const stored = ctx.loaded.document.formField(formPath, field);
        if (ctx.editor.formValue(formPath, field) === null && stored !== null && stored !== '') {
            problem = `${JSON.stringify(value)} at ${field}: does not read as a ${spec.type} value`;
        }
    } catch (e) {
        problem = (e as Error).message;
    }
    if (problem !== null) {
        ctx.loaded.document.setFormField(formPath, field, previous ?? '');
        throw new SpecEditRefusal('wrongValue', problem, { field: { name: field, ...declared } });
    }
}

// ---------------------------------------------------------------------------
// Implementations
// ---------------------------------------------------------------------------

export async function specCreateDocumentImpl(deps: SpecToolDeps, input: SpecCreateDocumentInput): Promise<string> {
    try {
        const loaded = await deps.store.create(resolveInput(deps, input.file), input.root);
        const errors = validateDocument(deps.service.model, loaded.document);
        return json({ ok: true, written: true, document: documentHeader(deps, loaded), validation: { total: errors.length } });
    } catch (e) {
        return editFailure(e);
    }
}

export async function specSetContentImpl(deps: SpecToolDeps, input: SpecSetContentInput): Promise<string> {
    return runEdit(deps, input, (ctx) => {
        const res = ctx.inspector.resolve(input.path);
        requireKind(res, input.path, VALUE_LEAVES, 'a content or scalar value');
        const text = input.text === '' ? null : input.text;
        ctx.editor.setValue(input.path, text);
        return { touched: input.path, result: { path: input.path, value: ctx.editor.value(input.path) } };
    });
}

export async function specSetFormFieldImpl(deps: SpecToolDeps, input: SpecSetFormFieldInput): Promise<string> {
    return runEdit(deps, input, (ctx) => {
        const res = ctx.inspector.resolve(input.path);
        requireKind(res, input.path, [SpecNodeKind.FORM], 'a form');
        setFormField(ctx, input.path, input.field, input.value === '' ? null : input.value);
        return { touched: input.path, result: { path: input.path, field: input.field, value: ctx.editor.formValue(input.path, input.field) } };
    });
}

export async function specSetHeadlineImpl(deps: SpecToolDeps, input: SpecSetHeadlineInput): Promise<string> {
    return runEdit(deps, input, (ctx) => {
        ctx.inspector.resolve(input.path);
        ctx.editor.setHeadline(input.path, input.headline || null);
        return { touched: input.path, result: { path: input.path, headline: ctx.loaded.document.headline(input.path) } };
    });
}

export async function specSetCodeSpecImpl(deps: SpecToolDeps, input: SpecSetCodeSpecInput): Promise<string> {
    return runEdit(deps, input, (ctx) => {
        ctx.inspector.resolve(input.path);
        ctx.loaded.document.setCodeSpec(input.path, input.codeSpec ?? '');
        return { touched: input.path, result: { path: input.path, codeSpec: ctx.loaded.document.codeSpec(input.path) } };
    });
}

export async function specAddNodeImpl(deps: SpecToolDeps, input: SpecAddNodeInput): Promise<string> {
    return runEdit(deps, input, (ctx) => {
        ctx.inspector.resolve(input.parentPath);
        const doc = ctx.loaded.document;
        let added: string;
        try {
            added = new SpecNodeCreator(deps.service.model, doc)
                .add(input.parentPath, input.childSegment, input.itemId ?? null, input.month ?? null, input.day ?? null);
        } catch (e) {
            if (e instanceof SpecCreationError) {
                const legal = ctx.inspector.reflectPath(input.parentPath, { brief: true });
                throw new SpecEditRefusal(e.code, e.message, { addable: legal.addable ?? [], notAddable: legal.notAddable ?? [] });
            }
            throw e;
        }
        const res = ctx.inspector.resolve(added);
        if (input.content !== undefined && input.content !== null) {
            const target = VALUE_LEAVES.includes(res.kind) ? added : specPathJoin(added, 'content');
            const targetRes = ctx.inspector.resolve(target);
            requireKind(targetRes, target, VALUE_LEAVES, 'a value leaf `content` can be written to');
            ctx.editor.setValue(target, input.content);
        }
        for (const [relative, values] of Object.entries(input.fields ?? {})) {
            const formPath = relative === '' ? added : specPathJoin(added, relative);
            requireKind(ctx.inspector.resolve(formPath), formPath, [SpecNodeKind.FORM], 'a form');
            for (const [field, value] of Object.entries(values)) {
                setFormField(ctx, formPath, field, value);
            }
        }
        const isItem = LIST_ITEMS.includes(res.kind);
        return {
            touched: isItem ? specParentPath(added) : added,
            result: {
                path: added,
                kind: res.kind,
                ...(isItem && doc.itemSectionId(added) ? { sectionId: doc.itemSectionId(added) } : {}),
            },
        };
    });
}

/** The list path owning an item path: its parent plus the list segment the item's segment extends. */
function listOf(itemPath: string): { parent: string; segment: string; list: string } {
    const split = splitListItemSegment(specPathSegments(itemPath).pop() as string);
    const parent = specParentPath(itemPath);
    const segment = split ? split.base : '';
    return { parent, segment, list: specPathJoin(parent, segment) };
}

export async function specSetItemSectionIdImpl(deps: SpecToolDeps, input: SpecSetItemSectionIdInput): Promise<string> {
    return runEdit(deps, input, (ctx) => {
        const res = ctx.inspector.resolve(input.itemPath);
        requireKind(res, input.itemPath, LIST_ITEMS, 'a list item');
        const doc = ctx.loaded.document;
        const previous = doc.itemSectionId(input.itemPath);
        if (previous !== input.sectionId) {
            const { parent, segment } = listOf(input.itemPath);
            // The runtime's add rule states the id rules: keep the pattern prefix, stay unique in the list.
            const error = checkAddNode(deps.service.model, doc, parent, segment, input.sectionId);
            if (error) {
                throw new SpecEditRefusal(error.code, error.message, { pattern: res.field?.sectionIdPattern ?? null });
            }
            doc.setItemSectionId(input.itemPath, input.sectionId);
        }
        return { touched: input.itemPath, result: { path: input.itemPath, sectionId: input.sectionId, previous } };
    });
}

export async function specMoveListItemImpl(deps: SpecToolDeps, input: SpecMoveListItemInput): Promise<string> {
    return runEdit(deps, input, (ctx) => {
        const res = ctx.inspector.resolve(input.itemPath);
        requireKind(res, input.itemPath, LIST_ITEMS, 'a list item');
        if (input.toList) { ctx.inspector.resolve(input.toList); }
        const moved = ctx.loaded.document.moveListItem(deps.service.model, input.itemPath, input.toIndex, input.toList ?? null);
        const renamed = Object.fromEntries(moved.renamed);
        if (ctx.loaded.format === 'yaml' && ctx.loaded.review) {
            ctx.loaded.review = rekeyReview(ctx.loaded.review, moved.renamed);
        }
        const from = listOf(input.itemPath).list;
        const to = input.toList ?? from;
        return {
            touched: to === from ? from : specParentPath(from),
            result: { path: moved.path, renamed, pinnedIds: Object.fromEntries(moved.pinnedIds) },
        };
    });
}

export async function specRemoveListItemImpl(deps: SpecToolDeps, input: SpecRemoveListItemInput): Promise<string> {
    return runEdit(deps, input, (ctx) => {
        const res = ctx.inspector.resolve(input.itemPath);
        requireKind(res, input.itemPath, LIST_ITEMS, 'a list item');
        const sectionId = ctx.loaded.document.itemSectionId(input.itemPath);
        ctx.loaded.document.removeListItem(input.itemPath);
        return { touched: listOf(input.itemPath).list, result: { removed: input.itemPath, ...(sectionId ? { sectionId } : {}) } };
    });
}

export async function specClearSectionImpl(deps: SpecToolDeps, input: SpecClearSectionInput): Promise<string> {
    return runEdit(deps, input, (ctx) => {
        ctx.inspector.resolve(input.path);
        ctx.editor.clearSection(input.path);
        return { touched: input.path, result: { cleared: input.path } };
    });
}

// ---------------------------------------------------------------------------
// Tool definitions
// ---------------------------------------------------------------------------

const VALUE_SCHEMA = { type: ['string', 'number', 'boolean', 'null'] };
const EDIT_PARAMS = {
    file: FILE_PARAM,
    expectedRevision: { type: 'string', description: 'The `revision` from the last read; the edit is refused when the file has changed since.' },
    dryRun: { type: 'boolean', description: 'Return the result and a unified `diff` without writing. Default false.' },
};
const RESULT_NOTE =
    ' Answers `{ok, written, revision, …, validation: {introduced, resolved, underPath, total}}` — validation found by '
    + 'the runtime\'s validateDocument, compared before and after the edit across the whole document (a stated count '
    + 'that no longer matches is `countMismatch`) — plus `staleReviewPaths` for YAML review entries left without a node, '
    + 'and `diff` on a dry run. A refused edit writes nothing and returns `{ok:false, code, error}`; the document must '
    + 'be editable (see readOnlyReason in tomAi_specOutline). ' + UNRESOLVED_NOTE;

/**
 * One edit tool. The `{ name, displayName }` literal keeps `name: 'tomAi_…'`
 * greppable: the tool-coverage audit finds tools by that text.
 */
function editTool<T>(id: { name: string; displayName: string }, description: string, properties: Record<string, unknown>, required: string[], impl: (deps: SpecToolDeps, input: T) => Promise<string>): SharedToolDefinition<T> {
    return {
        name: id.name,
        displayName: id.displayName,
        description,
        tags: ['tomspecs', 'som', 'docspecs', 'edit', 'tom-ai-chat'],
        readOnly: false,
        requiresApproval: true,
        inputSchema: { type: 'object', properties, required },
        execute: async (input) => impl(liveDeps(), input),
    };
}

export const SPEC_CREATE_DOCUMENT_TOOL = editTool<SpecCreateDocumentInput>(
    { name: 'tomAi_specCreateDocument', displayName: 'Spec: Create Document' },
    'Create a new, empty TomSpecs document for one model root, stamped with the current model version. The format follows '
    + 'the file name: `*.docspecs.yaml` or `*.md`. Refuses an existing file (`code: "exists"`); creates missing folders. '
    + 'List the roots with tomAi_specListDocuments. Answers the new document\'s header (format, stamp, revision).',
    {
        file: { type: 'string', description: 'The new file, `*.docspecs.yaml` or `*.md`, inside the workspace.' },
        root: { type: 'string', description: 'The document root: its section id (e.g. `SBP`) or type (e.g. `D00SolutionBlueprint`).' },
    },
    ['file', 'root'],
    specCreateDocumentImpl,
);

export const SPEC_SET_CONTENT_TOOL = editTool<SpecSetContentInput>(
    { name: 'tomAi_specSetContent', displayName: 'Spec: Set Content' },
    'Set the value of a content or scalar leaf (a `…/content` path, or a scalar list item) through the runtime\'s '
    + 'SpecEditor. `text` null or empty clears it. A typed scalar takes a number or boolean and refuses one of the wrong '
    + 'type. For form fields use tomAi_specSetFormField. Editor counterpart: doc_set_content.' + RESULT_NOTE,
    { ...EDIT_PARAMS, path: { type: 'string', description: PATH_PARAM_HINT }, text: { ...VALUE_SCHEMA, description: 'The new value; null or "" clears it.' } },
    ['file', 'path', 'text'],
    specSetContentImpl,
);

export const SPEC_SET_FORM_FIELD_TOOL = editTool<SpecSetFormFieldInput>(
    { name: 'tomAi_specSetFormField', displayName: 'Spec: Set Form Field' },
    'Set one field of a form, typed by its declaration: an `int` field takes a whole number (2.5 is refused), a `double` '
    + 'a number, a `bool` true/false, an enum one of its names; a string is stored as written and must read back as the '
    + 'declared type. A wrong value returns `code: "wrongValue"` with the field\'s type and enum domain; an unknown field '
    + 'returns the form\'s fields. null or "" clears it. tomAi_specGetSection shows each form\'s fields. Editor '
    + 'counterpart: doc_set_form_field.' + RESULT_NOTE,
    {
        ...EDIT_PARAMS,
        path: { type: 'string', description: `The form's path. ${PATH_PARAM_HINT}` },
        field: { type: 'string', description: 'The field name, e.g. `priority`.' },
        value: { ...VALUE_SCHEMA, description: 'The value, typed per the field (number, boolean, enum name or string).' },
    },
    ['file', 'path', 'field', 'value'],
    specSetFormFieldImpl,
);

export const SPEC_SET_HEADLINE_TOOL = editTool<SpecSetHeadlineInput>(
    { name: 'tomAi_specSetHeadline', displayName: 'Spec: Set Headline' },
    'Set the stored headline of a section, list item or the root; null or "" returns it to its default title.' + RESULT_NOTE,
    { ...EDIT_PARAMS, path: { type: 'string', description: PATH_PARAM_HINT }, headline: { type: ['string', 'null'], description: 'The headline text.' } },
    ['file', 'path', 'headline'],
    specSetHeadlineImpl,
);

export const SPEC_SET_CODE_SPEC_TOOL = editTool<SpecSetCodeSpecInput>(
    { name: 'tomAi_specSetCodeSpec', displayName: 'Spec: Set CodeSpec' },
    'Set the heading-level `codeSpec=` routing marker of a section (the CodeSpecs mapping reads it, e.g. '
    + '`CsOrder,CsOrder.captureFromEdi`); null or "" removes it.' + RESULT_NOTE,
    { ...EDIT_PARAMS, path: { type: 'string', description: PATH_PARAM_HINT }, codeSpec: { type: ['string', 'null'], description: 'The marker value.' } },
    ['file', 'path', 'codeSpec'],
    specSetCodeSpecImpl,
);

export const SPEC_ADD_NODE_TOOL = editTool<SpecAddNodeInput>(
    { name: 'tomAi_specAddNode', displayName: 'Spec: Add Node' },
    'Add a child under `parentPath` through the runtime\'s SpecNodeCreator: for a list segment (e.g. `FRE-REQU-LST`) a new '
    + 'item, whose section id is generated from the list\'s @SectionIdPattern (dated `month`/`day`, default today) or '
    + 'taken from `itemId` (it must keep the pattern prefix and be unique); for a single child its path. Optionally '
    + 'populate it in the same call: `content` sets the new node\'s value (or its `content` leaf), `fields` sets forms '
    + '`{ "<form segment relative to the new node, \'\' for the node itself>": { "<field>": value } }`. Answers the new '
    + '`path`, `kind` and `sectionId`. A refused add returns the runtime\'s code (unknownChild, patternMismatch, '
    + 'duplicateSectionId, cardinalityExceeded, notAContainer) and the parent\'s `addable` children; nothing is written. '
    + 'Editor counterparts: doc_add_node, doc_add_list_item.' + RESULT_NOTE,
    {
        ...EDIT_PARAMS,
        parentPath: { type: 'string', description: PATH_PARAM_HINT },
        childSegment: { type: 'string', description: 'The child: a field\'s @SectionId or name — a list\'s segment for a new item.' },
        itemId: { type: 'string', description: 'Section id for a new list item, instead of a generated one.' },
        month: { type: 'number', description: 'Month (1–12) for the generated id\'s date part. Default today.' },
        day: { type: 'number', description: 'Day of month for the generated id\'s date part. Default today.' },
        content: { ...VALUE_SCHEMA, description: 'Value for the new node or its `content` leaf.' },
        fields: { type: 'object', description: 'Form values: relative form path → field → value.' },
    },
    ['file', 'parentPath', 'childSegment'],
    specAddNodeImpl,
);

export const SPEC_SET_ITEM_SECTION_ID_TOOL = editTool<SpecSetItemSectionIdInput>(
    { name: 'tomAi_specSetItemSectionId', displayName: 'Spec: Set Item Section Id' },
    'Rename a list item\'s section id. The id must keep the list\'s @SectionIdPattern prefix and be unique in the list; a '
    + 'refusal names the pattern. Paths do not change (the path is the position).' + RESULT_NOTE,
    { ...EDIT_PARAMS, itemPath: { type: 'string', description: PATH_PARAM_HINT }, sectionId: { type: 'string', description: 'The new id.' } },
    ['file', 'itemPath', 'sectionId'],
    specSetItemSectionIdImpl,
);

export const SPEC_MOVE_LIST_ITEM_TOOL = editTool<SpecMoveListItemInput>(
    { name: 'tomAi_specMoveListItem', displayName: 'Spec: Move List Item' },
    'Move a list item to `toIndex` (0-based) within its list, or into `toList` (a list of the same element class; the '
    + 'item\'s id must fit the destination\'s pattern). The section id is the identity and the path the position: the list '
    + 'is renumbered and values travel with their item. Answers `renamed` (old → new item path for every item that moved '
    + '— any path you hold below the list may have changed) and `pinnedIds`. In YAML files the `review:` entries follow '
    + 'their items.' + RESULT_NOTE,
    {
        ...EDIT_PARAMS,
        itemPath: { type: 'string', description: PATH_PARAM_HINT },
        toIndex: { type: 'number', description: 'The 0-based position in the destination list.' },
        toList: { type: 'string', description: 'The destination list path; default the item\'s own list.' },
    },
    ['file', 'itemPath', 'toIndex'],
    specMoveListItemImpl,
);

export const SPEC_REMOVE_LIST_ITEM_TOOL = editTool<SpecRemoveListItemInput>(
    { name: 'tomAi_specRemoveListItem', displayName: 'Spec: Remove List Item' },
    'Remove a list item and every value under it. The other items keep their paths. Editor counterpart: '
    + 'doc_remove_list_item.' + RESULT_NOTE,
    { ...EDIT_PARAMS, itemPath: { type: 'string', description: PATH_PARAM_HINT } },
    ['file', 'itemPath'],
    specRemoveListItemImpl,
);

export const SPEC_CLEAR_SECTION_TOOL = editTool<SpecClearSectionInput>(
    { name: 'tomAi_specClearSection', displayName: 'Spec: Clear Section' },
    'Remove every value under a path (content, form fields, headlines, codeSpecs, list items). The node itself stays '
    + 'part of the model.' + RESULT_NOTE,
    { ...EDIT_PARAMS, path: { type: 'string', description: PATH_PARAM_HINT } },
    ['file', 'path'],
    specClearSectionImpl,
);

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export const SPEC_EDIT_TOOLS: SharedToolDefinition<any>[] = [
    SPEC_CREATE_DOCUMENT_TOOL,
    SPEC_SET_CONTENT_TOOL,
    SPEC_SET_FORM_FIELD_TOOL,
    SPEC_SET_HEADLINE_TOOL,
    SPEC_SET_CODE_SPEC_TOOL,
    SPEC_ADD_NODE_TOOL,
    SPEC_SET_ITEM_SECTION_ID_TOOL,
    SPEC_MOVE_LIST_ITEM_TOOL,
    SPEC_REMOVE_LIST_ITEM_TOOL,
    SPEC_CLEAR_SECTION_TOOL,
];
