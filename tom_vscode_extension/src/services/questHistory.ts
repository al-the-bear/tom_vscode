/**
 * The quest's history: what a session's prompt gets as its compacted history,
 * built by each host for itself (untracked, class C) in the quest's
 * `history/` folder:
 *
 *     history/compacted_history.md        the compacted history (blocks, src/services/compacted-history.ts)
 *     history/history.json, history.md    its snapshot
 *     history/history.watermark.json      what it covers
 *
 * Its two sources, interleaved by time:
 *
 *   1. the **consolidated trail** — every host's compact trail
 *      `history/trail.<host>.md` (src/services/hostTrail.ts), each turn once
 *      (by its id), sorted by time; generated on the spot, never written. Only
 *      the turns of sessions whose setting `contributesToTrailAndMemory` is on
 *      are in the host trails;
 *   2. the **todo archive** `todos-archived.<quest>.todo.yaml` — each
 *      completed or cancelled todo, with the fields
 *      {@link ARCHIVED_TODO_HISTORY_FIELDS}, in completion order. A todo whose
 *      completion date is a day sorts at the end of that day (UTC).
 *
 * The **watermark** records, per host, the time of the newest turn the
 * history covers and the last archived todo it covers; a build takes only
 * what comes after it ({@link pendingHistoryInputs}). A host trail's turn is
 * trimmed only once the watermark covers it (hostTrail.ts).
 *
 * {@link buildQuestHistory} folds the new inputs into the blocks chunk by
 * chunk (the LLM calls are passed in), writes the blocks, the snapshot and
 * the watermark after each chunk, and extracts memory candidates from the
 * chunk's turns, one call per session (a candidate names the turn's session).
 * The first build on a host deletes the old tracked per-session histories
 * (`history/sessions/<session>/`: `compacted_history.md`, `history.json`,
 * `history.md`, the folders then empty) once ({@link deleteOldSessionHistories}).
 *
 * vscode-free.
 */

import * as fs from 'fs';
import * as path from 'path';
import { parse as parseYaml } from 'yaml';

import {
    type Block,
    COMPACTED_HISTORY_FILENAME,
    applyCompactionOutput,
    concatenateBodies,
    loadFromDisk as loadBlocks,
    renderBlocksForLlm,
    saveToDisk as saveBlocks,
} from './compacted-history';
import { formatHistoryAsMarkdown } from './historySnapshotFormat';
import { historyWatermarkFile, readHostTrails, type HostTrailTurn } from './hostTrail';
import { normaliseTodoDecisions } from '../utils/todoDecisions';
import type { ConversationMessage } from './history-compaction';

// ---------------------------------------------------------------------------
// Places
// ---------------------------------------------------------------------------

/** The quest's `history/` folder; `questFolder` is `_ai/quests/<quest>`. */
export function questHistoryFolder(questFolder: string): string {
    return path.join(questFolder, 'history');
}

/** The quest's compacted history `history/compacted_history.md`. */
export function questCompactedHistoryFile(questFolder: string): string {
    return path.join(questHistoryFolder(questFolder), COMPACTED_HISTORY_FILENAME);
}

/**
 * The old history of session `session` (`history/sessions/<session>/`): its
 * `compacted_history.md`, `history.json` and `history.md`, which the `_ai`
 * format migration leaves there for the quest history's first build. Read
 * only while the quest has no history ({@link loadQuestHistoryBlocks}).
 */
export function oldSessionHistoryFolder(questFolder: string, session: string): string {
    return path.join(questHistoryFolder(questFolder), 'sessions', session);
}

/** The quest's todo archive `todos-archived.<quest>.todo.yaml`. */
export function todoArchiveFile(questFolder: string, quest: string): string {
    return path.join(questFolder, `todos-archived.${quest}.todo.yaml`);
}

// ---------------------------------------------------------------------------
// The consolidated trail
// ---------------------------------------------------------------------------

function timeOf(iso: string): number {
    const t = Date.parse(iso);
    return Number.isFinite(t) ? t : 0;
}

/**
 * Every host's turns of the quest in `questFolder`, each once (the first
 * read of an id wins; hosts are read in name order), sorted by time — a
 * stable sort, so turns of the same time keep the order they were read in.
 */
