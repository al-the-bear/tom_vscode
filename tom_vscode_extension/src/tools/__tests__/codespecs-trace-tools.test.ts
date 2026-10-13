/**
 * CodeSpecs query and trace (vsctsa19), over a snapshot of
 * tom_specs_samples/phase4_codespecs_run: its 27 extracts (the run's
 * gitignored build/codespecs_extracts) and the back-link index of its
 * generated trio (`validate_codespecs --backlinks`), in fixtures/phase4/.
 * CT-10 holds the snapshot to the sample when the sample has been run.
 *
 *   CT-1   query by token, area, path and text; the limit
 *   CT-2   an extract in an unknown format version is reported, the rest still answer
 *   CT-3   from a declaration: its tokens, their spec values, who else cites them; the sample agrees
 *   CT-4   from a code location: the declaration at or above the line
 *   CT-5   from a token and from a spec path: the declarations citing it
 *   CT-6   a dangling back-link and an uncited token are flagged
 *   CT-7   the heading codeSpec forward link from a spec document
 *   CT-8   a gate record scopes the run
 *   CT-9   input errors, the back-link provider, a wrong index format
 *   CT-10  the fixture equals the sample's run (when the sample has been run)
 *   CT-11  registration
 *   CT-12  codeDirs through the bundled validate_codespecs: the same index and agreement as backlinks.json
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
import { backlinkIndexJson } from '../../services/codespecs-validator.js';
import type { SpecToolDeps } from '../spec-tool-common.js';
import {
    CODESPECS_TRACE_TOOLS,
    codeSpecsQueryImpl,
    codeSpecsTraceImpl,
    setBacklinkProvider,
} from '../codespecs-trace-tools.js';

const EXT_ROOT = path.resolve(__dirname, '..', '..', '..');
const FIXTURE = path.join(EXT_ROOT, 'src', 'tools', '__tests__', 'fixtures', 'phase4');
const AI_BUILD = path.resolve(EXT_ROOT, '..', '..', 'ai_build');
const SAMPLE_EXTRACTS = path.join(AI_BUILD, 'tom_specs_samples', 'phase4_codespecs_run', 'build', 'codespecs_extracts');
const MERIDIAN_YAML = fs.readFileSync(path.join(AI_BUILD, 'tom_som_dart_v0', 'documents', 'meridian_order_management.docspecs.yaml'), 'utf8');
const CORPUS = path.join(AI_BUILD, 'tom_som_conformance', 'generated-doc', 'codespecs_extracts');

const ENTITY = 'SBP/informationAndDataModel/dataModel/DAENT-ENTI-LST-1';

const ws = fs.mkdtempSync(path.join(os.tmpdir(), 'codespecs-trace-'));
const put = (name: string, text: string): string => {
    fs.mkdirSync(path.dirname(path.join(ws, name)), { recursive: true });
    fs.writeFileSync(path.join(ws, name), text);
    return name;
};
/** A copy of the fixture run under `name/`, optionally changed. */
function run(name: string, change?: (file: string, text: string) => string): string {
    for (const f of fs.readdirSync(path.join(FIXTURE, 'codespecs_extracts'))) {
        const text = fs.readFileSync(path.join(FIXTURE, 'codespecs_extracts', f), 'utf8');
        put(`${name}/codespecs_extracts/${f}`, change ? change(f, text) : text);
    }
    put(`${name}/backlinks.json`, fs.readFileSync(path.join(FIXTURE, 'backlinks.json'), 'utf8'));
    return name;
}

const service = SomModelService.instance;
const deps: SpecToolDeps = { wsRoot: ws, store: new SomDocumentStore(service), service };
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Json = any;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const call = async (impl: (d: SpecToolDeps, i: any) => Promise<string>, input: object): Promise<Json> => JSON.parse(await impl(deps, input));
const base = { extractsDir: 'base/codespecs_extracts', backlinks: 'base/backlinks.json' };

