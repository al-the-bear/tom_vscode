/**
 * Who queued a queue item (vscimpb146): the quest, run and session of the
 * agent turn that queued it (tomAi_addQueueItem, tomAi_sendItemToQuest), or
 * the run and session the user chose in a panel (the todo panel). A todo's
 * done notification — its `notify_prompt`, or the configured template when
 * `withTemplate` (the todo panel's Done notification box was on) — is
 * delivered there, into that run and session; the item's own queue and run
 * are never the fallback. Persisted on the item as `queued-by`.
 *
 * vscode-free and pure.
 */

export interface QueuedBy {
    quest: string;
    run: string;
    /** The session (as the item's `session` names it); unset: the run's queue default. */
    session?: string;
    /** The queuing panel asked for done notifications: a todo without a notify prompt gets the configured template. */
    withTemplate?: true;
}

/** A stored or sent `queued-by` read back, or undefined when it is not one. */
export function queuedByFrom(raw: unknown): QueuedBy | undefined {
    if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) { return undefined; }
    const r = raw as Record<string, unknown>;
    if (typeof r.quest !== 'string' || !r.quest.trim()) { return undefined; }
    const run = typeof r.run === 'string' && r.run.trim() ? r.run.trim() : 'default';
    const session = typeof r.session === 'string' && r.session.trim() ? r.session.trim() : undefined;
    return { quest: r.quest.trim(), run, ...(session ? { session } : {}), ...(r.withTemplate === true ? { withTemplate: true as const } : {}) };
}

/** The `queued-by` mapping as the queue file and the inbox keep it. */
export function queuedByToYaml(q: QueuedBy): { quest: string; run: string; session?: string; withTemplate?: true } {
    return { quest: q.quest, run: q.run, ...(q.session ? { session: q.session } : {}), ...(q.withTemplate ? { withTemplate: true as const } : {}) };
}

/** The queued-by of a turn running as a queue item (or a chat send's item): its quest, run and session. */
export function queuedByOfItem(item: { run?: string; session?: string; processRun?: { run?: string } } | undefined, quest: string): QueuedBy | undefined {
    if (!item || !quest || quest === 'default') { return undefined; }
    const run = item.processRun?.run || item.run || 'default';
    return { quest, run, ...(item.session ? { session: item.session } : {}) };
}

/** The queued-by of a tool call, from its `filed_by` context (quest, run, session); undefined without a quest. */
export function queuedByFromFiledBy(f: { quest?: string; run?: string; session?: string } | undefined): QueuedBy | undefined {
    if (!f?.quest || f.quest === 'default') { return undefined; }
    return { quest: f.quest, run: f.run || 'default', ...(f.session ? { session: f.session } : {}) };
}

/** `quest / run / session` for logs and the queue editor. */
export function queuedByLine(q: QueuedBy | undefined): string {
    return q ? `${q.quest} / ${q.run} / ${q.session ?? 'queue default'}` : '(unknown)';
}
