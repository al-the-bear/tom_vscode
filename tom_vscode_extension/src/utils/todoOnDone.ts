/**
 * A todo's follow-up (`on_done`) and its origin (`filed_by`): the two fields
 * of the todo schema the todo tools, the todo manager and the todo editor
 * write (idea agent_collaboration, part-todo-followups).
 *
 * `on_done` says what happens when the todo is completed: the todos it acts on
 * (`todos`, ids in `quest`, default the todo's own quest, and `run`), the
 * actions (`unblock`, `notify`, `queue`, `none`; absent means `[none]`),
 * `instructions` for the agent, `notify_prompt` and `report_to`.
 * `filed_by` says who filed it: quest, run, session, the todo whose walk filed
 * it, and when.
 *
 * Consistency (BP-2): an `unblock` target carries this todo in its
 * `blocked_by` (the bare id in the same quest, `<quest>/<id>` from another)
 * while the todo is not cancelled. {@link unblockEntryPlan} answers what to add
 * and remove when a todo is created, its `on_done` replaced or the todo
 * cancelled (DP-part-todo-followups-2); the manager writes it.
 *
 * Pure: no `vscode`, no file system.
 */

import { formatRepeatMoment } from './todoRepeat';

export const TODO_ON_DONE_ACTIONS = ['unblock', 'notify', 'queue', 'none'] as const;
export type TodoOnDoneAction = (typeof TODO_ON_DONE_ACTIONS)[number];

/* eslint-disable @typescript-eslint/naming-convention -- the todo schema's YAML keys */
export interface TodoOnDone {
    quest?: string;
    run?: string;
    todos?: string[];
    action?: TodoOnDoneAction[];
    instructions?: string;
    notify_prompt?: string;
    report_to?: string;
}

export interface TodoFiledBy {
    quest?: string;
    run?: string;
    session?: string;
    todo?: string;
    at?: string;
}

const ON_DONE_KEYS = ['quest', 'run', 'todos', 'action', 'instructions', 'notify_prompt', 'report_to'] as const;
const FILED_BY_KEYS = ['quest', 'run', 'session', 'todo', 'at'] as const;
const STRING_KEYS = ['quest', 'run', 'instructions', 'notify_prompt', 'report_to'] as const;

/**
 * Why `value` is not an `on_done` block the schema accepts, or `undefined`.
 * The shape only (closed keys, types, the four actions) and the rule that
 * `unblock` and `queue` need `todos`; whether the targets exist is
 * {@link onDoneTargetRefusal}.
 */
export function onDoneShapeError(value: unknown): string | undefined {
    if (value === undefined || value === null) { return undefined; }
    if (typeof value !== 'object' || Array.isArray(value)) {
        return '`on_done` must be an object such as {"todos": ["<id>"], "action": ["unblock"]}.';
    }
    const record = value as Record<string, unknown>;
    for (const key of Object.keys(record)) {
        if (!(ON_DONE_KEYS as readonly string[]).includes(key)) {
            return `\`on_done\` has an unknown key "${key}"; allowed: ${ON_DONE_KEYS.join(', ')}.`;
        }
    }
    for (const key of STRING_KEYS) {
        if (record[key] !== undefined && typeof record[key] !== 'string') { return `\`on_done.${key}\` must be a string.`; }
    }
    if (record.todos !== undefined && (!Array.isArray(record.todos) || record.todos.some((t) => typeof t !== 'string' || !t.trim()))) {
        return '`on_done.todos` must be a list of todo ids.';
    }
    if (record.action !== undefined) {
        if (!Array.isArray(record.action)) { return '`on_done.action` must be a list, e.g. ["unblock", "notify"].'; }
        for (const a of record.action) {
            if (!(TODO_ON_DONE_ACTIONS as readonly unknown[]).includes(a)) {
                return `\`on_done.action\` has "${String(a)}"; the actions are ${TODO_ON_DONE_ACTIONS.join(', ')}.`;
            }
        }
        const actions = record.action as string[];
        const todos = (record.todos as string[] | undefined) ?? [];
        for (const needsTodos of ['unblock', 'queue']) {
            if (actions.includes(needsTodos) && todos.length === 0) {
                return `\`on_done.action\` "${needsTodos}" needs \`on_done.todos\`: the todos it acts on.`;
            }
        }
    }
    return undefined;
}

