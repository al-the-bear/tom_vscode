// Quest TODO panel — prefix grouping.
//
// Pure string/array logic with no DOM and no `vscode` handle, kept in its own
// file so it can be loaded into a bare `vm` sandbox and unit-tested directly
// (src/utils/__tests__/questTodoPrefixGroups.test.ts). Prepended to main.js by
// getQuestTodoScript(); classic script, so the declarations below are globals
// that main.js can call.

/** Label of the catch-all group for todos whose id yields no prefix. */
var QT_UNPREFIXED_LABEL = 'Unprefixed';

/**
 * @typedef {{ id?: unknown }} QtTodoLike
 * @typedef {{ prefix: string, label: string, todos: QtTodoLike[] }} QtPrefixGroup
 */

/**
 * Grouping key of a todo id (tom_todo_model `tomTodoGroupOf`): a leading
 * number is part of the group's name and only sorts the groups
 * (`001_cleanup1` → `001_cleanup`); after it, everything up to the first
 * digit, which starts the todo's number.
 *
 * Returns `''` — meaning "no prefix" — when no number follows the prefix
 * (`aaa_cleanup`, `001_cleanup`). Separators are kept verbatim (`qr-4` →
 * `qr-`): the rule is the literal text, not a normalised key, so ids the
 * author spelled differently stay in different groups.
 *
 * @param {unknown} id
 * @returns {string}
 */
function qtTodoPrefix(id) {
    if (id === null || id === undefined) { return ''; }
    var m = /^([0-9]*)([^0-9]*)[0-9]/.exec(String(id));
    // A leading number names a group only together with the text after it.
    if (!m || (m[1] && !m[2])) { return ''; }
    return m[1] + m[2];
}

/**
 * Natural order of two strings: digit runs compare by value (`qr2` before
 * `qr10`), letters without regard to case; equal that way, by code point, so
 * the order is total and the same on every machine.
 *
 * @param {string} a
 * @param {string} b
 * @returns {number}
 */
function qtNaturalCompare(a, b) {
    var cmp = a.localeCompare(b, 'en', { numeric: true, sensitivity: 'base' });
    if (cmp !== 0) { return cmp; }
    return a < b ? -1 : a > b ? 1 : 0;
}

/** @param {QtTodoLike} t */
function qtIdText(t) {
    return t && t.id !== null && t.id !== undefined ? String(t.id) : '';
}

/**
 * Compare two todos by id in natural order (`qr2` before `qr10`) — the
 * list's `id` sort, and its order when no sort is chosen.
 *
 * @param {QtTodoLike} a
 * @param {QtTodoLike} b
 * @returns {number}
 */
function qtCompareTodoIds(a, b) {
    return qtNaturalCompare(qtIdText(a), qtIdText(b));
}

/**
 * Split a todo list into prefix groups for the list pane.
 *
 * The groups are **sorted naturally by prefix** (`001_cleanup` before `002_x` before `qr`), the `Unprefixed`
 * catch-all last — whatever the list's sort and filter, so every group is
 * always in the same place. Inside a group the todos keep the incoming order:
 * the list's sort (by id in natural order when none is chosen). The filter
 * still decides which todos appear.
 *
 * @param {QtTodoLike[] | null | undefined} todos
 * @returns {QtPrefixGroup[]}
 */
function qtGroupTodosByPrefix(todos) {
    var list = todos || [];
    // '#'-namespaced keys: a bare `{}` lookup reports inherited names such as
    // `constructor` and `toString` as already present, which would drop every
    // todo whose prefix happens to spell one.
    /** @type {Record<string, QtPrefixGroup>} */
    var byKey = {};
    /** @type {string[]} */
    var order = [];
    /** @type {QtPrefixGroup | null} */
    var unprefixed = null;

    for (var i = 0; i < list.length; i++) {
        var todo = list[i];
        var prefix = qtTodoPrefix(todo ? todo.id : undefined);
        if (!prefix) {
            if (!unprefixed) { unprefixed = { prefix: '', label: QT_UNPREFIXED_LABEL, todos: [] }; }
            unprefixed.todos.push(todo);
            continue;
        }
        var key = '#' + prefix;
        if (!Object.prototype.hasOwnProperty.call(byKey, key)) {
            byKey[key] = { prefix: prefix, label: prefix, todos: [] };
            order.push(key);
        }
        byKey[key].todos.push(todo);
    }

    var groups = order
        .map(function(k) { return byKey[k]; })
        .sort(/** @param {QtPrefixGroup} a @param {QtPrefixGroup} b */ function(a, b) { return qtNaturalCompare(a.prefix, b.prefix); });
    if (unprefixed) { groups.push(unprefixed); }
    return groups;
}

