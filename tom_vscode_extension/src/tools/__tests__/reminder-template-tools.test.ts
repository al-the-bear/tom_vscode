/**
 * Tool-impl tests for `reminder-template-tools.ts` — the 4
 * `tomAi_*ReminderTemplate` tools.
 *
 * Strategy: in-memory `ReminderTemplateStore` fake mirroring the
 * production semantics — `add` generates a uuid-ish id, `update`
 * flips `isDefault` off on every other entry when set to true,
 * `delete` returns `{existed, promotedDefault}` so the caller can
 * see auto-promotion when the default is removed.
 *
 * Coverage entry #21 four-row checklist:
 *
 *   a) Description clarity — verified in the impl file; when
 *      reminders fire (5-min default timeout, 30 s poll), who they
 *      target (the chat panel the original prompt was dispatched
 *      to), and the mustache `{{token}}` syntax are all spelled
 *      out.
 *   b) Ambiguities — covered:
 *        - name-collision rejection on create (was silently allowed)
 *        - not-found errors on update/delete (was silent no-op
 *          returning `template: null`)
 *        - default auto-promotion on delete (was undocumented)
 *        - placeholder syntax: `{{token}}` not `${token}` (the
 *          mustache-vs-canonical trap)
 *   c) Same shape as entry #20 (in-memory fake + round-trip).
 *   d) Timing — all 4 typical cases via `withTiming`.
 */

import test, { beforeEach, describe } from 'node:test';
import assert from 'node:assert/strict';

import { withTiming } from './_timing.js';
import {
    createReminderTemplateImpl,
    deleteReminderTemplateImpl,
    listReminderTemplatesImpl,
    updateReminderTemplateImpl,
    type ReminderTemplateEntry,
    type ReminderTemplateStore,
} from '../reminder-template-tools.js';

// ===========================================================================
// In-memory store fake
// ===========================================================================

interface FakeStore extends ReminderTemplateStore {
    _entries: ReminderTemplateEntry[];
}

function makeStore(seed: ReminderTemplateEntry[] = []): FakeStore {
    let nextSeq = seed.length + 1;
    const entries: ReminderTemplateEntry[] = seed.map((t) => ({ ...t }));
    return {
        _entries: entries,
        list() { return entries.map((t) => ({ ...t })); },
        findById(id) {
            const t = entries.find((x) => x.id === id);
            return t ? { ...t } : undefined;
        },
        findByName(name) {
            const t = entries.find((x) => x.name === name);
            return t ? { ...t } : undefined;
        },
        add(entry) {
            if (entry.isDefault) { entries.forEach((x) => { x.isDefault = false; }); }
            const created: ReminderTemplateEntry = { id: `r-${nextSeq++}`, ...entry };
            entries.push(created);
            return { ...created };
        },
        update(id, patch) {
            const t = entries.find((x) => x.id === id);
            if (!t) { return undefined; }
            if (patch.isDefault) { entries.forEach((x) => { x.isDefault = false; }); }
            if (patch.name !== undefined) { t.name = patch.name; }
            if (patch.prompt !== undefined) { t.prompt = patch.prompt; }
            if (patch.isDefault !== undefined) { t.isDefault = patch.isDefault === true; }
            return { ...t };
        },
        delete(id) {
            const idx = entries.findIndex((x) => x.id === id);
            if (idx < 0) { return { existed: false }; }
            const wasDefault = entries[idx].isDefault;
            entries.splice(idx, 1);
            if (!wasDefault) { return { existed: true }; }
            // Auto-promote first remaining
            if (entries.length > 0) {
                entries[0].isDefault = true;
                return { existed: true, promotedDefault: { ...entries[0] } };
            }
            return { existed: true };
        },
    };
}

let store: FakeStore;
beforeEach(() => { store = makeStore(); });

// ===========================================================================
// listReminderTemplates
// ===========================================================================

describe('listReminderTemplatesImpl', () => {

    test('typical call surfaces defaultId + defaultName + the full array', async () => {
        store = makeStore([
            { id: 'r-1', name: 'Alpha', prompt: 'a', isDefault: false },
            { id: 'r-2', name: 'Beta', prompt: 'b', isDefault: true },
        ]);
        const raw = await withTiming('tomAi_listReminderTemplates:typical', () =>
            listReminderTemplatesImpl(store));
        const r = JSON.parse(raw);
        assert.equal(r.ok, true);
        assert.equal(r.count, 2);
        assert.equal(r.defaultId, 'r-2');
        assert.equal(r.defaultName, 'Beta');
        assert.equal(r.templates.length, 2);
    });

    test('empty store: count 0, defaultId null', async () => {
        const r = JSON.parse(await listReminderTemplatesImpl(store));
        assert.equal(r.count, 0);
        assert.equal(r.defaultId, null);
        assert.equal(r.defaultName, null);
    });

    test('store with no default reports defaultId: null', async () => {
        store = makeStore([{ id: 'r-1', name: 'Only', prompt: 'x', isDefault: false }]);
        const r = JSON.parse(await listReminderTemplatesImpl(store));
        assert.equal(r.count, 1);
        assert.equal(r.defaultId, null);
    });
});

