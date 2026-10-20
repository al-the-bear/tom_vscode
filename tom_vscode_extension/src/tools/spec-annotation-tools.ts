/**
 * TomSpecs (SOM) review-annotation tools — the questions, reviewer comments and
 * inline marks inside a document's content values (SOM §11.9), read and edited
 * through the runtime's SpecReviewAnnotations, never by parsing the Markdown
 * here:
 *
 *   tomAi_specAnnotations        list them (or those under a path), with counts and the marks revision
 *   tomAi_specInsertComment      a comment block after a paragraph
 *   tomAi_specInsertQuestion     a question block after a paragraph, or directly after a comment
 *   tomAi_specSetAnswer          write (or clear) a question's answer
 *   tomAi_specEditComment        replace a comment's text
 *   tomAi_specAssignCommentIds   give every comment without an id the next one
 *   tomAi_specResolveAnnotation  remove one comment or question once it has been applied
 *   tomAi_specDecideMarks        accept / reject inline marks, by id or all under a path
 *   tomAi_specRemoveAllAnnotations  every mark accepted, every comment and question removed
 *
 * The writers share the edit cycle of the other spec edit tools
 * (spec-edit-core.ts): revision check, read-only refusal, dry run with diff,
 * validation before and after. Each is also a batch op of tomAi_specApplyEdits
 * ({@link ANNOTATION_BATCH_OPS}). Reading a document without its annotations is
 * tomAi_specRender with `withoutAnnotations`.
 *
 * Positions inside a value are 0-based line numbers; paragraphs are the
 * blank-line separated blocks of the value (annotation blocks count; a blank
 * line inside fenced code does not end one).
 */

import {
    SpecMarkDecision,
    SpecNodeKind,
    SpecQuestionDraft,
    SpecReviewAnnotations,
    type SpecMarkDecisionValue,
    type SpecReviewAnnotation,
} from 'tom_som_typescript_runtime';

import { SharedToolDefinition } from './shared-tool-registry';
import { FILE_PARAM, FIRST_LOOK, PATH_PARAM_HINT, SpecToolDeps, documentHeader, failure, json, liveDeps, loadDocument } from './spec-tool-common';
import {
    EDIT_PARAMS,
    RESULT_NOTE,
    SpecEditRefusal,
    VALUE_LEAVES,
    editTool,
    requireKind,
    runEdit,
    type EditContext,
    type OpInput,
    type OpOutcome,
    type SpecEditOptions,
} from './spec-edit-core';
import { SomSpecInspector } from '../services/som-spec-inspector';
import { findSpecDocuments } from './spec-tools';
import type { LoadedSomDocument } from '../services/som-document-store';

// ---------------------------------------------------------------------------
// Inputs
// ---------------------------------------------------------------------------

export type AnnotationKind = 'comment' | 'question' | 'mark';

export interface SpecAnnotationsInput {
    /** One document: its annotations listed. Or pass `dir`. */
    file?: string;
    /** A folder: the counts of every SOM document under it, no lists. */
    dir?: string;
    /** With `dir`: at most this many documents (default 200, max 2000). */
    maxResults?: number;
    /** With `dir`: how long the search and the reading may take, in ms (default 10 s, max 120 s). */
    timeBudgetMs?: number;
    /** Only the annotations at or below this path. */
    path?: string;
    kinds?: AnnotationKind[];
    /** Questions without an answer only. */
    openOnly?: boolean;
    /** At most this many of each kind (default 200). */
    limit?: number;
}

/** Where an annotation goes: a content value, or a form field's value. */
interface ValueTarget {
    path: string;
    field?: string;
}

/**
 * Where in a value an annotation goes: after paragraph `afterParagraph`, or
 * after the paragraph a text anchor names — exactly one of the three.
 */
interface ParagraphAnchor {
    afterParagraph?: number;
    /** The paragraph that begins with this text (both trimmed, case-sensitive). */
    afterTextStart?: string;
    /** The paragraph that contains this text. */
    afterTextContains?: string;
}

export interface SpecInsertCommentInput extends SpecEditOptions, ValueTarget, ParagraphAnchor {
    text: string;
    author?: string;
    id?: string;
}

export interface SpecQuestionInput {
    id: string;
    topic: string;
    text: string;
    options?: string[];
    recommended?: string;
    recommendation?: string;
    assumption?: string;
    starred?: boolean;
}

export interface SpecInsertQuestionInput extends SpecEditOptions, ParagraphAnchor {
    question: SpecQuestionInput;
    afterComment?: string;
    path?: string;
    field?: string;
}

export interface SpecSetAnswerInput extends SpecEditOptions {
    questionId: string;
    answer: string;
}

export interface SpecEditCommentInput extends SpecEditOptions {
    commentId: string;
    text: string;
}

export interface SpecAssignCommentIdsInput extends SpecEditOptions {
    floor?: number;
}

export interface SpecResolveAnnotationInput extends SpecEditOptions {
    id: string;
}

