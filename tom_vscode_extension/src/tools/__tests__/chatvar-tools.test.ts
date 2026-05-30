/**
 * Tool-impl tests for `chatvar-tools.ts` — `tomAi_readChatVariable`,
 * `tomAi_writeChatVariable`.
 *
 * Strategy: a small in-memory `ChatVariablesAccess` fake — Map-backed,
 * mirrors the production rule "empty string = delete". The real
 * `ChatVariablesStore` is its own thing (persists to YAML, emits
 * change events, owns a change log); here we pin only the tool-
 * orchestration layer.
 *
 * Coverage entry #14 four-row checklist:
 *
 *   a) Description clarity — verified in the impl file (every
 *      built-in named, persistence spelled out, custom.* prefix
 *      idempotency).
 *   b) Ambiguities — covered:
 *        - write-then-read consistency
 *        - type coercion: string/number/boolean/null/undefined/object
 *        - unknown variable name is distinguishable (`exists: false`)
 *        - custom.-prefix idempotency: `myKey` vs `custom.myKey` same
 *        - empty-string deletion semantics
 *        - built-in-key write rejection with structured reason
 *   c) Tests via fake `ChatVariablesAccess`.
 *   d) Timing — both typical cases sub-ms via `withTiming`.
 */

import test, { beforeEach, describe } from 'node:test';
import assert from 'node:assert/strict';

import { withTiming } from './_timing.js';
import {
    readChatVariableImpl,
    writeChatVariableImpl,
    type ChatVariablesAccess,
    type ChatVariablesPublicSnapshot,
} from '../chatvar-tools.js';

// ---------------------------------------------------------------------------
// In-memory fake matching production behaviour:
//   - built-ins always exist (default empty)
//   - custom is a Map; setCustomBulk with empty value deletes
//   - has() distinguishes "set to empty" from "never set" for custom
// ---------------------------------------------------------------------------

interface FakeOpts {
    builtIns?: Partial<Pick<ChatVariablesPublicSnapshot, 'quest' | 'role' | 'activeProjects' | 'todo' | 'todoFile'>>;
    custom?: Record<string, string>;
}

function makeAccess(opts: FakeOpts = {}): ChatVariablesAccess & {
    builtIns: { quest: string; role: string; activeProjects: string[]; todo: string; todoFile: string };
    custom: Map<string, string>;
    bulkCalls: Array<Record<string, string>>;
} {
    const builtIns = {
        quest: opts.builtIns?.quest ?? '',
        role: opts.builtIns?.role ?? '',
        activeProjects: opts.builtIns?.activeProjects ?? [],
        todo: opts.builtIns?.todo ?? '',
        todoFile: opts.builtIns?.todoFile ?? 'all',
    };
    const custom = new Map<string, string>(Object.entries(opts.custom ?? {}));
    const bulkCalls: Array<Record<string, string>> = [];
    return {
        builtIns, custom, bulkCalls,
        getRaw(key) {
            switch (key) {
                case 'quest': return builtIns.quest;
                case 'role': return builtIns.role;
                case 'activeProjects': return [...builtIns.activeProjects];
                case 'todo': return builtIns.todo;
                case 'todoFile': return builtIns.todoFile;
                default: return custom.get(key) ?? '';
            }
        },
        has(key) {
            if (key === 'quest' || key === 'role' || key === 'activeProjects' || key === 'todo' || key === 'todoFile') {
                return true;
            }
            return custom.has(key);
        },
        snapshot() {
            return {
                quest: builtIns.quest,
                role: builtIns.role,
                activeProjects: [...builtIns.activeProjects],
                todo: builtIns.todo,
                todoFile: builtIns.todoFile,
                custom: Object.fromEntries(custom.entries()),
            };
        },
        setCustomBulk(values) {
            bulkCalls.push({ ...values });
            for (const [k, v] of Object.entries(values)) {
                if (v === '') { custom.delete(k); }
                else { custom.set(k, v); }
            }
        },
    };
}

let access: ReturnType<typeof makeAccess>;
beforeEach(() => { access = makeAccess(); });

// ===========================================================================
// readChatVariable
// ===========================================================================

