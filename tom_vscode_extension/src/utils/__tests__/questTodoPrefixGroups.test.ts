/**
 * Prefix grouping for the Quest TODO list (`media/questTodoPanel/grouping.js`).
 *
 * The grouping rule is pure string logic, so it lives in its own webview script
 * with no DOM or `vscode` dependency and is loaded into a bare `vm` context
 * here. That means these tests exercise the **actual runtime file** the panel
 * ships — there is no TS mirror of the rule that could drift out of sync (the
 * hazard `qtIsTerminalTodoFileName` lives with).
 */

import test, { describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import vm from 'node:vm';

interface TodoLike { id?: unknown; title?: string }
interface PrefixGroup { prefix: string; label: string; todos: TodoLike[] }

interface GroupingApi {
    QT_UNPREFIXED_LABEL: string;
    qtTodoPrefix(id: unknown): string;
    qtGroupTodosByPrefix(todos: TodoLike[] | null | undefined): PrefixGroup[];
}

/**
 * Load the real webview script into a bare sandbox. Top-level `function`
 * declarations in a classic script become globals, so the sandbox object *is*
 * the module surface.
 */
function loadGrouping(): GroupingApi {
    // out/utils/__tests__ -> project root is three levels up, then media/...
    const src = readFileSync(
        join(__dirname, '..', '..', '..', 'media', 'questTodoPanel', 'grouping.js'),
        'utf-8',
    );
    const sandbox: Record<string, unknown> = {};
    vm.createContext(sandbox);
    vm.runInContext(src, sandbox);
    return sandbox as unknown as GroupingApi;
}

/**
 * Group labels in render order — the assertion most tests care about.
 *
 * `Array.from` rather than `.map`: arrays built inside the sandbox carry the
 * sandbox realm's `Array.prototype`, which `deepStrictEqual` treats as a
 * mismatch even for identical contents. Rebuilding in the host realm keeps the
 * element-wise comparison exact.
 */
function labels(groups: PrefixGroup[]): string[] {
    return Array.from(groups, (g) => g.label);
}

/** Todo ids per group, in render order (host-realm array — see {@link labels}). */
function idsOf(group: PrefixGroup): unknown[] {
    return Array.from(group.todos, (t) => t.id);
}

describe('qtTodoPrefix', () => {
    const api = loadGrouping();

    test('takes the characters before the first digit', () => {
        assert.equal(api.qtTodoPrefix('qr3-20260723-inflight-repetition'), 'qr');
        assert.equal(api.qtTodoPrefix('vex1_agäo-add-retry-backoff'), 'vex');
        assert.equal(api.qtTodoPrefix('TRA02'), 'TRA');
    });

    test('is case-sensitive — the id is taken as written', () => {
        // Deliberate: the rule is "the initial characters", not "a normalised
        // key". Folding case would silently merge two ids the author chose to
        // spell differently.
        assert.notEqual(api.qtTodoPrefix('TRA02'), api.qtTodoPrefix('tra02'));
        assert.equal(api.qtTodoPrefix('tra02'), 'tra');
    });

    test('ids starting with a digit have no prefix', () => {
        assert.equal(api.qtTodoPrefix('1abc'), '');
        assert.equal(api.qtTodoPrefix('42'), '');
    });

    test('ids without any digit have no prefix', () => {
        assert.equal(api.qtTodoPrefix('cleanup'), '');
        assert.equal(api.qtTodoPrefix('some-todo-id'), '');
    });

    test('non-string / missing ids have no prefix', () => {
        assert.equal(api.qtTodoPrefix(''), '');
        assert.equal(api.qtTodoPrefix(undefined), '');
        assert.equal(api.qtTodoPrefix(null), '');
    });

    test('separators are kept verbatim — no trimming', () => {
        // The spec is literally "the initial characters before the first
        // digit", so `qr-` and `qr` are different prefixes. Trimming would be
        // a guess about the author's naming convention.
        assert.equal(api.qtTodoPrefix('qr-4'), 'qr-');
        assert.equal(api.qtTodoPrefix('todo-1a2b'), 'todo-');
    });
});

describe('qtGroupTodosByPrefix', () => {
    const api = loadGrouping();

    test('groups consecutive and non-consecutive todos under one prefix', () => {
        const groups = api.qtGroupTodosByPrefix([
            { id: 'qr1-a' }, { id: 'vex2-b' }, { id: 'qr3-c' },
        ]);
        assert.deepEqual(labels(groups), ['qr', 'vex']);
        assert.deepEqual(idsOf(groups[0]), ['qr1-a', 'qr3-c']);
        assert.deepEqual(idsOf(groups[1]), ['vex2-b']);
    });

    test('keeps groups in first-appearance order, so the active sort survives', () => {
        const groups = api.qtGroupTodosByPrefix([
            { id: 'zz9' }, { id: 'aa1' }, { id: 'mm5' },
        ]);
        assert.deepEqual(labels(groups), ['zz', 'aa', 'mm']);
    });

    test('preserves the incoming order of todos within a group', () => {
        const groups = api.qtGroupTodosByPrefix([
            { id: 'qr9-late' }, { id: 'qr1-early' },
        ]);
        assert.deepEqual(idsOf(groups[0]), ['qr9-late', 'qr1-early']);
    });

    test('collects prefix-less todos into the Unprefixed group', () => {
        const groups = api.qtGroupTodosByPrefix([
            { id: 'qr1-a' }, { id: 'cleanup' }, { id: '7-seven' },
        ]);
        assert.deepEqual(labels(groups), ['qr', api.QT_UNPREFIXED_LABEL]);
        assert.deepEqual(idsOf(groups[1]), ['cleanup', '7-seven']);
        assert.equal(groups[1].prefix, '', 'the catch-all group is keyed by the empty prefix');
    });

    test('puts the Unprefixed group last even when it appears first', () => {
        const groups = api.qtGroupTodosByPrefix([
            { id: 'cleanup' }, { id: 'qr1-a' },
        ]);
        assert.deepEqual(labels(groups), ['qr', api.QT_UNPREFIXED_LABEL]);
    });

    test('emits no Unprefixed group when every todo has a prefix', () => {
        const groups = api.qtGroupTodosByPrefix([{ id: 'qr1-a' }, { id: 'vex2-b' }]);
        assert.deepEqual(labels(groups), ['qr', 'vex']);
    });

    test('groups todos whose prefix collides with an Object.prototype key', () => {
        // A plain `{}` lookup table reports `constructor` / `toString` as
        // already present, which would silently drop every such todo. The
        // implementation must namespace its keys.
        const groups = api.qtGroupTodosByPrefix([
            { id: 'constructor1' }, { id: 'toString2' }, { id: 'constructor3' },
        ]);
        assert.deepEqual(labels(groups), ['constructor', 'toString']);
        assert.deepEqual(idsOf(groups[0]), ['constructor1', 'constructor3']);
        assert.deepEqual(idsOf(groups[1]), ['toString2']);
    });

    test('returns no groups for an empty or missing list', () => {
        assert.equal(api.qtGroupTodosByPrefix([]).length, 0);
        assert.equal(api.qtGroupTodosByPrefix(undefined).length, 0);
        assert.equal(api.qtGroupTodosByPrefix(null).length, 0);
    });

    test('every todo lands in exactly one group', () => {
        const todos: TodoLike[] = [
            { id: 'qr1' }, { id: 'vex2' }, { id: 'cleanup' }, { id: 'qr2' }, { id: '9' },
        ];
        const groups = api.qtGroupTodosByPrefix(todos);
        const flat: TodoLike[] = [];
        for (const g of groups) { flat.push(...g.todos); }
        assert.equal(flat.length, todos.length, 'no todo may be dropped or duplicated');
        assert.equal(new Set(flat).size, todos.length);
    });
});
