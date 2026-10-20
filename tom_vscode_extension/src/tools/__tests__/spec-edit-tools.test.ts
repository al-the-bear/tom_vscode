/**
 * TomSpecs edit tools (vsctsa5), each on a fresh copy of the Meridian sample.
 *
 *   SE-1   setContent writes, changes the revision, and reads back
 *   SE-2   setContent refuses a non-leaf and leaves the file byte-identical; "" clears
 *   SE-3   setFormField: an enum by name; an unknown name or field is refused with the domain
 *   SE-4   typed coercion: an int field refuses 2.5 and an unreadable string, takes 6
 *   SE-5   setHeadline and setCodeSpec
 *   SE-6   addNode: a populated list item, and the stated count it breaks (countMismatch)
 *   SE-7   a refused add names the legal children and leaves the file byte-identical
 *   SE-8   setItemSectionId: a rename; pattern and collision refusals
 *   SE-9   moveListItem within a list: the renamed map, and review entries following their item
 *   SE-10  moveListItem across lists; a colliding id is refused
 *   SE-11  removeListItem reports the stale review entry and the broken count
 *   SE-12  clearSection
 *   SE-13  expectedRevision conflicts and dryRun writes nothing
 *   SE-14  create → add → validate, in YAML and in Markdown, each saved in its own format
 *   SE-15  a read-only document is refused
 *   SE-16  all edit tools (and the batch) need approval and are outside the MCP read-only floor
 *   SE-17  a value leaf's type refuses a value it cannot read — "lots" or 2.5 into an int leaf, a name outside
 *          an enum leaf's domain — as `wrongValue` with the leaf's declared type, the leaf unchanged (the code
 *          tomAi_specSetFormField answers for the same mistake). The bundled model has no typed value leaf
 *          (its leaves are text content and String list items), so a two-field model built here stands in
 *   SE-18  addNode with a headline (vscimpa9): one call adds a populated, headlined item; a headline with a line
 *          break (it would break the Markdown heading) refuses the whole add, and setHeadline refuses it too
 */

import test, { before, describe } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import { installVscodeStub } from './_vscode-stub.js';
import { withTiming } from './_timing.js';
import { withStamp } from './_somSamples.js';
installVscodeStub({});

import { SomModelService } from '../../services/som-model-service.js';
import { SomDocumentStore } from '../../services/som-document-store.js';
import type { SpecToolDeps } from '../spec-tool-common.js';
import {
    SPEC_EDIT_TOOLS,
    specAddNodeImpl,
    specClearSectionImpl,
    specCreateDocumentImpl,
    specMoveListItemImpl,
    specRemoveListItemImpl,
    specSetCodeSpecImpl,
    specSetContentImpl,
    specSetFormFieldImpl,
    specSetHeadlineImpl,
    specSetItemSectionIdImpl,
} from '../spec-edit-tools.js';
import { specGetSectionImpl } from '../spec-tools.js';
import { SpecEditRefusal, setLeafValue } from '../spec-edit-core.js';
import { SpecAnnotation, SpecClass, SpecDocument, SpecEditor, SpecField, SpecFieldKind, SpecModel, SpecRoot } from 'tom_som_typescript_runtime';
import { resolveEffectiveTools } from '../../handlers/mcpServer-handler.js';

const SAMPLES = path.resolve(__dirname, '..', '..', '..', '..', '..', 'ai_build', 'tom_som_dart_v0', 'documents');
const MERIDIAN_YAML = fs.readFileSync(path.join(SAMPLES, 'meridian_order_management.docspecs.yaml'), 'utf8');
const MERIDIAN_MD = fs.readFileSync(path.join(SAMPLES, 'meridian_order_management.md'), 'utf8');

const FR = 'SBP/introductionAndScope/requirements/functionalRequirements';
const FR1 = `${FR}/FRE-REQU-LST-1`;
const SYSCL = 'SBP/introductionAndScope/summary/SYSCL';
/** Form segments of a requirement item (section ids, so not camelCase keys). */
const FRED = 'FRED';
const FREP = 'FREP';

