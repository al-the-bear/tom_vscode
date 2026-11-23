/**
 * Carrying out a completed todo's `on_done` (idea agent_collaboration,
 * part-todo-followups § When it runs): what the extension does when the todo
 * is completed, as a plan of writes and sends, before anything is written.
 *
 * - `unblock`: each target (`<quest>/<id>` or a bare id in the todo's quest)
 *   is set free — `group` for a group todo, else `not-started`, or
 *   `decision-needed` while it has an open decision — without looking at its
 *   other conditions. Its `blocked_by` is left as it is. Only a target that
 *   waits (blocked, not-started, decision-needed, group) changes; one that is
 *   in progress, waits for its repetition or is done is passed over.
 * - The done notification (vscimpb146): the todo's `notify_prompt`, else the
 *   configured template (`todoPanel.doneNotificationTemplate`) when the panel
 *   that queued the todo had its Done notification on, or when `notify` asks
 *   for it. It goes into the run and session that queued the todo
 *   (`ctx.queuedBy`); with `notify` checked into the quest and run of
 *   `filed_by` instead (that run's default session). Without a recipient or a
 *   text it is not sent.
 * - `instructions`: sent as a prompt to `on_done.quest` / `run` (unset: the
 *   todo's own quest and the run it was completed in), in that run's default
 *   session, with a header naming the completed todo and its answer.
 * Every prompt is queued next in its run (between the iterations of a loop
 * that is sending).
 *
 * A target that is gone, or only in a `-deleted` file, is skipped with a line
 * in the todo's notes.
 *
 * Where it runs: in a walk where the queue settles the todo's claim (after
 * `recordTodoAnswer`, so `last_answer` is there), outside a walk where the
 * todo writer sets `completed`, and for a group when its last member is
 * completed; a repeated todo on every completion. Once per completion: a
 * completion while the queue holds the todo's claim is left to the queue
 * ({@link onDoneDueAtSettle}).
 *
 * Pure: no `vscode`, no file system.
 */

/* eslint-disable @typescript-eslint/naming-convention -- the todo schema's YAML keys */
import { escapePlaceholders, fillPlaceholder } from './placeholderEscape';
import { onDoneInstructionTarget, onDoneTargetEntry, onDoneTargets, type TodoFiledBy, type TodoOnDone } from './todoOnDone';
import type { QueuedBy } from './queuedBy';

/** A target todo as the planner sees it. */
export interface OnDoneTarget {
    status: string;
    decisions?: Array<{ decision?: string }>;
    /** A group todo (status `group`, or members in `comprised_of`). */
    group?: boolean;
    /** Where it is: a live file, an `-archived` or a `-deleted` sibling. */
    where: 'live' | 'archived' | 'deleted';
    title?: string;
}

/** The completed todo. */
export interface CompletedTodo {
    id: string;
    title?: string;
    on_done?: TodoOnDone;
    filed_by?: TodoFiledBy;
    last_answer?: string;
    sourceFile?: string;
}

export interface OnDoneContext {
    /** The quest the completed todo is in. */
    quest: string;
    /** The run it was completed in (the walk's item, else the window's): where its instructions go by default. */
    run: string;
    /** Look a todo up in every file of a quest, archived and deleted siblings included. */
    findTodo(quest: string, id: string): OnDoneTarget | undefined;
    /** For the notes line. */
    today: string;
    /** The configured todo done-notification template, used when the block has no `notify_prompt`. */
    notifyTemplate?: string;
    /** Who queued the todo (the queue item or chat send that ran it): where the done notification goes. */
    queuedBy?: QueuedBy;
}

/** A target's new status. */
export interface UnblockWrite {
    quest: string;
    id: string;
    status: 'not-started' | 'decision-needed' | 'group';
}

/** A prompt queued at a quest and run, next in its queue. */
export interface OnDoneSend {
    quest: string;
    run: string;
    text: string;
    /** The session it runs in (the notification to the queuing run: its session); unset: the run's queue default. */
    session?: string;
    /** Queued next in its run (between the iterations of a loop that is sending). */
    next: true;
}

export interface OnDonePlan {
    unblock: UnblockWrite[];
    notify?: OnDoneSend;
    instructions?: OnDoneSend;
    /** Lines for the completed todo's notes (deleted or missing targets). */
    notes: string[];
    /** Targets passed over (done, in progress, waiting for a repetition), for the log. */
    skipped: string[];
    /** Why a done notification was not sent, when one was meant (no text, no recipient), for the log. */
    notifyNotSent?: string;
}

const DONE = new Set(['completed', 'cancelled']);
/** The statuses `unblock` changes: a todo that waits. */
const WAITING = new Set(['blocked', 'not-started', 'decision-needed', 'group']);

/** The placeholders of a notification prompt filled from the completed todo; the values are escaped. */
export function fillTodoPlaceholders(text: string, todo: CompletedTodo, ctx: { quest: string; run: string }): string {
    const onDoneYaml = todo.on_done ? JSON.stringify(todo.on_done) : '(none)';
    const filedBy = todo.filed_by ? Object.entries(todo.filed_by).map(([k, v]) => `${k} ${v}`).join(', ') : '(not recorded)';
    const values: Record<string, string> = {
        todoId: todo.id,
        todoTitle: todo.title ?? '',
        todoFile: todo.sourceFile ?? '',
        todoStatus: 'completed',
        itemOutcome: 'completed',
        itemAnswer: todo.last_answer?.trim() || '(no answer recorded)',
        todoLastAnswer: todo.last_answer?.trim() || '(no answer recorded)',
        todoOnDone: onDoneYaml,
        filedBy,
        reportTo: todo.on_done?.report_to || '(none)',
        senderQuest: ctx.quest,
        senderRun: ctx.run,
    };
    let out = text;
    for (const [name, value] of Object.entries(values)) { out = fillPlaceholder(out, `\${${name}}`, escapePlaceholders(value)); }
    return out;
}