/** Why `value` is not a `filed_by` block, or `undefined` (shape only; callers cannot set it, the manager writes it). */
export function filedByShapeError(value: unknown): string | undefined {
    if (value === undefined || value === null) { return undefined; }
    if (typeof value !== 'object' || Array.isArray(value)) { return '`filed_by` must be an object.'; }
    for (const [key, v] of Object.entries(value as Record<string, unknown>)) {
        if (!(FILED_BY_KEYS as readonly string[]).includes(key)) { return `\`filed_by\` has an unknown key "${key}".`; }
        if (typeof v !== 'string') { return `\`filed_by.${key}\` must be a string.`; }
    }
    return undefined;
}

/** The quest `on_done.todos` are in: `on_done.quest`, else the todo's own. */
export function onDoneQuest(onDone: TodoOnDone | undefined, ownQuest: string): string {
    return onDone?.quest?.trim() || ownQuest;
}

/**
 * Why an `on_done` names a target that does not exist, or `undefined`. Only
 * the targets of `unblock` / `queue` must exist (archived and deleted todos
 * count: `exists` answers over every file of the quest).
 */
export function onDoneTargetRefusal(
    onDone: TodoOnDone | undefined,
    ownQuest: string,
    exists: (quest: string, id: string) => boolean,
): string | undefined {
    if (!onDone?.todos?.length) { return undefined; }
    const actions = onDone.action ?? [];
    if (!actions.includes('unblock') && !actions.includes('queue')) { return undefined; }
    const quest = onDoneQuest(onDone, ownQuest);
    const missing = onDone.todos.filter((id) => !exists(quest, id));
    if (missing.length === 0) { return undefined; }
    return `\`on_done.todos\` names ${missing.map((id) => `"${id}"`).join(', ')}, which quest "${quest}" has in none of its todo files (archived and deleted ones included).`;
}

/** The `blocked_by` entry a todo `ownerId` of `ownerQuest` is named by in a target of `targetQuest`. */
export function unblockEntry(ownerQuest: string, ownerId: string, targetQuest: string): string {
    return ownerQuest === targetQuest ? ownerId : `${ownerQuest}/${ownerId}`;
}

/** A target todo: its quest and id. */
export interface TodoRef { quest: string; id: string }

/**
 * The targets that must carry the todo's `blocked_by` entry: the `unblock`
 * targets of its `on_done`, none once the todo is done (completed or
 * cancelled) — a done blocker leaves the `blocked_by` lists.
 */
export function unblockTargets(todo: { status?: string; on_done?: TodoOnDone } | undefined, ownQuest: string): TodoRef[] {
    if (!todo?.on_done || todo.status === 'cancelled' || todo.status === 'completed') { return []; }
    if (!(todo.on_done.action ?? []).includes('unblock')) { return []; }
    const quest = onDoneQuest(todo.on_done, ownQuest);
    return [...new Set(todo.on_done.todos ?? [])].map((id) => ({ quest, id }));
}

/** What to add and remove after a write: the entries of the targets before and after. */
export interface UnblockEntryPlan { add: TodoRef[]; remove: TodoRef[] }

/**
 * The `blocked_by` entries to write and remove when todo `before` (absent:
 * a new todo) becomes `after`: added to every unblock target it has now,
 * removed from every target it no longer has (its `on_done` replaced, or the
 * todo cancelled).
 */