// ===========================================================================
// createReminderTemplate
// ===========================================================================

describe('createReminderTemplateImpl', () => {

    test('typical call: creates with generated id, returns id + name + isDefault', async () => {
        const raw = await withTiming('tomAi_createReminderTemplate:typical', () =>
            createReminderTemplateImpl(store, { name: 'Wake Up', prompt: 'Are you there?' }));
        const r = JSON.parse(raw);
        assert.equal(r.ok, true);
        assert.match(r.id, /^r-\d+$/);
        assert.equal(r.name, 'Wake Up');
        assert.equal(r.isDefault, false);
        assert.equal(store._entries.length, 1);
    });

    test('isDefault: true unsets default on every other entry', async () => {
        store = makeStore([{ id: 'r-1', name: 'Old', prompt: 'x', isDefault: true }]);
        await createReminderTemplateImpl(store, { name: 'New', prompt: 'y', isDefault: true });
        const old = store._entries.find((t) => t.id === 'r-1')!;
        const created = store._entries.find((t) => t.name === 'New')!;
        assert.equal(old.isDefault, false);
        assert.equal(created.isDefault, true);
    });

    test('NAME COLLISION REJECTED without overwrite (was silently allowed)', async () => {
        store = makeStore([{ id: 'r-1', name: 'Same Name', prompt: 'old', isDefault: false }]);
        const r = JSON.parse(await createReminderTemplateImpl(store, {
            name: 'Same Name', prompt: 'new',
        }));
        assert.equal(r.ok, false);
        assert.match(r.error, /already exists/);
        assert.match(r.error, /overwrite: true/);
        // Original intact
        assert.equal(store._entries[0].prompt, 'old');
        assert.equal(store._entries.length, 1);
    });

    test('name collision with overwrite: true replaces the entry (reports replacedId)', async () => {
        store = makeStore([{ id: 'r-1', name: 'Same', prompt: 'old', isDefault: false }]);
        const r = JSON.parse(await createReminderTemplateImpl(store, {
            name: 'Same', prompt: 'new', overwrite: true,
        }));
        assert.equal(r.ok, true);
        assert.equal(r.replacedId, 'r-1');
        assert.equal(store._entries.length, 1);
        assert.equal(store._entries[0].prompt, 'new');
    });

    test('empty name / empty prompt rejected', async () => {
        const r1 = JSON.parse(await createReminderTemplateImpl(store, { name: '   ', prompt: 'x' }));
        assert.match(r1.error, /`name` is required/);
        const r2 = JSON.parse(await createReminderTemplateImpl(store, { name: 'x', prompt: '   ' }));
        assert.match(r2.error, /`prompt` is required/);
    });
});

// ===========================================================================
// updateReminderTemplate
// ===========================================================================

describe('updateReminderTemplateImpl', () => {

    test('typical update: patches name + prompt, returns updated snapshot', async () => {
        store = makeStore([{ id: 'r-1', name: 'Old', prompt: 'old', isDefault: false }]);
        const raw = await withTiming('tomAi_updateReminderTemplate:typical', () =>
            updateReminderTemplateImpl(store, { id: 'r-1', name: 'New', prompt: 'new' }));
        const r = JSON.parse(raw);
        assert.equal(r.ok, true);
        assert.equal(r.name, 'New');
        assert.equal(store._entries[0].name, 'New');
        assert.equal(store._entries[0].prompt, 'new');
    });

    test('NOT FOUND: unknown id returns structured error pointing at list', async () => {
        const r = JSON.parse(await updateReminderTemplateImpl(store, { id: 'r-nope', name: 'X' }));
        assert.equal(r.ok, false);
        assert.match(r.error, /not found.*tomAi_listReminderTemplates/);
    });

    test('rename to an existing name (different id) → collision error', async () => {
        store = makeStore([
            { id: 'r-1', name: 'A', prompt: 'a', isDefault: false },
            { id: 'r-2', name: 'B', prompt: 'b', isDefault: false },
        ]);
        const r = JSON.parse(await updateReminderTemplateImpl(store, { id: 'r-1', name: 'B' }));
        assert.match(r.error, /Cannot rename to "B"/);
        // Original intact
        assert.equal(store._entries.find((t) => t.id === 'r-1')!.name, 'A');
    });

    test('renaming to the same name is a no-op (no collision triggered)', async () => {
        store = makeStore([{ id: 'r-1', name: 'Same', prompt: 'x', isDefault: false }]);
        const r = JSON.parse(await updateReminderTemplateImpl(store, { id: 'r-1', name: 'Same', prompt: 'new' }));
        assert.equal(r.ok, true);
        assert.equal(store._entries[0].prompt, 'new');
    });

    test('isDefault: true unsets others', async () => {
        store = makeStore([
            { id: 'r-1', name: 'A', prompt: 'a', isDefault: false },
            { id: 'r-2', name: 'B', prompt: 'b', isDefault: true },
        ]);
        await updateReminderTemplateImpl(store, { id: 'r-1', isDefault: true });
        assert.equal(store._entries.find((t) => t.id === 'r-1')!.isDefault, true);
        assert.equal(store._entries.find((t) => t.id === 'r-2')!.isDefault, false);
    });

    test('missing id rejected', async () => {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const r = JSON.parse(await updateReminderTemplateImpl(store, {} as any));
        assert.match(r.error, /`id` is required/);
    });
});

