/**
 * The module catalogue of `_copilot_guidelines/architecture.md` names every module of `src/` (qrfix13;
 * scripts/check-module-catalogue.cjs, `npm run check:module-catalogue`).
 *
 *   MC-1 the catalogue as it is: every non-test module of src/ is named in its folder's row, every top-level file
 *        has a row, no row names a module deleted from src/, and no row claims a module of another folder
 *   MC-2 the check on a small tree: a module missing from its row, a folder without a row, a name of a deleted
 *        module, a module claimed by the wrong row are reported; a module named by its base name or `sub/name`, a
 *        schema without `.json`, and a cross-reference written with its folder (`services/x`) pass; tests and
 *        `.d.ts` files are not modules
 */

import test, { describe } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'fs';
import * as path from 'path';

const EXT = path.resolve(__dirname, '..', '..', '..');
// eslint-disable-next-line @typescript-eslint/no-require-imports
const catalogue = require(path.join(EXT, 'scripts', 'check-module-catalogue.cjs')) as {
    check(o?: { root?: string; text?: string; removed?: Set<string> }): {
        missing: Array<{ folder: string; module: string | null }>;
        removed: Array<{ folder: string; name: string }>;
        misplaced: Array<{ folder: string; name: string; in: string[] }>;
    };
};

function tree(files: Record<string, string>): string {
    const base = path.join(EXT, '..', '..', '..', 'ztmp');
    fs.mkdirSync(base, { recursive: true });
    const root = fs.mkdtempSync(path.join(base, 'vscode_extension_261115_qrfix13_catalogue-'));
    for (const [rel, text] of Object.entries(files)) {
        fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true });
        fs.writeFileSync(path.join(root, rel), text);
    }
    return root;
}

const table = (rows: string[]): string => ['# Architecture', '', '## Module catalogue (`src/`)', '', '| Folder | Modules |', '| --- | --- |', ...rows, '', '## Next', ''].join('\n');

describe('the module catalogue', () => {
    test('MC-1: every module of src/ is named, nothing removed or misplaced', () => {
        const r = catalogue.check();
        assert.deepEqual(r.missing, [], `missing from the catalogue: ${r.missing.map((m) => `${m.folder}${m.module ?? '(row)'}`).join(', ')}`);
        assert.deepEqual(r.removed, [], 'names of removed modules');
        assert.deepEqual(r.misplaced, [], 'modules claimed by the wrong row (write a cross-reference with its folder: `services/x`)');
    });

    test('MC-2: the check on a small tree', () => {
        const root = tree({
            'src/extension.ts': '',
            'src/handlers/a-handler.ts': '', 'src/handlers/chat/b.ts': '', 'src/handlers/__tests__/a.test.ts': '',
            'src/services/x.ts': '', 'src/services/y.ts': '', 'src/services/types.d.ts': '',
            'src/config/c.schema.json': '',
            'src/utils/u.ts': '',
        });
        try {
            const text = table([
                '| `extension.ts` | Activation. |',
                '| `handlers/` | `a-handler` (uses `services/x`), `chat/b` |',
                '| `services/` | `x` and `gone` (deleted), also `u` |',
                '| `config/` | the `c.schema` file |',
            ]);
            const r = catalogue.check({ root, text, removed: new Set(['gone', 'x']) });
            assert.deepEqual(r.missing, [{ folder: 'services/', module: 'y' }, { folder: 'utils/', module: null }]);
            assert.deepEqual(r.removed, [{ folder: 'services/', name: 'gone' }], 'a name deleted once but a module now (x) is no removed one');
            assert.deepEqual(r.misplaced, [{ folder: 'services/', name: 'u', in: ['utils/'] }]);
        } finally {
            fs.rmSync(root, { recursive: true, force: true });
        }
    });
});
