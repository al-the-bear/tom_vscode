/**
 * Grill me / Explain in detail run from the MD Browser (ccparity_i_assist-6):
 * src/services/questionAssist.ts with faked sessions and send, and the
 * proposal's Accept / Edit / Discard on the host's parser.
 *
 *   QA-1 the prompt's values: the document kind (plain Markdown or a TomSpecs specification), the question
 *        block as written, the note beside the document (<document folder>/notes/<id>-explained.md)
 *   QA-2 the run: the use's Assist prompt filled; a temporary session based on the document's session (fresh
 *        when that has no session file); sent to the panel in it; the session removed afterwards, also when the
 *        send fails; a busy panel and an answered or unknown question are reported
 *   QA-3 the proposal's three actions on the fixture: Accept writes it into the Answer line and removes it,
 *        Edit accepts the edited text, Discard removes it and leaves the answer; a question without a proposal
 *        is refused
 *   QA-4 wiring: the panel's message runs it; runAnthropicSend takes the session; the default prompts name the
 *        tools per document kind and use choices; an unedited i-3 default is upgraded
 */

import * as fs from 'fs';
import * as path from 'path';
import test, { describe } from 'node:test';
import assert from 'node:assert/strict';

import { installVscodeStub } from '../../tools/__tests__/_vscode-stub.js';
installVscodeStub({});

import { explanationFileFor, findQuestion, isTomSpecsMarkdown, questionAssistValues, runQuestionAssist, type QuestionAssistDeps } from '../questionAssist.js';
import { proposeMdAnswer, readMdQuestions, settleProposedAnswer } from '../../utils/mdQuestions.js';
import { ASSIST_PROMPT_INFO, ensureDefaultAssistPrompts, type AssistPromptsSection } from '../../utils/assistPrompts.js';

const EXT = path.join(__dirname, '..', '..', '..');
const FIXTURE = fs.readFileSync(path.join(EXT, 'src', 'tools', '__tests__', 'fixtures', 'md_questions', 'review.md'), 'utf8');
const WS = '/ws';
const FILE = '/ws/specs/review.md';

function fake(over: Partial<QuestionAssistDeps> = {}, text = FIXTURE) {
    const sessions = new Set(['default', 'p2-work']);
    const created: Array<{ name: string; basedOn?: string }> = [];
    const deleted: string[] = [];
    const sent: Array<{ prompt: string; session: string; source: string; existed: boolean }> = [];
    const deps: QuestionAssistDeps = {
        workspaceRoot: WS,
        readText: () => text,
        assistPrompts: () => undefined,
        baseSession: () => 'p2-work',
        sessionsFolder: () => '/ws/_ai/quests/q/history',
        hasSession: (_f, name) => sessions.has(name),
        createSession: (_f, name, opts) => { sessions.add(name); created.push({ name, ...opts }); return { ok: true }; },
        deleteSession: (_f, name) => { sessions.delete(name); deleted.push(name); },
        send: async (prompt, session, source) => { sent.push({ prompt, session, source, existed: sessions.has(session) }); return { ok: true }; },
        now: () => new Date(2026, 10, 8, 9, 30, 5),
        ...over,
    };
    return { deps, created, deleted, sent };
}

