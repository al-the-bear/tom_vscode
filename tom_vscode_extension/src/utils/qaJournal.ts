/**
 * The **Q&A journal** of a quest: `qa.<host>.<quest>.md` at the quest folder's
 * top level, one file per host, tracked in `_ai` and written only by its host.
 * One block per event, appended in time order:
 *
 *   - `question` — a question put to the user (tomAi_askUser,
 *     tomAi_askUserPicker, tomAi_askInMdBrowser, the intercepted
 *     `AskUserQuestion`, a message written into a running or waiting turn):
 *     the asking session / run / queue item, the title, the questions and the
 *     choices offered. Written when it is asked.
 *   - `answer` — the user's answer to a question, naming the question's id in
 *     `questionId`: the text (the button, the pick, the words; a timeout, a
 *     dismissal, a closed panel as the tools report them) and what produced it.
 *     Written when it comes. A question is never rewritten: a question without
 *     an answer block is one still open (or one whose window went away).
 *   - `answerGiven` — an answer an agent gave with tomAi_answerUser: the title,
 *     the user's question when quoted, the Markdown answer, the suggested
 *     prompts and todos by label.
 *   - `decision` — a process decision (a decision step's jump, a reset, an
 *     aborted level, a move back, a follow-up process): what was decided and
 *     the details.
 *
 * The format. A block starts with a metadata line `<!-- qa {json} -->` (id,
 * kind, ISO time, host and the short fields); a readable heading and summary
 * line follow, then the free texts, each a `#### <label>` line followed by the
 * text quoted with `> `. Every line of a free text is quoted, so no line of a
 * question or an answer — a Markdown heading, a fenced code block, a line that
 * looks like a metadata line — can be read as the start of a block or a
 * section. The reader takes the metadata from the JSON and the texts from the
 * quoted sections; the heading and the summary line are for people.
 *
 * Every host's file of a quest read together, sorted by time, is the quest's
 * journal ({@link combineQaBlocks}).
 *
 * vscode-free: the paths come in as arguments.
 */

import * as fs from 'fs';
import * as path from 'path';

export type QaBlockKind = 'question' | 'answer' | 'answerGiven' | 'decision';

/** One block of a Q&A journal, as written and as read back. */
export interface QaBlock {
    id: string;
    kind: QaBlockKind;
    /** ISO time of the event. */
    time: string;
    /** The host that wrote it (the file's host). */
    host: string;
    session?: string;
    run?: string;
    queueItemId?: string;
    /** `question`: the asking tool (an `answer` repeats it). */
    tool?: string;
    /** `question`, `answerGiven`, `decision`: the title (an `answer` repeats the question's). */
    title?: string;
    /** `question`: the questions, in order. */
    questions?: string[];
    /** `question`: the choices offered (button / item labels). */
    choices?: string[];
    /** `answer`: the question it answers. */
    questionId?: string;
    /** `answer`, `answerGiven`: the text. */
    answer?: string;
    /** `answer`: what produced it (`vscode`, `telegram`, `timeout`, `cancel`, …). */
    source?: string;
    /** `answerGiven`: the user's question, quoted. */
    userQuestion?: string;
    /** `answerGiven`: the answer's id in this machine's answer store. */
    answerId?: string;
    /** `answerGiven`: the suggested prompts, by label. */
    suggestedPrompts?: string[];
    /** `answerGiven`: the suggested todos, as `<id> — <title>`. */
    suggestedTodos?: string[];
    /** `decision`: the details (Markdown). */
    details?: string;
}

/** A question's answer, as the combined view attaches it. */
export interface QaReply {
    id: string;
    time: string;
    host: string;
    text: string;
    source?: string;
}

/** One entry of a quest's combined journal: a question (with its reply when there is one), an answer given or a decision. */
export interface QaItem extends QaBlock {
    kind: 'question' | 'answerGiven' | 'decision';
    reply?: QaReply;
    /** The quest whose journal it is in (set by the reader of several quests). */
    quest?: string;
    /** Read from the old questions journal, whose host is not known. */
    legacy?: boolean;
}

/** The journal's file name for `host`. */
export function qaJournalFileName(quest: string, host: string): string {
    return `qa.${host}.${quest}.md`;
}