export interface SpecDecideMarksInput extends SpecEditOptions {
    decisions?: Record<string, string>;
    all?: 'accept' | 'reject';
    path?: string;
    marksRevision?: string;
}

export type SpecRemoveAllAnnotationsInput = SpecEditOptions;

// ---------------------------------------------------------------------------
// Shared
// ---------------------------------------------------------------------------

const DEFAULT_LIMIT = 200;

/** The document's root id qualifies a comment id cited outside it (`SBP C-12`). */
function annotationsOf(document: LoadedSomDocument['document'], loaded: LoadedSomDocument): SpecReviewAnnotations {
    return new SpecReviewAnnotations(document, { qualifier: loaded.root.sectionId ?? null });
}

function notesOf(ctx: EditContext): SpecReviewAnnotations {
    return annotationsOf(ctx.loaded.document, ctx.loaded);
}

function invalid(message: string): never {
    throw new SpecEditRefusal('invalidInput', message);
}

function requireText(value: unknown, name: string): string {
    if (typeof value !== 'string' || value.trim() === '') { invalid(`\`${name}\` must be a non-empty string.`); }
    return value as string;
}

function requireParagraph(value: unknown): number {
    if (!Number.isInteger(value) || (value as number) < -1) { invalid('`afterParagraph` must be a whole number, -1 for the start of the value.'); }
    return value as number;
}

/** How long a candidate's text is quoted when an anchor is refused. */
const CANDIDATE_EXCERPT = 80;

const hasAnchor = (a: ParagraphAnchor): boolean =>
    a.afterParagraph !== undefined || a.afterTextStart !== undefined || a.afterTextContains !== undefined;

/**
 * The paragraph index an annotation goes after: `afterParagraph` as given, or
 * the one paragraph a text anchor names, looked up in the runtime's paragraph
 * listing — the same paragraphs `afterParagraph` counts — without the
 * annotation blocks, which are not the text an anchor means.
 */
function resolveParagraph(notes: SpecReviewAnnotations, target: ValueTarget, anchor: ParagraphAnchor): number {
    const given = [anchor.afterParagraph, anchor.afterTextStart, anchor.afterTextContains].filter((a) => a !== undefined).length;
    if (given !== 1) {
        invalid('Say where it goes with exactly one of `afterParagraph` (a number), `afterTextStart` or `afterTextContains` (text of the paragraph).');
    }
    if (anchor.afterParagraph !== undefined) { return requireParagraph(anchor.afterParagraph); }
    const byStart = anchor.afterTextStart !== undefined;
    const needle = requireText(byStart ? anchor.afterTextStart : anchor.afterTextContains, byStart ? 'afterTextStart' : 'afterTextContains');
    const paragraphs = notes.paragraphs({ path: target.path, field: target.field || null }).filter((p) => p.annotation === null);
    const matches = paragraphs.filter((p) => (byStart ? p.text.trim().startsWith(needle.trim()) : p.text.includes(needle)));
    const excerpt = (text: string): string => {
        const flat = text.replace(/\s+/g, ' ').trim();
        return flat.length > CANDIDATE_EXCERPT ? `${flat.slice(0, CANDIDATE_EXCERPT)}…` : flat;
    };
    const how = byStart ? 'begins with' : 'contains';
    if (matches.length === 0) {
        throw new SpecEditRefusal('anchorNotFound', `No paragraph of the value ${how} "${needle}" (annotation blocks are not counted).`, {
            paragraphs: paragraphs.map((p) => ({ index: p.index, text: excerpt(p.text) })),
        });
    }
    if (matches.length > 1) {
        throw new SpecEditRefusal('anchorAmbiguous', `${matches.length} paragraphs ${how} "${needle}"; name one by more of its text, or by \`afterParagraph\`.`, {
            candidates: matches.map((p) => ({ index: p.index, text: excerpt(p.text) })),
        });
    }
    return matches[0].index;
}

/** The value an annotation goes into must exist: a content / scalar leaf, or a field of a form. */
function requireValue(ctx: EditContext, target: ValueTarget): void {
    const res = ctx.inspector.resolve(target.path);
    if (target.field === undefined || target.field === null || target.field === '') {
        requireKind(res, target.path, VALUE_LEAVES, 'a content value (name a form with `field` for a form field)');
        return;
    }
    requireKind(res, target.path, [SpecNodeKind.FORM], 'a form');
    const fields = ctx.editor.formFields(target.path).map((f) => f.name);
    if (!fields.includes(target.field)) {
        throw new SpecEditRefusal('unknownField', `'${target.field}' is not a field of the form at ${target.path}.`, { fields });
    }
}

/** Where the annotation with this id is (a comment's qualified id matches too); null when it is not there. */
function locate(notes: SpecReviewAnnotations, id: string): SpecReviewAnnotation | null {
    return notes.list().find((a) => a.id === id || a.qualifiedId === id) ?? null;
}

function countsOf(notes: SpecReviewAnnotations): Record<string, number> {
    return notes.counts().toJson();
}

