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
 * Grouping key of a todo id: everything before the id's FIRST digit.
 *
 * Returns `''` — meaning "no prefix" — when the id starts with a digit or
 * contains no digit at all. Separators are kept verbatim (`qr-4` → `qr-`):
 * the rule is the literal leading run of non-digits, not a normalised key, so
 * ids the author spelled differently stay in different groups.
 *
 * @param {unknown} id
 * @returns {string}
 */
function qtTodoPrefix(id) {
    if (id === null || id === undefined) { return ''; }
    var text = String(id);
    var firstDigit = /[0-9]/.exec(text);
    if (!firstDigit) { return ''; }
    return text.substring(0, firstDigit.index);
}

/**
 * Split a todo list into prefix groups for the list pane.
 *
 * Named groups keep **first-appearance order**, so whatever filter/sort the
 * user has applied still drives the layout; the `Unprefixed` catch-all is
 * always appended last. Order within a group is the incoming order.
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

    var groups = order.map(function(k) { return byKey[k]; });
    if (unprefixed) { groups.push(unprefixed); }
    return groups;
}