/** The host of a journal file name of `quest`, or undefined when the name is no journal of it. */
export function hostOfQaJournal(fileName: string, quest: string): string | undefined {
    const prefix = 'qa.';
    const suffix = `.${quest}.md`;
    if (!fileName.startsWith(prefix) || !fileName.endsWith(suffix)) { return undefined; }
    const host = fileName.slice(prefix.length, fileName.length - suffix.length);
    return host && !host.includes('.') ? host : undefined;
}

/** Preamble written once, when a host's journal file is created. */
export function qaJournalHeader(quest: string, host: string): string {
    return [
        `# Q&A — ${quest} (${host})`,
        '',
        `The questions asked of the user on ${host} with the answers, the answers agents gave`,
        'with tomAi_answerUser and the process decisions, one block each, appended in time order.',
        'The Q&A page (`@T: Q&A`) shows every host\'s journal of the quest together.',
        '',
        '',
    ].join('\n');
}

let counter = 0;

/** A new block id: sortable by time, unique per process and call. */
export function newQaId(prefix: string, now: Date = new Date()): string {
    return `${prefix}${now.getTime().toString(36)}-${process.pid.toString(36)}${(counter++).toString(36)}${Math.random().toString(36).slice(2, 5)}`;
}

const META = /^<!-- qa (\{.*\}) -->$/;
const SECTION = /^#### (.+)$/;

/** Quote a free text: every line behind `> ` (an empty line `>`). */
function quote(text: string): string[] {
    return text.replace(/\r\n/g, '\n').replace(/\n+$/, '').split('\n').map((l) => (l.length ? `> ${l}` : '>'));
}

function unquote(line: string): string {
    if (line === '>') { return ''; }
    return line.startsWith('> ') ? line.slice(2) : line.slice(1);
}

/** One line of text for the readable heading. */
function oneLine(text: string | undefined, max = 160): string {
    const t = (text ?? '').replace(/\s+/g, ' ').trim();
    return t.length > max ? `${t.slice(0, max - 1)}…` : t;
}

const KIND_LABEL: Record<QaBlockKind, string> = {
    question: 'Question',
    answer: 'Answer',
    answerGiven: 'Answer given',
    decision: 'Process decision',
};

/** The metadata line: the short fields as JSON, `<` and `>` escaped so the comment cannot end early. */
function metaLine(b: QaBlock): string {
    const meta: Record<string, unknown> = { id: b.id, kind: b.kind, time: b.time, host: b.host };
    const keys: Array<keyof QaBlock> = ['session', 'run', 'queueItemId', 'tool', 'title', 'choices', 'questionId', 'source', 'answerId', 'suggestedPrompts', 'suggestedTodos'];
    for (const k of keys) {
        const v = b[k];
        if (v === undefined || v === '' || (Array.isArray(v) && v.length === 0)) { continue; }
        meta[k] = v;
    }
    const json = JSON.stringify(meta).replace(/</g, '\\u003c').replace(/>/g, '\\u003e');
    return `<!-- qa ${json} -->`;
}

function section(label: string, text: string): string[] {
    return [`#### ${label}`, '', ...quote(text), ''];
}

/** One appendable block, ending in a blank line. */
export function formatQaBlock(b: QaBlock): string {
    const lines = [metaLine(b), `### ${b.time} · ${KIND_LABEL[b.kind]}${b.title ? `: ${oneLine(b.title)}` : ''}`, ''];
    const facts = [
        b.tool ? `**Tool:** \`${b.tool}\`` : '',
        b.session ? `**Session:** ${b.session}` : '',
        b.run ? `**Run:** ${b.run}` : '',
        b.queueItemId ? `**Queue item:** ${b.queueItemId}` : '',
        b.questionId ? `**Answers:** ${b.questionId}` : '',
        b.source ? `**Via:** ${b.source}` : '',
    ].filter(Boolean);
    if (facts.length) { lines.push(`- ${facts.join(' · ')}`); }
    if (b.choices?.length) { lines.push(`- **Choices:** ${b.choices.map((c) => oneLine(c, 80)).join(' / ')}`); }
    if (b.suggestedPrompts?.length) { lines.push(`- **Suggested prompts:** ${b.suggestedPrompts.map((c) => oneLine(c, 80)).join(' / ')}`); }
    if (b.suggestedTodos?.length) { lines.push(`- **Suggested todos:** ${b.suggestedTodos.map((c) => oneLine(c, 120)).join(' / ')}`); }
    if (lines.length > 3) { lines.push(''); }
    (b.questions ?? []).forEach((q, i) => lines.push(...section(`Question ${i + 1}`, q)));
    if (b.userQuestion !== undefined) { lines.push(...section('User\'s question', b.userQuestion)); }
    if (b.answer !== undefined) { lines.push(...section('Answer', b.answer)); }
    if (b.details !== undefined) { lines.push(...section('Details', b.details)); }
    return `${lines.join('\n')}\n`;
}

