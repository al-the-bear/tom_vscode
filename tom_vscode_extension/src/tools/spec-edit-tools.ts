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
    SpecNodeCreator,
    SpecNodeKind,
    checkAddNode,
    rekeyReview,
    specParentPath,
    specPathJoin,
    specPathSegments,
    splitListItemSegment,
    validateDocument,
} from 'tom_som_typescript_runtime';
import type { SomValue } from 'tom_som_typescript_runtime';

import { SharedToolDefinition } from './shared-tool-registry';
import { PATH_PARAM_HINT, SpecToolDeps, documentHeader, json, liveDeps, resolveInput, FIRST_LOOK } from './spec-tool-common';
import {
    BatchEditFailure,
    EDIT_PARAMS,
    LIST_ITEMS,
    RESULT_NOTE,
    SpecEditRefusal,
    VALUE_LEAVES,
    VALUE_SCHEMA,
    editFailure,
    editTool,
    requireKind,
    runEdit,
    setLeafValue,
    type EditContext,
    type OpInput,
    type OpOutcome,
    type SpecEditOptions,
} from './spec-edit-core';

import { ANNOTATION_BATCH_OPS, writeMarked } from './spec-annotation-tools';

export { SpecEditRefusal, type SpecEditOptions, type OpInput } from './spec-edit-core';

// ---------------------------------------------------------------------------
// Inputs
// ---------------------------------------------------------------------------

