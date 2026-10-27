/**
 * The done-notification of a queue item: a prompt queued when the item is
 * finished, so whoever queued it — another quest's window, through
 * tomAi_sendItemToQuest — is told.
 *
 * - **When.** The item is finished: every pre-prompt, every repetition (or
 *   `<prefix>*` todo), every follow-up and every template iteration done
 *   (outcome `done`), or it ended in an error that will not recover — no API
 *   key, a request the API refused, an exhausted retry schedule (outcome
 *   `error: <message>`). A state the queue waits out (a usage quota until its
 *   next cycle, a rate limit, a scheduled retry, a paused queue) is not such
 *   an error. Once per run of the item: a retry of the error that then
 *   succeeds does not notify twice, a Send Now (a new run) does.
 * - **Where.** Ahead of every other pending item, with the finished item's
 *   transport, profile and session; marked as the notification of its item.
 * - **Pause after.** The item's "pause after this" moves to the
 *   notification, so the queue pauses after the notification.
 * - **Temporary session.** A temporary session is handed over to the
 *   notification, which runs in it; it is deleted once the notification is
 *   done (or right away when there is no notification).
 * - `${itemOutcome}` in the prompt becomes `done` or `error: <message>`.
 *
 * Also the item's fields as its entry file stores them (in `meta`).
 *
 * vscode-free.
 */

import type { InboxSender } from './questInbox';

export const ITEM_OUTCOME_PLACEHOLDER = '${itemOutcome}';

export type ItemOutcome = { kind: 'done' } | { kind: 'error'; message: string };

/** What `${itemOutcome}` reads: `done`, or `error: <message>` (one line). */
export function outcomeText(outcome: ItemOutcome): string {
    if (outcome.kind === 'done') { return 'done'; }
    const message = outcome.message.replace(/\s+/g, ' ').trim();
    return `error: ${message || 'unknown error'}`;
}

/** The item fields this module reads and writes. */
export interface DoneNotificationItem {
    id: string;
    status: string;
    runId?: string;
    pauseAfter?: boolean;
    transport?: 'copilot' | 'anthropic';
    anthropicProfileId?: string;
    anthropicConfigId?: string;
    session?: string;
    doneNotificationPrompt?: string;
    /** The prompt is kept but not queued. */
    doneNotificationDisabled?: boolean;
    /** The run the notification was queued for (no second one for the same run). */
    doneNotificationRun?: string;
    /** On a notification item: the item it reports on. */
    notificationOf?: string;
    /** On an item sent by another quest's window. */
    from?: InboxSender;
    /** The item's session is temporary: deleted once the item (and its notification) is done. */
    temporarySession?: boolean;
}

/** What to queue, and where. */
export interface DoneNotificationPlan {
    text: string;
    /** Insert index in the queue: ahead of every pending item; -1 appends. */
    position: number;
    transport?: 'copilot' | 'anthropic';
    anthropicProfileId?: string;
    anthropicConfigId?: string;
    session?: string;
    /** The item's "pause after this", moved here. */
    pauseAfter: boolean;
    /** The temporary session, handed over to the notification. */
    temporarySession: boolean;
    notificationOf: string;
    /** The run this notification is for; stored on the item. */
    run: string;
}

/** The key of an item's current run (Send Now starts a new one). */
export function runKeyOf(item: Pick<DoneNotificationItem, 'runId'>): string {
    return item.runId || 'run';
}

/**
 * The notification to queue for `item` finishing with `outcome`, or null:
 * no prompt, a blank one, a disabled one, or one already queued for this run.
 * `items` is the queue in order (the item itself included).
 */
