/**
 * The todo panel's dependency cleanup, the rules (pure): what one pass over a
 * set of live todos changes.
 *
 * - A `blocked_by` entry naming a todo that is done (completed, cancelled) is
 *   removed; so is one naming a todo that no longer exists as a live todo (not
 *   in any live todo file — archived, deleted or gone): it counts as completed.
 *   An entry that names no todo (prose, a bare quest name) stays.
 * - A todo of status `blocked` whose `blocked_by` the pass empties, and that
 *   waits for no `blocked_until` condition, is no longer blocked: it becomes
 *   `group` when it is a group todo (`comprised_of`), `decision-needed` when it
 *   holds an open decision, else `not-started`. A `blocked` todo without any
 *   `blocked_by` is left alone (what it waits for is not machine-readable).
 * - `blocking` is what the other todos' `blocked_by` say (expectedBlocking,
 *   todoBlocking.ts), judged after the removals of the same pass.
 *
 * vscode-free, no fs.
 */

import { expectedBlocking, sameRefs, type TodoRelationRecord } from './todoBlocking';
import { blockerOf, isDone } from './todoBlockingCascade';

/** A live todo as the cleanup reads it. */
export interface CleanupTodo {
    quest: string;
    id: string;
    status: string;
    blockedBy: string[];
    blocking: string[];
    blockedUntil: string[];
    /** A group todo: it names members in `comprised_of`. */
    group: boolean;
    /** It holds a decision without an answer. */
    openDecisions: boolean;
}

/** Why a `blocked_by` entry goes. */
export type RemovalReason = 'done' | 'gone';

/** What the pass changes on one todo; absent fields stay as they are. */
export interface CleanupChange {
    quest: string;
    id: string;
    removed: Array<{ entry: string; reason: RemovalReason }>;
    /** The new status, when it changes. */
    status?: { from: string; to: string };
    /** The new `blocking`, when it is not what the other todos' `blocked_by` say. */
    blocking?: { from: string[]; to: string[] };
}

/** The status a todo that is no longer blocked takes. */
export function unblockedStatus(todo: Pick<CleanupTodo, 'group' | 'openDecisions'>): string {
    if (todo.group) { return 'group'; }
    return todo.openDecisions ? 'decision-needed' : 'not-started';
}

/**
 * The changes of one pass. `all`: every live todo of every quest (the
 * blockers and the `blocking` sides are judged against them); `inScope`: the
 * todos the pass may change (the visible ones, the open quests', or all);
 * `quests`: every quest name (a bare quest name in `blocked_by` is prose).
 */
export function planDependencyCleanup(
    all: readonly CleanupTodo[],
    inScope: (quest: string, id: string) => boolean,
    quests: ReadonlySet<string>,
): CleanupChange[] {
    const live = new Map(all.map((t) => [`${t.quest}/${t.id}`, t]));
    const changes = new Map<string, CleanupChange>();
    const changeOf = (t: CleanupTodo): CleanupChange => {
        const key = `${t.quest}/${t.id}`;
        let c = changes.get(key);
        if (!c) { c = { quest: t.quest, id: t.id, removed: [] }; changes.set(key, c); }
        return c;
    };
    // 1. The blocked_by entries that go, and the todos they release.
    const keptBlockedBy = new Map<string, string[]>();
    for (const t of all) {
        if (!inScope(t.quest, t.id)) { keptBlockedBy.set(`${t.quest}/${t.id}`, t.blockedBy); continue; }
        const kept: string[] = [];
        const removed: Array<{ entry: string; reason: RemovalReason }> = [];
        for (const entry of t.blockedBy) {
            const target = blockerOf(entry, t.quest, quests);
            if (!target) { kept.push(entry); continue; }
            const blocker = live.get(`${target.quest}/${target.id}`);
            if (!blocker) { removed.push({ entry, reason: 'gone' }); continue; }
            if (isDone(blocker.status)) { removed.push({ entry, reason: 'done' }); continue; }
            kept.push(entry);
        }
        keptBlockedBy.set(`${t.quest}/${t.id}`, kept);
        if (removed.length) { changeOf(t).removed = removed; }
        if (t.status.trim().toLowerCase() === 'blocked' && t.blockedBy.length > 0 && kept.length === 0 && t.blockedUntil.length === 0) {
            changeOf(t).status = { from: t.status, to: unblockedStatus(t) };
        }
    }
    // 2. `blocking`, from the blocked_by lists as they are after the removals.
    const records: TodoRelationRecord[] = all.map((t) => ({
        scopeKey: `quest:${t.quest}`, quest: t.quest, id: t.id,
        blockedBy: keptBlockedBy.get(`${t.quest}/${t.id}`) ?? t.blockedBy, blocking: t.blocking,
    }));
    for (const t of all) {
        if (!inScope(t.quest, t.id)) { continue; }
        const expected = expectedBlocking({ scopeKey: `quest:${t.quest}`, id: t.id }, records);
        if (!sameRefs(expected, t.blocking)) { changeOf(t).blocking = { from: t.blocking, to: expected }; }
    }
    return [...changes.values()];
}

