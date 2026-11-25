/**
 * The Q&A journal's format (src/utils/qaJournal.ts): `qa.<host>.<quest>.md`, one block per event.
 *
 *   QJ-1 round trip: every kind of block, every field, formatted and parsed back equal
 *   QJ-2 free texts with Markdown headings, fenced code, quote lines, blank lines and a line that looks like a
 *        metadata line survive; a title holding `-->` cannot end the metadata comment
 *   QJ-3 a question still open: the question block alone is an open question; an answer block naming its id attaches
 *        to it (the last answer wins); an answer whose question is in no file stands as a question of its own
 *   QJ-4 two hosts' files read together keep the time order; the file name names the host; the header and broken
 *        metadata lines are skipped
 *   QJ-5 a process decision from a process entry (`## <ISO> — <title>` and its bullets)
 *   QJ-6 the files: append creates the file with its header once; hasBlock finds a block by id; readQaBlocks reads
 *        every host's file and nothing else
 */

import test, { describe, after } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'fs';
import * as path from 'path';

import {
    appendQaBlocks, combineQaBlocks, formatQaBlock, hostOfQaJournal, parseQaJournal, processDecisionBlock, qaJournalFileName,
    qaJournalHasBlock, qaJournalHeader, readQaBlocks,
    type QaBlock,
} from '../qaJournal.js';

const EXT = path.resolve(__dirname, '..', '..', '..');
const SANDBOX = fs.mkdtempSync(path.join(EXT, '..', '..', '..', 'ztmp', 'vscode_extension_251125_01_aifmt-4_qaj-'));
after(() => fs.rmSync(SANDBOX, { recursive: true, force: true }));

const QUESTION: QaBlock = {
    id: 'q-req-1', kind: 'question', time: '2026-11-25T10:00:00.000Z', host: 'mbp',
    session: 'default@default', run: 'collab', queueItemId: 'item-7', tool: 'tomAi_askUser', title: 'Which way?',
    questions: ['Left or right? [Left] [Right]', 'Why?\nSecond line'], choices: ['Left', 'Right'],
};
const ANSWER: QaBlock = {
    id: 'a-1', kind: 'answer', time: '2026-11-25T10:05:00.000Z', host: 'mbp', run: 'collab', tool: 'tomAi_askUser',
    title: 'Which way?', questionId: 'q-req-1', source: 'telegram', answer: '1. Left\n2. Shorter',
};
const GIVEN: QaBlock = {
    id: 'g-1', kind: 'answerGiven', time: '2026-11-25T11:00:00.000Z', host: 'bomber', session: 's', run: 'default',
    tool: 'tomAi_answerUser', title: 'Why slow?', answerId: 'a123', userQuestion: 'Why is the build slow?',
    answer: 'Because of **x**.', suggestedPrompts: ['Next'], suggestedTodos: ['x1 — Follow up'],
};
const DECISION: QaBlock = {
    id: 'd-1', kind: 'decision', time: '2026-11-25T12:00:00.000Z', host: 'mbp', run: 'r2',
    title: 'decision step: go on', details: '- **From:** p › a\n- **To:** p › b',
};

