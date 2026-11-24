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
 *   SV-8  convert refuses non-canonical Markdown, an existing target, and dropping review entries unasked
 *   SV-9  registration: validate and render are read-only, convert needs approval
 *   SV-10 the default convert target: `X.tomspecs.yaml` ↔ `X.tomspecs.md`, beside the source
 *   SV-11 render switches (05b_rdv3): drop, unmark and appendix each change the rendition and are counted per
 *         kind; lists and comma-joined strings, `all`; appendix references; heading divs; the readable header
 *         line; `withoutAnnotations` is drop comments and combines with drop; refs and records are never dropped;
 *         a subtree of the stripped document; nothing is written
 *   SV-12 the CLI's usage errors: an unknown name, a name in two lists, comments to unmark or move, appendix
 *         references without an appendix, an empty name list, a value that is no list of names
 *   SV-13 the tool's schema and description name every switch (what tomAi_describeTool shows)
 */

import test, { before, describe } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import { installVscodeStub } from './_vscode-stub.js';
import { withTiming } from './_timing.js';
import { renderedMarkdown, stampOf } from './_somSamples.js';
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
    SPEC_RENDER_TOOL,
    SPEC_VALIDATE_TOOLS,
    defaultConvertTarget,
    specConvertImpl,
    specRenderImpl,
    specValidateImpl,
} from '../spec-validate-tools.js';

const SAMPLES = path.resolve(__dirname, '..', '..', '..', '..', '..', 'ai_build', 'tom_som_dart_v0', 'documents');
const MERIDIAN_YAML = fs.readFileSync(path.join(SAMPLES, 'meridian_order_management.tomspecs.yaml'), 'utf8');
// Rendered by this build's runtime: ai_build's committed .tomspecs.md may be in an older layout (_somSamples.ts).
const MERIDIAN_MD = renderedMarkdown(MERIDIAN_YAML);

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
    const loaded = store.load(path.join(ws, put('tmp-source.tomspecs.yaml', MERIDIAN_YAML)));
    const doc = loaded.document;
    doc.setFormField(`${FR1}/FREP`, 'priority', 'urgent');
    doc.setFormField(`${FR}/FRE-REQU-LST-2/FRED`, 'description', '');
    doc.setFormField(SYSCL, 'functionalRequirementCount', '7');
    return put('broken.tomspecs.yaml', store.render(loaded, { stamp: loaded.stamp }));
}

/** Meridian with the reading notation of every kind, a review comment, a reference list and a records table in its content. */
const NOTATED_TEXT = [
    'The order system replaces the spreadsheets.',
    '',
    '::: {.provenance}',
    'Taken from the kickoff workshop.',
    ':::',
    '',
    'Orders are kept [three years]{.aside} (-> C2.1).',
    '',
    '::: {.editorial}',
    'Check the retention with legal.',
    ':::',
    '',
    '> ⬆️ **C-3** (Bob): What about returns?',
    '',
    'Orders are {++ always ++} archived.',
    '',
    '::: {.refs}',
    '- [FRE-REQU-ORDER-CAPTURE](#FRE-REQU-ORDER-CAPTURE)',
    ':::',
].join('\n');
function notatedMeridian(name: string): string {
    const loaded = store.load(path.join(ws, put(`tmp-${name}`, MERIDIAN_YAML)));
    loaded.document.setContent('SBP/content', NOTATED_TEXT);
    return put(name, store.render(loaded, { stamp: loaded.stamp }));
}

/** The YAML text of part of Meridian. */
function fragment(name: string, pick: (doc: Json) => Json): string {
    const doc = store.load(path.join(ws, put('tmp-whole.tomspecs.yaml', MERIDIAN_YAML))).document;
    return put(name, yamlEncode(pick(doc), service.metaTree('SBP'), '1.3', null));
}

