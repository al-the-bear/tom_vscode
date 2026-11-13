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
 * - **Where.** By default in the item's own queue and process run, ahead of
 *   every other pending item, with the finished item's transport, profile
 *   and session; marked as the notification of its item. The item can name
 *   another place (vscimpb71): `doneNotificationRun`, a run of its own quest
 *   (the notification goes into that run's lane, its session becoming
 *   `<session>@<run>`), and `doneNotificationQuest`, another quest — posted
 *   into that quest's inbox (src/utils/questInbox.ts) and queued there with
 *   that queue's defaults in `doneNotificationRun` (default `default`); with
 *   no window of that quest running it waits in the inbox, and the item
 *   records where it was posted (`doneNotificationPosted`).
 * - **Pause after.** The item's "pause after this" moves to the
 *   notification, so the queue pauses after the notification (not when the
 *   notification goes to another quest: the pause stays with the item).
 * - **Temporary session.** A temporary session is handed over to the
 *   notification, which runs in it; it is deleted once the notification is
 *   done (or right away when there is no notification, or it goes to another
 *   quest).
 * - `${itemOutcome}` in the prompt becomes `done` or `error: <message>`;
 *   `${senderQuest}` and `${senderRun}` the quest and run the notification
 *   comes from (the finished item's).
 *
 * Also the item's fields as its entry file stores them (in `meta`).
 *
 * vscode-free.
 */

import type { InboxSender } from './questInbox';

export const ITEM_OUTCOME_PLACEHOLDER = '${itemOutcome}';
/** The quest a notification comes from (the finished item's). */
export const SENDER_QUEST_PLACEHOLDER = '${senderQuest}';
/** The process run a notification comes from (the finished item's). */
export const SENDER_RUN_PLACEHOLDER = '${senderRun}';
const DEFAULT_RUN_NAME = 'default';

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
    /** The item's process run (`default` when unset). */
    run?: string;
    pauseAfter?: boolean;
    transport?: 'copilot' | 'anthropic';
    anthropicProfileId?: string;
    anthropicConfigId?: string;
    session?: string;
    doneNotificationPrompt?: string;
    /** The prompt is kept but not queued. */
    doneNotificationDisabled?: boolean;
    /** The send-run the notification was queued for (no second one for the same send-run). */
    doneNotificationQueuedFor?: string;
    /** The quest the notification is posted to; unset: the item's own. */
    doneNotificationQuest?: string;
    /** The process run it is queued in; unset: the item's run in its own quest, `default` in another. */
    doneNotificationRun?: string;
    /** Where a notification for another quest was posted, and whether it waits for a window there. */
    doneNotificationPosted?: DoneNotificationPosted;
    /** On a notification item: the item it reports on. */
    notificationOf?: string;
    /** On an item sent by another quest's window. */
    from?: InboxSender;
    /** The item's session is temporary: deleted once the item (and its notification) is done. */
    temporarySession?: boolean;
}

/** A notification posted into another quest's inbox. */
export interface DoneNotificationPosted {
    quest: string;
    run: string;
    /** The inbox file's name. */
    file: string;
    /** No window of the quest was running: it waits in the inbox until one starts. */
    waiting: boolean;
    at: string;
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
    /** The send-run this notification is for; stored on the item. */
    run: string;
    /** The process run the notification is queued in. */
    targetRun: string;
    /** Set when the notification goes to another quest (through its inbox). */
    targetQuest?: string;
    /** The target run was named on the item (a running Proceed's run is then not inherited). */
    explicitRun: boolean;
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
    ownQuest = '',
): DoneNotificationPlan | null {
    const prompt = item.doneNotificationPrompt;
    if (!prompt || !prompt.trim() || item.doneNotificationDisabled) { return null; }
    const run = runKeyOf(item);
    if (item.doneNotificationQueuedFor === run) { return null; }
    const itemRun = item.run || DEFAULT_RUN_NAME;
    const text = prompt.split(ITEM_OUTCOME_PLACEHOLDER).join(outcomeText(outcome))
        .split(SENDER_QUEST_PLACEHOLDER).join(ownQuest || DEFAULT_RUN_NAME)
        .split(SENDER_RUN_PLACEHOLDER).join(itemRun);
    const quest = item.doneNotificationQuest?.trim();
    if (quest && quest !== ownQuest) {
        // Another quest: its inbox, its queue's defaults; the pause and a temporary session stay here.
        return {
            text, position: -1, pauseAfter: false, temporarySession: false, notificationOf: item.id, run,
            targetQuest: quest, targetRun: item.doneNotificationRun || DEFAULT_RUN_NAME, explicitRun: true,
        };
    }
    const targetRun = item.doneNotificationRun || itemRun;
    const otherRun = targetRun !== itemRun;
    const position = items.findIndex((i) => i.id !== item.id && i.status === 'pending');
    return {
        text,
        position,
        ...(item.transport ? { transport: item.transport } : {}),
        ...(item.anthropicProfileId ? { anthropicProfileId: item.anthropicProfileId } : {}),
        ...(item.anthropicConfigId ? { anthropicConfigId: item.anthropicConfigId } : {}),
        // In another run the session is that run's own: its base name, which the queue makes `<session>@<run>`.
        ...(item.session ? { session: otherRun ? sessionBase(item.session) : item.session } : {}),
        pauseAfter: !!item.pauseAfter,
        temporarySession: !!item.temporarySession,
        notificationOf: item.id,
        run,
        targetRun,
        explicitRun: !!item.doneNotificationRun,
    };
}

