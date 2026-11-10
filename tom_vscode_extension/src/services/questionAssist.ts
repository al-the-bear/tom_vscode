/**
 * Grill me / Explain in detail on an open question in the MD Browser: the
 * button runs the Assist prompt of that name (chosen on the Status Page)
 * outside the queue, in the ANTHROPIC panel, in a temporary session based on
 * the session the document's work runs in — so it does not wait for a running
 * walk and still knows the context. The temporary session is removed when the
 * turn ends. When the question is still open then, the question panel offers
 * the question's own choices — its options (the recommended one marked), the
 * proposed answer when the turn left one, Leave it open — and takes a typed
 * answer too; the choice is written into the Answer line.
 *
 * vscode-free: the file, the config, the sessions and the send come in as
 * {@link QuestionAssistDeps}.
 */

import * as path from 'path';
import { buildAssistPrompt, type AssistPromptsSection } from '../utils/assistPrompts';
import { readMdQuestions, type MdQuestion } from '../utils/mdQuestions';
import { temporarySessionName } from '../utils/questInbox';
import { clickedChoiceId, type AskChoice } from '../utils/askChoices';

export type QuestionAssistUse = 'grillMe' | 'explainInDetail';

export interface QuestionAssistRequest {
    use: QuestionAssistUse;
    /** The document, absolute (the MD Browser's current file). */
    filePath: string;
    questionId: string;
    /** The line (0-based) of the question's Answer marker, to tell apart an id the document has twice. */
    answerLine?: number;
}

export interface QuestionAssistDeps {
    workspaceRoot: string;
    readText(absPath: string): string;
    assistPrompts(): AssistPromptsSection | undefined;
    /** The session the document's work runs in (the process's, else the queue's default). */
    baseSession(): string;
    sessionsFolder(): string;
    hasSession(folder: string, name: string): boolean;
    createSession(folder: string, name: string, opts: { basedOn?: string }): { ok: boolean; error?: string };
    deleteSession(folder: string, name: string): void;
    /** Run the prompt in the ANTHROPIC panel, in `session`. */
    send(prompt: string, session: string, source: string): Promise<{ ok: boolean; error?: string; rejected?: boolean }>;
    /** The question panel (tomAi_askUser with choices); answers the user's reply as the tool answers it. */
    /** The question panel's timeout answer, which is no answer. */
    fallbackPrompt?(): string | undefined;
    askAnswer?(input: { questions: string[]; title: string; choices: AskChoice[] }): Promise<string>;
    /** Write the Answer line (`option`: a letter) or accept the proposal; answers an error text, '' when written. */
    writeAnswer?(filePath: string, question: MdQuestion, answer: AnswerPick): Promise<string>;
    now?(): Date;
}

export type QuestionAssistOutcome =
    | { ok: true; session: string; basedOn: string | null; prompt: string; answered?: AnswerPick; answerError?: string }
    | { ok: false; error: string; session?: string };

const SOURCE: Record<QuestionAssistUse, string> = { grillMe: 'Grill me', explainInDetail: 'Explain in detail' };

/** A TomSpecs (SOM) document carries `<!--[ID]-->` section ids on its headings. */
export function isTomSpecsMarkdown(text: string): boolean {
    return /^#{1,6} .*<!--\[[A-Z][A-Z0-9-]*\]-->/m.test(text);
}

/** The note an explanation is written to: `<document folder>/notes/<question id>-explained.md`, workspace-relative. */
export function explanationFileFor(relativeFile: string, questionId: string): string {
    const dir = path.posix.dirname(relativeFile.split(path.sep).join('/'));
    return path.posix.join(dir === '.' ? '' : dir, 'notes', `${questionId}-explained.md`);
}

/** The question asked about: by id, and by its Answer line when the id is there more than once. */
export function findQuestion(questions: MdQuestion[], id: string, answerLine?: number): MdQuestion | undefined {
    const byId = questions.filter((q) => q.id === id);
    if (byId.length <= 1 || answerLine === undefined) { return byId[0]; }
    return byId.find((q) => q.answerLine === answerLine + 1) ?? byId[0];
}

/** The placeholder values of the prompt: the document, its kind, the question as written, the note's path. */
export function questionAssistValues(text: string, relativeFile: string, question: MdQuestion): Record<string, string> {
    const lines = text.split(/\r\n|\r|\n/);
    const end = question.answerLine ?? question.line;
    return {
        documentKind: isTomSpecsMarkdown(text) ? 'a TomSpecs specification' : 'plain Markdown',
        file: relativeFile,
        questionId: question.id,
        questionBlock: lines.slice(question.line - 1, end).join('\n'),
        explanationFile: explanationFileFor(relativeFile, question.id),
    };
}

/**
 * Run Grill me / Explain in detail on a question: the prompt is built, a
 * temporary session made (based on the document's session when that session
 * exists, else fresh), the turn sent to the panel; the session goes when the
 * turn ends, whatever its outcome.
 */
