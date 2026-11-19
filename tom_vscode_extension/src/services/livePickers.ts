/**
 * The pickers VS Code shows as a QuickPick right now (tomAi_askUserPicker, the
 * prompter's showQuickPick), by the queue item whose turn waits in them
 * (vscimpb173).
 *
 * A picker on screen is not one of the user-input panel's interactions
 * (services/userInteractions.ts lists only the pickers that could not be a
 * QuickPick). The queue item's ask panel shows it all the same — its items, to
 * pick there — and answers it through `answer`, which settles the QuickPick as
 * if the user had picked in it.
 *
 * vscode-free.
 */

/** What the item's ask panel answers a picker with (the user-input panel's picker message). */
export interface PickerResponse {
    dismissed?: boolean;
    /** Indexes into the picker's items. */
    selected?: number[];
    /** The user's own text, as an item. */
    other?: string;
}

/** A QuickPick on screen. */
export interface LivePicker {
    id: string;
    queueItemId?: string;
    run: string;
    createdAt: number;
    title?: string;
    prompt?: string;
    items: Array<{ label: string; description?: string }>;
    canPickMany: boolean;
    answer(response: PickerResponse): void;
}

const live = new Map<string, LivePicker>();
const listeners = new Set<() => void>();

function changed(): void {
    for (const l of [...listeners]) { try { l(); } catch { /* a listener must not break the picker */ } }
}

/** Register a QuickPick while it shows; answers how to remove it (idempotent). */
export function registerLivePicker(picker: LivePicker): () => void {
    live.set(picker.id, picker);
    changed();
    return () => { if (live.delete(picker.id)) { changed(); } };
}

/** The QuickPicks the turn of queue item `queueItemId` waits in. */
export function livePickersOf(queueItemId: string): LivePicker[] {
    return [...live.values()].filter((p) => p.queueItemId === queueItemId).sort((a, b) => a.createdAt - b.createdAt);
}

/** QuickPick `id`, while it shows. */
export function livePicker(id: string): LivePicker | undefined {
    return live.get(id);
}

/** Be told when a QuickPick opens or closes; answers the unsubscribe. */
export function onLivePickersChange(listener: () => void): () => void {
    listeners.add(listener);
    return () => { listeners.delete(listener); };
}

/**
 * What a picker response picks of `items`: the selected ones in order, then the user's own text as an item;
 * one item unless `canPickMany`. Undefined: dismissed.
 */
export function pickedOf<T extends { label: string; value?: string }>(items: readonly T[], response: PickerResponse, canPickMany: boolean): T | T[] | undefined {
    if (response.dismissed === true) { return undefined; }
    const picked: T[] = (Array.isArray(response.selected) ? response.selected : []).map(Number).filter((n) => items[n] !== undefined).map((n) => items[n]);
    const other = typeof response.other === 'string' ? response.other.trim() : '';
    if (other) { picked.push({ label: other, value: other } as T); }
    return canPickMany ? picked : picked[0];
}