/** A session's name without its `@<run>` (src/utils/runSessions.ts sessionBaseName, kept here vscode-free). */
function sessionBase(name: string): string {
    const at = name.indexOf('@');
    return at > 0 ? name.slice(0, at) : name;
}

/**
 * Record on the finished item that `plan` was queued: the run, and the pause
 * and the temporary session it handed over.
 */
export function applyPlanToItem(item: DoneNotificationItem, plan: DoneNotificationPlan): void {
    item.doneNotificationQueuedFor = plan.run;
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
    if (item.doneNotificationPrompt !== undefined || item.doneNotificationDisabled || item.doneNotificationQuest
        || item.doneNotificationRun || item.doneNotificationPosted) {
        out['done-notification'] = {
            prompt: item.doneNotificationPrompt ?? '',
            ...(item.doneNotificationDisabled ? { disabled: true } : {}),
            ...(item.doneNotificationQueuedFor ? { 'queued-for-run': item.doneNotificationQueuedFor } : {}),
            ...(item.doneNotificationQuest ? { quest: item.doneNotificationQuest } : {}),
            ...(item.doneNotificationRun ? { run: item.doneNotificationRun } : {}),
            ...(item.doneNotificationPosted ? {
                posted: {
                    quest: item.doneNotificationPosted.quest,
                    run: item.doneNotificationPosted.run,
                    file: item.doneNotificationPosted.file,
                    ...(item.doneNotificationPosted.waiting ? { waiting: true } : {}),
                    at: item.doneNotificationPosted.at,
                },
            } : {}),
        };
    }
    if (item.notificationOf) { out['notification-of'] = item.notificationOf; }
    if (item.from) {
        out.from = {
            quest: item.from.quest, ...(item.from.run ? { run: item.from.run } : {}),
            'window-id': item.from.windowId, host: item.from.host, 'sent-at': item.from.sentAt,
        };
    }
    if (item.temporarySession) { out['temporary-session'] = true; }
    return out;
}

/** The fields an entry's meta stores for this module. */
export type DoneNotificationMetaFields = Pick<DoneNotificationItem,
    'doneNotificationPrompt' | 'doneNotificationDisabled' | 'doneNotificationQueuedFor' | 'doneNotificationQuest'
    | 'doneNotificationRun' | 'doneNotificationPosted' | 'notificationOf' | 'from' | 'temporarySession'>;

/** The fields read back from an entry's meta. */
export function doneNotificationMetaFromYaml(meta: Record<string, unknown>): DoneNotificationMetaFields {
    const out: DoneNotificationMetaFields = {};
    const dn = meta['done-notification'];
    if (dn && typeof dn === 'object') {
        const d = dn as Record<string, unknown>;
        if (typeof d.prompt === 'string') { out.doneNotificationPrompt = d.prompt; }
        if (d.disabled === true) { out.doneNotificationDisabled = true; }
        if (typeof d['queued-for-run'] === 'string') { out.doneNotificationQueuedFor = d['queued-for-run']; }
        if (typeof d.quest === 'string' && d.quest) { out.doneNotificationQuest = d.quest; }
        if (typeof d.run === 'string' && d.run) { out.doneNotificationRun = d.run; }
        const p = d.posted;
        if (p && typeof p === 'object' && typeof (p as Record<string, unknown>).quest === 'string') {
            const q = p as Record<string, unknown>;
            out.doneNotificationPosted = {
                quest: String(q.quest),
                run: typeof q.run === 'string' ? q.run : DEFAULT_RUN_NAME,
                file: typeof q.file === 'string' ? q.file : '',
                waiting: q.waiting === true,
                at: typeof q.at === 'string' ? q.at : '',
            };
        }
    }
    if (typeof meta['notification-of'] === 'string') { out.notificationOf = meta['notification-of']; }
    const f = meta.from;
    if (f && typeof f === 'object' && typeof (f as Record<string, unknown>).quest === 'string') {
        const r = f as Record<string, unknown>;
        out.from = {
            quest: String(r.quest),
            ...(typeof r.run === 'string' && r.run ? { run: r.run } : {}),
            windowId: typeof r['window-id'] === 'string' ? r['window-id'] : '',
            host: typeof r.host === 'string' ? r.host : '',
            sentAt: typeof r['sent-at'] === 'string' ? r['sent-at'] : '',
        };
    }
    if (meta['temporary-session'] === true) { out.temporarySession = true; }
    return out;
}