describe('readChatVariableImpl', () => {

    test('typical call: full snapshot when no key', async () => {
        access = makeAccess({
            builtIns: { quest: 'vscode_extension', role: 'engineer', activeProjects: ['tom_vscode_extension'], todo: '', todoFile: 'all' },
            custom: { myKey: 'myValue' },
        });
        const raw = await withTiming('tomAi_readChatVariable:typical', () =>
            readChatVariableImpl(access, {}));
        const r = JSON.parse(raw);
        assert.equal(r.quest, 'vscode_extension');
        assert.deepEqual(r.activeProjects, ['tom_vscode_extension']);
        assert.deepEqual(r.custom, { myKey: 'myValue' });
        // changeLog is intentionally omitted from the tool response
        assert.equal(r.changeLog, undefined);
    });

    test('single built-in key returns {key, value, exists: true, isBuiltIn: true}', async () => {
        access = makeAccess({ builtIns: { quest: 'demo_quest' } });
        const r = JSON.parse(await readChatVariableImpl(access, { key: 'quest' }));
        assert.equal(r.key, 'quest');
        assert.equal(r.value, 'demo_quest');
        assert.equal(r.exists, true);
        assert.equal(r.isBuiltIn, true);
    });

    test('single custom key returns {key, value, exists: true} for a known key', async () => {
        access = makeAccess({ custom: { foo: 'bar' } });
        const r = JSON.parse(await readChatVariableImpl(access, { key: 'foo' }));
        assert.equal(r.value, 'bar');
        assert.equal(r.exists, true);
        assert.equal(r.isBuiltIn, false);
    });

    test('UNKNOWN custom key returns exists:false (distinguishable from empty value)', async () => {
        access = makeAccess({ custom: { wasSetToEmpty: '' } });
        // wasSetToEmpty exists, value = ''
        const r1 = JSON.parse(await readChatVariableImpl(access, { key: 'wasSetToEmpty' }));
        assert.equal(r1.value, '');
        assert.equal(r1.exists, true, 'set-to-empty must report exists:true');
        // neverSet does not exist
        const r2 = JSON.parse(await readChatVariableImpl(access, { key: 'neverSet' }));
        assert.equal(r2.value, '');
        assert.equal(r2.exists, false, 'never-set must report exists:false');
    });

    test('CUSTOM.-PREFIX IDEMPOTENCY: `myKey` and `custom.myKey` resolve to the same value', async () => {
        access = makeAccess({ custom: { foo: 'bar' } });
        const r1 = JSON.parse(await readChatVariableImpl(access, { key: 'foo' }));
        const r2 = JSON.parse(await readChatVariableImpl(access, { key: 'custom.foo' }));
        assert.equal(r1.value, r2.value);
        assert.equal(r1.key, r2.key);   // both report the stripped form
        assert.equal(r1.key, 'foo');
    });
});

// ===========================================================================
// writeChatVariable
// ===========================================================================