const STRING_KEYS = ['session', 'run', 'queueItemId', 'tool', 'title', 'questionId', 'source', 'answerId'] as const;
const LIST_KEYS = ['choices', 'suggestedPrompts', 'suggestedTodos'] as const;
const KINDS: ReadonlySet<string> = new Set(['question', 'answer', 'answerGiven', 'decision']);

function blockOfMeta(raw: string): QaBlock | undefined {
    let meta: Record<string, unknown>;
    try { meta = JSON.parse(raw) as Record<string, unknown>; } catch { return undefined; }
    if (!meta || typeof meta !== 'object') { return undefined; }
    const { id, kind, time, host } = meta as { id?: unknown; kind?: unknown; time?: unknown; host?: unknown };
    if (typeof id !== 'string' || typeof kind !== 'string' || !KINDS.has(kind) || typeof time !== 'string') { return undefined; }
    const b: QaBlock = { id, kind: kind as QaBlockKind, time, host: typeof host === 'string' ? host : '' };
    for (const k of STRING_KEYS) { if (typeof meta[k] === 'string') { b[k] = meta[k] as string; } }
    for (const k of LIST_KEYS) {
        const v = meta[k];
        if (Array.isArray(v)) { b[k] = v.filter((x): x is string => typeof x === 'string'); }
    }
    return b;
}

function applySection(b: QaBlock, label: string, text: string): void {
    const q = /^Question (\d+)$/.exec(label);
    if (q) {
        const questions = b.questions ?? (b.questions = []);
        questions[Number(q[1]) - 1] = text;
        return;
    }
    if (label === 'Answer') { b.answer = text; }
    else if (label === 'User\'s question') { b.userQuestion = text; }
    else if (label === 'Details') { b.details = text; }
}

/** The blocks of one journal file, in file order; text before the first block and broken metadata lines are skipped. */
export function parseQaJournal(text: string): QaBlock[] {
    const blocks: QaBlock[] = [];
    let current: QaBlock | undefined;
    let label: string | undefined;
    let content: string[] | undefined;
    const close = (): void => {
        if (current && label !== undefined && content) { applySection(current, label, content.join('\n')); }
        label = undefined;
        content = undefined;
    };
    for (const line of text.replace(/\r\n/g, '\n').split('\n')) {
        const meta = META.exec(line);
        if (meta) {
            close();
            current = blockOfMeta(meta[1]);
            if (current) { blocks.push(current); }
            continue;
        }
        if (!current) { continue; }
        const sec = SECTION.exec(line);
        if (sec) { close(); label = sec[1].trim(); content = []; continue; }
        if (label === undefined || !content) { continue; }
        if (line.startsWith('>')) { content.push(unquote(line)); continue; }
        // A blank line before the quote starts; anything else after it ends the section.
        if (line.trim() === '' && content.length === 0) { continue; }
        close();
    }
    close();
    for (const b of blocks) { if (b.questions) { b.questions = Array.from(b.questions, (q) => q ?? ''); } }
    return blocks;
}

/**
 * The combined journal of the blocks of every host: each answer attached to
 * its question (the last one wins), an answer whose question is in no file
 * kept as a question of its own; sorted by time, oldest first (stable).
 */
