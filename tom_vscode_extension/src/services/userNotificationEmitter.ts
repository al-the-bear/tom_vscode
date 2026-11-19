/**
 * The user-directed events of the machine's notification log (vscimpb170),
 * written by this window: USER NOTIFICATIONS and NOTIFICATIONS show them.
 *
 * - **Asks** — a question (tomAi_askUser), a picker, an MD Browser ask, a plan
 *   proposal, a tool approval — come from the window's interaction registry
 *   (services/userInteractions.ts): `askOpened` when one opens, `askClosed`
 *   with how it was settled when it closes, paired by the interaction's id.
 * - **A process decision** waiting for the user: `decisionWaiting` when a run
 *   of the quest arrives at a decision (the process store's change).
 * - **The queue holding for the user**: `queueHolding` when an item of this
 *   window's queue becomes `decision-needed`, `error` or needs attention, and
 *   when a run is paused because of one (promptQueueManager calls
 *   {@link emitRunPaused}).
 * - **Messages, suggestions, todos** are emitted where they happen, with the
 *   drafts here: tomAi_notifyUser ({@link userNotifiedDraft}),
 *   tomAi_suggestSubprocess ({@link subprocessSuggestedDraft}), a todo filed
 *   or turned into one for the user ({@link userTodoDraft}).
 *
 * The drafts are pure; the wiring takes its sources as arguments, so the
 * module is vscode-free.
 */

import { emitNotifications, type NotificationDraft } from './notificationLog';
import { previewValue } from '../utils/notificationEvents';
import type { ClosedInteraction, OpenInteraction, UserInteractions } from './userInteractions';

/** Lines naming what an interaction asks: the questions with their choices, the items, the document, the plan, the tool. */
export function interactionDetails(i: Pick<OpenInteraction, 'kind' | 'data'>): string[] {
    const d = i.data ?? {};
    const lines: string[] = [];
    const str = (v: unknown): string | undefined => (typeof v === 'string' && v.trim() ? v : undefined);
    switch (i.kind) {
        case 'question': {
            const questions = Array.isArray(d.questions) ? d.questions.map(String) : [];
            questions.forEach((q, n) => { lines.push(`${n + 1}. ${q}`); });
            const choices = Array.isArray(d.choices) ? d.choices as Array<{ label?: unknown; question?: unknown }> : [];
            if (choices.length) { lines.push(`Choices: ${choices.map((c) => String(c.label ?? '')).filter(Boolean).join(' · ')}`); }
            break;
        }
        case 'picker': {
            if (str(d.prompt)) { lines.push(String(d.prompt)); }
            const items = Array.isArray(d.items) ? d.items as Array<{ label?: unknown }> : [];
            lines.push(...items.slice(0, 20).map((it) => `• ${String(it.label ?? '')}`));
            if (items.length > 20) { lines.push(`… and ${items.length - 20} more`); }
            if (d.canPickMany === true) { lines.push('(several may be picked)'); }
            break;
        }
        case 'mdBrowser':
            if (str(d.file)) { lines.push(`Document: ${String(d.file)}`); }
            break;
        case 'plan': {
            const plan = str(d.plan) ?? '';
            lines.push(...plan.split('\n').slice(0, 30));
            break;
        }
        case 'approval':
            if (str(d.toolName)) { lines.push(`Tool: ${String(d.toolName)}`); }
            if (str(d.inputSummary)) { lines.push(`Input: ${previewValue(d.inputSummary, 300) ?? ''}`); }
            break;
    }
    return lines;
}

/** The `askOpened` event of an interaction. */
export function askOpenedDraft(i: OpenInteraction): NotificationDraft {
    return {
        type: 'askOpened',
        run: i.run,
        user: {
            kind: i.kind,
            key: i.id,
            title: i.title,
            details: interactionDetails(i),
            ...(i.session ? { session: i.session } : {}),
            ...(i.queueItemId ? { queueItemId: i.queueItemId } : {}),
        },
    };
}