describe('writeChatVariableImpl', () => {

    test('typical call: creates a custom variable, reports created list', async () => {
        const raw = await withTiming('tomAi_writeChatVariable:typical', () =>
            writeChatVariableImpl(access, { variables: { newKey: 'val' } }));
        const r = JSON.parse(raw);
        assert.equal(r.ok, true);
        assert.deepEqual(r.accepted.created, ['newKey']);
        assert.deepEqual(r.accepted.updated, []);
        assert.deepEqual(r.accepted.deleted, []);
        assert.deepEqual(r.rejected, []);
        assert.equal(access.custom.get('newKey'), 'val');
    });

    test('updating an existing key surfaces in `updated`, not `created`', async () => {
        access = makeAccess({ custom: { existing: 'old' } });
        const r = JSON.parse(await writeChatVariableImpl(access, { variables: { existing: 'new' } }));
        assert.deepEqual(r.accepted.created, []);
        assert.deepEqual(r.accepted.updated, ['existing']);
        assert.equal(access.custom.get('existing'), 'new');
    });

    test('EMPTY-STRING DELETES an existing key (surfaces in `deleted`)', async () => {
        access = makeAccess({ custom: { toRemove: 'present' } });
        const r = JSON.parse(await writeChatVariableImpl(access, { variables: { toRemove: '' } }));
        assert.deepEqual(r.accepted.deleted, ['toRemove']);
        assert.equal(access.custom.has('toRemove'), false);
    });

    test('EMPTY-STRING on UNKNOWN key is rejected (not silent no-op)', async () => {
        const r = JSON.parse(await writeChatVariableImpl(access, { variables: { neverWritten: '' } }));
        assert.equal(r.ok, false);
        assert.deepEqual(r.accepted.created, []);
        assert.equal(r.rejected.length, 1);
        assert.equal(r.rejected[0].key, 'neverWritten');
        assert.match(r.rejected[0].reason, /would set\/delete-nothing/);
        assert.equal(access.custom.has('neverWritten'), false);
    });

    test('BUILT-IN keys rejected with structured reason', async () => {
        const r = JSON.parse(await writeChatVariableImpl(access, {
            variables: { quest: 'tryToOverwrite', role: 'tryAgain' },
        }));
        assert.equal(r.ok, false);
        assert.equal(r.rejected.length, 2);
        assert.equal(r.rejected[0].key, 'quest');
        assert.match(r.rejected[0].reason, /built-in.*user-only/);
        // CRITICAL: nothing landed in custom
        assert.equal(access.custom.size, 0);
    });

    test('CUSTOM.-PREFIX IDEMPOTENCY on write: `custom.foo` and `foo` write the same key', async () => {
        await writeChatVariableImpl(access, { variables: { 'custom.foo': 'one' } });
        await writeChatVariableImpl(access, { variables: { foo: 'two' } });
        // Final value is "two"; only one custom entry exists
        assert.equal(access.custom.size, 1);
        assert.equal(access.custom.get('foo'), 'two');
    });

    test('empty NAME (after stripping prefix) rejected', async () => {
        const r = JSON.parse(await writeChatVariableImpl(access, { variables: { 'custom.': 'x' } }));
        assert.equal(r.ok, false);
        assert.match(r.rejected[0].reason, /empty name/);
    });

    test('TYPE COERCION: number/boolean coerced via String()', async () => {
        await writeChatVariableImpl(access, {
            variables: {
                // eslint-disable-next-line @typescript-eslint/no-explicit-any
                myNumber: 42 as any,
                // eslint-disable-next-line @typescript-eslint/no-explicit-any
                myBool: true as any,
            },
        });
        assert.equal(access.custom.get('myNumber'), '42');
        assert.equal(access.custom.get('myBool'), 'true');
    });

    test('TYPE COERCION: null and undefined → empty string (= delete-if-present)', async () => {
        access = makeAccess({ custom: { existing: 'present' } });
        await writeChatVariableImpl(access, {
            variables: {
                // eslint-disable-next-line @typescript-eslint/no-explicit-any
                existing: null as any,
            },
        });
        assert.equal(access.custom.has('existing'), false, 'null coerces to "" which deletes when key exists');
    });

    test('TYPE COERCION: object → String(value) is documented as the "[object Object]" trap', async () => {
        await writeChatVariableImpl(access, {
            variables: {
                // eslint-disable-next-line @typescript-eslint/no-explicit-any
                blob: { nested: true } as any,
            },
        });
        // The documented behaviour is `String({...})` = `"[object Object]"`
        assert.equal(access.custom.get('blob'), '[object Object]');
    });

    test('mixed batch: created + updated + deleted + rejected all reported', async () => {
        access = makeAccess({ custom: { keepMe: 'original', toRemove: 'bye' } });
        const r = JSON.parse(await writeChatVariableImpl(access, {
            variables: {
                brandNew: 'hi',
                keepMe: 'updated',
                toRemove: '',
                quest: 'nope',     // rejected (built-in)
                neverHere: '',     // rejected (empty on unknown)
            },
        }));
        assert.deepEqual(r.accepted.created.sort(), ['brandNew']);
        assert.deepEqual(r.accepted.updated, ['keepMe']);
        assert.deepEqual(r.accepted.deleted, ['toRemove']);
        assert.equal(r.rejected.length, 2);
        assert.equal(r.ok, false);
    });
});

// ===========================================================================
// write → read round-trip (write-then-read consistency)
// ===========================================================================

describe('chatvar — write/read round-trip', () => {

    test('write then read returns the written value (consistency proof)', async () => {
        await writeChatVariableImpl(access, { variables: { roundtrip: 'ping' } });
        const r = JSON.parse(await readChatVariableImpl(access, { key: 'roundtrip' }));
        assert.equal(r.value, 'ping');
        assert.equal(r.exists, true);
    });

    test('write-delete then read returns exists:false (delete is visible to read)', async () => {
        await writeChatVariableImpl(access, { variables: { temp: 'value' } });
        await writeChatVariableImpl(access, { variables: { temp: '' } });
        const r = JSON.parse(await readChatVariableImpl(access, { key: 'temp' }));
        assert.equal(r.exists, false);
        assert.equal(r.value, '');
    });

    test('write under custom.-prefix then read under bare name returns the value', async () => {
        await writeChatVariableImpl(access, { variables: { 'custom.aliased': 'value' } });
        const r = JSON.parse(await readChatVariableImpl(access, { key: 'aliased' }));
        assert.equal(r.value, 'value');
        assert.equal(r.exists, true);
    });
});
