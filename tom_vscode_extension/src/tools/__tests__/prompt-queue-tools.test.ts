/**
 * Tool-impl tests for `prompt-queue-tools.ts` — the 14 queue tools.
 *
 * Strategy: an in-memory `PromptQueueAccess` fake that mirrors the
 * production semantics around id generation (`q-N` monotonic),
 * status transitions, pre-prompt/follow-up array ordering, and the
 * `sendQueuedPrompt` vs `sendNow` vs `resendLastPrompt` distinction.
 *
 * Coverage entry #18 four-row checklist:
 *
 *   a) Description clarity — verified in the impl file; the
 *      conceptual model (pre/main/follow-ups), status enum, transport
 *      routing, and the **sendQueueItem vs sendQueuedPrompt** split
 *      are all documented up front.
 *   b) Ambiguities — covered:
 *        - id resolution (queueItemId vs requestId — both work, with
 *          queueItemId preferred)
 *        - status enum (5 values: staged / pending / sending / sent /
 *          error; only staged↔pending settable manually)
 *        - resendQueueItem semantics (reuses id, replays last stage,
 *          NOT a new item)
 *        - sendQueueItem (one stage now) vs sendQueuedPrompt
 *          (manager-managed full lifecycle)
 *        - transport defaults + per-stage overrides
 *   c) Round-trip every operation against the in-memory fake.
 *   d) Timing — every tool gets a `withTiming('tomAi_*:typical', …)`
 *      assertion for audit coverage.
 */

import test, { beforeEach, describe } from 'node:test';
import assert from 'node:assert/strict';

import { withTiming } from './_timing.js';
import {
    addQueueFollowUpImpl,
    addQueueItemImpl,
    addQueuePrePromptImpl,
    listQueueImpl,
    removeQueueFollowUpImpl,
    removeQueueItemImpl,
    removeQueuePrePromptImpl,
    resendQueueItemImpl,
    sendQueueItemImpl,
    sendQueuedPromptImpl,
    setQueueItemStatusImpl,
    updateQueueFollowUpImpl,
    updateQueueItemImpl,
    updateQueuePrePromptImpl,
    type EnqueueInput,
    type FollowUpItem,
    type FollowUpSpec,
    type PrePromptSpec,
    type PromptQueueAccess,
    type QueueItemSnapshot,
} from '../prompt-queue-tools.js';

// ===========================================================================
// In-memory fake
// ===========================================================================

interface FakeAccess extends PromptQueueAccess {
    _items: QueueItemSnapshot[];
    _nextSeq: number;
    _nextFollowUpSeq: number;
    _autoSendEnabled: boolean;
    _responseFileTimeoutMinutes: number;
}

