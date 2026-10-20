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
            'tomAi_specInsertComment', 'tomAi_specInsertQuestion', 'tomAi_specResolveAnnotation', 'tomAi_specSetAnswer',
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
});