describe('CodeSpecs query and trace', () => {
    before(() => { void service.model; run('base'); });

    test('CT-1: query', async () => {
        const r = JSON.parse(await withTiming('tomAi_specCodeSpecsQueryExtracts:typical', () =>
            codeSpecsQueryImpl(deps, { extractsDir: base.extractsDir, token: 'DAENT-IDEN' })));
        assert.equal(r.ok, true, JSON.stringify(r));
        assert.equal(r.areas, 27);
        assert.ok(r.total > 0 && r.entries.every((e: Json) => e.token === 'DAENT-IDEN'));
        const first = r.entries[0];
        assert.ok(first.path && first.className && first.field && first.routedBy && first.value !== undefined);
        const db = await call(codeSpecsQueryImpl, { extractsDir: base.extractsDir, area: 'CE-DB', path: ENTITY });
        assert.ok(db.total > 0 && db.entries.every((e: Json) => e.area === 'CE-DB' && e.path.startsWith(ENTITY)));
        const text = await call(codeSpecsQueryImpl, { extractsDir: base.extractsDir, text: 'CUSTOMERS' });
        assert.ok(text.entries.some((e: Json) => e.value === 'customers'), 'text matches any case');
        const limited = await call(codeSpecsQueryImpl, { extractsDir: base.extractsDir, limit: 3 });
        assert.equal(limited.entries.length, 3);
        assert.equal(limited.truncated, true);
    });

    test('CT-2: an unknown format version is reported, not misread', async () => {
        run('future', (f, text) => (f === 'CE-DB.extract.yaml' ? text.replace(/formatVersion: \d+/, 'formatVersion: 99') : text));
        const r = await call(codeSpecsQueryImpl, { extractsDir: 'future/codespecs_extracts', token: 'DAENT-IDEN' });
        assert.equal(r.ok, true);
        assert.equal(r.unreadable.length, 1);
        assert.equal(r.unreadable[0].file, 'CE-DB.extract.yaml');
        assert.match(r.unreadable[0].error, /format 99/);
        assert.equal(r.areas, 26);
        assert.ok(r.entries.every((e: Json) => e.area !== 'CE-DB'), 'the other areas still answer');
    });

    test('CT-3: from a declaration', async () => {
        const r = JSON.parse(await withTiming('tomAi_specCodeSpecsTrace:typical', () =>
            codeSpecsTraceImpl(deps, { ...base, declaration: 'dataAccess.Customer' })));
        assert.equal(r.ok, true, JSON.stringify(r));
        assert.equal(r.from.declaration.name, 'Customer');
        assert.equal(r.codeSpec.id, 'dataAccess.Customer');
        assert.deepEqual(r.tokens.map((t: Json) => t.token), ['DAENT-IDEN', 'content', 'DAATT-IDEN', 'DAATT-DATA']);
        const iden = r.tokens[0];
        assert.ok(iden.entries.some((e: Json) => e.value === 'customers' && e.path === `${ENTITY}/DAENT-IDEN`), 'down to the spec value');
        assert.ok(iden.citedBy.some((d: Json) => d.codeSpecId === 'dataAccess.Customer'));
        assert.deepEqual(r.agreement, { passed: true, uncited: [], dangling: [] }, 'the sample\'s trio cites every extracted token');
    });

    test('CT-4: from a code location', async () => {
        const index = JSON.parse(fs.readFileSync(path.join(FIXTURE, 'backlinks.json'), 'utf8'));
        const customer = index.declarations.find((d: Json) => d.codeSpec?.id === 'dataAccess.Customer');
        const r = await call(codeSpecsTraceImpl, { ...base, codeFile: `codespec/server/${customer.file}`, line: customer.line + 3 });
        assert.equal(r.ok, true, JSON.stringify(r));
        assert.equal(r.codeSpec.id, 'dataAccess.Customer', 'the declaration at or above the line');
        assert.equal((await call(codeSpecsTraceImpl, { ...base, codeFile: 'lib/nowhere.dart', line: 1 })).code, 'notFound');
    });

    test('CT-5: from a token and from a spec path', async () => {
        const token = await call(codeSpecsTraceImpl, { ...base, token: 'DAATT-DATA' });
        assert.ok(token.tokens[0].citedBy.length > 0);
        assert.ok(token.tokens[0].entries.length > 0);
        const spec = await call(codeSpecsTraceImpl, { ...base, specPath: ENTITY });
        assert.ok(spec.tokens.length > 0);
        assert.ok(spec.tokens.every((t: Json) => t.entries.every((e: Json) => e.path.startsWith(ENTITY))), 'only the entries under the path');
        assert.ok(spec.tokens.some((t: Json) => t.citedBy.some((d: Json) => d.codeSpecId === 'dataAccess.Customer')));
    });

    test('CT-6: a dangling back-link and an uncited token', async () => {
        run('crafted');
        const index = JSON.parse(fs.readFileSync(path.join(ws, 'crafted/backlinks.json'), 'utf8'));
        const customer = index.declarations.find((d: Json) => d.codeSpec?.id === 'dataAccess.Customer');
        customer.tokens.push('NOPE-TOKEN');
        for (const d of index.declarations) { d.tokens = d.tokens.filter((t: string) => t !== 'DAATT-DATA'); }
        put('crafted/backlinks.json', JSON.stringify(index));
        const crafted = { extractsDir: 'crafted/codespecs_extracts', backlinks: 'crafted/backlinks.json' };
        const r = await call(codeSpecsTraceImpl, { ...crafted, declaration: 'dataAccess.Customer' });
        assert.equal(r.agreement.passed, false);
        assert.deepEqual(r.agreement.dangling.map((d: Json) => d.token), ['NOPE-TOKEN']);
        assert.match(r.agreement.dangling[0].citedBy[0], /Customer/);
        assert.ok(r.agreement.uncited.some((u: Json) => u.token === 'DAATT-DATA' && u.values > 0));
        assert.equal(r.tokens.find((t: Json) => t.token === 'NOPE-TOKEN').dangling, true);
    });

    test('CT-7: the heading codeSpec forward link', async () => {
        put('spec/meridian.docspecs.yaml', MERIDIAN_YAML);
        for (const f of fs.readdirSync(CORPUS)) { put(`spec/generated-doc/codespecs_extracts/${f}`, fs.readFileSync(path.join(CORPUS, f), 'utf8')); }
        const fr1 = 'SBP/introductionAndScope/requirements/functionalRequirements/FRE-REQU-LST-1';
        const r = await call(codeSpecsTraceImpl, { file: 'spec/meridian.docspecs.yaml', specPath: `${fr1}/FRED` });
        assert.equal(r.ok, true, JSON.stringify(r));
        assert.deepEqual(r.headingCodeSpec, [
            { path: fr1, codeSpec: 'CsOrder,CsOrder.captureFromEdi,CsOrderRepository' },
            { path: 'SBP/introductionAndScope/requirements/functionalRequirements', codeSpec: 'CsFunctionalRequirements' },
        ], 'every ancestor carrying one, nearest first');
        assert.equal(r.backlinks, null);
    });

    test('CT-8: a gate record scopes the run', async () => {
        run('scoped');
        put('scoped/codespecs_extracts/gate.verdicts.yaml', 'gate:\n  formatVersion: 1\n  verdicts:\n    - area: CE-SU\n      verdict: insufficient\n      resolution: descoped\n');
        const r = await call(codeSpecsQueryImpl, { extractsDir: 'scoped/codespecs_extracts', area: 'CE-SU' });
        assert.ok(r.outOfScope.includes('CE-SU'));
        assert.ok(r.entries.length > 0 && r.entries.every((e: Json) => e.outOfScope === true));
    });

    test('CT-9: input errors and the back-link provider', async () => {
        assert.equal((await call(codeSpecsQueryImpl, {})).code, 'invalidInput');
        assert.equal((await call(codeSpecsTraceImpl, { ...base })).code, 'invalidInput');
        assert.equal((await call(codeSpecsTraceImpl, { ...base, token: 'X', specPath: 'Y' })).code, 'invalidInput');
        assert.equal((await call(codeSpecsTraceImpl, { extractsDir: base.extractsDir, declaration: 'x' })).code, 'noBacklinkSource');
        const noBinary = await call(codeSpecsTraceImpl, { extractsDir: base.extractsDir, codeDirs: { server: 'x' }, token: 'DAENT-IDEN' });
        assert.equal(noBinary.code, 'noBacklinkSource');
        assert.match(noBinary.error, /--backlinks/);

        let asked: unknown = null;
        setBacklinkProvider(async (dirs) => { asked = dirs; return fs.readFileSync(path.join(FIXTURE, 'backlinks.json'), 'utf8'); });
        try {
            const viaBinary = await call(codeSpecsTraceImpl, { extractsDir: base.extractsDir, codeDirs: { server: 'code/server' }, token: 'DAENT-IDEN' });
            assert.equal(viaBinary.ok, true);
            assert.deepEqual(asked, { server: path.join(ws, 'code/server') });
        } finally {
            setBacklinkProvider(null);
        }

        put('wrong.json', JSON.stringify({ format: 'codespecs-validation', formatVersion: 1 }));
        const wrong = await call(codeSpecsTraceImpl, { extractsDir: base.extractsDir, backlinks: 'wrong.json', token: 'X' });
        assert.equal(wrong.ok, false);
        assert.match(wrong.error, /codespecs-backlinks\/1 only/);
        assert.equal((await call(codeSpecsQueryImpl, { extractsDir: 'missing' })).ok, false);
    });

    test('CT-10: the fixture equals the sample\'s run', (t) => {
        if (!fs.existsSync(SAMPLE_EXTRACTS)) {
            t.skip(`the sample has not been run on this machine (no ${SAMPLE_EXTRACTS}); run it with \`dart run\` there`);
            return;
        }
        const fixture = fs.readdirSync(path.join(FIXTURE, 'codespecs_extracts')).sort();
        const sample = fs.readdirSync(SAMPLE_EXTRACTS).filter((f) => f.endsWith('.extract.yaml')).sort();
        assert.deepEqual(fixture, sample);
        for (const f of fixture) {
            assert.equal(fs.readFileSync(path.join(FIXTURE, 'codespecs_extracts', f), 'utf8'), fs.readFileSync(path.join(SAMPLE_EXTRACTS, f), 'utf8'),
                `${f} is stale: copy the sample's build/codespecs_extracts/*.extract.yaml into fixtures/phase4/codespecs_extracts`);
        }
    });

    test('CT-11: registration', () => {
        assert.deepEqual(CODESPECS_TRACE_TOOLS.map((tool) => [tool.name, tool.readOnly]), [
            ['tomAi_specCodeSpecsQueryExtracts', true],
            ['tomAi_specCodeSpecsTrace', true],
        ]);
    });

    test('CT-12: codeDirs through the bundled binary', async () => {
        const recorded = JSON.parse(fs.readFileSync(path.join(FIXTURE, 'backlinks.json'), 'utf8'));
        const live = JSON.parse(await backlinkIndexJson({ shared: path.join(FIXTURE, 'codespec', 'shared') }));
        assert.deepEqual(live.declarations, recorded.declarations, 'the binary reads the fixture trio into the recorded index');

        setBacklinkProvider((dirs) => backlinkIndexJson(dirs));
        try {
            fs.cpSync(path.join(FIXTURE, 'codespec'), path.join(ws, 'trio', 'codespec'), { recursive: true });
            const codeDirs = { shared: 'trio/codespec/shared' };
            const viaBinary = await call(codeSpecsTraceImpl, { extractsDir: base.extractsDir, codeDirs, declaration: 'dataAccess.Customer' });
            const viaFile = await call(codeSpecsTraceImpl, { ...base, declaration: 'dataAccess.Customer' });
            assert.equal(viaBinary.ok, true, JSON.stringify(viaBinary));
            assert.deepEqual(viaBinary.agreement, viaFile.agreement);
            assert.deepEqual(viaBinary.agreement, { passed: true, uncited: [], dangling: [] });
            assert.deepEqual(viaBinary.tokens, viaFile.tokens);

            const missing = await call(codeSpecsTraceImpl, { extractsDir: base.extractsDir, codeDirs: { shared: 'nowhere/shared' }, token: 'DAENT-IDEN' });
            assert.equal(missing.code, 'usageError');
            assert.match(missing.error, /shared package not found/);
        } finally {
            setBacklinkProvider(null);
        }
    });
});
