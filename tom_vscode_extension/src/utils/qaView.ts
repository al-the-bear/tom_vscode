/**
 * The Q&A page's model (handlers/qaPanel-handler.ts), pure:
 *
 * - **Questions tab** ({@link questionEntries}): the entries of the Q&A
 *   journals of the chosen quests (utils/qaJournal.ts) — questions with their
 *   answers, the answers given with tomAi_answerUser, the process decisions —
 *   newest first. An answer given is joined to this machine's stored answer of
 *   the same id (utils/userAnswers.ts), which holds its suggested todos and
 *   prompts; a stored answer no journal names is listed too.
 * - **Decisions tab** ({@link decisionEntries}): the `decisions` of the todos of
 *   the chosen quests (the live todo files and the archived ones): the open
 *   ones first, then the answered ones newest first.
 * - **The filter** ({@link questsOfFilter}): the window's quest, the
 *   workspace's quests, or quests the user selects.
 * - **The counters** ({@link newCount}, {@link markShown}): an entry is new when
 *   its time is past the per-machine read marker of its quest and tab — the
 *   time up to which this machine has seen that tab's entries.
 *
 * vscode-free.
 */

import { isArchivedTodoFile, isDeletedTodoFile } from './todoArchiveNames';
import { decisionOptionLetters, normaliseTodoDecisions } from './todoDecisions';
import type { QaItem } from './qaJournal';
import type { UserAnswer } from './userAnswers';

export type QaTab = 'questions' | 'decisions';
export type QaScope = 'current' | 'workspace' | 'selected';

export interface QaFilter {
    scope: QaScope;
    /** The quests of `selected`. */
    selected: string[];
}

export const DEFAULT_QA_FILTER: QaFilter = { scope: 'current', selected: [] };

/** A filter as it arrives from the page or a stored state; anything unknown is the default. */
export function normaliseQaFilter(raw: unknown): QaFilter {
    const r = (raw && typeof raw === 'object' ? raw : {}) as { scope?: unknown; selected?: unknown };
    const scope: QaScope = r.scope === 'workspace' || r.scope === 'selected' ? r.scope : 'current';
    const selected = Array.isArray(r.selected) ? [...new Set(r.selected.filter((q): q is string => typeof q === 'string' && q.length > 0))] : [];
    return { scope, selected };
}

/** The quests a filter shows: the current quest, the workspace's quests (the current one included), or the selected ones that exist. */
export function questsOfFilter(filter: QaFilter, current: string, workspace: readonly string[], all: readonly string[]): string[] {
    const exists = new Set(all);
    const withCurrent = (list: readonly string[]): string[] => [...new Set([...(current && current !== 'default' ? [current] : []), ...list])];
    switch (filter.scope) {
        case 'workspace': return withCurrent(workspace).filter((q) => exists.has(q) || q === current);
        case 'selected': return filter.selected.filter((q) => exists.has(q));
        default: return current && current !== 'default' ? [current] : [];
    }
}

/** One entry of the Questions tab. */
export interface QaQuestionEntry {
    /** `<quest>|<id>`: unique across the quests shown. */
    key: string;
    item: QaItem;
    /** This machine's stored answer of an answer given, when it has it. */
    stored?: UserAnswer;
}

const ms = (time: string | undefined): number => {
    const t = Date.parse(time ?? '');
    return Number.isFinite(t) ? t : 0;
};

/** Newest first by time; equal times keep their order. */
function newestFirst<T>(list: readonly T[], timeOf: (x: T) => string | undefined): T[] {
    return list.map((x, i) => ({ x, i, t: ms(timeOf(x)) })).sort((a, b) => (b.t - a.t) || a.i - b.i).map((e) => e.x);
}

/** A stored answer as a journal entry (one no journal names: given before the journal recorded answers, or on a host whose journal is not here). */
export function storedAnswerItem(a: UserAnswer, host: string): QaItem {
    return {
        id: `store-${a.id}`,
        kind: 'answerGiven',
        time: a.at,
        host,
        quest: a.quest,
        ...(a.session ? { session: a.session } : {}),
        run: a.run,
        ...(a.queueItemId ? { queueItemId: a.queueItemId } : {}),
        tool: 'tomAi_answerUser',
        title: a.title,
        answerId: a.id,
        ...(a.question ? { userQuestion: a.question } : {}),
        answer: a.answer,
        suggestedPrompts: a.suggestedPrompts.map((p) => p.label),
        suggestedTodos: a.suggestedTodos.map((s) => String(s.todo.id)),
    };
}

/**
 * The Questions tab's entries, newest first: the journal items of `quests`
 * (each carrying its `quest`), every answer given joined to its stored answer,
 * and the stored answers of those quests no journal names (as of `host`).
 */
export function questionEntries(items: readonly QaItem[], stored: readonly UserAnswer[], quests: readonly string[], host: string): QaQuestionEntry[] {
    const shown = new Set(quests);
    const byId = new Map(stored.map((a) => [a.id, a]));
    const named = new Set<string>();
    const out: QaQuestionEntry[] = [];
    for (const item of items) {
        if (!item.quest || !shown.has(item.quest)) { continue; }
        const a = item.kind === 'answerGiven' && item.answerId ? byId.get(item.answerId) : undefined;
        if (item.answerId) { named.add(item.answerId); }
        out.push({ key: `${item.quest}|${item.id}`, item, ...(a ? { stored: a } : {}) });
    }
    for (const a of stored) {
        if (named.has(a.id) || !shown.has(a.quest)) { continue; }
        const item = storedAnswerItem(a, host);
        out.push({ key: `${a.quest}|${item.id}`, item, stored: a });
    }
    return newestFirst(out, (e) => e.item.time);
}

