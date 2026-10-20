/**
 * The TomSpecs review-annotation tools (vscannot1): questions, reviewer comments
 * and inline marks in content values, read and edited through the runtime's
 * SpecReviewAnnotations (SOM §11.9). Every test works on one value holding all
 * three kinds: two comments (one without an id), an open question with a
 * recommended option, and two inline marks.
 *
 *   SA-1  tomAi_specAnnotations lists comments (id, author, text, the paragraph before), questions (topic,
 *         options, recommended, answer, open) and marks (M-<n>, kind, old / new text) with counts and the
 *         marks revision; `kinds`, `openOnly` and `path` narrow it; a path that does not resolve is refused
 *   SA-2  insertComment after a paragraph: the next free id (or the one given) and the author; dryRun
 *         writes nothing and returns the diff; a stale expectedRevision, a missing paragraph and a path
 *         that is no value are refused, the file unchanged
 *   SA-3  insertQuestion after a paragraph or directly after a comment: the recommended option bold
 *   SA-4  setAnswer answers a question, "" reopens it; an unknown question id is refused
 *   SA-5  editComment replaces a comment's text, its id and author kept
 *   SA-6  assignCommentIds gives the comment without an id the next one
 *   SA-7  resolveAnnotation removes a comment (a qualified id `SBP C-3` too) or a question
 *   SA-8  decideMarks: one mark by id at the marks revision; a stale marks revision is refused; `all`
 *         accepts or rejects every mark under a path
 *   SA-9  tomAi_specRender withoutAnnotations: the document as it reads with every mark accepted and
 *         every comment and question removed; the file unchanged
 *   SA-10 tomAi_specApplyEdits runs the annotation ops in one write
 *   SA-11 a Markdown document: the same tools, saved as Markdown
 *   SA-12 the reader is on the MCP read-only floor, every writer needs approval
 *   SA-13 removeAllAnnotations (vscannot3): every mark accepted, every comment and question removed, the
 *         counts before answered as `removed`; dryRun writes nothing; also a batch op
 *   SA-14 a marked write (vscannot3): setContent / setFormField with `marked: true` write the new text as
 *         marks against the old (accept all gives the new text, reject all the old); a second marked edit
 *         updates the mark instead of nesting one; a typed or enum field is refused (`notText`); the batch
 *         ops take `marked` too
 *   SA-15 tomAi_specExtractAnswers (vscannot3): the answered questions and comments as answers.md, the
 *         open questions and marks on request, counts per document and in total, a subtree by `path`, two
 *         documents in the order given, labelled by file name; writes nothing; on the read-only floor
 *   SA-16 tomAi_specWriteAnswers (vscannot3): writes answers.md (folders created), unchanged is not
 *         rewritten, other text is refused without `overwrite`, dryRun returns the diff and writes nothing
 *   SA-17 the counts across a folder (vscimpa13): `dir` instead of `file` answers per document — file, root,
 *         counts, findings — and the totals, no lists; the search's truncation and stoppedBy are passed on;
 *         `file` and `dir` together, or neither, are refused
 *   SA-18 a text anchor instead of a paragraph number (vscimpa14): `afterTextStart` (the paragraph that begins with
 *         it, trimmed, case-sensitive) and `afterTextContains` (anywhere in it) on insertComment, insertQuestion and
 *         their batch ops, matched against the runtime's paragraph listing without the annotation blocks; no match
 *         is refused (`anchorNotFound`), more than one (`anchorAmbiguous`) with the candidates; one anchor only
 */

import test, { before, describe } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import { installVscodeStub } from './_vscode-stub.js';
import { withTiming } from './_timing.js';
installVscodeStub({});

import { SomModelService } from '../../services/som-model-service.js';
import { SomDocumentStore } from '../../services/som-document-store.js';
import type { SpecToolDeps } from '../spec-tool-common.js';
import { specCreateDocumentImpl, specSetContentImpl, specApplyEditsImpl } from '../spec-edit-tools.js';
import {
    SPEC_ANNOTATION_TOOLS,
    specAnnotationsImpl,
    specAssignCommentIdsImpl,
    specDecideMarksImpl,
    specEditCommentImpl,
    specInsertCommentImpl,
    specInsertQuestionImpl,
    specResolveAnnotationImpl,
    specSetAnswerImpl,
} from '../spec-annotation-tools.js';
import { specRenderImpl } from '../spec-validate-tools.js';
import { specRemoveAllAnnotationsImpl } from '../spec-annotation-tools.js';
import { SPEC_ANSWERS_TOOLS, answersLabel, specExtractAnswersImpl, specWriteAnswersImpl } from '../spec-answers-tools.js';
import { specSetFormFieldImpl } from '../spec-edit-tools.js';
import { READ_ONLY_TOOLS } from '../tool-executors.js';

