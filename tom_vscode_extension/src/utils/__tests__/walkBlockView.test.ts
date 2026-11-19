/**
 * What a queue item sees of its todos' blocks (utils/walkBlockView.ts).
 *
 *   WB-1 a blocker earlier in the item's own walk does not hold; a later one does
 *   WB-2 a blocker a queue item ahead runs does not hold; only the entries left are named
 *   WB-3 a stale in-progress todo of the series runs; one this item ran, one another item claims, or the user's own,
 *        does not; a single queued todo (no walk) is left as it is
 *   WB-4 the user's choices: a skipped todo is passed, a todo run anyway is not held (a `blocked` status runs as
 *        not-started)
 *   WB-5 a `blocked` status whose blockers all run first runs as not-started, unless it also waits for a version
 */

/* eslint-disable @typescript-eslint/naming-convention -- `blocked_by` is the todo schema's key */
import { describe, test } from 'node:test';
import assert from 'node:assert/strict';

import { effectiveBlock, walkBlockView, type ViewTodo, type WalkBlockContext } from '../walkBlockView.js';
import { todoBlockState } from '../todoBlockState.js';

const Q = 'q1';

function setup(todos: ViewTodo[], extra: Partial<WalkBlockContext> = {}): { ctx: WalkBlockContext; states: Map<string, ReturnType<typeof todoBlockState>> } {
    const byId = new Map(todos.map((t) => [t.id, t]));
    const statusOf = (quest: string, id: string): string | undefined => (quest === Q ? byId.get(id)?.status : extra.statusOf?.(quest, id));
    const quests = new Set([Q, 'other']);
    const ctx: WalkBlockContext = {
        questId: Q, quests, statusOf,
        queuedAhead: () => false, claimedElsewhere: () => false,
        ran: new Set(), skipped: new Set(), ignoreBlock: new Set(),
        ...extra,
    };
    const states = new Map<string, ReturnType<typeof todoBlockState>>();
    for (const t of todos) {
        if ((t.blockedBy?.length ?? 0) > 0 || t.status === 'blocked') {
            states.set(t.id, todoBlockState({ id: t.id, status: t.status, blocked_by: t.blockedBy, blocked_until: t.blockedUntil }, Q, statusOf, quests));
        }
    }
    return { ctx, states };
}
const byId = (list: Array<{ id: string }>, id: string): Record<string, unknown> => list.find((t) => t.id === id) as Record<string, unknown>;

describe('walk block view', () => {
    test('WB-1: a blocker earlier in the walk does not hold; a later one does', () => {
        const todos: ViewTodo[] = [
            { id: 'a1_x', status: 'not-started' },
            { id: 'a2_x', status: 'not-started', blockedBy: ['a1_x'] },
            { id: 'a3_x', status: 'not-started', blockedBy: ['a4_x'] },
            { id: 'a4_x', status: 'not-started' },
        ];
        const { ctx, states } = setup(todos);
        const view = walkBlockView('a*', todos, states, ctx);
        assert.equal(byId(view, 'a2_x').blockedReason, undefined);
        assert.equal(byId(view, 'a3_x').blockedReason, 'waits for a4_x (not-started)');
        assert.equal('blockedBy' in byId(view, 'a2_x'), false, 'the raw fields are not passed on');
    });

    test('WB-2: a blocker an item ahead runs does not hold', () => {
        const todos: ViewTodo[] = [{ id: 'b1_x', status: 'not-started', blockedBy: ['g1', 'g2', 'other/o1'] }, { id: 'g1', status: 'in-progress' }, { id: 'g2', status: 'not-started' }];
        const { ctx, states } = setup(todos, { queuedAhead: (quest, id) => (quest === Q && id === 'g1') || (quest === 'other' && id === 'o1') });
        const view = walkBlockView('b*', todos, states, ctx);
        assert.equal(byId(view, 'b1_x').blockedReason, 'waits for g2 (not-started)', 'only the entry left is named');
        const single = effectiveBlock({ id: 'b1_x', status: 'not-started', blockedBy: ['g1'] },
            todoBlockState({ id: 'b1_x', blocked_by: ['g1'] }, Q, ctx.statusOf, ctx.quests), ctx);
        assert.equal(single.blocked, false, 'a single queued todo too');
    });

    test('WB-3: stale in-progress todos of the series run', () => {
        const todos: ViewTodo[] = [
            { id: 'c1_x', status: 'in-progress' },
            { id: 'c2_x', status: 'in-progress' },
            { id: 'c3_x', status: 'in-progress' },
            { id: 'c4_x', status: 'in-progress', userAction: true },
            { id: 'c5_x', status: 'not-started', blockedBy: ['c1_x'] },
        ];
        const { ctx, states } = setup(todos, { ran: new Set(['c2_x']), claimedElsewhere: (id) => id === 'c3_x' });
        const view = walkBlockView('c*', todos, states, ctx);
        assert.equal(byId(view, 'c1_x').status, 'not-started', 'stale: runs');
        assert.equal(byId(view, 'c2_x').status, 'in-progress', 'this item ran it');
        assert.equal(byId(view, 'c3_x').status, 'in-progress', 'another running item works on it');
        assert.equal(byId(view, 'c4_x').status, 'in-progress', 'the user\'s own');
        assert.equal(byId(view, 'c5_x').blockedReason, undefined, 'its blocker runs before it');
        const plain = walkBlockView(undefined, todos, states, ctx);
        assert.equal(byId(plain, 'c1_x').status, 'in-progress', 'no walk: nothing is resumed');
        assert.equal(byId(plain, 'c5_x').blockedReason, 'waits for c1_x (in-progress)');
    });

    test('WB-4: skipped and run-anyway todos', () => {
        const todos: ViewTodo[] = [
            { id: 'd1_x', status: 'not-started', blockedBy: ['gate'] },
            { id: 'd2_x', status: 'blocked', blockedBy: ['gate'] },
            { id: 'gate', status: 'in-progress' },
        ];
        const { ctx, states } = setup(todos, { skipped: new Set(['d1_x']), ignoreBlock: new Set(['d2_x']) });
        const view = walkBlockView('d*', todos, states, ctx);
        assert.equal(byId(view, 'd1_x').excluded, true);
        assert.equal(byId(view, 'd2_x').blockedReason, undefined);
        assert.equal(byId(view, 'd2_x').status, 'not-started');
    });

    test('WB-5: a blocked status whose blockers run first', () => {
        const todos: ViewTodo[] = [
            { id: 'e1_x', status: 'not-started' },
            { id: 'e2_x', status: 'blocked', blockedBy: ['e1_x'] },
            { id: 'e3_x', status: 'blocked', blockedBy: ['e1_x'], blockedUntil: ['tom_basics >= 9.0.0'] },
        ];
        const { ctx, states } = setup(todos);
        const view = walkBlockView('e*', todos, states, ctx);
        assert.equal(byId(view, 'e2_x').status, 'not-started');
        assert.equal(byId(view, 'e2_x').blockedReason, undefined);
        assert.equal(byId(view, 'e3_x').blockedReason, 'is blocked until tom_basics >= 9.0.0');
    });
});
