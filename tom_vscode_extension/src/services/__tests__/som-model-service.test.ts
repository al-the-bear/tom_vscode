/**
 * The TomSpecs SOM runtime is loadable in the extension (vsctsa1).
 *
 * The extension consumes tom_som_typescript_runtime + tom_som_typescript_v0 as
 * real packages in node_modules (installed from the tarballs
 * scripts/build-som-packages.cjs builds), never as a path into ai_build.
 * SomModelService is the one place that loads the model; every spec tool goes
 * through it.
 *
 *   SM-1  the model loads from the facade's meta, by package name
 *   SM-2  the model is loaded once and cached (every tool depends on it warm)
 *   SM-3  a known path resolves; an unknown one does not
 *   SM-4  meta trees by root type and by section id, cached; unknown root named
 *   SM-5  DocSpecs schemas come from the facade's accessor
 *   SM-6  GUARD: runtime and facade versions agree, and the meta's model
 *         version is the facade's — a half-rebuilt pair is red here
 *   SM-7  the Meridian sample round-trips byte for byte through the YAML codec
 *         with its own stamp; SM-7b the same with a review pass
 *   SM-8  the packages resolve inside this extension, not into ai_build
 *   SM-9  the SOM editing classes construct (SpecDocument, SpecEditor)
 */

import test, { describe } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'fs';
import * as path from 'path';

import { SpecDocument, SpecEditor, yamlDecode, yamlEncode } from 'tom_som_typescript_runtime';
import { SomModelService } from '../som-model-service.js';

// out/services/__tests__ -> extension root is three levels up.
const EXT_ROOT = path.resolve(__dirname, '..', '..', '..');
const MERIDIAN = path.resolve(
    EXT_ROOT, '..', '..', 'ai_build', 'tom_som_dart_v0', 'documents', 'meridian_order_management.docspecs.yaml',
);

describe('SomModelService', () => {
    const service = new SomModelService();

    test('SM-1: the model loads from the facade meta', () => {
        assert.ok(service.model.roots.length >= 14, `roots: ${service.model.roots.length}`);
        assert.ok(service.model.roots.some((r) => r.sectionId === 'SBP' && r.type === 'D00SolutionBlueprint'));
        assert.match(service.modelVersion, /^\d+\.\d+$/);
    });

    test('SM-2: the model is loaded once', () => {
        assert.equal(service.model, service.model);
        assert.equal(service.reflection, service.reflection);
        assert.equal(SomModelService.instance, SomModelService.instance);
    });

    test('SM-3: a known path resolves, an unknown one does not', () => {
        assert.ok(service.reflection.resolve('SBP/content'));
        assert.equal(service.reflection.resolve('SBP/noSuchSection'), null);
    });

    test('SM-4: meta trees by root type and by section id', () => {
        const byType = service.metaTree('D00SolutionBlueprint');
        assert.equal(service.metaTree('SBP'), byType, 'the same cached tree for the section id');
        assert.throws(() => service.metaTree('NOPE'), /NOPE.*SBP/s);
    });

    test('SM-5: DocSpecs schemas come from the facade accessor', () => {
        assert.ok(service.schemaIds.includes('solution-blueprint'), service.schemaIds.join(','));
        assert.ok(service.schema('solution-blueprint'));
        assert.throws(() => service.schema('no-such-schema'));
    });

    test('SM-6: runtime and facade versions agree with the model version', () => {
        const v = service.packageVersions;
        assert.equal(v.runtime, v.facade, `runtime ${v.runtime} vs facade ${v.facade}`);
        // The generated facade's names (a root class, its MODEL_VERSION constant).
        // eslint-disable-next-line @typescript-eslint/no-require-imports, @typescript-eslint/naming-convention
        const facade = require('tom_som_typescript_v0') as { D00SolutionBlueprint: { MODEL_VERSION: string } };
        assert.equal(service.modelVersion, facade.D00SolutionBlueprint.MODEL_VERSION,
            'the meta and the typed facade come from one generator run');
        assert.ok(v.runtime.startsWith(`${service.modelVersion}.`), `package ${v.runtime} carries model ${service.modelVersion}`);
    });

    /** decode, then encode with the file's own stamp and review pass. */
    function roundTrip(text: string): string {
        const tree = service.metaTree('SBP');
        const contents = yamlDecode(text, tree);
        // decode reports an absent `review:` pass as an empty map, and encode
        // writes an empty map as `review: {}`, so the review is passed only
        // when it holds entries. (Telling an absent pass from an explicit
        // empty one is tom_specs' vsctasb1.)
        const hasReview = Object.keys(contents.review ?? {}).length > 0;
        return yamlEncode(contents.document, tree, contents.modelVersion, hasReview ? contents.review : null);
    }

    test('SM-7: the Meridian sample round-trips byte for byte', () => {
        const text = fs.readFileSync(MERIDIAN, 'utf8');
        assert.equal(roundTrip(text), text);
    });

    test('SM-7b: a review pass survives the round trip', () => {
        const text = `${fs.readFileSync(MERIDIAN, 'utf8')}review:\n  "SBP/content":\n    comment: |2-\n      Checked against the programme charter.\n    reviewed: true\n`;
        assert.equal(roundTrip(text), text);
    });

    test('SM-8: the packages resolve inside this extension', () => {
        for (const pkg of ['tom_som_typescript_runtime', 'tom_som_typescript_v0']) {
            const resolved = fs.realpathSync(require.resolve(`${pkg}/package.json`));
            assert.ok(resolved.startsWith(path.join(EXT_ROOT, 'node_modules', pkg)),
                `${pkg} resolves to ${resolved}, not to this extension's node_modules (a symlink into ai_build?)`);
        }
    });

    test('SM-9: the SOM editing classes construct', () => {
        const doc = new SpecDocument();
        const editor = SpecEditor.forModel(doc, service.model);
        editor.setValue('SBP/content', 'A unifying order platform.');
        assert.equal(doc.content('SBP/content'), 'A unifying order platform.');
    });
});
