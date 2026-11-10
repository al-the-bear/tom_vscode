/**
 * Question tools for plain Markdown (ccparity_i_assist-2): tomAi_mdQuestions,
 * tomAi_mdSetAnswer, tomAi_mdProposeAnswer on the MD Browser's parser
 * (media/shared/mdQuestions.js), against fixtures/md_questions/review.md.
 *
 *   MQ-1 every question block: id, topic, text, line, options, the recommended one (bold, "recommended", a
 *        Recommendation line), answer, open, answerLine, a proposal under it; fenced code that looks like a
 *        question is not read; a question outside a quote; a block of several; `id` / `openOnly`; revision
 *   MQ-2 tomAi_mdSetAnswer writes the Answer line (option letter first, several lines inside the quote, "" clears,
 *        outside a quote) and changes nothing else; the marker records the time written, `**Answer (<time>):**`
 *        ("" reopens it as `**Answer:**`); the browser reads the written answer the same way
 *   MQ-3 tomAi_mdProposeAnswer writes `> **Proposed answer** (<source>, <date>): …` under the question after a bare
 *        quote line, leaves the answer open, keeps what follows apart, replaces a proposal already there
 *   MQ-4 refused: unknown id (the ids listed; the fenced one is not a question), an id twice without `line`, no
 *        Answer line, an unknown option, a file dirty in an editor, a changed `expectedRevision`, not .md, outside
 *        the workspace; `dryRun` answers the diff and writes nothing; CRLF line endings are kept
 *   MQ-5 one parser: blocks.js no longer holds it, the browser loads the shared file before blocks.js, and
 *        the browser's mdbQuestionAt reads the fixture's questions as the tools do; registration and docs
 *   MQ-6 change times (SOM §11.9.2, §11.9.10, tom_specs annot10): a header `**❓ BQ-1 (<time>) — topic:**` and a
 *        team answer `**Answer (<time>):**` are read like the untimed forms; an individual answer
 *        `**Answer (alice, <time>):**` is no team answer; writing records the new time; proposing keeps the label
 */

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as vm from 'vm';
import test, { describe } from 'node:test';
import assert from 'node:assert/strict';

import { installVscodeStub } from './_vscode-stub.js';
installVscodeStub({});

import { withTiming } from './_timing.js';
import { SomModelService } from '../../services/som-model-service.js';
import { SomDocumentStore, nodeSomDocumentIo } from '../../services/som-document-store.js';
import {
    MD_PROPOSE_ANSWER_TOOL, MD_QUESTIONS_TOOL, MD_SET_ANSWER_TOOL,
    mdProposeAnswerImpl, mdQuestionsImpl, mdSetAnswerImpl, type MdQuestionToolDeps,
} from '../md-question-tools.js';

const EXT = path.join(__dirname, '..', '..', '..');
const FIXTURE = fs.readFileSync(path.join(EXT, 'src', 'tools', '__tests__', 'fixtures', 'md_questions', 'review.md'), 'utf8');

const ws = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'md-questions-')));
const put = (name: string, text = FIXTURE): string => { fs.writeFileSync(path.join(ws, name), text); return name; };
const read = (name: string): string => fs.readFileSync(path.join(ws, name), 'utf8');
const dirty = new Set<string>();
/** The change time the writes record (deps.now). */
const NOW = '2026-11-10T09:00+01:00';
const deps: MdQuestionToolDeps & { now: () => string } = {
    wsRoot: ws,
    store: new SomDocumentStore(SomModelService.instance, { ...nodeSomDocumentIo, isDirty: (p) => dirty.has(path.resolve(p)) }),
    today: () => '2026-11-07',
    now: () => NOW,
};
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Json = any;
const run = async (impl: (d: MdQuestionToolDeps & { now: () => string }, i: Json) => Promise<string>, input: object): Promise<Json> => JSON.parse(await impl(deps, input));
const q = (all: Json, id: string, n = 0) => all.questions.filter((x: Json) => x.id === id)[n];
/** The lines of `after` that differ from `before`, by position (same line count) — or both texts when the count changed. */
const changedLines = (before: string, after: string): string[] => {
    const a = before.split('\n'); const b = after.split('\n');
    return b.filter((l, i) => a[i] !== l);
};

