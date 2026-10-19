/**
 * Plain DocSpecs Markdown — documents that are not SOM specs but declare a
 * DocSpecs schema (`<!-- docspec: <id>/<version> -->`): resolving the schema,
 * and the outline / section views the agent tools return.
 *
 * Parsing, validation and the section replace are the runtime's
 * (DocSpecsDocument, DocSpecsSchema, DocSpecsValidator); this module only
 * finds the schema file and shapes the answers.
 *
 * Schema resolution, first match wins:
 *   1. an explicit `schema` argument: `<id>/<version>` or a path to a
 *      `*.docspecs-schema.yaml`;
 *   2. `.tom/docspecs-schema/<id>/<id>.<version>.docspecs-schema.yaml` — or in
 *      a suffixed folder `<id>.<suffix>/` (`schema-test.sct/`) — in the
 *      document's folder or the nearest folder above it, up to the
 *      workspace root;
 *   3. the schemas generated from the SOM model (a SOM document's Markdown
 *      rendition declares one of those).
 * A declared schema found nowhere is a finding (`unknownSchema`), never a
 * silent pass. `docspec: none` declares that the document has no schema.
 *
 * The runtime reads the DocSpecs form whose headings carry `<!--[ID]-->` and
 * whose first line is `<!-- docspec: id/version -->`. The legacy form —
 * `# [id] Title` headings, a `<!-- schema=name-1.0 -->` field — and a
 * declaration written below the title are not read; the answers then carry a
 * migration hint naming `_bin/migrate_docspecs.py`, and a late declaration is
 * a `headerNotFirst` finding (as `_bin/check_docspecs_documents.py` reports it).
 *
 * vscode-free.
 */

import * as fs from 'fs';
import * as path from 'path';
import { DocSpecsDocument, DocSpecsSchema, DocSpecsValidator } from 'tom_som_typescript_runtime';
import type { DocSpecsSection, DocSpecsViolation } from 'tom_som_typescript_runtime';

import { SomModelService } from './som-model-service';

export const SCHEMA_DIR = path.join('.tom', 'docspecs-schema');

export interface ResolvedDocSpecsSchema {
    /** `<id>/<version>` as declared or given. */
    ref: string;
    source: 'argument' | 'workspace' | 'generated';
    /** The schema file, for argument and workspace schemas. */
    file?: string;
    schema: DocSpecsSchema;
    /** Keys the runtime does not support and ignored: constraints that are NOT checked. */
    warnings: string[];
}

export interface SchemaLookup {
    /** The schema reference the document declares, `none`, or null when it declares nothing. */
    declared: string | null;
    resolved: ResolvedDocSpecsSchema | null;
    /** Where a declared schema was looked for, when it was not found. */
    searched?: string[];
}

export interface DocSpecsFinding {
    rule: string;
    line: number;
    sectionId: string | null;
    message: string;
}

export interface DocSpecsOutlineEntry {
    id: string | null;
    title: string;
    level: number;
    /** First line of the section (its heading) and last line of its whole subtree, 1-based. */
    line: number;
    endLine: number;
    /** Characters in the section's own body (excluding subsections). */
    textLength: number;
    children: string[];
}

const LEGACY_HEADING = /^#{1,} \[[^\]\s]+\] /m;
const LEGACY_SCHEMA_FIELD = /<!--\s*schema=/;
const DECLARATION = /^<!--\s*docspec:\s*(\S+?)\s*-->$/;

/** The workspace command that converts a document to the current DocSpecs form. */
export function migrationCommand(file: string): string {
    return `_bin/migrate_docspecs.py doc ${file} --assign-ids --write`;
}

/**
 * A schema declaration written just below the title — the first non-blank
 * line a heading, the second the declaration — with its schema reference and
 * 1-based line. No runtime reads it there: they look only before the first
 * heading. Null otherwise (the rule `_bin/check_docspecs_documents.py` applies).
 */
