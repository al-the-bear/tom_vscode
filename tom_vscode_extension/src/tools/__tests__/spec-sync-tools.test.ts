/**
 * The TomSpecs document-set tools (src/tools/spec-sync-tools.ts): tomAi_specSyncReport over `tomspecs
 * :spec-sync-report --json`, with a runner standing in for the binary (SY-1 … SY-7) and the real one (SY-8);
 * the shared staging helper (src/tools/spec-staging.ts) and the JSON reader (src/services/spec-checks.ts).
 *
 *   SY-1 the JSON reader: exit 0 / 1 with the report, exit 2 with `{"refused": …}` a refused set, exit 2 otherwise
 *        a usage error, `Unknown command:` an outdated binary, any other exit (a crash) or no JSON a failure
 *   SY-2 the set: `files` as given, or `specRoot` — the `*.tomspecs.yaml` / `*.docspecs.yaml` directly in
 *        phase2_solution_blueprint/ and phase3_detailed_specifications/, never in their step folders; neither or
 *        both refused; a spec root without documents refused; two files of one name refused
 *   SY-3 the run: on copies in ztmp/ (removed afterwards) named as the files, `--pairs` and `--json` passed; the
 *        answer: documents with name, file, root, revision (the staged text's), model version and dirty; the
 *        counts and lists as objects; each finding with its message when the JSON has one
 *   SY-4 filters and paging: `codes`, `resolutions`, `includeInfo: false` narrow the listed findings, the counts
 *        cover the whole set; `limit` / `offset` page them (`truncated`, `nextOffset`)
 *   SY-5 refusals: `binaryMissing` (with help), `binaryOutdated`, `setRefused` (the documents as files),
 *        `usageError`, `timedOut`, a crash (`failed`, the copies' paths named as the files)
 *   SY-6 `output`: the full report (every finding, unfiltered) written to the file; refused when it is dirty in an
 *        editor, before anything runs
 *   SY-7 registration (read-only, no approval, selectable, in the TomSpecs category) and doc/llm_tools.md
 *   SY-8 the real binary on one shipped document: the link check of one document, every root not started
 */

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import test, { after, describe } from 'node:test';
import assert from 'node:assert/strict';

import { installVscodeStub } from './_vscode-stub.js';
installVscodeStub({});

import { withTiming } from './_timing.js';
import { SomModelService } from '../../services/som-model-service.js';
import { SomDocumentStore, nodeSomDocumentIo } from '../../services/som-document-store.js';
import { BinaryRunTimedOut, DartBinaryMissing, binaryFileName, runDartBinary, setDartBinariesExtensionRoot, type BinaryRun } from '../../services/dartBinariesStatus.js';
import { readSpecJsonRun, SPEC_CHECKS_TIMEOUT_MS } from '../../services/spec-checks.js';
import { SPEC_COMMANDS } from '../../services/tomspecsCalls.js';
import { getCurrentPlatform } from '../../utils/executableResolver.js';
import { AVAILABLE_LLM_TOOLS } from '../../utils/constants.js';
import { CATEGORY_MAP } from '../../utils/toolCategories.js';
import { SPEC_SYNC_TOOLS, specSyncReportImpl, type SpecSyncDeps, type SpecSyncRunner } from '../spec-sync-tools.js';
import { ALL_SHARED_TOOLS, READ_ONLY_TOOLS } from '../tool-executors.js';

const EXT = path.join(__dirname, '..', '..', '..');
setDartBinariesExtensionRoot(EXT);
const AI_BUILD = path.resolve(EXT, '..', '..', 'ai_build');
const SAMPLE = path.join(AI_BUILD, 'tom_som_conformance', 'samples', 'uam_access_hub.tomspecs.yaml');
const BINARY = path.join(EXT, 'bin', getCurrentPlatform(), binaryFileName('tomspecs'));

const ws = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'spec-sync-')));
after(() => fs.rmSync(ws, { recursive: true, force: true }));
const dirty = new Set<string>();
const deps = (runSync: SpecSyncRunner): SpecSyncDeps => ({
    wsRoot: ws,
    store: new SomDocumentStore(SomModelService.instance, { ...nodeSomDocumentIo, isDirty: (p) => dirty.has(path.resolve(p)) }),
    service: SomModelService.instance,
    runSync,
});
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Json = any;
const parse = async (p: Promise<string>): Promise<Json> => JSON.parse(await p);
const put = (rel: string, text: string): string => { const p = path.join(ws, rel); fs.mkdirSync(path.dirname(p), { recursive: true }); fs.writeFileSync(p, text); return p; };

