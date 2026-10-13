/**
 * CodeSpecs validate and step context (vsctsa20), over the snapshot of
 * tom_specs_samples/phase4_codespecs_run in fixtures/phase4/: its generated
 * trio (codespec/shared, client, server), the trio's recorded validation
 * report (codespec/validation_report.json) and its 27 extracts.
 *
 * Validation runs the real validate_codespecs binary in bin/<platform>/,
 * which `npm run codespecs:build` compiles (the install scripts run it).
 *
 *   CV-1  validate over the sample trio matches its recorded report
 *   CV-2  a crafted violation is reported with its check number
 *   CV-3  client and server default to the shared folder's siblings
 *   CV-4  usage errors are kept apart from clean and violations
 *   CV-5  a missing binary is an error naming the build step
 *   CV-6  the fixture trio equals the sample's (when the sample is present)
 *   SC-1  a step's context: its areas' extracts exactly, its entries, its project
 *   SC-2  every step's areas have extracts and contract entries
 *   SC-3  input errors, a missing extract, §2 in full
 *   SC-4  the packaged contract equals tom_core's
 *   SC-5  registration
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
import { SomDocumentStore } from '../../services/som-document-store.js';
import { CodeSpecsBinaryMissing, validateCodespecsBinary } from '../../services/codespecs-validator.js';
import { CONTRACT_FILE } from '../../services/codespecs-contract.js';
import type { SpecToolDeps } from '../spec-tool-common.js';
import {
    CODESPECS_VALIDATE_TOOLS,
    codeSpecsStepContextImpl,
    codeSpecsValidateImpl,
    codeSpecsValidationReport,
} from '../codespecs-validate-tools.js';

const EXT_ROOT = path.resolve(__dirname, '..', '..', '..');
const FIXTURE = path.join(EXT_ROOT, 'src', 'tools', '__tests__', 'fixtures', 'phase4');
const AI_BUILD = path.resolve(EXT_ROOT, '..', '..', 'ai_build');
const SAMPLE_TRIO = path.join(AI_BUILD, 'tom_specs_samples', 'phase4_codespecs_run', 'codespec');
const CONTRACT_SOURCE = path.resolve(EXT_ROOT, '..', '..', 'core', 'tom_core_codespecs', 'doc', 'codespecs_derivation_contract.md');

const ws = fs.mkdtempSync(path.join(os.tmpdir(), 'codespecs-validate-'));
/** A copy of the fixture's trio and extracts under `name/`. */
function copyRun(name: string): string {
    fs.cpSync(path.join(FIXTURE, 'codespec'), path.join(ws, name, 'codespec'), { recursive: true });
    fs.cpSync(path.join(FIXTURE, 'codespecs_extracts'), path.join(ws, name, 'codespecs_extracts'), { recursive: true });
    return name;
}
const trio = (name: string): Record<string, string> => ({
    shared: `${name}/codespec/shared`,
    client: `${name}/codespec/client`,
    server: `${name}/codespec/server`,
    extractsDir: `${name}/codespecs_extracts`,
});

const service = SomModelService.instance;
const deps: SpecToolDeps = { wsRoot: ws, store: new SomDocumentStore(service), service };
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Json = any;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const call = async (impl: (d: SpecToolDeps, i: any) => Promise<string>, input: object): Promise<Json> => JSON.parse(await impl(deps, input));

