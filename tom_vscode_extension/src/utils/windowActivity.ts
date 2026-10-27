/**
 * The queue summary a window writes into its state file (for
 * tomAi_getQuestWindowStatus) — pure, from the queue's items and defaults.
 */

import type { WindowQueueSummary } from './questWindowStatus';

/** A queue item, as far as the summary reads it. */
export interface SummaryItem {
    id: string;
    status: string;
    originalText: string;
    sentAt?: string;
    transport?: string;
    anthropicProfileId?: string;
    session?: string;
    lastDispatched?: { kind: string; transport?: string; anthropicProfileId?: string; dispatchedAt?: string };
}

export interface SummaryQueue {
    items: readonly SummaryItem[];
    autoSend: boolean;
    defaultTransport?: string;
    defaultProfileId?: string;
    defaultSession?: string;
}

const STAGE: Record<string, string> = { prePrompt: 'pre-prompt', main: 'main', followUp: 'follow-up' };

/** The first `max` characters of a prompt on one line. */
export function promptPreviewLine(text: string, max = 80): string {
    const line = text.replace(/\s+/g, ' ').trim();
    return line.length > max ? `${line.slice(0, max - 1)}…` : line;
}

/**
 * The queue summed up: auto-send, paused (an item is sending while auto-send
 * is off), counts per status, the defaults, and the item being sent — its
 * stage, transport, profile and session as the last dispatch ran it, else as
 * the item and the defaults say.
 */
export function summarizeQueue(q: SummaryQueue): WindowQueueSummary {
    const counts: Record<string, number> = {};
    for (const item of q.items) { counts[item.status] = (counts[item.status] ?? 0) + 1; }
    const sending = q.items.find((i) => i.status === 'sending');
    const ld = sending?.lastDispatched;
    const transport = ld?.transport ?? sending?.transport ?? q.defaultTransport;
    const profileId = transport === 'anthropic' ? (ld?.anthropicProfileId ?? sending?.anthropicProfileId ?? q.defaultProfileId) : undefined;
    return {
        autoSend: q.autoSend,
        paused: !!sending && !q.autoSend,
        counts,
        ...(q.defaultTransport ? { defaultTransport: q.defaultTransport } : {}),
        ...(q.defaultProfileId ? { defaultProfileId: q.defaultProfileId } : {}),
        ...(q.defaultSession ? { defaultSession: q.defaultSession } : {}),
        ...(sending ? {
            sending: {
                id: sending.id,
                preview: promptPreviewLine(sending.originalText),
                ...(ld?.kind && STAGE[ld.kind] ? { stage: STAGE[ld.kind] } : {}),
                ...(transport ? { transport } : {}),
                ...(profileId ? { profileId } : {}),
                ...(transport === 'anthropic' ? { session: sending.session ?? q.defaultSession ?? 'default' } : {}),
                ...((ld?.dispatchedAt ?? sending.sentAt) ? { since: ld?.dispatchedAt ?? sending.sentAt } : {}),
            },
        } : {}),
    };
}
