/**
 * What a queue item's turn asks the user, for the item's own ask panel in the
 * queue editor (vscimpb173): the open interactions of the item
 * (services/userInteractions.ts — tomAi_askUser questions, pickers shown in the
 * user-input panel, tomAi_askInMdBrowser asks, tool approvals, plan proposals)
 * and the QuickPicks on screen for it (services/livePickers.ts).
 *
 * The panel answers through {@link answerItemAsk} with the very messages the
 * user-input panel posts — a question's `submit` / `answers` / `choice`, a
 * picker's `picker` — and an MD Browser ask's button as `mdButton`, so an
 * answer given in the item is composed and settled exactly as one given there,
 * and the ask closes everywhere.
 *
 * vscode-free.
 */

import { userInteractions, type InteractionKind, type UserInteractions } from './userInteractions';
import { livePicker, livePickersOf, type LivePicker, type PickerResponse } from './livePickers';

/** One ask of an item, as the editor's panel gets it. */
export interface ItemAskView {
    /** The interaction's id (a question's request id), or the QuickPick's. */
    id: string;
    kind: InteractionKind;
    title: string;
    /** Epoch ms it opened. */
    createdAt: number;
    /** What it asks: the interaction's data (questions, choices, layout; items; file, buttons). */
    data: Record<string, unknown>;
    /** A QuickPick on screen (answered through services/livePickers.ts). */
    live?: true;
}

function pickerView(p: LivePicker): ItemAskView {
    return {
        id: p.id,
        kind: 'picker',
        title: p.title ?? p.prompt ?? 'Pick',
        createdAt: p.createdAt,
        data: { ...(p.title ? { title: p.title } : {}), ...(p.prompt ? { prompt: p.prompt } : {}), items: p.items, canPickMany: p.canPickMany },
        live: true,
    };
}

/** The asks the turn of queue item `queueItemId` waits in, oldest first. */
export function itemAskViews(queueItemId: string, interactions: Pick<UserInteractions, 'forQueueItem'> = userInteractions, pickers: (id: string) => LivePicker[] = livePickersOf): ItemAskView[] {
    const open: ItemAskView[] = interactions.forQueueItem(queueItemId).map((i) => ({ id: i.id, kind: i.kind, title: i.title, createdAt: i.createdAt, data: i.data }));
    return [...open, ...pickers(queueItemId).map(pickerView)].sort((a, b) => a.createdAt - b.createdAt);
}

/** What answering an item's ask did. */
export type ItemAskAnswer = { ok: true; kind: InteractionKind } | { ok: false; reason: string };

/**
 * Answer ask `askId` of queue item `queueItemId` with `response` (the
 * user-input panel's message for its kind; `{type: 'mdButton', buttonId,
 * keepFile?}` for an MD Browser ask's button). An ask of another item, or one
 * that closed meanwhile, is refused.
 */
export function answerItemAsk(
    queueItemId: string,
    askId: string,
    response: Record<string, unknown>,
    interactions: Pick<UserInteractions, 'get'> = userInteractions,
    picker: (id: string) => LivePicker | undefined = livePicker,
): ItemAskAnswer {
    const shown = picker(askId);
    if (shown) {
        if (shown.queueItemId !== queueItemId) { return { ok: false, reason: 'That picker belongs to another item.' }; }
        shown.answer(response as PickerResponse);
        return { ok: true, kind: 'picker' };
    }
    const interaction = interactions.get(askId);
    if (!interaction || interaction.queueItemId !== queueItemId) { return { ok: false, reason: 'That question was already closed; your answer was not sent.' }; }
    if (!interaction.respond) { return { ok: false, reason: 'This ask cannot be answered from the item.' }; }
    interaction.respond(response);
    return { ok: true, kind: interaction.kind };
}