const ws = fs.mkdtempSync(path.join(os.tmpdir(), 'spec-edit-'));
const service = SomModelService.instance;
const deps: SpecToolDeps = { wsRoot: ws, store: new SomDocumentStore(service), service };

let counter = 0;
/** A fresh copy of the sample (optionally with extra text appended); returns its workspace-relative name. */
function copy(extra = ''): string {
    const name = `m${++counter}.docspecs.yaml`;
    fs.writeFileSync(path.join(ws, name), MERIDIAN_YAML + extra);
    return name;
}
const read = (name: string): string => fs.readFileSync(path.join(ws, name), 'utf8');

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Json = any;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const run = async (impl: (d: SpecToolDeps, i: any) => Promise<string>, input: object): Promise<Json> => JSON.parse(await impl(deps, input));
const section = async (file: string, p: string): Promise<Json> => (await run(specGetSectionImpl, { file, path: p })).section;
const field = (s: Json, form: string, name: string): Json => s.forms[form].fields.find((f: Json) => f.name === name);

describe('TomSpecs edit tools', () => {
    before(() => { void service.model; void service.metaTree('SBP'); });

    test('SE-1: setContent writes and reads back', async () => {
        const file = copy();
        const r = JSON.parse(await withTiming('tomAi_specSetContent:typical', () =>
            specSetContentImpl(deps, { file, path: 'SBP/content', text: 'A new summary.' })));
        assert.equal(r.ok, true, JSON.stringify(r));
        assert.equal(r.written, true);
        assert.equal(r.value, 'A new summary.');
        assert.deepEqual(r.validation.introduced, []);
        assert.match(read(file), /A new summary\./);
        assert.equal((await section(file, 'SBP/content')).value, 'A new summary.');
        assert.notEqual(r.revision, (await run(specSetContentImpl, { file: copy(), path: 'SBP/content', text: 'x', dryRun: true })).revision);
    });

    test('SE-2: setContent refuses a non-leaf; "" clears', async () => {
        const file = copy();
        const r = await run(specSetContentImpl, { file, path: 'SBP/introductionAndScope', text: 'x' });
        assert.equal(r.code, 'wrongKind');
        assert.equal(read(file), MERIDIAN_YAML);
        const cleared = await run(specSetContentImpl, { file, path: 'SBP/content', text: '' });
        assert.equal(cleared.value, null);
        assert.equal((await section(file, 'SBP/content')).value, null);
    });

    test('SE-3: setFormField by enum name; unknown names and fields are refused', async () => {
        const file = copy();
        const r = JSON.parse(await withTiming('tomAi_specSetFormField:typical', () =>
            specSetFormFieldImpl(deps, { file, path: `${FR1}/FREP`, field: 'priority', value: 'should' })));
        assert.equal(r.ok, true, JSON.stringify(r));
        assert.equal(field(await section(file, FR1), 'FREP', 'priority').value, 'should');
        const before = read(file);
        const bad = await run(specSetFormFieldImpl, { file, path: `${FR1}/FREP`, field: 'priority', value: 'urgent' });
        assert.equal(bad.code, 'wrongValue');
        assert.deepEqual(bad.field.enumValues, ['must', 'should', 'could', 'wontThisTime']);
        const unknown = await run(specSetFormFieldImpl, { file, path: `${FR1}/FREP`, field: 'nope', value: 'x' });
        assert.equal(unknown.code, 'unknownField');
        assert.ok(unknown.fields.includes('priority'));
        assert.equal(read(file), before);
    });

    test('SE-4: typed coercion on an int field', async () => {
        const file = copy();
        const fractional = await run(specSetFormFieldImpl, { file, path: SYSCL, field: 'estimatedUserCount', value: 2.5 });
        assert.equal(fractional.code, 'wrongValue');
        assert.equal(fractional.field.type, 'int');
        const unreadable = await run(specSetFormFieldImpl, { file, path: SYSCL, field: 'estimatedUserCount', value: 'lots' });
        assert.equal(unreadable.code, 'wrongValue');
        assert.equal(unreadable.field.type, 'int');
        assert.match(unreadable.error, /lots/, 'the runtime\'s own refusal names the value');
        assert.equal(read(file), MERIDIAN_YAML);
        const ok = await run(specSetFormFieldImpl, { file, path: SYSCL, field: 'estimatedUserCount', value: 250 });
        assert.equal(ok.value, 250);
        assert.equal(field(await section(file, 'SBP/introductionAndScope/summary'), 'SYSCL', 'estimatedUserCount').value, 250);
    });

    test('SE-5: setHeadline and setCodeSpec', async () => {
        const file = copy();
        const h = JSON.parse(await withTiming('tomAi_specSetHeadline:typical', () =>
            specSetHeadlineImpl(deps, { file, path: FR1, headline: 'FR-01 — Capture all orders' })));
        assert.equal(h.headline, 'FR-01 — Capture all orders');
        const c = JSON.parse(await withTiming('tomAi_specSetCodeSpec:typical', () =>
            specSetCodeSpecImpl(deps, { file, path: FR1, codeSpec: 'CsOrder' })));
        assert.equal(c.codeSpec, 'CsOrder');
        const s = await section(file, FR1);
        assert.equal(s.headline, 'FR-01 — Capture all orders');
        assert.equal(s.codeSpec, 'CsOrder');
        await run(specSetHeadlineImpl, { file, path: FR1, headline: null });
        assert.equal((await run(specSetCodeSpecImpl, { file, path: FR1, codeSpec: null })).codeSpec, null);
        assert.equal((await section(file, FR1)).codeSpec, undefined);
    });

    test('SE-6: addNode adds a populated item and reports the count it breaks', async () => {
        const file = copy();
        const stated = await run(specSetFormFieldImpl, { file, path: SYSCL, field: 'functionalRequirementCount', value: 6 });
        assert.deepEqual(stated.validation.introduced, [], 'six requirements are stated and present');
        const r = JSON.parse(await withTiming('tomAi_specAddNode:typical', () => specAddNodeImpl(deps, {
            file, parentPath: FR, childSegment: 'FRE-REQU-LST', month: 10, day: 13,
            fields: { [FRED]: { description: 'The system must archive orders.' }, [FREP]: { priority: 'could' } },
        })));
        assert.equal(r.ok, true, JSON.stringify(r));
        assert.equal(r.path, `${FR}/FRE-REQU-LST-7`);
        assert.equal(r.kind, 'listItemComplex');
        assert.match(r.sectionId, /^FRE-REQU-/);
        const count = r.validation.introduced.filter((e: Json) => e.code === 'countMismatch');
        assert.equal(count.length, 1, JSON.stringify(r.validation));
        assert.match(count[0].path, /SYSCL/);
        const added = await section(file, r.path);
        assert.equal(field(added, 'FRED', 'description').value, 'The system must archive orders.');
        assert.equal(field(added, 'FREP', 'priority').value, 'could');
    });

    test('SE-7: a refused add names the legal children and writes nothing', async () => {
        const file = copy();
        const unknown = await run(specAddNodeImpl, { file, parentPath: FR, childSegment: 'nope' });
        assert.equal(unknown.code, 'unknownChild');
        assert.ok(unknown.addable.includes('FRE-REQU-LST'));
        const pattern = await run(specAddNodeImpl, { file, parentPath: FR, childSegment: 'FRE-REQU-LST', itemId: 'XYZ-1' });
        assert.equal(pattern.code, 'patternMismatch');
        const populated = await run(specAddNodeImpl, { file, parentPath: FR, childSegment: 'FRE-REQU-LST', fields: { [FREP]: { priority: 'urgent' } } });
        assert.equal(populated.code, 'wrongValue', 'a population error refuses the whole add');
        assert.equal(read(file), MERIDIAN_YAML);
    });

    test('SE-8: setItemSectionId', async () => {
        const file = copy();
        const r = JSON.parse(await withTiming('tomAi_specSetItemSectionId:typical', () =>
            specSetItemSectionIdImpl(deps, { file, itemPath: FR1, sectionId: 'FRE-REQU-CAPTURE' })));
        assert.equal(r.ok, true, JSON.stringify(r));
        assert.equal(r.previous, 'FRE-REQU-ORDER-CAPTURE');
        assert.equal((await section(file, FR1)).sectionId, 'FRE-REQU-CAPTURE');
        const pattern = await run(specSetItemSectionIdImpl, { file, itemPath: FR1, sectionId: 'XYZ-1' });
        assert.equal(pattern.code, 'patternMismatch');
        assert.equal(pattern.pattern, 'FRE-REQU-xxx');
        const taken = await run(specSetItemSectionIdImpl, { file, itemPath: FR1, sectionId: 'FRE-REQU-SYNC-PRICING' });
        assert.equal(taken.code, 'duplicateSectionId');
    });

    test('SE-9: moveListItem within a list; review entries follow', async () => {
        const file = copy(`review:\n  "${FR1}":\n    comment: ok\n`);
        const r = JSON.parse(await withTiming('tomAi_specMoveListItem:typical', () =>
            specMoveListItemImpl(deps, { file, itemPath: FR1, toIndex: 2 })));
        assert.equal(r.ok, true, JSON.stringify(r));
        assert.equal(r.path, `${FR}/FRE-REQU-LST-3`);
        assert.equal(r.renamed[FR1], `${FR}/FRE-REQU-LST-3`);
        assert.equal(r.renamed[`${FR}/FRE-REQU-LST-2`], FR1);
        assert.equal((await section(file, `${FR}/FRE-REQU-LST-3`)).sectionId, 'FRE-REQU-ORDER-CAPTURE', 'the id travels with the item');
        const saved = read(file);
        assert.match(saved, new RegExp(`"${FR}/FRE-REQU-LST-3":\\n {4}comment: ok`), 'the review entry follows its item');
        assert.equal(r.staleReviewPaths, undefined);
        assert.equal((await run(specMoveListItemImpl, { file, itemPath: FR1, toIndex: 99 })).code, 'outOfRange');
    });

    test('SE-10: moveListItem across lists', async () => {
        const file = copy();
        const from = `${FR1}/acceptanceCriteria/ACE-CRIT-LST`;
        const to = `${FR}/FRE-REQU-LST-2/acceptanceCriteria/ACE-CRIT-LST`;
        const r = await run(specMoveListItemImpl, { file, itemPath: `${from}-2`, toIndex: 0, toList: to });
        assert.equal(r.ok, true, JSON.stringify(r));
        assert.equal(r.path, `${to}-1`);
        assert.equal(r.renamed[`${from}-2`], `${to}-1`);
        const list = await section(file, to);
        assert.deepEqual(list.items.map((i: Json) => i.sectionId), ['ACE-CRIT-2', 'ACE-CRIT-1']);
        const before = read(file);
        const collision = await run(specMoveListItemImpl, { file, itemPath: `${from}-1`, toIndex: 0, toList: to });
        assert.equal(collision.ok, false);
        assert.equal(collision.code, 'sectionIdCollision');
        assert.match(collision.error, /ACE-CRIT-1/);
        assert.equal(read(file), before);
    });

    test('SE-11: removeListItem reports the stale review entry and the broken count', async () => {
        const file = copy(`review:\n  "${FR}/FRE-REQU-LST-6":\n    comment: ok\n`);
        await run(specSetFormFieldImpl, { file, path: SYSCL, field: 'functionalRequirementCount', value: 6 });
        const r = JSON.parse(await withTiming('tomAi_specRemoveListItem:typical', () =>
            specRemoveListItemImpl(deps, { file, itemPath: `${FR}/FRE-REQU-LST-6` })));
        assert.equal(r.ok, true, JSON.stringify(r));
        assert.equal(r.sectionId, 'FRE-REQU-HOLD-RELEASE');
        assert.deepEqual(r.staleReviewPaths, [`${FR}/FRE-REQU-LST-6`]);
        assert.ok(r.validation.introduced.some((e: Json) => e.code === 'countMismatch'));
        assert.equal((await section(file, `${FR}/FRE-REQU-LST`)).items.length, 5);
    });

    test('SE-12: clearSection', async () => {
        const file = copy();
        const r = JSON.parse(await withTiming('tomAi_specClearSection:typical', () =>
            specClearSectionImpl(deps, { file, path: `${FR1}/FRED` })));
        assert.equal(r.ok, true, JSON.stringify(r));
        const s = await section(file, FR1);
        assert.ok(s.forms.FRED.fields.every((f: Json) => f.value === null));
    });

    test('SE-13: expectedRevision and dryRun', async () => {
        const file = copy();
        const conflict = await run(specSetContentImpl, { file, path: 'SBP/content', text: 'x', expectedRevision: 'deadbeef' });
        assert.equal(conflict.code, 'revisionConflict');
        assert.match(conflict.revision, /^[0-9a-f]{64}$/);
        const dry = await run(specSetContentImpl, { file, path: 'SBP/content', text: 'Dry.', dryRun: true, expectedRevision: conflict.revision });
        assert.equal(dry.ok, true);
        assert.equal(dry.written, false);
        assert.match(dry.diff, /^\+ +Dry\.$/m);
        assert.equal(read(file), MERIDIAN_YAML);
        const real = await run(specSetContentImpl, { file, path: 'SBP/content', text: 'Real.', expectedRevision: conflict.revision });
        assert.equal(real.written, true);
    });

    test('SE-14: create, add, validate — YAML and Markdown', async () => {
        for (const file of ['new/blueprint.docspecs.yaml', 'new/blueprint.md']) {
            const created = JSON.parse(await withTiming('tomAi_specCreateDocument:typical', () =>
                specCreateDocumentImpl(deps, { file, root: 'SBP' })));
            assert.equal(created.ok, true, JSON.stringify(created));
            assert.equal(created.document.stamp, service.modelVersion);
            assert.equal(created.document.readOnlyReason, null);
            assert.equal((await run(specCreateDocumentImpl, { file, root: 'SBP' })).code, 'exists');

            const content = await run(specSetContentImpl, { file, path: 'SBP/content', text: 'A blueprint.' });
            assert.equal(content.ok, true, JSON.stringify(content));
            const item = await run(specAddNodeImpl, {
                file, parentPath: FR, childSegment: 'FRE-REQU-LST', itemId: 'FRE-REQU-FIRST',
                fields: { [FRED]: { description: 'First requirement.' } },
            });
            assert.equal(item.ok, true, JSON.stringify(item));
            assert.equal(item.path, `${FR}/FRE-REQU-LST-1`);
            assert.equal(item.validation.total, 0, JSON.stringify(item.validation));
            const text = read(file);
            if (file.endsWith('.md')) {
                assert.match(text, /^<!-- docspec: solution-blueprint\/\d+\.\d+ -->/);
                assert.match(text, /<!--\[FRE-REQU-FIRST\]-->/);
            } else {
                assert.match(text, /^# TomSpecs document/);
                assert.match(text, /FRE-REQU-FIRST/);
            }
            assert.equal(field(await section(file, FR1), 'FRED', 'description').value, 'First requirement.');
        }
        assert.equal((await run(specCreateDocumentImpl, { file: 'x.docspecs.yaml', root: 'NOPE' })).code, 'unknownRoot');
    });

    test('SE-15: a read-only document is refused', async () => {
        // A non-canonical Markdown file: a save would rewrite it, so it is read-only.
        const odd = MERIDIAN_MD.replace('\n\n## ', '\n\n\n## ');
        fs.writeFileSync(path.join(ws, 'meridian.md'), odd);
        const r = await run(specSetContentImpl, { file: 'meridian.md', path: 'SBP/content', text: 'x' });
        assert.equal(r.code, 'readOnly');
        assert.match(r.error, /rewrite it/);
        assert.equal(read('meridian.md'), odd);
        // So is a document stamped with a newer model version.
        fs.writeFileSync(path.join(ws, 'newer.docspecs.yaml'), withStamp(MERIDIAN_YAML, '1.99'));
        assert.equal((await run(specSetContentImpl, { file: 'newer.docspecs.yaml', path: 'SBP/content', text: 'x' })).code, 'readOnly');
    });

    test('SE-16: all ten need approval and stay outside the MCP read-only floor', () => {
        assert.equal(SPEC_EDIT_TOOLS.length, 11, 'the ten single edits and the batch');
        assert.ok(SPEC_EDIT_TOOLS.every((t) => t.readOnly === false && t.requiresApproval === true));
        const floor = resolveEffectiveTools(SPEC_EDIT_TOOLS, { authenticated: false, allowWriteWithoutAuth: false });
        assert.deepEqual(floor, [], 'an unauthenticated MCP client sees none of them');
        assert.equal(resolveEffectiveTools(SPEC_EDIT_TOOLS, { authenticated: true, allowWriteWithoutAuth: false }).length, 11);
    });

    test('SE-17: a typed value leaf refuses what it cannot read as wrongValue', () => {
        const root = new SpecClass({
            name: 'Root', sectionId: 'R', annotations: [new SpecAnnotation('Document')], fields: [
                new SpecField({ name: 'count', kind: SpecFieldKind.SCALAR, type: 'int', sectionId: 'CNT' }),
                new SpecField({ name: 'level', kind: SpecFieldKind.ENUM, enumType: 'Level', enumValues: ['low', 'high'], sectionId: 'LVL' }),
            ],
        });
        const model = new SpecModel({ roots: [new SpecRoot({ type: 'Root', title: 'Root', sectionId: 'R' })], classes: new Map([['Root', root]]) });
        const editor = SpecEditor.forModel(new SpecDocument(), model);
        const refusal = (path: string, value: string | number): SpecEditRefusal => {
            try {
                setLeafValue(editor, path, value);
            } catch (e) {
                assert.ok(e instanceof SpecEditRefusal, `a refusal, not ${String(e)}`);
                return e;
            }
            assert.fail(`${JSON.stringify(value)} into ${path} was not refused`);
        };
        setLeafValue(editor, 'R/CNT', 6);
        const lots = refusal('R/CNT', 'lots');
        assert.equal(lots.code, 'wrongValue');
        assert.match(lots.message, /"lots" at R\/CNT: cannot be read as int/, 'the runtime\'s words');
        assert.deepEqual(lots.details, { field: { name: 'count', type: 'int' } });
        assert.equal(refusal('R/CNT', 2.5).code, 'wrongValue');
        assert.equal(editor.value('R/CNT'), 6, 'the leaf keeps its value');
        const level = refusal('R/LVL', 'medium');
        assert.deepEqual([level.code, level.details], ['wrongValue', { field: { name: 'level', type: 'Level', enumValues: ['low', 'high'] } }]);
        setLeafValue(editor, 'R/LVL', 'high');
        assert.equal(editor.value('R/LVL'), 'high');
    });

    test('SE-18: addNode with a headline', async () => {
        const file = copy();
        const r = await run(specAddNodeImpl, {
            file, parentPath: FR, childSegment: 'FRE-REQU-LST', itemId: 'FRE-REQU-ARCHIVE',
            headline: 'FR-07 — Archive closed orders',
            fields: { [FRED]: { description: 'The system must archive closed orders.' } },
        });
        assert.equal(r.ok, true, JSON.stringify(r));
        assert.equal(r.headline, 'FR-07 — Archive closed orders');
        const added = await section(file, r.path);
        assert.equal(added.headline, 'FR-07 — Archive closed orders');
        assert.equal(field(added, 'FRED', 'description').value, 'The system must archive closed orders.');

        const before = read(file);
        const broken = await run(specAddNodeImpl, { file, parentPath: FR, childSegment: 'FRE-REQU-LST', headline: 'two\nlines' });
        assert.equal(broken.code, 'invalidHeadline');
        const typed = await run(specAddNodeImpl, { file, parentPath: FR, childSegment: 'FRE-REQU-LST', headline: 7 });
        assert.equal(typed.code, 'invalidInput');
        assert.equal(read(file), before, 'a refused headline refuses the whole add');
        const set = await run(specSetHeadlineImpl, { file, path: r.path, headline: 'a\r\nb' });
        assert.equal(set.code, 'invalidHeadline');
        assert.equal(read(file), before);
    });
});
