/**
 * What the Markdown Browser needs from the TomSpecs runtime to write a review
 * comment (tom_specs annot1) into a SOM Markdown document the same way the
 * agents' tools do:
 *
 * - the next free comment id as the runtime's annotation API counts it
 *   (`SpecReviewAnnotations.nextCommentId`, annot2), so the browser and the
 *   agents never hand out different ids;
 * - the lines of every form's fields, where no comment may go: in a form's
 *   section a comment belongs in the preamble, above the first field
 *   (annot1, SOM §11.9 placement);
 * - every question's options and recommended letter as the runtime reads them
 *   (annot7), so the answer prefill and the options popup offer what the agents'
 *   tools read.
 *
 * The form lines come from the document's own rendition: `toMarkdownWithMap`
 * gives the document path behind every heading it renders. The file's headings
 * are matched to the rendition's in order, by level and section id, so a file
 * the import does not reproduce exactly (an extra blank line, a block it
 * rejected) still has a path for every heading the import understood, at the
 * file's own line. The meta tree gives the form behind a path, and the codec's
 * rules where its fields start: a `Field:` label at column 0, outside a fence,
 * naming one of the form's fields, or the header of a form or section table
 * (`| TomSpecField | Value |`, `| Section | TomSpecField | Value |`: the
 * runtime's `SpecDocumentMarkdown.layoutTableHeader`, SOM §11.4, §11.5). They
 * run to the next heading. A section table in a section whose own node has no
 * form (its children's single forms) covers its table lines. A heading is a
 * `#` line or a styled-div heading (`SpecDocumentMarkdown.headingDiv`).
 *
 * vscode-free.
 */

import { SpecDocumentMarkdown, SpecReviewAnnotations, type SomMetaNode } from 'tom_som_typescript_runtime';

import type { LoadedSomDocument } from './som-document-store';
import { documentTeam, readRevisionHistory, type RevisionRecord, type TeamMember } from './review-team';
import type { SomModelService } from './som-model-service';

export interface SomCommentContext {
    /** The number of the next free comment id (`C-<n>`), as the runtime counts the document's comments. */
    nextCommentNumber: number;
    /** 0-based `[first, end)` line ranges holding form fields; no comment is offered there. */
    formFieldRanges: Array<[number, number]>;
    /** Question id → its options and recommended letter; an id the document uses twice is left out. */
    questions: Record<string, SomQuestionReading>;
    /** The document's own review team (SOM §11.9.8), in order; [] when it names none. */
    team: TeamMember[];
    /** Its revision history with each round's team and reviewers, guests marked (CC-89, CC-90). */
    revisions: RevisionRecord[];
}

/** A question as the runtime reads it (tom_specs annot7). */
export interface SomQuestionReading {
    options: Array<{ letter: string; text: string; bold: boolean }>;
    /** The bold option, else the one saying "recommended", else a `*Recommendation:*` line's letter. */
    recommended: string | null;
}

/** The questions of `notes`, keyed by id; an id used twice is ambiguous and left out. */
function questionReadings(notes: SpecReviewAnnotations): Record<string, SomQuestionReading> {
    const out: Record<string, SomQuestionReading> = {};
    const seen = new Set<string>();
    for (const a of notes.list()) {
        if (a.kind !== 'question' || !a.id) { continue; }
        if (seen.has(a.id)) { delete out[a.id]; continue; }
        seen.add(a.id);
        out[a.id] = {
            options: a.options.map((o) => ({ letter: o.letter, text: o.text, bold: o.bold })),
            recommended: a.recommended,
        };
    }
    return out;
}