export function consolidatedTrail(questFolder: string): HostTrailTurn[] {
    return consolidateTurns(readHostTrails(questFolder));
}

/** {@link consolidatedTrail} of trails already read. */
export function consolidateTurns(trails: ReadonlyMap<string, readonly HostTrailTurn[]>): HostTrailTurn[] {
    const seen = new Set<string>();
    const out: HostTrailTurn[] = [];
    for (const turns of trails.values()) {
        for (const t of turns) {
            if (seen.has(t.id)) { continue; }
            seen.add(t.id);
            out.push(t);
        }
    }
    return out
        .map((t, i) => ({ t, i }))
        .sort((a, b) => timeOf(a.t.time) - timeOf(b.t.time) || a.i - b.i)
        .map((x) => x.t);
}

// ---------------------------------------------------------------------------
// The todo archive
// ---------------------------------------------------------------------------

/** The fields of an archived todo the history gets, in this order; nothing else. */
export const ARCHIVED_TODO_HISTORY_FIELDS = ['id', 'title', 'status', 'completed_date', 'description', 'notes', 'decisions', 'references', 'last_answer'] as const;

/** One decision of an archived todo as the history gets it. */
export interface ArchivedTodoDecision {
    summary: string;
    /** The answer; absent when it was archived undecided. */
    decision?: string;
    /** Who decided: the user (a todo's decision is the user's answer); absent when undecided. */
    decidedBy?: 'user';
}

/** One reference of an archived todo (a path, a URL or a description). */
export interface ArchivedTodoReference {
    path?: string;
    url?: string;
    description?: string;
}

/** An archived todo as the history gets it: only {@link ARCHIVED_TODO_HISTORY_FIELDS}. */
/* eslint-disable @typescript-eslint/naming-convention -- the todo schema's YAML keys */
export interface ArchivedTodoRecord {
    id: string;
    title?: string;
    status: 'completed' | 'cancelled';
    completed_date?: string;
    description?: string;
    notes?: string;
    decisions?: ArchivedTodoDecision[];
    references?: ArchivedTodoReference[];
    last_answer?: string;
}
/* eslint-enable @typescript-eslint/naming-convention */

function text(v: unknown): string | undefined {
    if (typeof v === 'string') { const s = v.trim(); return s ? s : undefined; }
    if (v instanceof Date) { return v.toISOString().slice(0, 10); }
    return undefined;
}

function referencesOf(v: unknown): ArchivedTodoReference[] | undefined {
    if (!Array.isArray(v)) { return undefined; }
    const out: ArchivedTodoReference[] = [];
    for (const r of v) {
        if (typeof r === 'string') { if (r.trim()) { out.push({ path: r.trim() }); } continue; }
        if (!r || typeof r !== 'object') { continue; }
        const o = r as Record<string, unknown>;
        const ref: ArchivedTodoReference = {
            ...(text(o.path) ? { path: text(o.path) } : {}),
            ...(text(o.url) ? { url: text(o.url) } : {}),
            ...(text(o.description) ? { description: text(o.description) } : {}),
        };
        if (Object.keys(ref).length > 0) { out.push(ref); }
    }
    return out.length > 0 ? out : undefined;
}

/** One raw todo of the archive as a record, or undefined when it is not completed / cancelled. */
export function archivedTodoRecord(raw: unknown): ArchivedTodoRecord | undefined {
    if (!raw || typeof raw !== 'object') { return undefined; }
    const o = raw as Record<string, unknown>;
    const id = text(o.id);
    const status = o.status;
    if (!id || (status !== 'completed' && status !== 'cancelled')) { return undefined; }
    const decisions = (normaliseTodoDecisions(o.decisions) ?? []).map((d): ArchivedTodoDecision => (
        d.decision ? { summary: d.summary, decision: d.decision, decidedBy: 'user' } : { summary: d.summary }));
    const references = referencesOf(o.references);
    const rec: ArchivedTodoRecord = { id, status };
    if (text(o.title)) { rec.title = text(o.title); }
    if (text(o.completed_date)) { rec.completed_date = text(o.completed_date); }
    if (text(o.description)) { rec.description = text(o.description); }
    if (text(o.notes)) { rec.notes = text(o.notes); }
    if (decisions.length > 0) { rec.decisions = decisions; }
    if (references) { rec.references = references; }
    if (text(o.last_answer)) { rec.last_answer = text(o.last_answer); }
    // In the order of ARCHIVED_TODO_HISTORY_FIELDS.
    const ordered: Record<string, unknown> = {};
    for (const f of ARCHIVED_TODO_HISTORY_FIELDS) { if ((rec as unknown as Record<string, unknown>)[f] !== undefined) { ordered[f] = (rec as unknown as Record<string, unknown>)[f]; } }
    return ordered as unknown as ArchivedTodoRecord;
}