export function combineQaBlocks(blocks: readonly QaBlock[]): QaItem[] {
    const items: QaItem[] = [];
    const byId = new Map<string, QaItem>();
    for (const b of blocks) {
        if (b.kind === 'answer') { continue; }
        const item = { ...b } as QaItem;
        items.push(item);
        byId.set(b.id, item);
    }
    for (const b of blocks) {
        if (b.kind !== 'answer') { continue; }
        const reply: QaReply = { id: b.id, time: b.time, host: b.host, text: b.answer ?? '', ...(b.source ? { source: b.source } : {}) };
        const question = b.questionId ? byId.get(b.questionId) : undefined;
        if (question && question.kind === 'question') {
            if (!question.reply || question.reply.time <= reply.time) { question.reply = reply; }
            continue;
        }
        const { answer: _a, source: _s, questionId: _q, ...rest } = b;
        items.push({ ...rest, id: b.questionId ?? b.id, kind: 'question', reply });
    }
    return sortQaItems(items);
}

/** Oldest first by time; equal times keep their order. */
export function sortQaItems<T extends { time: string }>(items: readonly T[]): T[] {
    return items.map((item, i) => ({ item, i, t: Date.parse(item.time) }))
        .sort((a, b) => ((Number.isFinite(a.t) ? a.t : 0) - (Number.isFinite(b.t) ? b.t : 0)) || a.i - b.i)
        .map((x) => x.item);
}

/**
 * A process decision block from a decision entry as the process code formats
 * it (`## <ISO time> — <what was decided>`, then its bullet lines): the
 * heading's time and text, the rest as the details.
 */
export function processDecisionBlock(entry: string, opts: { host: string; run?: string; id?: string; now?: Date }): QaBlock {
    const lines = entry.replace(/\r\n/g, '\n').replace(/^\n+/, '').split('\n');
    const head = /^##\s+(\S+)\s+—\s+(.*)$/.exec(lines[0] ?? '');
    const now = opts.now ?? new Date();
    const time = head && Number.isFinite(Date.parse(head[1])) ? new Date(Date.parse(head[1])).toISOString() : now.toISOString();
    const title = head ? head[2].trim() : oneLine(lines[0]);
    const details = lines.slice(1).join('\n').trim();
    return {
        id: opts.id ?? newQaId('d', now),
        kind: 'decision',
        time,
        host: opts.host,
        ...(opts.run ? { run: opts.run } : {}),
        title,
        details,
    };
}

// ---------------------------------------------------------------------------
// I/O (vscode-free: the quest folder comes in)
// ---------------------------------------------------------------------------

/** Append blocks to the host's journal of the quest, creating it (with its header) the first time. */
export function appendQaBlocks(questFolder: string, quest: string, host: string, blocks: readonly QaBlock[]): string {
    const file = path.join(questFolder, qaJournalFileName(quest, host));
    fs.mkdirSync(questFolder, { recursive: true });
    const head = fs.existsSync(file) ? '' : qaJournalHeader(quest, host);
    fs.appendFileSync(file, head + blocks.map(formatQaBlock).join('\n') + '\n', 'utf-8');
    return file;
}

/** Whether the host's journal holds a block with id `id`. */
export function qaJournalHasBlock(questFolder: string, quest: string, host: string, id: string): boolean {
    try {
        const text = fs.readFileSync(path.join(questFolder, qaJournalFileName(quest, host)), 'utf-8');
        return text.includes(`{"id":${JSON.stringify(id).replace(/</g, '\\u003c').replace(/>/g, '\\u003e')},`);
    } catch {
        return false;
    }
}

/** Every host's journal file of the quest: `[host, file]`, sorted by host. */
export function qaJournalFiles(questFolder: string, quest: string): Array<[string, string]> {
    let names: string[] = [];
    try { names = fs.readdirSync(questFolder); } catch { return []; }
    return names
        .map((n) => [hostOfQaJournal(n, quest), path.join(questFolder, n)] as const)
        .filter((x): x is readonly [string, string] => x[0] !== undefined)
        .map(([h, f]) => [h, f] as [string, string])
        .sort((a, b) => a[0].localeCompare(b[0]));
}

/** The blocks of every host's journal of the quest. */
export function readQaBlocks(questFolder: string, quest: string): QaBlock[] {
    const out: QaBlock[] = [];
    for (const [host, file] of qaJournalFiles(questFolder, quest)) {
        try {
            for (const b of parseQaJournal(fs.readFileSync(file, 'utf-8'))) { out.push({ ...b, host: b.host || host }); }
        } catch { /* an unreadable file shows nothing */ }
    }
    return out;
}
