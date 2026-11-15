/**
 * A todo's follow-up and origin (utils/todoOnDone.ts; ww_a_collab-3).
 *
 *   OD-1 the shape of `on_done`: closed keys, string fields, `todos` a list of ids, `action` a list of the four
 *        actions; `unblock` and `queue` need `todos`; absent / null pass
 *   OD-2 targets of unblock / queue must exist in the block's quest (default the todo's own); notify / none
 *        targets are not checked
 *   OD-3 the unblock entries: a bare id in the same quest, `<quest>/<id>` across quests; added to every unblock
 *        target, removed from those the block no longer names, all removed when the todo is cancelled and added
 *        again when it is reopened; queue targets get none
 *   OD-4 filed_by: the window quest, the session without its `@<run>`, the run from it (else the call's run, else
 *        `default`), the walk's claimed todo of that quest, the time with its offset; on another quest's request
 *        the sender's quest and run with the creating session (DP-part-todo-followups-3)
 *   OD-5 normalising: empty parts dropped, ids trimmed and deduplicated, nothing left → undefined
 */

/* eslint-disable @typescript-eslint/naming-convention -- the todo schema's YAML keys */
import { describe, test } from 'node:test';
import assert from 'node:assert/strict';

import {
    buildFiledBy, filedByShapeError, normaliseOnDone, onDoneShapeError, onDoneTargetRefusal, unblockEntry,
    unblockEntryPlan, withBlockedByEntry, withoutBlockedByEntry,
} from '../todoOnDone';