export function unblockEntryPlan(
    before: { status?: string; on_done?: TodoOnDone } | undefined,
    after: { status?: string; on_done?: TodoOnDone },
    ownQuest: string,
): UnblockEntryPlan {
    const key = (r: TodoRef): string => `${r.quest}/${r.id}`;
    const was = unblockTargets(before, ownQuest);
    const now = unblockTargets(after, ownQuest);
    const nowKeys = new Set(now.map(key));
    return { add: now, remove: was.filter((r) => !nowKeys.has(key(r))) };
}

/** `entries` with `entry` added (once). */
export function withBlockedByEntry(entries: readonly string[] | undefined, entry: string): string[] {
    const list = [...(entries ?? [])];
    return list.includes(entry) ? list : [...list, entry];
}

/** `entries` without `entry`. */
export function withoutBlockedByEntry(entries: readonly string[] | undefined, entry: string): string[] {
    return (entries ?? []).filter((e) => e !== entry);
}

/** What a tool call or an edit knows about where it runs, for `filed_by`. */
export interface FiledByContext {
    /** The window's quest. */
    windowQuest?: string;
    /** The session the call runs in (`callerSession()`), `<name>@<run>` in a run. */
    session?: string;
    /** The process run the call runs for, when the session names none. */
    run?: string;
    /** The todo the queue item running the call has claimed (a walk), with its quest. */
    claim?: TodoRef;
    /** The inbox item's sender, when the item came from another quest's request. */
    sender?: { quest: string; run?: string };
}

/**
 * The `filed_by` block of a todo filed now. The quest is the window's, the
 * run the session's `@<run>` (else the call's run, else `default`), the
 * session the name without its run, the todo the walk's claimed todo of that
 * quest. A todo filed on another quest's request records the requester — the
 * inbox item's sender, its quest and run — with the creating session
 * (DP-part-todo-followups-3). Empty parts are left out.
 */
export function buildFiledBy(ctx: FiledByContext, now: Date): TodoFiledBy {
    const [sessionName, sessionRun] = splitSession(ctx.session);
    const quest = ctx.sender?.quest ?? ctx.windowQuest;
    const run = ctx.sender ? (ctx.sender.run || 'default') : (sessionRun ?? ctx.run ?? 'default');
    const todo = ctx.claim && (!quest || ctx.claim.quest === quest) ? ctx.claim.id : undefined;
    const out: TodoFiledBy = {};
    if (quest) { out.quest = quest; }
    out.run = run;
    if (sessionName) { out.session = sessionName; }
    if (todo) { out.todo = todo; }
    out.at = formatRepeatMoment(now);
    return out;
}

function splitSession(session: string | undefined): [string | undefined, string | undefined] {
    if (!session) { return [undefined, undefined]; }
    const at = session.lastIndexOf('@');
    return at > 0 ? [session.slice(0, at), session.slice(at + 1) || undefined] : [session, undefined];
}

/** A plain, ordered copy of an `on_done` block without empty parts; `undefined` when nothing is left. */
export function normaliseOnDone(value: TodoOnDone | undefined | null): TodoOnDone | undefined {
    if (!value) { return undefined; }
    const out: TodoOnDone = {};
    if (value.quest?.trim()) { out.quest = value.quest.trim(); }
    if (value.run?.trim()) { out.run = value.run.trim(); }
    const todos = (value.todos ?? []).map((t) => t.trim()).filter(Boolean);
    if (todos.length) { out.todos = [...new Set(todos)]; }
    const actions = (value.action ?? []).filter((a) => (TODO_ON_DONE_ACTIONS as readonly string[]).includes(a));
    if (actions.length) { out.action = [...new Set(actions)]; }
    if (value.instructions?.trim()) { out.instructions = value.instructions; }
    if (value.notify_prompt?.trim()) { out.notify_prompt = value.notify_prompt; }
    if (value.report_to?.trim()) { out.report_to = value.report_to.trim(); }
    return Object.keys(out).length ? out : undefined;
}
