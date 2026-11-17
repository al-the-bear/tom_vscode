/**
 * The configuration layers (`configLayers.ts`), the pure rules:
 *
 *   CL-1 deep merge: objects merged, arrays and scalars replace, later layers win
 *   CL-2 merge patch: only changed keys, removed keys as null, nothing when equal
 *   CL-3 applying a patch to a target keeps its other keys and adds no others
 *   CL-4 a symlinked layer file is read once; a file that does not parse is marked unreadable
 */

import { test, describe } from 'node:test';
import * as assert from 'node:assert/strict';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { applyMergePatch, deepMerge, mergePatch, readConfigLayers } from '../configLayers.js';

const parseJson = (raw: string): Record<string, unknown> | undefined => {
    try { const v = JSON.parse(raw); return v && typeof v === 'object' && !Array.isArray(v) ? v : undefined; } catch { return undefined; }
};

describe('configLayers', () => {
    test('CL-1: deep merge', () => {
        const merged = deepMerge(
            { a: { x: 1, y: 1, deep: { k: 1 } }, arr: [1, 2], s: 'defaults', only: true },
            { a: { y: 2, deep: { j: 2 } }, arr: [3], s: 'root' },
            { a: { x: 3 }, s: 'ws' },
        );
        assert.deepEqual(merged, { a: { x: 3, y: 2, deep: { k: 1, j: 2 } }, arr: [3], s: 'ws', only: true });
        assert.deepEqual(deepMerge({ a: { x: 1 } }, { a: [1] }), { a: [1] }, 'an array replaces an object');
        assert.deepEqual(deepMerge({ a: [1] }, { a: { x: 1 } }), { a: { x: 1 } }, 'an object replaces an array');
    });

    test('CL-2: merge patch', () => {
        assert.equal(mergePatch({ a: { x: 1 } }, { a: { x: 1 } }), undefined);
        assert.deepEqual(mergePatch({ a: { x: 1, y: 2 }, b: 1 }, { a: { x: 5, y: 2 }, b: 1 }), { a: { x: 5 } });
        assert.deepEqual(mergePatch({ a: { x: 1, y: 2 } }, { a: { x: 1 } }), { a: { y: null } });
        assert.deepEqual(mergePatch({ arr: [1, 2] }, { arr: [1, 2, 3] }), { arr: [1, 2, 3] });
        assert.deepEqual(mergePatch({}, { n: { m: 1 } }), { n: { m: 1 } });
    });

    test('CL-3: applying a patch', () => {
        const target = { a: { x: 1, own: 'kept' }, other: 'kept', gone: 1 };
        assert.deepEqual(applyMergePatch(target, { a: { x: 5 }, gone: null, added: [1] }), { a: { x: 5, own: 'kept' }, other: 'kept', added: [1] });
        assert.deepEqual(target, { a: { x: 1, own: 'kept' }, other: 'kept', gone: 1 }, 'the target is not changed in place');
    });

    test('CL-4: layer files read once; unreadable marked', () => {
        const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'cl-')));
        const root = path.join(dir, 'root.json');
        fs.writeFileSync(root, '{"a":1}');
        const link = path.join(dir, 'link.json');
        fs.symlinkSync(root, link);
        const bad = path.join(dir, 'bad.json');
        fs.writeFileSync(bad, '{ not json');
        const layers = readConfigLayers([root, link, bad, path.join(dir, 'missing.json')], parseJson);
        assert.deepEqual(layers.map((l) => [path.basename(l.path), l.exists, l.content, !!l.unreadable]), [
            ['root.json', true, { a: 1 }, false],
            ['bad.json', true, undefined, true],
            ['missing.json', false, undefined, false],
        ]);
    });
});
