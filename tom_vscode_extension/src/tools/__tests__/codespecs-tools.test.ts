/**
 * CodeSpecs tools (vsctsa10) over the Meridian sample and the packaged area
 * catalogue.
 *
 *   CS-1  the catalogue: areas, slices and steps; one area and one slice in detail
 *   CS-2  the packaged catalogue equals the one in tom_specs_model, byte for byte
 *   CS-2b the packaged model's modelHash equals ai_build's; same-version drift is named as a missing bump
 *   CS-3  routing of the sample: every class node routed, filters work
 *   CS-4  a crafted unrouted class is listed with its fix; extraction refuses it, writing nothing
 *   CS-5  an area's extract equals the conformance corpus' `.extract.md`; the summary covers every area
 *   CS-6  written extracts equal the conformance corpus byte for byte; dryRun and unchanged files
 *   CS-7  the CodeSpecs projection document is refused with the explanation
 *   CS-8  registration: three read-only tools, writing needs approval
 */

import test, { before, describe } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import { installVscodeStub } from './_vscode-stub.js';
import { withTiming } from './_timing.js';
installVscodeStub({});

import { SpecDocument, SpecEditor, SpecModel, yamlEncode } from 'tom_som_typescript_runtime';
import { SomModelService } from '../../services/som-model-service.js';
import { SomDocumentStore } from '../../services/som-document-store.js';
import type { SpecToolDeps } from '../spec-tool-common.js';
import {
    CODESPECS_TOOLS,
    codeSpecsAreasImpl,
    codeSpecsExtractImpl,
    codeSpecsRoutingImpl,
    codeSpecsWriteExtractsImpl,
} from '../codespecs-tools.js';

const AI_BUILD = path.resolve(__dirname, '..', '..', '..', '..', '..', 'ai_build');
const MERIDIAN_YAML = fs.readFileSync(path.join(AI_BUILD, 'tom_som_dart_v0', 'documents', 'meridian_order_management.docspecs.yaml'), 'utf8');
const CORPUS = path.join(AI_BUILD, 'tom_som_conformance', 'generated-doc', 'codespecs_extracts');
const CATALOG_SOURCE = path.join(AI_BUILD, 'tom_specs_model', 'generated-doc', 'codespecs', 'codespecs_areas.json');

// Routed to code (unlike introductionAndScope, which a process delivers, so routing stops there).
const ACTORS = 'SBP/targetOperatingModelConcept/processStepsAndActorInteractions/actorOverview';

const ws = fs.mkdtempSync(path.join(os.tmpdir(), 'codespecs-'));
const put = (name: string, text: string): string => {
    fs.mkdirSync(path.dirname(path.join(ws, name)), { recursive: true });
    fs.writeFileSync(path.join(ws, name), text);
    return name;
};

const service = SomModelService.instance;
const deps: SpecToolDeps = { wsRoot: ws, store: new SomDocumentStore(service), service };
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Json = any;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const run = async (impl: (d: SpecToolDeps, i: any) => Promise<string>, input: object, d: SpecToolDeps = deps): Promise<Json> =>
    JSON.parse(await impl(d, input));

/** The model with ActorEntry's routing annotation removed, so its nodes are unrouted. */
class UnroutedModelService extends SomModelService {
    private readonly crafted: SpecModel;
    constructor() {
        super();
        const meta = JSON.parse(fs.readFileSync(require.resolve('tom_som_typescript_v0/meta'), 'utf8'));
        const cls = meta.classes.ActorEntry;
        cls.annotations = cls.annotations.filter((a: { name: string }) => !['CodeSpecKind', 'FollowUpKind', 'NoArtifact'].includes(a.name));
        this.crafted = SpecModel.fromJson(meta);
    }
    override get model(): SpecModel { return this.crafted; }
}

