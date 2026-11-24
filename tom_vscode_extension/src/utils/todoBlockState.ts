/**
 * Whether a todo is blocked right now, and what a set of todos about to be
 * queued waits for outside itself.
 *
 * A todo is blocked when a `blocked_by` entry is not met — it names a todo
 * that is not completed or cancelled, or nothing that can be read (an unknown
 * id, prose) — or when its status is `blocked` for a reason no `blocked_by`
 * states (prose only, or a `blocked_until` condition). A todo whose status is
 * still `blocked` although every `blocked_by` entry is met, and which has no
 * `blocked_until`, is *releasable*: its blockers were completed in the
 * meantime, and it may run.
 *
 * The queue reads this before it sends a todo (a blocked todo holds its item,
 * a releasable one is set back to `not-started` and runs), and the todo panel
 * before it queues a group ({@link outsideBlockers}).
 *
 * "Met" is the cascade's and `_bin/check_todo_blocks.py`'s rule
 * (todoBlockingCascade.ts `blockedByVerdict`).
 *
 * Pure: imports neither `vscode` nor the todo files.
 */

import { blockedByVerdict, blockerOf, type StatusLookup } from './todoBlockingCascade';

/** What the block check reads of a todo. */
export interface TodoForBlockState {
    id: string;
    status?: string;
    // eslint-disable-next-line @typescript-eslint/naming-convention -- the todo schema's key
    blocked_by?: readonly string[];
    // eslint-disable-next-line @typescript-eslint/naming-convention -- the todo schema's key
    blocked_until?: readonly string[];
}

export interface TodoBlockState {
    /** The todo may not run now. */
    blocked: boolean;
    /** The `blocked_by` entries not met, as written. */
    open: string[];
    /** The `blocked_by` entries met (their todo is completed or cancelled). */
    met: string[];
    /** Status `blocked`, every `blocked_by` entry met and no `blocked_until`: its blockers are done, it may run. */
    releasable: boolean;
    /** One line saying what it waits for; '' when it is not blocked. */
    reason: string;
}

const norm = (status: string | undefined): string => (status ?? '').trim().toLowerCase().replace(/_/g, '-');

/** The block state of `todo` of `quest`. */
export function todoBlockState(todo: TodoForBlockState, quest: string, statusOf: StatusLookup, quests: ReadonlySet<string>): TodoBlockState {
    const entries = (todo.blocked_by ?? []).filter((e) => typeof e === 'string' && e.trim() !== '');
    const open: string[] = [];
    const met: string[] = [];
    for (const e of entries) { (blockedByVerdict(e, quest, statusOf, quests) === 'met' ? met : open).push(e); }
    const statusBlocked = norm(todo.status) === 'blocked';
    const until = (todo.blocked_until ?? []).filter((c) => typeof c === 'string' && c.trim() !== '');
    const releasable = statusBlocked && open.length === 0 && entries.length > 0 && until.length === 0;
    const blocked = open.length > 0 || (statusBlocked && !releasable);
    let reason = '';
    if (open.length) {
        reason = `waits for ${open.map((e) => {
            const target = blockerOf(e, quest, quests);
            const status = target ? statusOf(target.quest, target.id) : undefined;
            return `${e} (${status ? norm(status) : 'not found'})`;
        }).join(', ')}`;
    } else if (blocked) {
        reason = until.length ? `is blocked until ${until.join(', ')}` : 'is blocked (its status says so; no `blocked_by` names why)';
    }
    return { blocked, open, met, releasable, reason };
}

/** A blocker of a set being queued that does not run before the member: outside the set, or later in it. */
export interface OutsideBlocker {
    /** The member that waits. */
    member: string;
    /** The `blocked_by` entry, as written. */
    entry: string;
    /** The blocker's quest and id; undefined for an entry that names no todo. */
    quest?: string;
    id?: string;
    /** The blocker's status; undefined when it was not found. */
    status?: string;
    /** It is in the prompt queue ahead (set by the caller that knows the queue). */
    queuedAhead?: boolean;
    /** It is a member of the set itself, at or after the member in walk order: the walk reaches the member first. */
    laterInGroup?: boolean;
}

/**
 * What the open members of a set of todos (a group todo's members, a
 * `<prefix>*` group), given in walk order, wait for that does not run before
 * them: every unmet `blocked_by` entry of a member that is not done and names
 * no member, and every one naming a member at or after it in walk order
 * (`laterInGroup`: the walk reaches the waiting member first and holds
 * there). A blocker earlier in the set runs first and is not listed. A group
 * todo the member waits for is no member: it is listed (it is completed only
 * after its members). `queuedAhead` says for a blocker outside the set whether
 * it is already in the queue (it will run first).
 */
export function outsideBlockers(
    members: readonly TodoForBlockState[],
    quest: string,
    statusOf: StatusLookup,
    quests: ReadonlySet<string>,
    queuedAhead: (quest: string, id: string) => boolean = () => false,
): OutsideBlocker[] {
    const position = new Map(members.map((m, i) => [`${quest}/${m.id}`, i]));
    const out: OutsideBlocker[] = [];
    members.forEach((m, index) => {
        const status = norm(m.status);
        if (status === 'completed' || status === 'cancelled') { return; }
        for (const entry of todoBlockState(m, quest, statusOf, quests).open) {
            const target = blockerOf(entry, quest, quests);
            const at = target ? position.get(`${target.quest}/${target.id}`) : undefined;
            if (at !== undefined && at < index) { continue; }
            const blockerStatus = target ? statusOf(target.quest, target.id) : undefined;
            out.push({
                member: m.id,
                entry,
                ...(target ? { quest: target.quest, id: target.id } : {}),
                ...(blockerStatus !== undefined ? { status: norm(blockerStatus) } : {}),
                ...(at !== undefined ? { laterInGroup: true } : target && queuedAhead(target.quest, target.id) ? { queuedAhead: true } : {}),
            });
        }
    });
    return out;
}

/** The blockers the todo panel warns about: those that do not run first (not in the queue ahead, not earlier in the group). */
export function blockersNotAhead(blockers: readonly OutsideBlocker[]): OutsideBlocker[] {
    return blockers.filter((b) => !b.queuedAhead);
}

/**
 * The warning the todo panel gives before queueing `what` when members wait for todos that do not run before
 * them ({@link blockersNotAhead}): the message and its detail. Every todo is queued all the same, blocked or not.
 */
export function outsideBlockersQuestion(what: string, blockers: readonly OutsideBlocker[]): { message: string; detail: string } {
    const members = [...new Set(blockers.map((b) => b.member))];
    const lines = blockers.map((b) => {
        const state = b.laterInGroup ? 'later in this group' : b.queuedAhead ? 'already in the queue ahead' : b.status ? b.status : 'not found';
        return `• ${b.member} waits for ${b.entry} (${state})`;
    });
    const later = blockers.some((b) => b.laterInGroup);
    return {
        message: `${what}: ${members.length === 1 ? `todo ${members[0]} is` : `${members.length} todos are`} blocked by todos that do not run before them — not ahead in the prompt queue, not earlier in the group. Queue it anyway?`,
        detail: [
            ...lines,
            '',
            'Every todo is queued, blocked or not. A todo still blocked when the walk reaches it holds the item (item blocked) until its blocker is completed.'
                + (later ? ' A blocker later in the same group is only reached after it: complete it first, or change the order.' : ''),
        ].join('\n'),
    };
}