/** The notes line of a change (without the date), or undefined when it changes only `blocking`. */
export function cleanupNote(change: CleanupChange): string | undefined {
    const parts: string[] = [];
    const done = change.removed.filter((r) => r.reason === 'done').map((r) => r.entry);
    const gone = change.removed.filter((r) => r.reason === 'gone').map((r) => r.entry);
    if (done.length) { parts.push(`no longer blocked by ${done.join(', ')} (done)`); }
    if (gone.length) { parts.push(`no longer blocked by ${gone.join(', ')} (no longer a live todo, taken as completed)`); }
    if (change.status) { parts.push(`${change.status.from} → ${change.status.to}: nothing blocks it any more`); }
    return parts.length ? `dependency cleanup: ${parts.join('; ')}` : undefined;
}

/** A pass's counts, for the summary. */
export interface CleanupSummary {
    todos: number;
    removedDone: number;
    removedGone: number;
    unblocked: number;
    blockingFixed: number;
    /** `blocked` todos without any `blocked_by`: left alone. */
    blockedWithoutBlockers: number;
}

/** The counts of `changes` over the `todos` checked. */
export function summarizeCleanup(todos: readonly CleanupTodo[], changes: readonly CleanupChange[], inScope: (quest: string, id: string) => boolean): CleanupSummary {
    return {
        todos: todos.filter((t) => inScope(t.quest, t.id)).length,
        removedDone: changes.reduce((n, c) => n + c.removed.filter((r) => r.reason === 'done').length, 0),
        removedGone: changes.reduce((n, c) => n + c.removed.filter((r) => r.reason === 'gone').length, 0),
        unblocked: changes.filter((c) => c.status).length,
        blockingFixed: changes.filter((c) => c.blocking).length,
        blockedWithoutBlockers: todos.filter((t) => inScope(t.quest, t.id) && t.status.trim().toLowerCase() === 'blocked' && t.blockedBy.length === 0 && t.blockedUntil.length === 0).length,
    };
}

/** The summary as one message. */
export function cleanupSummaryText(s: CleanupSummary): string {
    const parts = [
        `${s.todos} todo${s.todos === 1 ? '' : 's'} checked`,
        `${s.removedDone + s.removedGone} blocked_by entr${s.removedDone + s.removedGone === 1 ? 'y' : 'ies'} removed (${s.removedDone} done, ${s.removedGone} no longer a live todo)`,
        `${s.unblocked} unblocked`,
        `${s.blockingFixed} blocking list${s.blockingFixed === 1 ? '' : 's'} corrected`,
    ];
    const tail = s.blockedWithoutBlockers
        ? ` ${s.blockedWithoutBlockers} blocked todo${s.blockedWithoutBlockers === 1 ? '' : 's'} without blocked_by left as ${s.blockedWithoutBlockers === 1 ? 'it is' : 'they are'}.`
        : '';
    return `Todo dependencies: ${parts.join(', ')}.${tail}`;
}