function makeAccess(): FakeAccess {
    const items: QueueItemSnapshot[] = [];
    let nextSeq = 1;
    let nextFollowUpSeq = 1;
    let autoSendEnabled = true;
    const access: FakeAccess = {
        _items: items,
        get _nextSeq() { return nextSeq; },
        set _nextSeq(v: number) { nextSeq = v; },
        get _nextFollowUpSeq() { return nextFollowUpSeq; },
        set _nextFollowUpSeq(v: number) { nextFollowUpSeq = v; },
        get _autoSendEnabled() { return autoSendEnabled; },
        set _autoSendEnabled(v: boolean) { autoSendEnabled = v; },
        _responseFileTimeoutMinutes: 5,

        items() { return items.map((i) => structuredClone(i)); },
        autoSendEnabled() { return autoSendEnabled; },
        responseFileTimeoutMinutes() { return access._responseFileTimeoutMinutes; },
        pendingCount() { return items.filter((i) => i.status === 'pending').length; },

        getById(id) {
            const i = items.find((x) => x.id === id);
            return i ? structuredClone(i) : undefined;
        },
        getByRequestId(requestId) {
            const i = items.find((x) => x.requestId === requestId);
            return i ? structuredClone(i) : undefined;
        },

        async enqueue(input: EnqueueInput): Promise<QueueItemSnapshot> {
            const id = `q-${nextSeq++}`;
            const item: QueueItemSnapshot = {
                id,
                status: input.deferSend === false ? 'pending' : 'staged',
                originalText: input.originalText,
                template: input.template,
                answerWrapper: input.answerWrapper,
                createdAt: Date.now(),
                repeatCount: input.repeatCount,
                repeatPrefix: input.repeatPrefix,
                repeatSuffix: input.repeatSuffix,
                templateRepeatCount: input.templateRepeatCount,
                answerWaitMinutes: input.answerWaitMinutes,
                reminderEnabled: input.reminderEnabled,
                reminderTemplateId: input.reminderTemplateId,
                reminderTimeoutMinutes: input.reminderTimeoutMinutes,
                reminderRepeat: input.reminderRepeat,
                transport: input.transport ?? 'copilot',
                anthropicProfileId: input.anthropicProfileId,
                anthropicConfigId: input.anthropicConfigId,
                prePrompts: (input.prePrompts ?? []).map((p) => ({ ...p })),
                followUps: (input.followUps ?? []).map((f) => ({
                    ...f,
                    id: `f-${nextFollowUpSeq++}`,
                })),
                followUpIndex: 0,
            };
            const position = typeof input.position === 'number' && input.position >= 0 ? input.position : items.length;
            items.splice(position, 0, item);
            return structuredClone(item);
        },

        remove(id) {
            const idx = items.findIndex((i) => i.id === id);
            if (idx >= 0) { items.splice(idx, 1); }
        },

        setStatus(id, status) {
            const i = items.find((x) => x.id === id);
            if (!i || (i.status !== 'staged' && i.status !== 'pending')) { return false; }
            i.status = status;
            return true;
        },

        async updateText(id, text) {
            const i = items.find((x) => x.id === id);
            if (i) { i.originalText = text; }
        },
        async updateItemTemplateAndWrapper(id, opts) {
            const i = items.find((x) => x.id === id);
            if (!i) { return; }
            if (opts.template !== undefined) { i.template = opts.template; }
            if (opts.answerWrapper !== undefined) { i.answerWrapper = opts.answerWrapper; }
        },
        updateItemReminder(id, opts) {
            const i = items.find((x) => x.id === id);
            if (!i) { return; }
            if (opts.reminderEnabled !== undefined) { i.reminderEnabled = opts.reminderEnabled; }
            if (opts.reminderTemplateId !== undefined) { i.reminderTemplateId = opts.reminderTemplateId; }
            if (opts.reminderTimeoutMinutes !== undefined) { i.reminderTimeoutMinutes = opts.reminderTimeoutMinutes; }
            if (opts.reminderRepeat !== undefined) { i.reminderRepeat = opts.reminderRepeat; }
        },
        updateItemRepetition(id, opts) {
            const i = items.find((x) => x.id === id);
            if (!i) { return; }
            if (opts.repeatCount !== undefined) { i.repeatCount = opts.repeatCount; }
            if (opts.repeatPrefix !== undefined) { i.repeatPrefix = opts.repeatPrefix; }
            if (opts.repeatSuffix !== undefined) { i.repeatSuffix = opts.repeatSuffix; }
            if (opts.templateRepeatCount !== undefined) { i.templateRepeatCount = opts.templateRepeatCount; }
            if (opts.answerWaitMinutes !== undefined) { i.answerWaitMinutes = opts.answerWaitMinutes; }
        },
        updateItemTransport(id, opts) {
            const i = items.find((x) => x.id === id);
            if (!i) { return; }
            if (opts.transport !== undefined) { i.transport = opts.transport; }
            if (opts.anthropicProfileId !== undefined) { i.anthropicProfileId = opts.anthropicProfileId; }
            if (opts.anthropicConfigId !== undefined) { i.anthropicConfigId = opts.anthropicConfigId; }
        },

        addPrePrompt(id, text, template, opts) {
            const i = items.find((x) => x.id === id);
            if (!i || (i.status !== 'staged' && i.status !== 'pending')) { return false; }
            if (!i.prePrompts) { i.prePrompts = []; }
            i.prePrompts.push({ text, template, ...(opts ?? {}) });
            return true;
        },
        updatePrePrompt(id, index, opts) {
            const i = items.find((x) => x.id === id);
            if (!i || !i.prePrompts || index < 0 || index >= i.prePrompts.length) { return false; }
            if (i.status !== 'staged' && i.status !== 'pending') { return false; }
            const pp = i.prePrompts[index] as PrePromptSpec;
            for (const [k, v] of Object.entries(opts)) {
                if (v !== undefined) { (pp as unknown as Record<string, unknown>)[k] = v; }
            }
            return true;
        },
        removePrePrompt(id, index) {
            const i = items.find((x) => x.id === id);
            if (!i || !i.prePrompts || index < 0 || index >= i.prePrompts.length) { return false; }
            i.prePrompts.splice(index, 1);
            return true;
        },

        addFollowUpPrompt(id, opts) {
            const i = items.find((x) => x.id === id);
            if (!i) { return undefined; }
            if (!i.followUps) { i.followUps = []; }
            const follow: FollowUpItem = {
                id: `f-${nextFollowUpSeq++}`,
                ...(opts as Omit<FollowUpSpec, 'repeatCount' | 'answerWaitMinutes'>),
            } as FollowUpItem;
            i.followUps.push(follow);
            return structuredClone(follow);
        },
        updateFollowUpPrompt(id, fuId, opts) {
            const i = items.find((x) => x.id === id);
            if (!i || !i.followUps) { return false; }
            const fu = i.followUps.find((f) => f.id === fuId);
            if (!fu) { return false; }
            for (const [k, v] of Object.entries(opts)) {
                if (v !== undefined) { (fu as unknown as Record<string, unknown>)[k] = v; }
            }
            return true;
        },
        removeFollowUpPrompt(id, fuId) {
            const i = items.find((x) => x.id === id);
            if (!i || !i.followUps) { return false; }
            const idx = i.followUps.findIndex((f) => f.id === fuId);
            if (idx < 0) { return false; }
            i.followUps.splice(idx, 1);
            return true;
        },

        async sendQueuedPrompt(selector) {
            // Match by id first (preferred), then by requestId, then any pending
            let i: QueueItemSnapshot | undefined;
            if (selector.id) {
                i = items.find((x) => x.id === selector.id && (x.status === 'staged' || x.status === 'pending'));
            } else if (selector.requestId) {
                i = items.find((x) => x.requestId === selector.requestId && (x.status === 'staged' || x.status === 'pending'));
            } else {
                i = items.find((x) => x.status === 'pending');
            }
            if (!i) { return null; }
            // Manager-managed lifecycle entry: mark sending, generate requestId
            i.status = 'sending';
            i.requestId = `req-${Math.floor(Math.random() * 1e9)}`;
            return structuredClone(i);
        },
        async sendNow(id) {
            const i = items.find((x) => x.id === id);
            if (!i) { return; }
            // Immediate dispatch: mark sending → sent, record lastDispatched
            i.status = 'sending';
            i.lastDispatched = `main:${i.originalText}`;
            i.status = 'sent';
            i.sentAt = Date.now();
            i.answerText = `answer to ${i.originalText}`;
        },
        async resendLastPrompt(id) {
            const i = items.find((x) => x.id === id);
            if (!i) { return; }
            if (!i.lastDispatched) {
                throw new Error('No lastDispatched recorded — item has never been sent.');
            }
            // Re-runs the previous stage WITHOUT changing repeat counters
            i.status = 'sending';
            // Simulate the resend completing
            i.status = 'sent';
        },
    };
    return access;
}

