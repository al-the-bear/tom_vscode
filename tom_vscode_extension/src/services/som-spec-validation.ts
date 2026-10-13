/**
 * Validating TomSpecs (SOM) documents, and rendering one subtree, for the
 * agent tools (tomAi_specValidate / tomAi_specRender).
 *
 * Validation runs the three tiers tom_specs' `validate_spec` CLI runs, and
 * reports them in the same shape (`spec-validation`/1: tiers, notRun,
 * violations `{tier, code, severity, file, line, location, message}`), so an
 * agent gets one answer for one file whichever tool asks:
 *
 *   decode    — reading each file: Markdown parse rejections; with several
 *               fragments, roots that disagree and values written by more
 *               than one fragment (SpecAssemblyOverlap, every writer named);
 *   schema    — DocSpecsValidator over the document's Markdown rendition,
 *               against the root's generated schema from the facade;
 *   instance  — validateDocument: typed values, enum domains, references,
 *               stated counts (countOf).
 *
 * The extension adds `path` to each finding: the document path to fix, in the
 * form the edit tools take. The instance tier states it. A schema finding
 * carries only a section id and a line of the rendition, and a section id
 * repeats (every requirement has a FRED form), so the path is found by
 * rendering once more with a marker headline on every node bearing that id
 * and reading which heading the line falls under (headlines are one line, so
 * line numbers do not move). tom_specs vsctasb6 asks the runtime to fill
 * DocSpecsViolation.path itself.
 *
 * vscode-free.
 */

import {
    DocSpecsDocument,
    DocSpecsValidator,
    SpecDocument,
    SpecNodeKind,
    assembleSpecDocuments,
    specPathSegments,
    validateDocument,
} from 'tom_som_typescript_runtime';
import type { SpecRoot } from 'tom_som_typescript_runtime';

import { SomDocumentError, SomDocumentStore } from './som-document-store';
import type { LoadedSomDocument } from './som-document-store';
import { SomModelService } from './som-model-service';

export const SPEC_VALIDATION_FORMAT = 'spec-validation';
export const SPEC_VALIDATION_FORMAT_VERSION = 1;
export const SPEC_VALIDATION_TIERS = ['decode', 'schema', 'instance'] as const;
export type SpecValidationTier = (typeof SPEC_VALIDATION_TIERS)[number];

export interface SpecValidationFinding {
    tier: SpecValidationTier;
    code: string;
    severity: 'error';
    /** The file a decode finding belongs to; for one document, that document. */
    file: string | null;
    /** 1-based line: of the file (decode) or of the Markdown rendition (schema). */
    line: number | null;
    /** What the tier itself names: a section id (schema) or a document path. */
    location: string | null;
    /** The document path to fix, as the edit tools take it, when known. */
    path?: string;
    message: string;
}

export interface SpecValidationReport {
    format: typeof SPEC_VALIDATION_FORMAT;
    formatVersion: typeof SPEC_VALIDATION_FORMAT_VERSION;
    root: { type: string; sectionId: string | null; title: string; schemaId: string | null; schemaVersion: string | null } | null;
    passed: boolean;
    summary: string;
    tiers: Array<{ tier: SpecValidationTier; ran: boolean; findings: number }>;
    notRun: Array<{ tier: SpecValidationTier; reason: string }>;
    violations: SpecValidationFinding[];
    /** With a scope: findings left out because their path is outside it, or unknown. */
    outOfScope?: number;
}

const DOCSPEC_SCHEMA = /^<!-- docspec: ([^/\s]+)\/\S+ -->/;

function under(p: string, scope: string): boolean {
    return p === scope || p.startsWith(`${scope}/`);
}

export class SomSpecValidation {
    constructor(private readonly service: SomModelService, private readonly store: SomDocumentStore) {}

