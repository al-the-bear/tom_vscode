/**
 * tomAi_specCodeSpecsMap (vscimpb99): Phase 4's stage 5 through the bundled irspecs, on a copy of the Meridian
 * sample (its generation-unit register) with the phase-4 fixture's IR.
 *
 *   CM-1 dryRun: one run per unit and mapper (the unit's areas grouped by mapper), the commands with
 *        workspace-relative paths, the dart-tom note; `unit` narrows to one unit; an unknown unit and a missing IR
 *        folder are refused
 *   CM-2 the runs: the arguments irspecs gets (`map --mapper --ir --spec --unit --out`), ok when every run exits 0,
 *        a failing run's error kept
 *   CM-3 a dart-tom run the compiled binary cannot format (`dart format failed`) is `formatterUnavailable`, with
 *        the note; a missing binary is `binaryMissing` with `help` and `page`
 *   CM-4 the real bundled irspecs (when this platform has one): a unit on ts-shared is mapped without a Dart SDK
 *   CM-5 registration (a writer, approval-gated), the runbook, the csgen31 text and the workflow name the tool;
 *        irspecs is one of the Dart binaries the window reports, built by codespecs:build with its stamp
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
import { CODESPECS_MAP_TOOL, FORMATTER_NOTE, codeSpecsMapImpl, setIrspecsRunnerForTest } from '../codespecs-map-tools.js';
import { AVAILABLE_LLM_TOOLS } from '../../utils/constants.js';
import { CATEGORY_MAP } from '../../utils/toolCategories.js';

const EXT_ROOT = path.resolve(__dirname, '..', '..', '..');
const FIXTURE_IR = path.join(EXT_ROOT, 'src', 'tools', '__tests__', 'fixtures', 'phase4', 'codespec', 'irspecs');
const AI_BUILD = path.resolve(EXT_ROOT, '..', '..', 'ai_build');
const MERIDIAN_YAML = fs.readFileSync(path.join(AI_BUILD, 'tom_som_dart_v0', 'documents', 'meridian_order_management.docspecs.yaml'), 'utf8');

const ws = fs.realpathSync(fs.mkdtempSync(path.join(EXT_ROOT, '..', '..', '..', 'ztmp', 'vscode_extension_261114_vscimpb99_map-')));
after(() => { setIrspecsRunnerForTest(undefined); fs.rmSync(ws, { recursive: true, force: true }); });
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

    test('CM-3: the formatter a compiled binary lacks; a missing binary', async () => {
        setIrspecsRunnerForTest(async () => ({ exitCode: 1, stdout: '', stderr: 'dart format failed: Could not find an option named "--output".\nUsage: …' }));
        const r = await call({ file: FILE, out: 'run/mapped', unit: 'meridian_codespec_server' });
        assert.equal(r.ok, false);
        assert.equal(r.formatterUnavailable, true);
        assert.equal(r.runs[0].formatterUnavailable, true);
        assert.match(r.runs[0].error, /files were written but not formatted/);
        assert.equal(r.note, FORMATTER_NOTE);
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
});
