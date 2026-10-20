/**
 * tomAi_specApplyEdits (vsctsa6) — one atomic batch of SOM edits, on copies of
 * the Meridian sample.
 *
 *   SB-1  a seven-edit fill of a new requirement writes once, through bound `$req` paths
 *   SB-2  a failing edit mid-batch writes nothing and names the edit; earlier results are reported
 *   SB-3  an unbound or late `$name`, `as` off addNode, an unknown op: refused before anything runs
 *   SB-4  a move mid-batch re-points bound names and refuses a stale literal path
 *   SB-5  dryRun returns results and the diff, writes nothing
 *   SB-6  validation split: what the batch introduced and what it resolved
 *   SB-7  the edit cap is enforced; a cap-sized batch stays in the time budget
 *   SB-8  the approval prompt summarises the batch; other tools keep the JSON summary
 *   SB-9  addNode takes `headline` (vscimpa9): the requirement added, filled and headlined in one op fewer
 */

import test, { before, describe } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import { installVscodeStub } from './_vscode-stub.js';
import { withTiming } from './_timing.js';
installVscodeStub({});

import { SomModelService } from '../../services/som-model-service.js';
import { SomDocumentStore, nodeSomDocumentIo } from '../../services/som-document-store.js';
import type { SpecToolDeps } from '../spec-tool-common.js';
import { MAX_BATCH_EDITS, SPEC_APPLY_EDITS_TOOL, SpecBatchEdit, specApplyEditsImpl, specSetFormFieldImpl } from '../spec-edit-tools.js';
import { specGetSectionImpl } from '../spec-tools.js';
import { summarizeToolInput } from '../shared-tool-registry.js';

const SAMPLES = path.resolve(__dirname, '..', '..', '..', '..', '..', 'ai_build', 'tom_som_dart_v0', 'documents');
const MERIDIAN_YAML = fs.readFileSync(path.join(SAMPLES, 'meridian_order_management.docspecs.yaml'), 'utf8');

const FR = 'SBP/introductionAndScope/requirements/functionalRequirements';
const SYSCL = 'SBP/introductionAndScope/summary/SYSCL';

const ws = fs.mkdtempSync(path.join(os.tmpdir(), 'spec-batch-'));
const service = SomModelService.instance;
let writes = 0;
const deps: SpecToolDeps = {
    wsRoot: ws,
    store: new SomDocumentStore(service, { ...nodeSomDocumentIo, write: async (p, t) => { writes++; await nodeSomDocumentIo.write(p, t); } }),
    service,
};

let counter = 0;
function copy(): string {
    const name = `b${++counter}.docspecs.yaml`;
    fs.writeFileSync(path.join(ws, name), MERIDIAN_YAML);
    return name;
}
const read = (name: string): string => fs.readFileSync(path.join(ws, name), 'utf8');

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Json = any;
const apply = async (file: string, edits: SpecBatchEdit[], extra: object = {}): Promise<Json> =>
    JSON.parse(await specApplyEditsImpl(deps, { file, edits, ...extra }));
const section = async (file: string, p: string): Promise<Json> =>
    JSON.parse(await specGetSectionImpl(deps, { file, path: p })).section;
const field = (s: Json, form: string, name: string): Json => s.forms[form].fields.find((f: Json) => f.name === name)?.value;

/** Add a requirement as $req and fill it: seven edits. */
const FILL: SpecBatchEdit[] = [
    { op: 'addNode', parentPath: FR, childSegment: 'FRE-REQU-LST', itemId: 'FRE-REQU-ARCHIVE', as: 'req' },
    { op: 'setFormField', path: '$req/content', field: 'status', value: 'draft' },
    { op: 'setFormField', path: '$req/FRED', field: 'description', value: 'The system must archive closed orders.' },
    { op: 'setFormField', path: '$req/FREP', field: 'priority', value: 'could' },
    { op: 'setFormField', path: '$req/FREP', field: 'businessValue', value: 'medium' },
    { op: 'setHeadline', path: '$req', headline: 'FR-07 — Archive closed orders' },
    { op: 'setCodeSpec', path: '$req', codeSpec: 'CsOrderArchive' },
];

