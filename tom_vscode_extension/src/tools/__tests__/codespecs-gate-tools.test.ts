/**
 * CodeSpecs gate and gate-record tools (vsctsa18), on copies of the Meridian
 * sample and its conformance gate record.
 *
 *   CG-1  the gate on the clean sample: open, A1–A5 all pass, schema named
 *   CG-2  A1 fails on an empty required form field, located at the right path
 *   CG-3  A2 fails on a bad enum value
 *   CG-4  A3 fails on an unrouted class; A4 then does not run, and says why
 *   CG-4b A3 fails on the projection document: the runtime refuses its root
 *   CG-5  A4 fails on an empty required marker source
 *   CG-6  A5 fails when the model loses a carrier; no document path, a model-level fix
 *   CG-7  the record: the corpus record reads complete and agrees with the extracts; partial and absent records
 *   CG-8  set a verdict: byte-stable rewrite, one entry changed, refusals, the insufficient reminder, dryRun
 *   CG-9  registration
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
    CODESPECS_GATE_TOOLS,
    codeSpecsGateImpl,
    codeSpecsSetVerdictImpl,
    codeSpecsVerdictsImpl,
} from '../codespecs-gate-tools.js';

const AI_BUILD = path.resolve(__dirname, '..', '..', '..', '..', '..', 'ai_build');
const MERIDIAN_YAML = fs.readFileSync(path.join(AI_BUILD, 'tom_som_dart_v0', 'documents', 'meridian_order_management.docspecs.yaml'), 'utf8');
const CORPUS = path.join(AI_BUILD, 'tom_som_conformance', 'generated-doc', 'codespecs_extracts');
const CORPUS_RECORD = fs.readFileSync(path.join(CORPUS, 'gate.verdicts.yaml'), 'utf8');

const FR = 'SBP/introductionAndScope/requirements/functionalRequirements';
const ENTITY = 'SBP/informationAndDataModel/dataModel/DAENT-ENTI-LST-1';

const ws = fs.mkdtempSync(path.join(os.tmpdir(), 'codespecs-gate-'));
const put = (name: string, text: string): string => {
    fs.mkdirSync(path.dirname(path.join(ws, name)), { recursive: true });
    fs.writeFileSync(path.join(ws, name), text);
    return name;
};
const read = (name: string): string => fs.readFileSync(path.join(ws, name), 'utf8');

const service = SomModelService.instance;
const store = new SomDocumentStore(service);
const deps: SpecToolDeps = { wsRoot: ws, store, service };
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Json = any;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const run = async (impl: (d: SpecToolDeps, i: any) => Promise<string>, input: object, d: SpecToolDeps = deps): Promise<Json> =>
    JSON.parse(await impl(d, input));
const check = (r: Json, label: string): Json => r.checks.find((c: Json) => c.check === label);

/** A copy of Meridian with one form field changed. */
function meridianWith(name: string, formPath: string, field: string, value: string): string {
    const loaded = store.load(path.join(ws, put(name, MERIDIAN_YAML)));
    loaded.document.setFormField(formPath, field, value);
    return put(name, store.render(loaded, { stamp: loaded.stamp }));
}

/** The model with changes made to its meta, for crafted A3 / A5 failures. */
class CraftedModelService extends SomModelService {
    private readonly crafted: SpecModel;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    constructor(edit: (classes: Record<string, any>) => void) {
        super();
        const meta = JSON.parse(fs.readFileSync(require.resolve('tom_som_typescript_v0/meta'), 'utf8'));
        edit(meta.classes);
        this.crafted = SpecModel.fromJson(meta);
    }
    override get model(): SpecModel { return this.crafted; }
}

/** A spec root holding Meridian, the corpus extracts and the corpus record. */
function specRoot(name: string, withRecord = true): string {
    put(`${name}/meridian.docspecs.yaml`, MERIDIAN_YAML);
    for (const f of fs.readdirSync(CORPUS)) {
        if (f === 'gate.verdicts.yaml' && !withRecord) { continue; }
        put(`${name}/generated-doc/codespecs_extracts/${f}`, fs.readFileSync(path.join(CORPUS, f), 'utf8'));
    }
    return name;
}

