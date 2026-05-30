/**
 * Tool-impl tests for `timed-request-tools.ts` — the 5 timed-request
 * tools.
 *
 * Strategy: in-memory `TimerEngineAccess` fake that mirrors the
 * production semantics around scheduleMode (interval vs scheduled),
 * the engine-AND-entry dual switch, and HH:MM/YYYY-MM-DD slot
 * validation. No real clock — the tool-layer doesn't fire timers
 * itself (that's `TimerEngine`'s job; tested separately).
 *
 * Coverage entry #19 four-row checklist:
 *
 *   a) Description clarity — verified in the impl file; the cron-
 *      syntax myth is explicitly denied, one-shot vs recurring
 *      spelled out for scheduled-mode, engine on/off vs entry.enabled
 *      AND-relationship documented prominently.
 *   b) Ambiguities — covered:
 *        - "cron syntax" trap: explicit "NO cron" in description
 *        - overlapping timers: documented as "engine awaits each
 *          fire's answer before scheduling next"
 *        - missed-fire: documented per-mode (interval re-schedules
 *          off last actual; scheduled slots don't catch up)
 *        - timezone: host's local TZ, documented
 *        - engine AND entry dual switch: dedicated test asserts the
 *          warning fires when one is set without the other
 *        - HH:MM and YYYY-MM-DD format validation tested
 *   c) Tests with fake engine state — no real clock needed for the
 *      tool layer (the timer engine's fire logic is its own concern).
 *   d) Timing — all 5 typical cases via `withTiming`.
 */

import test, { beforeEach, describe } from 'node:test';
import assert from 'node:assert/strict';

import { withTiming } from './_timing.js';
import {
    addTimedRequestImpl,
    listTimedRequestsImpl,
    removeTimedRequestImpl,
    setTimerEngineStateImpl,
    updateTimedRequestImpl,
    type TimedEntrySnapshot,
    type TimedScheduleSlot,
    type TimerEngineAccess,
} from '../timed-request-tools.js';

// ===========================================================================
// In-memory engine fake
// ===========================================================================

interface FakeAccess extends TimerEngineAccess {
    _entries: TimedEntrySnapshot[];
    _activated: boolean;
    _nextSeq: number;
}

function makeAccess(): FakeAccess {
    const entries: TimedEntrySnapshot[] = [];
    let activated = false;
    let nextSeq = 1;
    return {
        _entries: entries,
        get _activated() { return activated; },
        set _activated(v: boolean) { activated = v; },
        get _nextSeq() { return nextSeq; },
        set _nextSeq(v: number) { nextSeq = v; },

        entries() { return entries.map((e) => structuredClone(e)); },
        isTimerActivated() { return activated; },
        setTimerActivated(v: boolean) { activated = v; },
        getEntry(id) {
            const e = entries.find((x) => x.id === id);
            return e ? structuredClone(e) : undefined;
        },
        addEntry(spec) {
            const id = `t-${nextSeq++}`;
            const entry: TimedEntrySnapshot = { id, status: 'pending', ...spec };
            entries.push(entry);
            return structuredClone(entry);
        },
        updateEntry(id, patch) {
            const e = entries.find((x) => x.id === id);
            if (!e) { return undefined; }
            for (const [k, v] of Object.entries(patch)) {
                if (v !== undefined) {
                    (e as unknown as Record<string, unknown>)[k] = v;
                }
            }
            return structuredClone(e);
        },
        removeEntry(id) {
            const idx = entries.findIndex((x) => x.id === id);
            if (idx < 0) { return false; }
            entries.splice(idx, 1);
            return true;
        },
    };
}

let access: FakeAccess;
beforeEach(() => { access = makeAccess(); });

// ===========================================================================
// addTimedRequest
// ===========================================================================