describe('tomAi_specApplyEdits', () => {
    before(() => { void service.model; void service.metaTree('SBP'); });

    test('SB-1: a seven-edit fill writes once', async () => {
        const file = copy();
        writes = 0;
        const r = JSON.parse(await withTiming('tomAi_specApplyEdits:typical', () => specApplyEditsImpl(deps, { file, edits: FILL })));
        assert.equal(r.ok, true, JSON.stringify(r));
        assert.equal(writes, 1, 'one save for the whole batch');
        assert.equal(r.applied, 7);
        assert.deepEqual(r.results.map((x: Json) => x.op), FILL.map((e) => e.op));
        const req = `${FR}/FRE-REQU-LST-7`;
        assert.equal(r.bindings.req, req);
        const s = await section(file, req);
        assert.equal(s.sectionId, 'FRE-REQU-ARCHIVE');
        assert.equal(s.headline, 'FR-07 — Archive closed orders');
        assert.equal(s.codeSpec, 'CsOrderArchive');
        assert.equal(field(s, 'content', 'status'), 'draft');
        assert.equal(field(s, 'FRED', 'description'), 'The system must archive closed orders.');
        assert.equal(field(s, 'FREP', 'priority'), 'could');
        assert.equal(field(s, 'FREP', 'businessValue'), 'medium');
    });

    test('SB-2: a failing edit mid-batch writes nothing and names the edit', async () => {
        const file = copy();
        writes = 0;
        const edits = FILL.map((e) => ({ ...e }));
        edits[3] = { op: 'setFormField', path: '$req/FREP', field: 'priority', value: 'urgent' };
        const r = await apply(file, edits);
        assert.equal(r.ok, false);
        assert.deepEqual(r.failedOp, { index: 3, op: 'setFormField' });
        assert.equal(r.code, 'wrongValue');
        assert.ok(r.field.enumValues.includes('could'));
        assert.equal(r.completed.length, 3, 'the results of the edits before it');
        assert.equal(writes, 0);
        assert.equal(read(file), MERIDIAN_YAML);
    });

    test('SB-3: names and ops are checked before anything runs', async () => {
        const file = copy();
        writes = 0;
        const unbound = await apply(file, [
            { op: 'setHeadline', path: `${FR}/FRE-REQU-LST-1`, headline: 'x' },
            { op: 'setHeadline', path: '$nope/FRED', headline: 'x' },
        ]);
        assert.equal(unbound.code, 'invalidBatch');
        assert.match(unbound.error, /Edit 1 .*\$nope is not bound/);
        const late = await apply(file, [{ op: 'setHeadline', path: '$req', headline: 'x' }, FILL[0]]);
        assert.match(late.error, /\$req is not bound by an earlier addNode/);
        const asOff = await apply(file, [{ op: 'setHeadline', path: `${FR}/FRE-REQU-LST-1`, headline: 'x', as: 'h' }]);
        assert.match(asOff.error, /only addNode can bind/);
        const twice = await apply(file, [FILL[0], { ...FILL[0], itemId: 'FRE-REQU-OTHER' }]);
        assert.match(twice.error, /already bound/);
        const unknown = await apply(file, [{ op: 'deleteEverything' }]);
        assert.match(unknown.error, /unknown op/);
        assert.equal((await apply(file, [])).code, 'invalidBatch');
        assert.equal(writes, 0);
        assert.equal(read(file), MERIDIAN_YAML);
    });

    test('SB-4: a move re-points bound names and refuses a stale literal path', async () => {
        const file = copy();
        const r = await apply(file, [
            FILL[0],
            { op: 'moveListItem', itemPath: '$req', toIndex: 0 },
            { op: 'setHeadline', path: '$req', headline: 'Now first' },
        ]);
        assert.equal(r.ok, true, JSON.stringify(r));
        assert.equal(r.bindings.req, `${FR}/FRE-REQU-LST-1`, 're-pointed through the renamed map');
        const first = await section(file, `${FR}/FRE-REQU-LST-1`);
        assert.equal(first.sectionId, 'FRE-REQU-ARCHIVE');
        assert.equal(first.headline, 'Now first');

        // Two moves compose: the name follows its item through both, and a literal
        // original position leads to where its item went last.
        const file3 = copy();
        const twice = await apply(file3, [
            FILL[0],
            { op: 'moveListItem', itemPath: '$req', toIndex: 0 },
            { op: 'moveListItem', itemPath: '$req', toIndex: 3 },
            { op: 'setHeadline', path: '$req', headline: 'Fourth' },
            { op: 'setHeadline', path: `${FR}/FRE-REQU-LST-1`, headline: 'stale' },
        ]);
        assert.equal(twice.code, 'stalePath');
        assert.equal(twice.failedOp.index, 4);
        assert.equal(twice.completed[3].path, `${FR}/FRE-REQU-LST-4`, 'the bound name followed both moves');
        // [o1..o6, req] → req first → req fourth: o1 is back at LST-1, so that is where the literal leads.
        assert.equal(twice.use, `${FR}/FRE-REQU-LST-1`);

        const file2 = copy();
        const stale = await apply(file2, [
            { op: 'moveListItem', itemPath: `${FR}/FRE-REQU-LST-1`, toIndex: 2 },
            { op: 'setHeadline', path: `${FR}/FRE-REQU-LST-1/FRED`, headline: 'meant for the moved item' },
        ]);
        assert.equal(stale.code, 'stalePath');
        assert.equal(stale.failedOp.index, 1);
        assert.equal(stale.use, `${FR}/FRE-REQU-LST-3/FRED`, 'names where that item is now');
        assert.equal(read(file2), MERIDIAN_YAML);
    });

    test('SB-5: dryRun writes nothing', async () => {
        const file = copy();
        writes = 0;
        const r = await apply(file, FILL, { dryRun: true });
        assert.equal(r.ok, true);
        assert.equal(r.written, false);
        assert.equal(r.applied, 7);
        assert.match(r.diff, /CsOrderArchive/);
        assert.equal(writes, 0);
        assert.equal(read(file), MERIDIAN_YAML);
    });

    test('SB-6: the batch reports what it introduced and what it resolved', async () => {
        const file = copy();
        // Seven requirements stated, six present: one countMismatch to start with.
        const setup = JSON.parse(await specSetFormFieldImpl(deps, { file, path: SYSCL, field: 'functionalRequirementCount', value: 7 }));
        assert.equal(setup.validation.introduced.length, 1);
        const r = await apply(file, [
            { op: 'addNode', parentPath: FR, childSegment: 'FRE-REQU-LST', itemId: 'FRE-REQU-SEVENTH' },
            { op: 'setFormField', path: SYSCL, field: 'userCategoryCount', value: 99 },
        ]);
        assert.equal(r.ok, true, JSON.stringify(r));
        assert.equal(r.validation.resolved.length, 1);
        assert.match(r.validation.resolved[0].message, /FRE/);
        assert.equal(r.validation.introduced.length, 1);
        assert.match(r.validation.introduced[0].message, /UCE/);
        assert.equal(r.validation.total, 1);
    });

    test('SB-7: the edit cap', async () => {
        const file = copy();
        const tooMany = Array.from({ length: MAX_BATCH_EDITS + 1 }, (_, i) =>
            ({ op: 'setHeadline', path: `${FR}/FRE-REQU-LST-1`, headline: `h${i}` }));
        const refused = await apply(file, tooMany);
        assert.equal(refused.code, 'invalidBatch');
        assert.match(refused.error, new RegExp(`at most ${MAX_BATCH_EDITS} edits`));
        const full = JSON.parse(await withTiming('tomAi_specApplyEdits:cap-sized', () =>
            specApplyEditsImpl(deps, { file, edits: tooMany.slice(0, MAX_BATCH_EDITS) })));
        assert.equal(full.applied, MAX_BATCH_EDITS);
    });

    test('SB-8: the approval prompt summarises the batch', () => {
        const summary = summarizeToolInput(SPEC_APPLY_EDITS_TOOL, { file: 'spec/x.docspecs.yaml', edits: FILL });
        assert.match(summary, /^7 edits to spec\/x\.docspecs\.yaml: /);
        assert.match(summary, /addNode ×1, setFormField ×4, setHeadline ×1, setCodeSpec ×1/);
        assert.match(summary, /Paths: .*\$req\/FRED/);
        assert.match(summarizeToolInput(SPEC_APPLY_EDITS_TOOL, { file: 'x', edits: FILL, dryRun: true }), /dry run, writes nothing/);
        assert.equal(summarizeToolInput(undefined, { a: 1 }), '{"a":1}');
    });

    test('SB-9: addNode with a headline', async () => {
        const file = copy();
        const edits: SpecBatchEdit[] = [
            { op: 'addNode', parentPath: FR, childSegment: 'FRE-REQU-LST', itemId: 'FRE-REQU-ARCHIVE', headline: 'FR-07 — Archive closed orders', as: 'req' },
            { op: 'setFormField', path: '$req/FRED', field: 'description', value: 'The system must archive closed orders.' },
        ];
        const r = await apply(file, edits);
        assert.equal(r.ok, true, JSON.stringify(r));
        assert.equal(r.results[0].headline, 'FR-07 — Archive closed orders');
        const s = await section(file, r.bindings.req);
        assert.equal(s.headline, 'FR-07 — Archive closed orders');
        assert.equal(field(s, 'FRED', 'description'), 'The system must archive closed orders.');
        const refused = await apply(file, [{ op: 'addNode', parentPath: FR, childSegment: 'FRE-REQU-LST', headline: 'a\nb' }]);
        assert.equal(refused.code, 'invalidHeadline');
        assert.deepEqual(refused.failedOp, { index: 0, op: 'addNode' });
    });
});