/** The prompt that carries a completed todo's instructions: who sends them, the instructions, the todo's answer. */
export function instructionsPrompt(todo: CompletedTodo, ctx: { quest: string; run: string }): string {
    const title = todo.title?.trim() ? ` — ${escapePlaceholders(todo.title.trim())}` : '';
    const answer = todo.last_answer?.trim() ? escapePlaceholders(todo.last_answer.trim()) : '(no answer recorded)';
    return [
        `The todo \`${ctx.quest}/${todo.id}\`${title} was completed (run ${ctx.run}). Its After done sends you these instructions:`,
        '',
        fillTodoPlaceholders(todo.on_done?.instructions ?? '', todo, ctx).trim(),
        '',
        'The answer the todo was completed with:',
        '',
        answer,
        '',
    ].join('\n');
}

/** The status `unblock` gives a waiting target: `group`, else `decision-needed` with an open decision, else `not-started`. */
export function unblockedStatus(t: OnDoneTarget): UnblockWrite['status'] {
    if (t.group) { return 'group'; }
    const openDecision = (t.decisions ?? []).some((d) => !(typeof d.decision === 'string' && d.decision.trim()));
    return openDecision ? 'decision-needed' : 'not-started';
}

/** What carrying out `todo`'s `on_done` writes and sends. */
export function planOnDoneRun(todo: CompletedTodo, ctx: OnDoneContext): OnDonePlan {
    const plan: OnDonePlan = { unblock: [], notes: [], skipped: [] };
    // A todo without After done still gets the template when the panel that queued it asked for done notifications.
    const onDone: TodoOnDone = todo.on_done ?? {};
    const actions = onDone.action ?? [];

    if (actions.includes('unblock')) {
        for (const ref of onDoneTargets(onDone, ctx.quest)) {
            const name = `${ref.quest}/${ref.id}`;
            const t = ctx.findTodo(ref.quest, ref.id);
            if (!t) { plan.notes.push(`[on_done ${ctx.today}] ${name} does not exist; not unblocked.`); continue; }
            if (t.where === 'deleted') { plan.notes.push(`[on_done ${ctx.today}] ${name} was deleted; not unblocked.`); continue; }
            const status = t.status.trim().toLowerCase();
            if (t.where === 'archived' || DONE.has(status) || !WAITING.has(status)) {
                plan.skipped.push(`${onDoneTargetEntry(ref, ctx.quest)} (${t.where === 'archived' ? 'archived' : t.status})`);
                continue;
            }
            const next = unblockedStatus(t);
            if (next !== status) { plan.unblock.push({ quest: ref.quest, id: ref.id, status: next }); }
        }
    }

    // The done notification: to the run that queued the todo, or with `notify` to the run that filed it.
    const toFiledBy = actions.includes('notify');
    const ownPrompt = onDone.notify_prompt?.trim() ? onDone.notify_prompt : undefined;
    const templateAllowed = toFiledBy || ctx.queuedBy?.withTemplate === true;
    const text = ownPrompt ?? (templateAllowed && ctx.notifyTemplate?.trim() ? ctx.notifyTemplate : undefined);
    if (text) {
        if (toFiledBy) {
            if (todo.filed_by?.quest && todo.filed_by.quest !== 'default') {
                plan.notify = { quest: todo.filed_by.quest, run: todo.filed_by.run || 'default', text: fillTodoPlaceholders(text, todo, ctx), next: true };
            } else {
                plan.notifyNotSent = 'notify asks for the filed-by quest, and the todo records none';
            }
        } else if (ctx.queuedBy) {
            plan.notify = {
                quest: ctx.queuedBy.quest,
                run: ctx.queuedBy.run,
                ...(ctx.queuedBy.session ? { session: ctx.queuedBy.session } : {}),
                text: fillTodoPlaceholders(text, todo, ctx),
                next: true,
            };
        } else {
            plan.notifyNotSent = 'no queuing run is known (the todo was not completed in a queue item or chat send that recorded who queued it)';
        }
    } else if (toFiledBy) {
        plan.notifyNotSent = 'no notify_prompt and no done-notification template configured';
    }

    if (onDone.instructions?.trim()) {
        const target = onDoneInstructionTarget(onDone, ctx.quest, ctx.run);
        plan.instructions = { quest: target.quest, run: target.run, text: instructionsPrompt(todo, ctx), next: true };
    }
    return plan;
}

/**
 * At a walk's claim settle: whether the queue carries out the todo's
 * `on_done` now. Yes when a completion was left to it while it held the claim
 * (`deferred`), or when the todo is `completed` now (completed without the
 * todo writer, e.g. by hand). Once per completion: a completion the writer
 * carried out itself was not claimed, so the queue never sees it.
 */
export function onDoneDueAtSettle(deferred: boolean, statusNow: string | undefined): boolean {
    return deferred || statusNow?.trim().toLowerCase() === 'completed';
}

/** Whether an update completes the todo: `completed` asked for a todo that was not completed (a repeated todo too, which then waits for its repetition). */
export function isCompletion(before: { status?: string } | undefined, requestedStatus: string | undefined): boolean {
    return requestedStatus === 'completed' && before?.status !== 'completed';
}
