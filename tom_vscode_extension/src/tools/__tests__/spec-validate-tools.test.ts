/**
 * TomSpecs validate, render and convert (vsctsa7), on copies of the Meridian
 * sample.
 *
 *   SV-1  a clean sample validates clean, every tier run, schema id and version named
 *   SV-2  a bad enum value, a missing required form field and a broken countOf each
 *         give a finding whose path the edit tools take
 *   SV-3  `path` keeps only the findings under it
 *   SV-4  two fragments validate as one; an overlap names both writers
 *   SV-5  fragments of different roots are a decode finding; a broken file is a decode finding
 *   SV-6  render of the YAML sample equals the Markdown golden; a subtree renders alone
 *   SV-7  convert round-trips YAML → Markdown → YAML byte-identically
 *   SV-8  convert refuses unfaithful Markdown, an existing target, and dropping review entries unasked
 *   SV-9  registration: validate and render are read-only, convert needs approval
 */

import test, { before, describe } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import { installVscodeStub } from './_vscode-stub.js';
import { withTiming } from './_timing.js';
installVscodeStub({});

import { SpecEditor, yamlEncode } from 'tom_som_typescript_runtime';
import { SomModelService } from '../../services/som-model-service.js';
import { SomDocumentStore } from '../../services/som-document-store.js';
import { subtreeOf } from '../../services/som-spec-validation.js';
import type { SpecToolDeps } from '../spec-tool-common.js';
import { specGetSectionImpl } from '../spec-tools.js';
import { summarizeToolInput } from '../shared-tool-registry.js';
import {
    SPEC_CONVERT_TOOL,
    SPEC_VALIDATE_TOOLS,
    specConvertImpl,
    specRenderImpl,
    specValidateImpl,
} from '../spec-validate-tools.js';

const SAMPLES = path.resolve(__dirname, '..', '..', '..', '..', '..', 'ai_build', 'tom_som_dart_v0', 'documents');
const MERIDIAN_YAML = fs.readFileSync(path.join(SAMPLES, 'meridian_order_management.docspecs.yaml'), 'utf8');
const MERIDIAN_MD = fs.readFileSync(path.join(SAMPLES, 'meridian_order_management.md'), 'utf8');

const FR = 'SBP/introductionAndScope/requirements/functionalRequirements';
const FR1 = `${FR}/FRE-REQU-LST-1`;
const SYSCL = 'SBP/introductionAndScope/summary/SYSCL';

const ws = fs.mkdtempSync(path.join(os.tmpdir(), 'spec-validate-'));
const service = SomModelService.instance;
const store = new SomDocumentStore(service);
const deps: SpecToolDeps = { wsRoot: ws, store, service };

const put = (name: string, text: string): string => {
    fs.mkdirSync(path.dirname(path.join(ws, name)), { recursive: true });
    fs.writeFileSync(path.join(ws, name), text);
    return name;
};
const read = (name: string): string => fs.readFileSync(path.join(ws, name), 'utf8');
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Json = any;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const run = async (impl: (d: SpecToolDeps, i: any) => Promise<string>, input: object): Promise<Json> => JSON.parse(await impl(deps, input));

/** Meridian with three defects: a bad enum name, an empty required field, a wrong stated count. */
function brokenMeridian(): string {
    const loaded = store.load(path.join(ws, put('tmp-source.docspecs.yaml', MERIDIAN_YAML)));
    const doc = loaded.document;
    doc.setFormField(`${FR1}/FREP`, 'priority', 'urgent');
    doc.setFormField(`${FR}/FRE-REQU-LST-2/FRED`, 'description', '');
    doc.setFormField(SYSCL, 'functionalRequirementCount', '7');
    return put('broken.docspecs.yaml', store.render(loaded, { stamp: loaded.stamp }));
}

/** The YAML text of part of Meridian. */
function fragment(name: string, pick: (doc: Json) => Json): string {
    const doc = store.load(path.join(ws, put('tmp-whole.docspecs.yaml', MERIDIAN_YAML))).document;
    return put(name, yamlEncode(pick(doc), service.metaTree('SBP'), '1.3', null));
}