describe('CodeSpecs gate and gate record', () => {
    before(() => { void service.model; put('meridian.docspecs.yaml', MERIDIAN_YAML); });

    test('CG-1: the clean sample opens the gate', async () => {
        const r = JSON.parse(await withTiming('tomAi_specCodeSpecsGate:typical', () => codeSpecsGateImpl(deps, { file: 'meridian.docspecs.yaml' })));
        assert.equal(r.ok, true, JSON.stringify(r).slice(0, 400));
        assert.equal(r.gateOpen, true, JSON.stringify(r.checks.filter((c: Json) => !c.passed)));
        assert.deepEqual(r.checks.map((c: Json) => [c.check, c.ran, c.passed]), [
            ['A1', true, true], ['A2', true, true], ['A3', true, true], ['A4', true, true], ['A5', true, true],
        ]);
        assert.equal(r.schema.id, 'solution-blueprint');
        assert.match(r.summary, /gate open/);
    });

    test('CG-2: A1 — an empty required form field, at its path', async () => {
        const file = meridianWith('a1.docspecs.yaml', `${FR}/FRE-REQU-LST-2/FRED`, 'description', '');
        const r = await run(codeSpecsGateImpl, { file });
        assert.equal(r.gateOpen, false);
        const a1 = check(r, 'A1');
        assert.equal(a1.passed, false);
        const finding = a1.findings.find((f: Json) => f.code === 'missingRequiredField');
        assert.equal(finding.path, `${FR}/FRE-REQU-LST-2/FRED`, 'the second requirement\'s form, not any FRED');
        assert.match(a1.fix, /tomAi_specSetFormField/);
    });

    test('CG-3: A2 — a bad enum value', async () => {
        const file = meridianWith('a2.docspecs.yaml', `${FR}/FRE-REQU-LST-1/FREP`, 'priority', 'urgent');
        const a2 = check(await run(codeSpecsGateImpl, { file }), 'A2');
        assert.equal(a2.passed, false);
        assert.deepEqual(a2.findings.map((f: Json) => [f.code, f.path]), [['enumValueUnknown', `${FR}/FRE-REQU-LST-1/FREP`]]);
    });

    test('CG-4: A3 — an unrouted class stops A4', async () => {
        const crafted = new CraftedModelService((classes) => {
            classes.ActorEntry.annotations = classes.ActorEntry.annotations.filter((a: { name: string }) => !['CodeSpecKind', 'FollowUpKind', 'NoArtifact'].includes(a.name));
        });
        const r = await run(codeSpecsGateImpl, { file: 'meridian.docspecs.yaml' }, { ...deps, service: crafted });
        const a3 = check(r, 'A3');
        assert.equal(a3.passed, false);
        assert.ok(a3.findings.length >= 4 && a3.findings.every((f: Json) => f.code === 'unrouted' && /ACEN-ACTO-LST-\d+$/.test(f.path)));
        assert.match(a3.fix, /@CodeSpecKind/);
        const a4 = check(r, 'A4');
        assert.equal(a4.ran, false);
        assert.match(a4.notRunReason, /A3 did not complete/);
    });

    test('CG-4b: A3 — the projection document is refused at its root', async () => {
        const cgp = new SpecDocument();
        SpecEditor.forModel(cgp, service.model).setValue('CGP/content', 'What generation reaches.');
        put('projection.docspecs.yaml', yamlEncode(cgp, service.metaTree('CGP'), service.modelVersion, null));
        const r = await run(codeSpecsGateImpl, { file: 'projection.docspecs.yaml' });
        assert.equal(r.gateOpen, false);
        const a3 = check(r, 'A3');
        assert.equal(a3.passed, false);
        assert.deepEqual(a3.findings.map((f: Json) => [f.code, f.path]), [['root', 'CGP']]);
        assert.match(a3.findings[0].message, /generation projection/);
    });

    test('CG-5: A4 — an empty required marker source', async () => {
        const file = meridianWith('a4.docspecs.yaml', `${ENTITY}/DAENT-IDEN`, 'tableName', '');
        const a4 = check(await run(codeSpecsGateImpl, { file }), 'A4');
        assert.equal(a4.passed, false);
        const finding = a4.findings.find((f: Json) => f.code === 'missingSource');
        assert.equal(finding.path, ENTITY);
        assert.match(finding.message, /tableName/);
    });

    test('CG-6: A5 — the model loses a carrier', async () => {
        const crafted = new CraftedModelService((classes) => {
            const content = classes.ScreenElementAction.fields.find((f: { name: string }) => f.name === 'content');
            content.formFields = content.formFields.filter((f: { name: string }) => f.name !== 'triggerKind');
        });
        const a5 = check(await run(codeSpecsGateImpl, { file: 'meridian.docspecs.yaml' }, { ...deps, service: crafted }), 'A5');
        assert.equal(a5.passed, false);
        assert.deepEqual(a5.findings.map((f: Json) => [f.code, f.location, f.path]), [['missingCarrier', 'ScreenElementAction.content.triggerKind', undefined]]);
        assert.match(a5.fix, /model-level/);
    });

    test('CG-7: the gate record', async () => {
        const root = specRoot('full');
        const r = JSON.parse(await withTiming('tomAi_specCodeSpecsVerdicts:typical', () =>
            codeSpecsVerdictsImpl(deps, { file: `${root}/meridian.docspecs.yaml` })));
        assert.equal(r.ok, true, JSON.stringify(r));
        assert.equal(r.exists, true);
        assert.equal(r.file, 'full/generated-doc/codespecs_extracts/gate.verdicts.yaml');
        assert.equal(r.complete, true);
        assert.deepEqual(r.missing, []);
        assert.equal(r.verdicts.length, 27);
        assert.deepEqual(r.againstExtracts, { ok: true });
        assert.equal((await run(codeSpecsVerdictsImpl, { specRoot: root })).verdicts.length, 27, 'by spec root too');

        put('partial/generated-doc/codespecs_extracts/gate.verdicts.yaml', 'gate:\n  formatVersion: 1\n  verdicts:\n    - area: CE-EN\n      verdict: sufficient\n');
        const partial = await run(codeSpecsVerdictsImpl, { specRoot: 'partial' });
        assert.equal(partial.complete, false);
        assert.equal(partial.missing.length, 26);
        assert.ok(!partial.missing.includes('CE-EN'));

        const none = await run(codeSpecsVerdictsImpl, { specRoot: 'nothing-here' });
        assert.equal(none.exists, false);
        assert.equal(none.missing.length, 27);

        put('bad/generated-doc/codespecs_extracts/gate.verdicts.yaml', 'gate:\n  formatVersion: 1\n  verdicts:\n    - area: CE-XX\n      verdict: sufficient\n');
        assert.equal((await run(codeSpecsVerdictsImpl, { specRoot: 'bad' })).code, 'recordError');
        assert.equal((await run(codeSpecsVerdictsImpl, { specRoot: 'a', file: 'b' })).code, 'invalidInput');
    });

    test('CG-8: setting a verdict', async () => {
        const root = specRoot('set');
        const record = `${root}/generated-doc/codespecs_extracts/gate.verdicts.yaml`;
        const same = JSON.parse(await withTiming('tomAi_specCodeSpecsSetVerdict:typical', () =>
            codeSpecsSetVerdictImpl(deps, { specRoot: root, area: 'CE-API', verdict: 'sufficient' })));
        assert.equal(same.ok, true, JSON.stringify(same));
        assert.equal(read(record), CORPUS_RECORD, 'rewriting an unchanged verdict is byte-identical, leading comment included');

        const changed = await run(codeSpecsSetVerdictImpl, { specRoot: root, area: 'CE-AU', verdict: 'insufficient', resolution: 'descoped', note: 'next release' });
        assert.equal(changed.written, true);
        assert.deepEqual(changed.replaced, { area: 'CE-AU', verdict: 'not applicable' });
        assert.match(changed.reminder, /csopen/);
        // Every area's block but CE-AU's is unchanged.
        const blocks = (text: string): Map<string, string> => new Map(text.split('\n    - area: ').slice(1).map((b) => [b.split('\n')[0], b]));
        const before = blocks(CORPUS_RECORD);
        const after = blocks(read(record));
        assert.deepEqual([...after.keys()], [...before.keys()]);
        for (const [area, block] of after) {
            if (area !== 'CE-AU') { assert.equal(block, before.get(area), `${area} unchanged`); }
        }
        assert.equal(read(record).split('\n    - area: ')[0], CORPUS_RECORD.split('\n    - area: ')[0], 'the head (comment, formatVersion) unchanged');
        assert.match(read(record), /- area: CE-AU\n {6}verdict: insufficient\n {6}resolution: descoped\n {6}note: /);

        const blocked = await run(codeSpecsSetVerdictImpl, { specRoot: root, area: 'CE-AC', verdict: 'insufficient' });
        assert.match(blocked.reminder, /may not continue/);

        assert.equal((await run(codeSpecsSetVerdictImpl, { specRoot: root, area: 'CE-XX', verdict: 'sufficient' })).code, 'unknownArea');
        assert.equal((await run(codeSpecsSetVerdictImpl, { specRoot: root, area: 'CE-EN', verdict: 'maybe' })).code, 'unknownVerdict');
        const wrongResolution = await run(codeSpecsSetVerdictImpl, { specRoot: root, area: 'CE-EN', verdict: 'sufficient', resolution: 'descoped' });
        assert.equal(wrongResolution.code, 'recordError');
        assert.match(wrongResolution.error, /only an insufficient area/);
        assert.equal((await run(codeSpecsSetVerdictImpl, { specRoot: root, area: 'CE-EN', verdict: 'notApplicable', expectedRevision: 'deadbeef' })).code, 'revisionConflict');

        const fresh = await run(codeSpecsSetVerdictImpl, { specRoot: 'new-root', area: 'CE-EN', verdict: 'sufficient', dryRun: true });
        assert.equal(fresh.written, false);
        assert.ok(!fs.existsSync(path.join(ws, 'new-root')));
        const created = await run(codeSpecsSetVerdictImpl, { specRoot: 'new-root', area: 'CE-EN', verdict: 'not applicable' });
        assert.equal(created.written, true);
        assert.equal(created.missing.length, 26);
        assert.equal((await run(codeSpecsVerdictsImpl, { specRoot: 'new-root' })).verdicts[0].verdict, 'not applicable');
    });

    test('CG-9: registration', () => {
        assert.deepEqual(CODESPECS_GATE_TOOLS.map((t) => [t.name, t.readOnly, t.requiresApproval ?? false]), [
            ['tomAi_specCodeSpecsGate', true, false],
            ['tomAi_specCodeSpecsVerdicts', true, false],
            ['tomAi_specCodeSpecsSetVerdict', false, true],
        ]);
    });
});
