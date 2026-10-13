/**
 * Read-only views of a TomSpecs (SOM) document and of the model behind it,
 * shaped for agent tools: what is in a document (outline, one section) and
 * what the model allows there (reflection, which children may be added).
 *
 * Every answer comes from the runtime — SpecReflection for paths and kinds,
 * SpecDocument for values, SpecEditor for typed form values, checkAddNode for
 * what may be added — so a tool never re-derives a model rule.
 *
 * Paths are document paths (`SBP/introductionAndScope/...`). A path that does
 * not resolve is answered with the nearest ancestor that does and that node's
 * children, so an agent can correct the path instead of guessing again. In a
 * document, a list item exists only when the list holds it; the model alone
 * would resolve `…-LST-99` for any number.
 *
 * vscode-free.
 */

import {
    SpecEditor,
    SpecNodeKind,
    checkAddNode,
    specParentPath,
    specPathJoin,
    specPathSegments,
    splitListItemSegment,
} from 'tom_som_typescript_runtime';
import type {
    FormFieldSpec,
    SpecAnnotation,
    SpecClass,
    SpecDocument,
    SpecField,
    SpecResolution,
} from 'tom_som_typescript_runtime';

import { SomModelService } from './som-model-service';

/** Thrown for a path or class the model (or the document) does not have; carries the recovery hint. */
export class SpecPathError extends Error {
    constructor(
        message: string,
        /** The nearest ancestor that resolves, with its children; null when not even the root does. */
        readonly nearest: { path: string; kind: string; children: string[] } | null,
    ) {
        super(message);
        this.name = 'SpecPathError';
    }
}

/** One node of a document, compact: absent facts are left out rather than null. */
export interface SpecNodeSummary {
    path: string;
    kind: string;
    sectionId?: string;
    headline?: string;
    codeSpec?: string;
    filled: boolean;
    /** Lists only. */
    itemCount?: number;
    /** Outline only: levels below the outline's start node. */
    depth?: number;
}

export interface SpecFormFieldView {
    name: string;
    label: string;
    type: string;
    required: boolean;
    enumValues?: string[];
    hint?: string;
    value: string | number | boolean | null;
}

export interface SpecOutline {
    path: string;
    total: number;
    offset: number;
    nodes: SpecNodeSummary[];
    /** Present when more nodes follow: pass it as `offset` for the next page. */
    nextOffset?: number;
}

export interface SpecSectionView extends SpecNodeSummary {
    /** Value leaves (content, scalar, enum, scalar list item): the value itself. */
    value?: string | number | boolean | null;
    /** Form nodes: the typed fields. */
    fields?: SpecFormFieldView[];
    /** Lists: the items. */
    items?: SpecNodeSummary[];
    /** Class-bearing nodes: their value-leaf children by segment (only those holding a value). */
    values?: Record<string, string>;
    /** Class-bearing nodes: their form children, every field with its value or null. */
    forms?: Record<string, { path: string; fields: SpecFormFieldView[] }>;
    /** Class-bearing nodes: their structural children (complex, section, list). */
    children?: Array<SpecNodeSummary & { items?: SpecNodeSummary[] }>;
}

export interface SpecFieldInfo {
    name: string;
    segment: string;
    kind: string;
    type?: string;
    elementType?: string;
    sectionIdPattern?: string;
    min?: number;
    contentType?: string;
    enumValues?: string[];
    headline?: string;
    doc?: string;
    help?: string;
    formFields?: Array<Omit<SpecFormFieldView, 'value'>>;
    annotations?: Array<{ name: string; arguments: Record<string, unknown> }>;
}

export interface SpecClassInfo {
    name: string;
    sectionId?: string;
    headline?: string;
    doc?: string;
    help?: string;
    mapsTo?: string;
    detailedIn?: string;
    annotations?: Array<{ name: string; arguments: Record<string, unknown> }>;
    fields: SpecFieldInfo[];
}

export interface SpecReflectView {
    path?: string;
    kind?: string;
    root?: string;
    field?: SpecFieldInfo;
    class?: SpecClassInfo;
    /** Lists: the item class. */
    itemClass?: SpecClassInfo;
    /** With a document: the child segments checkAddNode accepts under this path now. */
    addable?: string[];
    /** With a document: the ones it refuses, and why. */
    notAddable?: Array<{ segment: string; code: string; reason: string }>;
}

/**
 * Annotations already stated by other fields of the view (the segment, the
 * kind, the order), left out so the reflection stays readable.
 */
const REDUNDANT_ANNOTATIONS = new Set(['SectionId', 'SectionIdPattern', 'Form', 'SerializationOrder', 'ContentType', 'Min']);

