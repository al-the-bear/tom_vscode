/**
 * Format version 11, steps `notes`, `memory` and `qa-journal` (see context.ts): the quest notes, the quest
 * memory and the Q&A journal into the layout of ai_format_migration.md § 3.2. Per quest of `ctx.quests`:
 *
 *   - `notes`: `quest-notes.<q>.md` → `notes/quest-notes.md` (utils/notesFiles.ts). A target with other
 *     content gets the old text appended under `## From quest-notes.<q>.md`; a target that holds the old
 *     text already only loses the old file.
 *   - `memory`: `_ai/memory/<q>/` → `quests/<q>/memory/` (services/questMemoryFiles.ts), no session level.
 *     The files of the default run's default session (`default@default`, the bare `default`, and flat files
 *     directly in `_ai/memory/<q>/`) are the quest's curated memory: each merges into the curated file of
 *     the same name, the lines and `##` sections the target does not hold yet appended. Every other
 *     session's files become candidates of this host (`candidates.<host>.md`, the format of
 *     formatCandidateText), one per fact, naming their session and the curated file they belong to; a fact
 *     keeps its own stamp, an unstamped one gets the file's modification time and this host. The old
 *     history snapshots of `_ai/memory/<q>/history/` move to `quests/<q>/history/`. Then `_ai/memory/<q>/`
 *     goes, and `_ai/memory/` once empty. This host's candidates file under the machine's host name
 *     (`candidates.<hostname>.md`, the name before the host slug) merges into `candidates.<host>.md`.
 *   - `qa-journal`: `questions.<q>.md` (the old questions journal) and `decisions.<q>.md` (the old
 *     decisions journal) → blocks of this host's Q&A journal `qa.<host>.<q>.md` (utils/qaJournal.ts):
 *     each old question entry a `question` block with its `answer` block, each decision entry a `decision`
 *     block, merged with the journal's blocks in time order. The block ids are derived from the entry's
 *     text, so an entry is written once however often the step runs. Then the old files go.
 *
 * Idempotent: the old places are gone after an apply, and a second run finds nothing. A target that cannot
 * be merged is a problem and its old file stays.
 */

import * as crypto from 'crypto';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import { DEFAULT_QUEST_NOTES_FILE, QUEST_NOTES_FOLDER } from '../notesFiles';
import {
    DEFAULT_MEMORY_FILE, candidatesFileName, formatCandidateText, questMemoryFolder, safeHostForFile,
} from '../../services/questMemoryFiles';
import {
    formatQaBlock, parseQaJournal, processDecisionBlock, qaJournalFileName, qaJournalHeader, sortQaItems,
    type QaBlock,
} from '../qaJournal';
import { DEFAULT_RUN_SESSION, LEGACY_DEFAULT_SESSION } from '../runSessions';
import type { V11Context } from './context';

export function migrateV11NotesMemoryQa(ctx: V11Context): void {
    migrateV11NotesMemoryQaWith(ctx, os.hostname());
}

/** The step with the machine's host name given (the name this host's candidates file had before the host slug). */
export function migrateV11NotesMemoryQaWith(ctx: V11Context, hostName: string): void {
    for (const quest of ctx.quests) {
        migrateNotes(ctx, quest);
        migrateMemory(ctx, quest, hostName);
        migrateQaJournal(ctx, quest);
    }
    const memoryRoot = path.join(ctx.aiRoot, 'memory');
    if (isEmptyDir(memoryRoot)) {
        ctx.change('(workspace)', 'memory', `remove ${ctx.rel(memoryRoot)} (empty)`);
        if (ctx.apply) { fs.rmdirSync(memoryRoot); }
    }
}

// ============================================================================
// Helpers
// ============================================================================

function readText(file: string): string | undefined {
    try { return fs.readFileSync(file, 'utf8'); } catch { return undefined; }
}

function isFile(p: string): boolean {
    try { return fs.statSync(p).isFile(); } catch { return false; }
}

function isDir(p: string): boolean {
    try { return fs.statSync(p).isDirectory(); } catch { return false; }
}

function isEmptyDir(p: string): boolean {
    try { return fs.statSync(p).isDirectory() && fs.readdirSync(p).length === 0; } catch { return false; }
}

