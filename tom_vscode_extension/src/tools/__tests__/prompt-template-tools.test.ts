/**
 * Tool-impl tests for `prompt-template-tools.ts` — the 4
 * `tomAi_*PromptTemplate` tools.
 *
 * Strategy: in-memory `PromptTemplateStore` fake. Both stores
 * (copilot map + anthropic array) live in plain JS objects; the
 * fake mirrors the production write semantics:
 *   - copilot: `set` overwrites, `delete` returns false on miss
 *   - anthropic: `update` mutates in-place; `setDefault` flips
 *     every other entry off
 *
 * Coverage entry #20 four-row checklist:
 *
 *   a) Descriptions verified in the impl file. NO category enum,
 *      placeholder syntax + transport-keyed identity model spelled
 *      out, defaults documented per transport.
 *   b) Ambiguities — covered:
 *        - create vs update on existing id (both reject without
 *          `overwrite: true`)
 *        - delete of unknown id (structured error pointing at list)
 *        - copilot rename collision (rejected without overwrite —
 *          previously a silent data-loss trap)
 *        - copilot vs anthropic identity model (name=id vs id+name)
 *   c) Round-trip every operation against the in-memory fake. Two
 *      transports tested independently.
 *   d) Timing — all 4 typical cases via `withTiming`.
 */

import test, { beforeEach, describe } from 'node:test';
import assert from 'node:assert/strict';

import { withTiming } from './_timing.js';
import {
    createPromptTemplateImpl,
    deletePromptTemplateImpl,
    listPromptTemplatesImpl,
    updatePromptTemplateImpl,
    type AnthropicTemplateEntry,
    type CopilotTemplateEntry,
    type PromptTemplateStore,
} from '../prompt-template-tools.js';

// ===========================================================================
// In-memory store fake
// ===========================================================================

interface FakeStore extends PromptTemplateStore {
    _copilotMap: Record<string, CopilotTemplateEntry>;
    _anthropicList: AnthropicTemplateEntry[];
}

function makeStore(seed: { copilot?: Record<string, CopilotTemplateEntry>; anthropic?: AnthropicTemplateEntry[] } = {}): FakeStore {
    const copilotMap: Record<string, CopilotTemplateEntry> = { ...(seed.copilot ?? {}) };
    const anthropicList: AnthropicTemplateEntry[] = [...(seed.anthropic ?? [])];
    return {
        _copilotMap: copilotMap,
        _anthropicList: anthropicList,
        copilot: {
            list() { return { ...copilotMap }; },
            has(name) { return Object.prototype.hasOwnProperty.call(copilotMap, name); },
            set(name, entry) { copilotMap[name] = { ...entry }; },
            delete(name) {
                if (!Object.prototype.hasOwnProperty.call(copilotMap, name)) { return false; }
                delete copilotMap[name];
                return true;
            },
        },
        anthropic: {
            list() { return anthropicList.map((t) => ({ ...t })); },
            find(id) {
                const t = anthropicList.find((x) => x.id === id);
                return t ? { ...t } : undefined;
            },
            add(entry) { anthropicList.push({ ...entry }); },
            update(id, patch) {
                const t = anthropicList.find((x) => x.id === id);
                if (!t) { return undefined; }
                if (patch.newId !== undefined && patch.newId !== t.id) { t.id = patch.newId; }
                if (patch.name !== undefined) { t.name = patch.name; }
                if (patch.description !== undefined) { t.description = patch.description || undefined; }
                if (patch.template !== undefined) { t.template = patch.template; }
                if (patch.isDefault !== undefined) { t.isDefault = patch.isDefault === true; }
                return { ...t };
            },
            delete(id) {
                const idx = anthropicList.findIndex((x) => x.id === id);
                if (idx < 0) { return false; }
                anthropicList.splice(idx, 1);
                return true;
            },
            setDefault(id) {
                for (const t of anthropicList) { t.isDefault = (t.id === id); }
            },
        },
    };
}

let store: FakeStore;
beforeEach(() => { store = makeStore(); });

// ===========================================================================
// listPromptTemplates
// ===========================================================================