let access: FakeAccess;
beforeEach(() => { access = makeAccess(); });

// ===========================================================================
// Add / list
// ===========================================================================

describe('addQueueItemImpl + listQueueImpl', () => {

    test('typical add: stages an item (deferSend default true), listQueue surfaces it', async () => {
        const addRaw = await withTiming('tomAi_addQueueItem:typical', () =>
            addQueueItemImpl(access, { text: 'do the thing' }));
        const addR = JSON.parse(addRaw);
        assert.equal(addR.ok, true);
        assert.equal(addR.id, 'q-1');
        assert.equal(addR.status, 'staged');
        assert.equal(addR.queueLength, 1);

        const listRaw = await withTiming('tomAi_listQueue:typical', () =>
            listQueueImpl(access, {}));
        const listR = JSON.parse(listRaw);
        assert.equal(listR.ok, true);
        assert.equal(listR.totalCount, 1);
        assert.equal(listR.items[0].id, 'q-1');
        assert.equal(listR.items[0].status, 'staged');
        assert.equal(listR.items[0].transport, 'copilot');
    });

    test('add with deferSend: false → pending; pendingCount reflects it', async () => {
        await addQueueItemImpl(access, { text: 'pending now', deferSend: false });
        const list = JSON.parse(await listQueueImpl(access, {}));
        assert.equal(list.pendingCount, 1);
        assert.equal(list.items[0].status, 'pending');
    });

    test('listQueue excludes sent items by default; includeSent surfaces them', async () => {
        const added = JSON.parse(await addQueueItemImpl(access, { text: 'a' }));
        await sendQueueItemImpl(access, { queueItemId: added.id });
        const defaultList = JSON.parse(await listQueueImpl(access, {}));
        assert.equal(defaultList.totalCount, 0, 'sent items hidden by default');
        const fullList = JSON.parse(await listQueueImpl(access, { includeSent: true }));
        assert.equal(fullList.totalCount, 1);
        assert.equal(fullList.items[0].status, 'sent');
    });

    test('add with prePrompts + followUps in one call', async () => {
        const r = JSON.parse(await addQueueItemImpl(access, {
            text: 'main',
            prePrompts: [{ text: 'setup A' }, { text: 'setup B' }],
            followUps: [{ text: 'follow 1' }, { text: 'follow 2' }],
        }));
        assert.equal(r.prePromptCount, 2);
        assert.equal(r.followUpCount, 2);
    });

    test('add with transport: anthropic propagates the routing fields', async () => {
        const r = JSON.parse(await addQueueItemImpl(access, {
            text: 'remote', transport: 'anthropic', anthropicProfileId: 'p1', anthropicConfigId: 'c1',
        }));
        const item = access._items.find((i) => i.id === r.id)!;
        assert.equal(item.transport, 'anthropic');
        assert.equal(item.anthropicProfileId, 'p1');
        assert.equal(item.anthropicConfigId, 'c1');
    });

    test('empty text → instructive error, no item added', async () => {
        const r = JSON.parse(await addQueueItemImpl(access, { text: '   ' }));
        assert.match(r.error, /`text` is required/);
        assert.equal(access._items.length, 0);
    });
});