/** The `askClosed` event of a settled interaction. */
export function askClosedDraft(c: ClosedInteraction): NotificationDraft {
    const i = c.interaction;
    return {
        type: 'askClosed',
        run: i.run,
        user: {
            kind: i.kind,
            key: i.id,
            title: i.title,
            outcome: c.outcome ?? 'closed',
            ...(i.queueItemId ? { queueItemId: i.queueItemId } : {}),
        },
    };
}

/** tomAi_notifyUser: its message, urgency and channel. */
export function userNotifiedDraft(input: { message: string; title?: string; urgency?: string; channel?: string }): NotificationDraft {
    return {
        type: 'userNotified',
        user: {
            title: input.title ? `${input.title}: ${previewValue(input.message, 100)}` : (previewValue(input.message, 120) ?? ''),
            details: input.message.split('\n'),
            urgency: input.urgency ?? 'info',
            channel: input.channel ?? 'auto',
        },
    };
}

/** tomAi_suggestSubprocess: the processes suggested, with their reasons; the branching editor waits for the user. */
export function subprocessSuggestedDraft(suggestions: ReadonlyArray<{ process: string; reason?: string; kind?: string }>): NotificationDraft {
    return {
        type: 'subprocessSuggested',
        user: {
            title: `${suggestions.length === 1 ? 'A process is' : `${suggestions.length} processes are`} suggested: ${suggestions.map((s) => s.process).join(', ')}`,
            details: suggestions.map((s) => `• ${s.process}${s.kind ? ` (${s.kind})` : ''}${s.reason ? ` — ${s.reason}` : ''}`),
        },
    };
}

/** Why a todo is the user's: `decision-needed`, a user action, or neither. */
export function userTodoReason(todo: { status?: unknown; user_action?: unknown }): 'decision-needed' | 'user action' | undefined {
    if (todo.status === 'decision-needed') { return 'decision-needed'; }
    if (todo.user_action === true) { return 'user action'; }
    return undefined;
}

/**
 * The `userTodo` event of a todo of `quest` that is the user's: filed so
 * (`before` absent), or turned so by an update (it was not before).
 * Undefined when it is not the user's, or already was.
 */
export function userTodoDraft(
    quest: string,
    todo: { id: string; title?: string; description?: string; status?: unknown; user_action?: unknown; decisions?: unknown },
    before?: { status?: unknown; user_action?: unknown },
): NotificationDraft | undefined {
    const reason = userTodoReason(todo);
    if (!reason || (before && userTodoReason(before) === reason)) { return undefined; }
    const open = Array.isArray(todo.decisions)
        ? (todo.decisions as Array<{ summary?: unknown; decision?: unknown }>).filter((d) => !d.decision).map((d) => `• ${String(d.summary ?? '')}`)
        : [];
    return {
        type: 'userTodo',
        todo: { id: todo.id, quest, ...(previewValue(todo.title ?? todo.description, 70) ? { title: previewValue(todo.title ?? todo.description, 70) } : {}), fields: [] },
        user: {
            kind: reason,
            title: `${reason === 'decision-needed' ? 'Decision needed in' : 'Your action in'} todo ${todo.id}${todo.title ? `: ${previewValue(todo.title, 80)}` : ''}`,
            details: [...(open.length ? ['Open decisions:', ...open] : [])],
        },
    };
}

/** An item of the queue, as far as its holding state reads it. */
export interface HoldingItem {
    id: string;
    status: string;
    run: string;
    needsAttention?: string;
    error?: string;
    preview: string;
}

/** What an item holds the queue for, or undefined. */
export function holdingState(i: HoldingItem): string | undefined {
    if (i.status === 'decision-needed') { return 'decision-needed'; }
    if (i.status === 'error') { return 'error'; }
    if (i.needsAttention) { return 'needs attention'; }
    return undefined;
}