    /**
     * Validate one document, or several fragments of one document as one.
     * `names` are what findings call each file (workspace-relative paths);
     * `scope` keeps only findings whose path is at or below it.
     */
    validate(files: Array<{ filePath: string; name: string }>, options: { scope?: string } = {}): SpecValidationReport {
        const findings: SpecValidationFinding[] = [];
        const notRun: SpecValidationReport['notRun'] = [];
        const single = files.length === 1 ? files[0].name : null;
        const finding = (f: Omit<SpecValidationFinding, 'severity' | 'file' | 'line' | 'location'> & Partial<SpecValidationFinding>): void => {
            const { tier, code, ...rest } = f;
            findings.push({ tier, code, severity: 'error', file: single, line: null, location: null, ...rest });
        };

        // Tier 1 — decode every file, then assemble.
        const loaded: Array<{ name: string; doc: LoadedSomDocument }> = [];
        for (const { filePath, name } of files) {
            try {
                const doc = this.store.load(filePath);
                loaded.push({ name, doc });
                for (const r of doc.rejections) {
                    finding({ tier: 'decode', code: r.reason, file: name, line: r.line, message: r.message });
                }
            } catch (e) {
                const code = e instanceof SomDocumentError ? e.code : 'format';
                finding({ tier: 'decode', code, file: name, message: (e as Error).message });
            }
        }
        const roots = new Set(loaded.map((l) => l.doc.root.type));
        const root: SpecRoot | null = loaded[0]?.doc.root ?? null;
        let document: SpecDocument | null = null;
        let reason: string | null = null;
        if (loaded.length < files.length) {
            reason = files.length === 1
                ? 'the document did not decode, so there is nothing to check'
                : 'a fragment did not decode, so there is no assembled document to check';
        } else if (roots.size > 1) {
            finding({
                tier: 'decode', code: 'rootMismatch', file: null,
                message: `The fragments belong to different document roots (${[...roots].join(', ')}); only fragments of one root assemble.`,
            });
            reason = 'the fragments belong to different roots';
        } else if (loaded.length === 1) {
            document = loaded[0].doc.document;
        } else {
            const assembly = assembleSpecDocuments(loaded.map((l) => [l.name, l.doc.document] as const));
            for (const o of assembly.overlaps) {
                const where = o.field === null ? o.path : `${o.path}/${o.field}`;
                finding({ tier: 'decode', code: 'overlap', file: null, location: where, path: o.path, message: o.message });
            }
            document = assembly.document;
            if (!document) { reason = 'the fragments overlap, so they do not assemble into one document'; }
        }

        let schemaId: string | null = null;
        let schemaVersion: string | null = null;
        if (!document || !root) {
            for (const tier of ['schema', 'instance'] as const) { notRun.push({ tier, reason: reason ?? 'nothing to check' }); }
        } else {
            // Tier 2 — the DocSpecs schema over the rendition.
            const markdown = document.toMarkdown(this.service.model, root.type);
            schemaId = DOCSPEC_SCHEMA.exec(markdown)?.[1] ?? null;
            if (!schemaId || !this.service.schemaIds.includes(schemaId)) {
                const named = schemaId ? `\`${schemaId}\` ` : '';
                notRun.push({ tier: 'schema', reason: `no DocSpecs schema ${named}ships for ${root.type}` });
            } else {
                schemaVersion = this.service.schemaVersion(schemaId);
                const violations = new DocSpecsValidator(this.service.schema(schemaId)).validateMarkdown(markdown);
                const paths = violations.length > 0 ? this.locate(document, root, markdown, violations) : [];
                violations.forEach((v, i) => {
                    finding({
                        tier: 'schema',
                        code: v.rule,
                        line: v.line,
                        location: v.sectionId ?? v.path,
                        ...(paths[i] ? { path: paths[i] as string } : {}),
                        message: `${v.message} (schema ${schemaId}/${schemaVersion ?? '?'})`,
                    });
                });
            }

            // Tier 3 — the instance tier.
            for (const e of validateDocument(this.service.model, document)) {
                finding({ tier: 'instance', code: e.code, location: e.path, path: e.path, message: e.message });
            }
        }

        let violations = findings;
        let outOfScope: number | undefined;
        if (options.scope) {
            violations = findings.filter((f) => f.path !== undefined && under(f.path, options.scope as string));
            outOfScope = findings.length - violations.length;
        }
        const passed = findings.length === 0 && notRun.length === 0;
        const tiers = SPEC_VALIDATION_TIERS.map((tier) => ({
            tier,
            ran: !notRun.some((n) => n.tier === tier),
            findings: violations.filter((f) => f.tier === tier).length,
        }));
        const summary = passed
            ? 'all three tiers clean'
            : `${violations.length} finding(s)${options.scope ? ` under ${options.scope}` : ''} — `
                + tiers.map((t) => `${t.tier} ${t.findings}`).join(', ')
                + (notRun.length > 0 ? `; ${notRun.length} tier(s) not run` : '');
        return {
            format: SPEC_VALIDATION_FORMAT,
            formatVersion: SPEC_VALIDATION_FORMAT_VERSION,
            root: root ? { type: root.type, sectionId: root.sectionId, title: root.title, schemaId, schemaVersion } : null,
            passed,
            summary,
            tiers,
            notRun,
            violations,
            ...(outOfScope !== undefined ? { outOfScope } : {}),
        };
    }