describe('todoOnDone', () => {
    test('OD-1: the shape of on_done', () => {
        assert.equal(onDoneShapeError(undefined), undefined);
        assert.equal(onDoneShapeError(null), undefined);
        assert.equal(onDoneShapeError({ todos: ['a'], action: ['unblock', 'notify'], report_to: 'x.md#t' }), undefined);
        assert.equal(onDoneShapeError({ action: ['notify'], notify_prompt: 'done' }), undefined, 'notify needs no todos');
        assert.match(onDoneShapeError('x') ?? '', /must be an object/);
        assert.match(onDoneShapeError({ when: 'later' }) ?? '', /unknown key "when"/);
        assert.match(onDoneShapeError({ action: 'unblock', todos: ['a'] }) ?? '', /must be a list/);
        assert.match(onDoneShapeError({ action: ['wake'], todos: ['a'] }) ?? '', /"wake"/);
        assert.match(onDoneShapeError({ action: ['unblock'] }) ?? '', /"unblock" needs `on_done.todos`/);
        assert.match(onDoneShapeError({ action: ['queue'], todos: [] }) ?? '', /"queue" needs/);
        assert.match(onDoneShapeError({ todos: [3] }) ?? '', /list of todo ids/);
        assert.match(onDoneShapeError({ quest: 3 }) ?? '', /on_done.quest` must be a string/);
        assert.equal(filedByShapeError({ quest: 'q', at: '2026-11-15T05:00+01:00' }), undefined);
        assert.match(filedByShapeError({ host: 'mbp' }) ?? '', /unknown key/);
    });

    test('OD-2: unblock / queue targets must exist', () => {
        const have = new Set(['own/a', 'other/b']);
        const exists = (q: string, id: string): boolean => have.has(`${q}/${id}`);
        assert.equal(onDoneTargetRefusal({ todos: ['a'], action: ['unblock'] }, 'own', exists), undefined);
        assert.equal(onDoneTargetRefusal({ quest: 'other', todos: ['b'], action: ['queue'] }, 'own', exists), undefined);
        assert.match(onDoneTargetRefusal({ todos: ['a', 'zz'], action: ['unblock'] }, 'own', exists) ?? '', /"zz", which quest "own"/);
        assert.match(onDoneTargetRefusal({ quest: 'other', todos: ['a'], action: ['queue'] }, 'own', exists) ?? '', /quest "other"/);
        assert.equal(onDoneTargetRefusal({ todos: ['zz'], action: ['notify'] }, 'own', exists), undefined, 'notify targets are not checked');
        assert.equal(onDoneTargetRefusal(undefined, 'own', exists), undefined);
    });

    test('OD-3: the unblock entries', () => {
        assert.equal(unblockEntry('q', 'a', 'q'), 'a');
        assert.equal(unblockEntry('q', 'a', 'r'), 'q/a');
        const open = { status: 'not-started', on_done: { todos: ['t1', 't2'], action: ['unblock' as const] } };
        assert.deepEqual(unblockEntryPlan(undefined, open, 'q'), { add: [{ quest: 'q', id: 't1' }, { quest: 'q', id: 't2' }], remove: [] });
        const replaced = { status: 'not-started', on_done: { quest: 'r', todos: ['t2'], action: ['unblock' as const] } };
        assert.deepEqual(unblockEntryPlan(open, replaced, 'q'), {
            add: [{ quest: 'r', id: 't2' }],
            remove: [{ quest: 'q', id: 't1' }, { quest: 'q', id: 't2' }],
        });
        const cancelled = { ...open, status: 'cancelled' };
        assert.deepEqual(unblockEntryPlan(open, cancelled, 'q').add, []);
        assert.equal(unblockEntryPlan(open, cancelled, 'q').remove.length, 2, 'cancelled: every entry goes');
        assert.equal(unblockEntryPlan(cancelled, open, 'q').add.length, 2, 'reopened: they come back');
        const queueOnly = { status: 'not-started', on_done: { todos: ['t1'], action: ['queue' as const] } };
        assert.deepEqual(unblockEntryPlan(undefined, queueOnly, 'q'), { add: [], remove: [] });
        assert.deepEqual(unblockEntryPlan(open, { status: 'not-started' }, 'q').remove.length, 2, 'on_done removed');
        assert.deepEqual(withBlockedByEntry(['x'], 'a'), ['x', 'a']);
        assert.deepEqual(withBlockedByEntry(['a'], 'a'), ['a']);
        assert.deepEqual(withoutBlockedByEntry(['x', 'a'], 'a'), ['x']);
    });

    test('OD-4: filed_by from the call context', () => {
        const now = new Date(2026, 10, 15, 6, 7);
        const at = buildFiledBy({}, now).at ?? '';
        assert.match(at, /^2026-11-15T06:07[+-]\d{2}:\d{2}$/);
        assert.deepEqual(buildFiledBy({ windowQuest: 'q', session: 'idea@collab', claim: { quest: 'q', id: 'w1' } }, now),
            { quest: 'q', run: 'collab', session: 'idea', todo: 'w1', at });
        assert.deepEqual(buildFiledBy({ windowQuest: 'q', session: 'chat', run: 'r2' }, now), { quest: 'q', run: 'r2', session: 'chat', at });
        assert.deepEqual(buildFiledBy({ windowQuest: 'q' }, now), { quest: 'q', run: 'default', at }, 'no session (Copilot, MCP)');
        assert.deepEqual(
            buildFiledBy({ windowQuest: 'q', session: 'default', claim: { quest: 'q', id: 'w1' }, sender: { quest: 'other', run: 'chg7' } }, now),
            { quest: 'other', run: 'chg7', session: 'default', at },
            'on request: the requester, with the creating session; the claim is no todo of the requester',
        );
        assert.equal(buildFiledBy({ windowQuest: 'q', sender: { quest: 'other' } }, now).run, 'default');
    });

    test('OD-5: normalising', () => {
        assert.equal(normaliseOnDone(undefined), undefined);
        assert.equal(normaliseOnDone({ todos: [' '], instructions: '  ' }), undefined);
        assert.deepEqual(normaliseOnDone({ quest: ' r ', todos: [' a', 'a', 'b'], action: ['unblock', 'unblock'], report_to: ' x ' }),
            { quest: 'r', todos: ['a', 'b'], action: ['unblock'], report_to: 'x' });
    });
});