/** The time an archived todo sorts at: its completion time; a bare day at the end of that day (UTC); none at 0. */
export function archivedTodoTime(rec: Pick<ArchivedTodoRecord, 'completed_date'>): number {
    const d = rec.completed_date;
    if (!d) { return 0; }
    if (/^\d{4}-\d{2}-\d{2}$/.test(d)) { return timeOf(`${d}T23:59:59.999Z`); }
    return timeOf(d);
}

/** The completed and cancelled todos of the quest's archive, in completion order (ties: file order). */
export function readArchivedTodoRecords(questFolder: string, quest: string): ArchivedTodoRecord[] {
    let raw: unknown;
    try { raw = parseYaml(fs.readFileSync(todoArchiveFile(questFolder, quest), 'utf-8')); } catch { return []; }
    const todos = raw && typeof raw === 'object' ? (raw as { todos?: unknown }).todos : undefined;
    if (!Array.isArray(todos)) { return []; }
    return todos
        .map((t, i) => ({ rec: archivedTodoRecord(t), i }))
        .filter((x): x is { rec: ArchivedTodoRecord; i: number } => x.rec !== undefined)
        .sort((a, b) => archivedTodoTime(a.rec) - archivedTodoTime(b.rec) || a.i - b.i)
        .map((x) => x.rec);
}

/** An archived todo as the text the compaction reads: its fields in the order of {@link ARCHIVED_TODO_HISTORY_FIELDS}. */
export function formatArchivedTodo(rec: ArchivedTodoRecord): string {
    const out = [`Archived todo ${rec.id}${rec.title ? ` — ${rec.title}` : ''}`];
    out.push(`Status: ${rec.status}${rec.completed_date ? ` on ${rec.completed_date}` : ''}`);
    if (rec.description) { out.push('', 'Description:', rec.description); }
    if (rec.notes) { out.push('', 'Notes:', rec.notes); }
    if (rec.decisions) {
        out.push('', 'Decisions:');
        for (const d of rec.decisions) {
            out.push(d.decision ? `- ${d.summary}: ${d.decision} (decided by the ${d.decidedBy ?? 'user'})` : `- ${d.summary}: (not decided)`);
        }
    }
    if (rec.references) {
        out.push('', 'References:');
        for (const r of rec.references) { out.push(`- ${[r.path, r.url, r.description].filter((x) => x).join(' — ')}`); }
    }
    if (rec.last_answer) { out.push('', 'Last answer:', rec.last_answer); }
    return out.join('\n');
}

// ---------------------------------------------------------------------------
// The watermark
// ---------------------------------------------------------------------------

/** `history/history.watermark.json`: what the quest's history covers on this host. */
export interface HistoryWatermark {
    /** Per host, the ISO time of the newest turn the history covers. */
    hosts: Record<string, string>;
    /** The last archived todo the history covers. */
    lastArchivedTodo: { id: string; completed: string } | null;
    /** When the history was last built. */
    builtAt: string;
    /** Whether this host deleted the old per-session `compacted_history.md` files (done once). */
    oldSessionHistoriesDeleted?: boolean;
}

/** The quest's watermark; undefined when there is none (or it does not read). */
export function readHistoryWatermark(questFolder: string): HistoryWatermark | undefined {
    try {
        const raw = JSON.parse(fs.readFileSync(historyWatermarkFile(questFolder), 'utf-8')) as Record<string, unknown>;
        if (!raw || typeof raw !== 'object') { return undefined; }
        const hosts: Record<string, string> = {};
        if (raw.hosts && typeof raw.hosts === 'object' && !Array.isArray(raw.hosts)) {
            for (const [h, t] of Object.entries(raw.hosts as Record<string, unknown>)) { if (typeof t === 'string') { hosts[h] = t; } }
        }
        const last = raw.lastArchivedTodo as { id?: unknown; completed?: unknown } | null | undefined;
        return {
            hosts,
            lastArchivedTodo: last && typeof last.id === 'string' ? { id: last.id, completed: typeof last.completed === 'string' ? last.completed : '' } : null,
            builtAt: typeof raw.builtAt === 'string' ? raw.builtAt : '',
            ...(raw.oldSessionHistoriesDeleted === true ? { oldSessionHistoriesDeleted: true } : {}),
        };
    } catch {
        return undefined;
    }
}