function commentView(a: SpecReviewAnnotation): Record<string, unknown> {
    return { id: a.id, qualifiedId: a.qualifiedId, author: a.author, text: a.text, context: a.context, path: a.path, field: a.field, line: a.line };
}

function questionView(a: SpecReviewAnnotation): Record<string, unknown> {
    return {
        id: a.id, topic: a.topic, text: a.text,
        options: a.options.map((o) => ({ letter: o.letter, text: o.text, bold: o.bold })),
        recommended: a.recommended, answer: a.answer, answerLetter: a.answerLetter, open: a.open,
        starred: a.starred, combined: a.combined, path: a.path, field: a.field, line: a.line,
    };
}

// ---------------------------------------------------------------------------
// Reading
// ---------------------------------------------------------------------------

/** The annotation counts of one loaded document. */
function annotationCounts(notes: SpecReviewAnnotations): { questions: number; openQuestions: number; answeredQuestions: number; comments: number; marks: number } {
    const all = notes.list();
    const questions = all.filter((a) => a.kind === 'question');
    return {
        questions: questions.length,
        openQuestions: questions.filter((q) => q.open).length,
        answeredQuestions: questions.filter((q) => !q.open).length,
        comments: all.filter((a) => a.kind === 'comment').length,
        marks: all.filter((a) => a.kind === 'mark').length,
    };
}

/** The `dir` form: per document under the folder, its counts and its annotation findings; and the totals. */
async function annotationsAcrossFolder(deps: SpecToolDeps, input: SpecAnnotationsInput): Promise<string> {
    const found = await findSpecDocuments(deps, input);
    const documents: Record<string, unknown>[] = [];
    let stoppedBy: string | null = found.stoppedBy;
    const totals = { documents: 0, withAnnotations: 0, questions: 0, openQuestions: 0, answeredQuestions: 0, comments: 0, marks: 0, findings: 0 };
    for (const doc of found.documents) {
        if (Date.now() > found.deadline) { stoppedBy = 'time'; break; }
        const file = String(doc.file);
        try {
            const loaded = loadDocument(deps, file);
            const notes = annotationsOf(loaded.document, loaded);
            const counts = annotationCounts(notes);
            const findings = notes.validate().length;
            documents.push({ file, root: loaded.root.sectionId ?? loaded.root.type, counts, findings });
            totals.documents++;
            if (counts.questions + counts.comments + counts.marks > 0) { totals.withAnnotations++; }
            for (const k of ['questions', 'openQuestions', 'answeredQuestions', 'comments', 'marks'] as const) { totals[k] += counts[k]; }
            totals.findings += findings;
        } catch (e) {
            documents.push({ file, error: (e as Error).message });
        }
    }
    return json({
        ok: true,
        searched: found.searched,
        search: found.search,
        documents,
        totals,
        ...(stoppedBy ? { truncated: true, stoppedBy } : {}),
    });
}

export async function specAnnotationsImpl(deps: SpecToolDeps, input: SpecAnnotationsInput): Promise<string> {
    try {
        if ((input.file && input.dir) || (!input.file && !input.dir)) {
            return json({ ok: false, code: 'invalidInput', error: 'Pass `file` (one document, its annotations listed) or `dir` (a folder, counts per document), not both.' });
        }
        if (input.dir) { return await annotationsAcrossFolder(deps, input); }
        const loaded = loadDocument(deps, input.file as string);
        const scope = input.path || null;
        if (scope) { new SomSpecInspector(deps.service, loaded.document).resolve(scope); }
        const inScope = (p: string): boolean => !scope || p === scope || p.startsWith(`${scope}/`);
        const notes = annotationsOf(loaded.document, loaded);
        const all = notes.list().filter((a) => inScope(a.path));
        const questions = all.filter((a) => a.kind === 'question');
        const counts = {
            questions: questions.length,
            openQuestions: questions.filter((q) => q.open).length,
            answeredQuestions: questions.filter((q) => !q.open).length,
            comments: all.filter((a) => a.kind === 'comment').length,
            marks: all.filter((a) => a.kind === 'mark').length,
        };
        const kinds = new Set<AnnotationKind>(input.kinds && input.kinds.length ? input.kinds : ['comment', 'question', 'mark']);
        const limit = input.limit && input.limit > 0 ? input.limit : DEFAULT_LIMIT;
        const comments = kinds.has('comment') ? all.filter((a) => a.kind === 'comment').map(commentView) : [];
        const shownQuestions = kinds.has('question') ? questions.filter((q) => !input.openOnly || q.open).map(questionView) : [];
        const marks = kinds.has('mark') ? notes.listMarks({ path: scope }).map((m) => m.toJson()) : [];
        const truncated = [comments, shownQuestions, marks].some((l) => l.length > limit);
        const findings = notes.validate().filter((e) => inScope(e.path)).map((e) => ({ path: e.path, code: e.code, message: e.message }));
        return json({
            ok: true,
            document: documentHeader(deps, loaded),
            ...(scope ? { path: scope } : {}),
            counts,
            marksRevision: notes.revision(),
            comments: comments.slice(0, limit),
            questions: shownQuestions.slice(0, limit),
            marks: marks.slice(0, limit),
            findings,
            ...(truncated ? { truncated: true } : {}),
        });
    } catch (e) {
        return failure(e);
    }
}

