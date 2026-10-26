/**
 * Finding a queue item's entry file from the item's id ("Open YAML file").
 *
 * An item's id is the UUID in its file's `meta.id`; the file name carries
 * only the first eight characters as its unique token
 * (`<host>_<ws>_<yymmdd>_<hhmmss>-<token>_<quest>.<type>.entry.queue.yaml`).
 * The lookup compared the id with the whole file-name stem, so it never found
 * a file and every "Open YAML file" said "Queue entry file not found".
 *
 *   QE-1 an item id finds the file whose meta.id it is; the file named by its token is read first
 *   QE-2 a file-name stem (an entry id) still finds its file directly
 *   QE-3 a file carrying the token but another meta.id is not taken; an unknown id finds nothing
 */

import test, { describe } from 'node:test';
import assert from 'node:assert/strict';

import { findEntryFileForId } from '../queueStep5Utils.js';

const SUFFIX = '.entry.queue.yaml';
const A = 'mbp_local_vscode_extension_261021_131006-190a1af6_vscode_extension.normal' + SUFFIX;
const B = 'mbp_local_vscode_extension_261023_104815-009c89ee_vscode_extension.normal' + SUFFIX;
const C = 'mbp_local_tom_core_260803_190518-36a756d2_tom_core.normal' + SUFFIX;
const META: Record<string, string> = {
    [A]: '190a1af6-1b1e-4710-876c-be046f8f14c8',
    [B]: '009c89ee-0000-4000-8000-000000000001',
    [C]: '36a756d2-0000-4000-8000-000000000002',
};

function reader(log: string[]): (f: string) => string | undefined {
    return (f) => { log.push(f); return META[f]; };
}

describe('findEntryFileForId', () => {
    test('QE-1: an item id finds its file, the token-named file first', () => {
        const read: string[] = [];
        assert.equal(findEntryFileForId([C, B, A], '190a1af6-1b1e-4710-876c-be046f8f14c8', SUFFIX, reader(read)), A);
        assert.deepEqual(read, [A], 'only the file carrying the token was read');
    });

    test('QE-2: a file-name stem finds its file directly', () => {
        const read: string[] = [];
        assert.equal(findEntryFileForId([A, B], B.slice(0, -SUFFIX.length), SUFFIX, reader(read)), B);
        assert.deepEqual(read, [], 'no file read');
    });

    test('QE-3: the meta.id decides; an unknown id finds nothing', () => {
        const clash = 'mbp_local_x_261026_120000-190a1af6_x.normal' + SUFFIX;
        const meta = { ...META, [clash]: '190a1af6-ffff-4000-8000-000000000003' };
        assert.equal(findEntryFileForId([clash, A], '190a1af6-1b1e-4710-876c-be046f8f14c8', SUFFIX, (f) => meta[f]), A);
        assert.equal(findEntryFileForId([A, B, C], 'ffffffff-0000-4000-8000-000000000000', SUFFIX, (f) => META[f]), undefined);
    });
});
