/**
 * The order of the entries in an editor's list (the list on the left of the
 * template, profile, prompt, role and process editors), moved with the Up and
 * Down buttons.
 *
 * Two kinds of list:
 *
 *   - entries kept in an array of the configuration (templates, profiles):
 *     the array itself is reordered ({@link moveById}), so every picker that
 *     lists them follows;
 *   - entries that are files or folders (queue templates, reusable prompts,
 *     group prompts, roles, role types, processes): their order is stored per
 *     list in the configuration's `editorListOrder` ({@link applyListOrder},
 *     {@link movedListOrder}) and applied to the editor's list.
 *
 * A stored order names ids; an entry it does not name follows the named ones
 * in the list's own order (a new file appears at the end), an id that names no
 * entry is ignored.
 *
 * Pure: no `vscode`, no `fs`.
 */

export type MoveDirection = 'up' | 'down';

/** `direction` as given by a webview, or undefined. */
export function moveDirection(value: unknown): MoveDirection | undefined {
    return value === 'up' || value === 'down' ? value : undefined;
}

/**
 * `items` with the entry whose id is `id` moved one place up or down;
 * undefined when it cannot move (not in the list, already first / last).
 */
export function moveById<T>(items: readonly T[], id: string, direction: MoveDirection, idOf: (item: T) => string): T[] | undefined {
    const from = items.findIndex((i) => idOf(i) === id);
    if (from < 0) { return undefined; }
    const to = direction === 'up' ? from - 1 : from + 1;
    if (to < 0 || to >= items.length) { return undefined; }
    const next = [...items];
    [next[from], next[to]] = [next[to], next[from]];
    return next;
}

/** `items` in the stored `order`: the ids it names first, in its order, then the others as they were. */
export function applyListOrder<T>(items: readonly T[], order: readonly string[] | undefined, idOf: (item: T) => string): T[] {
    if (!order?.length) { return [...items]; }
    const rank = new Map<string, number>();
    order.forEach((id, i) => { if (!rank.has(id)) { rank.set(id, i); } });
    const named = items.filter((i) => rank.has(idOf(i))).sort((a, b) => rank.get(idOf(a))! - rank.get(idOf(b))!);
    return [...named, ...items.filter((i) => !rank.has(idOf(i)))];
}

/**
 * The order to store after moving `id` one place in the list shown (`shownIds`,
 * already in its stored order): every shown id, in the new order. Undefined
 * when it cannot move.
 */
export function movedListOrder(shownIds: readonly string[], id: string, direction: MoveDirection): string[] | undefined {
    return moveById(shownIds, id, direction, (x) => x);
}

/** Whether entry `id` of the list shown can move up / down (for the buttons' disabled state). */
export function canMove(shownIds: readonly string[], id: string | undefined): { up: boolean; down: boolean } {
    const at = id === undefined ? -1 : shownIds.indexOf(id);
    return { up: at > 0, down: at >= 0 && at < shownIds.length - 1 };
}
