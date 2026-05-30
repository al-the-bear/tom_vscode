/**
 * Tool-impl tests for `memory-tools.ts` — `tomAi_saveMemory`,
 * `tomAi_updateMemory`, `tomAi_forgetMemory`, `tomAi_readMemory`,
 * `tomAi_listMemory`.
 *
 * Strategy: a `Map<scope, Map<file, content>>`-backed in-memory
 * `MemoryStore` fake. The real production `TwoTierMemoryService` is
 * fs-backed and already has its own integration tests; here we're
 * pinning the tool-orchestration layer: scope routing, suffix
 * filtering, file-vs-entry handling, wildcard rejection.
 *
 * Coverage entry #12 four-row checklist:
 *
 *   a) Description clarity — verified in the impl file; the
 *      file-vs-entry distinction and the saveMemory↔updateMemory
 *      overlap are documented.
 *   b) Ambiguities — covered:
 *        - file vs entry (heading): both paths exercised in the
 *          round-trip test
 *        - wildcard delete: rejected with a clear error
 *        - update vs replace: saveMemory(heading) and updateMemory
 *          produce identical store calls (asserted)
 *        - suffix filter matches the `injectForSystemPrompt(suffix)`
 *          strict policy (only `facts-<suffix>.md`)
 *   c) Round-trip: save → list → read → update → forget, with
 *      assertions at every step.
 *   d) Timing — all five typical cases via `withTiming`.
 */

import test, { beforeEach, describe } from 'node:test';
import assert from 'node:assert/strict';

import { withTiming } from './_timing.js';
import {
    forgetMemoryImpl,
    listMemoryImpl,
    readMemoryImpl,
    saveMemoryImpl,
    updateMemoryImpl,
    type MemoryScope,
    type MemoryStore,
} from '../memory-tools.js';

// ---------------------------------------------------------------------------
// In-memory MemoryStore fake
// ---------------------------------------------------------------------------

interface StoreCall {
    method: 'list' | 'read' | 'append' | 'replaceSection' | 'delete';
    args: unknown[];
}

function makeStore(seed: Partial<Record<MemoryScope, Record<string, string>>> = {}): MemoryStore & { calls: StoreCall[]; raw: Map<MemoryScope, Map<string, string>> } {
    const raw = new Map<MemoryScope, Map<string, string>>([
        ['quest', new Map(Object.entries(seed.quest ?? {}))],
        ['shared', new Map(Object.entries(seed.shared ?? {}))],
    ]);
    const calls: StoreCall[] = [];
    return {
        raw, calls,
        list(scope) {
            calls.push({ method: 'list', args: [scope] });
            return Array.from(raw.get(scope)!.keys()).sort();
        },
        read(scope, file) {
            calls.push({ method: 'read', args: [scope, file] });
            return raw.get(scope)!.get(file) ?? '';
        },
        append(scope, file, content) {
            calls.push({ method: 'append', args: [scope, file, content] });
            const existing = raw.get(scope)!.get(file) ?? '';
            const sep = existing && !existing.endsWith('\n') ? '\n' : '';
            raw.get(scope)!.set(file, existing + sep + content.trimEnd() + '\n');
        },
        replaceSection(scope, file, heading, content) {
            calls.push({ method: 'replaceSection', args: [scope, file, heading, content] });
            // Simplified: just emit `## heading\n\n<content>\n` — production has
            // a smarter parser, but this is enough for tool-level orchestration tests.
            const existing = raw.get(scope)!.get(file) ?? '';
            const headerRe = new RegExp(`(^|\\n)## ${heading}\\n[\\s\\S]*?(?=\\n## |$)`);
            if (headerRe.test(existing)) {
                raw.get(scope)!.set(file, existing.replace(headerRe, `$1## ${heading}\n\n${content.trim()}\n`));
            } else {
                const sep = existing && !existing.endsWith('\n') ? '\n' : '';
                raw.get(scope)!.set(file, (existing + sep + `\n## ${heading}\n\n${content.trim()}\n`).replace(/^\n+/, ''));
            }
        },
        delete(scope, file) {
            calls.push({ method: 'delete', args: [scope, file] });
            raw.get(scope)!.delete(file);
        },
    };
}

