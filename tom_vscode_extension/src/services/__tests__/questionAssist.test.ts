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
 *   QA-5 the closing answer: the question still open after the turn, the question panel offers its own choices —
 *        the proposal first when there is one, each option with the recommended one marked, Leave it open — and a
 *        typed reply; the pick is written (an option as its letter, the proposal accepted, a typed text as is);
 *        Leave it open, a timeout and an answered question write nothing; a refused write is reported
 *   QA-6 the user is told how the question ended (vscimpb63): the proposal accepted — a notice naming what was
 *        written, the question, the file and the line of its Answer as the file has it after the write, also put
 *        under the turn's answer in its queue entry (the send's chat item); answered by the turn itself, left
 *        open, a refused write (a warning) each have their notice; no notice when the turn failed; the live wiring
 *        (notify with Open file, noteChatItem, only a failed run warned by the panel)
 */

import * as fs from 'fs';
import * as path from 'path';
import test, { describe } from 'node:test';
import assert from 'node:assert/strict';

import { installVscodeStub } from '../../tools/__tests__/_vscode-stub.js';
installVscodeStub({});

import {
    closingAnswerAsk, closingNotice, explanationFileFor, findQuestion, interpretClosingReply, isTomSpecsMarkdown, questionAssistValues, runQuestionAssist, type AnswerPick, type QuestionAssistDeps,
} from '../questionAssist.js';
import { choiceAnswer, composeChoiceAnswers } from '../../utils/askChoices.js';
import { proposeMdAnswer, readMdQuestions, settleProposedAnswer } from '../../utils/mdQuestions.js';
import type { AssistNotice } from '../questionAssist.js';
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

    test('QA-5: the closing answer', async () => {
        const questions = readMdQuestions(FIXTURE);
        const cc2 = findQuestion(questions, 'CC-2')!;
        const ask = closingAnswerAsk(cc2, 'specs/review.md');
        assert.equal(ask.title, 'Answer CC-2 in specs/review.md');
        assert.deepEqual(ask.choices.map((c) => c.label), ['(a) the runtime first and then the browser', '(b) the browser first (recommended)', 'Leave it open']);
        assert.match(ask.questions[0], /^CC-2 — The order of the work: two pieces, which first\?/);
        const pr1 = closingAnswerAsk(findQuestion(questions, 'PR-1')!, 'specs/review.md');
        assert.equal(pr1.choices[0].label, 'Accept the proposed answer', 'the proposal first');
        assert.match(pr1.questions[0], /Proposed answer \(grill me\): \(a\) keep it,\nbecause it works\./);
        const click = (a: typeof ask, label: string) => choiceAnswer(a.choices.find((c) => c.label === label)!);
        assert.deepEqual(interpretClosingReply(click(ask, '(b) the browser first (recommended)'), cc2), { kind: 'option', letter: 'b' });
        assert.deepEqual(interpretClosingReply(click(pr1, 'Accept the proposed answer'), findQuestion(questions, 'PR-1')!), { kind: 'proposal' });
        assert.equal(interpretClosingReply(click(ask, 'Leave it open'), cc2), undefined);
        assert.deepEqual(interpretClosingReply('  both, in one go ', cc2), { kind: 'text', text: 'both, in one go' });
        assert.equal(interpretClosingReply('No answer came.', cc2, 'No answer came.'), undefined, 'the timeout fallback');
        assert.equal(interpretClosingReply('askUser error: busy', cc2), undefined);
        // Sent with Send answers (vscimpb35): the choice selected, with the user's words beside it or not.
        const sent = (choiceId: string | undefined, text: string, general = '') =>
            composeChoiceAnswers(ask.questions, ask.choices, [{ ...(choiceId ? { choiceId } : {}), text }], general);
        assert.deepEqual(interpretClosingReply(sent('option-b', 'the browser is smaller'), cc2), { kind: 'option', letter: 'b', text: 'the browser is smaller' });
        assert.deepEqual(interpretClosingReply(sent('option-a', ''), cc2), { kind: 'option', letter: 'a' });
        assert.deepEqual(interpretClosingReply(sent(undefined, 'both, in one go'), cc2), { kind: 'text', text: 'both, in one go' });
        assert.equal(interpretClosingReply(sent('leave-open', ''), cc2), undefined, 'Leave it open, no words');
        assert.equal(interpretClosingReply(sent(undefined, ''), cc2), undefined, 'nothing selected, nothing typed');
        // The run: after the turn the panel is asked and the pick written.
        const written: AnswerPick[] = [];
        const asked: string[] = [];
        const run = (reply: string, over: Partial<QuestionAssistDeps> = {}) => {
            const f = fake({
                askAnswer: async (input) => { asked.push(input.title); return reply; },
                writeAnswer: async (_file, q, pick) => { written.push(pick); assert.equal(q.id, 'CC-2'); return ''; },
                fallbackPrompt: () => 'No answer came.',
                ...over,
            });
            return runQuestionAssist(f.deps, { use: 'grillMe', filePath: FILE, questionId: 'CC-2' });
        };
        const picked = await run(click(ask, '(a) the runtime first and then the browser'));
        assert.equal(picked.ok && picked.answered?.kind, 'option');
        assert.deepEqual(written, [{ kind: 'option', letter: 'a' }]);
        await run('No answer came.');
        await run(click(ask, 'Leave it open'));
        assert.equal(written.length, 1, 'nothing written for a timeout or Leave it open');
        const refused = await run('my own', { writeAnswer: async () => 'the file is dirty in an editor' });
        assert.match(refused.ok ? refused.answerError ?? '' : '', /the answer to CC-2 could not be written: the file is dirty/);
        // Answered meanwhile (the agent, the user in the MD Browser): no panel.
        const before = asked.length;
        const answeredText = FIXTURE.replace('> *Recommendation:* (b): the browser is smaller.\n>\n> **Answer:**\n', '> *Recommendation:* (b): the browser is smaller.\n>\n> **Answer:** (b)\n');
        let reads = 0;
        await run('x', { readText: () => (reads++ === 0 ? FIXTURE : answeredText) });
        assert.equal(asked.length, before, 'no panel for an answered question');
        const src = fs.readFileSync(path.join(EXT, 'src', 'handlers', 'markdownBrowser-handler.ts'), 'utf8');
        assert.match(src, /askAnswer: async \(input\) => \(await import\('\.\/askUser-handler\.js'\)\)\.askUserWithChoices\(input\)/);
        assert.match(src, /liveMdAnswerWriter\.acceptProposal\(\{ \.\.\.target, \.\.\.\(pick\.text && question\.proposed \? \{ text: `\$\{question\.proposed\.text\}\\n\$\{pick\.text\}` \} : \{\}\) \}\)/);
        assert.match(src, /option: pick\.letter, \.\.\.\(pick\.text \? \{ answer: pick\.text \} : \{\}\)/, 'an option with the user\'s words: (b) words');
    });

    test('QA-6: the user is told how the question ended', async () => {
        const choiceOf = (label: string, q = 'PR-1') => choiceAnswer(closingAnswerAsk(findQuestion(readMdQuestions(FIXTURE), q)!, 'specs/review.md').choices.find((c) => c.label === label)!);
        const run = async (reply: string, over: Partial<QuestionAssistDeps> = {}, questionId = 'PR-1') => {
            let text = FIXTURE;
            const notices: AssistNotice[] = [];
            const notes: Array<[string, string]> = [];
            const f = fake({
                readText: () => text,
                send: async () => ({ ok: true, chatItemId: 'chat-150e' }),
                askAnswer: async () => reply,
                writeAnswer: async (_file, q, pick) => { if (pick.kind === 'proposal') { text = settleProposedAnswer(text, q.id, 'accept').text; } return ''; },
                notify: (n) => { notices.push(n); },
                noteChatItem: (id, note) => { notes.push([id, note]); },
                fallbackPrompt: () => 'No answer came.',
                ...over,
            });
            const outcome = await runQuestionAssist(f.deps, { use: 'grillMe', filePath: FILE, questionId });
            return { outcome, notices, notes, text: () => text };
        };
        // The proposal accepted: written, and the notice names the file, the question and the Answer line after the write.
        const accepted = await run(choiceOf('Accept the proposed answer'));
        const answerLine = readMdQuestions(accepted.text()).find((q) => q.id === 'PR-1')!.answerLine!;
        assert.equal(readMdQuestions(accepted.text()).find((q) => q.id === 'PR-1')!.open, false, 'the answer is written');
        assert.deepEqual(accepted.notices, [{ kind: 'info', message: `Grill me: the proposed answer to PR-1 is written into specs/review.md, line ${answerLine}.`, filePath: FILE, line: answerLine }]);
        assert.deepEqual(accepted.notes, [['chat-150e', accepted.notices[0].message]], 'under the turn\'s answer in its queue entry');
        assert.equal(accepted.outcome.ok && accepted.outcome.chatItemId, 'chat-150e');
        // An option, left open, a refused write.
        const option = await run(choiceOf('(b) the browser first (recommended)', 'CC-2'), {}, 'CC-2');
        assert.match(option.notices[0].message, /^Grill me: option \(b\) to CC-2 is written into specs\/review\.md, line \d+\.$/);
        const open = await run(choiceOf('Leave it open'));
        assert.deepEqual(open.notices.map((n) => [n.kind, n.message]), [['info', 'Grill me: PR-1 is left open in specs/review.md.']]);
        assert.equal(open.notes.length, 1);
        const timedOut = await run('No answer came.');
        assert.match(timedOut.notices[0].message, /left open/);
        const refused = await run(choiceOf('Accept the proposed answer'), { writeAnswer: async () => 'the file is dirty in an editor' });
        assert.equal(refused.notices[0].kind, 'warning');
        assert.match(refused.notices[0].message, /^Grill me: the answer to PR-1 could not be written: the file is dirty in an editor$/);
        // Answered by the turn itself (the agent wrote it): no panel, a notice where it is.
        const answeredText = settleProposedAnswer(FIXTURE, 'PR-1', 'accept').text;
        let reads = 0;
        const inTurn = await run('x', { readText: () => (reads++ === 0 ? FIXTURE : answeredText), askAnswer: async () => { throw new Error('no panel'); } });
        assert.match(inTurn.notices[0].message, /^Grill me: PR-1 is answered in specs\/review\.md, line \d+\.$/);
        // A failed turn: no notice from the assist (the panel's handler warns).
        const failed = await run('x', { send: async () => ({ ok: false, error: 'boom', chatItemId: 'c' }) });
        assert.equal(failed.outcome.ok, false);
        assert.deepEqual(failed.notices, []);
        assert.equal(closingNotice('explainInDetail', {}, FILE), undefined, 'nothing settled, nothing said');
        assert.match(closingNotice('explainInDetail', { answered: { kind: 'text', text: 't' }, at: { file: 'a.md', id: 'X-1', line: 4 } }, FILE)!.message, /^Explain in detail: your answer to X-1 is written into a\.md, line 4\.$/);
        const handler = fs.readFileSync(path.join(EXT, 'src', 'handlers', 'markdownBrowser-handler.ts'), 'utf8');
        assert.match(handler, /notify: \(notice\) => \{ void showAssistNotice\(notice\); \}/);
        assert.match(handler, /PromptQueueManager\.instance\.noteChatItem\(chatItemId, note\)/);
        assert.match(handler, /show\(notice\.message, 'Open file'\)/);
        assert.match(handler, /if \(!outcome\.ok\) \{ void vscode\.window\.showWarningMessage/);
        const live = fs.readFileSync(path.join(EXT, 'src', 'services', 'assistLiveDeps.ts'), 'utf8');
        assert.match(live, /chatItemId: outcome\.chatItemId/);
    });
});
