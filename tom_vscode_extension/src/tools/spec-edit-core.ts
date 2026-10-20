/**
 * The edit cycle every TomSpecs (SOM) write tool shares — spec-edit-tools.ts
 * (structure and values) and spec-annotation-tools.ts (review annotations):
 * load, refuse a read-only document or a stale revision, run the operation on
 * the document in memory, compare validation before and after, save through
 * the store (or return the diff on a dry run). A refused operation writes
 * nothing. Also the parameter text and the tool shape the write tools share.
 */

import {
    SpecCreationError,
    SpecEditor,
    SpecNodeKind,
    SpecReviewAnnotationError,
    SpecSectionIdCollision,
    validateDocument,
} from 'tom_som_typescript_runtime';
import type { SomValue, SpecResolution, SpecValidationError } from 'tom_som_typescript_runtime';

import { SharedToolDefinition } from './shared-tool-registry';
import { BATCH_HINT, FILE_PARAM, SpecToolDeps, UNRESOLVED_NOTE, failure, json, liveDeps, loadDocument } from './spec-tool-common';
import { SomSpecInspector } from '../services/som-spec-inspector';
import type { LoadedSomDocument } from '../services/som-document-store';

/** What every edit takes besides its own arguments. */
export interface SpecEditOptions {
    file: string;
    /** Refuse unless the file is still at this revision (the one the agent read). */
    expectedRevision?: string;
    /** Compute the result and the diff; write nothing. */
    dryRun?: boolean;
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

/** An operation's arguments without the per-call file options (a batch entry has no `file`). */
export type OpInput<T> = Omit<T, keyof SpecEditOptions>;

/** What an operation did: the path(s) it touched (for `underPath`) and its part of the answer. */
export interface OpOutcome {
    touched: string | string[];
    result?: Record<string, unknown>;
}

export interface EditContext {
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
export async function runEdit(
    deps: SpecToolDeps,
    options: SpecEditOptions,
    mutate: (ctx: EditContext) => OpOutcome,
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
        const outcome = mutate(ctx);
        const touched = Array.isArray(outcome.touched) ? outcome.touched : [outcome.touched];
        const result = outcome.result;
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
                underPath: after.filter((e) => touched.some((t) => under(e.path, t))).map(errorView),
                total: after.length,
            },
            ...(saved.staleReviewPaths.length > 0 ? { staleReviewPaths: saved.staleReviewPaths } : {}),
            ...(options.dryRun ? { diff: saved.diff } : {}),
        });
    } catch (e) {
        return editFailure(e);
    }
}

export function editFailure(e: unknown): string {
    if (e instanceof BatchEditFailure) {
        const inner = JSON.parse(editFailure(e.cause)) as Record<string, unknown>;
        return json({ ...inner, failedOp: { index: e.index, op: e.op }, completed: e.completed });
    }
    if (e instanceof SpecEditRefusal) {
        return json({ ok: false, code: e.code, error: e.message, ...e.details });
    }
    if (e instanceof SpecCreationError) {
        return json({ ok: false, code: e.code, error: e.message });
    }
    if (e instanceof SpecSectionIdCollision) {
        return json({ ok: false, code: 'sectionIdCollision', error: e.message });
    }
    if (e instanceof SpecReviewAnnotationError) {
        // An annotation, value or paragraph that is not there, or a stale mark revision.
        return json({ ok: false, code: 'annotationRefused', error: e.message });
    }
    if (e instanceof RangeError) {
        return json({ ok: false, code: 'outOfRange', error: e.message });
    }
    const handled = failure(e);
    const parsed = JSON.parse(handled) as { code?: string };
    // Anything else the runtime threw is its refusal of the edit, stated in its own words.
    return parsed.code ? handled : json({ ok: false, code: 'refused', error: (e as Error).message });
}

export function requireKind(res: SpecResolution, path: string, kinds: readonly string[], what: string): void {
    if (!kinds.includes(res.kind)) {
        throw new SpecEditRefusal('wrongKind', `'${path}' is a ${res.kind} node, not ${what}.`, { kind: res.kind });
    }
}

/**
 * Set a value leaf through the runtime's SpecEditor. A value the leaf's
 * declared type cannot read — "lots" or 2.5 into an int leaf, a name outside
 * an enum leaf's domain — is refused as `wrongValue` in the runtime's words,
 * with the leaf's name and type (and enum domain): the answer
 * tomAi_specSetFormField gives for the same mistake. The runtime formats the
 * value before it stores it, so a refused value leaves the leaf as it was.
 * The caller has checked that `path` is a value leaf.
 */
export function setLeafValue(editor: SpecEditor, path: string, value: SomValue): void {
    const res = editor.resolve(path);
    try {
        editor.setValue(path, value);
    } catch (e) {
        const f = res.field;
        const type = f ? (f.enumType ?? f.type ?? f.elementType ?? null) : null;
        const enumValues = f && f.enumValues.length > 0 ? { enumValues: [...f.enumValues] } : {};
        throw new SpecEditRefusal('wrongValue', (e as Error).message, f ? { field: { name: f.name, type, ...enumValues } } : {});
    }
}

export const VALUE_LEAVES: readonly string[] = [SpecNodeKind.CONTENT, SpecNodeKind.SCALAR, SpecNodeKind.ENUM_VALUE, SpecNodeKind.LIST_ITEM_SCALAR];
export const LIST_ITEMS: readonly string[] = [SpecNodeKind.LIST_ITEM_COMPLEX, SpecNodeKind.LIST_ITEM_SCALAR];

/** A batch entry that failed: which one, why, and what the entries before it did (none of it written). */
export class BatchEditFailure extends Error {
    constructor(readonly index: number, readonly op: string, readonly cause: unknown, readonly completed: Record<string, unknown>[]) {
        super(cause instanceof Error ? cause.message : String(cause));
        this.name = 'BatchEditFailure';
    }
}

// ---------------------------------------------------------------------------
// What the write tools share
// ---------------------------------------------------------------------------

export const VALUE_SCHEMA = { type: ['string', 'number', 'boolean', 'null'] };
export const EDIT_PARAMS = {
    file: FILE_PARAM,
    expectedRevision: { type: 'string', description: 'The `revision` from the last read; the edit is refused when the file has changed since.' },
    dryRun: { type: 'boolean', description: 'Return the result and a unified `diff` without writing. Default false.' },
};
export const RESULT_NOTE =
    ' Answers `{ok, written, revision, …, validation: {introduced, resolved, underPath, total}}` — validation found by '
    + 'the runtime\'s validateDocument, compared before and after the edit across the whole document (a stated count '
    + 'that no longer matches is `countMismatch`) — plus `staleReviewPaths` for YAML review entries left without a node, '
    + 'and `diff` on a dry run. A refused edit writes nothing and returns `{ok:false, code, error}`; the document must '
    + 'be editable (see readOnlyReason in tomAi_specOutline). ' + UNRESOLVED_NOTE + BATCH_HINT;

/**
 * One edit tool. The `{ name, displayName }` literal keeps `name: 'tomAi_…'`
 * greppable: the tool-coverage audit finds tools by that text.
 */
export function editTool<T>(id: { name: string; displayName: string }, description: string, properties: Record<string, unknown>, required: string[], impl: (deps: SpecToolDeps, input: T) => Promise<string>): SharedToolDefinition<T> {
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