/** Files below `root`, relative, `/`-separated, sorted. */
function filesBelow(root: string, sub = ''): string[] {
    let names: fs.Dirent[];
    try { names = fs.readdirSync(sub ? path.join(root, sub) : root, { withFileTypes: true }); } catch { return []; }
    const out: string[] = [];
    for (const e of names) {
        const rel = sub ? `${sub}/${e.name}` : e.name;
        if (e.isDirectory()) { out.push(...filesBelow(root, rel)); } else if (e.isFile()) { out.push(rel); }
    }
    return out.sort();
}

/** Remove the empty folders below `root` and `root` itself when it ends up empty. */
function removeEmptyDirs(root: string): void {
    let names: fs.Dirent[];
    try { names = fs.readdirSync(root, { withFileTypes: true }); } catch { return; }
    for (const e of names) { if (e.isDirectory()) { removeEmptyDirs(path.join(root, e.name)); } }
    if (isEmptyDir(root)) { fs.rmdirSync(root); }
}

function writeFile(file: string, text: string): void {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, text, 'utf8');
}

const FENCE = /^\s*(```|~~~)/;

// ============================================================================
// notes
// ============================================================================

/** The heading the old notes stand under when they are appended to an existing notes file. */
export function oldNotesHeading(quest: string): string {
    return `## From quest-notes.${quest}.md`;
}

function migrateNotes(ctx: V11Context, quest: string): void {
    const questFolder = path.join(ctx.aiRoot, 'quests', quest);
    const from = path.join(questFolder, `quest-notes.${quest}.md`);
    if (!isFile(from)) { return; }
    const to = path.join(questFolder, QUEST_NOTES_FOLDER, DEFAULT_QUEST_NOTES_FILE);
    if (fs.existsSync(to) && !isFile(to)) {
        ctx.problem(quest, 'notes', `${ctx.rel(to)} is not a file: ${ctx.rel(from)} stays where it is`);
        return;
    }
    if (!fs.existsSync(to)) {
        ctx.change(quest, 'notes', `move ${ctx.rel(from)} -> ${ctx.rel(to)}`);
        if (ctx.apply) {
            fs.mkdirSync(path.dirname(to), { recursive: true });
            fs.renameSync(from, to);
        }
        return;
    }
    const old = (readText(from) ?? '').replace(/\r\n/g, '\n').trim();
    const target = (readText(to) ?? '').replace(/\r\n/g, '\n');
    if (!old || target.includes(old)) {
        ctx.change(quest, 'notes', `remove ${ctx.rel(from)} (${ctx.rel(to)} holds its text)`);
        if (ctx.apply) { fs.unlinkSync(from); }
        return;
    }
    ctx.change(quest, 'notes', `append ${ctx.rel(from)} to ${ctx.rel(to)} under "${oldNotesHeading(quest)}", then remove it`);
    if (ctx.apply) {
        const sep = target.length === 0 ? '' : target.endsWith('\n\n') ? '' : target.endsWith('\n') ? '\n' : '\n\n';
        fs.writeFileSync(to, `${target}${sep}${oldNotesHeading(quest)}\n\n${old}\n`, 'utf8');
        fs.unlinkSync(from);
    }
}

// ============================================================================
// memory
// ============================================================================

/** The sessions whose old files are the quest's curated memory (flat files count too: session ''). */
const CURATED_SESSIONS: ReadonlySet<string> = new Set(['', DEFAULT_RUN_SESSION, LEGACY_DEFAULT_SESSION]);

/** The old memory folder's history snapshots (`_ai/memory/<q>/history/`), which move to the quest's `history/`. */
const OLD_HISTORY_FOLDER = 'history';

/** A memory file as units: the lines before the first `##` heading, then the `##` sections. */
interface MemorySection {
    heading: string;
    /** The heading line as written. */
    headingLine: string;
    lines: string[];
}
interface MemoryUnits {
    head: string[];
    sections: MemorySection[];
}

const SECTION_HEADING = /^##\s+(.+?)\s*$/;

function normHeading(h: string): string {
    return h.trim().replace(/\s+/g, ' ').toLowerCase();
}

