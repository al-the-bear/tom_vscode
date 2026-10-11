/**
 * Tests for the prompt queue's todo claim (`utils/queueTodoClaim.ts`).
 *
 * The runner writes `in-progress` onto a todo when it dispatches it. When the
 * run stops, is interrupted or errors before the answer arrives, it must put
 * back what that write overwrote — and only that write: a status the agent or
 * the user set meanwhile is theirs and stays.
 *
 * TC-1  claim writes in-progress and records the prior status
 * TC-2  a failed write yields no claim (the dispatcher must not send)
 * TC-3  release restores the prior status when the todo still holds the claim
 * TC-4  release leaves a todo someone else moved (completed, blocked)
 * TC-5  release is idempotent and a no-op without a claim
 * TC-6  release reports an unreadable todo as failed and writes nothing
 * TC-7  a Resend re-claims a released todo still at its prior status ...
 * TC-8  ... and does not when somebody moved it after the release
 * TC-9  the claim round-trips through its persisted YAML shape
 * TC-10 wiring: the queue manager writes in-progress only through a claim,
 *       releases it on every exit that ends a run before its answer (stop,
 *       interrupt, error, removal, clear) and settles it on re-entry
 */
import test, { describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import {
    CLAIM_STATUS,
    claimTodo,
    reclaimForResend,
    releaseTodoClaim,
    todoClaimFromYaml,
    todoClaimToYaml,
    type TodoStatusPort,
} from '../queueTodoClaim.js';

/** An in-memory todo store with a write log. */
function store(initial: Record<string, string>, opts: { failWrites?: boolean } = {}) {
    const statuses = new Map(Object.entries(initial));
    const writes: string[] = [];
    const port: TodoStatusPort = {
        readStatus: (_q, id) => statuses.get(id),
        writeStatus: (_q, id, status) => {
            if (opts.failWrites || !statuses.has(id)) { return false; }
            statuses.set(id, status);
            writes.push(`${id}=${status}`);
            return true;
        },
    };
    return { port, statuses, writes };
}

const NOW = new Date('2026-10-07T10:00:00Z');

describe('queueTodoClaim', () => {
    test('TC-1: claim writes in-progress and records the prior status', () => {
        const s = store({ dsa7: 'not-started' });
        const claim = claimTodo(s.port, 'webwork', 'dsa7', 'not-started', NOW);
        assert.deepEqual(claim, {
            questId: 'webwork', todoId: 'dsa7', priorStatus: 'not-started', claimedAt: NOW.toISOString(),
        });
        assert.equal(s.statuses.get('dsa7'), CLAIM_STATUS);
        assert.deepEqual(s.writes, ['dsa7=in-progress']);
    });

    test('TC-2: a failed write yields no claim', () => {
        const s = store({ dsa7: 'not-started' }, { failWrites: true });
        assert.equal(claimTodo(s.port, 'webwork', 'dsa7', 'not-started', NOW), undefined);
        assert.equal(claimTodo(store({}).port, 'webwork', 'missing', 'not-started', NOW), undefined);
    });

    test('TC-3: release restores the prior status when the todo still holds the claim', () => {
        const s = store({ dsa7: 'not-started' });
        const claim = claimTodo(s.port, 'webwork', 'dsa7', 'not-started', NOW);
        const r = releaseTodoClaim(s.port, claim);
        assert.equal(r.outcome, 'restored');
        assert.equal(s.statuses.get('dsa7'), 'not-started');
        assert.equal(r.claim?.released, true);
        assert.deepEqual(s.writes, ['dsa7=in-progress', 'dsa7=not-started']);
    });

    for (const moved of ['completed', 'blocked', 'decision-needed']) {
        test(`TC-4: release leaves a todo that was moved to '${moved}'`, () => {
            const s = store({ dsa7: 'not-started' });
            const claim = claimTodo(s.port, 'webwork', 'dsa7', 'not-started', NOW);
            s.statuses.set('dsa7', moved); // the agent / the user wrote it
            const r = releaseTodoClaim(s.port, claim);
            assert.equal(r.outcome, 'left');
            assert.equal(r.found, moved);
            assert.equal(s.statuses.get('dsa7'), moved);
            assert.deepEqual(s.writes, ['dsa7=in-progress']);
        });
    }

    test('TC-5: release is idempotent and a no-op without a claim', () => {
        const s = store({ dsa7: 'not-started' });
        const claim = claimTodo(s.port, 'webwork', 'dsa7', 'not-started', NOW);
        const first = releaseTodoClaim(s.port, claim);
        // The status is set back to in-progress by hand: a second release of
        // the SAME (already released) claim must not touch it again.
        s.statuses.set('dsa7', 'in-progress');
        const second = releaseTodoClaim(s.port, first.claim);
        assert.equal(second.outcome, 'none');
        assert.equal(s.statuses.get('dsa7'), 'in-progress');
        assert.equal(releaseTodoClaim(s.port, undefined).outcome, 'none');
    });

    test('TC-6: an unreadable todo is reported failed and nothing is written', () => {
        const s = store({ dsa7: 'not-started' });
        const claim = claimTodo(s.port, 'webwork', 'dsa7', 'not-started', NOW)!;
        s.statuses.delete('dsa7');
        const r = releaseTodoClaim(s.port, claim);
        assert.equal(r.outcome, 'failed');
        assert.equal(r.claim?.released, true);
        assert.deepEqual(s.writes, ['dsa7=in-progress']);
    });

    test('TC-7: a Resend re-claims a released todo still at its prior status', () => {
        const s = store({ dsa7: 'not-started' });
        const released = releaseTodoClaim(s.port, claimTodo(s.port, 'webwork', 'dsa7', 'not-started', NOW)).claim;
        const again = reclaimForResend(s.port, released, NOW);
        assert.equal(again?.released, undefined);
        assert.equal(s.statuses.get('dsa7'), 'in-progress');
        // A live claim is returned unchanged, with no write.
        assert.equal(reclaimForResend(s.port, again, NOW), again);
        assert.deepEqual(s.writes, ['dsa7=in-progress', 'dsa7=not-started', 'dsa7=in-progress']);
    });

    test('TC-8: a Resend does not re-claim a todo somebody moved after the release', () => {
        const s = store({ dsa7: 'not-started' });
        const released = releaseTodoClaim(s.port, claimTodo(s.port, 'webwork', 'dsa7', 'not-started', NOW)).claim;
        s.statuses.set('dsa7', 'cancelled');
        assert.equal(reclaimForResend(s.port, released, NOW), released);
        assert.equal(s.statuses.get('dsa7'), 'cancelled');
    });

    test('TC-9: the claim round-trips through its persisted YAML shape', () => {
        const s = store({ dsa7: 'not-started' });
        const claim = claimTodo(s.port, 'webwork', 'dsa7', 'Not Started', NOW)!;
        assert.equal(claim.priorStatus, 'not-started');
        assert.deepEqual(todoClaimFromYaml(todoClaimToYaml(claim)), claim);
        const released = releaseTodoClaim(s.port, claim).claim!;
        assert.deepEqual(todoClaimFromYaml(todoClaimToYaml(released)), released);
        assert.equal(todoClaimToYaml(undefined), undefined);
        assert.equal(todoClaimFromYaml(undefined), undefined);
        assert.equal(todoClaimFromYaml({ quest: 'webwork' }), undefined);
    });

    test('TC-10: the queue manager claims, releases and settles at the right places', () => {
        // out/utils/__tests__ -> project root is three levels up.
        const src = readFileSync(join(__dirname, '..', '..', '..', 'src', 'managers', 'promptQueueManager.ts'), 'utf8');
        const body = (signature: string): string => {
            const start = src.indexOf(signature);
            assert.notEqual(start, -1, `method not found: ${signature}`);
            // Up to the next class-member declaration at four-space indent.
            const rest = src.slice(start + signature.length);
            const end = rest.search(/\n    (?:private |async |public |static |get |set )?[A-Za-z_]+\s*\(/);
            return end === -1 ? rest : rest.slice(0, end);
        };
        // The only literal in-progress write is the claim's; no direct
        // writeQuestTodoStatus(…, 'in-progress') and no blind 'not-started'.
        assert.doesNotMatch(src, /writeQuestTodoStatus\([^)]*'in-progress'\)/);
        assert.doesNotMatch(src, /writeQuestTodoStatus\([^)]*'not-started'\)/);
        assert.match(body('private claimQuestTodo('), /claimTodo\(/);
        for (const exit of [
            'setStatus(id: string',                       // stop
            'interruptActiveItemForContinuation(',        // interrupt
            'private _markItemError(',                    // error
            'remove(id: string)',                         // removal
            'private _releaseClaimsOfDroppedItems(',      // clear
        ]) {
            assert.match(body(exit), /releaseQuestTodoClaim\(/, `no release in ${exit}`);
        }
        assert.match(body('clearAll()'), /_releaseClaimsOfDroppedItems\(/);
        assert.match(body('clearByStatus('), /_releaseClaimsOfDroppedItems\(/);
        assert.match(body('private async dispatchNextStageForSendingItem('), /item\.todoClaim = undefined/);
        assert.match(body('async resendLastPrompt('), /reclaimForResend\(/);
    });
});