// ---------------------------------------------------------------------------
// The operations — single tools and batch ops alike
// ---------------------------------------------------------------------------

function opInsertComment(_deps: SpecToolDeps, ctx: EditContext, input: OpInput<SpecInsertCommentInput>): OpOutcome {
    requireValue(ctx, input);
    const notes = notesOf(ctx);
    const id = notes.insertComment({
        path: input.path,
        field: input.field || null,
        afterParagraph: resolveParagraph(notes, input, input),
        text: requireText(input.text, 'text'),
        author: input.author || null,
        id: input.id || null,
    });
    return { touched: input.path, result: { id, path: input.path, counts: countsOf(notes) } };
}

function draftOf(q: SpecQuestionInput | undefined): SpecQuestionDraft {
    if (!q || typeof q !== 'object') { invalid('`question` is required: {id, topic, text, options?, recommended?, …}.'); }
    return new SpecQuestionDraft({
        id: requireText(q.id, 'question.id'),
        topic: requireText(q.topic, 'question.topic'),
        text: requireText(q.text, 'question.text'),
        options: Array.isArray(q.options) ? q.options.map(String) : [],
        recommendation: q.recommendation ?? '',
        assumption: q.assumption ?? '',
        starred: q.starred === true,
        recommended: q.recommended || null,
    });
}

function opInsertQuestion(_deps: SpecToolDeps, ctx: EditContext, input: OpInput<SpecInsertQuestionInput>): OpOutcome {
    const draft = draftOf(input.question);
    const notes = notesOf(ctx);
    if (input.afterComment) {
        const comment = locate(notes, input.afterComment);
        notes.insertQuestionAfterComment(input.afterComment, draft);
        const where = comment?.path ?? '';
        return { touched: where, result: { id: draft.id, path: where, counts: countsOf(notes) } };
    }
    if (!input.path || !hasAnchor(input)) {
        invalid('Say where the question goes: `afterComment` (a comment id), or `path` with `afterParagraph`, `afterTextStart` or `afterTextContains`.');
    }
    requireValue(ctx, { path: input.path, field: input.field });
    const afterParagraph = resolveParagraph(notes, { path: input.path, field: input.field }, input);
    notes.insertQuestion({ path: input.path, field: input.field || null, afterParagraph, question: draft });
    return { touched: input.path, result: { id: draft.id, path: input.path, counts: countsOf(notes) } };
}

function opSetAnswer(_deps: SpecToolDeps, ctx: EditContext, input: OpInput<SpecSetAnswerInput>): OpOutcome {
    const notes = notesOf(ctx);
    const id = requireText(input.questionId, 'questionId');
    if (typeof input.answer !== 'string') { invalid('`answer` must be a string; "" reopens the question.'); }
    const where = locate(notes, id)?.path ?? '';
    notes.setAnswer(id, input.answer);
    return { touched: where, result: { questionId: id, path: where, counts: countsOf(notes) } };
}

function opEditComment(_deps: SpecToolDeps, ctx: EditContext, input: OpInput<SpecEditCommentInput>): OpOutcome {
    const notes = notesOf(ctx);
    const id = requireText(input.commentId, 'commentId');
    const text = requireText(input.text, 'text');
    const where = locate(notes, id)?.path ?? '';
    notes.editComment(id, text);
    return { touched: where, result: { commentId: id, path: where } };
}

function opAssignCommentIds(_deps: SpecToolDeps, ctx: EditContext, input: OpInput<SpecAssignCommentIdsInput>): OpOutcome {
    const notes = notesOf(ctx);
    const unnamed = notes.list().filter((a) => a.kind === 'comment' && !a.id).map((a) => a.path);
    const assigned = notes.assignCommentIds(input.floor !== undefined ? { floor: input.floor } : {});
    return { touched: [...new Set(unnamed)], result: { assigned } };
}

function opResolveAnnotation(_deps: SpecToolDeps, ctx: EditContext, input: OpInput<SpecResolveAnnotationInput>): OpOutcome {
    const notes = notesOf(ctx);
    const id = requireText(input.id, 'id');
    const found = locate(notes, id);
    notes.resolve(id);
    return { touched: found?.path ?? '', result: { resolved: id, kind: found?.kind ?? null, path: found?.path ?? null, counts: countsOf(notes) } };
}

const DECISIONS: readonly string[] = [SpecMarkDecision.ACCEPT, SpecMarkDecision.REJECT, SpecMarkDecision.LEAVE];