export function lateDeclaration(text: string): { ref: string; line: number } | null {
    const nonblank = text.split('\n').map((l, i) => ({ text: l.trim(), line: i + 1 })).filter((l) => l.text !== '');
    if (nonblank.length < 2 || !nonblank[0].text.startsWith('#') || DECLARATION.test(nonblank[0].text)) { return null; }
    const m = DECLARATION.exec(nonblank[1].text);
    return m ? { ref: m[1], line: nonblank[1].line } : null;
}

/**
 * A migration hint when the document is in a form the runtime does not read:
 * the legacy form (bracket ids, a `schema=` field) with no `<!--[ID]-->` id on
 * any heading — so every heading reads as malformed — or a declaration below
 * the title. Names the command that converts it; null for a current document.
 */
export function migrationHint(text: string, doc: DocSpecsDocument, file: string): string | null {
    const legacy = !doc.allSections.some((s) => s.id !== null)
        && (LEGACY_HEADING.test(text) || LEGACY_SCHEMA_FIELD.test(text));
    const late = doc.declaredSchema === null ? lateDeclaration(text) : null;
    if (!legacy && !late) { return null; }
    const problems: string[] = [];
    if (legacy) {
        problems.push('it is in the legacy DocSpecs form (`# [id] Title` headings or a `<!-- schema=name-1.0 -->` field), '
            + 'which the runtime does not read: its sections have no ids here and every heading reports as malformed');
    }
    if (late) {
        problems.push(`its schema declaration (line ${late.line}) sits below the title, where no runtime reads it`);
    }
    return `This document cannot be read as current DocSpecs: ${problems.join('; and ')}. The current form has `
        + '`<!-- docspec: <id>/<version> -->` on its first line and `<!--[ID]-->` ids on its headings. '
        + `Migrate it with \`${migrationCommand(file)}\`.`;
}

/** Parse `<id>/<version>`; null when the text is not of that shape. */
function splitRef(ref: string): { id: string; version: string } | null {
    const m = /^([^/\s]+)\/(\S+)$/.exec(ref.trim());
    return m ? { id: m[1], version: m[2] } : null;
}

function load(text: string): { schema: DocSpecsSchema; warnings: string[] } {
    const schema = DocSpecsSchema.fromYamlText(text);
    return { schema, warnings: [...schema.warnings] };
}

/**
 * The schema for a document at `filePath`, from `override` or the document's
 * declaration. `wsRoot` bounds the walk up for `.tom/docspecs-schema/`.
 */
export function resolveDocSpecsSchema(
    service: SomModelService,
    filePath: string,
    declared: string | null,
    wsRoot: string,
    override?: string,
): SchemaLookup {
    if (override) {
        if (override.endsWith('.docspecs-schema.yaml')) {
            const file = path.isAbsolute(override) ? override : path.join(wsRoot, override);
            if (!fs.existsSync(file)) { return { declared, resolved: null, searched: [file] }; }
            return { declared, resolved: { ref: override, source: 'argument', file, ...load(fs.readFileSync(file, 'utf8')) } };
        }
        return { ...resolveRef(service, filePath, override, wsRoot), declared };
    }
    if (!declared || declared === 'none') { return { declared, resolved: null }; }
    return { ...resolveRef(service, filePath, declared, wsRoot), declared };
}

function resolveRef(service: SomModelService, filePath: string, ref: string, wsRoot: string): Omit<SchemaLookup, 'declared'> {
    const parts = splitRef(ref);
    if (!parts) { return { resolved: null, searched: [] }; }
    const searched: string[] = [];
    const root = path.resolve(wsRoot || path.parse(filePath).root);
    let dir = path.dirname(path.resolve(filePath));
    const fileName = `${parts.id}.${parts.version}.docspecs-schema.yaml`;
    for (;;) {
        const schemaDir = path.join(dir, SCHEMA_DIR);
        // The folder is named after the id, or carries a suffix (`schema-test.sct/`).
        const suffixed = fs.existsSync(schemaDir)
            ? fs.readdirSync(schemaDir).filter((n) => n.startsWith(`${parts.id}.`)).sort().map((n) => path.join(schemaDir, n, fileName))
            : [];
        for (const candidate of [path.join(schemaDir, parts.id, fileName), ...suffixed]) {
            searched.push(candidate);
            if (fs.existsSync(candidate)) {
                return { resolved: { ref, source: 'workspace', file: candidate, ...load(fs.readFileSync(candidate, 'utf8')) } };
            }
        }
        if (dir === root || path.dirname(dir) === dir || !dir.startsWith(root)) { break; }
        dir = path.dirname(dir);
    }
    if (service.schemaIds.includes(parts.id)) {
        return { resolved: { ref, source: 'generated', schema: service.schema(parts.id), warnings: [] } };
    }
    searched.push(`the schemas generated from the SOM model (${parts.id} is not one)`);
    return { resolved: null, searched };
}