export function planDoneNotification(
    item: DoneNotificationItem,
    outcome: ItemOutcome,
    items: ReadonlyArray<Pick<DoneNotificationItem, 'id' | 'status'>>,
): DoneNotificationPlan | null {
    const prompt = item.doneNotificationPrompt;
    if (!prompt || !prompt.trim() || item.doneNotificationDisabled) { return null; }
    const run = runKeyOf(item);
    if (item.doneNotificationRun === run) { return null; }
    const position = items.findIndex((i) => i.id !== item.id && i.status === 'pending');
    return {
        text: prompt.split(ITEM_OUTCOME_PLACEHOLDER).join(outcomeText(outcome)),
        position,
        ...(item.transport ? { transport: item.transport } : {}),
        ...(item.anthropicProfileId ? { anthropicProfileId: item.anthropicProfileId } : {}),
        ...(item.anthropicConfigId ? { anthropicConfigId: item.anthropicConfigId } : {}),
        ...(item.session ? { session: item.session } : {}),
        pauseAfter: !!item.pauseAfter,
        temporarySession: !!item.temporarySession,
        notificationOf: item.id,
        run,
    };
}

/**
 * Record on the finished item that `plan` was queued: the run, and the pause
 * and the temporary session it handed over.
 */
export function applyPlanToItem(item: DoneNotificationItem, plan: DoneNotificationPlan): void {
    item.doneNotificationRun = plan.run;
    if (plan.pauseAfter) { item.pauseAfter = false; }
    if (plan.temporarySession) { item.temporarySession = false; }
}

/** Whether a finished item's temporary session is to be deleted now (none, or not handed to a notification). */
export function deletesTemporarySession(item: DoneNotificationItem, plan: DoneNotificationPlan | null): boolean {
    return !!item.temporarySession && !!item.session && !plan?.temporarySession;
}

// ---------------------------------------------------------------------------
// Entry file (meta)
// ---------------------------------------------------------------------------

/** The meta keys of these fields; unset ones left out, so an untouched entry round-trips unchanged. */
export function doneNotificationMetaToYaml(item: DoneNotificationMetaFields): Record<string, unknown> {
    const out: Record<string, unknown> = {};
    if (item.doneNotificationPrompt !== undefined || item.doneNotificationDisabled) {
        out['done-notification'] = {
            prompt: item.doneNotificationPrompt ?? '',
            ...(item.doneNotificationDisabled ? { disabled: true } : {}),
            ...(item.doneNotificationRun ? { 'queued-for-run': item.doneNotificationRun } : {}),
        };
    }
    if (item.notificationOf) { out['notification-of'] = item.notificationOf; }
    if (item.from) {
        out.from = { quest: item.from.quest, 'window-id': item.from.windowId, host: item.from.host, 'sent-at': item.from.sentAt };
    }
    if (item.temporarySession) { out['temporary-session'] = true; }
    return out;
}

/** The fields an entry's meta stores for this module. */
export type DoneNotificationMetaFields = Pick<DoneNotificationItem,
    'doneNotificationPrompt' | 'doneNotificationDisabled' | 'doneNotificationRun' | 'notificationOf' | 'from' | 'temporarySession'>;

/** The fields read back from an entry's meta. */
export function doneNotificationMetaFromYaml(meta: Record<string, unknown>): DoneNotificationMetaFields {
    const out: DoneNotificationMetaFields = {};
    const dn = meta['done-notification'];
    if (dn && typeof dn === 'object') {
        const d = dn as Record<string, unknown>;
        if (typeof d.prompt === 'string') { out.doneNotificationPrompt = d.prompt; }
        if (d.disabled === true) { out.doneNotificationDisabled = true; }
        if (typeof d['queued-for-run'] === 'string') { out.doneNotificationRun = d['queued-for-run']; }
    }
    if (typeof meta['notification-of'] === 'string') { out.notificationOf = meta['notification-of']; }
    const f = meta.from;
    if (f && typeof f === 'object' && typeof (f as Record<string, unknown>).quest === 'string') {
        const r = f as Record<string, unknown>;
        out.from = {
            quest: String(r.quest),
            windowId: typeof r['window-id'] === 'string' ? r['window-id'] : '',
            host: typeof r.host === 'string' ? r.host : '',
            sentAt: typeof r['sent-at'] === 'string' ? r['sent-at'] : '',
        };
    }
    if (meta['temporary-session'] === true) { out.temporarySession = true; }
    return out;
}