const VALUE_LEAF_KINDS: ReadonlySet<string> = new Set([
    SpecNodeKind.CONTENT, SpecNodeKind.SCALAR, SpecNodeKind.ENUM_VALUE, SpecNodeKind.LIST_ITEM_SCALAR,
]);

const STRUCTURAL_KINDS: ReadonlySet<string> = new Set([
    SpecNodeKind.COMPLEX, SpecNodeKind.SECTION, SpecNodeKind.LIST,
]);

/** Outline depth is capped: model types can recurse, and the answer must stay bounded. */
export const MAX_OUTLINE_DEPTH = 12;

export class SomSpecInspector {
    private readonly editor: SpecEditor | null;

    /** `document` is null for model-only questions (reflection without a file). */
    constructor(
        private readonly service: SomModelService,
        private readonly document: SpecDocument | null,
    ) {
        this.editor = document ? SpecEditor.forModel(document, service.model) : null;
    }

    // ── resolution ──────────────────────────────────────────────────────────

    /**
     * Resolve `path` in the model and, with a document, check that every list
     * item on the way exists. Throws {@link SpecPathError} naming the nearest
     * resolvable ancestor and its children otherwise.
     */
    resolve(path: string): SpecResolution {
        const res = this.tryResolve(path);
        if (res) { return res; }
        throw new SpecPathError(`'${path}' does not resolve${this.document ? ' in this document' : ' in the model'}.`, this.nearest(path));
    }

    private tryResolve(path: string): SpecResolution | null {
        const res = this.service.reflection.resolve(path);
        if (!res || !this.document) { return res; }
        const segs = specPathSegments(path);
        for (let i = 1; i < segs.length; i++) {
            const split = splitListItemSegment(segs[i]);
            if (!split) { continue; }
            const prefix = segs.slice(0, i + 1).join('/');
            const kind = this.service.reflection.resolve(prefix)?.kind;
            if (kind !== SpecNodeKind.LIST_ITEM_COMPLEX && kind !== SpecNodeKind.LIST_ITEM_SCALAR) { continue; }
            const listPath = specPathJoin(segs.slice(0, i).join('/'), split.base);
            if (!this.document.listItems(listPath).includes(prefix)) { return null; }
        }
        return res;
    }

    private nearest(path: string): SpecPathError['nearest'] {
        let p = path;
        while (p.includes('/')) {
            const dropped = specPathSegments(p).pop() as string;
            p = specParentPath(p);
            // A missing list item's nearest node is its list, which is not a
            // path prefix of the item (`…/X-LST-9` sits beside `…/X-LST`).
            const split = splitListItemSegment(dropped);
            if (split) {
                const listPath = specPathJoin(p, split.base);
                const list = this.tryResolve(listPath);
                if (list?.kind === SpecNodeKind.LIST) {
                    return { path: listPath, kind: list.kind, children: this.childPaths(listPath, list) };
                }
            }
            const res = this.tryResolve(p);
            if (res) {
                return { path: p, kind: res.kind, children: this.childPaths(p, res) };
            }
        }
        return null;
    }

    /** Child paths of a node: the declared fields of a class-bearing node, the held items of a list. */
    private childPaths(path: string, res: SpecResolution): string[] {
        if (res.kind === SpecNodeKind.LIST) {
            return this.document ? this.document.listItems(path) : [];
        }
        if (!res.targetClass) { return []; }
        return res.targetClass.fields.map((f) => specPathJoin(path, this.service.reflection.fieldSegment(f)));
    }

    // ── document views ──────────────────────────────────────────────────────

    summary(path: string, res: SpecResolution = this.resolve(path)): SpecNodeSummary {
        const doc = this.requireDocument();
        const node: SpecNodeSummary = { path, kind: res.kind, filled: doc.hasValuesUnder(path) };
        const sectionId = res.kind === SpecNodeKind.LIST_ITEM_COMPLEX || res.kind === SpecNodeKind.LIST_ITEM_SCALAR
            ? doc.itemSectionId(path)
            : res.kind === SpecNodeKind.ROOT ? res.root.sectionId : res.field?.sectionId;
        if (sectionId) { node.sectionId = sectionId; }
        const headline = doc.headline(path)
            ?? (res.kind === SpecNodeKind.ROOT ? res.root.title : null)
            ?? (res.kind === SpecNodeKind.LIST ? null : res.field?.headline ?? res.targetClass?.headline ?? null);
        if (headline) { node.headline = headline; }
        const codeSpec = doc.codeSpec(path);
        if (codeSpec) { node.codeSpec = codeSpec; }
        if (res.kind === SpecNodeKind.LIST) { node.itemCount = doc.listItemCount(path); }
        return node;
    }