describe('addTimedRequestImpl', () => {

    test('typical interval-mode add: defaults to interval/30min/disabled', async () => {
        const raw = await withTiming('tomAi_addTimedRequest:typical', () =>
            addTimedRequestImpl(access, { text: 'check status' }));
        const r = JSON.parse(raw);
        assert.equal(r.ok, true);
        assert.equal(r.id, 't-1');
        assert.equal(r.enabled, false, 'default enabled = false');
        assert.equal(r.scheduleMode, 'interval');
        assert.equal(r.intervalMinutes, 30);
    });

    test('intervalMinutes < 1 clamped to 1', async () => {
        const r = JSON.parse(await addTimedRequestImpl(access, {
            text: 'too fast', intervalMinutes: 0,
        }));
        assert.equal(r.intervalMinutes, 1);
    });

    test('scheduled-mode add accepts HH:MM slots — no need to call update', async () => {
        const r = JSON.parse(await addTimedRequestImpl(access, {
            text: 'daily report',
            scheduleMode: 'scheduled',
            scheduledTimes: [{ time: '09:00' }, { time: '17:00' }],
        }));
        assert.equal(r.ok, true);
        assert.equal(r.scheduleMode, 'scheduled');
        assert.deepEqual(r.scheduledTimes, [{ time: '09:00' }, { time: '17:00' }]);
        // Old impl required a second updateTimedRequest call; this is the fix.
    });

    test('scheduled-mode with `date` slot for ONE-SHOT firing', async () => {
        const r = JSON.parse(await addTimedRequestImpl(access, {
            text: 'birthday note',
            scheduleMode: 'scheduled',
            scheduledTimes: [{ time: '10:30', date: '2026-12-25' }],
        }));
        assert.equal(r.ok, true);
        assert.equal(r.scheduledTimes[0].date, '2026-12-25');
    });

    test('scheduled mode without scheduledTimes → instructive error', async () => {
        const r = JSON.parse(await addTimedRequestImpl(access, {
            text: 't', scheduleMode: 'scheduled',
        }));
        assert.match(r.error, /`scheduledTimes` is required.*HH:MM/);
    });

    test('bad HH:MM format rejected with the exact value in the error', async () => {
        const r = JSON.parse(await addTimedRequestImpl(access, {
            text: 't', scheduleMode: 'scheduled',
            scheduledTimes: [{ time: '9:00' }],   // missing leading zero
        }));
        assert.match(r.error, /24-hour HH:MM/);
        assert.match(r.error, /9:00/);
    });

    test('bad date format rejected', async () => {
        const r = JSON.parse(await addTimedRequestImpl(access, {
            text: 't', scheduleMode: 'scheduled',
            scheduledTimes: [{ time: '09:00', date: '12/25/2026' }],
        }));
        assert.match(r.error, /YYYY-MM-DD/);
        assert.match(r.error, /12\/25\/2026/);
    });

    test('THE TRAP: enabled:true while engine off → warning in response', async () => {
        // engine starts off
        const r = JSON.parse(await addTimedRequestImpl(access, {
            text: 'will-not-fire', enabled: true,
        }));
        assert.equal(r.ok, true);
        assert.match(r.warning, /global timer engine is OFF/);
        assert.match(r.warning, /tomAi_setTimerEngineState/);
    });

    test('enabled:true with engine ON → no warning', async () => {
        access._activated = true;
        const r = JSON.parse(await addTimedRequestImpl(access, {
            text: 'will-fire', enabled: true,
        }));
        assert.equal(r.warning, undefined);
    });

    test('empty text rejected', async () => {
        const r = JSON.parse(await addTimedRequestImpl(access, { text: '   ' }));
        assert.match(r.error, /`text` is required/);
    });
});

// ===========================================================================
// listTimedRequests
// ===========================================================================

