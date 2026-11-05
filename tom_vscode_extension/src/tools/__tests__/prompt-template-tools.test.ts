/**
 * Tool-impl tests for `prompt-template-tools.ts` — the 4
 * `tomAi_*PromptTemplate` tools over the one template store (the
 * user-message templates both transports read).
 *
 * Strategy: an in-memory `PromptTemplateStore` fake whose array mirrors the
 * production write semantics: `update` mutates in place, `setDefault` flips
 * every other entry off, `delete` answers false on a miss.
 *
 * Covered: create vs update on an existing id (both reject without
 * `overwrite: true`), delete of an unknown id (structured error pointing at
 * list), id and name being independent, a rename onto an existing id, and the
 * round-trip of every operation; the four typical calls are timed.
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
    type PromptTemplateStore,
} from '../prompt-template-tools.js';

interface FakeStore extends PromptTemplateStore {
    _list: AnthropicTemplateEntry[];
}

function makeStore(seed: AnthropicTemplateEntry[] = []): FakeStore {
    const list: AnthropicTemplateEntry[] = seed.map((t) => ({ ...t }));
    return {
        _list: list,
        anthropic: {
            list() { return list.map((t) => ({ ...t })); },
            find(id) {
                const t = list.find((x) => x.id === id);
                return t ? { ...t } : undefined;
            },
            add(entry) { list.push({ ...entry }); },
            update(id, patch) {
                const t = list.find((x) => x.id === id);
                if (!t) { return undefined; }
                if (patch.newId !== undefined && patch.newId !== t.id) { t.id = patch.newId; }
                if (patch.name !== undefined) { t.name = patch.name; }
                if (patch.description !== undefined) { t.description = patch.description || undefined; }
                if (patch.template !== undefined) { t.template = patch.template; }
                if (patch.isDefault !== undefined) { t.isDefault = patch.isDefault === true; }
                return { ...t };
            },
            delete(id) {
                const idx = list.findIndex((x) => x.id === id);
                if (idx < 0) { return false; }
                list.splice(idx, 1);
                return true;
            },
            setDefault(id) {
                for (const t of list) { t.isDefault = (t.id === id); }
            },
        },
    };
}

let store: FakeStore;
beforeEach(() => { store = makeStore(); });

describe('listPromptTemplatesImpl', () => {
    test('typical call lists the store with id, name, description, isDefault', async () => {
        store = makeStore([
            { id: 'fast', name: 'Fast', template: '${userMessage}', isDefault: true },
            { id: 'slow', name: 'Slow', template: 'analyse: ${userMessage}', description: 'careful mode' },
        ]);
        const raw = await withTiming('tomAi_listPromptTemplates:typical', () => listPromptTemplatesImpl(store, {}));
        const r = JSON.parse(raw);
        assert.equal(r.ok, true);
        assert.equal(r.count, 2);
        assert.equal(r.templates.find((t: { id: string }) => t.id === 'fast').isDefault, true);
        assert.equal(r.templates.find((t: { id: string }) => t.id === 'slow').description, 'careful mode');
        assert.equal('transport' in r, false, 'there is one store, no transport');
    });

    test('an empty store returns count: 0', async () => {
        const r = JSON.parse(await listPromptTemplatesImpl(store, {}));
        assert.equal(r.count, 0);
        assert.deepEqual(r.templates, []);
    });
});

describe('createPromptTemplateImpl', () => {
    test('typical create: body defaults to ${userMessage}, id to name', async () => {
        const raw = await withTiming('tomAi_createPromptTemplate:typical', () =>
            createPromptTemplateImpl(store, { name: 'Code Review' }));
        const r = JSON.parse(raw);
        assert.equal(r.ok, true);
        assert.equal(r.id, 'Code Review');
        assert.equal(store._list[0].template, '${userMessage}');
        assert.equal(store._list[0].name, 'Code Review');
    });

    test('an existing id is rejected without overwrite', async () => {
        store = makeStore([{ id: 'fast', name: 'Fast', template: 'original' }]);
        const r = JSON.parse(await createPromptTemplateImpl(store, { name: 'Fast', id: 'fast', template: 'new' }));
        assert.equal(r.ok, false);
        assert.match(r.error, /already exists/);
        assert.match(r.error, /overwrite: true/);
        assert.equal(store._list.length, 1);
        assert.equal(store._list[0].template, 'original');
    });

    test('an existing id with overwrite: true is replaced', async () => {
        store = makeStore([{ id: 'fast', name: 'Fast', template: 'original' }]);
        const r = JSON.parse(await createPromptTemplateImpl(store, { name: 'Fast', id: 'fast', template: 'replaced', overwrite: true }));
        assert.equal(r.ok, true);
        assert.equal(store._list.length, 1);
        assert.equal(store._list[0].template, 'replaced');
    });

    test('isDefault: true unsets the default on every other entry', async () => {
        store = makeStore([
            { id: 'old-default', name: 'Old', template: 'x', isDefault: true },
            { id: 'other', name: 'Other', template: 'y' },
        ]);
        await createPromptTemplateImpl(store, { name: 'New Default', id: 'new-default', isDefault: true });
        assert.equal(store._list.find((t) => t.id === 'new-default')?.isDefault, true);
        assert.equal(store._list.find((t) => t.id === 'old-default')?.isDefault, false);
        assert.equal(store._list.find((t) => t.id === 'other')?.isDefault, false);
    });

    test('an empty name is rejected', async () => {
        const r = JSON.parse(await createPromptTemplateImpl(store, { name: '   ' }));
        assert.match(r.error, /`name` is required/);
    });
});

describe('updatePromptTemplateImpl', () => {
    test('typical update by id: name and description change, the id stays', async () => {
        store = makeStore([{ id: 'a', name: 'OldName', template: 'x', description: 'old-desc' }]);
        const raw = await withTiming('tomAi_updatePromptTemplate:typical', () =>
            updatePromptTemplateImpl(store, { id: 'a', name: 'NewName', description: 'new-desc' }));
        const r = JSON.parse(raw);
        assert.equal(r.ok, true);
        assert.equal(r.id, 'a');
        assert.equal(r.name, 'NewName');
        assert.equal(store._list[0].description, 'new-desc');
    });

    test('without id, name looks the template up', async () => {
        store = makeStore([{ id: 'My', name: 'My', template: 'old' }]);
        const r = JSON.parse(await updatePromptTemplateImpl(store, { name: 'My', template: 'new' }));
        assert.equal(r.ok, true);
        assert.equal(store._list[0].template, 'new');
    });

    test('newId moves the identity', async () => {
        store = makeStore([{ id: 'old-id', name: 'X', template: 'x' }]);
        const r = JSON.parse(await updatePromptTemplateImpl(store, { id: 'old-id', newId: 'new-id' }));
        assert.equal(r.id, 'new-id');
        assert.equal(store._list[0].id, 'new-id');
    });

    test('a rename onto an existing id is rejected without overwrite, both kept', async () => {
        store = makeStore([
            { id: 'src', name: 'S', template: 'src' },
            { id: 'dst', name: 'D', template: 'dst-original' },
        ]);
        const r = JSON.parse(await updatePromptTemplateImpl(store, { id: 'src', newId: 'dst' }));
        assert.match(r.error, /already exists/);
        assert.equal(store._list.length, 2);
        assert.equal(store._list.find((t) => t.id === 'dst')!.template, 'dst-original');
    });

    test('a rename onto an existing id with overwrite: true replaces it', async () => {
        store = makeStore([
            { id: 'src', name: 'S', template: 'src' },
            { id: 'dst', name: 'D', template: 'old' },
        ]);
        const r = JSON.parse(await updatePromptTemplateImpl(store, { id: 'src', newId: 'dst', overwrite: true }));
        assert.equal(r.ok, true);
        assert.equal(store._list.length, 1);
        assert.equal(store._list[0].template, 'src');
    });

    test('isDefault: true unsets the flag on every other entry', async () => {
        store = makeStore([
            { id: 'a', name: 'A', template: 'a' },
            { id: 'b', name: 'B', template: 'b', isDefault: true },
        ]);
        await updatePromptTemplateImpl(store, { id: 'a', isDefault: true });
        assert.equal(store._list.find((t) => t.id === 'a')?.isDefault, true);
        assert.equal(store._list.find((t) => t.id === 'b')?.isDefault, false);
    });

    test('an unknown id → instructive error pointing at list', async () => {
        const r = JSON.parse(await updatePromptTemplateImpl(store, { id: 'nope' }));
        assert.match(r.error, /not found.*tomAi_listPromptTemplates/);
    });

    test('neither id nor name → instructive error', async () => {
        const r = JSON.parse(await updatePromptTemplateImpl(store, {}));
        assert.match(r.error, /`id` \(or `name`\) is required/);
    });
});

describe('deletePromptTemplateImpl', () => {
    test('typical delete', async () => {
        store = makeStore([{ id: 'a', name: 'A', template: 'a' }]);
        const raw = await withTiming('tomAi_deletePromptTemplate:typical', () => deletePromptTemplateImpl(store, { id: 'a' }));
        const r = JSON.parse(raw);
        assert.equal(r.ok, true);
        assert.equal(r.id, 'a');
        assert.equal(store._list.length, 0);
    });

    test('an unknown id → not-found error pointing at list', async () => {
        const r = JSON.parse(await deletePromptTemplateImpl(store, { id: 'nope' }));
        assert.match(r.error, /not found.*tomAi_listPromptTemplates/);
    });

    test('without id → instructive error', async () => {
        const r = JSON.parse(await deletePromptTemplateImpl(store, {}));
        assert.match(r.error, /`id` is required/);
    });
});

describe('prompt-template — full round-trip', () => {
    test('create → list → update (rename + isDefault) → delete', async () => {
        await createPromptTemplateImpl(store, { name: 'First', id: 'first' });
        await createPromptTemplateImpl(store, { name: 'Second', id: 'second', isDefault: true });
        let r = JSON.parse(await listPromptTemplatesImpl(store, {}));
        assert.equal(r.count, 2);
        assert.equal(r.templates.find((t: { id: string }) => t.id === 'second').isDefault, true);

        await updatePromptTemplateImpl(store, { id: 'second', newId: 'second-renamed' });
        await updatePromptTemplateImpl(store, { id: 'first', isDefault: true });
        r = JSON.parse(await listPromptTemplatesImpl(store, {}));
        assert.equal(r.templates.find((t: { id: string }) => t.id === 'second-renamed').isDefault, false);
        assert.equal(r.templates.find((t: { id: string }) => t.id === 'first').isDefault, true);

        await deletePromptTemplateImpl(store, { id: 'first' });
        await deletePromptTemplateImpl(store, { id: 'second-renamed' });
        r = JSON.parse(await listPromptTemplatesImpl(store, {}));
        assert.equal(r.count, 0);
    });
});
