/**
 * The todo id rule read from the todo schema (utils/todoIdRule, vscimpb60).
 *
 *   IR-1 the pattern and its words come from `$defs.todo.properties.id` of the schema under the workspace root; no
 *        schema, no check
 *   IR-2 the workspace's schema: `_cleanup1`, `-x`, `1234` and `Bad1` refused with the rule named, `cleanup1_akkj-x`
 *        and `001_cleanup1` accepted; several ids: the first named, the others listed
 *   IR-3 the todo panel checks it in place: the ID edit, the group rename (its dry run) and both moves with renumbering
 *   IR-4 a move with renumbering keeps the tail after the id's own number, a leading-number group included
 */

import test, { after, describe } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';

import { TODO_SCHEMA_RELATIVE_PATH, todoIdRule, todoIdRuleError, todoIdsRuleError } from '../todoIdRule.js';
import { todoRenames } from '../todoDestinationPicker.js';

const EXT_ROOT = path.join(__dirname, '..', '..', '..');
const WS = path.join(EXT_ROOT, '..', '..', '..');
const SANDBOX = fs.mkdtempSync(path.join(WS, 'ztmp', 'vscode_extension_261112_vscimpb60_rule-'));
after(() => fs.rmSync(SANDBOX, { recursive: true, force: true }));

describe('the todo id rule, from the schema', () => {
    test('IR-1: read from the schema; none, no check', () => {
        assert.equal(todoIdRule(SANDBOX), undefined);
        assert.equal(todoIdRuleError('_x', SANDBOX), undefined);
        const file = path.join(SANDBOX, TODO_SCHEMA_RELATIVE_PATH);
        fs.mkdirSync(path.dirname(file), { recursive: true });
        fs.writeFileSync(file, JSON.stringify({ $defs: { todo: { properties: { id: { type: 'string', pattern: '^[a-z]+[0-9]*$', description: 'An id (letters, then digits). More.' } } } } }));
        const rule = todoIdRule(SANDBOX);
        assert.deepEqual({ pattern: rule?.pattern, words: rule?.words }, { pattern: '^[a-z]+[0-9]*$', words: 'letters, then digits' });
        assert.equal(todoIdRuleError('ab12', SANDBOX), undefined);
        assert.equal(todoIdRuleError('12ab', SANDBOX), '"12ab" is no todo id: the todo schema (_ai/schemas/yaml/todo.schema.json) requires letters, then digits — pattern ^[a-z]+[0-9]*$.');
    });

    test('IR-2: the workspace\'s schema', { skip: fs.existsSync(path.join(WS, TODO_SCHEMA_RELATIVE_PATH)) ? false : 'no schema' }, () => {
        for (const bad of ['_cleanup1', '-x', '1234', 'Bad1', 'a b']) {
            assert.match(todoIdRuleError(bad, WS) ?? '', /is no todo id: the todo schema .* requires lowercase letters.* — pattern \^/, bad);
        }
        for (const good of ['cleanup1_akkj-x', '001_cleanup1', 'vex1_agäo-add']) { assert.equal(todoIdRuleError(good, WS), undefined, good); }
        assert.match(todoIdsRuleError(['ok1', '_a1', '_b2'], WS) ?? '', /^"_a1" is no todo id.* Also refused: _b2\.$/);
        assert.equal(todoIdsRuleError(['ok1', 'ok2'], WS), undefined);
    });

    test('IR-3: the panel checks it in place', () => {
        const handler = fs.readFileSync(path.join(EXT_ROOT, 'src', 'handlers', 'questTodoPanel-handler.ts'), 'utf8');
        assert.match(handler, /validateInput: \(value\) => todoIdInputError\(value, oldId, taken\) \?\? \(value\.trim\(\) !== oldId \? questTodo\.todoIdRefusal\(value\.trim\(\)\)/);
        assert.match(handler, /const plan = questTodo\.renameTodoPrefix\(questId, from, value, \{ dryRun: true \}\);\s*if \(!plan\.ok\) \{ return plan\.reason; \}/);
        assert.equal((handler.match(/validateTodoPrefix\(value\) \?\? questTodo\.todoIdsRefusal\(todoRenames\(/g) ?? []).length, 2, 'both custom-prefix boxes');
        assert.equal((handler.match(/const refused = questTodo\.todoIdsRefusal\(renames\.values\(\)\);/g) ?? []).length, 2, 'both moves, a picked group too');
    });

    test('IR-4: the tail after the id\'s own number', () => {
        assert.deepEqual([...todoRenames(['001_cleanup3_akkj-x', 'ab2-y', 'plain'], ['qq1'], 'qq').values()], ['qq2_akkj-x', 'qq3-y', 'qq4-plain']);
    });
});
