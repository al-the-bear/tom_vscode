/**
 * Grill me / Explain in detail on an open question in the MD Browser: the
 * button runs the Assist prompt of that name (chosen on the Status Page)
 * outside the queue, in the ANTHROPIC panel, in a temporary session based on
 * the session the document's work runs in — so it does not wait for a running
 * walk and still knows the context. While the turn works between two
 * interactions with the user, a "thinking" overlay with Cancel shows in the MD
 * Browser panel on the document and in the chat panel (vscimpb65,
 * services/assistProgress.ts); Cancel stops the turn and nothing more is
 * written. The temporary session is removed when the
 * turn ends. When the question is still open then, the question panel offers
 * the question's own choices — its options (the recommended one marked), the
 * proposed answer when the turn left one, Leave it open — and takes a typed
 * answer too; the choice is written into the Answer line. Then the user is told
 * where it went (vscimpb63): a notification naming the file, the question and
 * the line of its Answer, and the same words under the turn's answer in its
 * prompt queue entry — also when the turn answered the question itself, when
 * the question is left open, or when the write failed.
 *
 * vscode-free: the file, the config, the sessions and the send come in as
 * {@link QuestionAssistDeps}.
 */

import * as path from 'path';
import { buildAssistPrompt, type AssistPromptsSection } from '../utils/assistPrompts';
import { readMdQuestions, type MdQuestion } from '../utils/mdQuestions';
import { createTemporarySession } from './temporarySessions';
import { readSingleAnswer, type AskChoice } from '../utils/askChoices';

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
    send(prompt: string, session: string, source: string, hooks?: { onChatItem?(chatItemId: string): void }): Promise<{ ok: boolean; error?: string; rejected?: boolean; chatItemId?: string }>;
    /** The "thinking" overlay of the turn (services/assistProgress.ts); unset: none. */
    progress?: AssistProgressPort;
    /** Add a note under the answer of the turn's prompt queue entry (and the Tom Prompt Queue channel). */
    noteChatItem?(chatItemId: string, note: string): void;
    /** Tell the user how the question ended: a notification; `line` (1-based) is the Answer line, for opening the file there. */
    notify?(n: AssistNotice): void;
    /** The question panel (tomAi_askUser with choices); answers the user's reply as the tool answers it. */
    /** The question panel's timeout answer, which is no answer. */
    fallbackPrompt?(): string | undefined;
    askAnswer?(input: { questions: string[]; title: string; choices: AskChoice[] }): Promise<string>;
    /** Write the Answer line (`option`: a letter) or accept the proposal; answers an error text, '' when written. */
    writeAnswer?(filePath: string, question: MdQuestion, answer: AnswerPick): Promise<string>;
    now?(): Date;
}

/** The overlay of one turn: begun before the send, ended or failed after it; Cancel is the user's. */
export interface AssistProgressPort {
    begin(info: { label: string; questionId: string; filePath: string; file: string }): AssistProgressHandle;
}
export interface AssistProgressHandle {
    /** The prompt queue entry the turn is shown as (its waits for the user hide the overlay). */
    chatItem(chatItemId: string): void;
    /** Whether the user cancelled the turn from the overlay. */
    cancelled(): boolean;
    fail(error: string): void;
    end(): void;
}

export type QuestionAssistOutcome =
    | ({ ok: true; session: string; basedOn: string | null; prompt: string; chatItemId?: string; notice?: AssistNotice; cancelled?: boolean } & ClosingResult)
    | { ok: false; error: string; session?: string };

/** How the question ended after the turn. */
export interface ClosingResult {
    /** The answer the closing step wrote. */
    answered?: AnswerPick;
    answerError?: string;
    /** The turn answered the question itself (no closing step was needed). */
    answeredInTurn?: boolean;
    /** The closing step was shown and nothing was chosen. */
    leftOpen?: boolean;
    /** Where the question is: the workspace-relative file, its id, the 1-based line of its Answer marker. */
    at?: { file: string; id: string; line?: number };
}

/** What the user is told at the end. */
export interface AssistNotice {
    kind: 'info' | 'warning';
    message: string;
    /** Absolute file and 1-based line to open. */
    filePath?: string;
    line?: number;
}

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
    const made = createTemporarySession(deps, deps.baseSession(), req.use === 'grillMe' ? 'grill-me' : 'explain', deps.now?.() ?? new Date());
    if (!made.ok) { return { ok: false, error: made.error }; }
    const { session, basedOn } = made;
    let sentChatItem: string | undefined;
    const progress = deps.progress?.begin({ label: SOURCE[req.use], questionId: question.id, filePath: req.filePath, file: rel });
    let settled = false;
    try {
        const sent = await deps.send(prompt, session, `${SOURCE[req.use]} (${req.questionId})`, { onChatItem: (id) => progress?.chatItem(id) });
        sentChatItem = sent.chatItemId;
        if (progress?.cancelled()) {
            // Cancelled from the overlay: the document stays as the turn left it; no closing answer.
            progress.end();
            settled = true;
            const notice: AssistNotice = { kind: 'info', message: `${SOURCE[req.use]}: cancelled — ${question.id} in ${rel} is left as it is.`, filePath: req.filePath };
            try { deps.notify?.(notice); } catch { /* told or not, it is cancelled */ }
            if (sentChatItem) { try { deps.noteChatItem?.(sentChatItem, notice.message); } catch { /* entry gone */ } }
            return { ok: true, session, basedOn, prompt, cancelled: true, notice, ...(sentChatItem ? { chatItemId: sentChatItem } : {}) };
        }
        if (!sent.ok) {
            const error = sent.rejected ? 'the ANTHROPIC panel is busy with another request — try again when it is done' : (sent.error ?? 'the send failed');
            progress?.fail(error);
            settled = true;
            return { ok: false, session, error };
        }
        progress?.end();
        settled = true;
    } catch (e) {
        progress?.fail(e instanceof Error ? e.message : String(e));
        settled = true;
        throw e;
    } finally {
        if (!settled) { progress?.end(); }
        try { deps.deleteSession(folder, session); } catch { /* gone already */ }
    }
    const closing = await closingAnswer(deps, req);
    const notice = closingNotice(req.use, closing, req.filePath);
    if (notice) {
        try { deps.notify?.(notice); } catch { /* the answer is written either way */ }
        if (sentChatItem) { try { deps.noteChatItem?.(sentChatItem, notice.message); } catch { /* entry gone */ } }
    }
    return { ok: true, session, basedOn, prompt, ...(sentChatItem ? { chatItemId: sentChatItem } : {}), ...closing, ...(notice ? { notice } : {}) };
}

