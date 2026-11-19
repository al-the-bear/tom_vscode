/**
 * What a queue item sees of its todos' blocks (pure): the rules that decide
 * whether a walk, a GROUP item or a single queued todo holds at a blocked
 * todo, on top of the todo's own block state (utils/todoBlockState.ts).
 *
 * - **A blocker that runs first does not hold.** A `blocked_by` entry naming
 *   a todo the item itself will run earlier (it comes before the blocked todo
 *   in the walk's order: lowest number first, or the group's member order), or
 *   a todo a queue item ahead of this one runs (a single todo it names, or an
 *   open todo of its walk or group), is taken as done by the time the blocked
 *   todo is reached; the todo runs. Only the entries left decide.
 * - **A walk runs its in-progress todos too.** An `in-progress` todo of the
 *   series that this item has not run, and that no running queue item works
 *   on (its claim is stale — a reload, a stopped run), is run like a
 *   `not-started` one.
 * - **The user's choices on a held item:** a todo the user skipped
 *   (Continue) is passed by the walk; a todo the user runs anyway (Run
 *   anyway) is not held by its blockers.
 *
 * vscode-free, no fs.
 */

import { collectWalkTodos, parseTodoWalk, type TodoIterationSource } from './queueStep3Utils';
import { todoBlockState, type TodoBlockState } from './todoBlockState';
import { blockerOf, type StatusLookup } from './todoBlockingCascade';

/** What the view needs to know beyond the todos. */
export interface WalkBlockContext {
    questId: string;
    quests: ReadonlySet<string>;
    statusOf: StatusLookup;
    /** A todo the item ahead of this one in the queue runs (it will be done first). */
    queuedAhead(quest: string, id: string): boolean;
    /** A todo a running queue item (another than this one) holds a claim on. */
    claimedElsewhere(id: string): boolean;
    /** The todos this item has run. */
    ran: ReadonlySet<string>;
    /** Todos the user skipped on this item (Continue): the walk passes them. */
    skipped: ReadonlySet<string>;
    /** Todos the user runs anyway on this item: their blockers do not hold. */
    ignoreBlock: ReadonlySet<string>;
}

/** A todo's block as the item sees it: whether it holds, and why. */
export interface EffectiveBlock {
    blocked: boolean;
    reason: string;
    /** The todo's status is `blocked` but nothing the item waits for is left: it runs as `not-started`. */
    runsAsNotStarted: boolean;
}

/**
 * The block of todo `todo` (with its raw `blocked_by` / `blocked_until` and
 * its block state) as the item sees it. `earlier`: the todos the item runs
 * before this one (its own walk order).
 */
export function effectiveBlock(
    todo: { id: string; status?: string; blockedBy?: readonly string[]; blockedUntil?: readonly string[] },
    state: TodoBlockState,
    ctx: WalkBlockContext,
    earlier: ReadonlySet<string> = new Set(),
): EffectiveBlock {
    const statusBlocked = (todo.status ?? '').trim().toLowerCase() === 'blocked';
    if (ctx.ignoreBlock.has(todo.id)) { return { blocked: false, reason: '', runsAsNotStarted: statusBlocked }; }
    if (!state.blocked) { return { blocked: false, reason: '', runsAsNotStarted: false }; }
    const left = state.open.filter((entry) => {
        const target = blockerOf(entry, ctx.questId, ctx.quests);
        if (!target) { return true; }
        if (target.quest === ctx.questId && earlier.has(target.id)) { return false; }
        return !ctx.queuedAhead(target.quest, target.id);
    });
    const until = (todo.blockedUntil ?? []).filter((c) => typeof c === 'string' && c.trim() !== '');
    if (left.length === state.open.length) {
        // Nothing covered: the todo's own verdict stands.
        return { blocked: true, reason: state.reason, runsAsNotStarted: false };
    }
    if (left.length > 0) {
        // eslint-disable-next-line @typescript-eslint/naming-convention -- the todo schema's key
        const reduced = todoBlockState({ id: todo.id, status: 'not-started', blocked_by: left }, ctx.questId, ctx.statusOf, ctx.quests);
        return { blocked: true, reason: reduced.reason, runsAsNotStarted: false };
    }
    // Every open blocker runs first. A `blocked` status that also waits for a version still holds.
    if (statusBlocked && until.length > 0) {
        return { blocked: true, reason: `is blocked until ${until.join(', ')}`, runsAsNotStarted: false };
    }
    return { blocked: false, reason: '', runsAsNotStarted: statusBlocked };
}

/** A todo as the view reads it: the walk's source fields and the raw block fields. */
export type ViewTodo = TodoIterationSource & { blockedBy?: readonly string[]; blockedUntil?: readonly string[] };

/**
 * The todos as the item `repeatCount` walks them: the user's skips excluded,
 * stale in-progress todos of the series run, and each todo's block decided by
 * {@link effectiveBlock} (`blockedReason` set where it holds). `states`: the
 * block state of every todo that carries a block.
 */
export function walkBlockView(
    repeatCount: unknown,
    todos: readonly ViewTodo[],
    states: ReadonlyMap<string, TodoBlockState>,
    ctx: WalkBlockContext,
): TodoIterationSource[] {
    const walk = parseTodoWalk(repeatCount);
    const resumed = todos.map((t): ViewTodo => {
        if (ctx.skipped.has(t.id)) { return { ...t, excluded: true }; }
        const status = (t.status ?? '').trim().toLowerCase();
        if (walk && status === 'in-progress' && !t.userAction && !ctx.ran.has(t.id) && !ctx.claimedElsewhere(t.id)) {
            return { ...t, status: 'not-started' };
        }
        return t;
    });
    // The walk's order, so a todo knows which ones the item runs before it.
    const order = walk ? collectWalkTodos(walk, resumed).map((e) => e.id) : [];
    const position = new Map(order.map((id, i) => [id, i]));
    return resumed.map((t) => {
        const { blockedBy: _blockedBy, blockedUntil: _blockedUntil, ...source } = t;
        void _blockedBy; void _blockedUntil;
        const state = states.get(t.id);
        if (!state) { return source; }
        const at = position.get(t.id);
        const earlier = new Set(at === undefined ? [] : order.slice(0, at));
        const block = effectiveBlock(t, state, ctx, earlier);
        if (block.blocked) { return { ...source, blockedReason: block.reason }; }
        return block.runsAsNotStarted ? { ...source, status: 'not-started' } : source;
    });
}