/** Write the quest's watermark. */
export function writeHistoryWatermark(questFolder: string, wm: HistoryWatermark): void {
    const file = historyWatermarkFile(questFolder);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, `${JSON.stringify(wm, null, 2)}\n`, 'utf-8');
}

// ---------------------------------------------------------------------------
// What a build takes
// ---------------------------------------------------------------------------

/** One input of the history: a trail turn or an archived todo. */
export type HistoryInput =
    | { kind: 'turn'; time: number; turn: HostTrailTurn }
    | { kind: 'todo'; time: number; todo: ArchivedTodoRecord };

/** Whether `turn` is covered by `wm`: its time is at or before its host's watermark time. */
function covered(turn: HostTrailTurn, wm: HistoryWatermark | undefined): boolean {
    const at = wm?.hosts[turn.host];
    return at !== undefined && timeOf(turn.time) <= timeOf(at);
}

/** The archived todos after `last` (all of them without one); `last` not found: those completed after its date. */
export function todosAfter(records: readonly ArchivedTodoRecord[], last: HistoryWatermark['lastArchivedTodo']): ArchivedTodoRecord[] {
    if (!last) { return [...records]; }
    const at = records.findIndex((r) => r.id === last.id);
    if (at >= 0) { return records.slice(at + 1); }
    // eslint-disable-next-line @typescript-eslint/naming-convention -- the todo schema's YAML key
    const mark = archivedTodoTime({ completed_date: last.completed });
    return records.filter((r) => archivedTodoTime(r) > mark);
}

/**
 * What the history does not cover yet, in time order (a turn before a todo of
 * the same time): the consolidated trail's turns after their host's
 * watermark time, and the archived todos after the watermark's last one.
 */
export function pendingHistoryInputs(turns: readonly HostTrailTurn[], todos: readonly ArchivedTodoRecord[], wm: HistoryWatermark | undefined): HistoryInput[] {
    const inputs: HistoryInput[] = [
        ...turns.filter((t) => !covered(t, wm)).map((turn): HistoryInput => ({ kind: 'turn', time: timeOf(turn.time), turn })),
        ...todosAfter(todos, wm?.lastArchivedTodo ?? null).map((todo): HistoryInput => ({ kind: 'todo', time: archivedTodoTime(todo), todo })),
    ];
    return inputs
        .map((x, i) => ({ x, i }))
        .sort((a, b) => a.x.time - b.x.time || (a.x.kind === b.x.kind ? 0 : a.x.kind === 'turn' ? -1 : 1) || a.i - b.i)
        .map((e) => e.x);
}

/** The inputs as the compaction's messages: a turn as its prompt and answer, a todo as one record. */
export function historyInputMessages(inputs: readonly HistoryInput[]): ConversationMessage[] {
    const out: ConversationMessage[] = [];
    for (const input of inputs) {
        if (input.kind === 'turn') {
            const t = input.turn;
            out.push({ role: 'user', content: `[${t.time} · host ${t.host} · session ${t.session}]\n${t.prompt}` });
            out.push({ role: 'assistant', content: t.answer });
        } else {
            out.push({ role: 'system', content: formatArchivedTodo(input.todo) });
        }
    }
    return out;
}

/** `wm` advanced past `inputs`: each host's newest turn time, the last todo, `builtAt`. */
export function advanceWatermark(wm: HistoryWatermark | undefined, inputs: readonly HistoryInput[], builtAt: string): HistoryWatermark {
    const hosts = { ...(wm?.hosts ?? {}) };
    let last = wm?.lastArchivedTodo ?? null;
    for (const input of inputs) {
        if (input.kind === 'turn') {
            const prev = hosts[input.turn.host];
            if (prev === undefined || timeOf(input.turn.time) > timeOf(prev)) { hosts[input.turn.host] = input.turn.time; }
        } else {
            last = { id: input.todo.id, completed: input.todo.completed_date ?? '' };
        }
    }
    return { hosts, lastArchivedTodo: last, builtAt, ...(wm?.oldSessionHistoriesDeleted ? { oldSessionHistoriesDeleted: true } : {}) };
}

