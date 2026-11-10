/**
 * Questions and answers in plain Markdown, read and written on the MD
 * Browser's own parser (`media/shared/mdQuestions.js`).
 *
 * The parser is webview code: the browser loads it as a classic script. The
 * host runs the same file in a `vm` context and calls its declarations, so a
 * question reads the same in the browser and in the tools
 * (tomAi_mdQuestions, tomAi_mdSetAnswer, tomAi_mdProposeAnswer). This module
 * assembles the parser's pieces into whole questions and edits; it reads and
 * returns text and does no I/O.
 */

import * as fs from 'fs';
import * as path from 'path';
import * as vm from 'vm';

export interface MdQuestionOption {
    letter: string;
    text: string;
    bold: boolean;
}

export interface MdProposedAnswer {
    source: string;
    date: string;
    text: string;
    /** 1-based line of the `**Proposed answer**` head. */
    line: number;
}

export interface MdQuestion {
    id: string;
    topic: string;
    /** The header's text after the topic. */
    text: string;
    /** 1-based line of the header. */
    line: number;
    options: MdQuestionOption[];
    /** The recommended option's letter, or null. */
    recommended: string | null;
    /** The answer as written ('' when none). */
    answer: string;
    /** No answer written yet. */
    open: boolean;
    /** 1-based line of the `**Answer:**` marker; null when the question has none. */
    answerLine: number | null;
    proposed?: MdProposedAnswer;
}

/** The parser's declarations (media/shared/mdQuestions.js). */
interface Parser {
    mdbAnswerMarkers(text: string): Array<{ line: number; column: number }>;
    mdbAnswerAt(lines: string[], line: number, column: number): { text: string; endLine: number };
    mdbWriteAnswer(lines: string[], line: number, column: number, answer: string, at?: string): string;
    mdbQuestionHeads(text: string): Array<{ id: string; line: number; topic: string; text: string }>;
    mdbQuestionOptions(lines: string[], head: number, end: number): { options: MdQuestionOption[]; recommended: string | null };
    mdbOptionAnswer(letter: string): string;
    mdbQuoteDepth(line: string): number;
    mdbProposedAnswerAt(lines: string[], line: number): { source: string; date: string; text: string; line: number; endLine: number } | null;
    mdbProposedAnswerLines(prefix: string, source: string, date: string, text: string): string[];
    mdbProposalEdit(lines: string[], proposalLine: number, action: 'accept' | 'discard', text?: string, at?: string): { startLine: number; endLine: number; expected: string; replacement: string } | null;
}

let parser: Parser | undefined;

/** The shared parser, loaded once. `out/utils/` and `src/utils/` are both two levels below the extension root. */
function load(): Parser {
    if (!parser) {
        const file = path.join(__dirname, '..', '..', 'media', 'shared', 'mdQuestions.js');
        const sandbox: Record<string, unknown> = {};
        vm.createContext(sandbox);
        vm.runInContext(fs.readFileSync(file, 'utf8'), sandbox, { filename: file });
        parser = sandbox as unknown as Parser;
    }
    return parser;
}

/** A document as lines, remembering its line ending so a write keeps it. */
interface Lines { lines: string[]; eol: string }

function split(text: string): Lines {
    return { lines: text.split(/\r\n|\r|\n/), eol: text.includes('\r\n') ? '\r\n' : '\n' };
}

const plain = <T>(v: T): T => JSON.parse(JSON.stringify(v)) as T;