const SBP = 'version: 2\ndocument:\n  SBP D00SolutionBlueprint:\n    content: The Blueprint.\n';
const RSP = 'version: 2\ndocument:\n  RSP D04RequirementsSpecification:\n    content: The requirements.\n';

/** A spec root: the documents of record, a step folder's copies, a rendition beside, a stray file. */
function specRoot(): string {
    put('uam/tom_specs/phase2_solution_blueprint/tom_uam.sbp.tomspecs.yaml', SBP);
    put('uam/tom_specs/phase2_solution_blueprint/tom_uam.sbp.tomspecs.md', '# rendition\n');
    put('uam/tom_specs/phase2_solution_blueprint/01_Initial Version/tom_uam.sbp.docspecs.yaml', SBP);
    put('uam/tom_specs/phase2_solution_blueprint/README.md', '# readme\n');
    put('uam/tom_specs/phase3_detailed_specifications/tom_uam.rsp.tomspecs.yaml', RSP);
    put('uam/tom_specs/phase3_detailed_specifications/W2_05_Result/tom_uam.rsp.tomspecs.yaml', RSP);
    return 'uam/tom_specs';
}

const finding = (code: string, resolution: string, info = false, message?: string): Json => ({
    code, pair: 'FR', blueprint: { document: 'tom_uam.sbp.tomspecs.yaml', root: 'SBP', path: `SBP/x/${code}`, pendingMarks: false },
    detail: { document: 'tom_uam.rsp.tomspecs.yaml', root: 'RSP', path: `RSP/y/${code}`, pendingMarks: false },
    holder: 'detail', resolution, info, ...(message ? { message } : {}),
});
const REPORT = {
    findings: [finding('valueDiffers', 'backfill'), finding('elementMissing', 'agent', false, 'add it'), finding('derivedSummary', 'info', true), finding('valueDiffers', 'agent')],
    documentFindings: [['tom_uam.sbp.tomspecs.yaml', [{ path: 'SBP/a', code: 'inverseMissing' }]], ['tom_uam.rsp.tomspecs.yaml', []]],
    notStarted: ['D05InteractionScenarios'], notStartedPairs: ['UC'],
    countsByCode: [['valueDiffers', 2], ['elementMissing', 1], ['derivedSummary', 1]],
    countsByResolution: [['backfill', 1], ['agent', 2], ['info', 1]],
    clean: false,
};

/** A runner that records its calls and answers `answer`; it also checks the copies exist while it runs. */
function recorder(answer: (args: string[]) => BinaryRun | Promise<BinaryRun>): { runner: SpecSyncRunner; calls: Array<{ command: string; args: string[]; copies: string[] }> } {
    const calls: Array<{ command: string; args: string[]; copies: string[] }> = [];
    return {
        calls,
        runner: async (command, args) => {
            const copies = args.filter((a) => a.endsWith('.yaml') || a.endsWith('.md'));
            for (const c of copies) { assert.ok(fs.existsSync(c), `the copy ${c} exists while the command runs`); }
            calls.push({ command, args, copies });
            return answer(args);
        },
    };
}
const ok = (report: unknown = REPORT, exitCode = 1): BinaryRun => ({ exitCode, stdout: `${JSON.stringify(report)}\n`, stderr: '' });