// ===========================================================================
// sendQueuedPrompt vs sendQueueItem vs resendQueueItem (b-row trap)
// ===========================================================================

describe('send variants — the key distinction', () => {

    test('sendQueuedPrompt → manager run loop (status: sending, requestId stamped)', async () => {
        const added = JSON.parse(await addQueueItemImpl(access, { text: 'lifecycle', deferSend: false }));
        const raw = await withTiming('tomAi_sendQueuedPrompt:typical', () =>
            sendQueuedPromptImpl(access, { queueItemId: added.id }));
        const r = JSON.parse(raw);
        assert.equal(r.ok, true);
        assert.equal(r.id, 'q-1');
        assert.equal(r.status, 'sending', 'manager run-loop entry → status sending');
        assert.match(r.requestId, /^req-/, 'requestId is stamped on lifecycle entry');
    });

    test('sendQueueItem → immediate dispatch (status: sent, no run-loop chain)', async () => {
        const added = JSON.parse(await addQueueItemImpl(access, { text: 'now please' }));
        const raw = await withTiming('tomAi_sendQueueItem:typical', () =>
            sendQueueItemImpl(access, { queueItemId: added.id }));
        const r = JSON.parse(raw);
        assert.equal(r.ok, true);
        assert.equal(r.status, 'sent', 'immediate dispatch completes synchronously in the fake');
        assert.equal(r.transport, 'copilot');
    });

    test('SENDQUEUEDPROMPT vs SENDQUEUEITEM both target same item — different transitions', async () => {
        const a = JSON.parse(await addQueueItemImpl(access, { text: 'a', deferSend: false }));
        const b = JSON.parse(await addQueueItemImpl(access, { text: 'b' }));
        // a → sendQueuedPrompt → sending (run loop took it)
        const rA = JSON.parse(await sendQueuedPromptImpl(access, { queueItemId: a.id }));
        assert.equal(rA.status, 'sending');
        // b → sendQueueItem → sent (immediate)
        const rB = JSON.parse(await sendQueueItemImpl(access, { queueItemId: b.id }));
        assert.equal(rB.status, 'sent');
    });

    test('sendQueuedPrompt no-match → error pointing at how to select', async () => {
        const r = JSON.parse(await sendQueuedPromptImpl(access, { queueItemId: 'q-nope' }));
        assert.match(r.error, /No pending queued prompt matched/);
        assert.match(r.error, /queueItemId.*preferred/);
    });

    test('sendQueuedPrompt by requestId (alternative selector)', async () => {
        const a = JSON.parse(await addQueueItemImpl(access, { text: 'x', deferSend: false }));
        // Stamp a requestId so the requestId selector matches
        access._items.find((i) => i.id === a.id)!.requestId = 'rid-1';
        const r = JSON.parse(await sendQueuedPromptImpl(access, { requestId: 'rid-1' }));
        assert.equal(r.ok, true);
    });

    test('resendQueueItem REUSES the same id, replays last stage', async () => {
        const added = JSON.parse(await addQueueItemImpl(access, { text: 'send and resend' }));
        await sendQueueItemImpl(access, { queueItemId: added.id });
        const raw = await withTiming('tomAi_resendQueueItem:typical', () =>
            resendQueueItemImpl(access, { queueItemId: added.id }));
        const r = JSON.parse(raw);
        assert.equal(r.ok, true);
        assert.equal(r.id, added.id, 'resend reuses the SAME id (not a new item)');
        assert.match(r.lastDispatched, /^main:/);
        // Still just ONE item in the queue (resend ≠ add new)
        assert.equal(access._items.length, 1);
    });

    test('resendQueueItem on never-sent item surfaces the underlying error', async () => {
        const added = JSON.parse(await addQueueItemImpl(access, { text: 'unsent' }));
        const r = JSON.parse(await resendQueueItemImpl(access, { queueItemId: added.id }));
        assert.match(r.error, /No lastDispatched/);
    });
});

