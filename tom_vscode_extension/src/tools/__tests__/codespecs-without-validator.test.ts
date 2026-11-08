/**
 * The CodeSpecs tools on a platform without validate_codespecs (vsc_nodart-4):
 * an extension root that has no binary for this platform and nothing
 * configured. With the binary present the CV-*, CT-* and WS-* tests hold.
 *
 *   NV-1 tomAi_specCodeSpecsValidate: `binaryMissing` with `expected`, `help` and `page`; the error names the
 *        platform, the configuration key, the build command and the page
 *   NV-2 tomAi_specCodeSpecsTrace with `codeDirs`: the trace from the extracts, no `agreement`, the warning and
 *        `help` (the activation provider answering null, or the binary run throwing); an explicit `backlinks`
 *        index still gives the agreement; tracing from code says the back-links are missing
 *   NV-3 tomAi_specCodeSpecsStatus with `shared`: validation notChecked with the warning and `help`; `next` as
 *        without `shared`
 *   NV-4 the user is told once per tool in a window session; the answers carry the warning every time
 *   NV-5 the runbook codespecs-validate and the tom_specs process say what to do on `binaryMissing`; the
 *        activation provider is the null-answering one
 */

import test, { before, describe } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import { installVscodeStub } from './_vscode-stub.js';
installVscodeStub({});

import { SomModelService } from '../../services/som-model-service.js';
import { SomDocumentStore } from '../../services/som-document-store.js';
import {
    backlinkIndexJson,
    isValidatorAvailable,
    resetValidationSkippedNotices,
    setValidationSkippedNotifier,
    VALIDATOR_CONFIG_KEY,
} from '../../services/codespecs-validator.js';
import { HELP_HINT, setDartBinariesConfigSource, setDartBinariesExtensionRoot } from '../../services/dartBinariesStatus.js';
import { getCurrentPlatform } from '../../utils/executableResolver.js';
import { runbookText } from '../../services/codespecs-guides.js';
import type { SpecToolDeps } from '../spec-tool-common.js';
import { codeSpecsValidateImpl } from '../codespecs-validate-tools.js';
import { codeSpecsTraceImpl, setBacklinkProvider, type BacklinkProvider } from '../codespecs-trace-tools.js';
import { codeSpecsStatusImpl, type StatusDeps } from '../codespecs-workflow-tools.js';

const EXT_ROOT = path.resolve(__dirname, '..', '..', '..');
const WS_ROOT = path.resolve(EXT_ROOT, '..', '..', '..');
const FIXTURE = path.join(EXT_ROOT, 'src', 'tools', '__tests__', 'fixtures', 'phase4');
const MERIDIAN = path.resolve(EXT_ROOT, '..', '..', 'ai_build', 'tom_som_dart_v0', 'documents', 'meridian_order_management.docspecs.yaml');
const PLATFORM = getCurrentPlatform();
const WARNING = `validate_codespecs missing on ${PLATFORM}: no back-link agreement (checks 35, 36)`;
const NOTICE = `CodeSpecs validation skipped: validate_codespecs is not available on ${PLATFORM}.`;

const ws = fs.mkdtempSync(path.join(os.tmpdir(), 'codespecs-no-validator-'));
fs.cpSync(path.join(FIXTURE, 'codespec'), path.join(ws, 'run', 'codespec'), { recursive: true });
fs.cpSync(path.join(FIXTURE, 'codespecs_extracts'), path.join(ws, 'run', 'codespecs_extracts'), { recursive: true });
fs.copyFileSync(path.join(FIXTURE, 'backlinks.json'), path.join(ws, 'run', 'backlinks.json'));

// No binary for this platform, nothing configured.
const noBinaryRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'codespecs-no-binary-ext-'));
setDartBinariesExtensionRoot(noBinaryRoot);
setDartBinariesConfigSource(() => ({}));
const notices: string[] = [];
setValidationSkippedNotifier((m) => { notices.push(m); });

const service = SomModelService.instance;
const deps: SpecToolDeps = { wsRoot: ws, store: new SomDocumentStore(service), service };
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Json = any;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const call = async (impl: (d: SpecToolDeps, i: any) => Promise<string>, input: object): Promise<Json> => JSON.parse(await impl(deps, input));
/** The provider extension.ts installs at activation. */
const activationProvider: BacklinkProvider = async (dirs) => (isValidatorAvailable() ? backlinkIndexJson(dirs) : null);
const status: StatusDeps = { plan: {} as never, activeQuest: () => '' };