/** A form-field label line, as the SOM Markdown codec reads one. */
const FIELD_LABEL = /^([A-Za-z][A-Za-z0-9_]*):/;
const FENCE = /^ {0,3}(```|~~~)/;
/** Any heading line (SOM Markdown uses more than six levels): a `#` line or a styled-div heading. */
const HEADING_ANY = /^#+ /;
function isHeadingLine(line: string): boolean {
    return HEADING_ANY.test(line) || SpecDocumentMarkdown.headingDiv(line) !== null;
}
/** The header line of a form or section table (the runtime's rule). */
function isLayoutTableHeader(line: string): boolean {
    SpecDocumentMarkdown.layoutTableHeader.lastIndex = 0;
    return SpecDocumentMarkdown.layoutTableHeader.test(line);
}
/** The end (exclusive) of the table whose header is line `start`: the first line after it that is no table row. */
function tableEnd(lines: string[], start: number, limit: number): number {
    let i = start + 1;
    while (i < limit && /^\s*\|/.test(lines[i])) { i++; }
    return i;
}

/** The lower-cased field names whose labels may appear in the body of `node`'s section. */
function bodyFieldNames(node: SomMetaNode): Set<string> {
    const names = new Set<string>();
    const add = (n: SomMetaNode): void => {
        for (const f of n.form?.fields ?? []) { names.add(f.name.toLowerCase()); }
    };
    add(node);
    // Forms without a section id of their own are written into their owner's body.
    for (const c of node.children) {
        if (c.form && (c.sectionId === null || c.sectionId === undefined)) { add(c); }
    }
    return names;
}

/** A heading line of SOM Markdown: its level and section id. */
const ID_HEADING = /^(#+) <!--\[([^\]\s]+)\]/;
/** A heading line's key, `<level> <id>`, a `#` line's or a styled-div heading's; '' when it has no id. */
function headingKey(line: string): string {
    const m = ID_HEADING.exec(line);
    if (m) { return `${m[1].length} ${m[2]}`; }
    const div = SpecDocumentMarkdown.headingDiv(line);
    const id = div ? /^\s*<!--\[([^\]\s]+)\]/.exec(div[1]) : null;
    return div && id ? `${div[0]} ${id[1]}` : '';
}

/** The file's heading lines (0-based) with the document path the rendition gives them, matched in order by level and id. */
function headingPaths(fileLines: string[], rendition: { markdown: string; headingPaths: Map<number, string> }): Array<[number, string]> {
    const rendered = rendition.markdown.split('\n');
    const targets = [...rendition.headingPaths.entries()]
        .sort((a, b) => a[0] - b[0])
        .map(([line, p]) => ({ key: headingKey(rendered[line - 1] ?? ''), path: p }));
    const out: Array<[number, string]> = [];
    let next = 0;
    let inFence = false;
    for (let i = 0; i < fileLines.length; i++) {
        if (FENCE.test(fileLines[i])) { inFence = !inFence; continue; }
        const key = inFence ? '' : headingKey(fileLines[i]);
        if (!key) { continue; }
        for (let k = next; k < targets.length; k++) {
            if (targets[k].key === key) {
                out.push([i, targets[k].path]);
                next = k + 1;
                break;
            }
        }
    }
    return out;
}

/** The context for `loaded`; a YAML document has no form-field lines. */
export function somCommentContext(loaded: LoadedSomDocument, service: SomModelService): SomCommentContext {
    const notes = new SpecReviewAnnotations(loaded.document);
    const nextId = notes.nextCommentId();
    const rootId = loaded.root.sectionId ?? '';
    const context: SomCommentContext = {
        nextCommentNumber: Number(nextId.slice(2)), formFieldRanges: [], questions: questionReadings(notes),
        team: rootId ? documentTeam(loaded.document, rootId) : [],
        revisions: rootId ? readRevisionHistory(service.model, loaded.document, rootId) : [],
    };
    if (loaded.format !== 'markdown') { return context; }
    const tree = service.metaTree(loaded.root.type);
    const lines = loaded.text.split('\n');
    // Every heading line of the file, matched or not, ends the section above it.
    const allHeadings: number[] = [];
    let inFence = false;
    for (let i = 0; i < lines.length; i++) {
        if (FENCE.test(lines[i])) { inFence = !inFence; continue; }
        if (!inFence && isHeadingLine(lines[i])) { allHeadings.push(i); }
    }
    const sectionEnd = (start: number): number => allHeadings.find((h) => h > start) ?? lines.length;
    for (const [start, docPath] of headingPaths(lines, loaded.document.toMarkdownWithMap(service.model, loaded.root.type))) {
        const node = tree.byPath(docPath);
        if (!node) { continue; }
        const fields = bodyFieldNames(node);
        const end = sectionEnd(start);
        let fenced = false;
        for (let i = start + 1; i < end; i++) {
            if (FENCE.test(lines[i])) { fenced = !fenced; continue; }
            if (fenced) { continue; }
            if (isLayoutTableHeader(lines[i])) {
                // A form of the section: its fields run to the next heading; a section table only (the
                // children's forms) is its own lines.
                context.formFieldRanges.push([i, fields.size > 0 ? end : tableEnd(lines, i, end)]);
                if (fields.size > 0) { break; }
                continue;
            }
            const m = fields.size > 0 ? FIELD_LABEL.exec(lines[i]) : null;
            if (m && fields.has(m[1].toLowerCase())) {
                context.formFieldRanges.push([i, end]);
                break;
            }
        }
    }
    return context;
}