/** The words the user gets once the question is settled for this round (none when the step could not run). */
export function closingNotice(use: QuestionAssistUse, c: ClosingResult, filePath: string): AssistNotice | undefined {
    const who = SOURCE[use];
    const where = c.at ? `${c.at.file}${c.at.line ? `, line ${c.at.line}` : ''}` : '';
    const open = { filePath, ...(c.at?.line ? { line: c.at.line } : {}) };
    if (c.answerError) { return { kind: 'warning', message: `${who}: ${c.answerError}`, ...open }; }
    if (!c.at) { return undefined; }
    if (c.answered) {
        const what = c.answered.kind === 'proposal' ? 'the proposed answer' : c.answered.kind === 'option' ? `option (${c.answered.letter})` : 'your answer';
        return { kind: 'info', message: `${who}: ${what} to ${c.at.id} is written into ${where}.`, ...open };
    }
    if (c.answeredInTurn) { return { kind: 'info', message: `${who}: ${c.at.id} is answered in ${where}.`, ...open }; }
    if (c.leftOpen) { return { kind: 'info', message: `${who}: ${c.at.id} is left open in ${c.at.file}.`, ...open }; }
    return undefined;
}

/** What the closing answer step chose: an option, the proposal, a typed answer, or nothing. */
export type AnswerPick =
    | { kind: 'option'; letter: string; text?: string }
    | { kind: 'proposal'; text?: string }
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
    lines.push('Select one and Send answers — add your own words beside it, or type an answer without one. It is written into the Answer line.');
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
    // A choice selected and sent (with the user's words beside it), a click, or text typed alone.
    const { choiceId: id, text: own } = readSingleAnswer(text);
    const words = own ? { text: own } : {};
    if (id !== undefined) {
        if (id === ACCEPT_PROPOSAL_ID) { return question.proposed ? { kind: 'proposal', ...words } : undefined; }
        const option = question.options.find((o) => optionChoiceId(o.letter) === id);
        if (option) { return { kind: 'option', letter: option.letter, ...words }; }
        // Leave it open: the words alone, if any, are the answer.
        return own ? { kind: 'text', text: own } : undefined;
    }
    return own ? { kind: 'text', text: own } : undefined;
}

/** The question as the file holds it now (by id, near its old Answer line), or undefined. */
function readQuestionNow(deps: QuestionAssistDeps, req: QuestionAssistRequest, answerLine?: number): MdQuestion | undefined {
    try { return findQuestion(readMdQuestions(deps.readText(req.filePath)), req.questionId, answerLine); } catch { return undefined; }
}

/** After the turn: the question still open, the user picks or types its answer and it is written; where it is, read back. */
async function closingAnswer(deps: QuestionAssistDeps, req: QuestionAssistRequest): Promise<ClosingResult> {
    if (!deps.askAnswer || !deps.writeAnswer) { return {}; }
    const rel = path.relative(deps.workspaceRoot, req.filePath).split(path.sep).join('/');
    const question = readQuestionNow(deps, req, req.answerLine);
    if (!question) { return {}; }
    const at = (q: MdQuestion | undefined): ClosingResult['at'] => ({ file: rel, id: req.questionId, ...(q?.answerLine ? { line: q.answerLine } : {}) });
    if (!question.open) { return { answeredInTurn: true, at: at(question) }; }
    const reply = await deps.askAnswer(closingAnswerAsk(question, rel));
    const pick = interpretClosingReply(reply, question, deps.fallbackPrompt?.());
    if (!pick) { return { leftOpen: true, at: at(question) }; }
    const error = await deps.writeAnswer(req.filePath, question, pick);
    if (error) { return { answerError: `the answer to ${question.id} could not be written: ${error}`, at: at(question) }; }
    // Read back where the answer is now (the write may have moved the Answer line, e.g. a removed proposal).
    const after = readQuestionNow(deps, req, typeof question.answerLine === 'number' ? question.answerLine - 1 : undefined);
    return { answered: pick, at: at(after ?? question) };
}