    /**
     * The instance tree under `path` (default: the document root), pre-order,
     * `depth` levels deep, paged. With `filledOnly`, empty subtrees are left out.
     */
    outline(path: string, options: { depth?: number; offset?: number; limit?: number; filledOnly?: boolean } = {}): SpecOutline {
        const depth = Math.min(Math.max(options.depth ?? 2, 0), MAX_OUTLINE_DEPTH);
        const offset = Math.max(options.offset ?? 0, 0);
        const limit = Math.max(options.limit ?? 200, 1);
        const all: SpecNodeSummary[] = [];
        const walk = (p: string, res: SpecResolution, level: number): void => {
            const node = this.summary(p, res);
            if (options.filledOnly && !node.filled && level > 0) { return; }
            all.push({ ...node, depth: level });
            if (level >= depth) { return; }
            for (const child of this.childPaths(p, res)) {
                const childRes = this.service.reflection.resolve(child);
                if (childRes) { walk(child, childRes, level + 1); }
            }
        };
        walk(path, this.resolve(path), 0);
        const nodes = all.slice(offset, offset + limit);
        const out: SpecOutline = { path, total: all.length, offset, nodes };
        if (offset + nodes.length < all.length) { out.nextOffset = offset + nodes.length; }
        return out;
    }

    /** One node with its values: a leaf's value, a form's fields, a list's items, or a section's own values, forms and structure. */
    section(path: string): SpecSectionView {
        const doc = this.requireDocument();
        const res = this.resolve(path);
        const view: SpecSectionView = this.summary(path, res);
        if (VALUE_LEAF_KINDS.has(res.kind)) {
            view.value = this.leafValue(path);
            return view;
        }
        if (res.kind === SpecNodeKind.FORM) {
            view.fields = this.formFields(path);
            return view;
        }
        if (res.kind === SpecNodeKind.LIST) {
            view.items = doc.listItems(path).map((item) => this.summary(item));
            return view;
        }
        const values: Record<string, string> = {};
        const forms: NonNullable<SpecSectionView['forms']> = {};
        const children: NonNullable<SpecSectionView['children']> = [];
        for (const childPath of this.childPaths(path, res)) {
            const childRes = this.service.reflection.resolve(childPath);
            if (!childRes) { continue; }
            const segment = specPathSegments(childPath).pop() as string;
            if (VALUE_LEAF_KINDS.has(childRes.kind)) {
                const v = doc.content(childPath);
                if (v !== null) { values[segment] = v; }
            } else if (childRes.kind === SpecNodeKind.FORM) {
                forms[segment] = { path: childPath, fields: this.formFields(childPath) };
            } else if (STRUCTURAL_KINDS.has(childRes.kind)) {
                const child: SpecNodeSummary & { items?: SpecNodeSummary[] } = this.summary(childPath, childRes);
                if (childRes.kind === SpecNodeKind.LIST) {
                    child.items = doc.listItems(childPath).map((item) => this.summary(item));
                }
                children.push(child);
            }
        }
        if (Object.keys(values).length > 0) { view.values = values; }
        if (Object.keys(forms).length > 0) { view.forms = forms; }
        if (children.length > 0) { view.children = children; }
        return view;
    }

    private leafValue(path: string): string | number | boolean | null {
        try {
            return this.editor!.value(path);
        } catch {
            return this.requireDocument().content(path);
        }
    }

    private formFields(path: string): SpecFormFieldView[] {
        const editor = this.editor!;
        return editor.formFields(path).map((spec) => {
            let value: SpecFormFieldView['value'];
            try {
                value = editor.formValue(path, spec.name);
            } catch {
                // A stored value the declared type cannot parse is shown as stored.
                value = this.requireDocument().formField(path, spec.name);
            }
            return { ...formFieldInfo(spec), value };
        });
    }

    private requireDocument(): SpecDocument {
        if (!this.document) { throw new Error('This view needs a document.'); }
        return this.document;
    }

    // ── reflection ──────────────────────────────────────────────────────────

