/**
 * Question tools for plain Markdown — `tomAi_mdQuestions`, `tomAi_mdSetAnswer`,
 * `tomAi_mdProposeAnswer` — on the MD Browser's parser
 * (`media/shared/mdQuestions.js` through `src/utils/mdQuestions.ts`), for any
 * Markdown document written in the review syntax: `> **❓ ID — topic:** text`,
 * options `> - (a) …` (the recommended one bold), `> **Answer:**`.
 *
 * Reads and writes go through the save path every edit takes
 * (`SomDocumentStore.readText` / `writeText`): the editor buffer when the file
 * is open, refused when it is dirty there or changed since `expectedRevision`.
 */

import { SharedToolDefinition } from './shared-tool-registry';
import { SpecToolDeps, failure, json, liveDeps, resolveInput, toWorkspacePath } from './spec-tool-common';
import { MdQuestionError, localDate, proposeMdAnswer, readMdQuestions, setMdAnswer, type MdQuestion } from '../utils/mdQuestions';

/** What the tools need: the workspace root and the save path. */
export type MdQuestionToolDeps = Pick<SpecToolDeps, 'wsRoot' | 'store'> & {
    /** The date a proposal is stamped with (default today, local). */
    today?: () => string;
};

export interface MdQuestionsInput {
    file: string;
    id?: string;
    openOnly?: boolean;
}

export interface MdSetAnswerInput {
    file: string;
    id: string;
    line?: number;
    answer?: string;
    option?: string;
    expectedRevision?: string;
    dryRun?: boolean;
}

export interface MdProposeAnswerInput {
    file: string;
    id: string;
    line?: number;
    answer: string;
    source?: string;
    expectedRevision?: string;
    dryRun?: boolean;
}

function markdownFile(deps: MdQuestionToolDeps, file: string): string {
    if (!file) { throw new Error('`file` is required.'); }
    if (!/\.md$/i.test(file)) { throw new Error(`Not a Markdown file: ${file}`); }
    return resolveInput(deps as SpecToolDeps, file);
}

function refusal(e: unknown): string {
    if (e instanceof MdQuestionError) { return json({ ok: false, code: e.code, error: e.message }); }
    return failure(e);
}

export async function mdQuestionsImpl(deps: MdQuestionToolDeps, input: MdQuestionsInput): Promise<string> {
    try {
        const filePath = markdownFile(deps, input.file);
        const { text, revision } = deps.store.readText(filePath);
        const all = readMdQuestions(text);
        let questions = all;
        if (input.id) { questions = questions.filter((q) => q.id === input.id); }
        if (input.openOnly) { questions = questions.filter((q) => q.open); }
        return json({
            ok: true,
            file: toWorkspacePath(deps as SpecToolDeps, filePath),
            revision,
            total: all.length,
            open: all.filter((q) => q.open).length,
            questions,
        });
    } catch (e) {
        return refusal(e);
    }
}

async function edit(
    deps: MdQuestionToolDeps,
    input: { file: string; expectedRevision?: string; dryRun?: boolean },
    change: (text: string) => { text: string; question: MdQuestion },
): Promise<string> {
    try {
        const filePath = markdownFile(deps, input.file);
        const { text, revision } = deps.store.readText(filePath);
        const next = change(text);
        const saved = await deps.store.writeText(filePath, next.text, {
            baseRevision: revision,
            expectedRevision: input.expectedRevision,
            dryRun: input.dryRun,
        });
        return json({
            ok: true,
            written: saved.written,
            revision: saved.revision,
            file: toWorkspacePath(deps as SpecToolDeps, filePath),
            question: next.question,
            ...(input.dryRun ? { diff: saved.diff } : {}),
        });
    } catch (e) {
        return refusal(e);
    }
}

export async function mdSetAnswerImpl(deps: MdQuestionToolDeps, input: MdSetAnswerInput): Promise<string> {
    if (!input.id) { return json({ ok: false, error: '`id` is required.' }); }
    if (input.answer === undefined && input.option === undefined) {
        return json({ ok: false, error: 'Give `answer` (text; "" clears it), `option` (a letter), or both.' });
    }
    return edit(deps, input, (text) => setMdAnswer(text, input.id, input.answer ?? '', { line: input.line, option: input.option }));
}

export async function mdProposeAnswerImpl(deps: MdQuestionToolDeps, input: MdProposeAnswerInput): Promise<string> {
    if (!input.id) { return json({ ok: false, error: '`id` is required.' }); }
    if (!input.answer || !input.answer.trim()) { return json({ ok: false, error: '`answer` is required: the proposal to write.' }); }
    const date = (deps.today ?? (() => localDate()))();
    return edit(deps, input, (text) => proposeMdAnswer(text, input.id, input.answer, input.source ?? 'agent', date, { line: input.line }));
}

// ---------------------------------------------------------------------------
// Definitions
// ---------------------------------------------------------------------------

