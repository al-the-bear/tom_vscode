/**
 * Unit tests for the trailing-edge `debounce` helper (plan §7, todo #7).
 *
 * The MCP config file watcher (`extension.ts`) fires `onDidChange` multiple
 * times per save; `debounce` collapses those bursts into a single reconcile
 * call. The scheduler is injected so the behaviour is driven synchronously
 * here — no real timers, mirroring the "inject the boundary" test seam the
 * MCP handler uses for `vscode`/`process`.
 */

import test, { describe } from 'node:test';
import assert from 'node:assert/strict';

import { debounce, type DebounceScheduler } from '../debounce.js';

/**
 * Deterministic scheduler: records pending handlers instead of using real
 * timers. `flush()` fires every currently-pending handler (the trailing-edge
 * fire); `clear` drops one (the burst-collapse path).
 */
class FakeScheduler implements DebounceScheduler {
    private nextId = 1;
    private readonly handlers = new Map<number, () => void>();

    set(handler: () => void, _delayMs: number): number {
        const id = this.nextId++;
        this.handlers.set(id, handler);
        return id;
    }

    clear(handle: number): void {
        this.handlers.delete(handle);
    }

    flush(): void {
        const pending = [...this.handlers.values()];
        this.handlers.clear();
        for (const h of pending) {
            h();
        }
    }

    get pendingCount(): number {
        return this.handlers.size;
    }
}

describe('debounce (todo #7)', () => {
    test('a single call fires once after the delay elapses', () => {
        const scheduler = new FakeScheduler();
        let calls = 0;
        const d = debounce(() => { calls++; }, 50, scheduler);

        d();
        assert.equal(calls, 0, 'must not fire synchronously');
        scheduler.flush();
        assert.equal(calls, 1, 'fires once after the delay');
    });

    test('a burst of rapid calls collapses into a single trailing invocation', () => {
        const scheduler = new FakeScheduler();
        let calls = 0;
        const d = debounce(() => { calls++; }, 50, scheduler);

        d();
        d();
        d();
        assert.equal(scheduler.pendingCount, 1, 'only one timer is ever pending');
        scheduler.flush();
        assert.equal(calls, 1, 'the burst fires the function exactly once');
    });

    test('the trailing invocation receives the most recent arguments', () => {
        const scheduler = new FakeScheduler();
        const seen: string[] = [];
        const d = debounce((label: string) => { seen.push(label); }, 50, scheduler);

        d('first');
        d('second');
        d('latest');
        scheduler.flush();
        assert.deepEqual(seen, ['latest'], 'only the last call’s args survive');
    });

    test('cancel() drops a pending invocation', () => {
        const scheduler = new FakeScheduler();
        let calls = 0;
        const d = debounce(() => { calls++; }, 50, scheduler);

        d();
        d.cancel();
        scheduler.flush();
        assert.equal(calls, 0, 'a cancelled call never fires');
        assert.equal(scheduler.pendingCount, 0, 'the timer is released on cancel');
    });

    test('separate bursts fire once each', () => {
        const scheduler = new FakeScheduler();
        let calls = 0;
        const d = debounce(() => { calls++; }, 50, scheduler);

        d();
        scheduler.flush();
        d();
        scheduler.flush();
        assert.equal(calls, 2, 'each settled burst fires independently');
    });
});