describe('listPromptTemplatesImpl', () => {

    test('typical call (copilot default) returns the map as an array', async () => {
        store = makeStore({
            copilot: {
                'Default': { template: '${originalPrompt}', showInMenu: true },
                'Hidden': { template: 'x', showInMenu: false },
            },
        });
        const raw = await withTiming('tomAi_listPromptTemplates:typical', () =>
            listPromptTemplatesImpl(store, {}));
        const r = JSON.parse(raw);
        assert.equal(r.ok, true);
        assert.equal(r.transport, 'copilot');
        assert.equal(r.count, 2);
        const def = r.templates.find((t: { name: string }) => t.name === 'Default')!;
        assert.equal(def.showInMenu, true);
        assert.equal(def.template, '${originalPrompt}');
    });

    test('transport: "anthropic" lists the array store with id+name+description', async () => {
        store = makeStore({
            anthropic: [
                { id: 'fast', name: 'Fast', template: '${userMessage}', isDefault: true },
                { id: 'slow', name: 'Slow', template: 'analyse: ${userMessage}', description: 'careful mode' },
            ],
        });
        const r = JSON.parse(await listPromptTemplatesImpl(store, { transport: 'anthropic' }));
        assert.equal(r.transport, 'anthropic');
        assert.equal(r.count, 2);
        const fast = r.templates.find((t: { id: string }) => t.id === 'fast')!;
        assert.equal(fast.isDefault, true);
        const slow = r.templates.find((t: { id: string }) => t.id === 'slow')!;
        assert.equal(slow.description, 'careful mode');
    });

    test('empty stores return count: 0', async () => {
        const r = JSON.parse(await listPromptTemplatesImpl(store, {}));
        assert.equal(r.count, 0);
        assert.deepEqual(r.templates, []);
    });
});

// ===========================================================================
// createPromptTemplate
// ===========================================================================

describe('createPromptTemplateImpl', () => {

    test('typical copilot create: defaults template body to ${originalPrompt}, showInMenu to true', async () => {
        const raw = await withTiming('tomAi_createPromptTemplate:typical', () =>
            createPromptTemplateImpl(store, { name: 'Refactor' }));
        const r = JSON.parse(raw);
        assert.equal(r.ok, true);
        assert.equal(r.transport, 'copilot');
        assert.equal(r.name, 'Refactor');
        assert.equal(store._copilotMap['Refactor'].template, '${originalPrompt}');
        assert.equal(store._copilotMap['Refactor'].showInMenu, true);
    });

    test('typical anthropic create: defaults template body to ${userMessage}, id defaults to name', async () => {
        const r = JSON.parse(await createPromptTemplateImpl(store, {
            transport: 'anthropic',
            name: 'Code Review',
        }));
        assert.equal(r.ok, true);
        assert.equal(r.id, 'Code Review');
        const entry = store._anthropicList[0];
        assert.equal(entry.template, '${userMessage}');
        assert.equal(entry.name, 'Code Review');
    });

    test('SAFER-BY-DEFAULT: copilot duplicate rejected without overwrite (was silent overwrite trap)', async () => {
        store = makeStore({ copilot: { 'Existing': { template: 'original' } } });
        const r = JSON.parse(await createPromptTemplateImpl(store, {
            name: 'Existing', template: 'new',
        }));
        assert.equal(r.ok, false);
        assert.match(r.error, /already exists/);
        assert.match(r.error, /overwrite: true/);
        assert.equal(store._copilotMap['Existing'].template, 'original', 'template must be unchanged');
    });

    test('copilot duplicate with overwrite: true replaces the entry', async () => {
        store = makeStore({ copilot: { 'Existing': { template: 'original' } } });
        const r = JSON.parse(await createPromptTemplateImpl(store, {
            name: 'Existing', template: 'replaced', overwrite: true,
        }));
        assert.equal(r.ok, true);
        assert.equal(store._copilotMap['Existing'].template, 'replaced');
    });

    test('anthropic duplicate rejected without overwrite', async () => {
        store = makeStore({ anthropic: [{ id: 'fast', name: 'Fast', template: 'x' }] });
        const r = JSON.parse(await createPromptTemplateImpl(store, {
            transport: 'anthropic', name: 'Fast', id: 'fast',
        }));
        assert.match(r.error, /already exists/);
        assert.equal(store._anthropicList.length, 1);
    });

    test('anthropic isDefault: true unsets default on every other entry', async () => {
        store = makeStore({
            anthropic: [
                { id: 'old-default', name: 'Old', template: 'x', isDefault: true },
                { id: 'other', name: 'Other', template: 'y' },
            ],
        });
        await createPromptTemplateImpl(store, {
            transport: 'anthropic', name: 'New Default', id: 'new-default', isDefault: true,
        });
        assert.equal(store._anthropicList.find((t) => t.id === 'new-default')?.isDefault, true);
        assert.equal(store._anthropicList.find((t) => t.id === 'old-default')?.isDefault, false);
        assert.equal(store._anthropicList.find((t) => t.id === 'other')?.isDefault, false);
    });

    test('empty name rejected', async () => {
        const r = JSON.parse(await createPromptTemplateImpl(store, { name: '   ' }));
        assert.match(r.error, /`name` is required/);
    });
});

// ===========================================================================
// updatePromptTemplate
// ===========================================================================