/**
 * @typedef {{ ref: string, quest?: string, id?: string, title?: string, status?: string, found?: boolean }} QtGroupMemberInfo
 * @typedef {{ id?: unknown, title?: string, status?: string, comprised_of?: string[], group_members?: QtGroupMemberInfo[] }} QtGroupTodoLike
 * @typedef {{ ref: string, row: QtTodoLike | null, title: string, status: string, foreign: boolean, found: boolean }} QtGroupMember
 * @typedef {{ todo: QtGroupTodoLike, members: QtGroupMember[], done: number, total: number }} QtTodoGroup
 */

/** Statuses a group member counts as done with. */
var QT_GROUP_DONE = ['completed', 'cancelled'];

/**
 * The todo groups of a list (vscimpb126): every todo with status `group` or a
 * `comprised_of`, sorted by title (natural order), each with its members in
 * `comprised_of` order and its progress (done / all, counted over every
 * member, whatever the filter).
 *
 * A member of this quest is shown by its row when `todos` (the filtered list)
 * holds it; one the filter hides is left out (`row` null and not foreign —
 * the caller skips it). A member of another quest (`<quest>/<id>`) has no row
 * here and is shown by its ref, title and status (`foreign`).
 *
 * @param {QtGroupTodoLike[] | null | undefined} todos the list's (filtered) rows
 * @param {string} questId the list's quest; a member ref `<questId>/<id>` is this quest's
 * @returns {QtTodoGroup[]}
 */
function qtTodoGroupsOf(todos, questId) {
    var list = todos || [];
    /** @type {Record<string, QtGroupTodoLike>} */
    var byId = {};
    for (var i = 0; i < list.length; i++) {
        if (list[i] && list[i].id !== null && list[i].id !== undefined) { byId['#' + String(list[i].id)] = list[i]; }
    }
    /** @type {QtTodoGroup[]} */
    var out = [];
    for (var k = 0; k < list.length; k++) {
        var t = list[k];
        if (!t) { continue; }
        var comprised = Array.isArray(t.comprised_of) ? t.comprised_of : [];
        if (t.status !== 'group' && !comprised.length) { continue; }
        /** @type {QtGroupMemberInfo[]} */
        var infos = Array.isArray(t.group_members) && t.group_members.length === comprised.length
            ? t.group_members
            : comprised.map(function(ref) { return { ref: ref }; });
        /** @type {QtGroupMember[]} */
        var members = infos.map(function(m) {
            var ref = String(m.ref);
            var slash = ref.indexOf('/');
            var local = slash < 0 || (!!questId && ref.slice(0, slash) === questId);
            var localId = slash < 0 ? ref : ref.slice(slash + 1);
            var row = local && Object.prototype.hasOwnProperty.call(byId, '#' + localId) ? byId['#' + localId] : null;
            return {
                ref: ref,
                row: row,
                title: String((row && row.title) || m.title || ''),
                status: String((row && row.status) || m.status || ''),
                foreign: !local,
                found: !!row || m.found === true,
            };
        });
        var done = 0;
        for (var d = 0; d < infos.length; d++) {
            var st = members[d].row ? members[d].status : String(infos[d].status || '');
            if (QT_GROUP_DONE.indexOf(st) >= 0) { done++; }
        }
        out.push({ todo: t, members: members, done: done, total: members.length });
    }
    out.sort(/** @param {QtTodoGroup} a @param {QtTodoGroup} b */ function(a, b) {
        return qtNaturalCompare(String(a.todo.title || a.todo.id || ''), String(b.todo.title || b.todo.id || ''));
    });
    return out;
}
