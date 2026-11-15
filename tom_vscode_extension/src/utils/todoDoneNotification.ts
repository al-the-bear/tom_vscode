/**
 * The todo done notification (idea agent_collaboration, part-done-notification;
 * BP-3, DP-part-done-notification-1 … 6): queue items and chat sends the todo
 * panel makes for todos carry a done-notification prompt marked as a todo
 * notification (`doneNotificationTodo`). When such an item finishes — a walk
 * per todo, as each todo's repetition settles — the prompt is filled from the
 * todo as it is then and queued where the todo's `on_done` points, else in the
 * item's own queue and run (utils/doneNotification.ts plans and delivers it).
 *
 * - A todo without `on_done` gets none (-3).
 * - Its `on_done.notify_prompt` replaces the template (-4): one notification
 *   per todo. The extension's own `notify` action for that completion is then
 *   left out (services/todoOnDoneRunner.ts, `skipNotify`).
 * - A todo that is gone (not in any file of the quest) reads
 *   `(todo <id> not found)` and goes to the item's own queue.
 * - The template is `todoPanel.doneNotificationTemplate`, else
 *   {@link TODO_DONE_NOTIFICATION_DEFAULT}; the todo panel's Done notification
 *   box (on by default, per quest) decides whether its items carry it.
 *
 * Every filled value is escaped, so an answer or an `on_done` holding `${…}`
 * reaches the receiver as written.
 *
 * vscode-free.
 */

/* eslint-disable @typescript-eslint/naming-convention -- the todo schema's YAML keys */
import * as yaml from 'yaml';

import type { DoneNotificationItem } from './doneNotification';
import { escapePlaceholders, fillPlaceholder } from './placeholderEscape';
import { parseTodoPrefixPattern } from './queueStep3Utils';
import type { TodoFiledBy, TodoOnDone } from './todoOnDone';

/** The default text (BP-3, DP-part-done-notification-6). */
export const TODO_DONE_NOTIFICATION_DEFAULT =
    'Todo ${todoId} (${todoTitle}) is ${itemOutcome}. Its follow-up: ${todoOnDone}. Do what it says; if it says nothing, '
    + 'there is nothing to do. If it is not done, report that and do not carry out the follow-up.';

/** The placeholders the template takes, for the editor's help. */
export const TODO_DONE_NOTIFICATION_PLACEHOLDERS: ReadonlyArray<[string, string]> = [
    ['${todoId}', 'the todo\'s id'],
    ['${todoTitle}', 'its title'],
    ['${todoFile}', 'its *.todo.yaml, workspace-relative'],
    ['${todoStatus}', 'its status after the run (e.g. completed)'],
    ['${itemOutcome}', '`done` or `error: <message>`'],
    ['${itemAnswer}', 'the item\'s answer (a walk: this todo\'s), cut at 4,000 characters'],
    ['${todoLastAnswer}', 'the answer stored on the todo (last_answer)'],
    ['${todoOnDone}', 'its on_done block as YAML'],
    ['${filedBy}', 'its filed_by in one line, (unknown) without one'],
    ['${senderQuest}', 'the quest the notification comes from'],
    ['${senderRun}', 'and its run'],
];

/** The configured template, else the default. */
export function todoDoneNotificationTemplate(config: { todoPanel?: { doneNotificationTemplate?: string } } | null | undefined): string {
    const own = config?.todoPanel?.doneNotificationTemplate;
    return own && own.trim() ? own : TODO_DONE_NOTIFICATION_DEFAULT;
}

/** A todo as the notification reads it, at finish time. */
export interface TodoForNotification {
    id: string;
    title?: string;
    status?: string;
    on_done?: TodoOnDone;
    filed_by?: TodoFiledBy;
    last_answer?: string;
    /** Workspace-relative path of its file. */
    file?: string;
}

/** The one todo an item runs (`todoIdPattern` a single id), else undefined. */
export function singleTodoOf(item: { todoIdPattern?: string }): string | undefined {
    const p = item.todoIdPattern?.trim();
    return p && !p.includes(',') && !p.endsWith('*') ? p : undefined;
}

/** Whether the item is a `<prefix>*` walk: it notifies per todo, its own end adds none (-2). */
export function isWalkItem(item: { repeatCount?: number | string }): boolean {
    return parseTodoPrefixPattern(item.repeatCount) !== undefined;
}

/** `filed_by` in one line. */
export function filedByLine(filedBy: TodoFiledBy | undefined): string {
    if (!filedBy || Object.keys(filedBy).length === 0) { return '(unknown)'; }
    return (['quest', 'run', 'session', 'todo', 'at'] as const)
        .filter((k) => filedBy[k]).map((k) => `${k} ${filedBy[k]}`).join(', ');
}

/** `on_done` as YAML, `(none)` without one. */
export function onDoneYaml(onDone: TodoOnDone | undefined): string {
    return onDone ? yaml.stringify(onDone, { lineWidth: 0 }).trimEnd() : '(none)';
}

/** The todo placeholders of `prompt` filled (escaped); `${itemOutcome}` and the item ones are left to the planner. */
export function fillTodoNotification(prompt: string, todoId: string, todo: TodoForNotification | undefined): string {
    const gone = `(todo ${todoId} not found)`;
    const values: Array<[string, string]> = [
        ['${todoId}', todoId],
        ['${todoTitle}', todo ? (todo.title ?? '') : gone],
        ['${todoFile}', todo ? (todo.file ?? '') : gone],
        ['${todoStatus}', todo ? (todo.status ?? 'unknown') : gone],
        ['${todoLastAnswer}', todo ? (todo.last_answer?.trim() || '(no answer stored)') : gone],
        ['${todoOnDone}', todo ? onDoneYaml(todo.on_done) : gone],
        ['${filedBy}', todo ? filedByLine(todo.filed_by) : gone],
    ];
    let out = prompt;
    for (const [placeholder, value] of values) { out = fillPlaceholder(out, placeholder, escapePlaceholders(value)); }
    return out;
}

/**
 * The item the planner (planDoneNotification) gets for the todo `todoId` of
 * `base`: its prompt filled from the todo, its target the todo's `on_done`
 * quest and run, else the item's own. Null when the todo has no `on_done`
 * (-3). `perTodo` (a walk's todo, a chat send of several): a run key of its
 * own, so each todo is notified once, and the item's pause and temporary
 * session stay with the item; its answer is that todo's.
 */
export function todoNotificationItem(
    base: DoneNotificationItem,
    todoId: string,
    todo: TodoForNotification | undefined,
    opts: { perTodo: boolean },
): DoneNotificationItem | null {
    if (todo && !todo.on_done) { return null; }
    const prompt = todo?.on_done?.notify_prompt?.trim() ? todo.on_done.notify_prompt : base.doneNotificationPrompt;
    if (!prompt || !prompt.trim()) { return null; }
    const out: DoneNotificationItem = {
        ...base,
        doneNotificationPrompt: fillTodoNotification(prompt, todoId, todo),
        doneNotificationDisabled: false,
        doneNotificationQuest: todo?.on_done?.quest?.trim() || undefined,
        doneNotificationRun: todo?.on_done?.run?.trim() || undefined,
    };
    if (opts.perTodo) {
        out.runId = `${base.runId || 'run'}:${todoId}`;
        out.doneNotificationQueuedFor = undefined;
        out.pauseAfter = false;
        out.temporarySession = false;
        out.repetitionAnswers = (base.repetitionAnswers ?? []).filter((a) => a.key === todoId);
        if (out.repetitionAnswers.length === 0) { out.repetitionAnswers = undefined; }
    }
    return out;
}
