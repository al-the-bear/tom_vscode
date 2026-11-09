/**
 * The spec write tools on a large document in another writer's layout (LD-*):
 * a Blueprint of some 13 MB / 230 000 lines (the Meridian sample with its first
 * user category repeated 12 000 times), written with the key order and scalar
 * styles of a different encoder (every plain scalar as a `|2-` block, `userType`
 * before `description`). The SOM document store keeps the file's own text
 * wherever an edit did not change a value (mergeYamlLayout), and the dry-run
 * diff stays bounded (unifiedDiff).
 *
 *   LD-1  tomAi_specSetContent with `marked: true` succeeds within seconds; the only lines that change are
 *         the edited value's and the model-version stamp's
 *   LD-2  tomAi_specDecideMarks with `all: accept` succeeds within seconds and leaves the file as a plain
 *         write of the new text would; its dry run answers a small diff and writes nothing
 *   LD-3  the encoder's own output is not what the file holds — the test document really is in a
 *         foreign layout
 */

import test, { after, describe } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import { installVscodeStub } from './_vscode-stub.js';
installVscodeStub();

import { SomModelService } from '../../services/som-model-service.js';
import { SomDocumentStore } from '../../services/som-document-store.js';
import type { SpecToolDeps } from '../spec-tool-common.js';
import { specSetContentImpl } from '../spec-edit-tools.js';
import { specDecideMarksImpl } from '../spec-annotation-tools.js';

const SAMPLES = path.resolve(__dirname, '..', '..', '..', '..', '..', 'ai_build', 'tom_som_dart_v0', 'documents');
const MERIDIAN_YAML = fs.readFileSync(path.join(SAMPLES, 'meridian_order_management.docspecs.yaml'), 'utf8');

const COPIES = 12_000;
/** Generous for a loaded machine; the tools take a few seconds on the 16 MB Tom UAM Blueprint. */
const SECONDS = 30;
const VALUE = 'SBP/content';