describe('listTimedRequestsImpl', () => {

    test('typical call surfaces timerActivated + entry summaries', async () => {
        await addTimedRequestImpl(access, { text: 'one' });
        await addTimedRequestImpl(access, { text: 'two', scheduleMode: 'scheduled', scheduledTimes: [{ time: '12:00' }] });
        const raw = await withTiming('tomAi_listTimedRequests:typical', () =>
            listTimedRequestsImpl(access, {}));
        const r = JSON.parse(raw);
        assert.equal(r.ok, true);
        assert.equal(r.timerActivated, false);
        assert.equal(r.totalCount, 2);
        const e1 = r.entries.find((x: TimedEntrySnapshot) => x.id === 't-1')!;
        assert.equal(e1.scheduleMode, 'interval');
        const e2 = r.entries.find((x: TimedEntrySnapshot) => x.id === 't-2')!;
        assert.equal(e2.scheduleMode, 'scheduled');
        assert.deepEqual(e2.scheduledTimes, [{ time: '12:00' }]);
    });

    test('completed entries excluded by default; includeCompleted: true surfaces them', async () => {
        await addTimedRequestImpl(access, { text: 'a' });
        await addTimedRequestImpl(access, { text: 'b' });
        // Mark t-2 completed
        access._entries.find((e) => e.id === 't-2')!.status = 'completed';
        const defaultList = JSON.parse(await listTimedRequestsImpl(access, {}));
        assert.equal(defaultList.totalCount, 1);
        const fullList = JSON.parse(await listTimedRequestsImpl(access, { includeCompleted: true }));
        assert.equal(fullList.totalCount, 2);
    });

    test('engine state reflected in response', async () => {
        access._activated = true;
        const r = JSON.parse(await listTimedRequestsImpl(access, {}));
        assert.equal(r.timerActivated, true);
    });
});

// ===========================================================================
// updateTimedRequest
// ===========================================================================

describe('updateTimedRequestImpl', () => {

    test('typical update: enable an entry + change interval', async () => {
        const added = JSON.parse(await addTimedRequestImpl(access, { text: 'x', intervalMinutes: 60 }));
        access._activated = true;
        const raw = await withTiming('tomAi_updateTimedRequest:typical', () =>
            updateTimedRequestImpl(access, {
                entryId: added.id,
                patch: { enabled: true, intervalMinutes: 15 },
            }));
        const r = JSON.parse(raw);
        assert.equal(r.ok, true);
        assert.equal(r.enabled, true);
        // No warning because engine is on
        assert.equal(r.warning, undefined);
        // Stored values match
        const stored = access._entries.find((e) => e.id === added.id)!;
        assert.equal(stored.intervalMinutes, 15);
    });

    test('mode switch: interval → scheduled with HH:MM slots', async () => {
        const added = JSON.parse(await addTimedRequestImpl(access, { text: 'x' }));
        const r = JSON.parse(await updateTimedRequestImpl(access, {
            entryId: added.id,
            patch: {
                scheduleMode: 'scheduled',
                scheduledTimes: [{ time: '08:00' }, { time: '20:00' }],
            },
        }));
        assert.equal(r.ok, true);
        assert.equal(r.scheduleMode, 'scheduled');
        const stored = access._entries.find((e) => e.id === added.id)!;
        assert.deepEqual(stored.scheduledTimes, [{ time: '08:00' }, { time: '20:00' }]);
    });

    test('engine-AND-entry warning fires when enabling while engine off', async () => {
        const added = JSON.parse(await addTimedRequestImpl(access, { text: 'x' }));
        const r = JSON.parse(await updateTimedRequestImpl(access, {
            entryId: added.id,
            patch: { enabled: true },
        }));
        assert.equal(r.enabled, true);
        assert.match(r.warning, /global timer engine is OFF/);
    });

    test('invalid scheduledTimes patch rejected', async () => {
        const added = JSON.parse(await addTimedRequestImpl(access, { text: 'x' }));
        const r = JSON.parse(await updateTimedRequestImpl(access, {
            entryId: added.id,
            patch: { scheduledTimes: [{ time: '25:00' }] },   // hour > 23
        }));
        assert.match(r.error, /24-hour HH:MM/);
    });

    test('unknown entryId returns structured error', async () => {
        const r = JSON.parse(await updateTimedRequestImpl(access, {
            entryId: 't-nope', patch: { enabled: true },
        }));
        assert.match(r.error, /not found.*tomAi_listTimedRequests/);
    });

    test('missing fields rejected', async () => {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const r = JSON.parse(await updateTimedRequestImpl(access, { entryId: 't-1' } as any));
        assert.match(r.error, /`entryId` and `patch` are both required/);
    });
});

// ===========================================================================
// removeTimedRequest
// ===========================================================================