    /**
     * The model facts at `path`. With a document, also which children
     * checkAddNode accepts there now (cardinality and list ids depend on it).
     */
    reflectPath(path: string, options: { brief?: boolean } = {}): SpecReflectView {
        const res = this.resolve(path);
        const brief = options.brief ?? false;
        const view: SpecReflectView = { path, kind: res.kind, root: res.root.sectionId ?? res.root.type };
        if (res.field) { view.field = fieldInfo(this.service, res.field, brief); }
        if (res.targetClass) { view.class = classInfo(this.service, res.targetClass, brief); }
        if (res.kind === SpecNodeKind.LIST && res.field?.elementIsComplex) {
            const item = this.service.reflection.classNamed(res.field.elementType);
            if (item) { view.itemClass = classInfo(this.service, item, brief); }
        }
        if (this.document) {
            const candidates = this.addCandidates(path, res);
            if (candidates) {
                view.addable = [];
                view.notAddable = [];
                for (const { parent, segment } of candidates) {
                    const error = checkAddNode(this.service.model, this.document, parent, segment);
                    if (error) {
                        view.notAddable.push({ segment, code: error.code, reason: error.message });
                    } else {
                        view.addable.push(segment);
                    }
                }
            }
        }
        return view;
    }

    /** A class by name, with no document needed. Throws with close names for an unknown one. */
    reflectClass(className: string, options: { brief?: boolean } = {}): SpecReflectView {
        const cls = this.service.reflection.classNamed(className);
        if (!cls) {
            const needle = className.toLowerCase();
            const close = this.service.reflection.classes
                .map((c) => c.name)
                .filter((n) => n.toLowerCase().includes(needle) || needle.includes(n.toLowerCase()))
                .slice(0, 10);
            throw new SpecPathError(
                `No model class '${className}'.${close.length > 0 ? ` Similar: ${close.join(', ')}.` : ''}`,
                null,
            );
        }
        return { class: classInfo(this.service, cls, options.brief ?? false) };
    }

    /**
     * The (parent, segment) pairs an add at `path` means: every declared
     * field of a class-bearing node, or a new item for a list (asked of the
     * list's parent with the list's segment, as checkAddNode takes it).
     */
    private addCandidates(path: string, res: SpecResolution): Array<{ parent: string; segment: string }> | null {
        if (res.kind === SpecNodeKind.LIST) {
            return [{ parent: specParentPath(path), segment: specPathSegments(path).pop() as string }];
        }
        if (!res.targetClass) { return null; }
        return res.targetClass.fields.map((f) => ({ parent: path, segment: this.service.reflection.fieldSegment(f) }));
    }
}

// ── model fact shapes ────────────────────────────────────────────────────────

function formFieldInfo(spec: FormFieldSpec): Omit<SpecFormFieldView, 'value'> {
    const out: Omit<SpecFormFieldView, 'value'> = { name: spec.name, label: spec.label, type: spec.type, required: spec.required };
    if (spec.enumValues.length > 0) { out.enumValues = [...spec.enumValues]; }
    if (spec.hint) { out.hint = spec.hint; }
    return out;
}

function annotationsInfo(annotations: SpecAnnotation[]): SpecFieldInfo['annotations'] {
    const kept = annotations.filter((a) => !REDUNDANT_ANNOTATIONS.has(a.name));
    return kept.length > 0 ? kept.map((a) => ({ name: a.name, arguments: a.arguments })) : undefined;
}

export function fieldInfo(service: SomModelService, f: SpecField, brief: boolean): SpecFieldInfo {
    const info: SpecFieldInfo = { name: f.name, segment: service.reflection.fieldSegment(f), kind: f.kind };
    if (f.type) { info.type = f.type; }
    if (f.elementType) { info.elementType = f.elementType; }
    if (f.sectionIdPattern) { info.sectionIdPattern = f.sectionIdPattern; }
    if (f.min !== null && f.min !== undefined) { info.min = f.min; }
    if (f.contentType) { info.contentType = f.contentType; }
    if (f.enumValues.length > 0) { info.enumValues = [...f.enumValues]; }
    if (f.headline) { info.headline = f.headline; }
    if (f.formFields.length > 0) { info.formFields = f.formFields.map(formFieldInfo); }
    if (!brief) {
        if (f.doc) { info.doc = f.doc; }
        if (f.help) { info.help = f.help; }
        const annotations = annotationsInfo(f.annotations);
        if (annotations) { info.annotations = annotations; }
    }
    return info;
}

export function classInfo(service: SomModelService, cls: SpecClass, brief: boolean): SpecClassInfo {
    const info: SpecClassInfo = { name: cls.name, fields: cls.fields.map((f) => fieldInfo(service, f, brief)) };
    if (cls.sectionId) { info.sectionId = cls.sectionId; }
    if (cls.headline) { info.headline = cls.headline; }
    if (cls.mapsTo) { info.mapsTo = cls.mapsTo; }
    if (cls.detailedIn) { info.detailedIn = cls.detailedIn; }
    if (!brief) {
        if (cls.doc) { info.doc = cls.doc; }
        if (cls.help) { info.help = cls.help; }
        const annotations = annotationsInfo(cls.annotations);
        if (annotations) { info.annotations = annotations; }
    }
    return info;
}
