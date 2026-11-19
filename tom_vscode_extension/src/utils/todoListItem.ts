/**
 * One row of the todo panel's list: the fields a list row, its filters and
 * its sort read (media/questTodoPanel/main.js qtRenderTodoRow and the filter
 * and sort beside it). The detail form reads the full todo separately.
 *
 * Every list the panel shows is built here, so a field the list needs is added
 * once: the list was once built by six hand-written copies, none of which
 * carried `user_action`, and no row ever showed its 👤 mark.
 *
 * vscode-free.
 */

// The snake_case names are the todo files' own field names (todo.schema.json),
// which the webview reads as they are.
/* eslint-disable @typescript-eslint/naming-convention */

import { describeRepeat, repeatRuleError, type TodoRepeat } from './todoRepeat';
import { describeRemind, describeReminderEntry, remindRuleError, type TodoReminderEntry } from './todoRemind';
import { isTodoOverdue, localDate } from './todoDue';

/** What a list row is built from: a todo as the todo manager reads it. */
export interface TodoListSource {
    id: string;
    title?: string;
    description?: string;
    status?: string;
    priority?: string;
    tags?: string[];
    created?: string;
    updated?: string;
    completed_date?: string;
    /** The target completion date (YYYY-MM-DD). */
    due?: string;
    user_action?: boolean;
    blocking?: string[];
    /** A group todo's members (vscimpb125). */
    comprised_of?: string[];
    repeat?: TodoRepeat;
    next_repeat?: string;
    remind?: TodoRepeat;
    next_remind?: string;
    reminders?: TodoReminderEntry[];
    /** The questions behind a `decision-needed` status; one without a `decision` is open. */
    decisions?: Array<{ summary?: string; decision?: string }>;
}

export interface TodoListItem {
    id: string;
    title?: string;
    status?: string;
    priority?: string;
    tags?: string[];
    created?: string;
    updated?: string;
    completed_date?: string;
    /** The target completion date (YYYY-MM-DD), when it has one. */
    due?: string;
    /** Present, and true, when `due` has passed and the todo is open (derived; the row's overdue mark). */
    overdue?: true;
    /** Present, and true, only for the user's own todos. */
    user_action?: true;
    /** The todos this one blocks (the reverse of their `blocked_by`); present only when there are any. */
    blocking?: string[];
    /** A repeated todo: its rule in words (the row's 🔁 mark and its tooltip). */
    repeat?: string;
    /** A manual repeated todo: Repeat now is offered while it waits. */
    repeat_manual?: true;
    /** When a waiting repeated todo is due again. */
    next_repeat?: string;
    /** The reminders it has, in words (the row's 🔔 mark and its tooltip): its `remind` schedule and its one-shot reminders still to ring. */
    reminders?: string[];
    /** A `decision-needed` todo: the summaries of its open decisions (the row's and its group's yellow chip). */
    open_decisions?: string[];
    /** A group todo (status `group`): its members as written (vscimpb126). */
    comprised_of?: string[];
    /** A group todo: its members with title and status, in `comprised_of` order ({@link withTodoGroups}). */
    group_members?: GroupMemberRow[];
    /** The groups this todo is a member of (derived; the row's chips). */
    part_of?: string[];
    sourceFile: string;
}

/** A member of a group todo, as the panel lists it under the group. */
export interface GroupMemberRow {
    /** As written in `comprised_of` (`<quest>/<id>` for another quest's). */
    ref: string;
    quest: string;
    id: string;
    title?: string;
    status?: string;
    /** The member exists (live, else archived / deleted). */
    found: boolean;
}

/** Where the group data of a list comes from (todoBlockingCascade.groupListInfo). */
export interface TodoGroupInfo {
    partOf(quest: string, id: string): string[];
    members(quest: string, comprisedOf: readonly string[]): GroupMemberRow[];
}

/**
 * The list with its todo groups (vscimpb126): each row's `part_of`, and each
 * group row's members. `questOf` names a row's quest (undefined: not a quest
 * todo, left as it is).
 */
export function withTodoGroups(items: readonly TodoListItem[], questOf: (item: TodoListItem) => string | undefined, info: TodoGroupInfo): TodoListItem[] {
    return items.map((item) => {
        const quest = questOf(item);
        if (!quest) { return item; }
        const partOf = info.partOf(quest, item.id);
        const members = item.comprised_of?.length ? info.members(quest, item.comprised_of) : undefined;
        return {
            ...item,
            ...(partOf.length ? { part_of: partOf } : {}),
            ...(members ? { group_members: members } : {}),
        };
    });
}

/** Title shown when a todo has none: the start of its description. */
const TITLE_FALLBACK_LENGTH = 60;

/**
 * The list row of `todo`, read from `sourceFile`. `id` replaces the todo's own
 * id where the list shows a composed one (session todos).
 */
export function todoListItem(todo: TodoListSource, sourceFile: string, id: string = todo.id, today: string = localDate(new Date())): TodoListItem {
    const row: TodoListItem = {
        id,
        title: todo.title ?? todo.description?.substring(0, TITLE_FALLBACK_LENGTH),
        status: todo.status,
        priority: todo.priority,
        tags: todo.tags,
        created: todo.created,
        updated: todo.updated,
        sourceFile,
    };
    if (todo.completed_date) { row.completed_date = todo.completed_date; }
    if (todo.due) { row.due = todo.due; }
    if (isTodoOverdue(todo, today)) { row.overdue = true; }
    if (todo.comprised_of?.length) { row.comprised_of = [...todo.comprised_of]; }
    if (todo.user_action === true) { row.user_action = true; }
    if (todo.blocking && todo.blocking.length) { row.blocking = todo.blocking; }
    if (todo.repeat && !repeatRuleError(todo.repeat)) {
        row.repeat = describeRepeat(todo.repeat);
        if (todo.repeat.rule === 'manual') { row.repeat_manual = true; }
    }
    if (todo.next_repeat) { row.next_repeat = todo.next_repeat; }
    const reminders: string[] = [];
    if (todo.remind && !remindRuleError(todo.remind)) {
        reminders.push(`${describeRemind(todo.remind)}${todo.next_remind ? ` — next ${todo.next_remind.replace('T', ' ')}` : ' — ended'}`);
    }
    for (const entry of todo.reminders ?? []) {
        if (!(entry.acknowledged ?? '').trim()) { reminders.push(describeReminderEntry(entry)); }
    }
    if (reminders.length) { row.reminders = reminders; }
    if (todo.status === 'decision-needed') {
        row.open_decisions = (todo.decisions ?? [])
            .filter((d) => !(typeof d?.decision === 'string' && d.decision.trim()))
            .map((d) => (typeof d?.summary === 'string' && d.summary.trim() ? d.summary.trim() : '(a decision)'));
    }
    return row;
}