describe('Grill me / Explain in detail', () => {
    test('QA-1: the prompt\'s values', () => {
        const q = findQuestion(readMdQuestions(FIXTURE), 'CC-2')!;
        const v = questionAssistValues(FIXTURE, 'specs/review.md', q);
        assert.equal(v.documentKind, 'plain Markdown');
        assert.equal(v.questionId, 'CC-2');
        assert.equal(v.file, 'specs/review.md');
        assert.ok(v.questionBlock.startsWith('> **❓ CC-2 — The order of the work:**'));
        assert.ok(v.questionBlock.endsWith('> **Answer:**'));
        assert.equal(v.explanationFile, 'specs/notes/CC-2-explained.md');
        assert.equal(explanationFileFor('top.md', 'X-1'), 'notes/X-1-explained.md');
        assert.equal(isTomSpecsMarkdown('# Solution Blueprint <!--[SBP]-->\n'), true);
        assert.equal(isTomSpecsMarkdown(FIXTURE), false);
        const dups = readMdQuestions(FIXTURE).filter((x) => x.id === 'DUP-1');
        assert.deepEqual(findQuestion(readMdQuestions(FIXTURE), 'DUP-1', dups[1].answerLine! - 1), dups[1], 'a duplicate picked by its Answer line');
    });

    test('QA-2: the run', async () => {
        const f = fake();
        const outcome = await runQuestionAssist(f.deps, { use: 'grillMe', filePath: FILE, questionId: 'CC-2' });
        assert.equal(outcome.ok, true);
        assert.deepEqual(f.created, [{ name: 'tmp-261108-093005-grill-me', basedOn: 'p2-work' }], 'based on the document\'s session');
        assert.equal(f.sent.length, 1);
        assert.equal(f.sent[0].session, 'tmp-261108-093005-grill-me');
        assert.equal(f.sent[0].existed, true, 'the session exists while the turn runs');
        assert.equal(f.sent[0].source, 'Grill me (CC-2)');
        assert.match(f.sent[0].prompt, /^\*\*Grill me\*\* on question CC-2 in `specs\/review\.md`\./);
        assert.match(f.sent[0].prompt, /This document is plain Markdown\./);
        assert.match(f.sent[0].prompt, /> \*\*❓ CC-2 — The order of the work:\*\*/);
        assert.deepEqual(f.deleted, ['tmp-261108-093005-grill-me'], 'removed when the turn ends');
        // Explain in detail, the chosen template, a document session without a file: fresh.
        const g = fake({
            baseSession: () => 'default-missing',
            assistPrompts: () => ({ selected: { explainInDetail: 'mine' }, templates: [{ id: 'mine', name: 'Mine', template: 'Explain ${questionId} into ${explanationFile}' }] }),
        });
        const e = await runQuestionAssist(g.deps, { use: 'explainInDetail', filePath: FILE, questionId: 'BQ-2' });
        assert.deepEqual(e, { ok: true, session: 'tmp-261108-093005-explain', basedOn: null, prompt: 'Explain BQ-2 into specs/notes/BQ-2-explained.md' });
        assert.deepEqual(g.created, [{ name: 'tmp-261108-093005-explain' }]);
        // Failures: busy panel (session still removed), answered and unknown questions.
        const busy = fake({ send: async () => ({ ok: false, rejected: true }) });
        assert.match((await runQuestionAssist(busy.deps, { use: 'grillMe', filePath: FILE, questionId: 'CC-2' }) as { error: string }).error, /panel is busy/);
        assert.equal(busy.deleted.length, 1);
        assert.match((await runQuestionAssist(fake().deps, { use: 'grillMe', filePath: FILE, questionId: 'CC-1' }) as { error: string }).error, /answered already/);
        const none = fake();
        assert.match((await runQuestionAssist(none.deps, { use: 'grillMe', filePath: FILE, questionId: 'FAKE-1' }) as { error: string }).error, /no question FAKE-1/);
        assert.deepEqual(none.created, [], 'nothing made for a refused run');
    });

    test('QA-3: the proposal\'s Accept, Edit, Discard', () => {
        const accepted = settleProposedAnswer(FIXTURE, 'PR-1', 'accept');
        assert.equal(accepted.question.answer, '(a) keep it,\nbecause it works.');
        assert.equal(accepted.question.proposed, undefined);
        assert.ok(accepted.text.endsWith('> **Answer:** (a) keep it,\n> because it works.\n'));
        const edited = settleProposedAnswer(FIXTURE, 'PR-1', 'accept', { text: '(b) drop it' });
        assert.equal(edited.question.answer, '(b) drop it');
        const discarded = settleProposedAnswer(FIXTURE, 'PR-1', 'discard');
        assert.equal(discarded.question.answer, '');
        assert.equal(discarded.question.proposed, undefined);
        assert.ok(discarded.text.endsWith('> - (b) drop\n>\n> **Answer:**\n'), 'the separator and the proposal go');
        // A proposal written by the tool, then accepted: the document reads as if answered directly.
        const proposed = proposeMdAnswer(FIXTURE, 'CC-2', '(b) the browser first', 'grill me', '2026-11-08').text;
        const settled = settleProposedAnswer(proposed, 'CC-2', 'accept');
        assert.equal(settled.text, FIXTURE.replace('> *Recommendation:* (b): the browser is smaller.\n>\n> **Answer:**\n', '> *Recommendation:* (b): the browser is smaller.\n>\n> **Answer:** (b) the browser first\n'));
        assert.throws(() => settleProposedAnswer(FIXTURE, 'CC-1', 'accept'), /has no proposed answer/);
    });

    test('QA-4: wiring and the default prompts', () => {
        const src = (rel: string) => fs.readFileSync(path.join(EXT, 'src', rel), 'utf8');
        assert.match(src('handlers/markdownBrowser-handler.ts'), /case 'assistQuestion': \{[\s\S]*?void runQuestionAssist\(liveQuestionAssistDeps\(this\._context\)/);
        assert.match(src('handlers/sendToChatRouter.ts'), /let targetSession = opts\?\.session \|\| ANTHROPIC_CHAT_SESSION_KEY;/);
        for (const use of ['grillMe', 'explainInDetail'] as const) {
            const body = ASSIST_PROMPT_INFO[use].defaultBody;
            assert.match(body, /This document is \$\{documentKind\}\./, use);
            assert.match(body, /tomAi_mdProposeAnswer/, use);
            assert.match(body, /tomAi_specInsertComment/, use);
            assert.match(body, /`choices`/, use);
        }
        assert.match(ASSIST_PROMPT_INFO.explainInDetail.defaultBody, /tomAi_askInMdBrowser/);
        const oldGrill = [
            '**Grill me** on question ${questionId} in `${file}`.', '', 'The question as written:', '', '${questionBlock}', '',
            'Help me answer it by asking — do not answer it for me:', '',
            '1. Read the document around the question so you know its context: its options and recommendation with tomAi_mdQuestions (in a TomSpecs document, tomAi_specAnnotations).',
            '2. Ask me narrowing questions through tomAi_askUser — a few at a time, each saying what it settles — until the question can be answered. Never ask in your reply text.',
            '3. Then propose the answer under the question with tomAi_mdProposeAnswer (source `grill me`). Do not write the Answer line: I accept, edit or discard the proposal in the MD Browser.',
            '4. End with one short paragraph: what you proposed and why.',
        ].join('\n');
        const config: { assistPrompts?: AssistPromptsSection } = { assistPrompts: { templates: [{ id: 'grill-me', name: 'Grill me', template: oldGrill }] } };
        ensureDefaultAssistPrompts(config);
        assert.equal(config.assistPrompts!.templates![0].template, ASSIST_PROMPT_INFO.grillMe.defaultBody, 'the unedited i-3 default is upgraded');
    });
});