// ===========================================================================
// setQueueItemStatus
// ===========================================================================

describe('setQueueItemStatusImpl', () => {

    test('staged → pending and back', async () => {
        const added = JSON.parse(await addQueueItemImpl(access, { text: 'x' }));
        const r1 = JSON.parse(await withTiming('tomAi_setQueueItemStatus:typical', () =>
            setQueueItemStatusImpl(access, { queueItemId: added.id, status: 'pending' })));
        assert.equal(r1.ok, true);
        assert.equal(access._items[0].status, 'pending');
        await setQueueItemStatusImpl(access, { queueItemId: added.id, status: 'staged' });
        assert.equal(access._items[0].status, 'staged');
    });

    test('cannot set status on a sent item (state machine refusal)', async () => {
        const added = JSON.parse(await addQueueItemImpl(access, { text: 'x' }));
        await sendQueueItemImpl(access, { queueItemId: added.id });
        const r = JSON.parse(await setQueueItemStatusImpl(access, { queueItemId: added.id, status: 'staged' }));
        assert.match(r.error, /Unable to set status/);
    });

    test('missing fields rejected', async () => {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const r = JSON.parse(await setQueueItemStatusImpl(access, {} as any));
        assert.match(r.error, /`queueItemId` and `status` are both required/);
    });
});

// ===========================================================================
// updateQueueItem
// ===========================================================================

describe('updateQueueItemImpl', () => {

    test('typical update: text + template + reminder + repeat + transport in one call', async () => {
        const added = JSON.parse(await addQueueItemImpl(access, { text: 'original' }));
        const raw = await withTiming('tomAi_updateQueueItem:typical', () =>
            updateQueueItemImpl(access, {
                queueItemId: added.id,
                text: 'updated',
                template: 'mytemplate',
                answerWrapper: true,
                reminderEnabled: true,
                reminderTemplateId: 'rmd-1',
                repeatCount: 3,
                repeatPrefix: 'P',
                repeatSuffix: 'S',
                answerWaitMinutes: 5,
                transport: 'anthropic',
                anthropicProfileId: 'p1',
            }));
        const r = JSON.parse(raw);
        assert.equal(r.ok, true);
        const stored = access._items.find((i) => i.id === added.id)!;
        assert.equal(stored.originalText, 'updated');
        assert.equal(stored.template, 'mytemplate');
        assert.equal(stored.answerWrapper, true);
        assert.equal(stored.repeatCount, 3);
        assert.equal(stored.transport, 'anthropic');
    });

    test('unknown id → structured error', async () => {
        const r = JSON.parse(await updateQueueItemImpl(access, { queueItemId: 'q-nope', text: 'x' }));
        assert.match(r.error, /not found/);
    });
});