describe('TomSpecs validate, render and convert', () => {
    before(() => { void service.model; void service.metaTree('SBP'); put('meridian.tomspecs.yaml', MERIDIAN_YAML); });

    test('SV-1: a clean sample validates clean', async () => {
        const r = JSON.parse(await withTiming('tomAi_specValidate:typical', () =>
            specValidateImpl(deps, { file: 'meridian.tomspecs.yaml' })));
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
        // Compared with the unfiltered run, not with fixed counts: how many findings one broken value
        // produces is the runtime's business (an emptied required field also became a value finding).
        const all = await run(specValidateImpl, { file: 'broken.tomspecs.yaml' });
        const under = all.violations.filter((v: Json) => v.path.startsWith(FR));
        const r = await run(specValidateImpl, { file: 'broken.tomspecs.yaml', path: FR });
        assert.ok(under.length >= 2, 'the enum and the emptied description lie under FR');
        assert.deepEqual(r.violations, under, 'exactly the findings under FR');
        assert.equal(r.outOfScope, all.violations.length - under.length);
        assert.ok(all.violations.some((v: Json) => v.path === SYSCL && !v.path.startsWith(FR)), 'the stated count in SYSCL lies outside');
        assert.match(r.summary, new RegExp(`under ${FR}`));
    });

    test('SV-4: fragments validate as one; overlaps name every writer', async () => {
        const rest = fragment('frag/rest.tomspecs.yaml', (doc) => { doc.removeValuesUnder(FR); return doc; });
        const reqs = fragment('frag/requirements.tomspecs.yaml', (doc) => subtreeOf(doc, FR));
        const together = JSON.parse(await withTiming('tomAi_specValidate:fragments', () =>
            specValidateImpl(deps, { files: [rest, reqs] })));
        assert.equal(together.passed, true, JSON.stringify(together.violations.slice(0, 3)));

        const twice = fragment('frag/first-requirement.tomspecs.yaml', (doc) => subtreeOf(doc, FR1));
        const r = await run(specValidateImpl, { files: [reqs, twice] });
        const overlaps = r.violations.filter((v: Json) => v.code === 'overlap');
        assert.ok(overlaps.length > 0);
        // Both write the first requirement's values, and its place in the list.
        assert.ok(overlaps.every((v: Json) => v.tier === 'decode' && (v.path.startsWith(FR1) || v.path === `${FR}/FRE-REQU-LST`)));
        assert.ok(overlaps.some((v: Json) => v.path === `${FR1}/FRED`));
        assert.match(overlaps[0].message, /frag\/requirements\.tomspecs\.yaml/);
        assert.match(overlaps[0].message, /frag\/first-requirement\.tomspecs\.yaml/);
        assert.deepEqual(r.notRun.map((n: Json) => n.tier), ['schema', 'instance']);
    });

    test('SV-5: different roots and an unreadable file are decode findings', async () => {
        await store.create(path.join(ws, 'other.tomspecs.yaml'), 'CLA');
        const roots = await run(specValidateImpl, { files: ['meridian.tomspecs.yaml', 'other.tomspecs.yaml'] });
        assert.equal(roots.violations[0].code, 'rootMismatch');
        const broken = put('broken-file.tomspecs.yaml', 'version: 2\ndocument:\n  NOPE Nothing:\n    x: 1\n');
        const r = await run(specValidateImpl, { file: broken });
        assert.equal(r.violations[0].tier, 'decode');
        assert.equal(r.violations[0].code, 'unknownRoot');
        assert.equal((await run(specValidateImpl, { file: 'a', files: ['b'] })).code, 'invalidInput');
    });

    test('SV-6: render equals the Markdown golden; a subtree renders alone', async () => {
        const r = JSON.parse(await withTiming('tomAi_specRender:typical', () => specRenderImpl(deps, { file: 'meridian.tomspecs.yaml' })));
        assert.equal(r.ok, true);
        assert.equal(r.markdown, MERIDIAN_MD, 'byte-identical to the Markdown the store renders of the same document');
        const sub = await run(specRenderImpl, { file: 'meridian.tomspecs.yaml', path: FR1 });
        assert.ok(sub.markdown.startsWith(`<!-- docspec: solution-blueprint/${stampOf(MERIDIAN_YAML)} -->`), 'under the document\'s own header');
        assert.match(sub.markdown, /<!--\[FRE-REQU-ORDER-CAPTURE\]/);
        assert.doesNotMatch(sub.markdown, /FRE-REQU-SYNC-PRICING/);
        assert.ok(sub.lines < r.lines / 10);
        assert.equal((await run(specRenderImpl, { file: 'meridian.tomspecs.yaml', path: `${FR}/FRE-REQU-LST-99` })).code, 'unresolvedPath');
    });

    test('SV-7: convert round-trips YAML → Markdown → YAML', async () => {
        const created = await store.create(path.join(ws, 'rt/clean.tomspecs.yaml'), 'SBP');
        const editor = SpecEditor.forModel(created.document, service.model);
        editor.setValue('SBP/content', 'A clean blueprint.');
        const item = editor.addListItem(`${FR}/FRE-REQU-LST`, 'FRE-REQU-ONE');
        editor.setFormValue(`${item}/FRED`, 'description', 'The one requirement.');
        await store.save(created);
        const original = read('rt/clean.tomspecs.yaml');

        const toMd = JSON.parse(await withTiming('tomAi_specConvert:typical', () => specConvertImpl(deps, { file: 'rt/clean.tomspecs.yaml' })));
        assert.equal(toMd.ok, true, JSON.stringify(toMd));
        assert.equal(toMd.target, 'rt/clean.tomspecs.md');
        assert.equal(toMd.format, 'markdown');
        assert.match(read('rt/clean.tomspecs.md'), /<!--\[FRE-REQU-ONE\]-->/);

        const back = await run(specConvertImpl, { file: 'rt/clean.tomspecs.md', target: 'rt/back.tomspecs.yaml' });
        assert.equal(back.ok, true, JSON.stringify(back));
        assert.equal(read('rt/back.tomspecs.yaml'), original, 'byte-identical after the round trip');
    });

    test('SV-8: convert refusals and the review pass', async () => {
        put('odd.md', MERIDIAN_MD.replace('\n\n## ', '\n\n\n## '));
        const unfaithful = await run(specConvertImpl, { file: 'odd.md' });
        assert.equal(unfaithful.code, 'readOnly');
        assert.match(unfaithful.error, /rewrite it/);

        const exists = await run(specConvertImpl, { file: 'rt/clean.tomspecs.yaml' });
        assert.equal(exists.code, 'exists');
        const same = await run(specConvertImpl, { file: 'rt/clean.tomspecs.yaml', target: 'rt/x.tomspecs.yaml' });
        assert.equal(same.code, 'sameFormat');

        put('reviewed.tomspecs.yaml', `${read('rt/clean.tomspecs.yaml')}review:\n  "SBP/content":\n    comment: ok\n`);
        const refused = await run(specConvertImpl, { file: 'reviewed.tomspecs.yaml' });
        assert.equal(refused.code, 'reviewWouldBeDropped');
        assert.ok(!fs.existsSync(path.join(ws, 'reviewed.md')));
        const dry = await run(specConvertImpl, { file: 'reviewed.tomspecs.yaml', dropReview: true, dryRun: true });
        assert.equal(dry.written, false);
        assert.match(dry.diff, /^\+<!-- docspec:/m);
        assert.ok(!fs.existsSync(path.join(ws, 'reviewed.md')));
        const dropped = await run(specConvertImpl, { file: 'reviewed.tomspecs.yaml', dropReview: true });
        assert.equal(dropped.written, true);
        assert.equal(dropped.droppedReviewEntries, 1);
        assert.match(read('reviewed.tomspecs.yaml'), /^review:/m, 'the source keeps its review pass');
    });

    test('SV-9: registration', () => {
        const [validate, render, convert] = SPEC_VALIDATE_TOOLS;
        assert.deepEqual([validate.readOnly, render.readOnly, convert.readOnly], [true, true, false]);
        assert.equal(convert.requiresApproval, true);
        assert.equal(summarizeToolInput(SPEC_CONVERT_TOOL, { file: 'a.tomspecs.yaml', overwrite: true }), 'Convert a.tomspecs.yaml → a.tomspecs.md (overwrites it)');
    });
});