function opDecideMarks(_deps: SpecToolDeps, ctx: EditContext, input: OpInput<SpecDecideMarksInput>): OpOutcome {
    const notes = notesOf(ctx);
    if (input.path) { ctx.inspector.resolve(input.path); }
    let report;
    if (input.all !== undefined) {
        if (input.all !== 'accept' && input.all !== 'reject') { invalid('`all` is "accept" or "reject".'); }
        if (input.decisions) { invalid('Give `decisions` or `all`, not both.'); }
        const scope = { path: input.path || null };
        report = input.all === 'accept' ? notes.acceptAllMarks(scope) : notes.rejectAllMarks(scope);
    } else {
        const entries = input.decisions && typeof input.decisions === 'object' ? Object.entries(input.decisions) : [];
        if (entries.length === 0) { invalid('Give `decisions` ({"M-2": "accept", …}) or `all` ("accept" / "reject").'); }
        for (const [id, decision] of entries) {
            if (!DECISIONS.includes(decision)) { invalid(`Mark ${id}: "${decision}" is not accept, reject or leave.`); }
        }
        report = notes.decideMarks(Object.fromEntries(entries) as Record<string, SpecMarkDecisionValue>, { revision: input.marksRevision || notes.revision() });
    }
    const touched = [...new Set(report.applied.map((a) => a.path))];
    return { touched: touched.length ? touched : (input.path || ''), result: { ...report.toJson(), marksRevision: notes.revision(), counts: countsOf(notes) } };
}

/**
 * Remove every annotation of the document (SpecReviewAnnotations.removeAllAnnotations):
 * every inline mark accepted, every comment and question block removed. The
 * runtime works on the whole document. Answers what was removed — the counts
 * before — and the marks it accepted; malformed marks stay and are reported.
 */
function opRemoveAllAnnotations(_deps: SpecToolDeps, ctx: EditContext, _input: OpInput<SpecRemoveAllAnnotationsInput>): OpOutcome {
    const notes = notesOf(ctx);
    const before = notes.list();
    const questions = before.filter((a) => a.kind === 'question');
    const removed = {
        comments: before.filter((a) => a.kind === 'comment').length,
        questions: questions.length,
        openQuestions: questions.filter((q) => q.open).length,
        marks: before.filter((a) => a.kind === 'mark').length,
    };
    const report = notes.removeAllAnnotations();
    const touched = [...new Set(before.map((a) => a.path))];
    return { touched, result: { removed, ...report.toJson(), counts: countsOf(notes) } };
}

/**
 * Write `text` at `path` / `field` as a marked change against the value there
 * now (SpecReviewAnnotations.setMarked, SOM §11.9.3): a reviewer accepting
 * every mark gets `text`, rejecting every mark the value as it was. A value
 * that already holds marks is compared from its original, so editing a passage
 * again updates its mark. Only text takes marks: the caller has checked the
 * target is a text value. Answers whether the marks reproduce both versions
 * exactly (false when a difference sits in fenced code or the text holds mark
 * delimiters — the new value is then written unmarked).
 */
export function writeMarked(ctx: EditContext, path: string, field: string | null, text: string): { exact: boolean } {
    const change = notesOf(ctx).setMarked({ path, field, text });
    return { exact: change.exact };
}

/** The annotation operations tomAi_specApplyEdits runs, with the single tools' arguments. */
export const ANNOTATION_BATCH_OPS: Record<string, (deps: SpecToolDeps, ctx: EditContext, input: never) => OpOutcome> = {
    insertComment: opInsertComment,
    insertQuestion: opInsertQuestion,
    setAnswer: opSetAnswer,
    editComment: opEditComment,
    assignCommentIds: opAssignCommentIds,
    resolveAnnotation: opResolveAnnotation,
    decideMarks: opDecideMarks,
    removeAllAnnotations: opRemoveAllAnnotations,
};

export async function specInsertCommentImpl(deps: SpecToolDeps, input: SpecInsertCommentInput): Promise<string> {
    return runEdit(deps, input, (ctx) => opInsertComment(deps, ctx, input));
}
export async function specInsertQuestionImpl(deps: SpecToolDeps, input: SpecInsertQuestionInput): Promise<string> {
    return runEdit(deps, input, (ctx) => opInsertQuestion(deps, ctx, input));
}
export async function specSetAnswerImpl(deps: SpecToolDeps, input: SpecSetAnswerInput): Promise<string> {
    return runEdit(deps, input, (ctx) => opSetAnswer(deps, ctx, input));
}
export async function specEditCommentImpl(deps: SpecToolDeps, input: SpecEditCommentInput): Promise<string> {
    return runEdit(deps, input, (ctx) => opEditComment(deps, ctx, input));
}
export async function specAssignCommentIdsImpl(deps: SpecToolDeps, input: SpecAssignCommentIdsInput): Promise<string> {
    return runEdit(deps, input, (ctx) => opAssignCommentIds(deps, ctx, input));
}
export async function specResolveAnnotationImpl(deps: SpecToolDeps, input: SpecResolveAnnotationInput): Promise<string> {
    return runEdit(deps, input, (ctx) => opResolveAnnotation(deps, ctx, input));
}
export async function specDecideMarksImpl(deps: SpecToolDeps, input: SpecDecideMarksInput): Promise<string> {
    return runEdit(deps, input, (ctx) => opDecideMarks(deps, ctx, input));
}
export async function specRemoveAllAnnotationsImpl(deps: SpecToolDeps, input: SpecRemoveAllAnnotationsInput): Promise<string> {
    return runEdit(deps, input, (ctx) => opRemoveAllAnnotations(deps, ctx, input));
}

