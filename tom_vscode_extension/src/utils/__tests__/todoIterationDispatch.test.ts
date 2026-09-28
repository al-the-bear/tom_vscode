/**
 * Tests for the main-stage dispatch gate — the decision "is there another
 * main prompt to send, and what drives it".
 *
 * Two modes share one gate:
 *
 * - **counter** — the classic behaviour. A numeric (or variable-resolved)
 *   repeat count; send while `sentCount < repeatCount`.
 * - **todo iteration** — triggered by a `<prefix>*` repeat count. The repeat
 *   count becomes display-only (the size of the series); what actually drives
 *   the loop is whether a `not-started` todo is still left. Since the
 *   dispatcher marks the picked todo `in-progress`, the candidate set shrinks
 *   on every pass and the loop terminates.
 *
 * The gate is pure so both modes can be pinned without the vscode-coupled
 * PromptQueueManager.
 */
import test, { describe } from 'node:test';
import assert from 'node:assert/strict';

import { planMainStageDispatch, releaseResolvedDecisionItems } from '../queueStep3Utils.js';

/** Terse fixture builder: `t('dsa2', 'not-started', 'Fix the thing')`. */
function t(id: string, status?: string, title?: string) {
    return { id, status, title };
}

describe('planMainStageDispatch — counter mode', () => {
    test('dispatches while the sent count is below the repeat count', () => {
        assert.deepEqual(planMainStageDispatch(3, 0, 3, []), { mode: 'counter', repeatIndex: 0 });
        assert.deepEqual(planMainStageDispatch(3, 2, 3, []), { mode: 'counter', repeatIndex: 2 });
    });

    test('is exhausted once the sent count reaches the repeat count', () => {
        assert.deepEqual(planMainStageDispatch(3, 3, 3, []), { mode: 'exhausted' });
    });

    test('a non-prefix string repeat count still counts — todos are ignored', () => {
        // `batchCount` is a chat variable; it was already resolved into the
        // repeat count, so the todos must not influence the gate.
        assert.deepEqual(
            planMainStageDispatch('batchCount', 1, 2, [t('dsa1', 'not-started')]),
            { mode: 'counter', repeatIndex: 1 },
        );
    });
});

describe('planMainStageDispatch — todo iteration mode', () => {
    test('dispatches the first not-started todo', () => {
        const plan = planMainStageDispatch('dsa*', 0, 3, [t('dsa2'), t('dsa1', undefined, 'First')]);
        assert.equal(plan.mode, 'todo');
        assert.equal(plan.mode === 'todo' && plan.todo.id, 'dsa1');
        assert.equal(plan.mode === 'todo' && plan.todo.title, 'First');
    });

    test('the sent count does not gate the walk — only the todos do', () => {
        // The series is `dsa1..dsa9` so the count is 9, but only `dsa9` is
        // left. Counter mode would send eight more times; todo mode sends once.
        const todos = [t('dsa1', 'completed'), t('dsa9', 'not-started')];
        const plan = planMainStageDispatch('dsa*', 0, 9, todos);
        assert.equal(plan.mode === 'todo' && plan.todo.id, 'dsa9');
        assert.equal(plan.mode === 'todo' && plan.todo.index, 9);
    });

    test('keeps walking even after more reps went out than the count', () => {
        // A stale/short resolved count must never cut the walk short.
        const plan = planMainStageDispatch('dsa*', 99, 1, [t('dsa4', 'not-started')]);
        assert.equal(plan.mode === 'todo' && plan.todo.id, 'dsa4');
    });

    test('is exhausted once every matching todo has been dispatched', () => {
        const todos = [t('dsa1', 'in-progress'), t('dsa2', 'completed')];
        assert.deepEqual(planMainStageDispatch('dsa*', 0, 2, todos), { mode: 'exhausted' });
    });

    test('is exhausted when the prefix matches no todo at all', () => {
        // Deliberate: `resolveTodoPrefixRepeatCount` floors at 1, but sending
        // a "work on ${repeatTodoId}" prompt with no todo to name is worse
        // than not sending it. The manager logs this case.
        assert.deepEqual(planMainStageDispatch('dsa*', 0, 1, [t('xyz1')]), { mode: 'exhausted' });
        assert.deepEqual(planMainStageDispatch('dsa*', 0, 1, []), { mode: 'exhausted' });
    });
});