describe('CodeSpecs tools', () => {
    before(() => { void service.model; put('meridian.docspecs.yaml', MERIDIAN_YAML); });

    test('CS-1: the catalogue', async () => {
        const r = JSON.parse(await withTiming('tomAi_specCodeSpecsAreas:typical', () => codeSpecsAreasImpl(deps, {})));
        assert.equal(r.ok, true);
        assert.deepEqual(r.counts, { areas: 27, active: 27, slices: 7, steps: 31 });
        assert.ok(r.areas.some((a: Json) => a.code === 'CE-EN'));
        const area = await run(codeSpecsAreasImpl, { area: 'CE-EN' });
        assert.equal(area.area.code, 'CE-EN');
        assert.ok(area.area.steps.length > 0);
        assert.ok(Array.isArray(area.area.projects) && area.area.projects.length > 0);
        assert.equal((await run(codeSpecsAreasImpl, { area: area.area.canonicalId })).area.code, 'CE-EN', 'by canonical id too');
        const slice = await run(codeSpecsAreasImpl, { slice: 1 });
        assert.equal(slice.slice.number, 1);
        assert.ok(slice.areas.every((a: Json) => a.slices.includes(1)));
        assert.equal((await run(codeSpecsAreasImpl, { area: 'CE-NOPE' })).code, 'unknownArea');
    });

    test('CS-2: the packaged catalogue equals the source', () => {
        const packaged = SomModelService.codeSpecsCatalogFile;
        assert.ok(fs.existsSync(packaged), `missing ${packaged}: run npm run som:pack`);
        assert.ok(fs.existsSync(CATALOG_SOURCE), `missing ${CATALOG_SOURCE}`);
        assert.equal(fs.readFileSync(packaged, 'utf8'), fs.readFileSync(CATALOG_SOURCE, 'utf8'),
            'resources/codespecs/codespecs_areas.json is stale: run npm run som:pack');
    });

    test('CS-2b: the packaged model equals the source (modelHash)', () => {
        // The catalogue names model carriers, so a fresh catalogue over a stale
        // model reports carriers missing that are there. The version cannot
        // tell: a model changes under an unchanged version until somebody bumps
        // it. The meta's content hash can.
        const facade = 'tom_som_typescript_v0';
        const metaOf = (root: string) =>
            JSON.parse(fs.readFileSync(path.join(root, facade, 'meta', 'spec_model.meta.json'), 'utf8'));
        const versionOf = (root: string) =>
            JSON.parse(fs.readFileSync(path.join(root, facade, 'package.json'), 'utf8')).version as string;
        const nodeModules = path.resolve(__dirname, '..', '..', '..', 'node_modules');
        const packaged = metaOf(nodeModules);
        const source = metaOf(AI_BUILD);
        assert.ok(source.modelHash, 'ai_build\'s meta carries no modelHash: regenerate it (generate_som)');
        if (packaged.modelHash !== source.modelHash) {
            const pv = versionOf(nodeModules);
            const sv = versionOf(AI_BUILD);
            assert.fail(pv === sv
                ? `the packaged model differs from ai_build's under the same version ${pv}: ai_build changed the `
                    + 'model without bumping tom_specs_model. Run npm run som:pack, and bump the model in ai_build.'
                : `the packaged model is ${pv}, ai_build's is ${sv}: run npm run som:pack`);
        }
    });

    test('CS-3: routing of the sample', async () => {
        const r = JSON.parse(await withTiming('tomAi_specCodeSpecsRouting:typical', () =>
            codeSpecsRoutingImpl(deps, { file: 'meridian.docspecs.yaml' })));
        assert.equal(r.ok, true, JSON.stringify(r).slice(0, 300));
        assert.equal(r.passed, true);
        assert.deepEqual(r.unrouted, []);
        assert.equal(r.counts.documentRoot, 1);
        assert.ok(r.counts.feedsCode > 0 && r.counts.feedsProcess > 0 && r.counts.feedsNothing > 0);
        const nothing = await run(codeSpecsRoutingImpl, { file: 'meridian.docspecs.yaml', verdict: 'feedsNothing', limit: 2000 });
        assert.equal(nothing.routings.length, r.counts.feedsNothing);
        const scoped = await run(codeSpecsRoutingImpl, { file: 'meridian.docspecs.yaml', path: ACTORS });
        assert.ok(scoped.routings.length > 0 && scoped.routings.every((x: Json) => x.path.startsWith(ACTORS)));
        // A subtree a process delivers is not walked further: its classes take no routing of their own.
        const process = await run(codeSpecsRoutingImpl, { file: 'meridian.docspecs.yaml', path: 'SBP/introductionAndScope' });
        assert.deepEqual(process.routings.map((x: Json) => x.verdict), ['feedsProcess']);
    });

    test('CS-4: an unrouted class', async () => {
        const crafted: SpecToolDeps = { ...deps, service: new UnroutedModelService() };
        const r = await run(codeSpecsRoutingImpl, { file: 'meridian.docspecs.yaml' }, crafted);
        assert.equal(r.passed, false);
        assert.ok(r.unrouted.length >= 4, 'every actor');
        assert.ok(r.unrouted.every((u: Json) => u.className === 'ActorEntry'));
        assert.ok(r.unrouted.some((u: Json) => u.path === `${ACTORS}/ACEN-ACTO-LST-1`));
        assert.match(r.unrouted[0].fix, /@CodeSpecKind/);
        assert.match(r.unrouted[0].fix, /does not route/);

        const extract = await run(codeSpecsExtractImpl, { file: 'meridian.docspecs.yaml' }, crafted);
        assert.equal(extract.code, 'extractError');
        assert.equal(extract.path, `${ACTORS}/ACEN-ACTO-LST-1`, 'the first unrouted node');
        assert.equal(extract.className, 'ActorEntry');
        const write = await run(codeSpecsWriteExtractsImpl, { file: 'meridian.docspecs.yaml', outDir: 'refused' }, crafted);
        assert.equal(write.code, 'extractError');
        assert.ok(!fs.existsSync(path.join(ws, 'refused')), 'nothing written');
    });

    test('CS-5: an area\'s extract and the summary', async () => {
        const r = JSON.parse(await withTiming('tomAi_specCodeSpecsExtract:typical', () =>
            codeSpecsExtractImpl(deps, { file: 'meridian.docspecs.yaml', area: 'CE-EN' })));
        assert.equal(r.ok, true);
        assert.equal(r.markdown, fs.readFileSync(path.join(CORPUS, 'CE-EN.extract.md'), 'utf8'));
        assert.equal(r.provenance.length, r.entries);
        assert.ok(r.provenance.every((p: Json) => p.path && p.className && p.routedBy));
        const summary = await run(codeSpecsExtractImpl, { file: 'meridian.docspecs.yaml' });
        assert.equal(summary.areas.length, 27);
        assert.equal(summary.totalEntries, summary.areas.reduce((n: number, a: Json) => n + a.entries, 0));
    });

    test('CS-6: written extracts equal the conformance corpus', async () => {
        const dry = await run(codeSpecsWriteExtractsImpl, { file: 'meridian.docspecs.yaml', dryRun: true });
        assert.equal(dry.written, false);
        assert.equal(dry.outDir, 'generated-doc/codespecs_extracts', 'beside the document by default');
        assert.equal(dry.counts.new, 54);
        assert.ok(!fs.existsSync(path.join(ws, 'generated-doc')));

        const r = JSON.parse(await withTiming('tomAi_specCodeSpecsWriteExtracts:typical', () =>
            codeSpecsWriteExtractsImpl(deps, { file: 'meridian.docspecs.yaml' })));
        assert.equal(r.ok, true);
        const written = fs.readdirSync(path.join(ws, 'generated-doc', 'codespecs_extracts')).sort();
        assert.equal(written.length, 54);
        for (const f of written) {
            assert.equal(fs.readFileSync(path.join(ws, 'generated-doc', 'codespecs_extracts', f), 'utf8'),
                fs.readFileSync(path.join(CORPUS, f), 'utf8'), `${f} matches the corpus`);
        }
        const again = await run(codeSpecsWriteExtractsImpl, { file: 'meridian.docspecs.yaml' });
        assert.deepEqual(again.counts, { new: 0, changed: 0, unchanged: 54 });
    });

    test('CS-7: the projection document is refused', async () => {
        const cgp = new SpecDocument();
        SpecEditor.forModel(cgp, service.model).setValue('CGP/content', 'What generation reaches.');
        put('projection.docspecs.yaml', yamlEncode(cgp, service.metaTree('CGP'), service.modelVersion, null));
        for (const impl of [codeSpecsRoutingImpl, codeSpecsExtractImpl, codeSpecsWriteExtractsImpl]) {
            const r = await run(impl, { file: 'projection.docspecs.yaml' });
            // The runtime refuses it, on the root's @CodeSpecsProjection marker.
            assert.equal(r.code, 'extractError');
            assert.match(r.error, /generation projection/);
            assert.equal(r.path, 'CGP');
        }
    });

    test('CS-8: registration', () => {
        assert.deepEqual(CODESPECS_TOOLS.map((t) => [t.name, t.readOnly, t.requiresApproval ?? false]), [
            ['tomAi_specCodeSpecsAreas', true, false],
            ['tomAi_specCodeSpecsRouting', true, false],
            ['tomAi_specCodeSpecsExtract', true, false],
            ['tomAi_specCodeSpecsWriteExtracts', false, true],
        ]);
    });
});
