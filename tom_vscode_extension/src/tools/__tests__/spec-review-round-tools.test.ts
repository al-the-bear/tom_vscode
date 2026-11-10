/**
 * Team review rounds (ccparity_f_teamreview-2; SOM §11.9.8, §11.9.9; CC-64,
 * CC-65, CC-75, CC-77, C-42, C-43, C-52, C-54): the round folder, the copies'
 * status, the merge through the runtime's mergeReviews, the conflict
 * decisions, the review readers with team notation, and plain Markdown
 * questions — for TomSpecs documents and plain annotated Markdown.
 *
 *   RR-1  tomAi_specReviewRoundCreate, plain Markdown: `members` required (`noTeam`), a bad team refused
 *         (`invalidTeam`), base + one copy per member named by member id + round.yaml (document, kind, base,
 *         date, author, team); a folder holding a round refused (`exists`)
 *   RR-2  tomAi_specReviewRoundStatus: nothing returned at first; a returned copy with its counts; a guest's
 *         copy listed unnamed; a copy whose headings do not fit the base is invalid with its problem (CC-65)
 *   RR-3  tomAi_specMergeReviews, plain Markdown (the conformance case "plain Markdown is merged by heading
 *         path, a guest included"): an unnamed guest refused (`guestUnnamed`), a dry run writes nothing, the
 *         merge writes merged/ and merge-report.json exactly as the runtime pins them, keeps the guest in
 *         round.yaml; an invalid copy refuses the merge (`structureMismatch`); an unchanged copy is left out
 *   RR-4  conflicts in plain Markdown: two members change one sentence differently → X-1; tomAi_specDecideConflicts
 *         writes the decision (a letter, `base`, text; "" reopens), refuses an unknown conflict or letter
 *   RR-5  a SOM document with its own team: the round takes the document's team (owner = author), the merged
 *         document has a conflict listed by tomAi_specAnnotations (base, alternatives, members), individual
 *         answers on its question, counts with conflicts; tomAi_specRemoveAllAnnotations refuses while the conflict
 *         is undecided (`conflictUndecided`), applies it once decided; tomAi_specExtractAnswers lists the
 *         individual answers beside the team answer
 *   RR-6  a SOM document without a team takes the blueprint's: its entry for the document type, else its
 *         default team
 *   RR-7  tomAi_mdInsertQuestion: the agent's proposal question in plain Markdown, after a paragraph or at the
 *         end, read back by tomAi_mdQuestions; an id the file has, a missing or ambiguous anchor refused
 *   RR-8  registration: the four round tools and tomAi_mdInsertQuestion are registered; status reads (MCP floor),
 *         the others need approval
 */

/* eslint-disable @typescript-eslint/naming-convention -- conflict ids (`X-1`) are the decisions' keys */
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
import { specAddNodeImpl, specCreateDocumentImpl, specSetContentImpl } from '../spec-edit-tools.js';
import { specAnnotationsImpl, specRemoveAllAnnotationsImpl, specSetAnswerImpl, specInsertQuestionImpl } from '../spec-annotation-tools.js';
import { specExtractAnswersImpl } from '../spec-answers-tools.js';
import {
    SPEC_REVIEW_ROUND_TOOLS,
    specDecideConflictsImpl,
    specMergeReviewsImpl,
    specReviewRoundCreateImpl,
    specReviewRoundStatusImpl,
} from '../spec-review-round-tools.js';
import { MD_INSERT_QUESTION_TOOL, mdInsertQuestionImpl, mdQuestionsImpl } from '../md-question-tools.js';
import { ALL_SHARED_TOOLS, READ_ONLY_TOOLS } from '../tool-executors.js';
import { parseRound } from '../../utils/reviewRound.js';

const CORPUS = path.resolve(__dirname, '..', '..', '..', '..', '..', 'ai_build', 'tom_som_conformance', 'corpus', 'review_merge_cases.json');
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Json = any;
const CASES: Json[] = JSON.parse(fs.readFileSync(CORPUS, 'utf8')).cases;
const MD_CASE = CASES.find((c) => c.name === 'plain Markdown is merged by heading path, a guest included');

const ws = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'review-round-')));
const service = SomModelService.instance;
const deps: SpecToolDeps = { wsRoot: ws, store: new SomDocumentStore(service), service };
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const run = async (impl: (d: any, i: any) => Promise<string>, input: object): Promise<Json> => JSON.parse(await impl(deps, input));
const put = (name: string, text: string): string => {
    fs.mkdirSync(path.dirname(path.join(ws, name)), { recursive: true });
    fs.writeFileSync(path.join(ws, name), text);
    return name;
};
const read = (name: string): string => fs.readFileSync(path.join(ws, name), 'utf8');
const exists = (name: string): boolean => fs.existsSync(path.join(ws, name));