describe('the Q&A journal format', () => {
    test('QJ-1: round trip of every kind', () => {
        const text = qaJournalHeader('q1', 'mbp') + [QUESTION, ANSWER, GIVEN, DECISION].map(formatQaBlock).join('\n');
        assert.deepEqual(parseQaJournal(text), [QUESTION, ANSWER, GIVEN, DECISION]);
        // Readable: a heading per block.
        assert.match(formatQaBlock(QUESTION), /^<!-- qa \{"id":"q-req-1","kind":"question",[^\n]*\} -->\n### 2026-11-25T10:00:00\.000Z · Question: Which way\?\n/);
        assert.match(formatQaBlock(QUESTION), /- \*\*Choices:\*\* Left \/ Right/);
    });

    test('QJ-2: free texts survive', () => {
        const nasty = [
            '## A heading',
            '#### Answer',
            '',
            '```ts',
            'const x = 1; // <!-- qa {"id":"evil","kind":"question","time":"x"} -->',
            '```',
            '<!-- qa {"id":"evil2","kind":"decision","time":"2026-01-01T00:00:00Z","host":"h"} -->',
            '> a quote',
            '>',
            '  indented',
            '',
            'end',
        ].join('\n');
        const b: QaBlock = { ...ANSWER, id: 'a-nasty', title: 'ends --> here <b>', answer: nasty };
        const q: QaBlock = { ...QUESTION, questions: [nasty, '### q2'] };
        const parsed = parseQaJournal(formatQaBlock(q) + formatQaBlock(b));
        assert.equal(parsed.length, 2);
        assert.deepEqual(parsed[0].questions, [nasty, '### q2']);
        assert.equal(parsed[1].answer, nasty);
        assert.equal(parsed[1].title, 'ends --> here <b>');
        assert.doesNotMatch(formatQaBlock(b).split('\n')[0], /-->.*-->/, 'the metadata comment ends once');
    });

    test('QJ-3: open questions and their answers', () => {
        const open = combineQaBlocks([QUESTION]);
        assert.equal(open.length, 1);
        assert.equal(open[0].reply, undefined, 'open: no answer block');
        const answered = combineQaBlocks([QUESTION, ANSWER, { ...ANSWER, id: 'a-2', time: '2026-11-25T10:06:00.000Z', answer: 'later' }]);
        assert.equal(answered.length, 1);
        assert.deepEqual(answered[0].reply, { id: 'a-2', time: '2026-11-25T10:06:00.000Z', host: 'mbp', text: 'later', source: 'telegram' });
        const orphan = combineQaBlocks([{ ...ANSWER, questionId: 'q-gone' }]);
        assert.equal(orphan.length, 1);
        assert.equal(orphan[0].kind, 'question');
        assert.equal(orphan[0].id, 'q-gone');
        assert.equal(orphan[0].title, 'Which way?');
        assert.equal(orphan[0].reply?.text, ANSWER.answer);
    });

    test('QJ-4: two hosts in time order; host from the file name', () => {
        const mbp = qaJournalHeader('q1', 'mbp') + [QUESTION, ANSWER, DECISION].map(formatQaBlock).join('\n');
        const bomber = qaJournalHeader('q1', 'bomber') + formatQaBlock({ ...GIVEN, time: '2026-11-25T10:02:00.000Z' })
            + '<!-- qa {broken json -->\n' + formatQaBlock({ ...GIVEN, id: 'g-2', time: '2026-11-25T13:00:00.000Z' });
        const items = combineQaBlocks([...parseQaJournal(mbp), ...parseQaJournal(bomber)]);
        assert.deepEqual(items.map((i) => [i.id, i.host]), [['q-req-1', 'mbp'], ['g-1', 'bomber'], ['d-1', 'mbp'], ['g-2', 'bomber']]);
        assert.equal(qaJournalFileName('q1', 'mbp'), 'qa.mbp.q1.md');
        assert.equal(hostOfQaJournal('qa.mbp.q1.md', 'q1'), 'mbp');
        assert.equal(hostOfQaJournal('qa.mbp.q2.md', 'q1'), undefined);
        assert.equal(hostOfQaJournal('qa.a.b.q1.md', 'q1'), undefined);
        assert.equal(hostOfQaJournal('questions.q1.md', 'q1'), undefined);
    });

    test('QJ-5: a process decision from its entry', () => {
        const entry = '## 2026-11-25T09:00:00.000Z — Reset Run: run r1\n\n- **Was:** p › a\n- **Now:** no process\n';
        const b = processDecisionBlock(entry, { host: 'mbp', run: 'r1', id: 'd-x' });
        assert.deepEqual(b, { id: 'd-x', kind: 'decision', time: '2026-11-25T09:00:00.000Z', host: 'mbp', run: 'r1', title: 'Reset Run: run r1', details: '- **Was:** p › a\n- **Now:** no process' });
        assert.deepEqual(parseQaJournal(formatQaBlock(b)), [b]);
    });

    test('QJ-6: the files', () => {
        const folder = path.join(SANDBOX, 'q1');
        const file = appendQaBlocks(folder, 'q1', 'mbp', [QUESTION]);
        assert.equal(file, path.join(folder, 'qa.mbp.q1.md'));
        appendQaBlocks(folder, 'q1', 'mbp', [ANSWER]);
        appendQaBlocks(folder, 'q1', 'bomber', [GIVEN]);
        fs.writeFileSync(path.join(folder, 'questions.q1.md'), '# old\n');
        fs.writeFileSync(path.join(folder, 'qa.mbp.other.md'), formatQaBlock(DECISION));
        const text = fs.readFileSync(file, 'utf8');
        assert.equal(text.split('\n').filter((l) => l.startsWith('# ')).length, 1, 'the header once');
        assert.ok(text.startsWith('# Q&A — q1 (mbp)\n'));
        assert.equal(qaJournalHasBlock(folder, 'q1', 'mbp', 'q-req-1'), true);
        assert.equal(qaJournalHasBlock(folder, 'q1', 'mbp', 'q-req-2'), false);
        assert.equal(qaJournalHasBlock(folder, 'q1', 'nohost', 'q-req-1'), false);
        assert.deepEqual(readQaBlocks(folder, 'q1').map((b) => b.id).sort(), ['a-1', 'g-1', 'q-req-1']);
    });
});
