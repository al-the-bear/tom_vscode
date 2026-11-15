/**
 * Carrying out a completed todo's `on_done` (idea agent_collaboration,
 * part-todo-followups § When it runs; DP-part-todo-followups-1, DPR-5): what
 * the extension does when the todo is completed, as a plan of writes and
 * sends, before anything is written.
 *
 * The extension does the deterministic actions; the executing agent only the
 * `instructions` (the walk line in BUILTIN_GROUP_PROMPT says so):
 * - `unblock`: each target's `blocked_by` entry naming this todo is met and
 *   removed; a `blocked` target with nothing else blocking it becomes
 *   `not-started` (`decision-needed` when it has an open decision);
 * - `notify`: a prompt — `notify_prompt`, else {@link TODO_NOTIFY_DEFAULT} —
 *   queued at `on_done.quest` / `run` (another quest: through its inbox). The
 *   receiver records the result at `report_to`;
 * - `queue`: each target todo queued by the extension itself at that quest
 *   and run, with the quest's group prompt and the todo's record; a
 *   notification only reports.
 * A target already done (completed, cancelled, archived) is skipped; a target
 * that is gone, or only in a `-deleted` file, is skipped with a line in the
 * todo's notes.
 *
 * Where it runs: in a walk where the queue settles the todo's claim (after
 * `recordTodoAnswer`, so `last_answer` is there), outside a walk where the
 * todo writer sets `completed`; a repeated todo on every completion. Once per
 * completion: a completion while the queue holds the todo's claim is left to
 * the queue ({@link onDoneDueAtSettle}).
 *
 * Pure: no `vscode`, no file system.
 */

/* eslint-disable @typescript-eslint/naming-convention -- the todo schema's YAML keys */
import { escapePlaceholders, fillPlaceholder } from './placeholderEscape';
import { withTodoYaml, todoYamlBlock } from './todoIterationRecord';
import { onDoneQuest, unblockEntry, type TodoFiledBy, type TodoOnDone } from './todoOnDone';

/** A target todo as the planner sees it. */
export interface OnDoneTarget {
    status: string;
    blocked_by?: string[];
    blocked_until?: string[];
    decisions?: Array<{ decision?: string }>;
    /** Where it is: a live file, an `-archived` or a `-deleted` sibling. */
    where: 'live' | 'archived' | 'deleted';
    /** The whole record (for a queued todo's prompt) and its file. */
    record: Record<string, unknown>;
    sourceFile?: string;
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
    /** The run it was completed in (the walk's item, else the window's): the default target run in its own quest. */
    run: string;
    /** Look a todo up in every file of a quest, archived and deleted siblings included. */
    findTodo(quest: string, id: string): OnDoneTarget | undefined;
    /** The default group prompt of a quest (its own, else the global, else the built-in). */
    groupPrompt(quest: string): string;
    /** For the notes line. */
    today: string;
}

/** A target's `blocked_by` rewritten, and its status when it changes. */
export interface UnblockWrite {
    quest: string;
    id: string;
    blockedBy: string[];
    status?: 'not-started' | 'decision-needed';
}

/** A prompt queued at a quest and run. */
export interface OnDoneSend {
    quest: string;
    run: string;
    text: string;
    /** For a queued todo: its id (the queue item's todoIdPattern). */
    todoId?: string;
}

export interface OnDonePlan {
    unblock: UnblockWrite[];
    notify?: OnDoneSend;
    queue: OnDoneSend[];
    /** Lines for the completed todo's notes (deleted or missing targets). */
    notes: string[];
    /** Targets passed over because they are done (for the log). */
    skipped: string[];
}

/**
 * The prompt a `notify` queues when the block has no `notify_prompt`. The
 * todo done-notification template (ww_a_collab-6) will make it editable; its
 * placeholders are the ones {@link fillTodoPlaceholders} fills.
 */
export const TODO_NOTIFY_DEFAULT =
    'Todo ${todoId} (${todoTitle}) of quest ${senderQuest} is ${itemOutcome}. '
    + 'Record the result where its follow-up says (`report_to`: ${reportTo}); if it names no place, there is nothing to record.\n\n'
    + 'Its answer:\n\n${todoLastAnswer}';

const DONE = new Set(['completed', 'cancelled']);