/** Every plain `key: value` outside block scalars written as a `|2-` block, as another encoder does. */
function asBlocks(text: string): string {
    const out: string[] = [];
    let blockIndent = -1;
    let inDocument = false;
    for (const line of text.split('\n')) {
        const indent = line.length - line.trimStart().length;
        if (blockIndent >= 0 && (line.trim() === '' || indent > blockIndent)) { out.push(line); continue; }
        blockIndent = -1;
        if (line === 'document:') { inDocument = true; }
        const m = /^( *)([^\s#][^:]*): (.+)$/.exec(line);
        if (m && /^\|/.test(m[3])) { blockIndent = indent; out.push(line); continue; }
        if (inDocument && m && !/^["{[]/.test(m[3])) {
            out.push(`${m[1]}${m[2]}: |2-`, `${m[1]}  ${m[3]}`);
            continue;
        }
        out.push(line);
    }
    return out.join('\n');
}

/** Meridian with its first user category repeated, in another encoder's layout. */
function largeForeignBlueprint(): string {
    const lines = MERIDIAN_YAML.split('\n');
    const start = lines.indexOf('          UCE-USER-1:');
    assert.ok(start > 0, 'the sample has its first user category where the test expects it');
    let end = start + 1;
    while (lines[end].startsWith('           ')) { end++; }
    const item = lines.slice(start, end);
    const description = item.findIndex((l) => l.trim() === 'description: |2-');
    const userType = item.findIndex((l) => l.trim() === 'userType: |2-');
    assert.equal(userType, description + 2, 'description (one line) then userType');
    const copies: string[] = [];
    for (let k = 1; k <= COPIES; k++) {
        const copy = item.map((l) => l.replace('UCE-USER-1:', `UCE-USER-${k}:`).replace('Order Operations Clerk', `Order Operations Clerk ${k}`));
        // The other encoder's field order: userType before description.
        copies.push(...copy.slice(0, description), ...copy.slice(userType, userType + 2), ...copy.slice(description, description + 2), ...copy.slice(userType + 2));
    }
    return asBlocks([...lines.slice(0, start), ...copies, ...lines.slice(end)].join('\n'));
}

const ws = fs.mkdtempSync(path.join(os.tmpdir(), 'spec-large-'));
const service = SomModelService.instance;
const store = new SomDocumentStore(service);
const deps: SpecToolDeps = { wsRoot: ws, store, service };
const LARGE = largeForeignBlueprint();
const read = (name: string): string => fs.readFileSync(path.join(ws, name), 'utf8');
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Json = any;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const run = async (impl: (d: SpecToolDeps, i: any) => Promise<string>, input: object): Promise<Json> => JSON.parse(await impl(deps, input));
let counter = 0;
function fresh(): string {
    const file = `large${++counter}.docspecs.yaml`;
    fs.writeFileSync(path.join(ws, file), LARGE);
    return file;
}

/** The lines of `before` that `after` no longer has, by number, from a line diff of the two. */
function removedLines(before: string, after: string): number[] {
    const a = before.split('\n');
    const b = after.split('\n');
    let p = 0;
    while (p < a.length && p < b.length && a[p] === b[p]) { p++; }
    let s = 0;
    while (s < a.length - p && s < b.length - p && a[a.length - 1 - s] === b[b.length - 1 - s]) { s++; }
    // Changes are in [p, a.length - s); lines there that `after` keeps verbatim are not removed.
    const kept = new Set(b.slice(p, b.length - s));
    const removed: number[] = [];
    for (let i = p; i < a.length - s; i++) { if (!kept.has(a[i])) { removed.push(i); } }
    return removed;
}

/** The line range of the root's content value in `text` (its key line to the next key at that indent). */
function rootContentLines(text: string): Set<number> {
    const lines = text.split('\n');
    const start = lines.indexOf('    content: |2-');
    let end = start + 1;
    while (lines[end].trim() === '' || lines[end].startsWith('      ')) { end++; }
    return new Set(Array.from({ length: end - start }, (_, k) => start + k));
}

async function timed<T>(what: string, f: () => Promise<T>): Promise<T> {
    const started = Date.now();
    const r = await f();
    const seconds = (Date.now() - started) / 1000;
    assert.ok(seconds < SECONDS, `${what} took ${seconds.toFixed(1)} s`);
    return r;
}

describe('Spec write tools on a large document', () => {
    after(() => fs.rmSync(ws, { recursive: true, force: true }));

    test('LD-3: the test document is in a foreign layout', () => {
        assert.ok(LARGE.length > 12_000_000, `${(LARGE.length / 1e6).toFixed(1)} MB`);
        const loaded = store.load(path.join(ws, fresh()));
        assert.equal(loaded.readOnlyReason, null);
        const encoded = store.render(loaded, { stamp: loaded.stamp });
        assert.notEqual(encoded, LARGE);
        assert.ok(removedLines(LARGE, encoded).length > COPIES, 'the encoder would rewrite most of the file');
    });

    test('LD-1: a marked write changes only the value and the stamp', async () => {
        const file = fresh();
        const r = await timed('tomAi_specSetContent marked', () =>
            run(specSetContentImpl, { file, path: VALUE, text: 'Solution Blueprint for the MOM programme, rewritten.', marked: true }));
        assert.equal(r.ok, true, JSON.stringify(r).slice(0, 500));
        const after = read(file);
        assert.match(after, /\{(?:~~|--|\+\+) /, 'the change is written as marks');
        const allowed = rootContentLines(LARGE);
        allowed.add(LARGE.split('\n').findIndex((l) => l.startsWith('modelVersion: ')));
        const outside = removedLines(LARGE, after).filter((i) => !allowed.has(i));
        assert.deepEqual(outside.slice(0, 5), [], 'no line outside the edited value and the stamp changed');
    });

    test('LD-2: accepting every mark', async () => {
        const file = fresh();
        const text = 'Solution Blueprint for the MOM programme, rewritten.';
        assert.equal((await run(specSetContentImpl, { file, path: VALUE, text, marked: true })).ok, true);
        const marked = read(file);
        const dry = await timed('tomAi_specDecideMarks dry run', () => run(specDecideMarksImpl, { file, all: 'accept', dryRun: true }));
        assert.equal(dry.ok, true, JSON.stringify(dry).slice(0, 500));
        assert.equal(read(file), marked, 'a dry run writes nothing');
        assert.ok(dry.diff.split('\n').length < 40, `a small diff (${dry.diff.split('\n').length} lines)`);
        const r = await timed('tomAi_specDecideMarks all accept', () => run(specDecideMarksImpl, { file, all: 'accept' }));
        assert.equal(r.ok, true, JSON.stringify(r).slice(0, 500));
        const plain = fresh();
        assert.equal((await run(specSetContentImpl, { file: plain, path: VALUE, text })).ok, true);
        assert.equal(read(file), read(plain), 'accepted marks leave the file a plain write leaves');
    });
});
