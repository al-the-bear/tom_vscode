/**
 * tomAi_specCodeSpecsMap (vscimpb99): Phase 4's stage 5 through the bundled irspecs, on a copy of the Meridian
 * sample (its generation-unit register) with the phase-4 fixture's IR.
 *
 *   CM-1 dryRun: one run per unit and mapper (the unit's areas grouped by mapper), the commands with
 *        workspace-relative paths, the dart-tom note; `unit` narrows to one unit; an unknown unit and a missing IR
 *        folder are refused
 *   CM-2 the runs: the arguments irspecs gets (`map --mapper --ir --spec --unit --out`), ok when every run exits 0,
 *        a failing run's error kept
 *   CM-3 a dart-tom run without a Dart SDK (irspecs' "written unformatted: no Dart SDK …", tom_specs irfmt1) is
 *        `formatterUnavailable`, its error naming TOM_DART / PATH, with the note and `dartSdk: null`; an older irspecs'
 *        "dart format failed: Could not find an option" too; a missing binary is `binaryMissing` with `help` and `page`
 *   CM-4 the real bundled irspecs (when this platform has one): a unit on ts-shared is mapped without a Dart SDK
 *   CM-5 registration (a writer, approval-gated), the runbook, the csgen31 text and the workflow name the tool;
 *        irspecs is one of the Dart binaries the window reports, built by codespecs:build with its stamp
 *   CM-6 the SDK the window knows goes to a dart-tom run as TOM_DART (vscimpb114): the plan and the answer name it
 *        (`dartSdk`), a run of another mapper gets no environment of its own
 *   CM-7 the real bundled irspecs (when this platform has one and the host a Dart SDK): a dart-tom unit maps
 *        formatted with TOM_DART — `dart format --set-exit-if-changed` changes nothing in what it wrote
 *   CM-8 the real bundled irspecs without any Dart SDK (none known, none on PATH): the unit's files are written
 *        unformatted, the run is `formatterUnavailable` and its error names TOM_DART and PATH
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
import { DART_BINARIES, DART_BINARY_FEATURE, DartBinaryMissing, currentDartBinary, runDartBinary } from '../../services/dartBinariesStatus.js';
import type { SpecToolDeps } from '../spec-tool-common.js';
import { CODESPECS_MAP_TOOL, FORMATTER_NOTE, codeSpecsMapImpl, setDartSdkResolverForTest, setIrspecsRunnerForTest } from '../codespecs-map-tools.js';
import { findDartSdk } from '../../services/dartSdk.js';
import { execFileSync } from 'child_process';
import { AVAILABLE_LLM_TOOLS } from '../../utils/constants.js';
import { CATEGORY_MAP } from '../../utils/toolCategories.js';

const EXT_ROOT = path.resolve(__dirname, '..', '..', '..');
const FIXTURE_IR = path.join(EXT_ROOT, 'src', 'tools', '__tests__', 'fixtures', 'phase4', 'codespec', 'irspecs');
const AI_BUILD = path.resolve(EXT_ROOT, '..', '..', 'ai_build');
const MERIDIAN_YAML = fs.readFileSync(path.join(AI_BUILD, 'tom_som_dart_v0', 'documents', 'meridian_order_management.docspecs.yaml'), 'utf8');

const ws = fs.realpathSync(fs.mkdtempSync(path.join(EXT_ROOT, '..', '..', '..', 'ztmp', 'vscode_extension_261114_vscimpb99_map-')));
after(() => { setIrspecsRunnerForTest(undefined); setDartSdkResolverForTest(undefined); fs.rmSync(ws, { recursive: true, force: true }); });
/** This host's Dart SDK, found as the window finds it (without the Dart extension's settings). */
const HOST_SDK = findDartSdk({ settings: {} });
const NO_SDK_STDERR = 'the 4 Dart file(s) were written unformatted: no Dart SDK to run `dart format` with. Set TOM_DART to the `dart` executable (or the SDK folder), or put `dart` on PATH.';
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
        assert.equal(plan.runs[0].command, `irspecs map --mapper dart-tom --ir run/irspecs --spec ${FILE} --unit meridian_codespec_shared --out run/mapped`);
        assert.equal(plan.note, FORMATTER_NOTE);
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
        setIrspecsRunnerForTest(async (args) => {
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
        setIrspecsRunnerForTest(async () => ({ exitCode: 0, stdout: 'ok', stderr: '' }));
        assert.equal((await call({ file: FILE, out: 'run/mapped' })).ok, true);
    });

    test('CM-3: no Dart SDK to format with; a missing binary', async () => {
        setDartSdkResolverForTest(() => undefined);
        setIrspecsRunnerForTest(async () => ({ exitCode: 1, stdout: '', stderr: NO_SDK_STDERR }));
        const r = await call({ file: FILE, out: 'run/mapped', unit: 'meridian_codespec_server' });
        assert.equal(r.ok, false);
        assert.equal(r.formatterUnavailable, true);
        assert.equal(r.dartSdk, null, 'no SDK known');
        assert.equal(r.runs[0].formatterUnavailable, true);
        assert.equal(r.runs[0].error, NO_SDK_STDERR, 'its text, naming TOM_DART / PATH');
        assert.equal(r.note, FORMATTER_NOTE);
        assert.match(FORMATTER_NOTE, /A Dart SDK is a prerequisite of the Dart \+ Tom mapper/);
        setIrspecsRunnerForTest(async () => ({ exitCode: 1, stdout: '', stderr: 'dart format failed: Could not find an option named "--output".\nUsage: …' }));
        const old = await call({ file: FILE, out: 'run/mapped', unit: 'meridian_codespec_server' });
        assert.equal(old.runs[0].formatterUnavailable, true, 'an irspecs from before irfmt1');
        assert.match(old.runs[0].error, /rebuild it: npm run codespecs:build\)\. Set TOM_DART .* or put `dart` on PATH/);
        setDartSdkResolverForTest(undefined);
        setIrspecsRunnerForTest(async () => { throw new DartBinaryMissing('irspecs', '/x/bin/darwin-arm64/irspecs'); });
        const missing = await call({ file: FILE, out: 'run/mapped' });
        assert.deepEqual([missing.ok, missing.outcome, missing.expected], [false, 'binaryMissing', '/x/bin/darwin-arm64/irspecs']);
        assert.ok(missing.help && missing.page, 'how to get it');
        setIrspecsRunnerForTest(undefined);
    });

    test('CM-4: the bundled irspecs maps a ts-shared unit without a Dart SDK', { skip: currentDartBinary('irspecs', EXT_ROOT).path ? false : 'no irspecs for this platform' }, async () => {
        // The shared unit on the TypeScript mapper (no `dart format`); the run's PATH holds no Dart SDK.
        fs.writeFileSync(path.join(ws, 'run', 'ts.docspecs.yaml'), MERIDIAN_YAML.replace(/(unitId: \|2-\n\s+meridian_codespec_shared[\s\S]*?mapping: \|2-\n\s+)dart-tom/, '$1ts-shared'));
        const pathBefore = process.env.PATH;
        process.env.PATH = '/usr/bin:/bin';
        try {
            setIrspecsRunnerForTest((args) => runDartBinary('irspecs', args, { timeoutMs: 120_000, extensionRoot: EXT_ROOT }));
            const plan = await call({ file: 'run/ts.docspecs.yaml', out: 'run/ts-out', unit: 'meridian_codespec_shared', dryRun: true });
            assert.ok(plan.runs.some((r: Json) => r.mapper === 'ts-shared'), JSON.stringify(plan.runs));
            const r = await call({ file: 'run/ts.docspecs.yaml', out: 'run/ts-out', unit: 'meridian_codespec_shared' });
            const ts = r.runs.find((x: Json) => x.mapper === 'ts-shared');
            assert.equal(ts.exitCode, 0, JSON.stringify(ts));
            assert.match(ts.written, /file\(s\) written/);
        } finally {
            process.env.PATH = pathBefore;
            setIrspecsRunnerForTest(undefined);
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
        assert.ok((DART_BINARIES as readonly string[]).includes('irspecs'));
        assert.equal(DART_BINARY_FEATURE.irspecs, 'CodeSpecs mapping');
        assert.match(src('scripts/codespecs-binary-stamp.cjs'), /const CLITOOL_BINARIES = \['validate_codespecs', 'spec_checks', 'irspecs'\];/);
        assert.match(src('scripts/check-vsix-contents.cjs'), /'irspecs'\]/);
        assert.match(src('scripts/vsix-release.cjs'), /'irspecs'\]/);
    });

    test('CM-6: the SDK goes to a dart-tom run as TOM_DART', async () => {
        setDartSdkResolverForTest(() => ({ dart: '/sdk/bin/dart', via: 'dart.sdkPath' }));
        const envs: Array<NodeJS.ProcessEnv | undefined> = [];
        setIrspecsRunnerForTest(async (_args, env) => { envs.push(env); return { exitCode: 0, stdout: '4 file(s) written and formatted.', stderr: '' }; });
        try {
            const plan = await call({ file: FILE, out: 'run/mapped', dryRun: true });
            assert.deepEqual(plan.dartSdk, { dart: '/sdk/bin/dart', via: 'dart.sdkPath' }, 'the plan names it');
            const r = await call({ file: FILE, out: 'run/mapped', unit: 'meridian_codespec_shared' });
            assert.equal(r.ok, true);
            assert.deepEqual(r.dartSdk, { dart: '/sdk/bin/dart', via: 'dart.sdkPath' });
            assert.equal(envs[0]?.TOM_DART, '/sdk/bin/dart');
            assert.equal(envs[0]?.PATH, process.env.PATH, 'the rest of the environment kept');
            fs.writeFileSync(path.join(ws, 'run', 'ts6.docspecs.yaml'), MERIDIAN_YAML.replace(/(unitId: \|2-\n\s+meridian_codespec_shared[\s\S]*?mapping: \|2-\n\s+)dart-tom/, '$1ts-shared'));
            envs.length = 0;
            const ts = await call({ file: 'run/ts6.docspecs.yaml', out: 'run/mapped', unit: 'meridian_codespec_shared' });
            const tsIndex = ts.runs.findIndex((x: Json) => x.mapper === 'ts-shared');
            assert.equal(envs[tsIndex], undefined, 'another mapper gets no environment of its own');
        } finally {
            setIrspecsRunnerForTest(undefined);
            setDartSdkResolverForTest(undefined);
        }
    });

    test('CM-7: the bundled irspecs maps a dart-tom unit formatted with TOM_DART', {
        skip: !currentDartBinary('irspecs', EXT_ROOT).path ? 'no irspecs for this platform' : !HOST_SDK ? 'no Dart SDK on this host' : false,
    }, async () => {
        const pathBefore = process.env.PATH;
        process.env.PATH = '/usr/bin:/bin';
        setDartSdkResolverForTest(() => HOST_SDK);
        setIrspecsRunnerForTest((args, env) => runDartBinary('irspecs', args, { timeoutMs: 300_000, extensionRoot: EXT_ROOT, ...(env ? { env } : {}) }));
        try {
            // The server unit (the fixture's IR writes its four files; the shared unit's areas have none).
            const r = await call({ file: FILE, out: 'run/dart-out', unit: 'meridian_codespec_server' });
            assert.equal(r.ok, true, JSON.stringify(r));
            assert.equal(r.runs[0].written, '4 file(s) written and formatted.');
            const out = path.join(ws, 'run', 'dart-out', 'meridian_codespec_server');
            // What it wrote is in `dart format`'s layout: formatting it again changes nothing ...
            execFileSync(HOST_SDK!.dart, ['format', '--output=none', '--set-exit-if-changed', out], { stdio: 'pipe' });
            // ... and byte-equal to the committed trio's server package.
            const committed = path.join(EXT_ROOT, 'src', 'tools', '__tests__', 'fixtures', 'phase4', 'codespec', 'server');
            for (const rel of ['lib/src/data_access/customer.dart', 'lib/src/data_access/order.dart', 'lib/src/services/customer_service.dart', 'lib/src/services/order_service.dart']) {
                assert.equal(fs.readFileSync(path.join(out, rel), 'utf8'), fs.readFileSync(path.join(committed, rel), 'utf8'), rel);
            }
        } finally {
            process.env.PATH = pathBefore;
            setIrspecsRunnerForTest(undefined);
            setDartSdkResolverForTest(undefined);
        }
    });

    test('CM-8: the bundled irspecs without a Dart SDK names TOM_DART / PATH', { skip: currentDartBinary('irspecs', EXT_ROOT).path ? false : 'no irspecs for this platform' }, async () => {
        const pathBefore = process.env.PATH;
        const tomDartBefore = process.env.TOM_DART;
        process.env.PATH = '/usr/bin:/bin';
        delete process.env.TOM_DART;
        setDartSdkResolverForTest(() => undefined);
        setIrspecsRunnerForTest((args, env) => runDartBinary('irspecs', args, { timeoutMs: 300_000, extensionRoot: EXT_ROOT, ...(env ? { env } : {}) }));
        try {
            const r = await call({ file: FILE, out: 'run/nosdk-out', unit: 'meridian_codespec_server' });
            assert.equal(r.ok, false);
            assert.equal(r.formatterUnavailable, true, JSON.stringify(r));
            assert.match(r.runs[0].error, /^the 4 Dart file\(s\) were written unformatted: no Dart SDK to run `dart format` with\. Set TOM_DART to the `dart` executable \(or the SDK folder\), or put `dart` on PATH\./);
            assert.ok(fs.readdirSync(path.join(ws, 'run', 'nosdk-out')).length > 0, 'the files are written');
        } finally {
            process.env.PATH = pathBefore;
            if (tomDartBefore !== undefined) { process.env.TOM_DART = tomDartBefore; }
            setIrspecsRunnerForTest(undefined);
            setDartSdkResolverForTest(undefined);
        }
    });
});