/** The placeholders of a notification prompt filled from the completed todo; the values are escaped. */
export function fillTodoPlaceholders(text: string, todo: CompletedTodo, ctx: { quest: string; run: string }): string {
    const onDoneYaml = todo.on_done ? JSON.stringify(todo.on_done) : '(none)';
    const filedBy = todo.filed_by ? Object.entries(todo.filed_by).map(([k, v]) => `${k} ${v}`).join(', ') : '(not recorded)';
    const values: Record<string, string> = {
        todoId: todo.id,
        todoTitle: todo.title ?? '',
        todoFile: todo.sourceFile ?? '',
        itemOutcome: 'completed',
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

/** The prompt that queues one todo: the group prompt with the walk's placeholders filled for it, and its record. */
export function queuedTodoPrompt(groupPrompt: string, quest: string, id: string, target: OnDoneTarget): string {
    let text = groupPrompt;
    text = fillPlaceholder(text, '${repeatTodoId}', id);
    text = fillPlaceholder(text, '${repeatTodoTitle}', escapePlaceholders(target.title ?? id));
    text = fillPlaceholder(text, '${repeatNumber}', '1');
    text = fillPlaceholder(text, '${quest}', quest);
    return withTodoYaml(text, todoYamlBlock(target.record, target.sourceFile));
}

/** What carrying out `todo`'s `on_done` writes and sends. */
export function planOnDoneRun(todo: CompletedTodo, ctx: OnDoneContext): OnDonePlan {
    const plan: OnDonePlan = { unblock: [], queue: [], notes: [], skipped: [] };
    const onDone = todo.on_done;
    if (!onDone) { return plan; }
    const actions = onDone.action ?? [];
    const targetQuest = onDoneQuest(onDone, ctx.quest);
    const targetRun = onDone.run?.trim() || (targetQuest === ctx.quest ? ctx.run : 'default');
    const live = (id: string): OnDoneTarget | undefined => {
        const t = ctx.findTodo(targetQuest, id);
        if (!t) {
            plan.notes.push(`[on_done ${ctx.today}] ${targetQuest}/${id} does not exist; skipped.`);
            return undefined;
        }
        if (t.where === 'deleted') {
            plan.notes.push(`[on_done ${ctx.today}] ${targetQuest}/${id} was deleted; skipped.`);
            return undefined;
        }
        if (t.where === 'archived' || DONE.has(t.status)) {
            plan.skipped.push(`${targetQuest}/${id} (${t.status})`);
            return undefined;
        }
        return t;
    };
    const targets = [...new Set(onDone.todos ?? [])];
    const resolved = new Map<string, OnDoneTarget | undefined>();
    const target = (id: string): OnDoneTarget | undefined => {
        if (!resolved.has(id)) { resolved.set(id, live(id)); }
        return resolved.get(id);
    };
    if (actions.includes('unblock')) {
        const entry = unblockEntry(ctx.quest, todo.id, targetQuest);
        for (const id of targets) {
            const t = target(id);
            if (!t) { continue; }
            const blockedBy = (t.blocked_by ?? []).filter((e) => e !== entry);
            const free = blockedBy.length === 0 && (t.blocked_until ?? []).length === 0;
            const openDecision = (t.decisions ?? []).some((d) => !(typeof d.decision === 'string' && d.decision.trim()));
            const status = t.status === 'blocked' && free ? (openDecision ? 'decision-needed' : 'not-started') : undefined;
            if (blockedBy.length === (t.blocked_by ?? []).length && !status) { continue; }
            plan.unblock.push({ quest: targetQuest, id, blockedBy, ...(status ? { status } : {}) });
        }
    }
    if (actions.includes('queue')) {
        const prompt = ctx.groupPrompt(targetQuest);
        for (const id of targets) {
            const t = target(id);
            if (!t) { continue; }
            plan.queue.push({ quest: targetQuest, run: targetRun, todoId: id, text: queuedTodoPrompt(prompt, targetQuest, id, t) });
        }
    }
    if (actions.includes('notify')) {
        const text = onDone.notify_prompt?.trim() ? onDone.notify_prompt : TODO_NOTIFY_DEFAULT;
        plan.notify = { quest: targetQuest, run: targetRun, text: fillTodoPlaceholders(text, todo, { quest: ctx.quest, run: ctx.run }) };
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