describe('Markdown question tools', () => {
    test('MQ-1: tomAi_mdQuestions', async () => {
        const file = put('read.md');
        const all = await withTiming('tomAi_mdQuestions:typical', () => run(mdQuestionsImpl, { file }));
        assert.equal(all.ok, true);
        assert.deepEqual(all.questions.map((x: Json) => x.id), ['CC-1', 'CC-2', 'BQ-1', 'BQ-2', 'PL-1', 'NA-1', 'DUP-1', 'DUP-1', 'PR-1'], 'FAKE-1 in the fence is not read');
        assert.equal(all.total, 9);
        assert.equal(all.open, 6);
        assert.match(all.revision, /^[0-9a-f]{64}$/);
        assert.deepEqual(q(all, 'CC-1'), {
            id: 'CC-1', topic: 'Where the explanation appears', text: '', line: 8,
            options: [{ letter: 'a', text: 'in a note beside the document', bold: true }, { letter: 'b', text: 'only in the question panel', bold: false }],
            recommended: 'a', answer: '(a), and the MD Browser shows it', open: false, answerLine: 12,
        });
        const cc2 = q(all, 'CC-2');
        assert.equal(cc2.text, 'two pieces, which first?');
        assert.equal(cc2.options[0].text, 'the runtime first and then the browser', 'an indented line continues the option');
        assert.equal(cc2.recommended, 'b', 'from the Recommendation line');
        assert.equal(cc2.open, true);
        assert.equal(q(all, 'BQ-1').recommended, 'b', 'the bold option');
        assert.equal(q(all, 'BQ-1').answer, '(a)');
        assert.equal(q(all, 'BQ-2').recommended, 'b', 'the option that says recommended');
        assert.equal(q(all, 'BQ-2').answerLine, 41, 'its own answer, not the one of the block\'s first question');
        assert.equal(q(all, 'PL-1').answer, '(b)\ncontinued on the next line', 'outside a quote: the rest of the paragraph');
        assert.equal(q(all, 'NA-1').answerLine, null);
        assert.deepEqual(q(all, 'PR-1').proposed, { source: 'grill me', date: '2026-11-01', text: '(a) keep it,\nbecause it works.', line: 84 });
        assert.equal(q(all, 'PR-1').answer, '', 'the proposal is not the answer');
        assert.deepEqual((await run(mdQuestionsImpl, { file, id: 'BQ-2' })).questions.map((x: Json) => x.line), [37]);
        const open = await run(mdQuestionsImpl, { file, openOnly: true });
        assert.deepEqual(open.questions.map((x: Json) => x.id), ['CC-2', 'BQ-2', 'NA-1', 'DUP-1', 'DUP-1', 'PR-1']);
        assert.equal(open.total, 9, 'counts are of the whole document');
    });

    test('MQ-2: tomAi_mdSetAnswer', async () => {
        const file = put('set.md');
        const out = await withTiming('tomAi_mdSetAnswer:typical', () => run(mdSetAnswerImpl, { file, id: 'CC-2', option: 'b', answer: 'because it is smaller' }));
        assert.equal(out.ok, true);
        assert.equal(out.written, true);
        assert.equal(out.question.answer, '(b) because it is smaller');
        assert.equal(out.question.open, false);
        assert.deepEqual(changedLines(FIXTURE, read(file)), [`> **Answer (${NOW}):** (b) because it is smaller`], 'only the Answer line');
        // Several lines stay inside the quote; blank lines are dropped.
        const multi = await run(mdSetAnswerImpl, { file, id: 'BQ-2', answer: 'id\n\nand nothing else' });
        assert.equal(multi.question.answer, 'id\nand nothing else');
        assert.ok(read(file).includes(`> **Answer (${NOW}):** id\n> and nothing else\n\n## Code`));
        // "" clears it.
        const cleared = await run(mdSetAnswerImpl, { file, id: 'CC-1', answer: '' });
        assert.equal(cleared.question.open, true);
        assert.match(read(file), /\n> \*\*Answer:\*\*\n\n> ⬆️ \*\*C-1\*\*/);
        // Outside a quote: the whole paragraph is replaced.
        await run(mdSetAnswerImpl, { file, id: 'PL-1', option: '(a)' });
        assert.ok(read(file).includes(`\n**Answer (${NOW}):** (a)\n\n## Without`));
        // A duplicate picked by its line.
        const dup = await run(mdSetAnswerImpl, { file, id: 'DUP-1', line: 72, answer: 'the second' });
        assert.equal(dup.question.topic, 'Second');
        const after = await run(mdQuestionsImpl, { file });
        assert.deepEqual([q(after, 'DUP-1', 0).answer, q(after, 'DUP-1', 1).answer], ['', 'the second']);
    });

    test('MQ-3: tomAi_mdProposeAnswer', async () => {
        const file = put('propose.md');
        const out = await withTiming('tomAi_mdProposeAnswer:typical', () =>
            run(mdProposeAnswerImpl, { file, id: 'CC-2', answer: '(b) the browser first,\nit is smaller', source: 'grill me' }));
        assert.equal(out.ok, true);
        assert.deepEqual(out.question.proposed, { source: 'grill me', date: '2026-11-07', text: '(b) the browser first,\nit is smaller', line: 27 });
        assert.equal(out.question.open, true, 'the answer stays open');
        assert.match(read(file), /> \*\*Answer:\*\*\n>\n> \*\*Proposed answer\*\* \(grill me, 2026-11-07\): \(b\) the browser first,\n> it is smaller\n\n> ⬆️ \*\*C-2\*\*/);
        // Default source; a block of several: the next question stays apart and reads as before.
        const bq = await run(mdProposeAnswerImpl, { file, id: 'BQ-1', answer: '(a)' });
        assert.equal(bq.question.proposed.source, 'agent');
        assert.equal(bq.question.answer, '(a)');
        assert.match(read(file), /> \*\*Answer:\*\* \(a\)\n>\n> \*\*Proposed answer\*\* \(agent, 2026-11-07\): \(a\)\n>\n> \*\*BQ-2 — field:\*\*/);
        const all = await run(mdQuestionsImpl, { file });
        assert.equal(q(all, 'BQ-2').recommended, 'b');
        assert.equal(q(all, 'BQ-2').proposed, undefined);
        // Outside a quote: a quoted proposal after a blank line.
        await run(mdProposeAnswerImpl, { file, id: 'PL-1', answer: '(a)', source: 'explain' });
        assert.match(read(file), /continued on the next line\n\n> \*\*Proposed answer\*\* \(explain, 2026-11-07\): \(a\)\n\n## Without/);
        // One already there is replaced.
        const replaced = await run(mdProposeAnswerImpl, { file, id: 'PR-1', answer: '(b) drop it', source: 'grill (me), again' });
        assert.deepEqual(replaced.question.proposed, { source: 'grill me again', date: '2026-11-07', text: '(b) drop it', line: replaced.question.proposed.line });
        assert.equal((read(file).match(/Proposed answer\*\* \(grill/g) ?? []).length, 2, 'CC-2\'s and the replaced one');
        assert.ok(!read(file).includes('because it works'), 'the old proposal is gone');
        assert.ok(read(file).endsWith('> **Proposed answer** (grill me again, 2026-11-07): (b) drop it\n'));
    });

    test('MQ-4: refusals, dryRun, line endings', async () => {
        const file = put('refuse.md');
        const unknown = await run(mdSetAnswerImpl, { file, id: 'FAKE-1', answer: 'x' });
        assert.equal(unknown.code, 'unknownQuestion');
        assert.match(unknown.error, /it has CC-1, CC-2, BQ-1/);
        assert.equal((await run(mdSetAnswerImpl, { file, id: 'DUP-1', answer: 'x' })).code, 'ambiguousQuestion');
        assert.equal((await run(mdSetAnswerImpl, { file, id: 'DUP-1', line: 3, answer: 'x' })).code, 'unknownQuestion');
        assert.equal((await run(mdSetAnswerImpl, { file, id: 'NA-1', answer: 'x' })).code, 'noAnswerLine');
        assert.equal((await run(mdProposeAnswerImpl, { file, id: 'NA-1', answer: 'x' })).code, 'noAnswerLine');
        const opt = await run(mdSetAnswerImpl, { file, id: 'CC-2', option: 'z' });
        assert.equal(opt.code, 'unknownOption');
        assert.match(opt.error, /\(a\) \(b\)/);
        assert.match((await run(mdSetAnswerImpl, { file, id: 'CC-2' })).error, /Give `answer`/);
        assert.match((await run(mdProposeAnswerImpl, { file, id: 'CC-2', answer: ' ' })).error, /`answer` is required/);
        dirty.add(path.join(ws, file));
        assert.equal((await run(mdSetAnswerImpl, { file, id: 'CC-2', answer: 'x' })).code, 'dirtyInEditor');
        assert.equal((await run(mdProposeAnswerImpl, { file, id: 'CC-2', answer: 'x' })).code, 'dirtyInEditor');
        dirty.clear();
        assert.equal((await run(mdSetAnswerImpl, { file, id: 'CC-2', answer: 'x', expectedRevision: 'f'.repeat(64) })).code, 'revisionConflict');
        assert.match((await run(mdQuestionsImpl, { file: 'notes.txt' })).error, /Not a Markdown file/);
        assert.match((await run(mdQuestionsImpl, { file: '/elsewhere/x.md' })).error, /outside the workspace/);
        assert.equal(read(file), FIXTURE, 'nothing was written');
        const dry = await run(mdSetAnswerImpl, { file, id: 'CC-2', option: 'a', dryRun: true, expectedRevision: (await run(mdQuestionsImpl, { file })).revision });
        assert.equal(dry.written, false);
        assert.ok(dry.diff.includes(`+> **Answer (${NOW}):** (a)`));
        assert.equal(read(file), FIXTURE);
        // CRLF stays CRLF.
        const crlf = put('crlf.md', FIXTURE.replace(/\n/g, '\r\n'));
        await run(mdProposeAnswerImpl, { file: crlf, id: 'CC-2', answer: 'b' });
        const text = read(crlf);
        assert.equal(text.split('\r\n').length, text.split('\n').length, 'no bare \\n');
        assert.match(text, />\r\n> \*\*Proposed answer\*\* \(agent, 2026-11-07\): b\r\n/);
    });

    test('MQ-6: question and team-answer times', async () => {
        const timed = [
            '# Timed', '',
            '> **❓ BQ-1 (2026-11-07T14:05+01:00) — Timeout:** shorter?',
            '> - (a) 30',
            '> - **(b)** 15',
            '>',
            '> **Answer (alice, 2026-11-07T14:10+01:00):** (a)',
            '>',
            '> **Answer (2026-11-07T15:00Z):** (b)',
            '',
            '> **❓ BQ-2 (2026-11-07T14:05+01:00) — Kiosks:** also on kiosks?',
            '>',
            '> **Answer:**',
            '',
        ].join('\n');
        const file = put('timed.md', timed);
        const all = await run(mdQuestionsImpl, { file });
        assert.deepEqual(all.questions.map((x: Json) => x.id), ['BQ-1', 'BQ-2']);
        assert.equal(q(all, 'BQ-1').topic, 'Timeout', 'the time is not part of the topic');
        assert.equal(q(all, 'BQ-1').recommended, 'b');
        assert.equal(q(all, 'BQ-1').answer, '(b)', 'the timed team answer, not the individual one');
        assert.equal(q(all, 'BQ-1').answerLine, 9);
        assert.equal(q(all, 'BQ-1').open, false);
        assert.equal(q(all, 'BQ-2').open, true);
        // Writing records the time it was written, replacing the old one.
        await run(mdSetAnswerImpl, { file, id: 'BQ-1', option: 'a' });
        assert.deepEqual(changedLines(timed, read(file)), [`> **Answer (${NOW}):** (a)`]);
        // A proposal goes under the timed label, which it leaves as it is.
        const proposed = await run(mdProposeAnswerImpl, { file, id: 'BQ-1', answer: '(b)' });
        assert.equal(proposed.question.proposed.text, '(b)');
        assert.ok(read(file).includes(`> **Answer (${NOW}):** (a)\n>\n> **Proposed answer** (agent, 2026-11-07): (b)`));
        // "" reopens it untimed.
        await run(mdSetAnswerImpl, { file, id: 'BQ-2', answer: 'yes' });
        await run(mdSetAnswerImpl, { file, id: 'BQ-2', answer: '' });
        assert.match(read(file), /also on kiosks\?\n>\n> \*\*Answer:\*\*\n/);
    });

    test('MQ-5: one parser for browser and host; registration', async () => {
        const blocks = fs.readFileSync(path.join(EXT, 'media', 'markdownBrowser', 'blocks.js'), 'utf8');
        for (const name of ['function mdbQuestionAt', 'function mdbAnswerAt', 'function mdbWriteAnswer', 'function mdbAnswerMarkers', 'function mdbOptionAnswer', "var MDB_ANSWER_MARKER"]) {
            assert.ok(!blocks.includes(name), `${name} is no longer in blocks.js`);
        }
        const shell = fs.readFileSync(path.join(EXT, 'media', 'markdownBrowser', 'index.html'), 'utf8');
        assert.ok(shell.indexOf('{{sharedUri}}/mdQuestions.js') > 0 && shell.indexOf('{{sharedUri}}/mdQuestions.js') < shell.indexOf('/blocks.js'), 'loaded before blocks.js');
        // The browser's own reading of each answer marker gives the tools' options and recommendation.
        const sandbox: Record<string, Json> = {};
        vm.createContext(sandbox);
        vm.runInContext(fs.readFileSync(path.join(EXT, 'media', 'shared', 'mdQuestions.js'), 'utf8'), sandbox);
        const lines = FIXTURE.split('\n');
        const all = await run(mdQuestionsImpl, { file: put('same.md') });
        for (const x of all.questions.filter((y: Json) => y.answerLine !== null)) {
            const b = JSON.parse(JSON.stringify(sandbox.mdbQuestionAt(lines, x.answerLine - 1)));
            assert.deepEqual([b.id, b.line + 1, b.options, b.recommended], [x.id, x.line, x.options, x.recommended], x.id);
        }
        assert.equal(MD_QUESTIONS_TOOL.readOnly, true);
        for (const t of [MD_SET_ANSWER_TOOL, MD_PROPOSE_ANSWER_TOOL]) {
            assert.equal(t.readOnly, false);
            assert.equal(t.requiresApproval, true);
        }
        const src = (rel: string) => fs.readFileSync(path.join(EXT, 'src', rel), 'utf8');
        assert.match(src('tools/tool-executors.ts'), /\.\.\.MD_QUESTION_TOOLS,/);
        const doc = fs.readFileSync(path.join(EXT, 'doc', 'llm_tools.md'), 'utf8');
        for (const name of ['tomAi_mdQuestions', 'tomAi_mdSetAnswer', 'tomAi_mdProposeAnswer']) {
            assert.match(src('utils/toolCategories.ts'), new RegExp(`'${name}'`));
            assert.match(src('utils/constants.ts'), new RegExp(`'${name}'`));
            assert.match(doc, new RegExp(`^\\| \`${name}\` \\|`, 'm'), `${name}: llm_tools.md row`);
        }
    });
});