const SAMPLES = path.resolve(__dirname, '..', '..', '..', '..', '..', 'ai_build', 'tom_som_dart_v0', 'documents');
const MERIDIAN_YAML = fs.readFileSync(path.join(SAMPLES, 'meridian_order_management.docspecs.yaml'), 'utf8');

/** The value every test annotates. Paragraphs: 0 text, 1 comment C-3, 2 marks, 3 question, 4 text, 5 comment without id. */
const VALUE = 'SBP/content';
const ANNOTATED = [
    'The order system replaces the spreadsheets.',
    '',
    '> ⬆️ **C-3** (Bob): What about returns?',
    '',
    'Orders are {++ always ++} kept {~~ two ~> three ~~} years.',
    '',
    '> **❓ BQ-01 — retention:** How long are orders kept?',
    '> - (a) one year',
    '> - **(b)** three years',
    '> **Answer:**',
    '',
    'Invoices go to finance.',
    '',
    '> ⬆️ (Ann): Which finance system?',
].join('\n');

const ws = fs.mkdtempSync(path.join(os.tmpdir(), 'spec-annot-'));
const service = SomModelService.instance;
const deps: SpecToolDeps = { wsRoot: ws, store: new SomDocumentStore(service), service };

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Json = any;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const run = async (impl: (d: SpecToolDeps, i: any) => Promise<string>, input: object): Promise<Json> => JSON.parse(await impl(deps, input));
const read = (name: string): string => fs.readFileSync(path.join(ws, name), 'utf8');

let counter = 0;
/** A fresh Meridian copy whose summary holds the annotated value. */
async function annotated(): Promise<string> {
    const file = `a${++counter}.docspecs.yaml`;
    fs.writeFileSync(path.join(ws, file), MERIDIAN_YAML);
    const set = await run(specSetContentImpl, { file, path: VALUE, text: ANNOTATED });
    assert.equal(set.ok, true, JSON.stringify(set));
    return file;
}
const list = async (file: string, extra: object = {}): Promise<Json> => run(specAnnotationsImpl, { file, ...extra });