/** A todo as the Decisions tab reads it (a QuestTodoItem, or a raw record of a todo file). */
export interface QaTodoInput {
    id: string;
    title?: string;
    description?: string;
    status?: string;
    decisions?: unknown;
    created?: string;
    updated?: string;
    completed_date?: string;
    /** The file it is in (its archived sibling for an archived todo). */
    _sourceFile?: string;
}

/** One decision of a todo, as the Decisions tab shows it. */
export interface QaDecisionEntry {
    /** `<quest>|<todo id>|<index>`. */
    key: string;
    quest: string;
    todoId: string;
    todoTitle: string;
    todoStatus: string;
    /** The todo is in an archived todo file. */
    archived: boolean;
    index: number;
    summary: string;
    needed?: string;
    decision?: string;
    /** No decision yet, on a todo still to be done: answerable in place. */
    open: boolean;
    /** The date the entry is ordered and counted by: the completion date, else the last update, else the creation. */
    time: string;
    /** The option letters the decision text offers, `(a)`, `(b)` … */
    options: string[];
}

const DONE = new Set(['completed', 'cancelled']);

/** The Decisions tab's entries of `todos` of `quest` (the live and archived todo files; deleted ones are left out). */
export function decisionEntriesOf(quest: string, todos: readonly QaTodoInput[]): QaDecisionEntry[] {
    const out: QaDecisionEntry[] = [];
    for (const t of todos) {
        const file = t._sourceFile ?? '';
        if (file && isDeletedTodoFile(file)) { continue; }
        const decisions = normaliseTodoDecisions(t.decisions);
        if (!decisions) { continue; }
        const archived = !!file && isArchivedTodoFile(file);
        const status = t.status ?? 'not-started';
        decisions.forEach((d, index) => {
            const open = !d.decision && !archived && !DONE.has(status);
            out.push({
                key: `${quest}|${t.id}|${index}`,
                quest,
                todoId: t.id,
                todoTitle: (t.title ?? t.description ?? '').split('\n')[0].trim(),
                todoStatus: status,
                archived,
                index,
                summary: d.summary,
                ...(d.decision_needed ? { needed: d.decision_needed } : {}),
                ...(d.decision ? { decision: d.decision } : {}),
                open,
                time: String(t.completed_date ?? t.updated ?? t.created ?? ''),
                options: decisionOptionLetters(d.decision_needed),
            });
        });
    }
    return out;
}

/** The Decisions tab's order: the open decisions first, then the answered ones; each newest first. */
export function sortDecisionEntries(entries: readonly QaDecisionEntry[]): QaDecisionEntry[] {
    const sorted = newestFirst(entries, (e) => e.time);
    return [...sorted.filter((e) => e.open), ...sorted.filter((e) => !e.open)];
}

/** The read marker of this machine: per quest, per tab, the time (ms) up to which the entries were seen. */
export type QaReadMarker = Record<string, Partial<Record<QaTab, number>>>;

/** A marker as read from its file; anything else is the empty marker. */
export function normaliseQaMarker(raw: unknown): QaReadMarker {
    const out: QaReadMarker = {};
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) { return out; }
    for (const [quest, v] of Object.entries(raw as Record<string, unknown>)) {
        if (!v || typeof v !== 'object') { continue; }
        const tabs: Partial<Record<QaTab, number>> = {};
        for (const tab of ['questions', 'decisions'] as const) {
            const n = (v as Record<string, unknown>)[tab];
            if (typeof n === 'number' && Number.isFinite(n)) { tabs[tab] = n; }
        }
        out[quest] = tabs;
    }
    return out;
}

/** The quest and time of an entry of either tab. */
function questAndTime(e: QaQuestionEntry | QaDecisionEntry): { quest: string; t: number } {
    return 'item' in e ? { quest: e.item.quest ?? '', t: ms(e.item.time) } : { quest: e.quest, t: ms(e.time) };
}

/** Whether an entry is new: its time is past its quest's marker of `tab` (no marker: every entry is new). */
export function isNewEntry(e: QaQuestionEntry | QaDecisionEntry, tab: QaTab, marker: QaReadMarker): boolean {
    const { quest, t } = questAndTime(e);
    const seen = marker[quest]?.[tab];
    return seen === undefined || t > seen;
}

/** How many entries of `tab` are new. */
export function newCount(entries: ReadonlyArray<QaQuestionEntry | QaDecisionEntry>, tab: QaTab, marker: QaReadMarker): number {
    return entries.filter((e) => isNewEntry(e, tab, marker)).length;
}

/** The marker after the entries of `tab` were shown: each quest's time moved up to its newest entry shown. */
export function markShown(marker: QaReadMarker, entries: ReadonlyArray<QaQuestionEntry | QaDecisionEntry>, tab: QaTab): QaReadMarker {
    const next: QaReadMarker = Object.fromEntries(Object.entries(marker).map(([q, v]) => [q, { ...v }]));
    for (const e of entries) {
        const { quest, t } = questAndTime(e);
        if (!quest) { continue; }
        const tabs = next[quest] ?? (next[quest] = {});
        if (tabs[tab] === undefined || t > (tabs[tab] as number)) { tabs[tab] = t; }
    }
    return next;
}