export function parseMemoryUnits(text: string): MemoryUnits {
    const units: MemoryUnits = { head: [], sections: [] };
    let fenced = false;
    let current: MemorySection | undefined;
    for (const line of text.replace(/\r\n/g, '\n').split('\n')) {
        const heading = !fenced ? SECTION_HEADING.exec(line) : null;
        if (FENCE.test(line)) { fenced = !fenced; }
        if (heading) {
            current = { heading: heading[1], headingLine: line, lines: [] };
            units.sections.push(current);
            continue;
        }
        (current ? current.lines : units.head).push(line);
    }
    return units;
}

function trimBlankEnds(lines: string[]): string[] {
    let a = 0;
    let b = lines.length;
    while (a < b && !lines[a].trim()) { a++; }
    while (b > a && !lines[b - 1].trim()) { b--; }
    return lines.slice(a, b);
}

function renderMemoryUnits(units: MemoryUnits): string {
    const parts: string[] = [];
    const head = trimBlankEnds(units.head);
    if (head.length) { parts.push(head.join('\n')); }
    for (const s of units.sections) {
        const body = trimBlankEnds(s.lines);
        parts.push(body.length ? `${s.headingLine}\n\n${body.join('\n')}` : s.headingLine);
    }
    return parts.length ? `${parts.join('\n\n')}\n` : '';
}

/**
 * Merge an old curated memory file into the curated file of the same name: every line before the first
 * `##` heading the target does not hold is added to the target's lines before its first heading; a section
 * whose heading the target lacks is appended whole; a section the target has gets the lines it lacks at
 * its end. Answers the merged text and how many lines / sections were added (0: the target holds it all).
 */
export function mergeCuratedMemory(target: string, old: string): { text: string; added: number } {
    const t = parseMemoryUnits(target);
    const o = parseMemoryUnits(old);
    const has = (lines: string[], line: string): boolean => lines.some((l) => l.trim() === line.trim());
    let added = 0;
    const allTargetLines = [...t.head, ...t.sections.flatMap((s) => [s.headingLine, ...s.lines])];
    const headAdds = o.head.filter((l) => l.trim() && !has(allTargetLines, l));
    if (headAdds.length) {
        t.head = [...trimBlankEnds(t.head), ...headAdds];
        added += headAdds.length;
    }
    for (const s of o.sections) {
        const match = t.sections.find((x) => normHeading(x.heading) === normHeading(s.heading));
        if (!match) {
            t.sections.push({ ...s, lines: [...s.lines] });
            added++;
            continue;
        }
        const missing = s.lines.filter((l) => l.trim() && !has(match.lines, l));
        if (missing.length) {
            match.lines = [...trimBlankEnds(match.lines), '', ...missing];
            added += missing.length;
        }
    }
    return { text: added ? renderMemoryUnits(t) : target, added };
}

/** A stamped memory entry, `- <iso> [<host>] <text>` (services/memory-service.ts). */
const ENTRY_RE = /^-\s+(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:?\d{2}))\s+\[([^\]]*)\]\s+(.+)$/;

interface Entry { ts: string; host: string; text: string }

/**
 * The facts of an old session's memory file, one per entry: a stamped line keeps its stamp, any other
 * line before the first `##` heading (a `#` title left out) is a fact of its own; in a `##` section every
 * bullet and every other paragraph is a fact, its text led by the section's heading. Facts without a stamp
 * get `ts` and `host`.
 */