// ===========================================================================
// removeQueueItem
// ===========================================================================

describe('removeQueueItemImpl', () => {

    test('typical remove drops the item from the queue', async () => {
        const added = JSON.parse(await addQueueItemImpl(access, { text: 'gone' }));
        const raw = await withTiming('tomAi_removeQueueItem:typical', () =>
            removeQueueItemImpl(access, { queueItemId: added.id }));
        const r = JSON.parse(raw);
        assert.equal(r.ok, true);
        assert.equal(r.deletedId, added.id);
        assert.equal(access._items.length, 0);
    });

    test('remove of unknown id is idempotent (no error)', async () => {
        const r = JSON.parse(await removeQueueItemImpl(access, { queueItemId: 'q-nope' }));
        assert.equal(r.ok, true);
    });

    test('missing field → instructive error', async () => {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const r = JSON.parse(await removeQueueItemImpl(access, {} as any));
        assert.match(r.error, /`queueItemId` is required/);
    });
});

// ===========================================================================
// Pre-prompt suite (add / update / remove)
// ===========================================================================

describe('pre-prompt tools', () => {

    test('add → update by index → remove — round-trip', async () => {
        const added = JSON.parse(await addQueueItemImpl(access, { text: 'main' }));

        // add
        const addRaw = await withTiming('tomAi_addQueuePrePrompt:typical', () =>
            addQueuePrePromptImpl(access, { queueItemId: added.id, text: 'setup', template: 'tmpl' }));
        let r = JSON.parse(addRaw);
        assert.equal(r.ok, true);
        assert.equal(r.prePromptCount, 1);

        // update by index 0
        const updRaw = await withTiming('tomAi_updateQueuePrePrompt:typical', () =>
            updateQueuePrePromptImpl(access, {
                queueItemId: added.id, index: 0,
                text: 'updated setup', repeatCount: 2, answerWaitMinutes: 3,
            }));
        r = JSON.parse(updRaw);
        assert.equal(r.ok, true);
        const stored = access._items[0].prePrompts![0] as PrePromptSpec;
        assert.equal(stored.text, 'updated setup');
        assert.equal(stored.repeatCount, 2);
        assert.equal(stored.answerWaitMinutes, 3);

        // remove
        const rmRaw = await withTiming('tomAi_removeQueuePrePrompt:typical', () =>
            removeQueuePrePromptImpl(access, { queueItemId: added.id, index: 0 }));
        r = JSON.parse(rmRaw);
        assert.equal(r.ok, true);
        assert.equal(access._items[0].prePrompts!.length, 0);
    });

    test('update out-of-range index rejected', async () => {
        const added = JSON.parse(await addQueueItemImpl(access, { text: 'main' }));
        await addQueuePrePromptImpl(access, { queueItemId: added.id, text: 'only' });
        const r = JSON.parse(await updateQueuePrePromptImpl(access, {
            queueItemId: added.id, index: 99, text: 'x',
        }));
        assert.match(r.error, /Could not update pre-prompt/);
    });

    test('add on unknown item rejected', async () => {
        const r = JSON.parse(await addQueuePrePromptImpl(access, { queueItemId: 'q-nope', text: 'x' }));
        assert.match(r.error, /Could not add pre-prompt/);
    });
});

// ===========================================================================
// Follow-up suite (add / update / remove)
// ===========================================================================