const FILE = { type: 'string', description: 'A Markdown (.md) file, workspace-relative or absolute (inside the workspace).' };
const SYNTAX =
    'Question blocks in the review syntax: `> **❓ ID — topic:** text` (in a block of several also `> **ID — topic:** text`), ' +
    'options `> - (a) …` (the recommended one bold, `**(b)**`, or named by `*Recommendation:* (c)`), and `> **Answer:**`. ' +
    'Fenced code is not read. TomSpecs documents: the tomAi_spec* tools.';
const WRITE_NOTE =
    ' Written like every edit: refused when the file is dirty in an editor or has changed since `expectedRevision`; through the editor when open. `dryRun` answers the diff and writes nothing.';
const QUESTION_PICK = {
    id: { type: 'string', description: 'The question id, e.g. `CC-125` (from tomAi_mdQuestions).' },
    line: { type: 'number', description: 'The question header\'s line (1-based), when the id is in the document more than once.' },
};
const REVISION = {
    expectedRevision: { type: 'string', description: 'The `revision` from tomAi_mdQuestions; refused when the file changed since.' },
    dryRun: { type: 'boolean', description: 'Answer the diff and write nothing. Default false.' },
};

export const MD_QUESTIONS_TOOL: SharedToolDefinition<MdQuestionsInput> = {
    name: 'tomAi_mdQuestions',
    displayName: 'Markdown Questions',
    description:
        'The question blocks of a Markdown file, in order: each with `id`, `topic`, `text`, `line` (1-based), `options` ' +
        '(`{letter, text, bold}`), `recommended` (a letter or null), `answer` (as written), `open` (no answer yet), `answerLine` ' +
        '(null when the question has no Answer line) and `proposed` (`{source, date, text, line}` when a proposed answer is ' +
        'under it). `id` and `openOnly` narrow the list; `total` and `open` count the whole document; `revision` is what the ' +
        'writers take as `expectedRevision`. ' + SYNTAX,
    tags: ['markdown', 'questions', 'files', 'tom-ai-chat'],
    readOnly: true,
    inputSchema: {
        type: 'object',
        required: ['file'],
        properties: {
            file: FILE,
            id: { type: 'string', description: 'Only this question id.' },
            openOnly: { type: 'boolean', description: 'Only questions without an answer.' },
        },
    },
    execute: (input) => mdQuestionsImpl(liveDeps(), input),
};

export const MD_SET_ANSWER_TOOL: SharedToolDefinition<MdSetAnswerInput> = {
    name: 'tomAi_mdSetAnswer',
    displayName: 'Markdown: Set Answer',
    description:
        'Write the answer of a question in a Markdown file after its `**Answer:**` (replacing what is there; "" clears it). ' +
        '`option` (a letter of its options) writes `(b)` first, `answer` then follows: `(b) because …`. Several lines stay ' +
        'inside the quote; blank lines are dropped. Refused: an unknown id (the ids are listed), an id that is there twice ' +
        'without `line`, a question without an Answer line, an option it does not have. Answers the question as read back.' +
        WRITE_NOTE + ' ' + SYNTAX,
    tags: ['markdown', 'questions', 'files', 'tom-ai-chat'],
    readOnly: false,
    requiresApproval: true,
    inputSchema: {
        type: 'object',
        required: ['file', 'id'],
        properties: {
            file: FILE,
            ...QUESTION_PICK,
            answer: { type: 'string', description: 'The answer text; "" clears it.' },
            option: { type: 'string', description: 'The letter of the option chosen, e.g. `b`.' },
            ...REVISION,
        },
    },
    execute: (input) => mdSetAnswerImpl(liveDeps(), input),
};

export const MD_PROPOSE_ANSWER_TOOL: SharedToolDefinition<MdProposeAnswerInput> = {
    name: 'tomAi_mdProposeAnswer',
    displayName: 'Markdown: Propose Answer',
    description:
        'Propose an answer to a question in a Markdown file without answering it: written under the question, after its ' +
        'answer and a bare `>` line, as `> **Proposed answer** (<source>, <date>): text` (date today; `source` who proposes, ' +
        'e.g. `grill me`, default `agent`). The user accepts, edits or discards it; the Answer line is left alone. A proposal ' +
        'already under the question is replaced. Refused like tomAi_mdSetAnswer.' + WRITE_NOTE + ' ' + SYNTAX,
    tags: ['markdown', 'questions', 'files', 'tom-ai-chat'],
    readOnly: false,
    requiresApproval: true,
    inputSchema: {
        type: 'object',
        required: ['file', 'id', 'answer'],
        properties: {
            file: FILE,
            ...QUESTION_PICK,
            answer: { type: 'string', description: 'The proposed answer.' },
            source: { type: 'string', description: 'Who proposes, e.g. `grill me`. Default `agent`.' },
            ...REVISION,
        },
    },
    execute: (input) => mdProposeAnswerImpl(liveDeps(), input),
};

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export const MD_QUESTION_TOOLS: SharedToolDefinition<any>[] = [
    MD_QUESTIONS_TOOL,
    MD_SET_ANSWER_TOOL,
    MD_PROPOSE_ANSWER_TOOL,
];