describe('CodeSpecs validate', () => {
    before(() => { copyRun('base'); });

    test('CV-1: the sample trio matches its recorded report', async () => {
        const recorded = JSON.parse(fs.readFileSync(path.join(FIXTURE, 'codespec', 'validation_report.json'), 'utf8'));
        const report = await codeSpecsValidationReport(deps, trio('base'));
        const { inputs: _a, ...got } = report as Json;
        const { inputs: _b, ...want } = recorded;
        assert.deepEqual(got, want, 'the bundled binary reproduces the recorded report');

        const r = JSON.parse(await withTiming('tomAi_specCodeSpecsValidate:typical', () => codeSpecsValidateImpl(deps, trio('base'))));
        assert.equal(r.ok, true, JSON.stringify(r));
        assert.equal(r.outcome, 'clean');
        assert.equal(r.summary, recorded.summary);
        assert.deepEqual(r.violations, []);
        assert.equal(r.checkCount, 37);
        assert.equal(r.checksRun, 34, 'checks 9, 13 and 31 lack their corroborating input');
        assert.deepEqual(r.notRun.map((n: Json) => n.checks), [[13], [9], [31]]);
        assert.deepEqual(r.inputs, { shared: 'base/codespec/shared', client: 'base/codespec/client', server: 'base/codespec/server', extracts: 'base/codespecs_extracts' });
    });

    test('CV-2: a crafted violation carries its check number', async () => {
        copyRun('broken');
        const file = path.join(ws, 'broken', 'codespec', 'server', 'lib', 'src', 'data_access', 'customer.dart');
        const text = fs.readFileSync(file, 'utf8');
        const changed = text.replace("  DocRef('DAATT-DATA', 'supplies the storage type'),\n])\n@CsTable",
            "  DocRef('DAATT-DATA', 'supplies the storage type'),\n  DocRef('NOPE-TOKN', 'supplies nothing'),\n])\n@CsTable");
        assert.notEqual(changed, text, 'the fixture still has the shape this test edits');
        fs.writeFileSync(file, changed);

        const r = await call(codeSpecsValidateImpl, trio('broken'));
        assert.equal(r.ok, true);
        assert.equal(r.outcome, 'violations');
        assert.equal(r.passed, false);
        const dangling = r.violations.find((v: Json) => v.check === 36);
        assert.ok(dangling, JSON.stringify(r.violations));
        assert.equal(dangling.token, 'NOPE-TOKN');
        assert.equal(dangling.file, 'lib/src/data_access/customer.dart');
        assert.equal(typeof dangling.line, 'number');
        assert.match(dangling.checkTitle, /back-link/);
        assert.ok(r.violations.some((v: Json) => v.check === 7), 'the @CodeSpec/@DocSpec set mismatch is check 7');
        assert.deepEqual(Object.entries(r.byCheck), [['7', 1], ['36', 1]]);
        assert.equal(r.violationCount, 2);

        const limited = await call(codeSpecsValidateImpl, { ...trio('broken'), limit: 1 });
        assert.equal(limited.violations.length, 1);
        assert.equal(limited.truncated, true);
    });

    test('CV-3: client and server default to the shared folder\'s siblings', async () => {
        const r = await call(codeSpecsValidateImpl, { shared: 'base/codespec/shared', extractsDir: 'base/codespecs_extracts' });
        assert.equal(r.outcome, 'clean', JSON.stringify(r));
        assert.equal(r.inputs.server, 'base/codespec/server');
    });

    test('CV-4: usage errors are not violations', async () => {
        const missing = await call(codeSpecsValidateImpl, { ...trio('base'), server: 'base/codespec/nope' });
        assert.equal(missing.ok, false);
        assert.equal(missing.outcome, 'usageError');
        assert.match(missing.error, /server package not found/);

        const noShared = await call(codeSpecsValidateImpl, { client: 'base/codespec/client' });
        assert.equal(noShared.outcome, 'usageError');
        assert.match(noShared.error, /shared package is missing/);

        const unnamed = await call(codeSpecsValidateImpl, { shared: 'base/codespecs_extracts' });
        assert.equal(unnamed.outcome, 'usageError');
        assert.match(unnamed.error, /client package is missing/);

        const extracts = await call(codeSpecsValidateImpl, { ...trio('base'), extractsDir: 'base/none' });
        assert.equal(extracts.outcome, 'usageError');
        assert.match(extracts.error, /extracts directory not found/);
    });

    test('CV-5: a missing binary names the build step', () => {
        assert.throws(() => validateCodespecsBinary(ws), (e: unknown) =>
            e instanceof CodeSpecsBinaryMissing && /npm run codespecs:build/.test(e.message) && e.expected.startsWith(path.join(ws, 'bin')));
        assert.ok(fs.existsSync(validateCodespecsBinary()), 'this checkout carries the binary: npm run codespecs:build');
    });

    test('CV-6: the fixture trio equals the sample\'s', (t) => {
        if (!fs.existsSync(SAMPLE_TRIO)) {
            t.skip(`no sample at ${SAMPLE_TRIO}`);
            return;
        }
        const files = (root: string): string[] => fs.readdirSync(root, { recursive: true, withFileTypes: true })
            .filter((d) => d.isFile())
            .map((d) => path.relative(root, path.join(d.parentPath, d.name))).sort();
        const fixture = files(path.join(FIXTURE, 'codespec'));
        const dart = (list: string[]): string[] => list.filter((f) => f.endsWith('.dart'));
        assert.deepEqual(dart(fixture), dart(files(SAMPLE_TRIO)), 'the same generated files');
        for (const f of fixture) {
            assert.equal(fs.readFileSync(path.join(FIXTURE, 'codespec', f), 'utf8'), fs.readFileSync(path.join(SAMPLE_TRIO, f), 'utf8'),
                `fixtures/phase4/codespec/${f} is stale: copy the sample's codespec/ trio and validation_report.json`);
        }
    });
});

