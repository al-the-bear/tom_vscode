/**
 * A GROUP item's members and which of them it sends (vscimpb129).
 *
 * The item lists its group's members in `comprised_of` order (this quest's,
 * as the walk takes them, queueStep3Utils.collectWalkTodos), each with a
 * marker: → the member being sent, ✓ a member this item sent (with its
 * outcome: completed, or needs attention), or a checkbox for a member still to
 * come — checked when the walk will send it.
 *
 * The checkboxes start from the walk's rules, the same as a `<prefix>*` walk's:
 * not started — or a manual repeated todo — (walkRuleSends), or `blocked` /
 * `decision-needed`, where the walk holds until the blocker is completed or the
 * decision taken; never the user's own. Every member is queued, blocked or not. The user's choices are stored on
 * the item as overrides (`groupSelection`: the members checked and those
 * unchecked by hand); a member without a choice follows the rules, so one
 * added to the group later starts as the rules say, and one removed from it is
 * simply no member any more. The walk sends exactly the checked members, in
 * order, each once: a checked member is sent whatever its status, an unchecked
 * one never ({@link withSelectionFlags}).
 *
 * vscode-free and pure.
 */

import { collectWalkTodos, walkRuleSends, type TodoIterationSource, type TodoWalk } from './queueStep3Utils';

/** The user's choices on a GROUP item's members: checked and unchecked by hand. */
export interface GroupSelection {
    checked: string[];
    unchecked: string[];
}

/** A member of a GROUP item as the queue editor and tomAi_listQueue show it. */
export interface GroupMemberView {
    id: string;
    title?: string;
    status: string;
    /** `sending` (→), `sent` (✓), or `todo` (a checkbox). */
    marker: 'sending' | 'sent' | 'todo';
    /** For `sent`: the todo is completed, or it needs attention. */
    outcome?: 'completed' | 'needs attention';
    /** For `todo`: the walk will send it. */
    checked?: boolean;
    /** For `todo`: what the rules say (the box's state without a choice). */
    byRule?: boolean;
    /** For `todo`: the user chose its state. */
    chosen?: boolean;
}

/** A stored selection, when it is one (YAML `group-selection: {checked, unchecked}`). */
export function parseGroupSelection(value: unknown): GroupSelection | undefined {
    if (!value || typeof value !== 'object') { return undefined; }
    const v = value as { checked?: unknown; unchecked?: unknown };
    const ids = (x: unknown): string[] => (Array.isArray(x) ? x.filter((s): s is string => typeof s === 'string' && s !== '') : []);
    const sel = { checked: ids(v.checked), unchecked: ids(v.unchecked) };
    return sel.checked.length || sel.unchecked.length ? sel : undefined;
}

/** The todo sources with a GROUP item's selection applied: checked and not yet sent → forced, unchecked or sent → excluded. */
export function withSelectionFlags(todos: readonly TodoIterationSource[], selection: GroupSelection | undefined, sent: ReadonlySet<string>): TodoIterationSource[] {
    if (!selection) { return [...todos]; }
    const checked = new Set(selection.checked);
    const unchecked = new Set(selection.unchecked);
    return todos.map((t) => {
        if (checked.has(t.id)) { return sent.has(t.id) ? { ...t, excluded: true } : { ...t, forced: true }; }
        if (unchecked.has(t.id)) { return { ...t, excluded: true }; }
        return t;
    });
}

/** Set one member's choice: checked or unchecked by hand. */
export function withMemberChoice(selection: GroupSelection | undefined, id: string, checked: boolean): GroupSelection {
    const sel = { checked: (selection?.checked ?? []).filter((x) => x !== id), unchecked: (selection?.unchecked ?? []).filter((x) => x !== id) };
    (checked ? sel.checked : sel.unchecked).push(id);
    return sel;
}

/** The selection that checks exactly `checkedIds` among `memberIds` (Select all; tomAi_updateQueueItem `groupSelection`). */
export function selectionOf(memberIds: readonly string[], checkedIds: readonly string[]): GroupSelection {
    const want = new Set(checkedIds);
    return { checked: memberIds.filter((id) => want.has(id)), unchecked: memberIds.filter((id) => !want.has(id)) };
}

/**
 * A GROUP item's members with their markers, in walk order. `todos` are the
 * quest's todos (title, status), `sent` the members this item sent,
 * `sendingId` the member being sent now.
 */
export function groupItemMembers(input: {
    walk: TodoWalk;
    todos: readonly TodoIterationSource[];
    selection?: GroupSelection;
    sent: ReadonlySet<string>;
    sendingId?: string;
}): GroupMemberView[] {
    if (input.walk.kind !== 'group') { return []; }
    const checked = new Set(input.selection?.checked ?? []);
    const unchecked = new Set(input.selection?.unchecked ?? []);
    const byId = new Map(input.todos.map((t) => [t.id, t]));
    return collectWalkTodos(input.walk, input.todos).map((e): GroupMemberView => {
        const source = byId.get(e.id);
        const base = { id: e.id, ...(source?.title ? { title: source.title } : {}), status: e.status };
        if (e.id === input.sendingId) { return { ...base, marker: 'sending' }; }
        if (input.sent.has(e.id)) { return { ...base, marker: 'sent', outcome: e.status === 'completed' ? 'completed' : 'needs attention' }; }
        const byRule = walkRuleSends(source ?? e) || walkHoldsAt(source ?? e);
        const chosen = checked.has(e.id) || unchecked.has(e.id);
        return { ...base, marker: 'todo', checked: chosen ? checked.has(e.id) : byRule, byRule, ...(chosen ? { chosen: true } : {}) };
    });
}

/** A member the walk holds at until it can be sent: `blocked` or `decision-needed`, not the user's own. */
export function walkHoldsAt(e: { status?: string; userAction?: boolean }): boolean {
    const status = (e.status || '').trim().toLowerCase().replace(/_/g, '-');
    return (status === 'blocked' || status === 'decision-needed') && e.userAction !== true;
}

/** A member's marker as text (tomAi_listQueue): `→`, `✓ completed`, `☑`, `☐`. */
export function memberMarkerText(m: GroupMemberView): string {
    if (m.marker === 'sending') { return '→'; }
    if (m.marker === 'sent') { return `✓ ${m.outcome ?? ''}`.trim(); }
    return m.checked ? '☑' : '☐';
}
