/**
 * The stored order of the editors' file-based lists (utils/listOrder.ts): the
 * configuration's `editorListOrder`, one list of ids per list key. Read and
 * written through the shared configuration file, so every window and host
 * shows a list in the same order.
 *
 * List keys: `queueTemplates`, `reusablePrompts:quest:<quest>`
 * (utils/questPrompts.ts), `groupPrompts:global:<kind>` /
 * `groupPrompts:quest:<quest>:<kind>`, `roles`, `roleTypes`, `processes`.
 */

import { loadSendToChatConfig, saveSendToChatConfig } from '../utils/sendToChatConfig';
import { applyListOrder, movedListOrder, type MoveDirection } from '../utils/listOrder';

/** The stored order of list `key`, if any. */
export function storedListOrder(key: string): string[] | undefined {
    const order = loadSendToChatConfig()?.editorListOrder?.[key];
    return Array.isArray(order) ? order.filter((id): id is string => typeof id === 'string') : undefined;
}

/** `items` of list `key` in their stored order. */
export function inStoredOrder<T>(key: string, items: readonly T[], idOf: (item: T) => string): T[] {
    return applyListOrder(items, storedListOrder(key), idOf);
}

/**
 * Move entry `id` of list `key` one place (`shownIds`: the list as shown, in
 * its stored order) and store the new order. Answers whether it moved.
 */
export function moveInStoredOrder(key: string, shownIds: readonly string[], id: string, direction: MoveDirection): boolean {
    const next = movedListOrder(shownIds, id, direction);
    if (!next) { return false; }
    const config = loadSendToChatConfig();
    if (!config) { return false; }
    config.editorListOrder = { ...(config.editorListOrder ?? {}), [key]: next };
    return saveSendToChatConfig(config);
}

/** Entry `from` of list `key` is called `to` from here on: it keeps its place in a stored order. */
export function renameInStoredOrder(key: string, from: string, to: string): boolean {
    const order = storedListOrder(key);
    if (!order || !order.includes(from)) { return false; }
    const config = loadSendToChatConfig();
    if (!config) { return false; }
    config.editorListOrder = { ...(config.editorListOrder ?? {}), [key]: order.map((id) => (id === from ? to : id)) };
    return saveSendToChatConfig(config);
}
