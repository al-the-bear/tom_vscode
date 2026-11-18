/**
 * The DocSpecs schema lookup from the workspace folder and the root (02_wslayout-7, services/docspecs-markdown.ts
 * resolveDocSpecsSchema with layers).
 *
 *   DL-1 a document in a repository with a package-local `.tom/docspecs-schema/` finds that one first
 *   DL-2 the same without a package-local one: the workspace folder's layer, then the root's
 *   DL-3 a document in the root's `_ai`, opened through the workspace folder's `_ai` link and through the root:
 *        the same schema both ways
 *   DL-4 a standalone layout (one layer, the workspace folder's)
 *   DL-5 an unknown schema id: not found, the folders searched named, then the SOM model's schemas — as before;
 *        without layers the lookup walks up to the workspace folder as it did
 *   DL-6 the order of the folders: the walk inside the workspace folder, then the layers workspace before root, each
 *        once; a document outside the workspace folder gets only the layers
 */

import test, { after, describe } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'fs';
import * as path from 'path';

import { docSpecsSchemaDirs, resolveDocSpecsSchema, type DocSpecsLayers } from '../docspecs-markdown.js';

const EXT = path.resolve(__dirname, '..', '..', '..');
const SANDBOX = fs.realpathSync(fs.mkdtempSync(path.join(EXT, '..', '..', '..', 'ztmp', 'vscode_extension_261118_02_wslayout-7_lookup-')));
after(() => fs.rmSync(SANDBOX, { recursive: true, force: true }));

const SCHEMA = [
    'section-types:', '  content:', '    prefix: ""', '    subsection-types:', '      content:', '        max-count: infinite',
    'document:', '  sections:', '    content:', '      section-type: content', '      optional: true', '',
].join('\n');
function schemaAt(dir: string, id: string): string {
    const file = path.join(dir, '.tom', 'docspecs-schema', id, `${id}.1.0.docspecs-schema.yaml`);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, SCHEMA);
    return file;
}
function doc(file: string, id: string): string {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, `<!-- docspec: ${id}/1.0 -->\n\n# <!--[t]--> T\n`);
    return file;
}

// root/ (the root, .tom with `shared` and `both`), root/ws/ (the workspace folder, .tom with `ws` and `both`),
// root/ws/repo/pkg/ (a package with its own `.tom` holding `shared`), root/_ai/ linked as root/ws/_ai.
const ROOT = path.join(SANDBOX, 'root');
const WS = path.join(ROOT, 'ws');
const rootShared = schemaAt(ROOT, 'shared');
schemaAt(ROOT, 'both');
const wsOwn = schemaAt(WS, 'ws');
const wsBoth = schemaAt(WS, 'both');
const pkgShared = schemaAt(path.join(WS, 'repo', 'pkg'), 'shared');
fs.mkdirSync(path.join(ROOT, '_ai', 'quests', 'q'), { recursive: true });
fs.symlinkSync(path.join(ROOT, '_ai'), path.join(WS, '_ai'));
const LAYERS: DocSpecsLayers = { workspaceFolder: WS, configLayers: [path.join(ROOT, '.tom'), path.join(WS, '.tom')] };

// A model without the ids used here: the SOM schemas never answer.
const service = { schemaIds: [] as string[], schema: () => { throw new Error('not a SOM schema'); } } as never;
const fileOf = (filePath: string, id: string, layers: DocSpecsLayers | 'none' = LAYERS): string | undefined =>
    resolveDocSpecsSchema(service, filePath, `${id}/1.0`, WS, undefined, layers === 'none' ? undefined : layers).resolved?.file;

describe('the DocSpecs lookup from the workspace folder and the root', () => {
    test('DL-1: a package-local schema wins', () => {
        assert.equal(fileOf(doc(path.join(WS, 'repo', 'pkg', 'doc', 'a.md'), 'shared'), 'shared'), pkgShared);
    });

    test('DL-2: without one, the workspace layer, then the root', () => {
        const d = doc(path.join(WS, 'repo', 'other', 'b.md'), 'shared');
        assert.equal(fileOf(d, 'shared'), rootShared, 'only the root has it');
        assert.equal(fileOf(d, 'ws'), wsOwn, 'the workspace layer');
        assert.equal(fileOf(d, 'both'), wsBoth, 'the workspace layer before the root');
    });

    test('DL-3: a document in the root\'s _ai, through the link and through the root', () => {
        const viaRoot = doc(path.join(ROOT, '_ai', 'quests', 'q', 'idea.md'), 'shared');
        const viaLink = path.join(WS, '_ai', 'quests', 'q', 'idea.md');
        assert.ok(fs.existsSync(viaLink));
        for (const id of ['shared', 'both', 'ws']) {
            assert.equal(fileOf(viaLink, id), fileOf(viaRoot, id), `${id}: the same both ways`);
        }
        assert.equal(fileOf(viaRoot, 'shared'), rootShared);
        assert.equal(fileOf(viaRoot, 'both'), wsBoth);
    });

    test('DL-4: a standalone layout', () => {
        const standalone: DocSpecsLayers = { workspaceFolder: WS, configLayers: [path.join(WS, '.tom')] };
        const d = path.join(WS, 'repo', 'other', 'b.md');
        assert.equal(fileOf(d, 'ws', standalone), wsOwn);
        assert.equal(fileOf(d, 'both', standalone), wsBoth);
        assert.equal(fileOf(d, 'shared', standalone), undefined, 'no root layer');
    });

    test('DL-5: an unknown id, and the lookup without layers', () => {
        const d = path.join(WS, 'repo', 'other', 'b.md');
        const lookup = resolveDocSpecsSchema(service, d, 'nothing/1.0', WS, undefined, LAYERS);
        assert.equal(lookup.resolved, null);
        assert.equal(lookup.declared, 'nothing/1.0');
        assert.ok(lookup.searched?.some((s) => s.includes(path.join(ROOT, '.tom', 'docspecs-schema', 'nothing'))), 'the root layer searched');
        assert.match(lookup.searched!.at(-1)!, /the schemas generated from the SOM model \(nothing is not one\)/);
        // Without layers: the walk up to the workspace folder, as before (the root is not looked at).
        assert.equal(fileOf(d, 'ws', 'none'), wsOwn);
        assert.equal(fileOf(d, 'shared', 'none'), undefined);
    });

    test('DL-6: the order of the folders', () => {
        const d = path.join(WS, 'repo', 'pkg', 'doc', 'a.md');
        const rel = (dirs: string[]): string[] => dirs.map((x) => path.relative(ROOT, x));
        assert.deepEqual(rel(docSpecsSchemaDirs(d, WS, LAYERS)), [
            'ws/repo/pkg/doc/.tom/docspecs-schema', 'ws/repo/pkg/.tom/docspecs-schema', 'ws/repo/.tom/docspecs-schema',
            'ws/.tom/docspecs-schema', '.tom/docspecs-schema',
        ]);
        assert.deepEqual(rel(docSpecsSchemaDirs(path.join(ROOT, '_ai', 'x.md'), WS, LAYERS)), ['ws/.tom/docspecs-schema', '.tom/docspecs-schema'],
            'outside the workspace folder: only the layers');
    });
});
