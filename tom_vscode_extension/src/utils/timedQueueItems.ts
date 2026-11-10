/**
 * Queue items a timed request queued (TimerEngine): how they are told apart
 * from the others, and how an entry file names their kind.
 *
 * A timed item carries `type: 'timed'` and the id of its timed request in
 * `timedEntryId`; its `template` is the template the entry chose, applied
 * like any item's. Entry files of earlier builds marked a timed item by its
 * template, `timed:<entry id>` — which no prompt template matches, so the
 * entry's own template was never applied. Such a file reads as a timed item
 * of that entry with no template.
 */

/** The template an earlier build wrote to mark a timed item. */
const LEGACY_TIMED_TEMPLATE = /^timed:(.+)$/;

/** The kind of a queue item. */
export type QueueItemKind = 'normal' | 'timed' | 'reminder';

/** What an entry file says about an item's kind and template. */
export interface QueueItemKindRead {
    type: QueueItemKind;
    template: string;
    timedEntryId?: string;
}

/**
 * The item's kind, template and timed request from its entry file: `meta.type`
 * and `meta['timed-entry-id']`, the main prompt's template; a legacy
 * `timed:<id>` template is a timed item of `<id>` with no template (`(None)`).
 */
export function queueItemKindFromYaml(meta: Record<string, unknown>, template: unknown): QueueItemKindRead {
    const written = typeof template === 'string' && template ? template : '(None)';
    const legacy = LEGACY_TIMED_TEMPLATE.exec(written);
    if (legacy) {
        return { type: 'timed', template: '(None)', timedEntryId: legacy[1] };
    }
    const type: QueueItemKind = meta.type === 'timed' || meta.type === 'reminder' ? meta.type : 'normal';
    const entryId = typeof meta['timed-entry-id'] === 'string' && meta['timed-entry-id'] ? meta['timed-entry-id'] : undefined;
    return { type, template: written, ...(type === 'timed' && entryId ? { timedEntryId: entryId } : {}) };
}

/** Whether `item` is one the timed request `entryId` queued. */
export function isTimedItemOf(item: { type?: string; timedEntryId?: string }, entryId: string): boolean {
    return item.type === 'timed' && item.timedEntryId === entryId;
}
