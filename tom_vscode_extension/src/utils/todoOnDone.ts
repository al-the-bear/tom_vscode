/**
 * A todo's follow-up (`on_done`) and its origin (`filed_by`): the two fields
 * of the todo schema the todo tools, the todo manager and the todo editor
 * write (idea agent_collaboration, part-todo-followups).
 *
 * `on_done` says what happens when the todo is completed:
 * - `todos`: the target todos, a bare id in the todo's own quest,
 *   `<quest>/<id>` in another ({@link onDoneTargetRef});
 * - `action`: `unblock` (each target is set free: `group` for a group todo,
 *   else `not-started`, `decision-needed` while it has an open decision —
 *   without looking at its other conditions; a todo that must wait for its
 *   conditions names this one in its own `blocked_by` instead) and `notify`
 *   (the done notification goes to the quest and run in `filed_by` instead of
 *   the run that queued the todo);
 * - `instructions`: sent as a prompt to `quest` / `run` (unset: the todo's own
 *   quest and the run it was completed in);
 * - `notify_prompt`: the done notification;
 * - `report_to`: where the receiver records the outcome.
 * `filed_by` says who filed it: quest, run, session, the todo whose walk filed
 * it, and when.
 *
 * Nothing is written into the targets while the todo is open: `unblock` acts
 * at the completion only.
 *
 * Pure: no `vscode`, no file system.
 */

import { formatRepeatMoment } from './todoRepeat';

export const TODO_ON_DONE_ACTIONS = ['unblock', 'notify'] as const;
export type TodoOnDoneAction = (typeof TODO_ON_DONE_ACTIONS)[number];

/** Actions older todos may still carry; read as nothing, refused when written. */
export const RETIRED_ON_DONE_ACTIONS = ['queue', 'none'] as const;

/* eslint-disable @typescript-eslint/naming-convention -- the todo schema's YAML keys */
export interface TodoOnDone {
    /** The quest the instructions are sent to; unset: the todo's own. */
    quest?: string;
    /** The run the instructions are sent to; unset: the run the todo was completed in (its own quest), else `default`. */
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

/** A target todo: its quest and id. */
export interface TodoRef { quest: string; id: string }

/** A target entry of `on_done.todos` read: `<quest>/<id>`, else the id in `ownQuest`. */
export function onDoneTargetRef(entry: string, ownQuest: string): TodoRef {
    const e = entry.trim();
    const slash = e.indexOf('/');
    return slash > 0 ? { quest: e.slice(0, slash), id: e.slice(slash + 1) } : { quest: ownQuest, id: e };
}

/** How a target is written in `on_done.todos`: the bare id in `ownQuest`, `<quest>/<id>` in another. */
export function onDoneTargetEntry(ref: TodoRef, ownQuest: string): string {
    return ref.quest === ownQuest ? ref.id : `${ref.quest}/${ref.id}`;
}

/** The targets of an `on_done`, each with its quest, without repeats. */
export function onDoneTargets(onDone: TodoOnDone | undefined, ownQuest: string): TodoRef[] {
    const seen = new Set<string>();
    const out: TodoRef[] = [];
    for (const entry of onDone?.todos ?? []) {
        const ref = onDoneTargetRef(entry, ownQuest);
        const key = `${ref.quest}/${ref.id}`;
        if (ref.id && !seen.has(key)) { seen.add(key); out.push(ref); }
    }
    return out;
}

/**
 * Why `value` is not an `on_done` block the schema accepts, or `undefined`.
 * The shape only (closed keys, types, the two actions) and the rule that
 * `unblock` needs `todos`; whether the targets exist is
 * {@link onDoneTargetRefusal}.
 */
export function onDoneShapeError(value: unknown): string | undefined {
    if (value === undefined || value === null) { return undefined; }
    if (typeof value !== 'object' || Array.isArray(value)) {
        return '`on_done` must be an object such as {"todos": ["<id>", "<quest>/<id>"], "action": ["unblock"]}.';
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
        return '`on_done.todos` must be a list of todo ids (`<quest>/<id>` for a todo of another quest).';
    }
    if (record.action !== undefined) {
        if (!Array.isArray(record.action)) { return '`on_done.action` must be a list, e.g. ["unblock", "notify"].'; }
        for (const a of record.action) {
            if ((RETIRED_ON_DONE_ACTIONS as readonly unknown[]).includes(a)) {
                return `\`on_done.action\` "${String(a)}" no longer exists; the actions are ${TODO_ON_DONE_ACTIONS.join(', ')} (without an action only the instructions and the done notification follow).`;
            }
            if (!(TODO_ON_DONE_ACTIONS as readonly unknown[]).includes(a)) {
                return `\`on_done.action\` has "${String(a)}"; the actions are ${TODO_ON_DONE_ACTIONS.join(', ')}.`;
            }
        }
        const todos = (record.todos as string[] | undefined) ?? [];
        if ((record.action as string[]).includes('unblock') && todos.length === 0) {
            return '`on_done.action` "unblock" needs `on_done.todos`: the todos it sets free.';
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

/**
 * Why an `on_done` names an `unblock` target that does not exist, or
 * `undefined` (archived and deleted todos count: `exists` answers over every
 * file of the quest).
 */
export function onDoneTargetRefusal(
    onDone: TodoOnDone | undefined,
    ownQuest: string,
    exists: (quest: string, id: string) => boolean,
): string | undefined {
    if (!(onDone?.action ?? []).includes('unblock')) { return undefined; }
    const missing = onDoneTargets(onDone, ownQuest).filter((r) => !exists(r.quest, r.id));
    if (missing.length === 0) { return undefined; }
    return `\`on_done.todos\` names ${missing.map((r) => `"${onDoneTargetEntry(r, ownQuest)}"`).join(', ')}, which ${missing.length === 1 ? 'is' : 'are'} in no todo file of ${missing.length === 1 ? 'its quest' : 'their quests'} (archived and deleted ones included; a todo of another quest is written \`<quest>/<id>\`).`;
}

/** Where the instructions are sent: `on_done.quest` / `run`, else the todo's own quest and the run it was completed in. */
export function onDoneInstructionTarget(onDone: TodoOnDone | undefined, ownQuest: string, completedRun: string): { quest: string; run: string } {
    const quest = onDone?.quest?.trim() || ownQuest;
    const run = onDone?.run?.trim() || (quest === ownQuest ? completedRun : 'default');
    return { quest, run };
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
