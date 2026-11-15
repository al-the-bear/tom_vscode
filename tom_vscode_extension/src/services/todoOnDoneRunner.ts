/**
 * Runs a completed todo's `on_done` (utils/todoOnDoneRun.ts plans it): writes
 * the unblocked targets, queues the notification and the queued todos — in
 * this window's queue for its own quest, through the quest inbox for another —
 * and notes skipped targets on the todo.
 *
 * The extension's `notify` is left out (`skipNotify`) when the queue item or
 * chat send that ran the todo carries the todo done notification
 * (utils/todoDoneNotification.ts): one notification per todo.
 *
 * Two places call it, once per completion:
 * - the todo writer (questTodoManager.updateTodo) when an update completes a
 *   todo — unless the prompt queue holds that todo's claim (a walk runs it):
 *   then the completion is left to the queue ({@link deferTodoOnDone});
 * - the prompt queue where it settles a walk's claim, after `last_answer` is
 *   written ({@link takeDeferredTodoOnDone}, onDoneDueAtSettle).
 *
 * vscode-free: everything it touches goes through {@link TodoOnDonePorts},
 * wired at activation (extension.ts).
 */

import { planOnDoneRun, type CompletedTodo, type OnDoneContext, type OnDonePlan, type OnDoneSend, type OnDoneTarget } from '../utils/todoOnDoneRun';

export interface TodoOnDonePorts {
    /** The quest of this window. */
    windowQuest(): string | undefined;
    findTodo(quest: string, id: string): OnDoneTarget | undefined;
    groupPrompt(quest: string): string;
    /** The configured todo done-notification template (todoPanel.doneNotificationTemplate), when one is set. */
    notifyTemplate?(): string | undefined;
    /** Write a target's `blocked_by` (and status). */
    writeTarget(quest: string, id: string, blockedBy: string[], status?: string): void;
    /** Append lines to a todo's notes. */
    appendNotes(quest: string, id: string, lines: string[]): void;
    /** Queue a prompt in this window's queue, in `run`; `todoId` marks the todo it runs. */
    enqueueLocal(send: OnDoneSend): Promise<void>;
    /** Post a prompt into another quest's inbox, queued there in `run`. */
    postToQuest(send: OnDoneSend, from: { quest: string; run: string }): void;
    log(line: string): void;
    today(): string;
}

let ports: TodoOnDonePorts | undefined;
const deferred = new Set<string>();

/** Wire the runner (activation); undefined unwires it (tests). */
export function setTodoOnDonePorts(p: TodoOnDonePorts | undefined): void {
    ports = p;
    deferred.clear();
}

const key = (quest: string, id: string): string => `${quest}/${id}`;

/** A completion seen while the queue holds the todo's claim: the queue carries it out when it settles. */
export function deferTodoOnDone(quest: string, id: string): void { deferred.add(key(quest, id)); }

/** Whether a completion was deferred to the queue for the todo; the mark is taken. */
export function takeDeferredTodoOnDone(quest: string, id: string): boolean {
    return deferred.delete(key(quest, id));
}

/**
 * Carry out `todo`'s `on_done`, completed in `quest` and `run`. Answers the
 * plan it carried out (undefined without a runner or a block). Each step is
 * tried on its own: a failing send is logged and the others still run.
 */
export async function runTodoOnDone(quest: string, todo: CompletedTodo, run: string, opts: { skipNotify?: boolean } = {}): Promise<OnDonePlan | undefined> {
    const p = ports;
    if (!p || !todo.on_done) { return undefined; }
    const ctx: OnDoneContext = {
        quest, run,
        findTodo: (q, id) => p.findTodo(q, id),
        groupPrompt: (q) => p.groupPrompt(q),
        today: p.today(),
        ...(p.notifyTemplate?.() ? { notifyTemplate: p.notifyTemplate() } : {}),
    };
    const plan = planOnDoneRun(todo, ctx);
    // The todo done notification of the item that ran it covers this completion: one notification per todo.
    if (opts.skipNotify && plan.notify) {
        p.log(`on_done of ${quest}/${todo.id}: notify left to the item's todo done notification`);
        plan.notify = undefined;
    }
    const step = async (what: string, fn: () => unknown): Promise<void> => {
        try { await fn(); } catch (e) { p.log(`on_done of ${quest}/${todo.id}: ${what} failed: ${(e as Error).message}`); }
    };
    for (const u of plan.unblock) {
        await step(`unblock ${u.quest}/${u.id}`, () => p.writeTarget(u.quest, u.id, u.blockedBy, u.status));
    }
    const here = p.windowQuest();
    const send = async (s: OnDoneSend, what: string): Promise<void> => {
        await step(what, () => (s.quest === here ? p.enqueueLocal(s) : p.postToQuest(s, { quest, run })));
    };
    for (const q of plan.queue) { await send(q, `queue ${q.quest}/${q.todoId}`); }
    if (plan.notify) { await send(plan.notify, `notify ${plan.notify.quest}`); }
    if (plan.notes.length) { await step('notes', () => p.appendNotes(quest, todo.id, plan.notes)); }
    p.log(`on_done of ${quest}/${todo.id}: ${plan.unblock.length} unblocked, ${plan.queue.length} queued, `
        + `${plan.notify ? `notified ${plan.notify.quest}/${plan.notify.run}` : 'no notification'}`
        + `${plan.skipped.length ? `; done targets skipped: ${plan.skipped.join(', ')}` : ''}`
        + `${plan.notes.length ? `; ${plan.notes.length} noted` : ''}`);
    return plan;
}