export async function runQuestionAssist(deps: QuestionAssistDeps, req: QuestionAssistRequest): Promise<QuestionAssistOutcome> {
    let text: string;
    try { text = deps.readText(req.filePath); } catch (e) { return { ok: false, error: `the document cannot be read: ${(e as Error).message}` }; }
    const question = findQuestion(readMdQuestions(text), req.questionId, req.answerLine);
    if (!question) { return { ok: false, error: `the document has no question ${req.questionId}` }; }
    if (!question.open) { return { ok: false, error: `question ${req.questionId} is answered already` }; }
    const rel = path.relative(deps.workspaceRoot, req.filePath).split(path.sep).join('/');
    const prompt = buildAssistPrompt(deps.assistPrompts(), req.use, questionAssistValues(text, rel, question));

    const folder = deps.sessionsFolder();
    const base = deps.baseSession();
    const basedOn = base && deps.hasSession(folder, base) ? base : null;
    const session = temporarySessionName(deps.now?.() ?? new Date(), req.use === 'grillMe' ? 'grill-me' : 'explain');
    const made = deps.createSession(folder, session, basedOn ? { basedOn } : {});
    if (!made.ok) { return { ok: false, error: `the temporary session could not be created: ${made.error ?? 'unknown error'}` }; }
    try {
        const sent = await deps.send(prompt, session, `${SOURCE[req.use]} (${req.questionId})`);
        if (!sent.ok) {
            return { ok: false, session, error: sent.rejected ? 'the ANTHROPIC panel is busy with another request — try again when it is done' : (sent.error ?? 'the send failed') };
        }
    } finally {
        try { deps.deleteSession(folder, session); } catch { /* gone already */ }
    }
    const closing = await closingAnswer(deps, req);
    return { ok: true, session, basedOn, prompt, ...closing };
}

/** What the closing answer step chose: an option, the proposal, a typed answer, or nothing. */
export type AnswerPick =
    | { kind: 'option'; letter: string }
    | { kind: 'proposal' }
    | { kind: 'text'; text: string };

const ACCEPT_PROPOSAL_ID = 'accept-proposal';
const LEAVE_OPEN_ID = 'leave-open';
const optionChoiceId = (letter: string): string => `option-${letter}`;

/** One line of an option's text on a button. */
function shortLabel(text: string, max = 70): string {
    const one = text.replace(/\s+/g, ' ').trim();
    return one.length > max ? `${one.slice(0, max - 1)}…` : one;
}

/**
 * The question panel at the end of an assist: the question, its proposed
 * answer, and its own choices — the proposal first when there is one, then
 * each option (the recommended one marked), then Leave it open. A typed reply
 * is an answer of its own.
 */
export function closingAnswerAsk(question: MdQuestion, file: string): { questions: string[]; title: string; choices: AskChoice[] } {
    const lines = [`${question.id}${question.topic ? ` — ${question.topic}` : ''}: ${question.text}`.trim()];
    if (question.proposed) { lines.push(`Proposed answer (${question.proposed.source}): ${question.proposed.text}`); }
    lines.push('Pick one, or type your own answer. It is written into the Answer line.');
    const choices: AskChoice[] = [];
    if (question.proposed) { choices.push({ id: ACCEPT_PROPOSAL_ID, label: 'Accept the proposed answer', kind: 'answer' }); }
    for (const o of question.options) {
        const recommended = question.recommended === o.letter ? ' (recommended)' : '';
        choices.push({ id: optionChoiceId(o.letter), label: `(${o.letter}) ${shortLabel(o.text)}${recommended}`, kind: 'answer' });
    }
    choices.push({ id: LEAVE_OPEN_ID, label: 'Leave it open', kind: 'answer' });
    return { questions: [lines.join('\n\n')], title: `Answer ${question.id} in ${file}`, choices };
}

/** The reply of the closing panel read back: a choice clicked (choiceAnswer's text), a typed answer, or nothing. */
export function interpretClosingReply(reply: string, question: MdQuestion, fallbackPrompt?: string): AnswerPick | undefined {
    const text = reply.trim();
    if (!text || text.startsWith('askUser error') || (fallbackPrompt && text === fallbackPrompt.trim())) { return undefined; }
    const id = clickedChoiceId(text);
    if (id !== undefined) {
        if (id === ACCEPT_PROPOSAL_ID) { return question.proposed ? { kind: 'proposal' } : undefined; }
        const option = question.options.find((o) => optionChoiceId(o.letter) === id);
        return option ? { kind: 'option', letter: option.letter } : undefined;
    }
    return { kind: 'text', text };
}

/** After the turn: the question still open, the user picks or types its answer and it is written. */
async function closingAnswer(deps: QuestionAssistDeps, req: QuestionAssistRequest): Promise<{ answered?: AnswerPick; answerError?: string }> {
    if (!deps.askAnswer || !deps.writeAnswer) { return {}; }
    let question: MdQuestion | undefined;
    try { question = findQuestion(readMdQuestions(deps.readText(req.filePath)), req.questionId, req.answerLine); } catch { return {}; }
    if (!question?.open) { return {}; }
    const rel = path.relative(deps.workspaceRoot, req.filePath).split(path.sep).join('/');
    const reply = await deps.askAnswer(closingAnswerAsk(question, rel));
    const pick = interpretClosingReply(reply, question, deps.fallbackPrompt?.());
    if (!pick) { return {}; }
    const error = await deps.writeAnswer(req.filePath, question, pick);
    return error ? { answerError: `the answer to ${question.id} could not be written: ${error}` } : { answered: pick };
}