let store: ReturnType<typeof makeStore>;
beforeEach(() => { store = makeStore(); });

// ===========================================================================
// saveMemory
// ===========================================================================

describe('saveMemoryImpl', () => {

    test('typical call: appends to facts.md in quest scope by default', async () => {
        const raw = await withTiming('tomAi_saveMemory:typical', () =>
            saveMemoryImpl(store, { content: 'fact A' }));
        const r = JSON.parse(raw);
        assert.equal(r.ok, true);
        assert.equal(r.action, 'appended');
        assert.equal(r.scope, 'quest');
        assert.equal(r.file, 'facts.md');
        // append() was invoked, not replaceSection
        assert.equal(store.calls.find((c) => c.method === 'append')!.args[1], 'facts.md');
        // Content landed in the store
        assert.match(store.raw.get('quest')!.get('facts.md')!, /fact A/);
    });

    test('with heading → replaceSection path (semantically same as updateMemory)', async () => {
        const r = JSON.parse(await saveMemoryImpl(store, {
            content: 'updated value',
            heading: 'My Section',
        }));
        assert.equal(r.action, 'replaced-section');
        assert.equal(r.heading, 'My Section');
        // replaceSection was called, NOT append
        assert.equal(store.calls.filter((c) => c.method === 'replaceSection').length, 1);
        assert.equal(store.calls.filter((c) => c.method === 'append').length, 0);
    });

    test('empty content → instructive error', async () => {
        const r = JSON.parse(await saveMemoryImpl(store, { content: '   ' }));
        assert.match(r.error, /`content` is empty/);
        assert.equal(store.calls.length, 0);
    });

    test('shared scope routed correctly', async () => {
        await saveMemoryImpl(store, { content: 'shared fact', scope: 'shared' });
        assert.match(store.raw.get('shared')!.get('facts.md')!, /shared fact/);
        assert.equal(store.raw.get('quest')!.size, 0);
    });

    test('custom file name honoured', async () => {
        await saveMemoryImpl(store, { content: 'custom', file: 'prefs.md' });
        assert.ok(store.raw.get('quest')!.has('prefs.md'));
        assert.equal(store.raw.get('quest')!.has('facts.md'), false);
    });
});

// ===========================================================================
// updateMemory
// ===========================================================================

