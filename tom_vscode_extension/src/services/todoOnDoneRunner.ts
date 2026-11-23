/**
 * Runs what follows a completed todo (utils/todoOnDoneRun.ts plans it): sets
 * its `unblock` targets free, queues its done notification and its
 * instructions — next in their runs: in this window's queue for its own
 * quest, through the quest inbox for another — and notes skipped targets on
 * the todo.
 *
 * Two places call it, once per completion:
 * - the todo writer (questTodoManager.updateTodo) when an update completes a
 *   todo — unless the prompt queue holds that todo's claim (a walk runs it):
 *   then the completion is left to the queue ({@link deferTodoOnDone});
 * - the prompt queue where it settles a walk's claim, after `last_answer` is
 *   written ({@link takeDeferredTodoOnDone}, onDoneDueAtSettle).
 * A group its members completed runs it through the todo writer's hook.
 *
 * vscode-free: everything it touches goes through {@link TodoOnDonePorts},
 * wired at activation (extension.ts).
 */

import { planOnDoneRun, type CompletedTodo, type OnDoneContext, type OnDonePlan, type OnDoneSend, type OnDoneTarget } from '../utils/todoOnDoneRun';
import type { QueuedBy } from '../utils/queuedBy';

export interface TodoOnDonePorts {
    /** The quest of this window. */
    windowQuest(): string | undefined;
    findTodo(quest: string, id: string): OnDoneTarget | undefined;
    /** The configured todo done-notification template (todoPanel.doneNotificationTemplate), when one is set. */
    notifyTemplate?(): string | undefined;
    /** Set a target's status (unblock). */
    writeTarget(quest: string, id: string, status: string): void;
    /** Append lines to a todo's notes. */
    appendNotes(quest: string, id: string, lines: string[]): void;
    /** Queue a prompt next in this window's queue, in `run` (and `session`, when set). */
    enqueueLocal(send: OnDoneSend): Promise<void>;
    /** Post a prompt into another quest's inbox, queued next there in `run`. */
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
 * Carry out what follows `todo`, completed in `quest` and `run`. Answers the
 * plan it carried out (undefined without a runner, or when nothing follows).
 * Each step is tried on its own: a failing send is logged and the others still run.
 */
export async function runTodoOnDone(quest: string, todo: CompletedTodo, run: string, opts: { queuedBy?: QueuedBy } = {}): Promise<OnDonePlan | undefined> {
    const p = ports;
    if (!p) { return undefined; }
    const ctx: OnDoneContext = {
        quest, run,
        findTodo: (q, id) => p.findTodo(q, id),
        today: p.today(),
        ...(p.notifyTemplate?.() ? { notifyTemplate: p.notifyTemplate() } : {}),
        ...(opts.queuedBy ? { queuedBy: opts.queuedBy } : {}),
    };
    const plan = planOnDoneRun(todo, ctx);
    if (!todo.on_done && !plan.notify) { return undefined; }
    const step = async (what: string, fn: () => unknown): Promise<void> => {
        try { await fn(); } catch (e) { p.log(`on_done of ${quest}/${todo.id}: ${what} failed: ${(e as Error).message}`); }
    };
    for (const u of plan.unblock) {
        await step(`unblock ${u.quest}/${u.id}`, () => p.writeTarget(u.quest, u.id, u.status));
    }
    const here = p.windowQuest();
    const send = async (s: OnDoneSend, what: string): Promise<void> => {
        await step(what, () => (s.quest === here ? p.enqueueLocal(s) : p.postToQuest(s, { quest, run })));
    };
    if (plan.notify) { await send(plan.notify, `notify ${plan.notify.quest}`); }
    if (plan.instructions) { await send(plan.instructions, `instructions to ${plan.instructions.quest}/${plan.instructions.run}`); }
    if (plan.notes.length) { await step('notes', () => p.appendNotes(quest, todo.id, plan.notes)); }
    p.log(`on_done of ${quest}/${todo.id}: ${plan.unblock.length} unblocked, `
        + `${plan.notify ? `notified ${plan.notify.quest}/${plan.notify.run}/${plan.notify.session ?? 'queue default'}` : plan.notifyNotSent ? `no notification (${plan.notifyNotSent})` : 'no notification'}, `
        + `${plan.instructions ? `instructions to ${plan.instructions.quest}/${plan.instructions.run}` : 'no instructions'}`
        + `${plan.skipped.length ? `; targets passed over: ${plan.skipped.join(', ')}` : ''}`
        + `${plan.notes.length ? `; ${plan.notes.length} noted` : ''}`);
    return plan;
}