// ---------------------------------------------------------------------------
// Tool definitions
// ---------------------------------------------------------------------------

const NOTATION =
    ' Annotations (SOM §11.9) live in content values and form-field values: a comment block `> ⬆️ **C-12** (author): text` '
    + '(id and author optional), a question block `> **❓ BQ-81 — topic:** question`, options `> - (a) …` with the '
    + 'recommended one bold `> - **(b)** …`, and `> **Answer:**`; inline marks `{++added++}`, `{--removed--}`, '
    + '`{~~old~>new~~}`, `{==text==}{>>comment<<}`, `{>>comment<<}`.';
const PARAGRAPHS =
    'Paragraphs are the blank-line separated blocks of the value (an annotation block is one; a blank line inside fenced '
    + 'code does not end one), counted from 0 as tomAi_specGetSection shows the value; -1 is the start. Instead of the '
    + 'number, name the paragraph by its text: `afterTextStart` (the paragraph that begins with it, trimmed, '
    + 'case-sensitive) or `afterTextContains` (anywhere in it) — annotation blocks are not matched; no match is refused '
    + '(`anchorNotFound`, with the paragraphs), more than one (`anchorAmbiguous`, with the candidates and their numbers).';
const ANCHOR_PARAMS = {
    afterTextStart: { type: 'string', description: 'Instead of `afterParagraph`: the paragraph that begins with this text.' },
    afterTextContains: { type: 'string', description: 'Instead of `afterParagraph`: the paragraph that contains this text.' },
};
const TARGET_PARAMS = {
    path: { type: 'string', description: `The value: a content path (\`…/content\`), or a form with \`field\`. ${PATH_PARAM_HINT}` },
    field: { type: 'string', description: 'The form field whose value holds the annotation; omit for content.' },
};
const QUESTION_SCHEMA = {
    type: 'object',
    description: 'The question block to write.',
    properties: {
        id: { type: 'string', description: 'The question id, e.g. `BQ-90`.' },
        topic: { type: 'string', description: 'What it is about, one or two words.' },
        text: { type: 'string', description: 'The question; may span lines.' },
        options: { type: 'array', items: { type: 'string' }, description: 'Option lines, each `(a) text`, `(b) text`, … in order.' },
        recommended: { type: 'string', description: 'The recommended option\'s letter; that option is written bold.' },
        recommendation: { type: 'string', description: 'Why that option, written as a `*Recommendation:*` line.' },
        assumption: { type: 'string', description: 'The working assumption until it is answered.' },
        starred: { type: 'boolean', description: 'Mark it ★ (important).' },
    },
    required: ['id', 'topic', 'text'],
};

export const SPEC_ANNOTATIONS_TOOL: SharedToolDefinition<SpecAnnotationsInput> = {
    name: 'tomAi_specAnnotations',
    displayName: 'Spec: Annotations',
    description:
        'The review annotations of a TomSpecs document (`*.docspecs.yaml` or SOM `*.md`), read by the runtime\'s '
        + 'SpecReviewAnnotations: `comments` (id, qualifiedId `SBP C-12`, author, text, `context` = the paragraph the '
        + 'comment follows, path, field, line), `questions` (id, topic, text, options with the bold one, recommended '
        + 'letter, answer, open) and `marks` (`M-<n>`, markKind, oldText, newText, comment, markup, context), with `counts` '
        + '(questions, openQuestions, answeredQuestions, comments, marks), `marksRevision` (what tomAi_specDecideMarks '
        + 'checks mark ids against) and `findings` (annotation problems the runtime reports). `path` keeps those at or '
        + 'below it; `kinds` and `openOnly` narrow the lists; at most `limit` (default 200) of each, `truncated` when '
        + 'more. Lines are 0-based within the value. With `dir` instead of `file`: every SOM document under the folder '
        + '(found as tomAi_specListDocuments finds them) with its `counts` and its number of `findings`, and the `totals` '
        + '(documents, withAnnotations, the counts, findings) — no lists; which documents still have open questions, '
        + 'unapplied comments or marks, in one call. `maxResults` / `timeBudgetMs` bound it; `truncated` with `stoppedBy` '
        + 'when they did.' + NOTATION + FIRST_LOOK,
    tags: ['tomspecs', 'som', 'docspecs', 'tom-ai-chat'],
    readOnly: true,
    inputSchema: {
        type: 'object',
        properties: {
            file: { ...FILE_PARAM, description: `${FILE_PARAM.description} Or pass \`dir\`.` },
            dir: { type: 'string', description: 'A folder (workspace-relative or absolute): the counts of every SOM document under it, instead of one document\'s lists.' },
            maxResults: { type: 'number', description: 'With `dir`: at most this many documents. Default 200, max 2000.' },
            timeBudgetMs: { type: 'number', description: 'With `dir`: how long it may take, in ms. Default 10000, max 120000.' },
            path: { type: 'string', description: `Only annotations at or below this path. ${PATH_PARAM_HINT}` },
            kinds: { type: 'array', items: { type: 'string', enum: ['comment', 'question', 'mark'] }, description: 'Which lists to fill; default all three.' },
            openOnly: { type: 'boolean', description: 'Only questions without an answer.' },
            limit: { type: 'number', description: 'At most this many of each kind. Default 200.' },
        },
    },
    execute: async (input) => specAnnotationsImpl(liveDeps(), input),
};