describe('updatePromptTemplateImpl', () => {

    test('typical copilot update: patches template body without changing the name', async () => {
        store = makeStore({ copilot: { 'My': { template: 'old', showInMenu: true } } });
        const raw = await withTiming('tomAi_updatePromptTemplate:typical', () =>
            updatePromptTemplateImpl(store, { name: 'My', template: 'new' }));
        const r = JSON.parse(raw);
        assert.equal(r.ok, true);
        assert.equal(r.name, 'My');
        assert.equal(store._copilotMap['My'].template, 'new');
        assert.equal(store._copilotMap['My'].showInMenu, true, 'showInMenu preserved when not in patch');
    });

    test('copilot rename moves the entry to the new name (single key)', async () => {
        store = makeStore({ copilot: { 'Old': { template: 'x', showInMenu: true } } });
        const r = JSON.parse(await updatePromptTemplateImpl(store, { name: 'Old', newName: 'New' }));
        assert.equal(r.name, 'New');
        assert.equal(r.renamedFrom, 'Old');
        assert.ok(!('Old' in store._copilotMap));
        assert.ok('New' in store._copilotMap);
    });

    test('COPILOT RENAME COLLISION (THE TRAP) rejected without overwrite', async () => {
        store = makeStore({
            copilot: { 'Source': { template: 'src' }, 'Target': { template: 'target-original' } },
        });
        const r = JSON.parse(await updatePromptTemplateImpl(store, {
            name: 'Source', newName: 'Target',
        }));
        assert.equal(r.ok, false);
        assert.match(r.error, /Cannot rename to "Target"/);
        assert.match(r.error, /overwrite: true/);
        // CRITICAL: both originals must be intact (no silent clobber)
        assert.equal(store._copilotMap['Source'].template, 'src');
        assert.equal(store._copilotMap['Target'].template, 'target-original');
    });

    test('copilot rename collision with overwrite: true completes the move', async () => {
        store = makeStore({
            copilot: { 'Source': { template: 'src' }, 'Target': { template: 'old' } },
        });
        const r = JSON.parse(await updatePromptTemplateImpl(store, {
            name: 'Source', newName: 'Target', overwrite: true,
        }));
        assert.equal(r.ok, true);
        assert.ok(!('Source' in store._copilotMap));
        assert.equal(store._copilotMap['Target'].template, 'src');
    });

    test('anthropic update by id: name and description are independent', async () => {
        store = makeStore({
            anthropic: [{ id: 'a', name: 'OldName', template: 'x', description: 'old-desc' }],
        });
        const r = JSON.parse(await updatePromptTemplateImpl(store, {
            transport: 'anthropic', id: 'a', name: 'NewName', description: 'new-desc',
        }));
        assert.equal(r.ok, true);
        assert.equal(r.id, 'a', 'id stays the same when only name changes');
        assert.equal(r.name, 'NewName');
        assert.equal(store._anthropicList[0].description, 'new-desc');
    });

    test('anthropic rename via newId moves the identity', async () => {
        store = makeStore({ anthropic: [{ id: 'old-id', name: 'X', template: 'x' }] });
        const r = JSON.parse(await updatePromptTemplateImpl(store, {
            transport: 'anthropic', id: 'old-id', newId: 'new-id',
        }));
        assert.equal(r.id, 'new-id');
        assert.equal(store._anthropicList[0].id, 'new-id');
    });

    test('anthropic newId collision rejected without overwrite', async () => {
        store = makeStore({
            anthropic: [
                { id: 'src', name: 'S', template: 'src' },
                { id: 'dst', name: 'D', template: 'dst-original' },
            ],
        });
        const r = JSON.parse(await updatePromptTemplateImpl(store, {
            transport: 'anthropic', id: 'src', newId: 'dst',
        }));
        assert.match(r.error, /already exists/);
        // Both intact
        assert.equal(store._anthropicList.length, 2);
        assert.equal(store._anthropicList.find((t) => t.id === 'dst')!.template, 'dst-original');
    });

    test('anthropic isDefault: true unsets the flag on every other entry', async () => {
        store = makeStore({
            anthropic: [
                { id: 'a', name: 'A', template: 'a' },
                { id: 'b', name: 'B', template: 'b', isDefault: true },
            ],
        });
        await updatePromptTemplateImpl(store, {
            transport: 'anthropic', id: 'a', isDefault: true,
        });
        assert.equal(store._anthropicList.find((t) => t.id === 'a')?.isDefault, true);
        assert.equal(store._anthropicList.find((t) => t.id === 'b')?.isDefault, false);
    });

    test('copilot missing name → instructive error pointing at list', async () => {
        const r = JSON.parse(await updatePromptTemplateImpl(store, { name: 'NoSuch' }));
        assert.match(r.error, /not found.*tomAi_listPromptTemplates/);
    });

    test('anthropic missing id → instructive error pointing at list', async () => {
        const r = JSON.parse(await updatePromptTemplateImpl(store, { transport: 'anthropic', id: 'nope' }));
        assert.match(r.error, /not found.*tomAi_listPromptTemplates/);
    });
});