export interface SpecCreateDocumentInput {
    file: string;
    root: string;
}
export interface SpecSetContentInput extends SpecEditOptions {
    path: string;
    text: SomValue;
    /** Write the new text as a marked change against the value there now. */
    marked?: boolean;
}
export interface SpecSetFormFieldInput extends SpecEditOptions {
    path: string;
    field: string;
    value: SomValue;
    /** Write the new text as a marked change against the field's value now (String fields only). */
    marked?: boolean;
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

/**
 * Set one typed form field. The runtime refuses a value its declared type
 * cannot read (setFormValue throws); the old value is put back and the
 * refusal is `wrongValue` in the runtime's words, with the field's type.
 */
function setFormField(ctx: EditContext, formPath: string, field: string, value: SomValue): void {
    const spec = ctx.editor.formFields(formPath).find((f) => f.name === field);
    if (!spec) {
        throw new SpecEditRefusal('unknownField', `'${field}' is not a field of the form at ${formPath}.`, {
            fields: ctx.editor.formFields(formPath).map((f) => f.name),
        });
    }
    const declared = { type: spec.type, ...(spec.enumValues.length > 0 ? { enumValues: spec.enumValues } : {}) };
    const previous = ctx.loaded.document.formField(formPath, field);
    try {
        ctx.editor.setFormValue(formPath, field, value);
    } catch (e) {
        ctx.loaded.document.setFormField(formPath, field, previous ?? '');
        throw new SpecEditRefusal('wrongValue', (e as Error).message, { field: { name: field, ...declared } });
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

/** A marked write takes text: a String value, given as a string ('' / null mark the whole value deleted). */
function markedText(value: SomValue, declaredType: string | null | undefined, enumValues: readonly string[], where: string): string {
    if ((declaredType && declaredType !== 'String') || enumValues.length > 0) {
        throw new SpecEditRefusal('notText', `${where} holds a ${declaredType ?? 'typed'} value; only text takes change marks. Write it without \`marked\`.`, { type: declaredType ?? null });
    }
    if (value !== null && typeof value !== 'string') {
        throw new SpecEditRefusal('notText', `A marked write takes a string, not ${typeof value}.`);
    }
    return value ?? '';
}

function opSetContent(deps: SpecToolDeps, ctx: EditContext, input: OpInput<SpecSetContentInput>): OpOutcome {
    const res = ctx.inspector.resolve(input.path);
    requireKind(res, input.path, VALUE_LEAVES, 'a content or scalar value');
    if (input.marked === true) {
        const f = res.field;
        const type = res.kind === SpecNodeKind.CONTENT ? null : (f ? (f.enumType ?? f.type ?? f.elementType ?? null) : null);
        const text = markedText(input.text, type, f && res.kind !== SpecNodeKind.CONTENT ? f.enumValues : [], `'${input.path}'`);
        const { exact } = writeMarked(ctx, input.path, null, text);
        return { touched: input.path, result: { path: input.path, value: ctx.loaded.document.content(input.path) ?? null, marked: true, exact } };
    }
    const text = input.text === '' ? null : input.text;
    setLeafValue(ctx.editor, input.path, text);
    return { touched: input.path, result: { path: input.path, value: ctx.editor.value(input.path) } };
}

export async function specSetContentImpl(deps: SpecToolDeps, input: SpecSetContentInput): Promise<string> {
    return runEdit(deps, input, (ctx) => opSetContent(deps, ctx, input));
}

function opSetFormField(deps: SpecToolDeps, ctx: EditContext, input: OpInput<SpecSetFormFieldInput>): OpOutcome {
    const res = ctx.inspector.resolve(input.path);
    requireKind(res, input.path, [SpecNodeKind.FORM], 'a form');
    if (input.marked === true) {
        const spec = ctx.editor.formFields(input.path).find((f) => f.name === input.field);
        if (!spec) {
            throw new SpecEditRefusal('unknownField', `'${input.field}' is not a field of the form at ${input.path}.`, {
                fields: ctx.editor.formFields(input.path).map((f) => f.name),
            });
        }
        const text = markedText(input.value, spec.type, spec.enumValues, `Field '${input.field}' of ${input.path}`);
        const { exact } = writeMarked(ctx, input.path, input.field, text);
        return { touched: input.path, result: { path: input.path, field: input.field, value: ctx.loaded.document.formField(input.path, input.field) ?? null, marked: true, exact } };
    }
    setFormField(ctx, input.path, input.field, input.value === '' ? null : input.value);
    return { touched: input.path, result: { path: input.path, field: input.field, value: ctx.editor.formValue(input.path, input.field) } };
}

export async function specSetFormFieldImpl(deps: SpecToolDeps, input: SpecSetFormFieldInput): Promise<string> {
    return runEdit(deps, input, (ctx) => opSetFormField(deps, ctx, input));
}

function opSetHeadline(deps: SpecToolDeps, ctx: EditContext, input: OpInput<SpecSetHeadlineInput>): OpOutcome {
    ctx.inspector.resolve(input.path);
    ctx.editor.setHeadline(input.path, input.headline || null);
    return { touched: input.path, result: { path: input.path, headline: ctx.loaded.document.headline(input.path) } };
}

export async function specSetHeadlineImpl(deps: SpecToolDeps, input: SpecSetHeadlineInput): Promise<string> {
    return runEdit(deps, input, (ctx) => opSetHeadline(deps, ctx, input));
}

function opSetCodeSpec(deps: SpecToolDeps, ctx: EditContext, input: OpInput<SpecSetCodeSpecInput>): OpOutcome {
    ctx.inspector.resolve(input.path);
    ctx.loaded.document.setCodeSpec(input.path, input.codeSpec ?? '');
    return { touched: input.path, result: { path: input.path, codeSpec: ctx.loaded.document.codeSpec(input.path) } };
}

export async function specSetCodeSpecImpl(deps: SpecToolDeps, input: SpecSetCodeSpecInput): Promise<string> {
    return runEdit(deps, input, (ctx) => opSetCodeSpec(deps, ctx, input));
}

function opAddNode(deps: SpecToolDeps, ctx: EditContext, input: OpInput<SpecAddNodeInput>): OpOutcome {
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
        setLeafValue(ctx.editor, target, input.content);
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
}

export async function specAddNodeImpl(deps: SpecToolDeps, input: SpecAddNodeInput): Promise<string> {
    return runEdit(deps, input, (ctx) => opAddNode(deps, ctx, input));
}

/** The list path owning an item path: its parent plus the list segment the item's segment extends. */
function listOf(itemPath: string): { parent: string; segment: string; list: string } {
    const split = splitListItemSegment(specPathSegments(itemPath).pop() as string);
    const parent = specParentPath(itemPath);
    const segment = split ? split.base : '';
    return { parent, segment, list: specPathJoin(parent, segment) };
}

function opSetItemSectionId(deps: SpecToolDeps, ctx: EditContext, input: OpInput<SpecSetItemSectionIdInput>): OpOutcome {
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
}

export async function specSetItemSectionIdImpl(deps: SpecToolDeps, input: SpecSetItemSectionIdInput): Promise<string> {
    return runEdit(deps, input, (ctx) => opSetItemSectionId(deps, ctx, input));
}

function opMoveListItem(deps: SpecToolDeps, ctx: EditContext, input: OpInput<SpecMoveListItemInput>): OpOutcome {
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
}

export async function specMoveListItemImpl(deps: SpecToolDeps, input: SpecMoveListItemInput): Promise<string> {
    return runEdit(deps, input, (ctx) => opMoveListItem(deps, ctx, input));
}

function opRemoveListItem(deps: SpecToolDeps, ctx: EditContext, input: OpInput<SpecRemoveListItemInput>): OpOutcome {
    const res = ctx.inspector.resolve(input.itemPath);
    requireKind(res, input.itemPath, LIST_ITEMS, 'a list item');
    const sectionId = ctx.loaded.document.itemSectionId(input.itemPath);
    ctx.loaded.document.removeListItem(input.itemPath);
    return { touched: listOf(input.itemPath).list, result: { removed: input.itemPath, ...(sectionId ? { sectionId } : {}) } };
}

export async function specRemoveListItemImpl(deps: SpecToolDeps, input: SpecRemoveListItemInput): Promise<string> {
    return runEdit(deps, input, (ctx) => opRemoveListItem(deps, ctx, input));
}

function opClearSection(deps: SpecToolDeps, ctx: EditContext, input: OpInput<SpecClearSectionInput>): OpOutcome {
    ctx.inspector.resolve(input.path);
    ctx.editor.clearSection(input.path);
    return { touched: input.path, result: { cleared: input.path } };
}

export async function specClearSectionImpl(deps: SpecToolDeps, input: SpecClearSectionInput): Promise<string> {
    return runEdit(deps, input, (ctx) => opClearSection(deps, ctx, input));
}

// ---------------------------------------------------------------------------
// Tool definitions
// ---------------------------------------------------------------------------

const MARKED_NOTE =
    ' With `marked: true` the new text is written as a change the reviewer can accept or reject (SOM §11.9.3, through '
    + 'SpecReviewAnnotations.setMarked): its differences against the value there now become inline marks '
    + '(`{++added++}`, `{--removed--}`, `{~~old~>new~~}`), so accepting every mark gives the new text and rejecting every '
    + 'mark the old one. A value already holding marks is compared from its original, so a second edit of a passage '
    + 'updates its mark instead of nesting one. Text only: a typed or enum value is refused (`notText`). Answers '
    + '`marked: true` and `exact` (false when a difference could not be marked — inside fenced code, or text holding mark '
    + 'delimiters — and the new text was written unmarked). Read and decide the marks with tomAi_specAnnotations and '
    + 'tomAi_specDecideMarks.';
const MARKED_PARAM = { type: 'boolean', description: 'Write the new text as a marked change against the value there now. Default false.' };

export const SPEC_CREATE_DOCUMENT_TOOL = editTool<SpecCreateDocumentInput>(
    { name: 'tomAi_specCreateDocument', displayName: 'Spec: Create Document' },
    'Create a new, empty TomSpecs document for one model root, stamped with the current model version. The format follows '
    + 'the file name: `*.docspecs.yaml` or `*.md`. Refuses an existing file (`code: "exists"`); creates missing folders. '
    + 'List the roots with tomAi_specListDocuments. Answers the new document\'s header (format, stamp, revision).' + FIRST_LOOK,
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
    + 'SpecEditor. `text` null or empty clears it. A typed leaf takes a number or boolean, or a string it can read; a '
    + 'value its type cannot read (an int leaf given "lots" or 2.5, an enum leaf a name outside its domain) is refused as '
    + '`code: "wrongValue"` with the leaf\'s `field` (name, type, enum domain), as tomAi_specSetFormField answers. For '
    + 'form fields use tomAi_specSetFormField. Editor counterpart: doc_set_content.' + MARKED_NOTE + RESULT_NOTE,
    {
        ...EDIT_PARAMS,
        path: { type: 'string', description: PATH_PARAM_HINT },
        text: { ...VALUE_SCHEMA, description: 'The new value; null or "" clears it (with `marked`: marks the whole value deleted).' },
        marked: MARKED_PARAM,
    },
    ['file', 'path', 'text'],
    specSetContentImpl,
);

export const SPEC_SET_FORM_FIELD_TOOL = editTool<SpecSetFormFieldInput>(
    { name: 'tomAi_specSetFormField', displayName: 'Spec: Set Form Field' },
    'Set one field of a form, typed by its declaration: an `int` field takes a whole number (2.5 is refused), a `double` '
    + 'a number, a `bool` true/false, an enum one of its names; a string is stored as written and must read back as the '
    + 'declared type. A wrong value returns `code: "wrongValue"` with the field\'s type and enum domain; an unknown field '
    + 'returns the form\'s fields. null or "" clears it. tomAi_specGetSection shows each form\'s fields. Editor '
    + 'counterpart: doc_set_form_field.' + MARKED_NOTE + RESULT_NOTE,
    {
        ...EDIT_PARAMS,
        path: { type: 'string', description: `The form's path. ${PATH_PARAM_HINT}` },
        field: { type: 'string', description: 'The field name, e.g. `priority`.' },
        value: { ...VALUE_SCHEMA, description: 'The value, typed per the field (number, boolean, enum name or string).' },
        marked: MARKED_PARAM,
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


// ---------------------------------------------------------------------------
// specApplyEdits — the batch
// ---------------------------------------------------------------------------

/** The most edits one batch takes; keeps one call inside the tool time budget. */
export const MAX_BATCH_EDITS = 200;

/** The operations a batch entry can name, each with its single tool's argument shape. */
const BATCH_OPS: Record<string, (deps: SpecToolDeps, ctx: EditContext, input: never) => OpOutcome> = {
    setContent: opSetContent,
    setFormField: opSetFormField,
    setHeadline: opSetHeadline,
    setCodeSpec: opSetCodeSpec,
    addNode: opAddNode,
    setItemSectionId: opSetItemSectionId,
    moveListItem: opMoveListItem,
    removeListItem: opRemoveListItem,
    clearSection: opClearSection,
    // Review annotations (spec-annotation-tools.ts).
    ...ANNOTATION_BATCH_OPS,
};

/** The fields of an entry that hold a document path, and so may use `$name`. */
const PATH_FIELDS = ['path', 'parentPath', 'itemPath', 'toList'] as const;
const BINDING_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;
const REFERENCE = /^\$([A-Za-z_][A-Za-z0-9_]*)(\/.*)?$/;

export interface SpecBatchEdit {
    op: string;
    /** addNode only: bind the new node's path to this name for later entries (`$name/...`). */
    as?: string;
    [argument: string]: unknown;
}

export interface SpecApplyEditsInput extends SpecEditOptions {
    edits: SpecBatchEdit[];
}

/**
 * Check a batch before anything runs: the cap, known operations, `as` only on
 * addNode with a fresh name, and every `$name` bound by an earlier entry.
 */
function checkBatch(edits: unknown): string | null {
    if (!Array.isArray(edits) || edits.length === 0) { return '`edits` must be a non-empty array.'; }
    if (edits.length > MAX_BATCH_EDITS) { return `A batch takes at most ${MAX_BATCH_EDITS} edits; this one has ${edits.length}. Split it.`; }
    const bound = new Set<string>();
    for (let i = 0; i < edits.length; i++) {
        const e = edits[i] as SpecBatchEdit;
        if (!e || typeof e !== 'object' || !(e.op in BATCH_OPS)) {
            return `Edit ${i}: unknown op ${JSON.stringify(e?.op)}. Ops: ${Object.keys(BATCH_OPS).join(', ')}.`;
        }
        for (const field of PATH_FIELDS) {
            const value = e[field];
            const ref = typeof value === 'string' ? REFERENCE.exec(value) : null;
            if (typeof value === 'string' && value.startsWith('$') && !ref) {
                return `Edit ${i} (${e.op}): '${value}' is not a valid reference; write $name or $name/<path>.`;
            }
            if (ref && !bound.has(ref[1])) {
                return `Edit ${i} (${e.op}): $${ref[1]} is not bound by an earlier addNode (\`as: "${ref[1]}"\`).`;
            }
        }
        if (e.as !== undefined) {
            if (e.op !== 'addNode') { return `Edit ${i} (${e.op}): only addNode can bind a name with \`as\`.`; }
            if (typeof e.as !== 'string' || !BINDING_NAME.test(e.as)) { return `Edit ${i}: \`as\` must be a name like req or req_1.`; }
            if (bound.has(e.as)) { return `Edit ${i}: $${e.as} is already bound by an earlier entry.`; }
            bound.add(e.as);
        }
    }
    return null;
}

/** Replace the prefix `from` of `p` with `to`, when `p` is `from` or below it. */
function rebase(p: string, from: string, to: string): string | null {
    if (p === from) { return to; }
    return p.startsWith(`${from}/`) ? to + p.slice(from.length) : null;
}

/**
 * Where `p` is after a move. `renamed` is a permutation of item paths (a list
 * renumbered), so it is applied once, by the longest matching item path —
 * never entry after entry, which would chase one path round the whole cycle.
 */
function throughRenamed(p: string, renamed: Record<string, string>): string {
    let best: string | null = null;
    for (const from of Object.keys(renamed)) {
        if ((p === from || p.startsWith(`${from}/`)) && (best === null || from.length > best.length)) { best = from; }
    }
    return best === null ? p : (rebase(p, best, renamed[best]) as string);
}

export async function specApplyEditsImpl(deps: SpecToolDeps, input: SpecApplyEditsInput): Promise<string> {
    const invalid = checkBatch(input.edits);
    if (invalid) {
        return json({ ok: false, code: 'invalidBatch', error: invalid });
    }
    return runEdit(deps, input, (ctx) => {
        const bindings = new Map<string, string>();
        /** Every item path a move in this batch gave to another item: old → new. */
        const movedAway = new Map<string, string>();
        const results: Record<string, unknown>[] = [];
        const touched: string[] = [];
        input.edits.forEach((entry, index) => {
            const { op, as, ...args } = entry;
            try {
                for (const field of PATH_FIELDS) {
                    const value = args[field];
                    if (typeof value !== 'string') { continue; }
                    const ref = REFERENCE.exec(value);
                    if (ref) {
                        args[field] = (bindings.get(ref[1]) as string) + (ref[2] ?? '');
                        continue;
                    }
                    if ([...movedAway.keys()].some((from) => rebase(value, from, from) !== null)) {
                        const now = throughRenamed(value, Object.fromEntries(movedAway));
                        throw new SpecEditRefusal('stalePath',
                            `'${value}' names a position an earlier move in this batch changed; that item is now at '${now}'. `
                            + 'Write the new path, or bind the item with `as` and use $name.', { use: now });
                    }
                }
                const outcome = BATCH_OPS[op](deps, ctx, args as never);
                touched.push(...(Array.isArray(outcome.touched) ? outcome.touched : [outcome.touched]));
                const result = outcome.result ?? {};
                if (op === 'addNode' && as) { bindings.set(as, result.path as string); }
                const renamed = (result.renamed ?? {}) as Record<string, string>;
                if (Object.keys(renamed).length > 0) {
                    for (const [name, bound] of bindings) { bindings.set(name, throughRenamed(bound, renamed)); }
                    // Compose with earlier moves: an original position now leads where its item went last.
                    for (const [from, to] of movedAway) { movedAway.set(from, throughRenamed(to, renamed)); }
                    for (const [from, to] of Object.entries(renamed)) {
                        if (!movedAway.has(from)) { movedAway.set(from, to); }
                    }
                }
                results.push({ index, op, ...result });
            } catch (e) {
                throw new BatchEditFailure(index, op, e, results);
            }
        });
        return {
            touched,
            result: {
                applied: results.length,
                results,
                ...(bindings.size > 0 ? { bindings: Object.fromEntries(bindings) } : {}),
            },
        };
    });
}

/** The approval prompt for a batch: how many of each op, on which file, touching which paths. */
export function summarizeBatch(input: SpecApplyEditsInput): string {
    const edits = Array.isArray(input.edits) ? input.edits : [];
    const counts = new Map<string, number>();
    const paths: string[] = [];
    for (const e of edits) {
        counts.set(e.op, (counts.get(e.op) ?? 0) + 1);
        for (const field of PATH_FIELDS) {
            const v = e[field];
            if (typeof v === 'string' && !paths.includes(v)) { paths.push(v); }
        }
    }
    const ops = [...counts].map(([op, n]) => `${op} ×${n}`).join(', ');
    const shown = paths.slice(0, 6).join(', ') + (paths.length > 6 ? ` (+${paths.length - 6} more)` : '');
    const mode = input.dryRun ? ' (dry run, writes nothing)' : '';
    return `${edits.length} edit${edits.length === 1 ? '' : 's'} to ${input.file}${mode}: ${ops}. Paths: ${shown}`;
}

export const SPEC_APPLY_EDITS_TOOL: SharedToolDefinition<SpecApplyEditsInput> = {
    name: 'tomAi_specApplyEdits',
    displayName: 'Spec: Apply Edits',
    description:
        'Apply several edits to one TomSpecs document as ONE change: one approval, one write, one undo step, all or '
        + 'nothing. The preferred way to make more than one change (add an item, then fill it). `edits` is an ordered list '
        + `of up to ${MAX_BATCH_EDITS} entries, each \`{op, …}\` with the same arguments as the single tool, minus \`file\`: `
        + 'setContent {path, text, marked?}, setFormField {path, field, value, marked?}, setHeadline {path, headline}, setCodeSpec {path, '
        + 'codeSpec}, addNode {parentPath, childSegment, itemId?, month?, day?, content?, fields?, as?}, setItemSectionId '
        + '{itemPath, sectionId}, moveListItem {itemPath, toIndex, toList?}, removeListItem {itemPath}, clearSection {path}; '
        + 'and the review annotations: insertComment {path, field?, afterParagraph, text, author?, id?}, insertQuestion '
        + '{question, afterComment? | path + afterParagraph}, setAnswer {questionId, answer}, editComment {commentId, text}, '
        + 'assignCommentIds {floor?}, resolveAnnotation {id}, decideMarks {decisions + marksRevision? | all + path?} (mark ids '
        + 'are those of the document as the entry finds it), removeAllAnnotations {}. '
        + 'addNode can bind its new path with `as: "req"`; later entries write `$req` or `$req/FRED` in path, parentPath, '
        + 'itemPath or toList, so an item can be added and filled without knowing its generated id. A move re-points '
        + 'bound names; a later entry that names a path a move changed is refused (`stalePath`) with the new path. '
        + 'Names, ops and the cap are checked before anything runs (`invalidBatch`). Any failing entry aborts the whole '
        + 'batch and writes nothing: `{ok:false, failedOp: {index, op}, code, error, completed}`. On success: `{written, '
        + 'revision, applied, results: [{index, op, …}], bindings, validation: {introduced, resolved, underPath, total}}`, '
        + 'the validation compared before and after the whole batch. `dryRun` returns all of it plus the `diff`, writing '
        + 'nothing. Creating a document is tomAi_specCreateDocument. `validation` is the instance tier only; '
        + 'tomAi_specValidate gives the full picture, the DocSpecs schema tier included. Paths are document paths as in the '
        + 'single tools, e.g. `SBP/introductionAndScope/requirements/functionalRequirements/FRE-REQU-LST-1`.' + FIRST_LOOK,
    tags: ['tomspecs', 'som', 'docspecs', 'edit', 'tom-ai-chat'],
    readOnly: false,
    requiresApproval: true,
    inputSchema: {
        type: 'object',
        properties: {
            ...EDIT_PARAMS,
            edits: {
                type: 'array',
                maxItems: MAX_BATCH_EDITS,
                description: 'The edits, in order. Each is `{op, …arguments}`.',
                items: {
                    type: 'object',
                    properties: {
                        op: { type: 'string', enum: Object.keys(BATCH_OPS) },
                        as: { type: 'string', description: 'addNode only: name for the new path.' },
                    },
                    required: ['op'],
                },
            },
        },
        required: ['file', 'edits'],
    },
    approvalSummary: summarizeBatch,
    execute: async (input) => specApplyEditsImpl(liveDeps(), input),
};

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
    SPEC_APPLY_EDITS_TOOL,
];
