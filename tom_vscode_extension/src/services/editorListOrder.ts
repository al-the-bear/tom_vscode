/**
 * The stored order of the editors' file-based lists (utils/listOrder.ts): the
 * configuration's `editorListOrder`, one list of ids per list key. Read and
 * written through the shared configuration file, so every window and host
 * shows a list in the same order.
 *
 * List keys: `queueTemplates`, `reusablePrompts:global` /
 * `reusablePrompts:<scope>:<sub>`, `groupPrompts:global:<kind>` /
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