describe('follow-up tools', () => {

    test('add → update by id → remove — round-trip (id-based, not index)', async () => {
        const added = JSON.parse(await addQueueItemImpl(access, { text: 'main' }));

        // add — note that the manager uses `repeatCount`/`answerWaitMinutes` via internal updateFollowUp call
        const addRaw = await withTiming('tomAi_addQueueFollowUp:typical', () =>
            addQueueFollowUpImpl(access, {
                queueItemId: added.id,
                text: 'follow-1',
                repeatCount: 2,
                answerWaitMinutes: 4,
            }));
        let r = JSON.parse(addRaw);
        assert.equal(r.ok, true);
        const fuId = r.followUpId;
        assert.match(fuId, /^f-/);
        const storedFu = access._items[0].followUps![0] as FollowUpItem;
        // updateFollowUp was called internally so repeatCount + answerWaitMinutes are present
        assert.equal((storedFu as unknown as { repeatCount: number }).repeatCount, 2);
        assert.equal((storedFu as unknown as { answerWaitMinutes: number }).answerWaitMinutes, 4);

        // update by id (not index)
        const updRaw = await withTiming('tomAi_updateQueueFollowUp:typical', () =>
            updateQueueFollowUpImpl(access, {
                queueItemId: added.id, followUpId: fuId,
                text: 'follow-1-updated', repeatCount: 5,
            }));
        r = JSON.parse(updRaw);
        assert.equal(r.ok, true);
        assert.equal((storedFu as unknown as { originalText: string }).originalText, 'follow-1-updated');
        assert.equal((storedFu as unknown as { repeatCount: number }).repeatCount, 5);

        // remove
        const rmRaw = await withTiming('tomAi_removeQueueFollowUp:typical', () =>
            removeQueueFollowUpImpl(access, { queueItemId: added.id, followUpId: fuId }));
        r = JSON.parse(rmRaw);
        assert.equal(r.ok, true);
        assert.equal(access._items[0].followUps!.length, 0);
    });

    test('add by requestId (alternative selector to queueItemId)', async () => {
        const added = JSON.parse(await addQueueItemImpl(access, { text: 'x' }));
        access._items[0].requestId = 'rid-42';
        const r = JSON.parse(await addQueueFollowUpImpl(access, {
            requestId: 'rid-42', text: 'follow-via-requestId',
        }));
        assert.equal(r.ok, true);
        assert.equal(r.queueItemId, added.id);
    });

    test('add with no item-matching selector → error', async () => {
        const r = JSON.parse(await addQueueFollowUpImpl(access, {
            queueItemId: 'q-nope', text: 'x',
        }));
        assert.match(r.error, /Queue item not found/);
    });

    test('update of unknown follow-up id → error', async () => {
        const added = JSON.parse(await addQueueItemImpl(access, { text: 'x' }));
        const r = JSON.parse(await updateQueueFollowUpImpl(access, {
            queueItemId: added.id, followUpId: 'f-nope', text: 'y',
        }));
        assert.match(r.error, /not found/);
    });

    test('remove of unknown follow-up id → error', async () => {
        const added = JSON.parse(await addQueueItemImpl(access, { text: 'x' }));
        const r = JSON.parse(await removeQueueFollowUpImpl(access, {
            queueItemId: added.id, followUpId: 'f-nope',
        }));
        assert.match(r.error, /not found/);
    });
});

// ===========================================================================
// Full canonical workflow — add → addFollowUp → sendQueuedPrompt
// ===========================================================================

describe('canonical workflow', () => {

    test('add (staged) → addFollowUp ×2 → sendQueuedPrompt walks the lifecycle', async () => {
        // 1. add staged main
        const added = JSON.parse(await addQueueItemImpl(access, { text: 'main' }));
        assert.equal(added.status, 'staged');

        // 2. addFollowUp ×2
        const f1 = JSON.parse(await addQueueFollowUpImpl(access, {
            queueItemId: added.id, text: 'follow-1',
        }));
        const f2 = JSON.parse(await addQueueFollowUpImpl(access, {
            queueItemId: added.id, text: 'follow-2',
        }));
        assert.equal(f1.followUpCount, 1);
        assert.equal(f2.followUpCount, 2);

        // 3. listQueue confirms 1 staged item with 2 follow-ups, transport: copilot
        const list = JSON.parse(await listQueueImpl(access, {}));
        assert.equal(list.totalCount, 1);
        assert.equal(list.items[0].status, 'staged');
        assert.equal(list.items[0].followUpCount, 2);

        // 4. setQueueItemStatus → pending
        await setQueueItemStatusImpl(access, { queueItemId: added.id, status: 'pending' });

        // 5. sendQueuedPrompt hands to the run loop
        const sentR = JSON.parse(await sendQueuedPromptImpl(access, { queueItemId: added.id }));
        assert.equal(sentR.ok, true);
        assert.equal(sentR.status, 'sending');
        assert.equal(sentR.followUpCount, 2);
    });
});