describe('TomSpecs convert target names', () => {
    test('SV-10: the default convert target is the other `*.tomspecs.*` name beside the source', () => {
        assert.equal(defaultConvertTarget('specs/tom_uam.sbp.tomspecs.yaml'), 'specs/tom_uam.sbp.tomspecs.md');
        assert.equal(defaultConvertTarget('specs/tom_uam.sbp.tomspecs.md'), 'specs/tom_uam.sbp.tomspecs.yaml');
        assert.equal(defaultConvertTarget('specs/draft.md'), 'specs/draft.tomspecs.yaml');
        assert.equal(defaultConvertTarget('specs/draft'), 'specs/draft.tomspecs.md');
    });
});

describe('TomSpecs render switches', () => {
    before(() => { void service.model; void service.metaTree('SBP'); });

    test('SV-11: drop, unmark, appendix, references, heading divs, the header, the counts', async () => {
        const file = notatedMeridian('notated.tomspecs.yaml');
        const before = read(file);
        const plain = await run(specRenderImpl, { file });
        assert.equal(plain.ok, true);
        assert.equal(plain.readableHeader, undefined, 'no switch: a plain render');
        assert.match(plain.markdown, /Taken from the kickoff workshop\./);

        const dropped = JSON.parse(await withTiming('tomAi_specRender:switches', () => specRenderImpl(deps, { file, drop: ['provenance', 'editorial'] })));
        assert.equal(dropped.ok, true, JSON.stringify(dropped));
        assert.doesNotMatch(dropped.markdown, /kickoff workshop|Check the retention/, 'dropped with their content');
        assert.match(dropped.markdown, /three years/, 'the other kinds stay');
        assert.match(dropped.readableHeader, /^<!-- readable: drop=provenance,editorial; .*of=notated\.tomspecs\.yaml@[0-9a-f]{64}/);
        assert.ok(dropped.markdown.includes(dropped.readableHeader), 'the rendition carries the header line');
        assert.deepEqual(dropped.stripped.provenance, { dropped: 1, unmarked: 0, moved: 0 });
        assert.deepEqual(dropped.stripped.editorial, { dropped: 1, unmarked: 0, moved: 0 });
        assert.deepEqual(dropped.stripped.aside, { dropped: 0, unmarked: 0, moved: 0 });
        assert.deepEqual(dropped.kept, []);
        assert.equal(dropped.valid, true, JSON.stringify(dropped.findings));
        assert.ok(dropped.report.some((l: string) => l === 'provenance: 1 dropped, 0 unmarked, 0 moved'));

        const joined = await run(specRenderImpl, { file, drop: 'provenance,editorial' });
        assert.equal(joined.markdown, dropped.markdown, 'a comma-joined string is the same list');

        const unmarked = await run(specRenderImpl, { file, unmark: ['aside', 'trace'] });
        assert.equal(unmarked.ok, true, JSON.stringify(unmarked));
        assert.match(unmarked.markdown, /Orders are kept three years \(C2\.1\)\./, 'markers gone, text kept (a citation keeps its ids)');
        assert.doesNotMatch(unmarked.markdown, /\{\.aside\}|\(-> C2\.1\)/);
        assert.deepEqual([unmarked.stripped.aside.unmarked, unmarked.stripped.trace.unmarked], [1, 1]);

        const moved = await run(specRenderImpl, { file, appendix: ['provenance'], appendixReferences: true });
        assert.equal(moved.ok, true, JSON.stringify(moved));
        assert.equal(moved.stripped.provenance.moved, 1);
        assert.equal(moved.appendixEntries, 1);
        assert.match(moved.markdown, /Taken from the kickoff workshop\./, 'the moved text is in the appendix');
        assert.match(moved.markdown, /\[1\]/, 'a reference to its entry');
        assert.match(moved.readableHeader, /appendix=provenance; appendix-references/);

        const all = await run(specRenderImpl, { file, drop: 'all', unmark: 'trace' });
        assert.equal(all.ok, true, JSON.stringify(all));
        assert.equal(all.stripped.trace.unmarked, 1, '`all` leaves out what another list names');
        assert.deepEqual([all.stripped.provenance.dropped, all.stripped.editorial.dropped, all.stripped.aside.dropped], [1, 1, 1]);
        assert.doesNotMatch(all.markdown, /What about returns|\{\+\+/, 'all drops the comments too');
        assert.match(all.markdown, /\[FRE-REQU-ORDER-CAPTURE\]/, 'refs are never dropped');

        const divs = await run(specRenderImpl, { file, headingDivs: true });
        assert.equal(divs.ok, true, JSON.stringify(divs));
        assert.match(divs.readableHeader, /headings=divs/);

        const without = await run(specRenderImpl, { file, withoutAnnotations: true });
        assert.equal(without.withoutAnnotations, true);
        assert.match(without.readableHeader, /drop=comments/, 'withoutAnnotations is drop comments');
        assert.match(without.markdown, /Orders are always archived\./, 'marks accepted');
        assert.doesNotMatch(without.markdown, /⬆️/);
        const both = await run(specRenderImpl, { file, withoutAnnotations: true, drop: ['aside'] });
        assert.match(both.readableHeader, /drop=aside,comments/, 'combined with drop');

        const sub = await run(specRenderImpl, { file, drop: ['provenance'], path: FR1 });
        assert.equal(sub.ok, true, JSON.stringify(sub));
        assert.match(sub.markdown, /<!--\[FRE-REQU-ORDER-CAPTURE\]/);
        assert.equal((await run(specRenderImpl, { file, drop: ['provenance'], path: `${FR}/FRE-REQU-LST-99` })).code, 'unresolvedPath');
        assert.equal(read(file), before, 'nothing written');
    });

    test('SV-12: the usage errors', async () => {
        const file = notatedMeridian('usage.tomspecs.yaml');
        const usage = async (input: object, message: RegExp): Promise<void> => {
            const r = await run(specRenderImpl, { file, ...input });
            assert.equal(r.ok, false, JSON.stringify(input));
            assert.equal(r.code, 'usageError', JSON.stringify(r));
            assert.match(r.error, message);
        };
        await usage({ drop: ['footnotes'] }, /unknown kind name "footnotes" in drop/);
        await usage({ drop: ['refs'] }, /unknown kind name "refs"/);
        await usage({ unmark: ['records'] }, /unknown kind name "records" in unmark/);
        await usage({ drop: ['aside'], unmark: 'aside' }, /"aside" is in both drop and unmark/);
        await usage({ unmark: ['comments'] }, /comments cannot be unmarked/);
        await usage({ appendix: ['comments'] }, /comments cannot be moved to the appendix/);
        await usage({ appendixReferences: true }, /appendix references need an appendix/);
        await usage({ drop: '' }, /-drop: needs kind names/);
        await usage({ appendix: [' '] }, /-appendix: needs kind names/);
        await usage({ unmark: [3] }, /`unmark` takes kind names/);
        assert.equal((await run(specRenderImpl, { file, withoutAnnotations: true, drop: ['comments'] })).ok, true, 'comments named twice in drop is no conflict');
    });

    test('SV-13: the schema names every switch', () => {
        const props = SPEC_RENDER_TOOL.inputSchema.properties as Record<string, { type: unknown; description: string }>;
        for (const key of ['drop', 'unmark', 'appendix', 'appendixReferences', 'headingDivs', 'withoutAnnotations']) {
            assert.ok(props[key], key);
        }
        assert.deepEqual(props.drop.type, ['array', 'string']);
        assert.equal(props.appendixReferences.type, 'boolean');
        for (const word of ['drop', 'unmark', 'appendix', 'appendixReferences', 'headingDivs', 'usageError', 'readableHeader', '`refs`, `records`']) {
            assert.ok(SPEC_RENDER_TOOL.description.includes(word), word);
        }
        assert.match(SPEC_RENDER_TOOL.description, /never dropped/);
    });
});