// ===========================================================================
// deleteReminderTemplate
// ===========================================================================

describe('deleteReminderTemplateImpl', () => {

    test('typical delete (non-default): no auto-promotion', async () => {
        store = makeStore([
            { id: 'r-1', name: 'A', prompt: 'a', isDefault: true },
            { id: 'r-2', name: 'B', prompt: 'b', isDefault: false },
        ]);
        const raw = await withTiming('tomAi_deleteReminderTemplate:typical', () =>
            deleteReminderTemplateImpl(store, { id: 'r-2' }));
        const r = JSON.parse(raw);
        assert.equal(r.ok, true);
        assert.equal(r.id, 'r-2');
        assert.equal(r.promotedDefaultId, null);
        assert.match(r.note, /No auto-promotion/);
    });

    test('DELETE THE DEFAULT → first remaining auto-promotes, response surfaces it', async () => {
        store = makeStore([
            { id: 'r-1', name: 'Old Default', prompt: 'a', isDefault: true },
            { id: 'r-2', name: 'B', prompt: 'b', isDefault: false },
            { id: 'r-3', name: 'C', prompt: 'c', isDefault: false },
        ]);
        const r = JSON.parse(await deleteReminderTemplateImpl(store, { id: 'r-1' }));
        assert.equal(r.ok, true);
        assert.equal(r.promotedDefaultId, 'r-2');
        assert.equal(r.promotedDefaultName, 'B');
        assert.match(r.note, /"B" auto-promoted to default/);
        assert.equal(store._entries.find((t) => t.id === 'r-2')!.isDefault, true);
    });

    test('deleting the only template leaves no default', async () => {
        store = makeStore([{ id: 'r-1', name: 'Lonely', prompt: 'x', isDefault: true }]);
        const r = JSON.parse(await deleteReminderTemplateImpl(store, { id: 'r-1' }));
        assert.equal(r.ok, true);
        assert.equal(r.promotedDefaultId, null);
        assert.equal(store._entries.length, 0);
    });

    test('NOT FOUND: unknown id → structured error pointing at list', async () => {
        const r = JSON.parse(await deleteReminderTemplateImpl(store, { id: 'r-nope' }));
        assert.equal(r.ok, false);
        assert.match(r.error, /not found.*tomAi_listReminderTemplates/);
    });

    test('missing id rejected', async () => {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const r = JSON.parse(await deleteReminderTemplateImpl(store, {} as any));
        assert.match(r.error, /`id` is required/);
    });
});

// ===========================================================================
// Full round-trip — create → list → update → delete (default auto-promote)
// ===========================================================================

describe('reminder-template — full round-trip', () => {

    test('lifecycle walks all four ops + verifies default auto-promotion', async () => {
        // Create two — second one as default
        const a = JSON.parse(await createReminderTemplateImpl(store, {
            name: 'First', prompt: 'hello {{originalPrompt}}',
        }));
        const b = JSON.parse(await createReminderTemplateImpl(store, {
            name: 'Second', prompt: 'pinging — {{timeoutMinutes}} min', isDefault: true,
        }));

        // List shows both, b is default
        let r = JSON.parse(await listReminderTemplatesImpl(store));
        assert.equal(r.count, 2);
        assert.equal(r.defaultId, b.id);

        // Update A — change prompt body
        await updateReminderTemplateImpl(store, { id: a.id, prompt: 'updated body' });
        assert.equal(store._entries.find((t) => t.id === a.id)!.prompt, 'updated body');

        // Delete B (the default) — A auto-promotes
        const del = JSON.parse(await deleteReminderTemplateImpl(store, { id: b.id }));
        assert.equal(del.promotedDefaultId, a.id);
        r = JSON.parse(await listReminderTemplatesImpl(store));
        assert.equal(r.defaultId, a.id);

        // Final delete leaves an empty store
        await deleteReminderTemplateImpl(store, { id: a.id });
        r = JSON.parse(await listReminderTemplatesImpl(store));
        assert.equal(r.count, 0);
        assert.equal(r.defaultId, null);
    });
});
