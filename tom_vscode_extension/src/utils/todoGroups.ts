/**
 * Todo groups (vscimpb125): a todo with status `group` lists its members in
 * `comprised_of` — ids in its own quest, `<quest>/<id>` from another, as
 * `blocked_by` names blockers. Each member's `part_of`, the groups naming it,
 * is derived when read and never stored ({@link partOfRefs}).
 *
 * A group follows its members ({@link groupDecisions}): once every member is
 * completed or cancelled (live or archived; a member that cannot be found is
 * not done) the group becomes `completed`; when a member goes back to an open
 * status, a completed group becomes `group` again. The rule runs on the same
 * status-change path as the blocking rule (todoBlockingCascade.ts), before it,
 * so a todo blocked by a group is released when the group completes.
 *
 * vscode-free and pure.
 */

import { addressKey, blockingRefFor, resolveTodoRef, type TodoAddress } from './todoBlocking';

export const GROUP_STATUS = 'group';

const DONE = new Set(['completed', 'cancelled']);

/** A group todo, as the rules read it. */
export interface GroupRecord {
    /** `quest:<quest>` or `file:<path>` (todoBlocking.ts). */
    scopeKey: string;
    quest?: string;
    id: string;
    status: string;
    comprisedOf: string[];
}

/**
 * The `part_of` of `target`: every group whose `comprised_of` names it — its
 * bare id in the same scope, `<quest>/<id>` from another — sorted, without
 * repeats.
 */
export function partOfRefs(target: TodoAddress, groups: readonly GroupRecord[]): string[] {
    const refs = new Set<string>();
    const key = addressKey(target);
    for (const g of groups) {
        if (!g.comprisedOf.some((ref) => {
            const named = resolveTodoRef(ref, g);
            return !!named && addressKey(named) === key;
        })) { continue; }
        const name = blockingRefFor({ scopeKey: g.scopeKey, quest: g.quest, id: g.id, blockedBy: [], blocking: [] }, target.scopeKey);
        if (name) { refs.add(name); }
    }
    return [...refs].sort();
}

/** A status a todo crossed to (from done to open, or the other way). */
export interface MemberCrossing {
    quest: string;
    id: string;
    status: string;
}

/** A group's status change. */
export interface GroupDecision {
    quest: string;
    id: string;
    from: string;
    to: string;
    note: string;
}

/** The status of todo `id` of `quest` (live first, else archived / deleted); undefined when it is nowhere. */
export type GroupStatusLookup = (quest: string, id: string) => string | undefined;

/** The quest and id a `comprised_of` entry of a group in `ownQuest` names (undefined: malformed). */
function memberOf(entry: string, ownQuest: string): { quest: string; id: string } | undefined {
    const named = resolveTodoRef(entry, { scopeKey: `quest:${ownQuest}`, quest: ownQuest });
    if (!named || !named.scopeKey.startsWith('quest:')) { return undefined; }
    return { quest: named.scopeKey.slice('quest:'.length), id: named.id };
}

/**
 * What the groups naming a crossed todo do: a `group` whose members are now
 * all done becomes `completed`; a `completed` group with a member that went
 * back to an open status becomes `group`. Other statuses (a group cancelled
 * by hand, …) are left alone.
 */
export function groupDecisions(
    crossings: readonly MemberCrossing[],
    groups: readonly GroupRecord[],
    statusOf: GroupStatusLookup,
): GroupDecision[] {
    const out: GroupDecision[] = [];
    const seen = new Set<string>();
    for (const g of groups) {
        if (!g.quest || seen.has(`${g.quest}/${g.id}`)) { continue; }
        const members = g.comprisedOf.map((e) => memberOf(e, g.quest!));
        const crossed = crossings.filter((c) => members.some((m) => m && m.quest === c.quest && m.id === c.id));
        if (!crossed.length) { continue; }
        const ref = (c: MemberCrossing): string => (c.quest === g.quest ? c.id : `${c.quest}/${c.id}`);
        const reopened = crossed.find((c) => !DONE.has(c.status));
        if (g.status === 'completed' && reopened) {
            out.push({ quest: g.quest, id: g.id, from: g.status, to: GROUP_STATUS, note: `group reopened: ${ref(reopened)} is ${reopened.status}` });
            seen.add(`${g.quest}/${g.id}`);
            continue;
        }
        if (g.status === GROUP_STATUS && members.length > 0
            && members.every((m) => !!m && DONE.has(statusOf(m.quest, m.id) ?? ''))) {
            out.push({ quest: g.quest, id: g.id, from: g.status, to: 'completed', note: 'group completed: every member is done' });
            seen.add(`${g.quest}/${g.id}`);
        }
    }
    return out;
}