describe('planMainStageDispatch — a series with unmade decisions', () => {
    // A `decision-needed` todo is one the user has not answered yet. Running
    // *any* todo of the series past it means working from a guess about the
    // very thing that is still open, so the whole series is held — not just
    // that one todo.

    test('a decision-needed todo blocks the series even when work is available', () => {
        const todos = [t('dsa1', 'not-started'), t('dsa2', 'decision-needed')];
        const plan = planMainStageDispatch('dsa*', 0, 2, todos);
        assert.equal(plan.mode, 'decision-needed');
    });

    test('the block names the todos that are waiting', () => {
        // The manager logs these and the user has to find them; a bare "queue
        // paused" would send them hunting through the whole todo file.
        const todos = [t('dsa1', 'not-started'), t('dsa3', 'decision-needed', 'Pick a backend')];
        const plan = planMainStageDispatch('dsa*', 0, 3, todos);
        assert.equal(plan.mode === 'decision-needed' && plan.todos.length, 1);
        assert.equal(plan.mode === 'decision-needed' && plan.todos[0].id, 'dsa3');
        assert.equal(plan.mode === 'decision-needed' && plan.todos[0].title, 'Pick a backend');
    });

    test('position in the series is irrelevant — first or last, it blocks', () => {
        assert.equal(
            planMainStageDispatch('dsa*', 0, 2, [t('dsa1', 'decision-needed'), t('dsa2', 'not-started')]).mode,
            'decision-needed',
        );
        assert.equal(
            planMainStageDispatch('dsa*', 0, 2, [t('dsa1', 'not-started'), t('dsa2', 'decision-needed')]).mode,
            'decision-needed',
        );
    });

    test('blocks rather than reporting exhausted when nothing else is left', () => {
        // Reporting `exhausted` here would silently finish the queue item and
        // the open decision would never surface.
        const todos = [t('dsa1', 'completed'), t('dsa2', 'decision-needed')];
        assert.equal(planMainStageDispatch('dsa*', 0, 2, todos).mode, 'decision-needed');
    });

    test('every waiting todo is reported, not just the first', () => {
        const todos = [t('dsa1', 'decision-needed'), t('dsa2', 'not-started'), t('dsa3', 'decision-needed')];
        const plan = planMainStageDispatch('dsa*', 0, 3, todos);
        assert.deepEqual(
            plan.mode === 'decision-needed' ? plan.todos.map(x => x.id) : [],
            ['dsa1', 'dsa3'],
        );
    });

    test('a decision-needed todo outside the prefix does not block', () => {
        const todos = [t('dsa1', 'not-started'), t('other2', 'decision-needed')];
        assert.equal(planMainStageDispatch('dsa*', 0, 1, todos).mode, 'todo');
    });

    test('counter mode is unaffected — it does not look at todos', () => {
        assert.deepEqual(
            planMainStageDispatch(3, 0, 3, [t('dsa1', 'decision-needed')]),
            { mode: 'counter', repeatIndex: 0 },
        );
    });

    test('a hand-edited status still counts', () => {
        // Todo files are hand-editable; `decision_needed` and stray case are
        // what a human types.
        assert.equal(
            planMainStageDispatch('dsa*', 0, 1, [t('dsa1', 'Decision_Needed')]).mode,
            'decision-needed',
        );
    });

    test('once the decisions are answered the walk resumes', () => {
        const todos = [t('dsa1', 'not-started'), t('dsa2', 'not-started')];
        const plan = planMainStageDispatch('dsa*', 0, 2, todos);
        assert.equal(plan.mode === 'todo' && plan.todo.id, 'dsa1');
    });
});