export const SPEC_INSERT_COMMENT_TOOL = editTool<SpecInsertCommentInput>(
    { name: 'tomAi_specInsertComment', displayName: 'Spec: Insert Comment' },
    'Insert a reviewer comment block `> ⬆️ **C-<n>** (author): text` after a paragraph of a value (`afterParagraph`, or '
    + '`afterTextStart` / `afterTextContains`), through '
    + 'SpecReviewAnnotations.insertComment. The id is `id` when given, else the next free one (the highest `C-<n>` in '
    + 'the document plus one); answers it as `id`. ' + PARAGRAPHS + ' A missing paragraph is refused (`annotationRefused`).'
    + NOTATION + FIRST_LOOK + RESULT_NOTE,
    {
        ...EDIT_PARAMS, ...TARGET_PARAMS,
        afterParagraph: { type: 'number', description: 'The paragraph (0-based) the comment follows; -1 for the start of the value.' },
        ...ANCHOR_PARAMS,
        text: { type: 'string', description: 'The comment.' },
        author: { type: 'string', description: 'Who writes it; omit for none.' },
        id: { type: 'string', description: 'The id to write, e.g. `C-12`; default the next free one.' },
    },
    ['file', 'path', 'text'],
    specInsertCommentImpl,
);

export const SPEC_INSERT_QUESTION_TOOL = editTool<SpecInsertQuestionInput>(
    { name: 'tomAi_specInsertQuestion', displayName: 'Spec: Insert Question' },
    'Insert a question block (SOM §11.9.2): directly after a comment (`afterComment`, its id — how to ask about a '
    + 'comment), or after a paragraph of the value at `path` (`afterParagraph`, `afterTextStart` or `afterTextContains`). The block is written by the runtime: the '
    + 'header `> **❓ <id> — <topic>:** <text>`, the options one per line with the recommended one bold, an optional '
    + '`*Recommendation:*` and working assumption, and an empty `> **Answer:**`. ' + PARAGRAPHS + NOTATION + FIRST_LOOK + RESULT_NOTE,
    {
        ...EDIT_PARAMS, ...TARGET_PARAMS,
        question: QUESTION_SCHEMA,
        afterComment: { type: 'string', description: 'Insert directly after this comment (e.g. `C-12`).' },
        afterParagraph: { type: 'number', description: 'With `path`: the paragraph (0-based) the question follows; -1 for the start.' },
        ...ANCHOR_PARAMS,
    },
    ['file', 'question'],
    specInsertQuestionImpl,
);

export const SPEC_SET_ANSWER_TOOL = editTool<SpecSetAnswerInput>(
    { name: 'tomAi_specSetAnswer', displayName: 'Spec: Set Answer' },
    'Write the answer of a question after its `**Answer:**` (SpecReviewAnnotations.setAnswer): the option letter first '
    + 'when it picks one, `(b) because …`; several lines stay inside the quote. "" clears it and reopens the question. '
    + 'An unknown question id is refused (`annotationRefused`).' + FIRST_LOOK + RESULT_NOTE,
    {
        ...EDIT_PARAMS,
        questionId: { type: 'string', description: 'The question id, e.g. `BQ-81` (from tomAi_specAnnotations).' },
        answer: { type: 'string', description: 'The answer; "" reopens the question.' },
    },
    ['file', 'questionId', 'answer'],
    specSetAnswerImpl,
);

export const SPEC_EDIT_COMMENT_TOOL = editTool<SpecEditCommentInput>(
    { name: 'tomAi_specEditComment', displayName: 'Spec: Edit Comment' },
    'Replace the text of a comment block; its marker, id and author stay as written (SpecReviewAnnotations.editComment). '
    + 'A qualified id (`SBP C-12`) is accepted; an unknown one is refused (`annotationRefused`).' + FIRST_LOOK + RESULT_NOTE,
    {
        ...EDIT_PARAMS,
        commentId: { type: 'string', description: 'The comment id, e.g. `C-12`.' },
        text: { type: 'string', description: 'The new text.' },
    },
    ['file', 'commentId', 'text'],
    specEditCommentImpl,
);

