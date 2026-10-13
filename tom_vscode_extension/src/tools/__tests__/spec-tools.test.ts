/**
 * TomSpecs read-only tools (vsctsa3): specListDocuments, specOutline,
 * specGetSection, specReflect — against copies of the Meridian sample in a
 * temporary workspace.
 *
 *   ST-1   listDocuments finds YAML and SOM Markdown, skips non-SOM files and
 *          skipped folders, reports stamp and editability
 *   ST-2   listDocuments stops at maxResults or its time budget and says which; refuses a dir outside
 *   ST-3   outline: root first, depth, paging continues where the page ended
 *   ST-4   outline: every node kind agrees with the runtime's resolution
 *   ST-5   outline: filledOnly leaves empty subtrees out; the full tree stays in budget
 *   ST-6   getSection of a list item: section id, headline, typed forms with enum domains, children
 *   ST-7   getSection of a value leaf, a form and a list
 *   ST-8   an unresolvable path names the nearest node and its children
 *   ST-9   reflect by class name; an unknown class lists similar names
 *   ST-10  reflect by path with a file: addable is exactly what checkAddNode accepts
 *   ST-11  reflect of a list with a file; exactly one of path / className
 *   ST-12  Markdown: the outline works on the sample's Markdown, which is editable
 *   ST-13  all four are read-only tools
 */

import test, { before, describe } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import { installVscodeStub } from './_vscode-stub.js';
import { withTiming } from './_timing.js';
installVscodeStub({});

import { checkAddNode } from 'tom_som_typescript_runtime';
import { SomModelService } from '../../services/som-model-service.js';
import { SomDocumentStore } from '../../services/som-document-store.js';
import {
    SPEC_TOOLS,
    SpecToolDeps,
    specGetSectionImpl,
    specListDocumentsImpl,
    specOutlineImpl,
    specReflectImpl,
} from '../spec-tools.js';

const SAMPLES = path.resolve(__dirname, '..', '..', '..', '..', '..', 'ai_build', 'tom_som_dart_v0', 'documents');
const MERIDIAN_YAML = fs.readFileSync(path.join(SAMPLES, 'meridian_order_management.docspecs.yaml'), 'utf8');
const MERIDIAN_MD = fs.readFileSync(path.join(SAMPLES, 'meridian_order_management.md'), 'utf8');

const FR = 'SBP/introductionAndScope/requirements/functionalRequirements';
const FR1 = `${FR}/FRE-REQU-LST-1`;

const ws = fs.mkdtempSync(path.join(os.tmpdir(), 'spec-tools-'));
function put(rel: string, text: string): void {
    const p = path.join(ws, rel);
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, text);
}
put('specs/meridian.docspecs.yaml', MERIDIAN_YAML);
put('specs/meridian.md', MERIDIAN_MD);
put('specs/sub/newer.docspecs.yaml', MERIDIAN_YAML.replace('modelVersion: "1.3"', 'modelVersion: "1.99"'));
put('specs/notes.md', '# Notes\n\nNot a SOM document.\n');
put('specs/config.yaml', 'key: value\n');
put('node_modules/pkg/hidden.docspecs.yaml', MERIDIAN_YAML);
put('.hidden/hidden.docspecs.yaml', MERIDIAN_YAML);

const service = SomModelService.instance;
const deps: SpecToolDeps = { wsRoot: ws, store: new SomDocumentStore(service), service };
const YAML_FILE = 'specs/meridian.docspecs.yaml';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const call = async (impl: (d: SpecToolDeps, i: any) => Promise<string>, input: unknown): Promise<any> => JSON.parse(await impl(deps, input));