describe('removeTimedRequestImpl', () => {

    test('typical remove drops the entry', async () => {
        const added = JSON.parse(await addTimedRequestImpl(access, { text: 'x' }));
        const raw = await withTiming('tomAi_removeTimedRequest:typical', () =>
            removeTimedRequestImpl(access, { entryId: added.id }));
        const r = JSON.parse(raw);
        assert.equal(r.ok, true);
        assert.equal(r.deletedId, added.id);
        assert.equal(r.existed, true);
        assert.equal(access._entries.length, 0);
    });

    test('removing unknown entryId is idempotent; existed: false reports the no-op', async () => {
        const r = JSON.parse(await removeTimedRequestImpl(access, { entryId: 't-nope' }));
        assert.equal(r.ok, true);
        assert.equal(r.existed, false);
    });

    test('missing entryId returns instructive error', async () => {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const r = JSON.parse(await removeTimedRequestImpl(access, {} as any));
        assert.match(r.error, /`entryId` is required/);
    });
});

// ===========================================================================
// setTimerEngineState — THE engine on/off switch
// ===========================================================================

describe('setTimerEngineStateImpl', () => {

    test('typical activate: surfaces previous state + enabled-entry count + note', async () => {
        await addTimedRequestImpl(access, { text: 'a', enabled: true });
        await addTimedRequestImpl(access, { text: 'b', enabled: false });
        const raw = await withTiming('tomAi_setTimerEngineState:typical', () =>
            setTimerEngineStateImpl(access, { activated: true }));
        const r = JSON.parse(raw);
        assert.equal(r.ok, true);
        assert.equal(r.timerActivated, true);
        assert.equal(r.wasPreviously, false);
        assert.equal(r.enabledEntries, 1, 'only entry a is enabled; b is not');
        assert.match(r.note, /1 entry.*will now fire/);
    });

    test('idempotent activate: same value → wasPreviously matches new', async () => {
        access._activated = true;
        const r = JSON.parse(await setTimerEngineStateImpl(access, { activated: true }));
        assert.equal(r.timerActivated, true);
        assert.equal(r.wasPreviously, true);
    });

    test('deactivate carries pause note', async () => {
        access._activated = true;
        await addTimedRequestImpl(access, { text: 'a', enabled: true });
        const r = JSON.parse(await setTimerEngineStateImpl(access, { activated: false }));
        assert.equal(r.timerActivated, false);
        assert.match(r.note, /All entries paused/);
    });

    test('non-boolean activated rejected', async () => {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const r = JSON.parse(await setTimerEngineStateImpl(access, { activated: 'on' as any }));
        assert.match(r.error, /`activated` \(boolean\) is required/);
    });
});

// ===========================================================================
// Engine-AND-entry round-trip (the dual-switch trap)
// ===========================================================================

describe('engine-AND-entry dual switch', () => {

    test('entry fires only when BOTH engine.activated AND entry.enabled are true', async () => {
        // 1. Add an entry, both switches off
        const added = JSON.parse(await addTimedRequestImpl(access, { text: 'x' }));
        let state = JSON.parse(await listTimedRequestsImpl(access, {}));
        assert.equal(state.timerActivated, false);
        assert.equal(state.entries[0].enabled, false);

        // 2. Enable just the entry → warning surfaces
        const updateR = JSON.parse(await updateTimedRequestImpl(access, {
            entryId: added.id, patch: { enabled: true },
        }));
        assert.match(updateR.warning, /global timer engine is OFF/);

        // 3. Activate the engine → list shows BOTH on, no warning
        const engineR = JSON.parse(await setTimerEngineStateImpl(access, { activated: true }));
        assert.equal(engineR.enabledEntries, 1);
        state = JSON.parse(await listTimedRequestsImpl(access, {}));
        assert.equal(state.timerActivated, true);
        assert.equal(state.entries[0].enabled, true);

        // 4. Disable the entry → engine still on but this entry sleeps
        await updateTimedRequestImpl(access, { entryId: added.id, patch: { enabled: false } });
        state = JSON.parse(await listTimedRequestsImpl(access, {}));
        assert.equal(state.timerActivated, true);
        assert.equal(state.entries[0].enabled, false);
    });
});