const TEAM = MD_CASE.options.team;
const ALICE = MD_CASE.copies.find((c: Json) => c.memberId === 'alice');
const ERIN = MD_CASE.copies.find((c: Json) => c.memberId === 'erin');

describe('Team review rounds', () => {
    before(() => { void service.model; });

    test('RR-1: create a plain Markdown round', async () => {
        put('md1/payment.md', MD_CASE.base);
        const none = await run(specReviewRoundCreateImpl, { file: 'md1/payment.md' });
        assert.equal(none.code, 'noTeam', JSON.stringify(none));
        const bad = await run(specReviewRoundCreateImpl, { file: 'md1/payment.md', members: [{ memberId: 'Alice', displayName: 'A', role: 'r' }] });
        assert.equal(bad.code, 'invalidTeam');
        const twice = await run(specReviewRoundCreateImpl, { file: 'md1/payment.md', members: [TEAM[0], TEAM[0]] });
        assert.equal(twice.code, 'invalidTeam');

        const r = await withTiming('tomAi_specReviewRoundCreate:typical', () => run(specReviewRoundCreateImpl, {
            file: 'md1/payment.md', round: 'md1/round', members: TEAM, date: '2026-11-05', author: 'Alice Owner',
        }));
        assert.equal(r.ok, true, JSON.stringify(r));
        assert.equal(r.kind, 'markdown');
        assert.equal(r.teamSource, 'members');
        assert.deepEqual(r.copies, [{ memberId: 'alice', file: 'md1/round/alice.md' }, { memberId: 'bob', file: 'md1/round/bob.md' }]);
        assert.equal(read('md1/round/base.md'), MD_CASE.base);
        assert.equal(read('md1/round/alice.md'), MD_CASE.base, 'nothing is written into a copy');
        const round = parseRound(read('md1/round/round.yaml'));
        assert.equal(round.document, 'md1/payment.md');
        assert.equal(round.kind, 'markdown');
        assert.equal(round.base, 'base.md');
        assert.equal(round.extension, '.md');
        assert.equal(round.date, '2026-11-05');
        assert.equal(round.author, 'Alice Owner');
        assert.deepEqual(round.team, TEAM);
        assert.deepEqual(round.guests, []);

        const again = await run(specReviewRoundCreateImpl, { file: 'md1/payment.md', round: 'md1/round', members: TEAM });
        assert.equal(again.code, 'exists');

        const dflt = await run(specReviewRoundCreateImpl, { file: 'md1/payment.md', members: TEAM });
        assert.equal(dflt.ok, true);
        assert.match(dflt.round, /^md1\/review-rounds\/payment-\d{8}-\d{4}$/);
    });

    test('RR-2: round status', async () => {
        put('md2/payment.md', MD_CASE.base);
        await run(specReviewRoundCreateImpl, { file: 'md2/payment.md', round: 'md2/round', members: TEAM, date: '2026-11-05' });
        const first = await run(specReviewRoundStatusImpl, { round: 'md2/round' });
        assert.equal(first.ok, true, JSON.stringify(first));
        assert.deepEqual(first.summary, { members: 2, returned: 0, invalid: 0, guests: 0, unnamedGuests: 0 });

        put('md2/round/alice.md', ALICE.document);
        put('md2/round/erin.md', ERIN.document);
        const s = await withTiming('tomAi_specReviewRoundStatus:typical', () => run(specReviewRoundStatusImpl, { round: 'md2/round' }));
        const alice = s.members.find((m: Json) => m.memberId === 'alice');
        assert.equal(alice.returned, true);
        assert.equal(alice.valid, true);
        assert.equal(alice.displayName, 'Alice Owner');
        assert.deepEqual(alice.counts, { comments: 0, questions: 1, conflicts: 0, openConflicts: 0, marks: 0 });
        assert.equal(s.members.find((m: Json) => m.memberId === 'bob').returned, false);
        assert.equal(s.guests.length, 1);
        assert.equal(s.guests[0].memberId, 'erin');
        assert.equal(s.guests[0].named, false);
        assert.equal(s.summary.unnamedGuests, 1);

        put('md2/round/bob.md', '# Another title\n\nText.\n');
        const broken = await run(specReviewRoundStatusImpl, { round: 'md2/round' });
        const bob = broken.members.find((m: Json) => m.memberId === 'bob');
        assert.equal(bob.valid, false);
        assert.match(bob.problem, /Headings of the base are missing/);
        assert.equal(broken.summary.invalid, 1);

        const notARound = await run(specReviewRoundStatusImpl, { round: 'md2' });
        assert.equal(notARound.code, 'notARound');
    });

    test('RR-3: merge plain Markdown', async () => {
        put('md3/payment.md', MD_CASE.base);
        await run(specReviewRoundCreateImpl, { file: 'md3/payment.md', round: 'md3/round', members: TEAM, date: '2026-11-05', author: 'Alice Owner' });
        const nothing = await run(specMergeReviewsImpl, { round: 'md3/round' });
        assert.equal(nothing.code, 'nothingReturned');

        put('md3/round/alice.md', ALICE.document);
        put('md3/round/erin.md', ERIN.document);
        const unnamed = await run(specMergeReviewsImpl, { round: 'md3/round' });
        assert.equal(unnamed.code, 'guestUnnamed', JSON.stringify(unnamed));
        assert.deepEqual(unnamed.guests, ['erin']);

        const guests = [{ memberId: 'erin', displayName: 'Erin Ops', role: 'Operations' }];
        const dry = await run(specMergeReviewsImpl, { round: 'md3/round', guests, dryRun: true });
        assert.equal(dry.ok, true, JSON.stringify(dry));
        assert.equal(dry.written, false);
        assert.equal(dry.mergedText, MD_CASE.expect.merged);
        assert.equal(exists('md3/round/merged'), false);

        const r = await withTiming('tomAi_specMergeReviews:typical', () => run(specMergeReviewsImpl, { round: 'md3/round', guests }));
        assert.equal(r.ok, true, JSON.stringify(r));
        assert.equal(r.merged, 'md3/round/merged/payment.md');
        assert.deepEqual(r.mergedCopies, ['alice', 'erin']);
        assert.deepEqual(r.notReturned, ['bob']);
        assert.equal(read('md3/round/merged/payment.md'), MD_CASE.expect.merged);
        assert.deepEqual(r.report, MD_CASE.expect.report);
        assert.deepEqual(JSON.parse(read('md3/round/merged/merge-report.json')), MD_CASE.expect.report);
        assert.equal(r.summary.guestQuestions, 1);
        assert.equal(r.summary.answers, 1);
        const round = parseRound(read('md3/round/round.yaml'));
        assert.deepEqual(round.guests, guests, 'the guest is kept in round.yaml');
        assert.equal(round.merged?.file, 'merged/payment.md');
        // Named in round.yaml now: no `guests` needed again.
        const again = await run(specMergeReviewsImpl, { round: 'md3/round', dryRun: true });
        assert.equal(again.ok, true, JSON.stringify(again));

        put('md3/round/bob.md', '# Other\n\nText.\n');
        const mismatch = await run(specMergeReviewsImpl, { round: 'md3/round', dryRun: true });
        assert.equal(mismatch.code, 'structureMismatch');
        assert.equal(mismatch.copies[0].memberId, 'bob');
    });

    test('RR-4: conflicts in plain Markdown and their decisions', async () => {
        const base = '# Limits\n\nThe limit is 100 EUR.\n';
        put('md4/limits.md', base);
        await run(specReviewRoundCreateImpl, { file: 'md4/limits.md', round: 'md4/round', members: TEAM, date: '2026-11-05', author: 'Alice Owner' });
        put('md4/round/alice.md', '# Limits\n\nThe limit is 200 EUR.\n');
        put('md4/round/bob.md', '# Limits\n\nThe limit is 300 EUR.\n');
        const m = await run(specMergeReviewsImpl, { round: 'md4/round' });
        assert.equal(m.ok, true, JSON.stringify(m));
        assert.equal(m.summary.conflicts, 1);
        assert.equal(m.report.conflicts[0].id, 'X-1');
        assert.deepEqual(m.report.conflicts[0].members, ['alice', 'bob']);
        const merged = 'md4/round/merged/limits.md';
        assert.match(read(merged), /> ⚖️ \*\*X-1 — /);
        assert.match(read(merged), /> \*\*Decision:\*\*$/m);

        const unknown = await run(specDecideConflictsImpl, { file: merged, decisions: { 'X-9': 'a' } });
        assert.equal(unknown.code, 'unknownConflict');
        const letter = await run(specDecideConflictsImpl, { file: merged, decisions: { 'X-1': 'z' } });
        assert.equal(letter.code, 'unknownAlternative');
        const bad = await run(specDecideConflictsImpl, { file: merged, decisions: { C1: 'a' } });
        assert.equal(bad.code, 'invalidInput');

        const dry = await run(specDecideConflictsImpl, { file: merged, decisions: { 'X-1': 'b' }, dryRun: true });
        assert.equal(dry.written, false);
        assert.match(dry.diff, /\+> \*\*Decision:\*\* \(b\)/);
        const d = await withTiming('tomAi_specDecideConflicts:typical', () => run(specDecideConflictsImpl, { file: merged, decisions: { 'X-1': 'b' } }));
        assert.equal(d.ok, true, JSON.stringify(d));
        assert.deepEqual(d.decided, [{ id: 'X-1', decision: 'b' }]);
        assert.deepEqual(d.openConflicts, []);
        assert.match(read(merged), /^> \*\*Decision:\*\* \(b\)$/m);
        await run(specDecideConflictsImpl, { file: merged, decisions: { 'X-1': 'base' } });
        assert.match(read(merged), /^> \*\*Decision:\*\* \(base\)$/m);
        const text = await run(specDecideConflictsImpl, { file: merged, decisions: { 'X-1': 'The limit is 250 EUR.' } });
        assert.equal(text.ok, true);
        assert.match(read(merged), /^> \*\*Decision:\*\* The limit is 250 EUR\.$/m);
        const reopened = await run(specDecideConflictsImpl, { file: merged, decisions: { 'X-1': '' } });
        assert.deepEqual(reopened.openConflicts, ['X-1']);
        assert.match(read(merged), /^> \*\*Decision:\*\*$/m);
    });

    test('RR-5: a SOM document with its own team', async () => {
        const file = 'som5/req.docspecs.yaml';
        fs.mkdirSync(path.join(ws, 'som5'), { recursive: true });
        assert.equal((await run(specCreateDocumentImpl, { file, root: 'RSP' })).ok, true);
        for (const [memberId, displayName, role, owner] of [['alice', 'Alice Owner', 'Product owner', true], ['bob', 'Bob Dev', 'Developer', false]] as const) {
            const a = await run(specAddNodeImpl, { file, parentPath: 'RSP/reviewTeam', childSegment: 'RVMEM-MEMB-LST', fields: { content: { memberId, displayName, role, owner } } });
            assert.equal(a.ok, true, JSON.stringify(a));
        }
        const text = 'Orders are kept two years.\n\n> **❓ RQ-9 — retention:** Is two years enough?\n> - (a) yes\n> - **(b)** no\n> **Answer:**';
        assert.equal((await run(specSetContentImpl, { file, path: 'RSP/content', text })).ok, true);

        const c = await run(specReviewRoundCreateImpl, { file, round: 'som5/round', date: '2026-11-05' });
        assert.equal(c.ok, true, JSON.stringify(c));
        assert.equal(c.kind, 'som');
        assert.equal(c.teamSource, 'document');
        assert.deepEqual(c.team.map((m: Json) => m.memberId), ['alice', 'bob']);
        assert.equal(parseRound(read('som5/round/round.yaml')).author, 'Alice Owner', 'the owner authors the revision entry');

        const copyA = 'som5/round/alice.docspecs.yaml';
        const copyB = 'som5/round/bob.docspecs.yaml';
        assert.equal((await run(specSetContentImpl, { file: copyA, path: 'RSP/content', text: text.replace('two years', 'three years') })).ok, true);
        assert.equal((await run(specSetContentImpl, { file: copyB, path: 'RSP/content', text: text.replace('two years', 'five years') })).ok, true);
        assert.equal((await run(specSetAnswerImpl, { file: copyA, questionId: 'RQ-9', answer: '(b)', author: '' })).ok, true);
        assert.equal((await run(specSetAnswerImpl, { file: copyB, questionId: 'RQ-9', answer: '(a)', author: '' })).ok, true);

        const s = await run(specReviewRoundStatusImpl, { round: 'som5/round' });
        assert.deepEqual(s.members.map((m: Json) => [m.memberId, m.returned, m.valid]), [['alice', true, true], ['bob', true, true]], JSON.stringify(s));
        assert.equal(s.members[0].counts.questions, 1);

        const m = await run(specMergeReviewsImpl, { round: 'som5/round' });
        assert.equal(m.ok, true, JSON.stringify(m));
        assert.equal(m.summary.conflicts, 1);
        assert.ok(m.report.revision, 'a SOM merge appends a draft revision entry');
        const merged = 'som5/round/merged/req.docspecs.yaml';

        const notes = await run(specAnnotationsImpl, { file: merged });
        assert.equal(notes.ok, true, JSON.stringify(notes));
        assert.equal(notes.counts.conflicts, 1);
        assert.equal(notes.counts.openConflicts, 1);
        const [x1] = notes.conflicts;
        assert.equal(x1.id, 'X-1');
        assert.equal(x1.open, true);
        assert.match(x1.base, /two years/);
        assert.deepEqual(x1.alternatives.map((a: Json) => [a.letter, a.members]), [['a', ['alice']], ['b', ['bob']]]);
        const q = notes.questions.find((x: Json) => x.id === 'RQ-9');
        assert.deepEqual(q.answers.map((a: Json) => [a.members, a.answer]), [[['alice'], '(b)'], [['bob'], '(a)']]);
        assert.equal(q.open, true, 'the team has not answered');
        const onlyConflicts = await run(specAnnotationsImpl, { file: merged, kinds: ['conflict'], openOnly: true });
        assert.deepEqual([onlyConflicts.questions.length, onlyConflicts.conflicts.length], [0, 1]);

        const answers = await run(specExtractAnswersImpl, { file: merged, includeOpen: true });
        assert.equal(answers.ok, true, JSON.stringify(answers));
        assert.deepEqual(answers.documents[0].individualAnswers.map((x: Json) => [x.id, x.teamAnswer, x.answers.map((a: Json) => a.members.join(','))]), [['RQ-9', '', ['alice', 'bob']]]);
        assert.match(answers.markdown, /### Individual answers\n\n#### RQ-9 — retention\n\n- \*\*Path:\*\* `RSP\/content`\n- \*\*Team answer:\*\* \(none yet\)\n- \*\*alice:\*\* \(b\)\n- \*\*bob:\*\* \(a\)\n$/);

        const refused = await run(specRemoveAllAnnotationsImpl, { file: merged });
        assert.equal(refused.code, 'conflictUndecided', JSON.stringify(refused));
        assert.match(refused.error, /X-1/);

        const d = await run(specDecideConflictsImpl, { file: merged, decisions: { 'X-1': 'a' } });
        assert.equal(d.ok, true, JSON.stringify(d));
        assert.deepEqual(d.openConflicts, []);
        const after = await run(specAnnotationsImpl, { file: merged, kinds: ['conflict'] });
        assert.equal(after.conflicts[0].decision, '(a)');
        assert.equal((await run(specSetAnswerImpl, { file: merged, questionId: 'RQ-9', answer: '(b)', author: '' })).ok, true);
        const removed = await run(specRemoveAllAnnotationsImpl, { file: merged });
        assert.equal(removed.ok, true, JSON.stringify(removed));
        assert.equal(removed.removed.conflicts, 1);
        const final = (await run(specAnnotationsImpl, { file: merged })).counts;
        assert.deepEqual([final.conflicts, final.questions, final.marks], [0, 0, 0]);
        assert.match(read(merged), /three years/, 'the decision (a) is applied');
        assert.doesNotMatch(read(merged), /five years/);
    });

    test('RR-6: the blueprint\'s team for a document without one', async () => {
        fs.mkdirSync(path.join(ws, 'som6/docs'), { recursive: true });
        const sbp = 'som6/blueprint.docspecs.yaml';
        assert.equal((await run(specCreateDocumentImpl, { file: sbp, root: 'SBP' })).ok, true);
        const dflt = await run(specAddNodeImpl, { file: sbp, parentPath: 'SBP/stakeholdersAndGovernance/reviewTeam', childSegment: 'RVMEM-MEMB-LST', fields: { content: { memberId: 'dana', displayName: 'Dana Lead', role: 'Architect', owner: true } } });
        assert.equal(dflt.ok, true, JSON.stringify(dflt));
        const doc = 'som6/docs/req.docspecs.yaml';
        assert.equal((await run(specCreateDocumentImpl, { file: doc, root: 'RSP' })).ok, true);

        const byDefault = await run(specReviewRoundCreateImpl, { file: doc, round: 'som6/r1' });
        assert.equal(byDefault.ok, true, JSON.stringify(byDefault));
        assert.equal(byDefault.teamSource, 'som6/blueprint.docspecs.yaml (default team)');
        assert.deepEqual(byDefault.team.map((m: Json) => m.memberId), ['dana']);

        const entry = await run(specAddNodeImpl, { file: sbp, parentPath: 'SBP/stakeholdersAndGovernance', childSegment: 'DCRVTM-DOCR-LST', fields: { content: { documentType: 'd04RequirementsSpecification' } } });
        assert.equal(entry.ok, true, JSON.stringify(entry));
        const member = await run(specAddNodeImpl, { file: sbp, parentPath: entry.path, childSegment: 'RVMEM-MEMB-LST', fields: { content: { memberId: 'erik', displayName: 'Erik Req', role: 'Analyst' } } });
        assert.equal(member.ok, true, JSON.stringify(member));
        const byType = await run(specReviewRoundCreateImpl, { file: doc, round: 'som6/r2', sbp });
        assert.equal(byType.ok, true, JSON.stringify(byType));
        assert.equal(byType.teamSource, 'som6/blueprint.docspecs.yaml (d04)');
        assert.deepEqual(byType.team.map((m: Json) => m.memberId), ['erik']);
        assert.equal(byType.team.length, 1, 'the most specific team replaces the default');
    });

    test('RR-7: tomAi_mdInsertQuestion', async () => {
        const file = put('md7/notes.md', '# Notes\n\nFirst paragraph\ngoes on.\n\nSecond paragraph.\n\n```\nFirst paragraph in code\n```\n');
        const q = { id: 'RQ-1', topic: 'scope', text: 'Is the second part in scope?', options: ['(a) yes', '(b) no'], recommended: 'a', recommendation: 'it is cheap' };
        const r = await withTiming('tomAi_mdInsertQuestion:typical', () => run(mdInsertQuestionImpl, { file, question: q, afterTextContains: 'goes on' }));
        assert.equal(r.ok, true, JSON.stringify(r));
        assert.equal(r.question.id, 'RQ-1');
        assert.equal(r.question.recommended, 'a');
        assert.equal(r.question.open, true);
        const text = read(file);
        assert.match(text, /goes on\.\n\n> \*\*❓ RQ-1 \([^)]+\) — scope:\*\* Is the second part in scope\?\n> - \*\*\(a\)\*\* yes\n> - \(b\) no\n/);
        assert.match(text, /\n> \*\*Answer:\*\*\n\nSecond paragraph\./);
        const all = await run(mdQuestionsImpl, { file });
        assert.deepEqual(all.questions.map((x: Json) => x.id), ['RQ-1']);

        const end = await run(mdInsertQuestionImpl, { file, question: { id: 'RQ-2', topic: 'later', text: 'And then?' } });
        assert.equal(end.ok, true, JSON.stringify(end));
        assert.match(read(file), /```\n\n> \*\*❓ RQ-2 /);

        assert.equal((await run(mdInsertQuestionImpl, { file, question: q })).code, 'ambiguousQuestion', 'an id the file has');
        assert.equal((await run(mdInsertQuestionImpl, { file, question: { ...q, id: 'RQ-3' }, afterTextContains: 'nowhere' })).code, 'unknownQuestion');
        assert.equal((await run(mdInsertQuestionImpl, { file, question: { ...q, id: 'RQ-3' }, afterTextContains: 'paragraph' })).code, 'unknownQuestion', 'on several lines');
        const dry = await run(mdInsertQuestionImpl, { file, question: { ...q, id: 'RQ-3' }, afterLine: 1, dryRun: true });
        assert.equal(dry.written, false);
        assert.doesNotMatch(read(file), /RQ-3/);
    });

    test('RR-8: registration', () => {
        const names = ALL_SHARED_TOOLS.map((t) => t.name);
        for (const t of [...SPEC_REVIEW_ROUND_TOOLS, MD_INSERT_QUESTION_TOOL]) {
            assert.ok(names.includes(t.name), `${t.name} is registered`);
            const reads = t.name === 'tomAi_specReviewRoundStatus';
            assert.equal(t.readOnly, reads, t.name);
            assert.equal(READ_ONLY_TOOLS.some((r) => r.name === t.name), reads, `${t.name} on the read-only floor: ${reads}`);
            if (!reads) { assert.equal(t.requiresApproval, true, t.name); }
        }
        // The SOM question writer is the proposal writer for SOM documents; plain Markdown has its own.
        assert.equal(typeof specInsertQuestionImpl, 'function');
    });
});