export function memoryFacts(text: string, ts: string, host: string): Entry[] {
    const out: Entry[] = [];
    const add = (line: string, lead?: string): void => {
        const stamped = ENTRY_RE.exec(line.trim());
        const body = (stamped ? stamped[3] : line.trim().replace(/^[-*+]\s+/, '')).replace(/\s+/g, ' ').trim();
        if (!body) { return; }
        const textOut = lead ? `${lead} — ${body}` : body;
        out.push(stamped ? { ts: stamped[1], host: stamped[2], text: textOut } : { ts, host, text: textOut });
    };
    const units = parseMemoryUnits(text);
    for (const line of units.head) {
        if (!line.trim() || /^#\s/.test(line)) { continue; }
        add(line);
    }
    for (const s of units.sections) {
        let paragraph: string[] = [];
        const flush = (): void => {
            if (paragraph.length) { add(paragraph.join(' '), s.heading); }
            paragraph = [];
        };
        for (const line of s.lines) {
            if (!line.trim()) { flush(); continue; }
            if (/^\s*[-*+]\s+/.test(line)) { flush(); add(line, s.heading); continue; }
            paragraph.push(line.trim());
        }
        flush();
    }
    return out;
}

function parseEntries(text: string): { entries: Entry[]; other: string[] } {
    const entries: Entry[] = [];
    const other: string[] = [];
    for (const line of text.replace(/\r\n/g, '\n').split('\n')) {
        if (!line.trim()) { continue; }
        const m = ENTRY_RE.exec(line);
        if (m) { entries.push({ ts: m[1], host: m[2], text: m[3].trim() }); } else { other.push(line); }
    }
    return { entries, other };
}

/** Dedup by (ts, text), newest first: the candidates file's order (services/memory-service.ts). */
function serialiseEntries(entries: Entry[]): string {
    const seen = new Map<string, Entry>();
    for (const e of entries) { if (!seen.has(`${e.ts}\u0000${e.text}`)) { seen.set(`${e.ts}\u0000${e.text}`, e); } }
    const list = [...seen.values()].sort((a, b) => b.ts.localeCompare(a.ts));
    return list.length ? `${list.map((e) => `- ${e.ts} [${e.host}] ${e.text}`).join('\n')}\n` : '';
}

function migrateMemory(ctx: V11Context, quest: string, hostName: string): void {
    const questFolder = path.join(ctx.aiRoot, 'quests', quest);
    const memoryFolder = questMemoryFolder(path.join(ctx.aiRoot, 'quests'), quest);
    const ownCandidates = path.join(memoryFolder, candidatesFileName(ctx.hostSlug));
    // The texts of the targets as this run leaves them (a dry run writes nothing, so it keeps them here).
    const pending = new Map<string, string>();
    const current = (file: string): string | undefined => pending.get(file) ?? readText(file);
    const newCandidates: Entry[] = [];
    const candidateSources: string[] = [];

    // This host's candidates file under the machine's host name.
    const oldNamed = candidatesFileName(safeHostForFile(hostName));
    const oldNamedFile = path.join(memoryFolder, oldNamed);
    if (oldNamed !== path.basename(ownCandidates) && isFile(oldNamedFile)) {
        const parsed = parseEntries(readText(oldNamedFile) ?? '');
        if (parsed.other.length) {
            ctx.problem(quest, 'memory', `${ctx.rel(oldNamedFile)} holds lines that are no candidate entries: it stays`);
        } else {
            newCandidates.push(...parsed.entries);
            candidateSources.push(oldNamedFile);
        }
    }

    const oldRoot = path.join(ctx.aiRoot, 'memory', quest);
    const removals: string[] = [];
    let kept = false;
    if (isDir(oldRoot)) {
        for (const rel of filesBelow(oldRoot)) {
            const from = path.join(oldRoot, ...rel.split('/'));
            const parts = rel.split('/');
            if (parts[0] === OLD_HISTORY_FOLDER && parts.length > 1) {
                const to = path.join(questFolder, 'history', ...parts.slice(1));
                if (!fs.existsSync(to)) {
                    ctx.change(quest, 'memory', `move ${ctx.rel(from)} -> ${ctx.rel(to)}`);
                    if (ctx.apply) { fs.mkdirSync(path.dirname(to), { recursive: true }); fs.renameSync(from, to); }
                } else if (isFile(to) && fs.readFileSync(from).equals(fs.readFileSync(to))) {
                    ctx.change(quest, 'memory', `remove ${ctx.rel(from)} (identical to ${ctx.rel(to)})`);
                    removals.push(from);
                } else {
                    ctx.problem(quest, 'memory', `${ctx.rel(from)}: ${ctx.rel(to)} exists with other content; both kept`);
                    kept = true;
                }
                continue;
            }
            if (!rel.toLowerCase().endsWith('.md')) {
                ctx.problem(quest, 'memory', `${ctx.rel(from)} is no memory file (.md): it stays`);
                kept = true;
                continue;
            }
            const session = parts.length > 1 ? parts[0] : '';
            const file = parts.length > 1 ? parts.slice(1).join('/') : parts[0];
            const text = readText(from) ?? '';
            if (CURATED_SESSIONS.has(session)) {
                const to = path.join(memoryFolder, ...file.split('/'));
                const existing = current(to);
                if (existing === undefined) {
                    ctx.change(quest, 'memory', `move ${ctx.rel(from)} -> ${ctx.rel(to)}`);
                    pending.set(to, text);
                } else {
                    const merged = mergeCuratedMemory(existing, text);
                    ctx.change(quest, 'memory', merged.added
                        ? `merge ${ctx.rel(from)} into ${ctx.rel(to)} (${merged.added} entr${merged.added === 1 ? 'y' : 'ies'} added)`
                        : `remove ${ctx.rel(from)} (${ctx.rel(to)} holds its entries)`);
                    if (merged.added) { pending.set(to, merged.text); }
                }
                removals.push(from);
                continue;
            }
            const mtime = new Date(fs.statSync(from).mtimeMs).toISOString();
            const facts = memoryFacts(text, mtime, ctx.hostSlug)
                .map((f) => ({ ...f, text: formatCandidateText({ session, targetFile: file || DEFAULT_MEMORY_FILE, text: f.text }) }));
            ctx.change(quest, 'memory', `${facts.length} fact${facts.length === 1 ? '' : 's'} of ${ctx.rel(from)} -> candidates in ${ctx.rel(ownCandidates)} (session ${session})`);
            newCandidates.push(...facts);
            removals.push(from);
        }
    }

    if (newCandidates.length || candidateSources.length) {
        const parsed = parseEntries(current(ownCandidates) ?? '');
        if (parsed.other.length) {
            ctx.problem(quest, 'memory', `${ctx.rel(ownCandidates)} holds lines that are no candidate entries: the quest's old memory stays as it is`);
            return;
        }
        pending.set(ownCandidates, serialiseEntries([...parsed.entries, ...newCandidates]));
        for (const src of candidateSources) {
            ctx.change(quest, 'memory', `merge ${ctx.rel(src)} into ${ctx.rel(ownCandidates)}, then remove it`);
            removals.push(src);
        }
    }

    if (isDir(oldRoot) && !kept) { ctx.change(quest, 'memory', `remove ${ctx.rel(oldRoot)}`); }
    if (!ctx.apply) { return; }
    for (const [file, text] of pending) { writeFile(file, text); }
    for (const file of removals) { try { fs.unlinkSync(file); } catch { /* gone already */ } }
    removeEmptyDirs(oldRoot);
}

// ============================================================================
// qa-journal
// ============================================================================

/** One entry of the old questions journal `questions.<q>.md`. */
export interface OldQuestionEntry {
    /** The entry's lines as written (the block id is derived from them). */
    raw: string;
    time: string;
    title: string;
    tool?: string;
    run?: string;
    answeredAt?: string;
    source?: string;
    questions: string[];
    /** Undefined: the entry has no answer section. */
    answer?: string;
}

const OLD_ENTRY = /^## (\S+) — (.*)$/;

function isoOf(s: string): string | undefined {
    const t = Date.parse(s);
    return Number.isFinite(t) ? new Date(t).toISOString() : undefined;
}

/** Split an old journal into its entries: each starts with a `## <ISO time> — ` heading outside fenced code. */
function splitOldEntries(text: string): string[][] {
    const entries: string[][] = [];
    let current: string[] | undefined;
    let fenced = false;
    for (const line of text.replace(/\r\n/g, '\n').split('\n')) {
        const head = !fenced ? OLD_ENTRY.exec(line) : null;
        if (head && isoOf(head[1])) {
            current = [line];
            entries.push(current);
            continue;
        }
        if (FENCE.test(line) && current) { fenced = !fenced; }
        current?.push(line);
    }
    return entries.map((e) => trimBlankEnds(e));
}

/**
 * The entries of an old questions journal: a `## <ISO> — <title>` heading, the `Tool` / `Run` /
 * `Answered` bullets, a numbered `### Questions` list (a question's further lines follow it, fenced code
 * included) and the quoted `### Answer`.
 */
export function parseOldQuestionsJournal(text: string): OldQuestionEntry[] {
    return splitOldEntries(text).map((lines) => {
        const head = OLD_ENTRY.exec(lines[0])!;
        const e: OldQuestionEntry = { raw: lines.join('\n'), time: isoOf(head[1])!, title: head[2].trim(), questions: [] };
        let part: 'head' | 'questions' | 'answer' = 'head';
        let fenced = false;
        const answer: string[] = [];
        for (const line of lines.slice(1)) {
            if (!fenced && line === '### Questions' && part === 'head') { part = 'questions'; continue; }
            if (!fenced && line === '### Answer' && part !== 'answer') { part = 'answer'; e.answer = ''; continue; }
            if (part === 'head') {
                const tool = /^- \*\*Tool:\*\* `([^`]*)`/.exec(line);
                if (tool) { e.tool = tool[1]; continue; }
                const run = /^- \*\*Run:\*\* (.+)$/.exec(line);
                if (run) { e.run = run[1].trim(); continue; }
                const answered = /^- \*\*Answered:\*\* (\S+) via ([^,]+)/.exec(line);
                if (answered) { e.answeredAt = isoOf(answered[1]); e.source = answered[2].trim(); }
                continue;
            }
            if (part === 'questions') {
                const q = !fenced ? /^(\d+)\. (.*)$/.exec(line) : null;
                if (q && Number(q[1]) === e.questions.length + 1) { e.questions.push(q[2]); }
                else if (e.questions.length) { e.questions[e.questions.length - 1] += `\n${line}`; }
                if (FENCE.test(line)) { fenced = !fenced; }
                continue;
            }
            if (line.startsWith('>')) { answer.push(line === '>' ? '' : line.replace(/^> ?/, '')); }
        }
        e.questions = e.questions.map((q) => q.replace(/\n+$/, ''));
        if (e.answer !== undefined) {
            const a = answer.join('\n').replace(/\n+$/, '');
            e.answer = a === '_(no answer text)_' ? '' : a;
        }
        return e;
    });
}

function hashOf(text: string): string {
    return crypto.createHash('sha1').update(text).digest('hex').slice(0, 12);
}

/** The Q&A blocks of an old questions entry: the question and, when it was answered, its answer. */
export function questionEntryBlocks(e: OldQuestionEntry, host: string): QaBlock[] {
    const h = hashOf(e.raw);
    const question: QaBlock = {
        id: `q-v11-${h}`,
        kind: 'question',
        time: e.time,
        host,
        ...(e.run ? { run: e.run } : {}),
        ...(e.tool ? { tool: e.tool } : {}),
        ...(e.title && e.title !== e.tool ? { title: e.title } : {}),
        questions: [...e.questions],
    };
    if (e.answer === undefined && !e.answeredAt) { return [question]; }
    return [question, {
        id: `a-v11-${h}`,
        kind: 'answer',
        time: e.answeredAt ?? e.time,
        host,
        ...(e.run ? { run: e.run } : {}),
        ...(e.tool ? { tool: e.tool } : {}),
        ...(question.title ? { title: question.title } : {}),
        questionId: question.id,
        ...(e.source ? { source: e.source } : {}),
        answer: e.answer ?? '',
    }];
}

/** The decision blocks of an old decisions journal `decisions.<q>.md`: one per `## <ISO> — ` entry. */
export function decisionEntryBlocks(text: string, host: string): QaBlock[] {
    return splitOldEntries(text).map((lines) => {
        const raw = lines.join('\n');
        return processDecisionBlock(raw, { host, id: `d-v11-${hashOf(raw)}` });
    });
}

/** Whether an old journal holds anything besides its title and preamble when it has no entries. */
function onlyPreamble(text: string, title: RegExp): boolean {
    const lines = text.replace(/\r\n/g, '\n').split('\n').filter((l) => l.trim());
    return lines.length === 0 || title.test(lines[0]);
}

/**
 * Merge blocks into a journal's text: the blocks it holds already (by id) are left out, the others go
 * between the existing blocks by time (an existing block's text stays as written). Answers the new text and
 * how many blocks were added.
 */
export function mergeQaJournalText(existing: string | undefined, header: string, blocks: readonly QaBlock[]): { text: string; added: number } {
    const chunks: Array<{ time: string; text: string }> = [];
    let preamble = header;
    if (existing !== undefined) {
        const lines = existing.replace(/\r\n/g, '\n').split('\n');
        const first = lines.findIndex((l) => /^<!-- qa \{.*\} -->$/.test(l));
        preamble = (first < 0 ? lines : lines.slice(0, first)).join('\n');
        if (first >= 0) {
            let cur: string[] = [];
            const flush = (): void => {
                if (!cur.length) { return; }
                const block = parseQaJournal(cur.join('\n'))[0];
                const body = cur.join('\n').replace(/\s+$/, '');
                if (block) { chunks.push({ time: block.time, text: body }); }
                else if (chunks.length) { chunks[chunks.length - 1].text += `\n\n${body}`; }
                else { preamble += `\n${body}`; }
                cur = [];
            };
            for (const line of lines.slice(first)) {
                if (/^<!-- qa \{.*\} -->$/.test(line)) { flush(); }
                cur.push(line);
            }
            flush();
        }
    }
    const have = new Set((existing !== undefined ? parseQaJournal(existing) : []).map((b) => b.id));
    const fresh = blocks.filter((b) => {
        if (have.has(b.id)) { return false; }
        have.add(b.id);
        return true;
    });
    if (!fresh.length) { return { text: existing ?? '', added: 0 }; }
    const all = sortQaItems([...chunks, ...fresh.map((b) => ({ time: b.time, text: formatQaBlock(b).replace(/\s+$/, '') }))]);
    return { text: `${preamble.replace(/\s+$/, '')}\n\n${all.map((c) => c.text).join('\n\n')}\n`, added: fresh.length };
}

function migrateQaJournal(ctx: V11Context, quest: string): void {
    const questFolder = path.join(ctx.aiRoot, 'quests', quest);
    const questions = path.join(questFolder, `questions.${quest}.md`);
    const decisions = path.join(questFolder, `decisions.${quest}.md`);
    if (!isFile(questions) && !isFile(decisions)) { return; }
    const journal = path.join(questFolder, qaJournalFileName(quest, ctx.hostSlug));
    const blocks: QaBlock[] = [];
    const sources: string[] = [];

    if (isFile(questions)) {
        const text = readText(questions) ?? '';
        const entries = parseOldQuestionsJournal(text);
        if (!entries.length && !onlyPreamble(text, /^# Questions\b/)) {
            ctx.problem(quest, 'qa-journal', `${ctx.rel(questions)} holds no entry the step can read: it stays`);
        } else {
            entries.forEach((e) => blocks.push(...questionEntryBlocks(e, ctx.hostSlug)));
            ctx.change(quest, 'qa-journal', entries.length
                ? `${entries.length} question${entries.length === 1 ? '' : 's'} of ${ctx.rel(questions)} -> ${ctx.rel(journal)}, then remove it`
                : `remove ${ctx.rel(questions)} (no entries)`);
            sources.push(questions);
        }
    }
    if (isFile(decisions)) {
        const text = readText(decisions) ?? '';
        const found = decisionEntryBlocks(text, ctx.hostSlug);
        if (!found.length && !onlyPreamble(text, /^# Decisions\b/)) {
            ctx.problem(quest, 'qa-journal', `${ctx.rel(decisions)} holds no entry the step can read: it stays`);
        } else {
            blocks.push(...found);
            ctx.change(quest, 'qa-journal', found.length
                ? `${found.length} decision${found.length === 1 ? '' : 's'} of ${ctx.rel(decisions)} -> ${ctx.rel(journal)}, then remove it`
                : `remove ${ctx.rel(decisions)} (no entries)`);
            sources.push(decisions);
        }
    }
    if (!sources.length) { return; }
    const merged = mergeQaJournalText(readText(journal), qaJournalHeader(quest, ctx.hostSlug), blocks);
    if (!ctx.apply) { return; }
    if (merged.added) { writeFile(journal, merged.text); }
    for (const file of sources) { fs.unlinkSync(file); }
}