// ---------------------------------------------------------------------------
// Reading the history
// ---------------------------------------------------------------------------

/**
 * The compacted history a session's prompt gets: the quest's
 * `history/compacted_history.md`. While the quest has none, the session's
 * old `compacted_history.md` in `oldFolder` ({@link oldSessionHistoryFolder})
 * is read; nothing writes it, and the first build deletes it.
 */
export function loadQuestHistoryBlocks(questFolder: string, oldFolder?: string): Block[] {
    if (fs.existsSync(questCompactedHistoryFile(questFolder))) { return loadBlocks(questHistoryFolder(questFolder)); }
    // The session's old compacted history, until the quest's history exists.
    return oldFolder ? loadBlocks(oldFolder) : [];
}

/** Whether the quest has its own history yet. */
export function hasQuestHistory(questFolder: string): boolean {
    return fs.existsSync(questCompactedHistoryFile(questFolder));
}

/** Write the quest's snapshot `history.json` / `history.md` (the compacted history and the watermark). */
export function writeQuestHistorySnapshot(questFolder: string, quest: string, blocks: Block[], wm: HistoryWatermark, archive = false): void {
    const folder = questHistoryFolder(questFolder);
    fs.mkdirSync(folder, { recursive: true });
    const messages = { compactedSummary: concatenateBodies(blocks) };
    const json = `${JSON.stringify({ messages, savedAt: wm.builtAt, watermark: wm }, null, 2)}\n`;
    fs.writeFileSync(path.join(folder, 'history.json'), json, 'utf-8');
    const md = formatHistoryAsMarkdown({ messages, savedAt: wm.builtAt, questId: quest, title: `# Quest history — \`${quest}\`` });
    const covers = Object.entries(wm.hosts).map(([h, t]) => `${h} up to ${t}`).join(', ') || 'no trail turns';
    const todo = wm.lastArchivedTodo ? `, archived todos up to ${wm.lastArchivedTodo.id}` : '';
    const text = md.replace(/\n/, `\n\n_Covers ${covers}${todo}._\n`);
    fs.writeFileSync(path.join(folder, 'history.md'), text, 'utf-8');
    if (archive) {
        const stamp = wm.builtAt.replace(/[-:]/g, '').replace('T', '_').slice(0, 15);
        fs.writeFileSync(path.join(folder, `${stamp}.history.json`), json, 'utf-8');
        fs.writeFileSync(path.join(folder, `${stamp}.history.md`), text, 'utf-8');
    }
}

/** The files of an old session history ({@link oldSessionHistoryFolder}). */
const OLD_SESSION_HISTORY_FILES = [COMPACTED_HISTORY_FILENAME, 'history.json', 'history.md'];

/**
 * Delete the old per-session histories of the quest: in every
 * `history/sessions/<session>/` (tracked: every host has them) its
 * `compacted_history.md`, `history.json` and `history.md`, then the folders
 * left empty, `history/sessions/` included; and this host's
 * `history/<host>/sessions/*\/compacted_history.md`. Answers the files deleted.
 */
export function deleteOldSessionHistories(questFolder: string, host: string): string[] {
    const deleted: string[] = [];
    const history = questHistoryFolder(questFolder);
    const remove = (file: string): void => {
        try {
            if (fs.statSync(file).isFile()) { fs.rmSync(file); deleted.push(file); }
        } catch { /* not there */ }
    };
    const names = (folder: string): string[] => {
        try { return fs.readdirSync(folder); } catch { return []; }
    };
    const removeIfEmpty = (folder: string): void => {
        try { if (fs.readdirSync(folder).length === 0) { fs.rmdirSync(folder); } } catch { /* gone or not empty */ }
    };
    const old = path.join(history, 'sessions');
    for (const name of names(old)) {
        for (const f of OLD_SESSION_HISTORY_FILES) { remove(path.join(old, name, f)); }
        removeIfEmpty(path.join(old, name));
    }
    removeIfEmpty(old);
    const own = path.join(history, host, 'sessions');
    for (const name of names(own)) { remove(path.join(own, name, COMPACTED_HISTORY_FILENAME)); }
    return deleted;
}

