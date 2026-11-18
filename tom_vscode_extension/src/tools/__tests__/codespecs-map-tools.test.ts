/**
 * tomAi_specCodeSpecsMap (vscimpb99): Phase 4's stage 5 through the bundled `tomspecs :ir-map`, on a copy of the Meridian
 * sample (its generation-unit register) with the phase-4 fixture's IR.
 *
 *   CM-1 dryRun: one run per unit and mapper (the unit's areas grouped by mapper), the commands with
 *        workspace-relative paths, no Dart SDK note; `unit` narrows to one unit; an unknown unit and a missing IR
 *        folder are refused
 *   CM-2 the runs: the IR call's arguments (`map --mapper --ir --spec --unit --out`) and nothing else (no
 *        environment of its own), ok when every run exits 0, a failing run's error kept
 *   CM-3 a failing dart-tom run is an ordinary failure (no `formatterUnavailable`, no `dartSdk`); a missing binary
 *        is `binaryMissing` with `help` and `page`
 *   CM-4 the real bundled tomspecs (when this platform has one): a unit on ts-shared is mapped without a Dart SDK
 *   CM-5 registration (a writer, approval-gated), the runbook, the csgen31 text and the workflow name the tool;
 *        tomspecs is one of the Dart binaries the window reports (with tom_bs, nothing else), built by codespecs:build with its stamp; the
 *        description and the runbook name no Dart SDK prerequisite and no TOM_DART
 *   CM-7 the real bundled tomspecs (when this platform has one) with only /usr/bin:/bin on PATH and no TOM_DART
 *        (vscimpb147, tom_specs irfmt2: dart_style in-process): a dart-tom unit is written formatted, byte-equal
 *        to the committed trio's server package
 *   CM-9 a generation unit listing `markdown` among its emitters validates without `unitEmitterUnknown` (tom_specs
 *        irout3); an unknown emitter still reports it
 */

import test, { after, describe } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'fs';
import * as path from 'path';

import { installVscodeStub } from './_vscode-stub.js';
import { withTiming } from './_timing.js';
installVscodeStub({});

import { SomModelService } from '../../services/som-model-service.js';
import { SomDocumentStore } from '../../services/som-document-store.js';
import { DART_BINARIES, DART_BINARY_FEATURE, DartBinaryMissing, currentDartBinary } from '../../services/dartBinariesStatus.js';
import { CLITOOL_BINARY, runClitool } from '../../services/tomspecsCalls.js';

/** The mapping binary and its command. */
const MAPPER_BIN = CLITOOL_BINARY;
const MAP_CMD = 'tomspecs :ir-map';
import type { SpecToolDeps } from '../spec-tool-common.js';
import { CODESPECS_MAP_TOOL, codeSpecsMapImpl, setIrRunnerForTest } from '../codespecs-map-tools.js';
import { specValidateImpl } from '../spec-validate-tools.js';
import { AVAILABLE_LLM_TOOLS } from '../../utils/constants.js';
import { CATEGORY_MAP } from '../../utils/toolCategories.js';

const EXT_ROOT = path.resolve(__dirname, '..', '..', '..');
const FIXTURE_IR = path.join(EXT_ROOT, 'src', 'tools', '__tests__', 'fixtures', 'phase4', 'codespec', 'irspecs');
const AI_BUILD = path.resolve(EXT_ROOT, '..', '..', 'ai_build');
const MERIDIAN_YAML = fs.readFileSync(path.join(AI_BUILD, 'tom_som_dart_v0', 'documents', 'meridian_order_management.docspecs.yaml'), 'utf8');

const ws = fs.realpathSync(fs.mkdtempSync(path.join(EXT_ROOT, '..', '..', '..', 'ztmp', 'vscode_extension_261114_vscimpb99_map-')));
after(() => { setIrRunnerForTest(undefined); fs.rmSync(ws, { recursive: true, force: true }); });
fs.mkdirSync(path.join(ws, 'run'), { recursive: true });
fs.writeFileSync(path.join(ws, 'run', 'meridian.docspecs.yaml'), MERIDIAN_YAML);
fs.cpSync(FIXTURE_IR, path.join(ws, 'run', 'irspecs'), { recursive: true });
const FILE = 'run/meridian.docspecs.yaml';