describe('TomSpecs validate, render and convert', () => {
    before(() => { void service.model; void service.metaTree('SBP'); put('meridian.docspecs.yaml', MERIDIAN_YAML); });

    test('SV-1: a clean sample validates clean', async () => {
        const r = JSON.parse(await withTiming('tomAi_specValidate:typical', () =>
            specValidateImpl(deps, { file: 'meridian.docspecs.yaml' })));
        assert.equal(r.ok, true, JSON.stringify(r));
        assert.equal(r.format, 'spec-validation');
        assert.equal(r.formatVersion, 1);
        assert.equal(r.passed, true);
        assert.equal(r.summary, 'all three tiers clean');
        assert.deepEqual(r.tiers.map((t: Json) => [t.tier, t.ran, t.findings]), [['decode', true, 0], ['schema', true, 0], ['instance', true, 0]]);
        assert.equal(r.root.schemaId, 'solution-blueprint');
        assert.match(r.root.schemaVersion, /^\d+\.\d+$/);
    });

    test('SV-2: each defect is a finding with a path the edit tools take', async () => {
        const file = brokenMeridian();
        const r = await run(specValidateImpl, { file });
        assert.equal(r.passed, false);
        const find = (tier: string, code: string): Json => r.violations.find((v: Json) => v.tier === tier && v.code === code);

        const enumFinding = find('instance', 'enumValueUnknown');
        assert.equal(enumFinding.path, `${FR1}/FREP`);
        const missing = find('schema', 'missingRequiredField');
        assert.equal(missing.path, `${FR}/FRE-REQU-LST-2/FRED`, 'the FRED of the second requirement, not any FRED');
        assert.equal(missing.location, 'FRED');
        assert.ok(missing.line > 0);
        assert.match(missing.message, /schema solution-blueprint\/\d+\.\d+/);
        const count = find('instance', 'countMismatch');
        assert.equal(count.path, SYSCL);
        assert.ok(r.violations.every((v: Json) => v.severity === 'error' && v.file === file));

        for (const v of r.violations) {
            const section = await run(specGetSectionImpl, { file, path: v.path });
            assert.equal(section.ok, true, `${v.path} resolves for the edit tools`);
        }
    });

    test('SV-3: path keeps only the findings under it', async () => {
        const r = await run(specValidateImpl, { file: 'broken.docspecs.yaml', path: FR });
        assert.equal(r.violations.length, 2);
        assert.ok(r.violations.every((v: Json) => v.path.startsWith(FR)));
        assert.equal(r.outOfScope, 1, 'the stated count in SYSCL lies outside');
        assert.match(r.summary, new RegExp(`under ${FR}`));
    });

    test('SV-4: fragments validate as one; overlaps name every writer', async () => {
        const rest = fragment('frag/rest.docspecs.yaml', (doc) => { doc.removeValuesUnder(FR); return doc; });
        const reqs = fragment('frag/requirements.docspecs.yaml', (doc) => subtreeOf(doc, FR));
        const together = JSON.parse(await withTiming('tomAi_specValidate:fragments', () =>
            specValidateImpl(deps, { files: [rest, reqs] })));
        assert.equal(together.passed, true, JSON.stringify(together.violations.slice(0, 3)));

        const twice = fragment('frag/first-requirement.docspecs.yaml', (doc) => subtreeOf(doc, FR1));
        const r = await run(specValidateImpl, { files: [reqs, twice] });
        const overlaps = r.violations.filter((v: Json) => v.code === 'overlap');
        assert.ok(overlaps.length > 0);
        // Both write the first requirement's values, and its place in the list.
        assert.ok(overlaps.every((v: Json) => v.tier === 'decode' && (v.path.startsWith(FR1) || v.path === `${FR}/FRE-REQU-LST`)));
        assert.ok(overlaps.some((v: Json) => v.path === `${FR1}/FRED`));
        assert.match(overlaps[0].message, /frag\/requirements\.docspecs\.yaml/);
        assert.match(overlaps[0].message, /frag\/first-requirement\.docspecs\.yaml/);
        assert.deepEqual(r.notRun.map((n: Json) => n.tier), ['schema', 'instance']);
    });

    test('SV-5: different roots and an unreadable file are decode findings', async () => {
        await store.create(path.join(ws, 'other.docspecs.yaml'), 'CLA');
        const roots = await run(specValidateImpl, { files: ['meridian.docspecs.yaml', 'other.docspecs.yaml'] });
        assert.equal(roots.violations[0].code, 'rootMismatch');
        const broken = put('broken-file.docspecs.yaml', 'version: 2\ndocument:\n  NOPE Nothing:\n    x: 1\n');
        const r = await run(specValidateImpl, { file: broken });
        assert.equal(r.violations[0].tier, 'decode');
        assert.equal(r.violations[0].code, 'unknownRoot');
        assert.equal((await run(specValidateImpl, { file: 'a', files: ['b'] })).code, 'invalidInput');
    });

    test('SV-6: render equals the Markdown golden; a subtree renders alone', async () => {
        const r = JSON.parse(await withTiming('tomAi_specRender:typical', () => specRenderImpl(deps, { file: 'meridian.docspecs.yaml' })));
        assert.equal(r.ok, true);
        assert.equal(r.markdown, MERIDIAN_MD, 'byte-identical to the shipped Markdown of the same document');
        const sub = await run(specRenderImpl, { file: 'meridian.docspecs.yaml', path: FR1 });
        assert.match(sub.markdown, /^<!-- docspec: solution-blueprint\/1\.3 -->/);
        assert.match(sub.markdown, /<!--\[FRE-REQU-ORDER-CAPTURE\]/);
        assert.doesNotMatch(sub.markdown, /FRE-REQU-SYNC-PRICING/);
        assert.ok(sub.lines < r.lines / 10);
        assert.equal((await run(specRenderImpl, { file: 'meridian.docspecs.yaml', path: `${FR}/FRE-REQU-LST-99` })).code, 'unresolvedPath');
    });

    test('SV-7: convert round-trips YAML → Markdown → YAML', async () => {
        const created = await store.create(path.join(ws, 'rt/clean.docspecs.yaml'), 'SBP');
        const editor = SpecEditor.forModel(created.document, service.model);
        editor.setValue('SBP/content', 'A clean blueprint.');
        const item = editor.addListItem(`${FR}/FRE-REQU-LST`, 'FRE-REQU-ONE');
        editor.setFormValue(`${item}/FRED`, 'description', 'The one requirement.');
        await store.save(created);
        const original = read('rt/clean.docspecs.yaml');

        const toMd = JSON.parse(await withTiming('tomAi_specConvert:typical', () => specConvertImpl(deps, { file: 'rt/clean.docspecs.yaml' })));
        assert.equal(toMd.ok, true, JSON.stringify(toMd));
        assert.equal(toMd.target, 'rt/clean.md');
        assert.equal(toMd.format, 'markdown');
        assert.match(read('rt/clean.md'), /<!--\[FRE-REQU-ONE\]-->/);

        const back = await run(specConvertImpl, { file: 'rt/clean.md', target: 'rt/back.docspecs.yaml' });
        assert.equal(back.ok, true, JSON.stringify(back));
        assert.equal(read('rt/back.docspecs.yaml'), original, 'byte-identical after the round trip');
    });

    test('SV-8: convert refusals and the review pass', async () => {
        put('golden.md', MERIDIAN_MD);
        const unfaithful = await run(specConvertImpl, { file: 'golden.md' });
        assert.equal(unfaithful.code, 'readOnly');
        assert.match(unfaithful.error, /qrb8/);

        const exists = await run(specConvertImpl, { file: 'rt/clean.docspecs.yaml' });
        assert.equal(exists.code, 'exists');
        const same = await run(specConvertImpl, { file: 'rt/clean.docspecs.yaml', target: 'rt/x.docspecs.yaml' });
        assert.equal(same.code, 'sameFormat');

        put('reviewed.docspecs.yaml', `${read('rt/clean.docspecs.yaml')}review:\n  "SBP/content":\n    comment: ok\n`);
        const refused = await run(specConvertImpl, { file: 'reviewed.docspecs.yaml' });
        assert.equal(refused.code, 'reviewWouldBeDropped');
        assert.ok(!fs.existsSync(path.join(ws, 'reviewed.md')));
        const dry = await run(specConvertImpl, { file: 'reviewed.docspecs.yaml', dropReview: true, dryRun: true });
        assert.equal(dry.written, false);
        assert.match(dry.diff, /^\+<!-- docspec:/m);
        assert.ok(!fs.existsSync(path.join(ws, 'reviewed.md')));
        const dropped = await run(specConvertImpl, { file: 'reviewed.docspecs.yaml', dropReview: true });
        assert.equal(dropped.written, true);
        assert.equal(dropped.droppedReviewEntries, 1);
        assert.match(read('reviewed.docspecs.yaml'), /^review:/m, 'the source keeps its review pass');
    });

    test('SV-9: registration', () => {
        const [validate, render, convert] = SPEC_VALIDATE_TOOLS;
        assert.deepEqual([validate.readOnly, render.readOnly, convert.readOnly], [true, true, false]);
        assert.equal(convert.requiresApproval, true);
        assert.equal(summarizeToolInput(SPEC_CONVERT_TOOL, { file: 'a.docspecs.yaml', overwrite: true }), 'Convert a.docspecs.yaml → a.md (overwrites it)');
    });
});