    /**
     * The document path of each schema violation, or null where it cannot be
     * told. A violation names a section id and a line of `markdown`. The
     * section id is looked up first; when no node bears it (a missing required
     * section), the heading the line falls under is used instead.
     */
    locate(document: SpecDocument, root: SpecRoot, markdown: string, violations: Array<{ line: number; sectionId: string | null }>): Array<string | null> {
        const lines = markdown.split('\n');
        const parsed = DocSpecsDocument.parse(markdown).allSections;
        const enclosingId = (line: number): string | null => {
            let best: { line: number; id: string | null } | null = null;
            for (const s of parsed) {
                if (s.line <= line && (!best || s.line > best.line)) { best = { line: s.line, id: s.id }; }
            }
            return best?.id ?? null;
        };
        const byId = this.pathsByHeadingId(document, root);
        const wanted = new Map<string, string[]>();
        const ids = violations.map((v) => {
            const id = v.sectionId && byId.has(v.sectionId) ? v.sectionId : enclosingId(v.line);
            if (id && byId.has(id)) { wanted.set(id, byId.get(id) as string[]); }
            return id;
        });
        if (wanted.size === 0) { return violations.map(() => null); }

        // Render once more with a marker headline on every candidate; the line a
        // marker lands on is that candidate's heading.
        const marked = new SpecDocument();
        marked.loadJson(document.toJson());
        const candidates = [...new Set([...wanted.values()].flat())];
        candidates.forEach((p, i) => marked.setHeadline(p, `⟦${i}⟧`));
        const markedLines = marked.toMarkdown(this.service.model, root.type).split('\n');
        if (markedLines.length !== lines.length) { return violations.map(() => null); }
        const headingLine = new Map<string, number>();
        markedLines.forEach((l, i) => {
            const m = /⟦(\d+)⟧/.exec(l);
            if (m) { headingLine.set(candidates[Number(m[1])], i + 1); }
        });
        return violations.map((v, i) => {
            const id = ids[i];
            let best: { path: string; line: number } | null = null;
            for (const p of (id && wanted.get(id)) || []) {
                const at = headingLine.get(p);
                if (at !== undefined && at <= v.line && (!best || at > best.line)) { best = { path: p, line: at }; }
            }
            return best?.path ?? null;
        });
    }

    /**
     * Every node path the document holds a value at or below, grouped by the
     * heading id its section renders with: a list item's stored id, else the
     * field's or its class's @SectionId (the rule the query engine uses).
     */
    private pathsByHeadingId(document: SpecDocument, root: SpecRoot): Map<string, string[]> {
        const json = document.toJson();
        const keys = new Set<string>();
        const addWithAncestors = (p: string): void => {
            const segs = specPathSegments(p);
            for (let i = 1; i <= segs.length; i++) { keys.add(segs.slice(0, i).join('/')); }
        };
        for (const store of [json.content, json.forms, json.headlines, json.codeSpecs]) {
            for (const k of Object.keys(store ?? {})) { addWithAncestors(k); }
        }
        for (const [listPath, list] of Object.entries(json.lists ?? {})) {
            addWithAncestors(listPath);
            for (const item of list.items) { addWithAncestors(item); }
        }
        const byId = new Map<string, string[]>();
        for (const p of keys) {
            const res = this.service.reflection.resolve(p);
            if (!res) { continue; }
            const id = res.kind === SpecNodeKind.LIST_ITEM_COMPLEX || res.kind === SpecNodeKind.LIST_ITEM_SCALAR
                ? document.itemSectionId(p)
                : res.kind === SpecNodeKind.ROOT ? root.sectionId : (res.field?.sectionId ?? res.targetClass?.sectionId ?? null);
            if (!id) { continue; }
            byId.set(id, [...(byId.get(id) ?? []), p]);
        }
        return byId;
    }
}

/**
 * The part of `document` at and below `path`, with the list entries that lead
 * to it, as a new document: rendering it gives that subtree's Markdown under
 * its ancestors' headings.
 */
export function subtreeOf(document: SpecDocument, path: string): SpecDocument {
    const json = document.toJson();
    const keep = (k: string): boolean => under(k, path);
    const pick = <T>(store: Record<string, T> | undefined): Record<string, T> =>
        Object.fromEntries(Object.entries(store ?? {}).filter(([k]) => keep(k)));
    const lists: NonNullable<typeof json.lists> = {};
    for (const [listPath, list] of Object.entries(json.lists ?? {})) {
        // A list inside the subtree is kept whole; a list on the way to it keeps only the item the path runs through.
        const items = keep(listPath) ? list.items : list.items.filter((item) => path === item || path.startsWith(`${item}/`));
        if (items.length === 0) { continue; }
        const ids = Object.fromEntries(Object.entries(list.ids ?? {}).filter(([item]) => items.includes(item)));
        lists[listPath] = { seq: list.seq, items, ...(Object.keys(ids).length > 0 ? { ids } : {}) };
    }
    const sub = new SpecDocument();
    sub.loadJson({
        content: pick(json.content),
        forms: pick(json.forms),
        lists,
        headlines: pick(json.headlines),
        codeSpecs: pick(json.codeSpecs),
    });
    return sub;
}
