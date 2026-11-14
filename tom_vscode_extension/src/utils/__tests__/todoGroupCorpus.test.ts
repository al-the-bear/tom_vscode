/**
 * The leading-number group rule keeps every todo of the workspace corpus in its group (vscimpb59).
 *
 * A group may be named with a leading number (`001_cleanup1` → group `001_cleanup`, todo 1). Before, the group of
 * an id was everything before its first digit and its number the first digit run. Over every id in
 * `_ai/**\/*.todo.yaml` (the corpus this workspace mounts), the panel's rule (media/questTodoPanel/grouping.js
 * `qtTodoPrefix`) and its TS mirror (`todoIdPrefix`) give the group the old rule gave, and the number after it is
 * the old number. Skipped where no corpus is mounted.
 *
 *   TG-1 every corpus id keeps its group and number; the panel and the TS mirror agree; an id starting with a digit
 *        (a group named with a leading number, which the old rule could not group) has a group and a number
 */

import test, { describe } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import vm from 'node:vm';

import { todoIdPrefix } from '../todoDestinationPicker.js';

const EXT_ROOT = path.join(__dirname, '..', '..', '..');
const AI = path.join(EXT_ROOT, '..', '..', '..', '_ai');

function corpusIds(): string[] {
    const ids: string[] = [];
    const walk = (dir: string): void => {
        for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
            if (e.name.startsWith('.')) { continue; }
            const p = path.join(dir, e.name);
            if (e.isDirectory()) { walk(p); } else if (e.name.endsWith('.todo.yaml')) {
                for (const m of fs.readFileSync(p, 'utf8').matchAll(/^\s*-?\s*id:\s*['"]?([^\s'"#]+)/gm)) { ids.push(m[1]); }
            }
        }
    };
    walk(AI);
    return ids;
}

function panelPrefix(): (id: string) => string {
    const sandbox: Record<string, unknown> = {};
    vm.createContext(sandbox);
    vm.runInContext(fs.readFileSync(path.join(EXT_ROOT, 'media', 'questTodoPanel', 'grouping.js'), 'utf8'), sandbox);
    return sandbox.qtTodoPrefix as (id: string) => string;
}

/** The rule before vscimpb59: everything before the first digit, the number the first digit run. */
function oldGroup(id: string): { prefix: string; number?: number } {
    const m = /[0-9]+/.exec(id);
    return m && m.index > 0 ? { prefix: id.slice(0, m.index), number: Number(m[0]) } : { prefix: '' };
}

describe('the leading-number group rule over the corpus', () => {
    const present = fs.existsSync(path.join(AI, 'quests'));
    test('TG-1: every corpus id keeps its group and number', { skip: present ? false : 'no _ai corpus mounted' }, () => {
        const qt = panelPrefix();
        const ids = corpusIds();
        assert.ok(ids.length > 100, `the corpus holds todos (${ids.length})`);
        const changed: string[] = [];
        for (const id of ids) {
            const prefix = todoIdPrefix(id);
            assert.equal(qt(id), prefix, `panel and TS agree on ${id}`);
            const before = oldGroup(id);
            const number = prefix ? Number(/^[0-9]+/.exec(id.slice(prefix.length))?.[0]) : undefined;
            if (/^[0-9]/.test(id)) {
                // A group named with a leading number: the old rule had no group for it, so there is nothing to keep.
                if (!prefix || number === undefined || Number.isNaN(number)) { changed.push(`${id}: no group and number → ${prefix}/${number}`); }
                continue;
            }
            if (prefix !== before.prefix || number !== before.number) { changed.push(`${id}: ${before.prefix}/${before.number} → ${prefix}/${number}`); }
        }
        assert.deepEqual(changed, []);
    });
});