/** The `queueHolding` event of an item that began to hold the queue. */
export function queueHoldingDraft(i: HoldingItem, state: string): NotificationDraft {
    return {
        type: 'queueHolding',
        run: i.run,
        user: {
            kind: state,
            title: `Queue item ${state}: "${i.preview}"`,
            details: [
                ...(state === 'error' && i.error ? [`Error: ${i.error}`] : []),
                ...(state === 'needs attention' && i.needsAttention ? [i.needsAttention] : []),
                ...(state === 'decision-needed' ? ['The item waits for the decisions of its todo.'] : []),
            ],
            queueItemId: i.id,
        },
        who: { kind: 'extension', label: 'the queue' },
    };
}

/** A run was paused because of an item (an error, needs attention): the queue holds for the user. */
export function emitRunPaused(run: string, why: string, itemId?: string): void {
    emitNotifications([{
        type: 'queueHolding',
        run,
        user: { kind: 'paused', title: `Run ${run} paused: ${why}`, details: [`Resume the run's queue when the cause is dealt with.`], ...(itemId ? { queueItemId: itemId } : {}) },
        who: { kind: 'extension', label: 'the queue' },
    }]);
}

/** The sources the wiring watches. */
export interface UserNotificationSources {
    interactions: Pick<UserInteractions, 'onChange'>;
    /** The process: its change, and the runs waiting at a decision. */
    process?: { onDidChange(listener: () => void): { dispose(): void }; decisionWaitingRuns(): Array<{ run: string; process: string; position: string }> };
    /** The queue: its change, and its items' holding state. */
    queue?: { onDidChange(listener: () => void): { dispose(): void }; holdingItems(): HoldingItem[] };
    emit?: (drafts: NotificationDraft[]) => void;
}

/**
 * Write the user-directed events of this window's asks, process decisions and
 * queue holds as they happen. What waits already when it starts is taken as
 * known (no event): only changes are written. Answers the stop function.
 */
export function startUserNotificationEmitter(src: UserNotificationSources): () => void {
    const emit = src.emit ?? ((d: NotificationDraft[]) => emitNotifications(d));
    const stops: Array<() => void> = [];
    stops.push(src.interactions.onChange((added, closed) => {
        if (added) { emit([askOpenedDraft(added)]); }
        if (closed) { emit([askClosedDraft(closed)]); }
    }));
    if (src.process) {
        const process = src.process;
        const key = (r: { run: string; process: string; position: string }) => `${r.run}|${r.process}|${r.position}`;
        let known = new Set(safe(() => process.decisionWaitingRuns(), []).map(key));
        const sub = process.onDidChange(() => {
            const now = safe(() => process.decisionWaitingRuns(), []);
            const fresh = now.filter((r) => !known.has(key(r)));
            known = new Set(now.map(key));
            if (fresh.length) {
                emit(fresh.map((r) => ({
                    type: 'decisionWaiting',
                    run: r.run,
                    user: { kind: 'process', title: `Decide how ${r.process} goes on: ${r.position}`, details: ['The PROCESS view offers Decide… for this run.'] },
                    who: { kind: 'extension', label: 'the process' },
                }) as NotificationDraft));
            }
        });
        stops.push(() => sub.dispose());
    }
    if (src.queue) {
        const queue = src.queue;
        const stateOf = (items: HoldingItem[]) => new Map(items.map((i) => [i.id, holdingState(i)]));
        let known = stateOf(safe(() => queue.holdingItems(), []));
        const sub = queue.onDidChange(() => {
            const items = safe(() => queue.holdingItems(), []);
            const drafts: NotificationDraft[] = [];
            for (const i of items) {
                const state = holdingState(i);
                if (state && known.get(i.id) !== state) { drafts.push(queueHoldingDraft(i, state)); }
            }
            known = stateOf(items);
            if (drafts.length) { emit(drafts); }
        });
        stops.push(() => sub.dispose());
    }
    return () => { for (const s of stops) { try { s(); } catch { /* already gone */ } } };
}

function safe<T>(fn: () => T, fallback: T): T {
    try { return fn(); } catch { return fallback; }
}