const service = SomModelService.instance;
const deps: SpecToolDeps = { wsRoot: ws, store: new SomDocumentStore(service), service };
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Json = any;
const call = async (input: object): Promise<Json> => JSON.parse(await codeSpecsMapImpl(deps, input as never));

describe('tomAi_specCodeSpecsMap', () => {
    test('CM-1: the plan (dryRun)', async () => {
        const plan = await withTiming('tomAi_specCodeSpecsMap:typical', () => call({ file: FILE, out: 'run/mapped', dryRun: true }));
        assert.equal(plan.ok, true, JSON.stringify(plan));
        assert.equal(plan.dryRun, true);
        assert.deepEqual([plan.file, plan.ir, plan.out], [FILE, 'run/irspecs', 'run/mapped']);
        const units = [...new Set(plan.runs.map((r: Json) => r.unit))];
        assert.deepEqual(units, ['meridian_codespec_shared', 'meridian_codespec_client', 'meridian_codespec_server'], 'every unit, in register order');
        assert.ok(plan.runs.every((r: Json) => r.mapper === 'dart-tom'), 'Meridian maps every area with dart-tom: one run per unit');
        assert.ok(plan.runs[0].areas.includes('CE-API'));
        assert.equal(plan.runs[0].command, `${MAP_CMD} --mapper dart-tom --ir run/irspecs --spec ${FILE} --unit meridian_codespec_shared --out run/mapped`);
        assert.equal(plan.note, undefined, 'no Dart SDK note');
        assert.equal('dartSdk' in plan, false);
        const one = await call({ file: FILE, out: 'run/mapped', unit: 'meridian_codespec_server', dryRun: true });
        assert.deepEqual(one.runs.map((r: Json) => r.unit), ['meridian_codespec_server']);
        const unknown = await call({ file: FILE, out: 'run/mapped', unit: 'nowhere', dryRun: true });
        assert.deepEqual([unknown.ok, unknown.code], [false, 'unknownUnit']);
        assert.match(unknown.error, /its units: meridian_codespec_shared, meridian_codespec_client, meridian_codespec_server/);
        const noIr = await call({ file: FILE, out: 'run/mapped', ir: 'run/none', dryRun: true });
        assert.deepEqual([noIr.ok, noIr.code], [false, 'irMissing']);
        assert.equal((await call({ file: FILE })).ok, false, '`out` is required');
    });

    test('CM-2: the runs', async () => {
        const seen: string[][] = [];
        setIrRunnerForTest(async (...a: unknown[]) => {
            const args = a[0] as string[];
            assert.equal(a.length, 1, 'the arguments only: no environment of its own');
            seen.push(args);
            return args.includes('meridian_codespec_client') ? { exitCode: 1, stdout: '', stderr: 'a client mapper failed' } : { exitCode: 0, stdout: '3 file(s) written and formatted.', stderr: '' };
        });
        const r = await call({ file: FILE, out: 'run/mapped' });
        assert.equal(seen.length, 3);
        assert.deepEqual(seen[0], ['map', '--mapper', 'dart-tom', '--ir', path.join(ws, 'run', 'irspecs'), '--spec', path.join(ws, FILE), '--unit', 'meridian_codespec_shared', '--out', path.join(ws, 'run', 'mapped')]);
        assert.equal(r.ok, false, 'one run failed');
        assert.deepEqual(r.runs.map((x: Json) => [x.unit, x.exitCode]), [['meridian_codespec_shared', 0], ['meridian_codespec_client', 1], ['meridian_codespec_server', 0]]);
        assert.equal(r.runs[0].written, '3 file(s) written and formatted.');
        assert.equal(r.runs[1].error, 'a client mapper failed');
        setIrRunnerForTest(async () => ({ exitCode: 0, stdout: 'ok', stderr: '' }));
        assert.equal((await call({ file: FILE, out: 'run/mapped' })).ok, true);
    });

    test('CM-3: a failing run; a missing binary', async () => {
        setIrRunnerForTest(async () => ({ exitCode: 1, stdout: '', stderr: 'the server mapper failed' }));
        const r = await call({ file: FILE, out: 'run/mapped', unit: 'meridian_codespec_server' });
        assert.equal(r.ok, false);
        assert.equal(r.runs[0].error, 'the server mapper failed');
        assert.equal('formatterUnavailable' in r || 'formatterUnavailable' in r.runs[0], false, 'no formatterUnavailable');
        assert.equal('dartSdk' in r, false);
        assert.equal(r.note, undefined);
        setIrRunnerForTest(async () => { throw new DartBinaryMissing('tomspecs', '/x/bin/darwin-arm64/tomspecs'); });
        const missing = await call({ file: FILE, out: 'run/mapped' });
        assert.deepEqual([missing.ok, missing.outcome, missing.expected], [false, 'binaryMissing', '/x/bin/darwin-arm64/tomspecs']);
        assert.ok(missing.help && missing.page, 'how to get it');
        setIrRunnerForTest(undefined);
    });

    test('CM-4: the bundled tomspecs maps a ts-shared unit without a Dart SDK', { skip: currentDartBinary(MAPPER_BIN, EXT_ROOT).path ? false : `no ${MAPPER_BIN} for this platform` }, async () => {
        // The shared unit on the TypeScript mapper (no `dart format`); the run's PATH holds no Dart SDK.
        fs.writeFileSync(path.join(ws, 'run', 'ts.docspecs.yaml'), MERIDIAN_YAML.replace(/(unitId: \|2-\n\s+meridian_codespec_shared[\s\S]*?mapping: \|2-\n\s+)dart-tom/, '$1ts-shared'));
        const pathBefore = process.env.PATH;
        process.env.PATH = '/usr/bin:/bin';
        try {
            setIrRunnerForTest((args: string[]) => runClitool({ tool: 'ir', args }, { timeoutMs: 120_000, extensionRoot: EXT_ROOT }));
            const plan = await call({ file: 'run/ts.docspecs.yaml', out: 'run/ts-out', unit: 'meridian_codespec_shared', dryRun: true });
            assert.ok(plan.runs.some((r: Json) => r.mapper === 'ts-shared'), JSON.stringify(plan.runs));
            const r = await call({ file: 'run/ts.docspecs.yaml', out: 'run/ts-out', unit: 'meridian_codespec_shared' });
            const ts = r.runs.find((x: Json) => x.mapper === 'ts-shared');
            assert.equal(ts.exitCode, 0, JSON.stringify(ts));
            assert.match(ts.written, /file\(s\) written/);
        } finally {
            process.env.PATH = pathBefore;
            setIrRunnerForTest(undefined);
        }
    });

    test('CM-5: registered, named and built', () => {
        assert.equal(CODESPECS_MAP_TOOL.name, 'tomAi_specCodeSpecsMap');
        assert.equal(CODESPECS_MAP_TOOL.readOnly, false);
        assert.equal(CODESPECS_MAP_TOOL.requiresApproval, true);
        assert.ok(AVAILABLE_LLM_TOOLS.includes('tomAi_specCodeSpecsMap'));
        assert.ok(Object.values(CATEGORY_MAP).some((list) => (list as readonly string[]).includes('tomAi_specCodeSpecsMap')));
        const src = (rel: string): string => fs.readFileSync(path.join(EXT_ROOT, rel), 'utf8');
        assert.match(src('src/services/codespecs-guides.ts'), /1\. Map\. tomAi_specCodeSpecsMap with `file: "\{file\}"`/);
        assert.match(src('src/tools/codespecs-plan-tools.ts'), /tomAi_specCodeSpecsMap with file '<document>' and out '<packages folder>'/);
        assert.match(src('src/tools/codespecs-workflow-tools.ts'), /Map each generation unit from the IR \(tomAi_specCodeSpecsMap\)/);
        assert.deepEqual([...DART_BINARIES], ['tom_bs', 'tomspecs']);
        assert.equal(DART_BINARY_FEATURE.tomspecs, 'TomSpecs process checks, CodeSpecs validation and mapping');
        assert.match(src('scripts/codespecs-binary-stamp.cjs'), /const CLITOOL_BINARIES = \['tomspecs'\];/);
        assert.match(src('scripts/check-vsix-contents.cjs'), /const DART_BINARIES = \['tom_bs', 'tomspecs'\];/);
        assert.match(src('scripts/vsix-release.cjs'), /const DART_BINARIES = \['tom_bs', 'tomspecs'\];/);
        // No Dart SDK prerequisite (vscimpb147).
        assert.doesNotMatch(CODESPECS_MAP_TOOL.description, /Dart SDK|TOM_DART|formatterUnavailable|dartSdk/);
        assert.doesNotMatch(src('src/tools/codespecs-map-tools.ts'), /TOM_DART|formatterUnavailable|dartSdk/);
        assert.doesNotMatch(src('src/services/codespecs-guides.ts'), /TOM_DART|formatterUnavailable|prerequisite of dart-tom/);
        assert.equal(fs.existsSync(path.join(EXT_ROOT, 'src', 'services', 'dartSdk.ts')), false);
    });

    test('CM-7: the bundled tomspecs maps a dart-tom unit formatted, without a Dart SDK', { skip: currentDartBinary(MAPPER_BIN, EXT_ROOT).path ? false : `no ${MAPPER_BIN} for this platform` }, async () => {
        const pathBefore = process.env.PATH;
        const tomDartBefore = process.env.TOM_DART;
        process.env.PATH = '/usr/bin:/bin';
        delete process.env.TOM_DART;
        setIrRunnerForTest((args: string[]) => runClitool({ tool: 'ir', args }, { timeoutMs: 300_000, extensionRoot: EXT_ROOT }));
        try {
            // The server unit (the fixture's IR writes its four files; the shared unit's areas have none).
            const r = await call({ file: FILE, out: 'run/dart-out', unit: 'meridian_codespec_server' });
            assert.equal(r.ok, true, JSON.stringify(r));
            assert.match(r.runs[0].written, /^4 file\(s\) written/);
            const out = path.join(ws, 'run', 'dart-out', 'meridian_codespec_server');
            // Formatted as `dart format` lays it out: byte-equal to the committed trio's server package.
            const committed = path.join(EXT_ROOT, 'src', 'tools', '__tests__', 'fixtures', 'phase4', 'codespec', 'server');
            for (const rel of ['lib/src/data_access/customer.dart', 'lib/src/data_access/order.dart', 'lib/src/services/customer_service.dart', 'lib/src/services/order_service.dart']) {
                assert.equal(fs.readFileSync(path.join(out, rel), 'utf8'), fs.readFileSync(path.join(committed, rel), 'utf8'), rel);
            }
        } finally {
            process.env.PATH = pathBefore;
            if (tomDartBefore !== undefined) { process.env.TOM_DART = tomDartBefore; }
            setIrRunnerForTest(undefined);
        }
    });

    test('CM-9: `markdown` is a standard emitter', async () => {
        const withEmitter = (emitter: string): string => MERIDIAN_YAML.replace(/(emitter: \|2-\n\s+)openapi/, `$1${emitter}`);
        const codes = async (name: string, emitter: string): Promise<string[]> => {
            const text = withEmitter(emitter);
            assert.notEqual(text, MERIDIAN_YAML, 'the emitter replaced');
            fs.writeFileSync(path.join(ws, 'run', name), text);
            const v = JSON.parse(await specValidateImpl(deps, { file: `run/${name}` } as never));
            return (v.violations ?? []).map((x: Json) => x.code);
        };
        assert.equal((await codes('md.docspecs.yaml', 'markdown')).includes('unitEmitterUnknown'), false);
        assert.ok((await codes('bad.docspecs.yaml', 'nowhere-emitter')).includes('unitEmitterUnknown'), 'the check is live');
    });
});