describe('TomSpecs document-set tools', () => {
    test('SY-1: the JSON reader', () => {
        const read = (exitCode: number, stdout: string, stderr = '') => readSpecJsonRun('sync-report', { exitCode, stdout, stderr });
        assert.deepEqual([read(0, '{"clean":true}\n').outcome, read(0, '{"clean":true}\n').json], ['clean', { clean: true }]);
        assert.equal(read(1, 'noise\n{"clean":false}\n').outcome, 'findings', 'the last JSON line');
        const refused = read(2, '{"refused":{"refusal":"noBlueprint","documents":["a.yaml"]}}\n', 'refused: no Blueprint');
        assert.deepEqual([refused.outcome, refused.refused], ['refused', { refusal: 'noBlueprint', documents: ['a.yaml'] }]);
        assert.equal(read(2, '', 'error: Could not find an option named "--nope".').outcome, 'usageError');
        assert.equal(read(2, '', 'Unknown command: :spec-sync-report').outcome, 'binaryOutdated');
        assert.equal(read(255, '', 'Unhandled exception:\nRangeError').outcome, 'failed');
        assert.equal(read(0, 'not json\n').outcome, 'failed', 'no JSON where one is due');
        assert.equal(SPEC_COMMANDS['sync-report'], ':spec-sync-report');
    });

    test('SY-2: the set', async () => {
        const root = specRoot();
        const r = recorder(() => ok());
        const answer = await parse(specSyncReportImpl(deps(r.runner), { specRoot: root }));
        assert.equal(answer.ok, true);
        assert.deepEqual(answer.documents.map((d: Json) => d.file), [
            'uam/tom_specs/phase2_solution_blueprint/tom_uam.sbp.tomspecs.yaml',
            'uam/tom_specs/phase3_detailed_specifications/tom_uam.rsp.tomspecs.yaml',
        ], 'directly in the phase folders: no step folder, no rendition, no other file');
        const files = await parse(specSyncReportImpl(deps(r.runner), { files: [`${root}/phase3_detailed_specifications/tom_uam.rsp.tomspecs.yaml`] }));
        assert.deepEqual(files.documents.map((d: Json) => d.name), ['tom_uam.rsp.tomspecs.yaml']);
        for (const input of [{}, { files: [] }, { files: ['a.yaml'], specRoot: root }]) {
            assert.equal((await parse(specSyncReportImpl(deps(r.runner), input))).code, 'usageError', JSON.stringify(input));
        }
        put('empty/phase2_solution_blueprint/01_Initial Version/x.tomspecs.yaml', SBP);
        const empty = await parse(specSyncReportImpl(deps(r.runner), { specRoot: 'empty' }));
        assert.equal(empty.code, 'usageError');
        assert.match(empty.error, /directly in phase2_solution_blueprint or phase3_detailed_specifications/);
        put('twice/a/same.tomspecs.yaml', SBP);
        put('twice/b/same.tomspecs.yaml', RSP);
        const twice = await parse(specSyncReportImpl(deps(r.runner), { files: ['twice/a/same.tomspecs.yaml', 'twice/b/same.tomspecs.yaml'] }));
        assert.match(twice.error, /file name same\.tomspecs\.yaml/);
        assert.equal(r.calls.length, 2, 'refused before anything ran');
        assert.equal((await parse(specSyncReportImpl(deps(r.runner), { files: ['../outside.tomspecs.yaml'] }))).ok, false, 'outside the workspace');
    });

    test('SY-3: the run and the answer', async () => {
        const root = specRoot();
        const sbp = path.join(ws, root, 'phase2_solution_blueprint/tom_uam.sbp.tomspecs.yaml');
        dirty.add(sbp);
        try {
            const r = recorder(() => ok());
            const answer = await withTiming('tomAi_specSyncReport:typical', () => parse(specSyncReportImpl(deps(r.runner), { specRoot: root, pairs: ['FR', ' OR '] })));
            const call = r.calls[0];
            assert.equal(call.command, 'sync-report');
            assert.deepEqual(call.args.slice(-3), ['--pairs', 'FR,OR', '--json']);
            assert.deepEqual(call.copies.map((c) => path.basename(c)), ['tom_uam.sbp.tomspecs.yaml', 'tom_uam.rsp.tomspecs.yaml'], 'copies named as the files');
            assert.ok(call.copies.every((c) => c.startsWith(path.join(ws, 'ztmp') + path.sep)), 'in ztmp/');
            assert.ok(call.copies.every((c) => !fs.existsSync(c)), 'removed afterwards');
            assert.deepEqual(fs.readdirSync(path.join(ws, 'ztmp')), [], 'no scratch folder left');
            const store = deps(r.runner).store;
            assert.deepEqual(answer.documents, [
                { name: 'tom_uam.sbp.tomspecs.yaml', file: `${root}/phase2_solution_blueprint/tom_uam.sbp.tomspecs.yaml`, root: 'SBP', revision: store.readText(sbp).revision, modelVersion: null, dirty: true },
                { name: 'tom_uam.rsp.tomspecs.yaml', file: `${root}/phase3_detailed_specifications/tom_uam.rsp.tomspecs.yaml`, root: 'RSP', revision: store.readText(path.join(ws, root, 'phase3_detailed_specifications/tom_uam.rsp.tomspecs.yaml')).revision, modelVersion: null, dirty: false },
            ]);
            assert.equal(answer.clean, false);
            assert.deepEqual(answer.notStarted, ['D05InteractionScenarios']);
            assert.deepEqual(answer.notStartedPairs, ['UC']);
            assert.deepEqual(answer.countsByCode, { valueDiffers: 2, elementMissing: 1, derivedSummary: 1 });
            assert.deepEqual(answer.countsByResolution, { backfill: 1, agent: 2, info: 1 });
            assert.equal(answer.findingCount, 4);
            // eslint-disable-next-line @typescript-eslint/naming-convention -- keyed by the documents' file names
            assert.deepEqual(answer.documentFindings, { 'tom_uam.sbp.tomspecs.yaml': [{ path: 'SBP/a', code: 'inverseMissing' }], 'tom_uam.rsp.tomspecs.yaml': [] });
            assert.equal(answer.findings[1].message, 'add it', 'a message is passed through');
            assert.equal('message' in answer.findings[0], false, 'none invented');
            assert.deepEqual(answer.findings[2], finding('derivedSummary', 'info', true));
            assert.deepEqual([answer.truncated, answer.nextOffset], [false, null]);
        } finally { dirty.delete(sbp); }
    });

    test('SY-4: filters and paging', async () => {
        const root = specRoot();
        const run = (input: Json) => parse(specSyncReportImpl(deps(recorder(() => ok()).runner), { specRoot: root, ...input }));
        const codes = await run({ codes: ['valueDiffers'] });
        assert.deepEqual(codes.findings.map((f: Json) => f.resolution), ['backfill', 'agent']);
        assert.deepEqual([codes.findingCount, codes.matchedCount], [4, 2], 'the counts cover the whole set');
        assert.deepEqual(codes.countsByCode, { valueDiffers: 2, elementMissing: 1, derivedSummary: 1 });
        assert.deepEqual((await run({ resolutions: ['agent'] })).findings.map((f: Json) => f.code), ['elementMissing', 'valueDiffers']);
        assert.equal((await run({ includeInfo: false })).findings.some((f: Json) => f.info), false);
        assert.equal((await run({})).findings.filter((f: Json) => f.info).length, 1, 'info listed by default');
        const first = await run({ limit: 3 });
        assert.deepEqual([first.findings.length, first.truncated, first.nextOffset], [3, true, 3]);
        const next = await run({ limit: 3, offset: first.nextOffset });
        assert.deepEqual([next.findings.map((f: Json) => f.code), next.truncated, next.nextOffset], [['valueDiffers'], false, null]);
    });

    test('SY-5: refusals', async () => {
        const root = specRoot();
        const answer = (run: SpecSyncRunner) => parse(specSyncReportImpl(deps(run), { specRoot: root }));
        const missing = await answer(async () => { throw new DartBinaryMissing('tomspecs', '/ext/bin/x/tomspecs'); });
        assert.deepEqual([missing.ok, missing.code, missing.expected], [false, 'binaryMissing', '/ext/bin/x/tomspecs']);
        assert.ok(missing.help && missing.page, 'with the help');
        const outdated = await answer(async () => ({ exitCode: 2, stdout: '', stderr: 'Unknown command: :spec-sync-report\n' }));
        assert.equal(outdated.code, 'binaryOutdated');
        assert.match(outdated.error, /rebuild the extension's binaries[\s\S]*reload the window/);
        const refused = await answer(async (_c, args) => ({
            exitCode: 2, stdout: `${JSON.stringify({ refused: { refusal: 'twoDocumentsOneRoot', documents: args.filter((a) => a.endsWith('.yaml')).map((a) => path.basename(a)) } })}\n`, stderr: 'refused: two documents of one root\n',
        }));
        assert.deepEqual([refused.code, refused.refusal], ['setRefused', 'twoDocumentsOneRoot']);
        assert.deepEqual(refused.documents, [`${root}/phase2_solution_blueprint/tom_uam.sbp.tomspecs.yaml`, `${root}/phase3_detailed_specifications/tom_uam.rsp.tomspecs.yaml`], 'the documents as files');
        const usage = await answer(async () => ({ exitCode: 2, stdout: '', stderr: 'error: unknown pair XX\n' }));
        assert.deepEqual([usage.code, usage.error], ['usageError', 'error: unknown pair XX']);
        const timed = await answer(async () => { throw new BinaryRunTimedOut('tomspecs', SPEC_CHECKS_TIMEOUT_MS); });
        assert.deepEqual([timed.code, timed.timeoutMs], ['timedOut', SPEC_CHECKS_TIMEOUT_MS]);
        const crashed = await answer(async (_c, args) => ({ exitCode: 255, stdout: '', stderr: `Unhandled exception reading ${args[0]}\nRangeError` }));
        assert.equal(crashed.code, 'failed');
        assert.match(crashed.error, new RegExp(`reading ${root}/phase2_solution_blueprint/tom_uam\\.sbp\\.tomspecs\\.yaml\\nRangeError`), 'the copy named as its file');
        assert.deepEqual(fs.readdirSync(path.join(ws, 'ztmp')), [], 'the scratch folder removed after a failure too');
    });

    test('SY-6: output', async () => {
        const root = specRoot();
        const answer = await parse(specSyncReportImpl(deps(recorder(() => ok()).runner), { specRoot: root, output: 'evidence/G3/sync.json', codes: ['elementMissing'], limit: 1 }));
        assert.equal(answer.output, 'evidence/G3/sync.json');
        const full = JSON.parse(fs.readFileSync(path.join(ws, 'evidence/G3/sync.json'), 'utf8'));
        assert.equal(full.findings.length, 4, 'every finding, unfiltered and unpaged');
        assert.deepEqual(full.documents.map((d: Json) => d.name), ['tom_uam.sbp.tomspecs.yaml', 'tom_uam.rsp.tomspecs.yaml']);
        // Written again over the existing file; refused while it is dirty in an editor, before anything runs.
        await parse(specSyncReportImpl(deps(recorder(() => ok({ ...REPORT, findings: [] }, 0)).runner), { specRoot: root, output: 'evidence/G3/sync.json' }));
        assert.equal(JSON.parse(fs.readFileSync(path.join(ws, 'evidence/G3/sync.json'), 'utf8')).findings.length, 0);
        const out = path.join(ws, 'evidence/G3/sync.json');
        dirty.add(out);
        try {
            const r = recorder(() => ok());
            const refused = await parse(specSyncReportImpl(deps(r.runner), { specRoot: root, output: 'evidence/G3/sync.json' }));
            assert.equal(refused.code, 'dirtyInEditor');
            assert.equal(r.calls.length, 0);
        } finally { dirty.delete(out); }
    });

    test('SY-7: registration and documentation', () => {
        assert.deepEqual(SPEC_SYNC_TOOLS.map((t) => t.name), ['tomAi_specSyncReport']);
        const tool = ALL_SHARED_TOOLS.find((t) => t.name === 'tomAi_specSyncReport');
        assert.ok(tool, 'registered');
        assert.equal(tool!.readOnly, true);
        assert.notEqual(tool!.requiresApproval, true);
        assert.ok(READ_ONLY_TOOLS.some((t) => t.name === 'tomAi_specSyncReport'), 'on the read-only floor');
        assert.ok((AVAILABLE_LLM_TOOLS as readonly string[]).includes('tomAi_specSyncReport'), 'selectable');
        assert.ok(CATEGORY_MAP['TomSpecs'].includes('tomAi_specSyncReport'), 'in the TomSpecs picker category');
        assert.match(fs.readFileSync(path.join(EXT, 'src', 'tools', 'tool-executors.ts'), 'utf8'), /\.\.\.SPEC_SYNC_TOOLS,/);
        const doc = fs.readFileSync(path.join(EXT, 'doc', 'llm_tools.md'), 'utf8');
        assert.match(doc, /### 4\.23b TomSpecs document set \(`spec_checks`\)/);
        assert.match(doc, /\| `tomAi_specSyncReport` \|/, 'a row in the section');
        assert.match(doc, /### `tomAi_specSyncReport`/, 'a section of its own for tomAi_describeTool');
    });

    test('SY-8: the real binary on one shipped document', { skip: !fs.existsSync(BINARY) ? `no tomspecs at ${BINARY}` : !fs.existsSync(SAMPLE) ? `no ${SAMPLE}` : false }, async () => {
        put('real/uam_access_hub.tomspecs.yaml', fs.readFileSync(SAMPLE, 'utf8'));
        const real: SpecSyncRunner = (command, args) => runDartBinary('tomspecs', [SPEC_COMMANDS[command], ...args], { timeoutMs: SPEC_CHECKS_TIMEOUT_MS });
        const answer = await parse(specSyncReportImpl(deps(real), { files: ['real/uam_access_hub.tomspecs.yaml'] }));
        assert.equal(answer.ok, true, JSON.stringify(answer).slice(0, 400));
        assert.deepEqual(answer.documents.map((d: Json) => [d.name, d.root]), [['uam_access_hub.tomspecs.yaml', 'SBP']]);
        assert.ok(answer.notStarted.length > 0, 'one document: every Phase 3 root not started');
        assert.ok(Array.isArray(answer.documentFindings['uam_access_hub.tomspecs.yaml']), 'its own findings, by name');
    });
});