describe('TomSpecs annotation tools', () => {
    before(() => { void service.model; void service.metaTree('SBP'); });

    test('SA-1: listing', async () => {
        const file = await annotated();
        const r = JSON.parse(await withTiming('tomAi_specAnnotations:typical', () => specAnnotationsImpl(deps, { file })));
        assert.equal(r.ok, true, JSON.stringify(r));
        assert.deepEqual(r.counts, { questions: 1, openQuestions: 1, answeredQuestions: 0, comments: 2, marks: 2 });
        assert.match(r.marksRevision, /^[0-9a-f]{16}$/);
        assert.equal(r.document.root, 'SBP');
        const [c3, ann] = r.comments;
        assert.deepEqual([c3.id, c3.qualifiedId, c3.author, c3.text, c3.context, c3.path, c3.line], ['C-3', 'SBP C-3', 'Bob', 'What about returns?', 'The order system replaces the spreadsheets.', VALUE, 2]);
        assert.deepEqual([ann.id, ann.author, ann.text], [null, 'Ann', 'Which finance system?']);
        const q = r.questions[0];
        assert.deepEqual([q.id, q.topic, q.open, q.answer, q.recommended], ['BQ-01', 'retention', true, '', 'b']);
        assert.deepEqual(q.options.map((o: Json) => [o.letter, o.text, o.bold]), [['a', 'one year', false], ['b', 'three years', true]]);
        assert.deepEqual(r.marks.map((m: Json) => [m.id, m.markKind, m.oldText, m.newText]), [['M-1', 'insertion', '', 'always'], ['M-2', 'substitution', 'two', 'three']]);

        const onlyQuestions = await list(file, { kinds: ['question'] });
        assert.deepEqual([onlyQuestions.comments.length, onlyQuestions.questions.length, onlyQuestions.marks.length], [0, 1, 0]);
        assert.equal((await list(file, { openOnly: true })).questions.length, 1);
        const elsewhere = await list(file, { path: 'SBP/introductionAndScope' });
        assert.deepEqual(elsewhere.counts, { questions: 0, openQuestions: 0, answeredQuestions: 0, comments: 0, marks: 0 }, 'nothing under another subtree');
        assert.equal((await list(file, { path: 'SBP/nope' })).code, 'unresolvedPath');
    });

    test('SA-2: inserting a comment', async () => {
        const file = await annotated();
        const before = read(file);
        const dry = await run(specInsertCommentImpl, { file, path: VALUE, afterParagraph: 4, text: 'Finance means SAP?', author: 'Eve', dryRun: true });
        assert.equal(dry.ok, true, JSON.stringify(dry));
        assert.equal(dry.written, false);
        assert.equal(dry.id, 'C-4', 'the next free id');
        assert.match(dry.diff, /^\+\s*> ⬆️ \*\*C-4\*\* \(Eve\): Finance means SAP\?/m);
        assert.equal(read(file), before, 'a dry run writes nothing');

        const revision = (await list(file)).document.revision;
        const r = JSON.parse(await withTiming('tomAi_specInsertComment:typical', () =>
            specInsertCommentImpl(deps, { file, path: VALUE, afterParagraph: 0, text: 'Which spreadsheets?', id: 'C-10', expectedRevision: revision })));
        assert.equal(r.ok, true, JSON.stringify(r));
        assert.equal(r.id, 'C-10');
        assert.equal(r.counts.comments, 3);
        const c10 = (await list(file)).comments.find((c: Json) => c.id === 'C-10');
        assert.equal(c10.context, 'The order system replaces the spreadsheets.');
        assert.equal(c10.author, null);

        const now = read(file);
        assert.equal((await run(specInsertCommentImpl, { file, path: VALUE, afterParagraph: 0, text: 'x', expectedRevision: 'stale' })).code, 'revisionConflict');
        assert.equal((await run(specInsertCommentImpl, { file, path: VALUE, afterParagraph: 40, text: 'x' })).code, 'annotationRefused');
        assert.equal((await run(specInsertCommentImpl, { file, path: 'SBP/introductionAndScope', afterParagraph: 0, text: 'x' })).code, 'wrongKind');
        assert.equal((await run(specInsertCommentImpl, { file, path: 'SBP/nope', afterParagraph: 0, text: 'x' })).code, 'unresolvedPath');
        assert.equal(read(file), now, 'refusals write nothing');
    });

    test('SA-3: inserting a question', async () => {
        const file = await annotated();
        const question = { id: 'BQ-02', topic: 'returns', text: 'Are returns in scope?', options: ['(a) no', '(b) yes, within 30 days'], recommended: 'b' };
        const r = JSON.parse(await withTiming('tomAi_specInsertQuestion:typical', () =>
            specInsertQuestionImpl(deps, { file, afterComment: 'C-3', question })));
        assert.equal(r.ok, true, JSON.stringify(r));
        assert.match(read(file), /\*\*❓ BQ-02 — returns:\*\* Are returns in scope\?/);
        assert.match(read(file), /- \*\*\(b\)\*\* yes, within 30 days/, 'the recommended option is bold');
        const qs = (await list(file)).questions;
        assert.deepEqual(qs.map((q: Json) => q.id), ['BQ-02', 'BQ-01'], 'directly after the comment, before the marks paragraph');
        assert.equal(qs[0].recommended, 'b');

        const after = await run(specInsertQuestionImpl, { file, path: VALUE, afterParagraph: -1, question: { id: 'BQ-03', topic: 'start', text: 'First?' } });
        assert.equal(after.ok, true, JSON.stringify(after));
        assert.equal((await list(file)).questions[0].id, 'BQ-03', 'at the start of the value');
        assert.equal((await run(specInsertQuestionImpl, { file, question })).code, 'invalidInput', 'neither a comment nor a paragraph');
        assert.equal((await run(specInsertQuestionImpl, { file, afterComment: 'C-99', question })).code, 'annotationRefused');
    });

    test('SA-4: answering', async () => {
        const file = await annotated();
        const r = JSON.parse(await withTiming('tomAi_specSetAnswer:typical', () => specSetAnswerImpl(deps, { file, questionId: 'BQ-01', answer: '(b) for audit reasons' })));
        assert.equal(r.ok, true, JSON.stringify(r));
        assert.deepEqual([r.counts.openQuestions, r.counts.answeredQuestions], [0, 1]);
        const q = (await list(file)).questions[0];
        assert.deepEqual([q.open, q.answer, q.answerLetter], [false, '(b) for audit reasons', 'b']);
        await run(specSetAnswerImpl, { file, questionId: 'BQ-01', answer: '' });
        assert.equal((await list(file)).questions[0].open, true, '"" reopens it');
        assert.equal((await run(specSetAnswerImpl, { file, questionId: 'BQ-99', answer: 'x' })).code, 'annotationRefused');
    });

    test('SA-5: editing a comment', async () => {
        const file = await annotated();
        const r = JSON.parse(await withTiming('tomAi_specEditComment:typical', () => specEditCommentImpl(deps, { file, commentId: 'C-3', text: 'What about returns and refunds?' })));
        assert.equal(r.ok, true, JSON.stringify(r));
        assert.match(read(file), /> ⬆️ \*\*C-3\*\* \(Bob\): What about returns and refunds\?/);
    });

    test('SA-6: assigning comment ids', async () => {
        const file = await annotated();
        const r = JSON.parse(await withTiming('tomAi_specAssignCommentIds:typical', () => specAssignCommentIdsImpl(deps, { file })));
        assert.equal(r.ok, true, JSON.stringify(r));
        assert.deepEqual(r.assigned, ['C-4']);
        assert.deepEqual((await list(file)).comments.map((c: Json) => c.id), ['C-3', 'C-4']);
        assert.deepEqual((await run(specAssignCommentIdsImpl, { file })).assigned, [], 'nothing left to assign');
    });

    test('SA-7: resolving', async () => {
        const file = await annotated();
        const r = JSON.parse(await withTiming('tomAi_specResolveAnnotation:typical', () => specResolveAnnotationImpl(deps, { file, id: 'SBP C-3' })));
        assert.equal(r.ok, true, JSON.stringify(r));
        assert.equal(r.counts.comments, 1);
        await run(specResolveAnnotationImpl, { file, id: 'BQ-01' });
        const after = await list(file);
        assert.deepEqual([after.counts.questions, after.counts.comments, after.counts.marks], [0, 1, 2]);
        assert.doesNotMatch(read(file), /What about returns|How long are orders kept/);
        assert.equal((await run(specResolveAnnotationImpl, { file, id: 'C-77' })).code, 'annotationRefused');
    });

    // Mark ids are the runtime's `M-<n>`, not camelCase keys.
    /* eslint-disable @typescript-eslint/naming-convention */
    test('SA-8: deciding marks', async () => {
        const file = await annotated();
        const { marksRevision } = await list(file);
        const r = JSON.parse(await withTiming('tomAi_specDecideMarks:typical', () =>
            specDecideMarksImpl(deps, { file, decisions: { 'M-2': 'accept' }, marksRevision })));
        assert.equal(r.ok, true, JSON.stringify(r));
        assert.deepEqual(r.applied.map((a: Json) => [a.id, a.decision, a.result]), [['M-2', 'accept', 'three']]);
        assert.match(read(file), /Orders are \{\+\+ always \+\+\} kept three years\./, 'one mark decided, the other left');
        assert.equal((await run(specDecideMarksImpl, { file, decisions: { 'M-1': 'accept' }, marksRevision })).code, 'annotationRefused', 'the marks revision moved on');

        const all = await run(specDecideMarksImpl, { file, all: 'reject', path: 'SBP' });
        assert.equal(all.ok, true, JSON.stringify(all));
        assert.equal(all.applied.length, 1);
        assert.match(read(file), /Orders are kept three years\./);
        assert.equal((await run(specDecideMarksImpl, { file })).code, 'invalidInput', 'decisions or all');
    });

    /* eslint-enable @typescript-eslint/naming-convention */

    test('SA-9: rendering without annotations', async () => {
        const file = await annotated();
        const before = read(file);
        const r = JSON.parse(await withTiming('tomAi_specRender:withoutAnnotations', () => specRenderImpl(deps, { file, withoutAnnotations: true })));
        assert.equal(r.ok, true, JSON.stringify(r));
        assert.match(r.markdown, /Orders are always kept three years\./, 'marks accepted');
        assert.doesNotMatch(r.markdown, /⬆️|❓|\{\+\+|\{~~/, 'no comment, question or mark');
        assert.equal(read(file), before);
        assert.match((await run(specRenderImpl, { file })).markdown, /⬆️ \*\*C-3\*\*/, 'without the flag the annotations stay');
    });

    test('SA-10: annotation ops in one batch', async () => {
        const file = await annotated();
        const r = await run(specApplyEditsImpl, {
            file,
            edits: [
                { op: 'setAnswer', questionId: 'BQ-01', answer: '(b)' },
                { op: 'insertComment', path: VALUE, afterParagraph: 0, text: 'Agreed.', author: 'Al' },
                { op: 'assignCommentIds' },
                { op: 'decideMarks', all: 'accept' },
                { op: 'resolveAnnotation', id: 'C-3' },
            ],
        });
        assert.equal(r.ok, true, JSON.stringify(r));
        assert.equal(r.applied, 5);
        assert.equal(r.results[1].id, 'C-4');
        assert.deepEqual(r.results[2].assigned, ['C-5']);
        const after = await list(file);
        assert.deepEqual([after.counts.answeredQuestions, after.counts.comments, after.counts.marks], [1, 2, 0]);
    });

    test('SA-11: a Markdown document', async () => {
        const file = 'annotated.md';
        assert.equal((await run(specCreateDocumentImpl, { file, root: 'SBP' })).ok, true);
        assert.equal((await run(specSetContentImpl, { file, path: VALUE, text: ANNOTATED })).ok, true);
        assert.equal((await list(file)).counts.comments, 2);
        const r = await run(specSetAnswerImpl, { file, questionId: 'BQ-01', answer: '(a)' });
        assert.equal(r.ok, true, JSON.stringify(r));
        const c = await run(specInsertCommentImpl, { file, path: VALUE, afterParagraph: 4, text: 'Check SAP.' });
        assert.equal(c.id, 'C-4');
        const text = read(file);
        assert.match(text, /^# /m, 'still Markdown');
        assert.match(text, /> \*\*Answer:\*\* \(a\)/);
        assert.match(text, /> ⬆️ \*\*C-4\*\* Check SAP\./, 'no author: none written');
        assert.equal((await list(file)).counts.answeredQuestions, 1, 'reads back from the Markdown');
    });

    test('SA-12: the read-only floor and approval', () => {
        const floor = new Set(READ_ONLY_TOOLS.map((t) => t.name));
        const names = SPEC_ANNOTATION_TOOLS.map((t) => t.name).sort();
        assert.deepEqual(names, [
            'tomAi_specAnnotations', 'tomAi_specAssignCommentIds', 'tomAi_specDecideMarks', 'tomAi_specEditComment',
            'tomAi_specInsertComment', 'tomAi_specInsertQuestion', 'tomAi_specRemoveAllAnnotations', 'tomAi_specResolveAnnotation',
            'tomAi_specSetAnswer',
        ]);
        for (const t of SPEC_ANNOTATION_TOOLS) {
            if (t.name === 'tomAi_specAnnotations') {
                assert.equal(t.readOnly, true);
                assert.ok(floor.has(t.name), 'the reader is on the floor');
            } else {
                assert.equal(t.readOnly, false, t.name);
                assert.equal(t.requiresApproval, true, t.name);
                assert.ok(!floor.has(t.name), `${t.name} writes`);
            }
        }
    });

    test('SA-13: removing every annotation', async () => {
        const file = await annotated();
        const before = read(file);
        const dry = await run(specRemoveAllAnnotationsImpl, { file, dryRun: true });
        assert.equal(dry.ok, true, JSON.stringify(dry));
        assert.equal(dry.written, false);
        assert.deepEqual(dry.removed, { comments: 2, questions: 1, openQuestions: 1, marks: 2 });
        assert.match(dry.diff, /^-.*BQ-01/m);
        assert.equal(read(file), before, 'a dry run writes nothing');

        const r = JSON.parse(await withTiming('tomAi_specRemoveAllAnnotations:typical', () => specRemoveAllAnnotationsImpl(deps, { file })));
        assert.equal(r.ok, true, JSON.stringify(r));
        assert.equal(r.written, true);
        assert.equal(r.applied.length, 2, 'both marks accepted');
        assert.deepEqual(r.counts, { questions: 0, openQuestions: 0, answeredQuestions: 0, comments: 0, marks: 0 });
        const value = (await run(specRenderImpl, { file, path: VALUE })).markdown as string;
        assert.match(value, /Orders are always kept three years\./, 'the marks accepted');
        assert.doesNotMatch(value, /C-3|BQ-01|Which finance system/, 'comments and questions gone');
        assert.match(value, /Invoices go to finance\./, 'the text stays');

        const batched = await annotated();
        const b = await run(specApplyEditsImpl, { file: batched, edits: [{ op: 'removeAllAnnotations' }] });
        assert.equal(b.ok, true, JSON.stringify(b));
        assert.equal(b.results[0].removed.comments, 2);
        assert.equal((await list(batched)).counts.marks, 0);
    });

    test('SA-14: a marked write', async () => {
        const file = `m${++counter}.docspecs.yaml`;
        fs.writeFileSync(path.join(ws, file), MERIDIAN_YAML);
        assert.equal((await run(specSetContentImpl, { file, path: VALUE, text: 'Orders are kept two years.' })).ok, true);
        const r = JSON.parse(await withTiming('tomAi_specSetContent:marked', () =>
            specSetContentImpl(deps, { file, path: VALUE, text: 'Orders are kept three years.', marked: true })));
        assert.equal(r.ok, true, JSON.stringify(r));
        assert.deepEqual([r.marked, r.exact], [true, true]);
        assert.match(r.value, /\{~~\s*two\s*~>\s*three\s*~~\}/, 'the change is a substitution mark');
        const marks = (await list(file, { kinds: ['mark'] })).marks;
        assert.deepEqual(marks.map((m: Json) => [m.markKind, m.oldText, m.newText]), [['substitution', 'two', 'three']]);

        const again = await run(specSetContentImpl, { file, path: VALUE, text: 'Orders are kept four years.', marked: true });
        assert.equal(again.ok, true, JSON.stringify(again));
        const updated = (await list(file, { kinds: ['mark'] })).marks;
        assert.deepEqual(updated.map((m: Json) => [m.oldText, m.newText]), [['two', 'four']], 'compared from the original: one mark, updated');

        const accepted = await run(specDecideMarksImpl, { file, all: 'accept', dryRun: true });
        assert.match(accepted.diff, /Orders are kept four years\./);
        const rejected = await run(specDecideMarksImpl, { file, all: 'reject', dryRun: true });
        assert.match(rejected.diff, /Orders are kept two years\./);

        const FR1 = 'SBP/introductionAndScope/requirements/functionalRequirements/FRE-REQU-LST-1';
        const desc = await run(specSetFormFieldImpl, { file, path: `${FR1}/FRED`, field: 'description', value: 'The system must keep orders.' });
        assert.equal(desc.ok, true, JSON.stringify(desc));
        const field = await run(specSetFormFieldImpl, { file, path: `${FR1}/FRED`, field: 'description', value: 'The system must archive orders.', marked: true });
        assert.equal(field.ok, true, JSON.stringify(field));
        assert.match(field.value, /\{~~\s*keep\s*~>\s*archive\s*~~\}/);
        assert.equal((await list(file, { kinds: ['mark'], path: FR1 })).marks.length, 1, 'the form field\'s mark is listed');

        const before = read(file);
        const enumField = await run(specSetFormFieldImpl, { file, path: `${FR1}/FREP`, field: 'priority', value: 'could', marked: true });
        assert.equal(enumField.code, 'notText');
        const intField = await run(specSetFormFieldImpl, { file, path: 'SBP/introductionAndScope/summary/SYSCL', field: 'estimatedUserCount', value: '12', marked: true });
        assert.equal(intField.code, 'notText');
        assert.equal(intField.type, 'int');
        assert.equal(read(file), before, 'refused: nothing written');

        const batched = await run(specApplyEditsImpl, {
            file,
            edits: [
                { op: 'setContent', path: VALUE, text: 'Orders are kept five years.', marked: true },
                { op: 'setFormField', path: `${FR1}/FRED`, field: 'description', value: 'The system must delete orders.', marked: true },
            ],
        });
        assert.equal(batched.ok, true, JSON.stringify(batched));
        assert.deepEqual(batched.results.map((x: Json) => x.marked), [true, true]);
        assert.deepEqual((await list(file, { kinds: ['mark'] })).marks.map((m: Json) => m.newText).sort(), ['delete', 'five']);
    });

    test('SA-15: extracting the answers', async () => {
        const file = await annotated();
        await run(specSetAnswerImpl, { file, questionId: 'BQ-01', answer: '(b) as recommended' });
        const before = read(file);
        const r = JSON.parse(await withTiming('tomAi_specExtractAnswers:typical', () => specExtractAnswersImpl(deps, { file })));
        assert.equal(r.ok, true, JSON.stringify(r));
        assert.deepEqual(r.counts, { answered: 1, open: 0, comments: 2, marks: 2 });
        const label = answersLabel(file);
        assert.deepEqual(r.documents.map((d: Json) => [d.label, d.root]), [[label, 'SBP']]);
        assert.deepEqual(r.findings, []);
        const md = r.markdown as string;
        assert.match(md, /^# Answers$/m);
        assert.match(md, new RegExp(`^## ${label.replace('.', '\\.')}$`, 'm'));
        assert.match(md, /^### Answered questions$/m);
        assert.match(md, /BQ-01/);
        assert.match(md, /\(b\) as recommended/);
        assert.match(md, /What about returns\?/);
        assert.doesNotMatch(md, /^### Inline marks$/m, 'marks only on request');
        assert.equal(read(file), before, 'nothing written');

        const withMarks = await run(specExtractAnswersImpl, { file, includeMarks: true, includeOpen: true, title: 'Round 2' });
        assert.match(withMarks.markdown, /^# Round 2$/m);
        assert.match(withMarks.markdown, /^### Inline marks$/m);
        assert.match(withMarks.markdown, /^### Open questions$/m);

        const elsewhere = await run(specExtractAnswersImpl, { file, path: 'SBP/introductionAndScope' });
        assert.deepEqual(elsewhere.counts, { answered: 0, open: 0, comments: 0, marks: 0 });
        assert.equal((await run(specExtractAnswersImpl, { file, path: 'SBP/nope' })).code, 'unresolvedPath');

        const cla = `cla${++counter}.docspecs.yaml`;
        assert.equal((await run(specCreateDocumentImpl, { file: cla, root: 'CLA' })).ok, true);
        const claSet = await run(specSetContentImpl, { file: cla, path: 'CLA/content', text: 'The landscape.\n\n> ⬆️ **C-1** (Eve): Which systems?' });
        assert.equal(claSet.ok, true, JSON.stringify(claSet));
        const two = await run(specExtractAnswersImpl, { files: [cla, file] });
        assert.equal(two.ok, true, JSON.stringify(two));
        assert.deepEqual(two.documents.map((d: Json) => [d.label, d.root, d.counts.comments]), [[answersLabel(cla), 'CLA', 1], [label, 'SBP', 2]], 'in the order given');
        assert.equal(two.counts.comments, 3, 'the total over both');
        assert.ok(two.markdown.indexOf(`## ${answersLabel(cla)}`) < two.markdown.indexOf(`## ${label}`));

        const copy = await annotated();
        assert.equal((await run(specExtractAnswersImpl, { files: [file, copy] })).code, 'overlap', 'two fragments of one root writing the same values');
        assert.equal((await run(specExtractAnswersImpl, {})).code, 'invalidInput');
        assert.equal((await run(specExtractAnswersImpl, { file, files: [file] })).code, 'invalidInput');
        assert.equal(answersLabel('x/tom_uam.sbp.docspecs.yaml'), 'tom_uam.sbp');
        assert.equal(answersLabel('tom_uam.sbp.md'), 'tom_uam.sbp');

        const floor = new Set(READ_ONLY_TOOLS.map((t) => t.name));
        const [extractTool, writeTool] = SPEC_ANSWERS_TOOLS;
        assert.equal(extractTool.name, 'tomAi_specExtractAnswers');
        assert.ok(extractTool.readOnly && floor.has(extractTool.name), 'the extraction is on the floor');
        assert.equal(writeTool.name, 'tomAi_specWriteAnswers');
        assert.ok(!writeTool.readOnly && writeTool.requiresApproval && !floor.has(writeTool.name), 'writing needs approval');
    });

    test('SA-16: writing answers.md', async () => {
        const file = await annotated();
        const output = 'step/02_Deepening/answers.md';
        const dry = await run(specWriteAnswersImpl, { file, output, dryRun: true });
        assert.equal(dry.ok, true, JSON.stringify(dry));
        assert.deepEqual([dry.written, dry.status], [false, 'new']);
        assert.match(dry.diff, /^\+# Answers$/m);
        assert.equal(fs.existsSync(path.join(ws, output)), false, 'a dry run writes nothing');

        const r = JSON.parse(await withTiming('tomAi_specWriteAnswers:typical', () => specWriteAnswersImpl(deps, { file, output })));
        assert.equal(r.ok, true, JSON.stringify(r));
        assert.deepEqual([r.written, r.status, r.file], [true, 'new', output]);
        const text = read(output);
        assert.equal(text, (await run(specExtractAnswersImpl, { file })).markdown, 'the text the extraction answers');

        const same = await run(specWriteAnswersImpl, { file, output });
        assert.deepEqual([same.written, same.status], [false, 'unchanged']);

        await run(specSetAnswerImpl, { file, questionId: 'BQ-01', answer: '(a)' });
        const refused = await run(specWriteAnswersImpl, { file, output });
        assert.equal(refused.code, 'exists');
        assert.equal(read(output), text, 'refused: unchanged');
        const replaced = await run(specWriteAnswersImpl, { file, output, overwrite: true });
        assert.deepEqual([replaced.written, replaced.status], [true, 'changed']);
        assert.match(read(output), /\*\*Answer:\*\* \(a\)/);

        assert.equal((await run(specWriteAnswersImpl, { file, output: '../outside.md' })).ok, false, 'outside the workspace');
        assert.equal((await run(specWriteAnswersImpl, { file })).code, 'invalidInput');
    });

    test('SA-17: the counts across a folder', async () => {
        const dir = `round${++counter}`;
        const put = (name: string, text: string): string => {
            fs.mkdirSync(path.join(ws, dir), { recursive: true });
            fs.writeFileSync(path.join(ws, dir, name), text);
            return `${dir}/${name}`;
        };
        const a = put('a.docspecs.yaml', MERIDIAN_YAML);
        assert.equal((await run(specSetContentImpl, { file: a, path: VALUE, text: ANNOTATED })).ok, true);
        await run(specSetAnswerImpl, { file: a, questionId: 'BQ-01', answer: '(b)' });
        const b = `${dir}/b.md`;
        assert.equal((await run(specCreateDocumentImpl, { file: b, root: 'SBP' })).ok, true);
        assert.equal((await run(specSetContentImpl, { file: b, path: VALUE, text: ANNOTATED })).ok, true);
        put('c.docspecs.yaml', MERIDIAN_YAML);
        put('notes.md', '# Notes\n\nNot a spec.\n');

        const r = JSON.parse(await withTiming('tomAi_specAnnotations:dir', () => specAnnotationsImpl(deps, { dir } as never)));
        assert.equal(r.ok, true, JSON.stringify(r));
        assert.equal(r.searched, dir);
        assert.deepEqual(r.documents.map((d: Json) => d.file), [`${dir}/a.docspecs.yaml`, `${dir}/b.md`, `${dir}/c.docspecs.yaml`]);
        const [da, db, dc] = r.documents;
        assert.deepEqual(da.counts, { questions: 1, openQuestions: 0, answeredQuestions: 1, comments: 2, marks: 2 });
        assert.deepEqual(db.counts, { questions: 1, openQuestions: 1, answeredQuestions: 0, comments: 2, marks: 2 });
        assert.deepEqual(dc.counts, { questions: 0, openQuestions: 0, answeredQuestions: 0, comments: 0, marks: 0 });
        assert.deepEqual([da.root, db.root, da.findings], ['SBP', 'SBP', 0]);
        assert.deepEqual(r.totals, { documents: 3, withAnnotations: 2, questions: 2, openQuestions: 1, answeredQuestions: 1, comments: 4, marks: 4, findings: 0 });
        assert.equal(r.comments, undefined, 'no lists in the folder form');
        assert.equal(r.truncated, undefined);

        const capped = await run(specAnnotationsImpl, { dir, maxResults: 1 });
        assert.deepEqual([capped.documents.length, capped.truncated, capped.stoppedBy], [1, true, 'maxResults']);
        const late = await run(specAnnotationsImpl, { dir, timeBudgetMs: 1 });
        assert.equal(late.ok, true);
        assert.equal(late.truncated, true, 'the budget is passed on');

        assert.equal((await run(specAnnotationsImpl, { file: a, dir })).code, 'invalidInput');
        assert.equal((await run(specAnnotationsImpl, {})).code, 'invalidInput');
    });

    test('SA-18: a text anchor instead of a paragraph number', async () => {
        // The value's paragraphs: 0 'The order system…', 1 comment C-3, 2 'Orders are {++ always ++} kept…',
        // 3 question BQ-01, 4 'Invoices go to finance.', 5 Ann's comment.
        const file = await annotated();
        const commentAfter = async (anchor: object, text: string): Promise<Json> =>
            run(specInsertCommentImpl, { file, path: VALUE, text, ...anchor });
        const contextOf = async (text: string): Promise<string> =>
            (await list(file)).comments.find((c: Json) => c.text === text)?.context;

        assert.equal((await commentAfter({ afterTextStart: 'Invoices go' }, 'By start.')).ok, true);
        assert.equal(await contextOf('By start.'), 'Invoices go to finance.');
        assert.equal((await commentAfter({ afterTextContains: 'kept' }, 'By contains.')).ok, true);
        assert.match(await contextOf('By contains.'), /^Orders are/);

        const notStart = await commentAfter({ afterTextStart: 'kept' }, 'x');
        assert.equal(notStart.code, 'anchorNotFound', 'a start anchor does not match mid-paragraph');
        assert.equal((await commentAfter({ afterTextStart: 'invoices go' }, 'x')).code, 'anchorNotFound', 'case-sensitive');
        assert.equal((await commentAfter({ afterTextContains: 'What about returns?' }, 'x')).code, 'anchorNotFound',
            'an annotation block is not a paragraph to anchor to');
        const ambiguous = await commentAfter({ afterTextContains: 'o' }, 'x');
        assert.equal(ambiguous.code, 'anchorAmbiguous');
        // The two comments inserted above shifted 'Invoices…' from 4 to 5.
        assert.deepEqual(ambiguous.candidates.map((c: Json) => c.index), [0, 2, 5]);
        assert.match(ambiguous.candidates[0].text, /^The order system/);
        assert.equal((await commentAfter({ afterTextStart: 'Invoices', afterParagraph: 4 }, 'x')).code, 'invalidInput', 'one anchor only');
        assert.equal((await commentAfter({}, 'x')).code, 'invalidInput', 'an anchor is needed');

        const q = await run(specInsertQuestionImpl, {
            file, path: VALUE, afterTextStart: 'The order system',
            question: { id: 'BQ-02', topic: 'scope', text: 'Which spreadsheets?' },
        });
        assert.equal(q.ok, true, JSON.stringify(q));
        const value = (await list(file)).questions.find((x: Json) => x.id === 'BQ-02');
        assert.equal(value.line, 2, 'right after the first paragraph');

        const batch = await run(specApplyEditsImpl, {
            file, edits: [{ op: 'insertComment', path: VALUE, afterTextContains: 'finance', text: 'In a batch.' }],
        });
        assert.equal(batch.ok, true, JSON.stringify(batch));
        assert.equal(await contextOf('In a batch.'), 'Invoices go to finance.');
    });
});
