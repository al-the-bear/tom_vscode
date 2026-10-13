/**
 * Plain DocSpecs Markdown tools (vsctsa8), in a temporary workspace with its
 * own `.tom/docspecs-schema/`.
 *
 *   DS-1  a conforming document validates clean against the nearest workspace schema
 *   DS-2  a broken copy reports its findings; an unknown schema and a missing header are findings
 *   DS-3  the schema is found in the nearest folder above; an explicit `schema` wins;
 *         a SOM rendition finds its generated schema; ignored schema keys are reported
 *   DS-4  outline: sections with line ranges, required and missing sections marked
 *   DS-5  getSection: the section's own body; unknown and repeated ids are refused
 *   DS-6  replace touches only the section's own lines, a fenced block included, and reports validation
 *   DS-7  replace refuses a body that changes structure, a stale revision, a dirty-in-editor file; dryRun writes nothing
 *   DS-8  a document in the older DocSpecs form gets a dialect note
 *   DS-9  registration: three read-only tools, replace needs approval
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
import {
    DOCSPECS_TOOLS,
    docspecsGetSectionImpl,
    docspecsOutlineImpl,
    docspecsReplaceSectionImpl,
    docspecsValidateImpl,
} from '../docspecs-tools.js';

const SCHEMA = [
    'title-format: "# <!--[DEMO]--> Demo"',
    'section-types:',
    '  ovr:',
    '    prefix: OVR',
    '    description: Overview',
    '    text-required: true',
    '  dec:',
    '    prefix: DEC',
    '    description: Decisions',
    '    subsection-types:',
    '      item:',
    '        min-count: 0',
    '        max-count: infinite',
    '  item:',
    '    prefix: ITEM',
    '    description: One decision',
    'document:',
    '  sections:',
    '    ovr:',
    '      section-type: ovr',
    '      optional: false',
    '    dec:',
    '      section-type: dec',
    '      optional: true',
    '',
].join('\n');

const GOOD = [
    '<!-- docspec: demo/1.0 -->',
    '# <!--[DEMO]--> Demo',
    '',
    '## <!--[OVR]--> Overview',
    '',
    'What this is.',
    '',
    '## <!--[DEC]--> Decisions',
    '',
    'Decisions so far.',
    '',
    '### <!--[ITEM-1]--> First',
    '',
    'We chose A.',
    '',
    '```yaml',
    '# a comment, not a heading',
    'key: value',
    '```',
    '',
    '### <!--[ITEM-2]--> Second',
    '',
    'We chose B.',
    '',
].join('\n');

const SAMPLES = path.resolve(__dirname, '..', '..', '..', '..', '..', 'ai_build', 'tom_som_dart_v0', 'documents');

const ws = fs.mkdtempSync(path.join(os.tmpdir(), 'docspecs-'));
const put = (name: string, text: string): string => {
    fs.mkdirSync(path.dirname(path.join(ws, name)), { recursive: true });
    fs.writeFileSync(path.join(ws, name), text);
    return name;
};
const read = (name: string): string => fs.readFileSync(path.join(ws, name), 'utf8');

const service = SomModelService.instance;
let dirty = new Set<string>();
const deps: SpecToolDeps = {
    wsRoot: ws,
    store: new SomDocumentStore(service, { ...nodeSomDocumentIo, isDirty: (p) => dirty.has(path.resolve(p)) }),
    service,
};
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Json = any;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const run = async (impl: (d: SpecToolDeps, i: any) => Promise<string>, input: object): Promise<Json> => JSON.parse(await impl(deps, input));

describe('DocSpecs Markdown tools', () => {
    before(() => {
        put('.tom/docspecs-schema/demo/demo.1.0.docspecs-schema.yaml', SCHEMA);
        put('docs/deep/good.md', GOOD);
    });

    test('DS-1: a conforming document validates clean', async () => {
        const r = JSON.parse(await withTiming('tomAi_docspecsValidate:typical', () =>
            docspecsValidateImpl(deps, { file: 'docs/deep/good.md' })));
        assert.equal(r.ok, true, JSON.stringify(r));
        assert.equal(r.passed, true, JSON.stringify(r.findings));
        assert.deepEqual(r.schema, {
            declared: 'demo/1.0', found: true, ref: 'demo/1.0', source: 'workspace',
            file: '.tom/docspecs-schema/demo/demo.1.0.docspecs-schema.yaml',
        });
        assert.match(r.revision, /^[0-9a-f]{64}$/);
    });

    test('DS-2: findings for a broken copy, an unknown schema and no header', async () => {
        put('docs/broken.md', GOOD.replace('## <!--[OVR]--> Overview\n\nWhat this is.\n\n', ''));
        const broken = await run(docspecsValidateImpl, { file: 'docs/broken.md' });
        assert.equal(broken.passed, false);
        assert.ok(broken.findings.some((f: Json) => f.rule === 'missingRequiredSection' && /"ovr"/.test(f.message)));

        put('docs/empty-overview.md', GOOD.replace('What this is.', ''));
        assert.ok((await run(docspecsValidateImpl, { file: 'docs/empty-overview.md' })).findings.some((f: Json) => f.rule === 'textRequired'));

        put('docs/unknown.md', GOOD.replace('demo/1.0', 'nosuch/2.0'));
        const unknown = await run(docspecsValidateImpl, { file: 'docs/unknown.md' });
        assert.equal(unknown.passed, false);
        assert.equal(unknown.findings[0].rule, 'unknownSchema');
        assert.equal(unknown.findings[0].line, 1);
        assert.match(unknown.findings[0].message, /nosuch\/2\.0/);
        assert.match(unknown.findings[0].message, /\.tom\/docspecs-schema\/nosuch\/nosuch\.2\.0\.docspecs-schema\.yaml/);
        assert.equal(unknown.schema.found, false);

        put('docs/no-header.md', GOOD.replace('<!-- docspec: demo/1.0 -->\n', ''));
        assert.equal((await run(docspecsValidateImpl, { file: 'docs/no-header.md' })).findings[0].rule, 'noSchemaDeclared');
        put('docs/opted-out.md', GOOD.replace('demo/1.0', 'none'));
        const none = await run(docspecsValidateImpl, { file: 'docs/opted-out.md' });
        assert.equal(none.passed, true, 'docspec: none declares no schema; only the structure is checked');
    });

    test('DS-3: where the schema comes from', async () => {
        // A closer schema of the same id wins over the workspace root's.
        put('docs/.tom/docspecs-schema/demo/demo.1.0.docspecs-schema.yaml', SCHEMA.replace('optional: true', 'optional: false'));
        put('docs/deep/no-decisions.md', GOOD.slice(0, GOOD.indexOf('## <!--[DEC]-->')));
        const near = await run(docspecsValidateImpl, { file: 'docs/deep/no-decisions.md' });
        assert.equal(near.schema.file, 'docs/.tom/docspecs-schema/demo/demo.1.0.docspecs-schema.yaml');
        assert.ok(near.findings.some((f: Json) => f.rule === 'missingRequiredSection' && /"dec"/.test(f.message)));
        const explicit = await run(docspecsValidateImpl, { file: 'docs/deep/no-decisions.md', schema: '.tom/docspecs-schema/demo/demo.1.0.docspecs-schema.yaml' });
        assert.equal(explicit.schema.source, 'argument');
        assert.equal(explicit.passed, true);
        fs.rmSync(path.join(ws, 'docs/.tom'), { recursive: true });

        put('meridian.md', fs.readFileSync(path.join(SAMPLES, 'meridian_order_management.md'), 'utf8'));
        const som = await run(docspecsValidateImpl, { file: 'meridian.md' });
        assert.equal(som.schema.source, 'generated');
        assert.equal(som.passed, true, JSON.stringify(som.findings.slice(0, 3)));

        put('docs/legacy-schema.md', GOOD.replace('demo/1.0', 'legacy/1.0'));
        put('.tom/docspecs-schema/legacy/legacy.1.0.docspecs-schema.yaml', SCHEMA.replace('    description: Decisions', '    description: Decisions\n    max-count-in-document: 1'));
        const ignored = await run(docspecsValidateImpl, { file: 'docs/legacy-schema.md' });
        assert.ok(ignored.schema.ignoredByRuntime.some((w: string) => /max-count-in-document/.test(w)), 'unsupported keys are reported, not silently dropped');
    });

    test('DS-4: outline with required and missing sections', async () => {
        const r = JSON.parse(await withTiming('tomAi_docspecsOutline:typical', () =>
            docspecsOutlineImpl(deps, { file: 'docs/broken.md' })));
        assert.equal(r.ok, true);
        assert.deepEqual(r.sections.map((s: Json) => s.id), ['DEMO', 'DEC', 'ITEM-1', 'ITEM-2']);
        const dec = r.sections.find((s: Json) => s.id === 'DEC');
        assert.deepEqual([dec.level, dec.children], [2, ['ITEM-1', 'ITEM-2']]);
        assert.equal(dec.endLine, read('docs/broken.md').split('\n').length, 'its subtree runs to the end');
        assert.deepEqual(r.requiredSections, ['ovr']);
        assert.equal(r.missingSections.length, 1);
        assert.match(r.missingSections[0].message, /"ovr"/);
    });

    test('DS-5: getSection', async () => {
        const r = JSON.parse(await withTiming('tomAi_docspecsGetSection:typical', () =>
            docspecsGetSectionImpl(deps, { file: 'docs/deep/good.md', sectionId: 'DEC' })));
        assert.equal(r.body, 'Decisions so far.', 'its own body, not its subsections');
        assert.deepEqual(r.children.map((c: Json) => c.id), ['ITEM-1', 'ITEM-2']);
        const item = await run(docspecsGetSectionImpl, { file: 'docs/deep/good.md', sectionId: 'ITEM-1' });
        assert.match(item.body, /```yaml\n# a comment, not a heading/);
        const unknown = await run(docspecsGetSectionImpl, { file: 'docs/deep/good.md', sectionId: 'NOPE' });
        assert.equal(unknown.code, 'unknownSection');
        assert.match(unknown.error, /OVR/);
        put('docs/twice.md', GOOD.replace('<!--[ITEM-2]-->', '<!--[ITEM-1]-->'));
        assert.match((await run(docspecsGetSectionImpl, { file: 'docs/twice.md', sectionId: 'ITEM-1' })).error, /2 sections have id/);
    });

    test('DS-6: replace touches only the section\'s own lines', async () => {
        const file = put('docs/edit.md', GOOD);
        const body = 'We chose A, then revisited it.\n\n```md\n## not a heading either\n```';
        const r = JSON.parse(await withTiming('tomAi_docspecsReplaceSection:typical', () =>
            docspecsReplaceSectionImpl(deps, { file, sectionId: 'ITEM-1', body })));
        assert.equal(r.ok, true, JSON.stringify(r));
        assert.equal(r.written, true);
        const after = read(file);
        const before = GOOD.split('\n');
        const lines = after.split('\n');
        // Everything up to ITEM-1's heading and from ITEM-2's heading on is unchanged.
        const head = before.indexOf('### <!--[ITEM-1]--> First');
        const tail = before.indexOf('### <!--[ITEM-2]--> Second');
        assert.deepEqual(lines.slice(0, head + 1), before.slice(0, head + 1));
        assert.deepEqual(lines.slice(lines.indexOf('### <!--[ITEM-2]--> Second')), before.slice(tail));
        assert.match(after, /We chose A, then revisited it\.\n\n```md\n## not a heading either\n```/);
        assert.doesNotMatch(after, /# a comment, not a heading/);
        assert.deepEqual(r.validation, { introduced: [], resolved: [], total: 0 });

        const fix = await run(docspecsReplaceSectionImpl, { file: put('docs/fix.md', GOOD.replace('What this is.', '')), sectionId: 'OVR', body: 'Now it says what it is.' });
        assert.equal(fix.validation.resolved[0].rule, 'textRequired', 'the replace reports the finding it fixed');
    });

    test('DS-7: replace refusals and dryRun', async () => {
        const file = put('docs/guarded.md', GOOD);
        const heading = await run(docspecsReplaceSectionImpl, { file, sectionId: 'OVR', body: 'text\n\n## A new heading' });
        assert.equal(heading.code, 'refused');
        assert.match(heading.error, /heading outside a fenced block/);
        const fence = await run(docspecsReplaceSectionImpl, { file, sectionId: 'OVR', body: '```\nnever closed' });
        assert.equal(fence.code, 'refused');
        const stale = await run(docspecsReplaceSectionImpl, { file, sectionId: 'OVR', body: 'x', expectedRevision: 'deadbeef' });
        assert.equal(stale.code, 'revisionConflict');
        dirty = new Set([path.resolve(ws, file)]);
        const blocked = await run(docspecsReplaceSectionImpl, { file, sectionId: 'OVR', body: 'x' });
        dirty = new Set();
        assert.equal(blocked.code, 'dirtyInEditor');
        const dry = await run(docspecsReplaceSectionImpl, { file, sectionId: 'OVR', body: 'Dry.', dryRun: true });
        assert.equal(dry.written, false);
        assert.match(dry.diff, /^\+Dry\.$/m);
        assert.equal(read(file), GOOD);
    });

    test('DS-8: the older DocSpecs form gets a dialect note', async () => {
        put('docs/old.md', '<!-- docspec: demo/1.0 -->\n# [overview-title] Old Style <!-- schema=demo-1.0 -->\n\nText.\n\n## [overview-main] Overview\n\nMore.\n');
        const r = await run(docspecsValidateImpl, { file: 'docs/old.md' });
        assert.match(r.dialect, /older DocSpecs form/);
        assert.ok(r.findings.some((f: Json) => f.rule === 'malformedHeading'));
        assert.equal((await run(docspecsValidateImpl, { file: 'docs/deep/good.md' })).dialect, undefined);
    });

    test('DS-9: registration', () => {
        assert.deepEqual(DOCSPECS_TOOLS.map((t) => [t.name, t.readOnly, t.requiresApproval ?? false]), [
            ['tomAi_docspecsValidate', true, false],
            ['tomAi_docspecsOutline', true, false],
            ['tomAi_docspecsGetSection', true, false],
            ['tomAi_docspecsReplaceSection', false, true],
        ]);
    });
});