// ---------------------------------------------------------------------------
// The build
// ---------------------------------------------------------------------------

export interface QuestHistoryBuildOptions {
    /** `_ai/quests/<quest>` */
    questFolder: string;
    quest: string;
    /** This host ({@link hostSlugOf}): whose old session histories the first build deletes. */
    host: string;
    /** Inputs folded per compaction call. */
    chunkSize: number;
    /** At most this many of the newest inputs are folded; older ones are passed over (the watermark moves past them). */
    maxInputs: number;
    /** Also write a timestamped copy of the snapshot per chunk (`<yyyymmdd_hhmmss>.history.json` / `.md`). */
    archive?: boolean;
    /** One compaction call: the blocks so far and the chunk's messages in, the LLM's output back. */
    compact(input: { existingBlocks: string; existingSummary: string; messages: ConversationMessage[] }): Promise<string>;
    /** Memory extraction of a chunk's turns of one session; absent: no extraction. */
    extract?(input: { messages: ConversationMessage[]; session: string; compactedSummary: string }): Promise<void>;
    onProgress?(msg: string): void;
    log?(msg: string): void;
    now?(): Date;
}

export interface QuestHistoryBuildReport {
    /** Inputs folded. */
    folded: number;
    turns: number;
    todos: number;
    /** Older inputs passed over (beyond maxInputs). */
    skipped: number;
    chunks: number;
    /** Set when a compaction call failed: the build stopped there, the rest is folded next time. */
    failed?: string;
    /** Extraction calls made. */
    extractions: number;
    /** The old per-session histories the first build deleted. */
    deletedOldHistories: string[];
    blocks: number;
}

/** The turns of `inputs` grouped by session (sessions in first-seen order, turns in order). */
export function turnsBySession(inputs: readonly HistoryInput[]): Array<{ session: string; turns: HostTrailTurn[] }> {
    const groups = new Map<string, HostTrailTurn[]>();
    for (const input of inputs) {
        if (input.kind !== 'turn') { continue; }
        const list = groups.get(input.turn.session);
        if (list) { list.push(input.turn); } else { groups.set(input.turn.session, [input.turn]); }
    }
    return [...groups.entries()].map(([session, turns]) => ({ session, turns }));
}

/**
 * Fold what the quest's history does not cover yet into it: chunk by chunk,
 * each written with the snapshot and the advanced watermark, then the
 * chunk's turns extracted per session. A failing compaction call stops the
 * build (what was folded stays; the rest is folded next time); a failing
 * extraction is reported and the build goes on. After the first successful
 * write on a host, the old per-session histories are deleted once.
 */