describe('releaseResolvedDecisionItems — restarting the queue', () => {
    // A held item is released only once its series has no open decision left.
    //
    // Releasing unconditionally looks harmless — the gate would just block the
    // item again — but it is what made the play button a no-op: the released
    // item is the first `pending` one in array order, so `sendNext` picks it,
    // the gate re-blocks it and turns auto-send OFF again. The queue never got
    // as far as the prompts that had nothing to decide. Releasing only what is
    // genuinely resolved leaves the blocked item held and lets the rest drain.
    //
    // Nothing but `status` is touched, so an item with prior repetitions
    // resumes on its counters rather than re-sending from the top.

    /** Terse fixture: a held queue item walking the `dsa*` series. */
    function held(id: string, repeatCount: unknown = 'dsa*') {
        return { id, status: 'decision-needed', repeatCount: repeatCount as string };
    }

    test('a held item whose decisions are all answered goes back to pending', () => {
        const items = [held('a')];
        const released = releaseResolvedDecisionItems(items, [t('dsa1', 'not-started')]);
        assert.deepEqual(released.map(i => i.id), ['a']);
        assert.equal(items[0].status, 'pending');
    });

    test('a held item with an open decision stays held', () => {
        const items = [held('a')];
        const released = releaseResolvedDecisionItems(items, [
            t('dsa1', 'not-started'), t('dsa2', 'decision-needed'),
        ]);
        assert.deepEqual(released, []);
        assert.equal(items[0].status, 'decision-needed');
    });

    test('only the resolved item of a mixed set is released', () => {
        const items = [held('a', 'dsa*'), held('b', 'dec*')];
        const released = releaseResolvedDecisionItems(items, [
            t('dsa1', 'not-started'), t('dec1', 'decision-needed'),
        ]);
        assert.deepEqual(released.map(i => i.id), ['a']);
        assert.deepEqual(items.map(i => i.status), ['pending', 'decision-needed']);
    });

    test('an open decision outside the item’s own series does not hold it', () => {
        // Each item walks its own prefix; another series’ unanswered question
        // is none of its business.
        const items = [held('a', 'dsa*')];
        assert.equal(releaseResolvedDecisionItems(items, [t('other1', 'decision-needed')]).length, 1);
        assert.equal(items[0].status, 'pending');
    });

    test('leaves every other status alone', () => {
        const items = [
            { id: 'a', status: 'staged', repeatCount: 'dsa*' },
            held('b'),
            { id: 'c', status: 'sending', repeatCount: 'dsa*' },
            { id: 'd', status: 'sent', repeatCount: 'dsa*' },
            { id: 'e', status: 'error', repeatCount: 'dsa*' },
        ];
        assert.deepEqual(releaseResolvedDecisionItems(items, []).map(i => i.id), ['b']);
        assert.deepEqual(items.map(i => i.status), ['staged', 'pending', 'sending', 'sent', 'error']);
    });

    test('an empty todo set releases — never strand an item on a file we cannot read', () => {
        // No todos means no open decision we know of. The gate then reports
        // `exhausted` and the item finishes, which is recoverable; holding it
        // forever is not.
        const items = [held('a')];
        assert.equal(releaseResolvedDecisionItems(items, []).length, 1);
        assert.equal(items[0].status, 'pending');
    });

    test('a held item without a prefix* repeat count is released', () => {
        // Defensive: only todo iteration can reach the block, so such an item
        // is a leftover from an edited repeat count. Nothing can ever resolve
        // it, so holding it would strand it.
        const items = [held('a', 3), { id: 'b', status: 'decision-needed', repeatCount: undefined }];
        assert.deepEqual(releaseResolvedDecisionItems(items, [t('dsa1', 'decision-needed')]).map(i => i.id), ['a', 'b']);
        assert.deepEqual(items.map(i => i.status), ['pending', 'pending']);
    });

    test('reports nothing when no item was held', () => {
        const items = [{ id: 'a', status: 'pending', repeatCount: 'dsa*' }];
        assert.deepEqual(releaseResolvedDecisionItems(items, []), []);
    });
});