describe('TomSpecs read-only tools', () => {
    before(() => {
        // The 'typical' timings run warm: the model is parsed once per process.
        void service.model;
        void service.metaTree('SBP');
    });

    test('ST-1: listDocuments finds the SOM documents and nothing else', async () => {
        const r = JSON.parse(await withTiming('tomAi_specListDocuments:typical', () => specListDocumentsImpl(deps, {})));
        assert.equal(r.ok, true);
        assert.equal(r.modelVersion, service.modelVersion);
        assert.ok(r.roots.some((x: { sectionId: string }) => x.sectionId === 'SBP'));
        assert.equal(r.roots.length, service.model.roots.length);
        assert.deepEqual(r.documents.map((d: { file: string }) => d.file), [
            'specs/meridian.docspecs.yaml',
            'specs/meridian.md',
            'specs/sub/newer.docspecs.yaml',
        ]);
        const [yaml, md, newer] = r.documents;
        assert.deepEqual([yaml.format, yaml.root, yaml.stamp, yaml.editability], ['yaml', 'SBP', '1.3', 'editable']);
        assert.equal(yaml.readOnlyReason, undefined);
        assert.deepEqual([md.format, md.root, md.stamp], ['markdown', 'SBP', '1.3']);
        assert.equal(newer.editability, 'rejectedNewerMinor');
        assert.match(newer.readOnlyReason, /1\.99/);
        assert.equal(r.truncated, undefined);
    });

    test('ST-2: listDocuments stops at maxResults; a dir outside the workspace is refused', async () => {
        const r = await call(specListDocumentsImpl, { dir: 'specs', maxResults: 1 });
        assert.equal(r.documents.length, 1);
        assert.equal(r.truncated, true);
        assert.equal(r.stoppedBy, 'maxResults');
        assert.equal(r.searched, 'specs');
        const late = JSON.parse(await specListDocumentsImpl({ ...deps, listTimeBudgetMs: -1 }, {}));
        assert.deepEqual([late.ok, late.truncated, late.stoppedBy, late.documents.length], [true, true, 'time', 0]);
        const outside = await call(specListDocumentsImpl, { dir: '..' });
        assert.equal(outside.ok, false);
        assert.match(outside.error, /outside the workspace/);
    });

    test('ST-3: outline starts at the root, honours depth and pages', async () => {
        const first = JSON.parse(await withTiming('tomAi_specOutline:typical', () =>
            specOutlineImpl(deps, { file: YAML_FILE, limit: 10 })));
        assert.equal(first.ok, true);
        assert.equal(first.document.format, 'yaml');
        assert.match(first.document.revision, /^[0-9a-f]{64}$/);
        assert.equal(first.document.readOnlyReason, null);
        assert.deepEqual(first.nodes[0], { path: 'SBP', kind: 'root', filled: true, sectionId: 'SBP', headline: 'Solution Blueprint', depth: 0 });
        assert.ok(first.nodes.every((n: { depth: number }) => n.depth <= 2));
        assert.equal(first.nodes.length, 10);
        assert.equal(first.nextOffset, 10);
        const all = await call(specOutlineImpl, { file: YAML_FILE, limit: 100000 });
        const second = await call(specOutlineImpl, { file: YAML_FILE, limit: 10, offset: first.nextOffset });
        assert.deepEqual(second.nodes, all.nodes.slice(10, 20));
        assert.equal(all.nextOffset, undefined);
        assert.equal(all.total, all.nodes.length);
    });

    test('ST-4: every outline kind agrees with the runtime', async () => {
        const r = await call(specOutlineImpl, { file: YAML_FILE, path: FR, depth: 4, limit: 100000 });
        assert.ok(r.nodes.length > 20);
        for (const n of r.nodes) {
            assert.equal(service.reflection.resolve(n.path)?.kind, n.kind, n.path);
        }
        const list = r.nodes.find((n: { path: string }) => n.path === `${FR}/FRE-REQU-LST`);
        assert.equal(list.itemCount, list && r.nodes.filter((n: { path: string; kind: string }) =>
            n.kind === 'listItemComplex' && n.path.startsWith(`${FR}/FRE-REQU-LST-`) && n.path.split('/').length === FR.split('/').length + 1).length);
    });

    test('ST-5: filledOnly, and the full tree within the budget', async () => {
        const filled = await call(specOutlineImpl, { file: YAML_FILE, depth: 12, filledOnly: true, limit: 100000 });
        assert.ok(filled.nodes.every((n: { filled: boolean }) => n.filled));
        const full = JSON.parse(await withTiming('tomAi_specOutline:full-depth', () =>
            specOutlineImpl(deps, { file: YAML_FILE, depth: 12, limit: 100000 })));
        assert.ok(full.total > filled.total);
    });

    test('ST-6: getSection of a list item', async () => {
        const r = JSON.parse(await withTiming('tomAi_specGetSection:typical', () =>
            specGetSectionImpl(deps, { file: YAML_FILE, path: FR1 })));
        assert.equal(r.ok, true);
        const s = r.section;
        assert.equal(s.kind, 'listItemComplex');
        assert.equal(s.sectionId, 'FRE-REQU-ORDER-CAPTURE');
        assert.match(s.headline, /^FR-01/);
        assert.ok(s.codeSpec);
        const status = s.forms.content.fields.find((f: { name: string }) => f.name === 'status');
        assert.equal(status.value, 'approved');
        assert.ok(status.enumValues.includes('approved'));
        const description = s.forms.FRED.fields.find((f: { name: string }) => f.name === 'description');
        assert.equal(description.type, 'String');
        assert.equal(description.required, true);
        assert.match(description.value, /^The system must accept orders/);
        assert.ok(s.children.some((c: { path: string }) => c.path === `${FR1}/acceptanceCriteria`));
    });

    test('ST-7: getSection of a value leaf, a form and a list', async () => {
        const leaf = await call(specGetSectionImpl, { file: YAML_FILE, path: 'SBP/content' });
        assert.equal(leaf.section.kind, 'content');
        assert.match(leaf.section.value, /^Solution Blueprint for the/);
        const form = await call(specGetSectionImpl, { file: YAML_FILE, path: `${FR1}/FRED` });
        assert.equal(form.section.kind, 'form');
        assert.ok(form.section.fields.length >= 3);
        const list = await call(specGetSectionImpl, { file: YAML_FILE, path: `${FR}/FRE-REQU-LST` });
        assert.equal(list.section.kind, 'list');
        assert.equal(list.section.items[0].path, FR1);
        assert.equal(list.section.items[0].sectionId, 'FRE-REQU-ORDER-CAPTURE');
    });

    test('ST-8: an unresolvable path names the nearest node and its children', async () => {
        const item = await call(specGetSectionImpl, { file: YAML_FILE, path: `${FR}/FRE-REQU-LST-99/FRED` });
        assert.equal(item.ok, false);
        assert.equal(item.code, 'unresolvedPath');
        assert.equal(item.nearest.path, `${FR}/FRE-REQU-LST`);
        assert.equal(item.nearest.kind, 'list');
        assert.ok(item.nearest.children.includes(FR1));

        const field = await call(specOutlineImpl, { file: YAML_FILE, path: 'SBP/introductionAndScope/nope/deeper' });
        assert.equal(field.code, 'unresolvedPath');
        assert.equal(field.nearest.path, 'SBP/introductionAndScope');
        assert.ok(field.nearest.children.includes('SBP/introductionAndScope/requirements'));

        const root = await call(specOutlineImpl, { file: YAML_FILE, path: 'NOPE/x' });
        assert.equal(root.code, 'unresolvedPath');
        assert.equal(root.nearest, undefined);
    });

    test('ST-9: reflect by class name', async () => {
        const r = JSON.parse(await withTiming('tomAi_specReflect:typical', () =>
            specReflectImpl(deps, { className: 'FunctionalRequirementEntry' })));
        assert.equal(r.ok, true);
        assert.equal(r.class.name, 'FunctionalRequirementEntry');
        const details = r.class.fields.find((f: { name: string }) => f.name === 'details');
        assert.equal(details.segment, 'FRED');
        assert.equal(details.kind, 'form');
        assert.ok(details.formFields.some((f: { name: string }) => f.name === 'description'));
        assert.ok(r.class.doc);
        assert.ok(r.class.annotations.some((a: { name: string }) => a.name === 'NoArtifact'));
        const brief = await call(specReflectImpl, { className: 'FunctionalRequirementEntry', brief: true });
        assert.equal(brief.class.doc, undefined);
        assert.equal(brief.class.annotations, undefined);

        const unknown = await call(specReflectImpl, { className: 'FunctionalRequirement' });
        assert.equal(unknown.ok, false);
        assert.match(unknown.error, /Similar: .*FunctionalRequirementEntry/);
    });

    test('ST-10: reflect by path with a file: addable is exactly what checkAddNode accepts', async () => {
        const r = await call(specReflectImpl, { file: YAML_FILE, path: 'SBP', brief: true });
        assert.equal(r.kind, 'root');
        const doc = deps.store.load(path.join(ws, YAML_FILE)).document;
        const expected = service.reflection.classNamed('D00SolutionBlueprint')!.fields
            .map((f) => service.reflection.fieldSegment(f))
            .filter((segment) => checkAddNode(service.model, doc, 'SBP', segment) === null);
        assert.deepEqual(r.addable, expected);
        assert.ok(r.notAddable.length > 0, 'the filled single children are refused');
        assert.ok(r.notAddable.every((x: { code: string }) => x.code === 'cardinalityExceeded'));
        assert.equal(r.addable.length + r.notAddable.length, r.class.fields.length);

        const modelOnly = await call(specReflectImpl, { path: 'SBP', brief: true });
        assert.equal(modelOnly.addable, undefined);
    });

    test('ST-11: reflect a list; path xor className', async () => {
        const list = await call(specReflectImpl, { file: YAML_FILE, path: `${FR}/FRE-REQU-LST`, brief: true });
        assert.equal(list.kind, 'list');
        assert.equal(list.field.sectionIdPattern, 'FRE-REQU-xxx');
        assert.equal(list.itemClass.name, 'FunctionalRequirementEntry');
        assert.deepEqual(list.addable, ['FRE-REQU-LST']);
        // Without a file the model resolves any item number; with one, only held items do.
        assert.equal((await call(specReflectImpl, { path: `${FR}/FRE-REQU-LST-99`, brief: true })).kind, 'listItemComplex');
        assert.equal((await call(specReflectImpl, { file: YAML_FILE, path: `${FR}/FRE-REQU-LST-99` })).code, 'unresolvedPath');

        assert.match((await call(specReflectImpl, {})).error, /exactly one/);
        assert.match((await call(specReflectImpl, { path: 'SBP', className: 'X' })).error, /exactly one/);
    });

    test('ST-12: Markdown documents', async () => {
        const r = await call(specOutlineImpl, { file: 'specs/meridian.md', depth: 1 });
        assert.equal(r.ok, true);
        assert.equal(r.document.format, 'markdown');
        assert.equal(r.document.readOnlyReason, null, 'the sample Markdown imports faithfully (tom_specs qrb8 fixed)');
        assert.equal(r.nodes[0].path, 'SBP');
        const missing = await call(specOutlineImpl, { file: 'specs/none.docspecs.yaml' });
        assert.equal(missing.code, 'notFound');
    });

    test('ST-13: all four tools are read-only', () => {
        assert.deepEqual(SPEC_TOOLS.map((t) => t.name), [
            'tomAi_specListDocuments', 'tomAi_specOutline', 'tomAi_specGetSection', 'tomAi_specReflect',
        ]);
        assert.ok(SPEC_TOOLS.every((t) => t.readOnly && !t.requiresApproval));
    });
});