export const SPEC_ASSIGN_COMMENT_IDS_TOOL = editTool<SpecAssignCommentIdsInput>(
    { name: 'tomAi_specAssignCommentIds', displayName: 'Spec: Assign Comment Ids' },
    'Give every comment block without an id the next free `C-<n>`, in document order, so each can be cited and '
    + 'resolved (SpecReviewAnnotations.assignCommentIds). Answers the ids as `assigned` ([] when every comment has one); '
    + 'nothing else changes.' + FIRST_LOOK + RESULT_NOTE,
    {
        ...EDIT_PARAMS,
        floor: { type: 'number', description: 'Number from above this, when higher than the document\'s highest (e.g. ids used elsewhere).' },
    },
    ['file'],
    specAssignCommentIdsImpl,
);

export const SPEC_RESOLVE_ANNOTATION_TOOL = editTool<SpecResolveAnnotationInput>(
    { name: 'tomAi_specResolveAnnotation', displayName: 'Spec: Resolve Annotation' },
    'Remove one comment or question by id once it has been applied to the document (SpecReviewAnnotations.resolve); a '
    + 'qualified comment id (`SBP C-12`) is accepted. A question of a combined block takes only its own lines. The '
    + 'surrounding text stays. Inline marks are decided with tomAi_specDecideMarks instead.' + FIRST_LOOK + RESULT_NOTE,
    {
        ...EDIT_PARAMS,
        id: { type: 'string', description: 'A comment id (`C-12`, `SBP C-12`) or a question id (`BQ-81`).' },
    },
    ['file', 'id'],
    specResolveAnnotationImpl,
);

export const SPEC_DECIDE_MARKS_TOOL = editTool<SpecDecideMarksInput>(
    { name: 'tomAi_specDecideMarks', displayName: 'Spec: Decide Marks' },
    'Accept or reject inline marks (SOM §11.9.3): accepting takes the change (an insertion\'s text, nothing for a '
    + 'deletion, a substitution\'s new text) and removes a highlight\'s or comment mark\'s comment; rejecting undoes it. '
    + '`decisions` names marks by their `M-<n>` id from tomAi_specAnnotations, each "accept", "reject" or "leave", '
    + 'checked against `marksRevision` (default: the document as it is now) — a stale one is refused '
    + '(`annotationRefused`) and nothing changes. Or `all`: "accept" / "reject" every mark under `path` (default the '
    + 'whole document). Answers `applied` (id, decision, markup, result) and `malformed` marks left as written.'
    + FIRST_LOOK + RESULT_NOTE,
    {
        ...EDIT_PARAMS,
        decisions: { type: 'object', additionalProperties: { type: 'string', enum: ['accept', 'reject', 'leave'] }, description: 'Mark id → decision, e.g. {"M-2": "accept"}.' },
        marksRevision: { type: 'string', description: 'The `marksRevision` the ids were read at (tomAi_specAnnotations).' },
        all: { type: 'string', enum: ['accept', 'reject'], description: 'Decide every mark under `path` the same way.' },
        path: { type: 'string', description: `With \`all\`: only marks at or below this path. ${PATH_PARAM_HINT}` },
    },
    ['file'],
    specDecideMarksImpl,
);

export const SPEC_REMOVE_ALL_ANNOTATIONS_TOOL = editTool<SpecRemoveAllAnnotationsInput>(
    { name: 'tomAi_specRemoveAllAnnotations', displayName: 'Spec: Remove All Annotations' },
    'Remove every review annotation of the document and write it back (SpecReviewAnnotations.removeAllAnnotations): '
    + 'every inline mark accepted, every comment and question block removed, answered or not — the document as it '
    + 'reads once a review round is integrated (step 05, Result). The whole document; for part of it use '
    + 'tomAi_specDecideMarks with `all` and tomAi_specResolveAnnotation. Answers `removed` (comments, questions, '
    + 'openQuestions, marks, counted before), `applied` (each mark accepted) and `malformed` marks left as written. '
    + 'Collect the answers first (tomAi_specWriteAnswers): what is removed here is gone from the document. '
    + '`dryRun` shows the diff.' + FIRST_LOOK + RESULT_NOTE,
    { ...EDIT_PARAMS },
    ['file'],
    specRemoveAllAnnotationsImpl,
);

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export const SPEC_ANNOTATION_TOOLS: SharedToolDefinition<any>[] = [
    SPEC_ANNOTATIONS_TOOL,
    SPEC_INSERT_COMMENT_TOOL,
    SPEC_INSERT_QUESTION_TOOL,
    SPEC_SET_ANSWER_TOOL,
    SPEC_EDIT_COMMENT_TOOL,
    SPEC_ASSIGN_COMMENT_IDS_TOOL,
    SPEC_RESOLVE_ANNOTATION_TOOL,
    SPEC_DECIDE_MARKS_TOOL,
    SPEC_REMOVE_ALL_ANNOTATIONS_TOOL,
];