describe('updateMemoryImpl', () => {

    test('typical call: replaceSection routed correctly', async () => {
        const r = JSON.parse(await withTiming('tomAi_updateMemory:typical', () =>
            updateMemoryImpl(store, {
                file: 'facts.md',
                heading: 'Project Stack',
                content: 'TypeScript + Node',
            })));
        assert.equal(r.action, 'replaced-section');
        assert.equal(r.heading, 'Project Stack');
        assert.match(store.raw.get('quest')!.get('facts.md')!, /## Project Stack/);
    });

    test('update vs save-with-heading: identical store calls', async () => {
        const storeA = makeStore();
        const storeB = makeStore();
        await updateMemoryImpl(storeA, { file: 'f.md', heading: 'H', content: 'x' });
        await saveMemoryImpl(storeB, { file: 'f.md', heading: 'H', content: 'x' });
        assert.deepEqual(storeA.calls.map((c) => [c.method, c.args]),
                         storeB.calls.map((c) => [c.method, c.args]),
                         'updateMemory and saveMemory(with heading) must produce identical store calls');
    });

    test('missing file or heading → error', async () => {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const r1 = JSON.parse(await updateMemoryImpl(store, { heading: 'H', content: 'x' } as any));
        assert.match(r1.error, /`file` and `heading` are both required/);
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const r2 = JSON.parse(await updateMemoryImpl(store, { file: 'f.md', content: 'x' } as any));
        assert.match(r2.error, /`file` and `heading` are both required/);
    });
});

// ===========================================================================
// forgetMemory
// ===========================================================================

describe('forgetMemoryImpl', () => {

    test('without heading: deletes the entire file', async () => {
        store = makeStore({ quest: { 'facts.md': '# old' } });
        const r = JSON.parse(await withTiming('tomAi_forgetMemory:typical', () =>
            forgetMemoryImpl(store, { file: 'facts.md' })));
        assert.equal(r.action, 'deleted-file');
        assert.equal(store.raw.get('quest')!.has('facts.md'), false);
    });

    test('with heading: clears the section but preserves the heading', async () => {
        store = makeStore({ quest: { 'facts.md': '## Topic\n\nold body\n' } });
        const r = JSON.parse(await forgetMemoryImpl(store, { file: 'facts.md', heading: 'Topic' }));
        assert.equal(r.action, 'cleared-section');
        assert.match(r.note, /Heading is preserved/);
        // The replaceSection-with-empty path was taken
        const replaceCall = store.calls.find((c) => c.method === 'replaceSection');
        assert.ok(replaceCall);
        assert.equal(replaceCall.args[3], '');
    });

    test('WILDCARD DELETE rejected with a clear error pointing at listMemory', async () => {
        const r1 = JSON.parse(await forgetMemoryImpl(store, { file: '*.md' }));
        assert.match(r1.error, /Wildcard delete is not supported/);
        assert.match(r1.error, /tomAi_listMemory/);
        // Suite stayed intact
        assert.equal(store.calls.filter((c) => c.method === 'delete').length, 0);

        const r2 = JSON.parse(await forgetMemoryImpl(store, { file: 'facts?.md' }));
        assert.match(r2.error, /Wildcard delete is not supported/);
    });

    test('missing file → error', async () => {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const r = JSON.parse(await forgetMemoryImpl(store, {} as any));
        assert.match(r.error, /`file` is required/);
    });
});

// ===========================================================================
// readMemory
// ===========================================================================

describe('readMemoryImpl', () => {

    test('typical call: file in default quest scope returns body', async () => {
        store = makeStore({ quest: { 'facts.md': 'hello world' } });
        const out = await withTiming('tomAi_readMemory:typical', () =>
            readMemoryImpl(store, { file: 'facts.md' }));
        assert.equal(out, 'hello world');
    });

    test('missing file → (empty) marker', async () => {
        const out = await readMemoryImpl(store, { file: 'nope.md' });
        assert.equal(out, '(empty)');
    });

    test('scope: all merges shared + quest with labelled headers', async () => {
        store = makeStore({
            shared: { 'facts.md': 'shared body' },
            quest:  { 'facts.md': 'quest body' },
        });
        const out = await readMemoryImpl(store, { file: 'facts.md', scope: 'all' });
        assert.match(out, /### shared\/facts\.md/);
        assert.match(out, /shared body/);
        assert.match(out, /### quest\/facts\.md/);
        assert.match(out, /quest body/);
    });

    test('no file → concatenates every file in the scope', async () => {
        store = makeStore({
            quest: {
                'facts.md': 'a',
                'prefs.md': 'b',
            },
        });
        const out = await readMemoryImpl(store, {});
        assert.match(out, /### quest\/facts\.md/);
        assert.match(out, /### quest\/prefs\.md/);
        assert.match(out, /a/);
        assert.match(out, /b/);
    });

    test('SUFFIX FILTER: restricts to facts-<suffix>.md only', async () => {
        store = makeStore({
            quest: {
                'facts.md':         'default',
                'facts-gemma4.md':  'gemma profile',
                'prefs-gemma4.md':  'not a fact file',
            },
        });
        // No suffix → all 3 files in
        const all = await readMemoryImpl(store, {});
        assert.match(all, /default/);
        assert.match(all, /gemma profile/);
        assert.match(all, /not a fact file/);
        // suffix=gemma4 → ONLY facts-gemma4.md
        const filtered = await readMemoryImpl(store, { suffix: 'gemma4' });
        assert.doesNotMatch(filtered, /default/);
        assert.match(filtered, /gemma profile/);
        assert.doesNotMatch(filtered, /not a fact file/);
    });

    test('suffix ignored when explicit file passed', async () => {
        store = makeStore({ quest: { 'facts.md': 'explicit-file body' } });
        const out = await readMemoryImpl(store, { file: 'facts.md', suffix: 'gemma4' });
        assert.equal(out, 'explicit-file body');
    });

    test('empty scope with no suffix → "(no memory files in quest)"', async () => {
        const out = await readMemoryImpl(store, {});
        assert.equal(out, '(no memory files in quest)');
    });

    test('empty match for suffix → distinguishable error', async () => {
        store = makeStore({ quest: { 'facts.md': 'unrelated' } });
        const out = await readMemoryImpl(store, { suffix: 'no-match' });
        assert.match(out, /no memory files matching facts-no-match\.md/);
    });
});

// ===========================================================================
// listMemory
// ===========================================================================

describe('listMemoryImpl', () => {

    test('typical call: lists files in default quest scope', async () => {
        store = makeStore({ quest: { 'facts.md': 'x', 'prefs.md': 'y' } });
        const out = await withTiming('tomAi_listMemory:typical', () =>
            listMemoryImpl(store, {}));
        const lines = out.split('\n');
        assert.ok(lines.includes('quest/facts.md'));
        assert.ok(lines.includes('quest/prefs.md'));
        // Should NOT mix in any non-path lines
        for (const l of lines) {
            assert.match(l, /^quest\//);
        }
    });

    test('empty scope → explicit single-line marker (no path-like noise)', async () => {
        const out = await listMemoryImpl(store, { scope: 'quest' });
        assert.equal(out, '(no memory files in quest)');
        // Critically: no `quest/` prefix anywhere
        assert.doesNotMatch(out, /^quest\//);
    });

    test('scope: all enumerates both tiers', async () => {
        store = makeStore({
            shared: { 'globals.md': 'g' },
            quest: { 'facts.md': 'f' },
        });
        const out = await listMemoryImpl(store, { scope: 'all' });
        assert.match(out, /shared\/globals\.md/);
        assert.match(out, /quest\/facts\.md/);
    });

    test('SUFFIX FILTER: only facts-<suffix>.md entries surface', async () => {
        store = makeStore({
            quest: {
                'facts.md':         'a',
                'facts-gemma4.md':  'b',
                'prefs-gemma4.md':  'c',
            },
        });
        const out = await listMemoryImpl(store, { suffix: 'gemma4' });
        assert.equal(out, 'quest/facts-gemma4.md');
    });
});

// ===========================================================================
// Round-trip — save → list → read → update → forget
// ===========================================================================

describe('memory tools — round-trip', () => {

    test('save → list → read → update → forget produces the expected store mutations', async () => {
        store = makeStore();

        // 1) save
        await saveMemoryImpl(store, { content: 'fact body' });
        let listed = (await listMemoryImpl(store, {})).split('\n');
        assert.deepEqual(listed, ['quest/facts.md']);

        // 2) read
        let body = await readMemoryImpl(store, { file: 'facts.md' });
        assert.match(body, /fact body/);

        // 3) update (section)
        await updateMemoryImpl(store, { file: 'facts.md', heading: 'Project', content: 'Tom AI' });
        body = await readMemoryImpl(store, { file: 'facts.md' });
        assert.match(body, /## Project/);
        assert.match(body, /Tom AI/);

        // 4) forget (just the section)
        await forgetMemoryImpl(store, { file: 'facts.md', heading: 'Project' });
        body = await readMemoryImpl(store, { file: 'facts.md' });
        assert.match(body, /## Project/);   // heading preserved
        assert.doesNotMatch(body, /Tom AI/);  // body cleared

        // 5) forget (the whole file)
        await forgetMemoryImpl(store, { file: 'facts.md' });
        listed = (await listMemoryImpl(store, {})).split('\n');
        assert.deepEqual(listed, ['(no memory files in quest)']);
    });
});