// ===========================================================================
// deletePromptTemplate
// ===========================================================================

describe('deletePromptTemplateImpl', () => {

    test('typical copilot delete', async () => {
        store = makeStore({ copilot: { 'X': { template: 'x' } } });
        const raw = await withTiming('tomAi_deletePromptTemplate:typical', () =>
            deletePromptTemplateImpl(store, { name: 'X' }));
        const r = JSON.parse(raw);
        assert.equal(r.ok, true);
        assert.equal(r.name, 'X');
        assert.ok(!('X' in store._copilotMap));
    });

    test('typical anthropic delete', async () => {
        store = makeStore({ anthropic: [{ id: 'a', name: 'A', template: 'a' }] });
        const r = JSON.parse(await deletePromptTemplateImpl(store, { transport: 'anthropic', id: 'a' }));
        assert.equal(r.ok, true);
        assert.equal(store._anthropicList.length, 0);
    });

    test('unknown copilot name → not-found error pointing at list', async () => {
        const r = JSON.parse(await deletePromptTemplateImpl(store, { name: 'nope' }));
        assert.match(r.error, /not found.*tomAi_listPromptTemplates/);
    });

    test('unknown anthropic id → not-found error pointing at list', async () => {
        const r = JSON.parse(await deletePromptTemplateImpl(store, { transport: 'anthropic', id: 'nope' }));
        assert.match(r.error, /not found.*tomAi_listPromptTemplates/);
    });

    test('copilot delete without name → instructive error', async () => {
        const r = JSON.parse(await deletePromptTemplateImpl(store, {}));
        assert.match(r.error, /`name` is required for copilot/);
    });

    test('anthropic delete without id → instructive error', async () => {
        const r = JSON.parse(await deletePromptTemplateImpl(store, { transport: 'anthropic' }));
        assert.match(r.error, /`id` is required for anthropic/);
    });
});

// ===========================================================================
// Full round-trip — list → create → update → delete
// ===========================================================================

describe('prompt-template — full round-trip', () => {

    test('copilot lifecycle walks create → list → update → delete', async () => {
        // Empty
        let r = JSON.parse(await listPromptTemplatesImpl(store, {}));
        assert.equal(r.count, 0);

        // Create
        await createPromptTemplateImpl(store, { name: 'My', template: 'body' });
        r = JSON.parse(await listPromptTemplatesImpl(store, {}));
        assert.equal(r.count, 1);

        // Update template body
        await updatePromptTemplateImpl(store, { name: 'My', template: 'updated body' });
        r = JSON.parse(await listPromptTemplatesImpl(store, {}));
        assert.equal(r.templates[0].template, 'updated body');

        // Rename
        await updatePromptTemplateImpl(store, { name: 'My', newName: 'YourTemplate' });
        r = JSON.parse(await listPromptTemplatesImpl(store, {}));
        assert.equal(r.templates[0].name, 'YourTemplate');

        // Delete
        await deletePromptTemplateImpl(store, { name: 'YourTemplate' });
        r = JSON.parse(await listPromptTemplatesImpl(store, {}));
        assert.equal(r.count, 0);
    });

    test('anthropic lifecycle walks create → list → update (rename + isDefault) → delete', async () => {
        await createPromptTemplateImpl(store, {
            transport: 'anthropic', name: 'First', id: 'first',
        });
        await createPromptTemplateImpl(store, {
            transport: 'anthropic', name: 'Second', id: 'second', isDefault: true,
        });

        let r = JSON.parse(await listPromptTemplatesImpl(store, { transport: 'anthropic' }));
        assert.equal(r.count, 2);
        assert.equal(r.templates.find((t: { id: string }) => t.id === 'second').isDefault, true);

        // Rename second's id + flip the default to first
        await updatePromptTemplateImpl(store, {
            transport: 'anthropic', id: 'second', newId: 'second-renamed',
        });
        await updatePromptTemplateImpl(store, {
            transport: 'anthropic', id: 'first', isDefault: true,
        });

        r = JSON.parse(await listPromptTemplatesImpl(store, { transport: 'anthropic' }));
        assert.equal(r.templates.find((t: { id: string }) => t.id === 'second-renamed').isDefault, false);
        assert.equal(r.templates.find((t: { id: string }) => t.id === 'first').isDefault, true);

        // Delete
        await deletePromptTemplateImpl(store, { transport: 'anthropic', id: 'first' });
        await deletePromptTemplateImpl(store, { transport: 'anthropic', id: 'second-renamed' });
        r = JSON.parse(await listPromptTemplatesImpl(store, { transport: 'anthropic' }));
        assert.equal(r.count, 0);
    });
});