describe('CodeSpecs step context', () => {
    before(() => { copyRun('ctx'); });
    const extracts = { extractsDir: 'ctx/codespecs_extracts' };

    test('SC-1: step 10 — its area\'s extracts exactly, its entries, its project', async () => {
        const r = JSON.parse(await withTiming('tomAi_specCodeSpecsStepContext:typical', () =>
            codeSpecsStepContextImpl(deps, { ...extracts, step: 10 })));
        assert.equal(r.ok, true, JSON.stringify(r).slice(0, 400));
        assert.equal(r.step.number, 10);
        assert.equal(r.step.todo, 'csgen10');
        assert.equal(r.step.title, 'CE-DB entities/columns/repositories');
        assert.deepEqual(r.step.slice, { number: 3, title: 'Server persistence & configuration' });
        assert.deepEqual(r.step.areas.map((a: Json) => a.code), ['CE-DB']);
        assert.equal(r.outputProject, '<app>_codespec_server');

        assert.deepEqual(r.extracts.map((e: Json) => e.area), ['CE-DB']);
        const source = fs.readFileSync(path.join(FIXTURE, 'codespecs_extracts', 'CE-DB.extract.yaml'), 'utf8');
        const tokens = [...source.matchAll(/^\s+- sectionId: "([^"]*)"$/gm)].map((m) => m[1]);
        assert.ok(tokens.length > 0);
        assert.equal(r.extracts[0].entryCount, r.extracts[0].entries.length);
        assert.deepEqual(r.extracts[0].entries.map((e: Json) => e.token), tokens, 'every entry of CE-DB, in order, and nothing else');
        assert.ok(r.extracts[0].entries.every((e: Json) => e.area === 'CE-DB'));

        assert.deepEqual(r.contract.entries.map((s: Json) => s.number), ['3.0.1', '3.3.1', '3.3.2', '3.3.3', '3.3.4']);
        assert.match(r.contract.entries[1].text, /^#### 3\.3\.1 `@CsTable`/);
        assert.doesNotMatch(r.contract.entries[1].text, /#### 3\.3\.2/, 'one entry per section');
        assert.deepEqual(Object.entries(r.contract.matchedBy), [['CE-DB', 'slice']]);
        assert.ok(r.contract.universalRules.some((s: Json) => s.number === '2.9'));
    });

    test('SC-2: every step — its areas\' extracts, entries for each area', async () => {
        const catalog = service.codeSpecsCatalog;
        for (const step of catalog.steps) {
            const r = await call(codeSpecsStepContextImpl, { ...extracts, step: step.number });
            assert.equal(r.ok, true, `step ${step.number}: ${r.error}`);
            assert.deepEqual(r.extracts.map((e: Json) => e.area), step.areaCodes, `step ${step.number}`);
            assert.ok(r.extracts.every((e: Json) => !e.missing && e.entries.every((x: Json) => x.area === e.area)), `step ${step.number}`);
            for (const code of step.areaCodes) {
                assert.notEqual(r.contract.matchedBy[code], 'none', `step ${step.number}: no contract entry names ${code}`);
            }
        }
        const scc = await call(codeSpecsStepContextImpl, { ...extracts, step: 23 });
        assert.deepEqual(scc.extracts.map((e: Json) => e.area), ['CE-EL', 'CE-FM', 'CE-AC', 'CE-SC', 'CE-ST', 'CE-NV']);
        assert.equal(scc.outputProject, '<app>_codespec_client');
        const followsHost = await call(codeSpecsStepContextImpl, { ...extracts, step: 20 });
        assert.deepEqual(Object.entries(followsHost.contract.matchedBy), [['CE-LG', 'marker']], 'CE-LG over the handler: its marker\'s entry in slice 3');
        assert.ok(followsHost.contract.entries.some((s: Json) => s.number === '3.3.7'));
    });

    test('SC-3: input errors, a missing extract, §2 in full', async () => {
        const unknown = await call(codeSpecsStepContextImpl, { ...extracts, step: 32 });
        assert.equal(unknown.code, 'unknownStep');
        assert.match(unknown.error, /1–31/);
        assert.equal((await call(codeSpecsStepContextImpl, { step: 1 })).ok, false);

        fs.mkdirSync(path.join(ws, 'partial'), { recursive: true });
        fs.copyFileSync(path.join(FIXTURE, 'codespecs_extracts', 'CE-ER.extract.yaml'), path.join(ws, 'partial', 'CE-ER.extract.yaml'));
        const partial = await call(codeSpecsStepContextImpl, { extractsDir: 'partial', step: 2 });
        assert.equal(partial.ok, true);
        assert.deepEqual(partial.extracts.map((e: Json) => [e.area, e.missing === true]), [['CE-TX', true], ['CE-ER', false]]);

        const full = await call(codeSpecsStepContextImpl, { ...extracts, step: 1, includeUniversalRules: true });
        assert.match(full.contract.universalRules.text, /^## 2\. Universal rules/);
        assert.match(full.contract.universalRules.text, /### 2\.9 The authoring prompt/);
        assert.doesNotMatch(full.contract.universalRules.text, /^## 3\./m);
    });

    test('SC-4: the packaged contract equals tom_core\'s', (t) => {
        assert.ok(fs.existsSync(CONTRACT_FILE), `missing ${CONTRACT_FILE}: run npm run som:pack`);
        if (!fs.existsSync(CONTRACT_SOURCE)) {
            t.skip(`no tom_core checkout at ${CONTRACT_SOURCE}`);
            return;
        }
        assert.equal(fs.readFileSync(CONTRACT_FILE, 'utf8'), fs.readFileSync(CONTRACT_SOURCE, 'utf8'),
            'resources/codespecs/codespecs_derivation_contract.md is stale: run npm run som:pack -- --catalog-only');
    });

    test('SC-5: registration', () => {
        assert.deepEqual(CODESPECS_VALIDATE_TOOLS.map((tool) => [tool.name, tool.readOnly]), [
            ['tomAi_specCodeSpecsValidate', true],
            ['tomAi_specCodeSpecsStepContext', true],
        ]);
    });
});