/** Heading lines outside fenced code (0-based): a question never reaches past one. */
function headingLines(lines: string[]): number[] {
    const out: number[] = [];
    let fence: string | null = null;
    lines.forEach((l, i) => {
        const f = /^\s{0,3}(`{3,}|~{3,})/.exec(l);
        if (f) {
            if (fence === null) { fence = f[1][0]; return; }
            if (fence === f[1][0]) { fence = null; return; }
        }
        if (fence === null && /^\s{0,3}#{1,6}(\s|$)/.test(l)) { out.push(i); }
    });
    return out;
}

/** Internal reading of one question: 0-based lines and the answer's extent. */
interface Located {
    question: MdQuestion;
    head: number;
    marker?: { line: number; column: number; endLine: number };
    proposal?: { line: number; endLine: number };
    /** Where a proposal goes when there is none: after the answer and its separator. */
    end: number;
}

function locate(doc: Lines): Located[] {
    const p = load();
    const text = doc.lines.join('\n');
    const heads = plain(p.mdbQuestionHeads(text));
    const markers = plain(p.mdbAnswerMarkers(text));
    const headings = headingLines(doc.lines);
    return heads.map((h, i) => {
        const nextHead = i + 1 < heads.length ? heads[i + 1].line : doc.lines.length;
        const nextHeading = headings.find((l) => l > h.line) ?? doc.lines.length;
        // A header with its answer on the same line ends there for the next one.
        const end = Math.min(nextHeading, nextHead === h.line ? doc.lines.length : nextHead);
        const m = markers.find((x) => x.line >= h.line && x.line < end && (x.line < nextHead || nextHead === h.line));
        const options = plain(p.mdbQuestionOptions(doc.lines, h.line, m ? m.line : end));
        const question: MdQuestion = {
            id: h.id, topic: h.topic, text: h.text, line: h.line + 1,
            options: options.options, recommended: options.recommended,
            answer: '', open: true, answerLine: null,
        };
        const located: Located = { question, head: h.line, end };
        if (m) {
            const answer = plain(p.mdbAnswerAt(doc.lines, m.line, m.column));
            question.answer = answer.text;
            question.open = answer.text.trim() === '';
            question.answerLine = m.line + 1;
            located.marker = { line: m.line, column: m.column, endLine: answer.endLine };
            // The proposal follows the answer, after one bare quote (or blank) line.
            let k = answer.endLine;
            if (k < doc.lines.length && isSeparator(doc.lines[k])) { k++; }
            const proposed = k < end ? plain(p.mdbProposedAnswerAt(doc.lines, k)) : null;
            if (proposed) {
                question.proposed = { source: proposed.source, date: proposed.date, text: proposed.text, line: proposed.line + 1 };
                located.proposal = { line: proposed.line, endLine: proposed.endLine };
            }
        }
        return located;
    });
}

/** A bare quote line (`>`, `> >`) or a blank line. */
function isSeparator(line: string): boolean {
    return /^\s*(?:>\s*)*$/.test(line);
}

/** Every question block of a Markdown document, in order (fenced code is not read). */
export function readMdQuestions(text: string): MdQuestion[] {
    return locate(split(text)).map((l) => l.question);
}

export class MdQuestionError extends Error {
    constructor(readonly code: 'unknownQuestion' | 'ambiguousQuestion' | 'noAnswerLine' | 'unknownOption', message: string) {
        super(message);
    }
}

function pick(found: Located[], id: string, line?: number): Located {
    const byId = found.filter((l) => l.question.id === id);
    if (byId.length === 0) {
        const ids = found.map((l) => l.question.id);
        throw new MdQuestionError('unknownQuestion', `No question ${id} in the document${ids.length ? ` (it has ${ids.join(', ')})` : ' (it has none)'}.`);
    }
    if (line !== undefined) {
        const at = byId.find((l) => l.question.line === line);
        if (!at) { throw new MdQuestionError('unknownQuestion', `Question ${id} is not at line ${line}; it is at line ${byId.map((l) => l.question.line).join(', ')}.`); }
        return at;
    }
    if (byId.length > 1) {
        throw new MdQuestionError('ambiguousQuestion', `Question ${id} is in the document ${byId.length} times (lines ${byId.map((l) => l.question.line).join(', ')}); pass \`line\`.`);
    }
    return byId[0];
}

/**
 * The document with question `id`'s answer written (`""` clears it). With
 * `option`, the answer starts with `(<letter>)`, the letter checked against
 * the question's options. With `at` (a change time) the marker records it,
 * `**Answer (<at>):**`, as the TomSpecs runtime writes a team answer (SOM §11.9.10).
 */
export function setMdAnswer(text: string, id: string, answer: string, opts: { line?: number; option?: string; at?: string } = {}): { text: string; question: MdQuestion } {
    const doc = split(text);
    const target = pick(locate(doc), id, opts.line);
    if (!target.marker) {
        throw new MdQuestionError('noAnswerLine', `Question ${id} has no **Answer:** line to write to.`);
    }
    let value = answer;
    if (opts.option !== undefined) {
        const letter = opts.option.trim().replace(/^\(|\)$/g, '');
        if (!target.question.options.some((o) => o.letter === letter)) {
            throw new MdQuestionError('unknownOption', `Question ${id} has no option (${letter}); its options are ${target.question.options.map((o) => `(${o.letter})`).join(' ') || 'none'}.`);
        }
        value = `${load().mdbOptionAnswer(letter)}${answer.trim() ? ` ${answer.trim()}` : ''}`;
    }
    const m = target.marker;
    const written = load().mdbWriteAnswer(doc.lines, m.line, m.column, value, opts.at).split('\n');
    doc.lines.splice(m.line, m.endLine - m.line, ...written);
    const next = doc.lines.join(doc.eol);
    return { text: next, question: pick(locate(split(next)), id, target.question.line).question };
}

/**
 * The document with a proposed answer under question `id`, after its answer:
 * `> **Proposed answer** (<source>, <date>): text`, separated from the answer
 * by a bare quote line. A proposal already there is replaced.
 */
export function proposeMdAnswer(
    text: string, id: string, answer: string, source: string, date: string, opts: { line?: number } = {},
): { text: string; question: MdQuestion } {
    const p = load();
    const doc = split(text);
    const target = pick(locate(doc), id, opts.line);
    if (!target.marker) {
        throw new MdQuestionError('noAnswerLine', `Question ${id} has no **Answer:** line to propose under.`);
    }
    const answerLine = doc.lines[target.marker.line];
    const depth = p.mdbQuoteDepth(answerLine);
    const quote = depth > 0 ? (/^\s*(?:>\s?)+/.exec(answerLine)?.[0] ?? '> ') : '';
    const prefix = depth > 0 ? quote.replace(/\s*$/, ' ') : '> ';
    const separator = depth > 0 ? quote.replace(/\s*$/, '') : '';
    const lines = p.mdbProposedAnswerLines(prefix, source, date, answer).slice();
    if (target.proposal) {
        doc.lines.splice(target.proposal.line, target.proposal.endLine - target.proposal.line, ...lines);
    } else {
        const at = target.marker.endLine;
        const insert = [separator, ...lines];
        // What follows must not run on into the proposal's paragraph.
        const after = doc.lines[at];
        if (after !== undefined && !isSeparator(after)) { insert.push(separator); }
        doc.lines.splice(at, 0, ...insert);
    }
    const next = doc.lines.join(doc.eol);
    return { text: next, question: pick(locate(split(next)), id, target.question.line).question };
}

/**
 * Settle the proposed answer under question `id` — what the MD Browser's
 * Accept / Edit / Discard do, on the same parser: `accept` writes it (or
 * `text`, as edited) into the Answer line and removes it; `discard` removes it.
 * An accepted answer records `opts.at` like setMdAnswer.
 */
export function settleProposedAnswer(
    text: string, id: string, action: 'accept' | 'discard', opts: { line?: number; text?: string; at?: string } = {},
): { text: string; question: MdQuestion } {
    const doc = split(text);
    const target = pick(locate(doc), id, opts.line);
    if (!target.proposal) {
        throw new MdQuestionError('unknownQuestion', `Question ${id} has no proposed answer.`);
    }
    const edit = load().mdbProposalEdit(doc.lines, target.proposal.line, action, opts.text, opts.at);
    if (!edit) { throw new MdQuestionError('noAnswerLine', `The proposed answer of ${id} is not right under its Answer line.`); }
    doc.lines.splice(edit.startLine, edit.endLine - edit.startLine, ...edit.replacement.split('\n'));
    const next = doc.lines.join(doc.eol);
    return { text: next, question: pick(locate(split(next)), id, target.question.line).question };
}

/** Today as YYYY-MM-DD (local time), the date a proposal is stamped with. */
export function localDate(now = new Date()): string {
    const pad = (n: number) => String(n).padStart(2, '0');
    return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
}