export async function buildQuestHistory(opts: QuestHistoryBuildOptions): Promise<QuestHistoryBuildReport> {
    const now = (): string => (opts.now ? opts.now() : new Date()).toISOString();
    let wm = readHistoryWatermark(opts.questFolder);
    let blocks = loadBlocks(questHistoryFolder(opts.questFolder));
    const all = pendingHistoryInputs(consolidatedTrail(opts.questFolder), readArchivedTodoRecords(opts.questFolder, opts.quest), wm);
    const max = Math.max(1, opts.maxInputs);
    const skippedInputs = all.length > max ? all.slice(0, all.length - max) : [];
    const inputs = all.slice(skippedInputs.length);
    const report: QuestHistoryBuildReport = { folded: 0, turns: 0, todos: 0, skipped: skippedInputs.length, chunks: 0, extractions: 0, deletedOldHistories: [], blocks: blocks.length };
    if (skippedInputs.length > 0) {
        wm = advanceWatermark(wm, skippedInputs, now());
        opts.log?.(`quest history: ${skippedInputs.length} older input(s) passed over (more than ${max} new)`);
    }
    const size = Math.max(1, opts.chunkSize);
    const total = Math.ceil(inputs.length / size);
    let wrote = false;
    for (let i = 0, c = 1; i < inputs.length; i += size, c++) {
        const chunk = inputs.slice(i, i + size);
        const turns = chunk.filter((x) => x.kind === 'turn').length;
        opts.onProgress?.(`Rebuild history: folding chunk ${c}/${total} (${turns} turn${turns === 1 ? '' : 's'}, ${chunk.length - turns} archived todo${chunk.length - turns === 1 ? '' : 's'})…`);
        let output: string;
        try {
            output = await opts.compact({ existingBlocks: renderBlocksForLlm(blocks), existingSummary: concatenateBodies(blocks), messages: historyInputMessages(chunk) });
        } catch (e) {
            report.failed = e instanceof Error ? e.message : String(e);
            opts.log?.(`quest history: chunk ${c}/${total} failed — ${report.failed}; the rest is folded next time`);
            break;
        }
        blocks = applyCompactionOutput(blocks, output, now());
        wm = advanceWatermark(wm, chunk, now());
        saveBlocks(questHistoryFolder(opts.questFolder), blocks);
        writeQuestHistorySnapshot(opts.questFolder, opts.quest, blocks, wm, opts.archive);
        writeHistoryWatermark(opts.questFolder, wm);
        wrote = true;
        report.chunks++;
        report.folded += chunk.length;
        report.turns += turns;
        report.todos += chunk.length - turns;
        if (opts.extract) {
            for (const group of turnsBySession(chunk)) {
                opts.onProgress?.(`Rebuild memory: extracting chunk ${c}/${total}, session ${group.session} (${group.turns.length} turn${group.turns.length === 1 ? '' : 's'})…`);
                try {
                    await opts.extract({
                        messages: historyInputMessages(group.turns.map((turn) => ({ kind: 'turn' as const, time: timeOf(turn.time), turn }))),
                        session: group.session,
                        compactedSummary: concatenateBodies(blocks),
                    });
                    report.extractions++;
                } catch (e) {
                    opts.log?.(`quest history: memory extraction of session ${group.session} failed — ${e instanceof Error ? e.message : String(e)}`);
                }
            }
        }
    }
    if (!wrote && skippedInputs.length > 0 && wm) {
        // Only older inputs, all passed over: the watermark still moves past them.
        writeHistoryWatermark(opts.questFolder, wm);
    }
    if (wrote && wm && !wm.oldSessionHistoriesDeleted) {
        report.deletedOldHistories = deleteOldSessionHistories(opts.questFolder, opts.host);
        for (const f of report.deletedOldHistories) { opts.log?.(`quest history: deleted the old session history ${f}`); }
        wm = { ...wm, oldSessionHistoriesDeleted: true };
        writeHistoryWatermark(opts.questFolder, wm);
    }
    report.blocks = blocks.length;
    return report;
}

// ---------------------------------------------------------------------------
// The notice after a reconcile
// ---------------------------------------------------------------------------

/**
 * The other hosts whose trail holds turns newer than their watermark time
 * (every other host with turns when there is no watermark), each with its
 * newest turn's time; this host's own trail is never named.
 */
export function hostsAheadOfHistory(trails: ReadonlyMap<string, readonly HostTrailTurn[]>, wm: HistoryWatermark | undefined, ownHost: string): Array<{ host: string; newest: string }> {
    const out: Array<{ host: string; newest: string }> = [];
    for (const [host, turns] of trails) {
        if (host === ownHost || turns.length === 0) { continue; }
        const newest = turns.reduce((a, t) => (timeOf(t.time) > timeOf(a.time) ? t : a), turns[0]);
        const at = wm?.hosts[host];
        if (at === undefined || timeOf(newest.time) > timeOf(at)) { out.push({ host, newest: newest.time }); }
    }
    return out;
}

/**
 * Decides when the notice is shown: once per change of what is ahead (the
 * hosts and their newest turn times). Nothing ahead resets it.
 */
export class HistoryNoticeGate {
    private last = '';

    /** The hosts to name in a notice now, or undefined when none is due. */
    check(ahead: ReadonlyArray<{ host: string; newest: string }>): string[] | undefined {
        const signature = ahead.map((a) => `${a.host}@${a.newest}`).sort().join('|');
        if (!signature) { this.last = ''; return undefined; }
        if (signature === this.last) { return undefined; }
        this.last = signature;
        return ahead.map((a) => a.host);
    }
}