describe('CodeSpecs without validate_codespecs', () => {
    before(() => { void service.model; });

    test('NV-1: validate answers binaryMissing with the help', async () => {
        assert.equal(isValidatorAvailable(), false);
        const r = await call(codeSpecsValidateImpl, { shared: 'run/codespec/shared', client: 'run/codespec/client', server: 'run/codespec/server' });
        assert.equal(r.ok, false);
        assert.equal(r.outcome, 'binaryMissing');
        assert.equal(r.expected, path.join(noBinaryRoot, 'bin', PLATFORM, process.platform === 'win32' ? 'validate_codespecs.exe' : 'validate_codespecs'));
        assert.equal(r.help, HELP_HINT);
        assert.match(r.page, /missing_dart_binaries\.md$/);
        for (const part of [`not available on ${PLATFORM}`, VALIDATOR_CONFIG_KEY, 'npm run codespecs:build', r.page, 'tomAi.showDartBinariesHelp']) {
            assert.ok(r.error.includes(part), `the error names ${part}`);
        }
    });

    test('NV-2: trace over codeDirs goes on without back-links', async () => {
        const input = { extractsDir: 'run/codespecs_extracts', codeDirs: { shared: 'run/codespec/shared' }, token: 'DAENT-IDEN' };
        for (const provider of [activationProvider, ((dirs) => backlinkIndexJson(dirs)) as BacklinkProvider]) {
            setBacklinkProvider(provider);
            const r = await call(codeSpecsTraceImpl, input);
            assert.equal(r.ok, true, JSON.stringify(r));
            assert.equal(r.backlinks, null);
            assert.equal(r.agreement, undefined, 'no agreement');
            assert.deepEqual(r.warnings, [WARNING]);
            assert.equal(r.help, HELP_HINT);
            assert.ok(r.tokens[0].entries.length > 0, 'the trace from the extracts');
        }
        const withIndex = await call(codeSpecsTraceImpl, { extractsDir: 'run/codespecs_extracts', backlinks: 'run/backlinks.json', token: 'DAENT-IDEN' });
        assert.equal(withIndex.ok, true);
        assert.ok(withIndex.agreement, 'an explicit index still gives the agreement');
        assert.equal(withIndex.warnings, undefined);
        const fromCode = await call(codeSpecsTraceImpl, { extractsDir: 'run/codespecs_extracts', codeDirs: { shared: 'run/codespec/shared' }, declaration: 'dataAccess.Customer' });
        assert.equal(fromCode.ok, false);
        assert.equal(fromCode.code, 'binaryMissing');
        assert.deepEqual(fromCode.warnings, [WARNING]);
        assert.equal(fromCode.help, HELP_HINT);
        setBacklinkProvider(null);
    });

    test('NV-3: status with shared', async (t) => {
        if (!fs.existsSync(MERIDIAN)) { t.skip(`no ${MERIDIAN}`); return; }
        fs.copyFileSync(MERIDIAN, path.join(ws, 'run', 'meridian.docspecs.yaml'));
        const file = 'run/meridian.docspecs.yaml';
        const without = JSON.parse(await codeSpecsStatusImpl(deps, status, { file }));
        const r = JSON.parse(await codeSpecsStatusImpl(deps, status, { file, shared: 'run/codespec/shared' }));
        assert.equal(r.ok, true, JSON.stringify(r));
        const v = r.stages.find((s: Json) => s.stage === 'validation');
        assert.equal(v.state, 'notChecked');
        assert.match(v.summary, new RegExp(`^validate_codespecs missing on ${PLATFORM}: the trio is not validated`));
        assert.deepEqual(r.warnings, v.details.warnings);
        assert.match(r.warnings[0], new RegExp(`^validate_codespecs missing on ${PLATFORM}: `));
        assert.equal(r.help, HELP_HINT);
        assert.deepEqual(r.next, without.next, 'next as if validation was not asked for');
    });

    test('NV-4: told once per tool, warned every time', async () => {
        resetValidationSkippedNotices();
        notices.length = 0;
        setBacklinkProvider(activationProvider);
        const input = { extractsDir: 'run/codespecs_extracts', codeDirs: { shared: 'run/codespec/shared' }, token: 'DAENT-IDEN' };
        for (let i = 0; i < 3; i++) { assert.deepEqual((await call(codeSpecsTraceImpl, input)).warnings, [WARNING]); }
        assert.deepEqual(notices, [NOTICE], 'once for the trace tool');
        if (fs.existsSync(MERIDIAN)) {
            for (let i = 0; i < 2; i++) {
                const r = JSON.parse(await codeSpecsStatusImpl(deps, status, { file: 'run/meridian.docspecs.yaml', shared: 'run/codespec/shared' }));
                assert.equal(r.warnings.length, 1);
            }
            assert.deepEqual(notices, [NOTICE, NOTICE], 'once more for the status tool');
        }
        await call(codeSpecsValidateImpl, { shared: 'run/codespec/shared', client: 'run/codespec/client', server: 'run/codespec/server' });
        assert.equal(notices.length, fs.existsSync(MERIDIAN) ? 2 : 1, 'the validate tool answers binaryMissing: no workaround, no notice');
        setBacklinkProvider(null);
    });

    test('NV-5: runbook, process, activation', (t) => {
        const rb = runbookText('codespecs-validate', { file: 'spec.docspecs.yaml', shared: 'app_codespec_shared' });
        assert.ok(rb.ok);
        assert.match((rb as { text: string }).text, /`outcome: "binaryMissing"`[\s\S]*"validation not run: validate_codespecs missing on <platform>"[\s\S]*carry on with the other steps\. The G4 gate stays unpassed until\nvalidation has run on a host that has the binary/);
        const ext = fs.readFileSync(path.join(EXT_ROOT, 'src', 'extension.ts'), 'utf8');
        assert.match(ext, /setBacklinkProvider\(async \(dirs\) => \(isValidatorAvailable\(\) \? backlinkIndexJson\(dirs\) : null\)\);/);
        assert.match(ext, /setValidationSkippedNotifier\(\(message\) => \{ void showWithDartBinariesHelp\('warning', message\); \}\);/);
        const processFile = path.join(WS_ROOT, '_ai', 'processes', 'tom_specs', 'tom_specs.process.yaml');
        if (!fs.existsSync(processFile)) { t.skip('no _ai/processes around this checkout'); return; }
        const yaml = fs.readFileSync(processFile, 'utf8');
        assert.match(yaml, /When the validate tool answers `outcome: "binaryMissing"`[^\n]*"validation not run: validate_codespecs missing on <platform>"[^\n]*gate G4 stays unpassed/);
        assert.match(yaml, /G4-VAL-1 derivation-contract checks pass \(validated on a host that has validate_codespecs: "validation not run" is not a pass\)/);
    });
});