/**
 * Validate `text` against the resolved schema, adding a finding for a declared
 * schema that was not found, for a declaration below the title, or for none.
 * `file` (workspace-relative) is named in the migration command.
 */
export function validateDocSpecs(text: string, lookup: SchemaLookup, file: string): { findings: DocSpecsFinding[]; parsed: DocSpecsDocument } {
    const parsed = DocSpecsDocument.parse(text);
    const toFinding = (v: DocSpecsViolation): DocSpecsFinding => ({ rule: v.rule, line: v.line, sectionId: v.sectionId, message: v.message });
    if (lookup.resolved) {
        return { findings: new DocSpecsValidator(lookup.resolved.schema).validateMarkdown(text).map(toFinding), parsed };
    }
    const findings = parsed.violations.map(toFinding);
    const headerLine = text.split('\n').findIndex((l) => /<!--\s*docspec:/.test(l)) + 1;
    if (lookup.declared && lookup.declared !== 'none') {
        findings.unshift({
            rule: 'unknownSchema',
            line: headerLine || 1,
            sectionId: null,
            message: `The document declares schema ${lookup.declared}, which was not found (looked in: ${(lookup.searched ?? []).join('; ') || 'nowhere — not an <id>/<version> reference'}).`,
        });
    } else if (!lookup.declared && lateDeclaration(text)) {
        const late = lateDeclaration(text) as { ref: string; line: number };
        findings.unshift({
            rule: 'headerNotFirst',
            line: late.line,
            sectionId: null,
            message: `The schema declaration (${late.ref}) sits below the title, where no runtime reads it, so the document `
                + `was checked without a schema. Move it to the first line — \`${migrationCommand(file)}\` does that and adds heading ids.`,
        });
    } else if (!lookup.declared) {
        findings.unshift({
            rule: 'noSchemaDeclared',
            line: 1,
            sectionId: null,
            message: 'The document declares no schema (`<!-- docspec: <id>/<version> -->`), so only its structure was checked. Pass `schema` to check it against one.',
        });
    }
    return { findings, parsed };
}

/** The section tree, flat in document order, with each subtree's line range. */
export function outlineOf(parsed: DocSpecsDocument, lineCount: number): DocSpecsOutlineEntry[] {
    const all = parsed.allSections;
    return all.map((s, i) => {
        const next = all.slice(i + 1).find((o) => o.level <= s.level);
        return {
            id: s.id,
            title: s.title,
            level: s.level,
            line: s.line,
            endLine: next ? next.line - 1 : lineCount,
            textLength: s.text.length,
            children: s.children.map((c) => c.id ?? c.title),
        };
    });
}

/** The section with `sectionId`, or why there is not exactly one. */
export function findSection(parsed: DocSpecsDocument, sectionId: string): DocSpecsSection | string {
    const hits = parsed.allSections.filter((s) => s.id === sectionId);
    if (hits.length === 1) { return hits[0]; }
    const ids = parsed.allSections.map((s) => s.id).filter((id): id is string => id !== null);
    return hits.length === 0
        ? `No section has id '${sectionId}'. Ids: ${ids.slice(0, 40).join(', ')}${ids.length > 40 ? ', …' : ''}.`
        : `${hits.length} sections have id '${sectionId}' (lines ${hits.map((h) => h.line).join(', ')}); a section id must be unique to be addressed.`;
}
