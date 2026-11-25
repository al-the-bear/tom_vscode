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
 *
 * The writes (tomAi_specBackfill, tomAi_specPrefill, tomAi_specDeriveFields, tomAi_specRenameId): SW-1 … SW-7 below.
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
import {
    SPEC_SYNC_TOOLS, currentStepFolder, prefillTargetName, specBackfillImpl, specDeriveFieldsImpl, specPrefillImpl, specRenameIdImpl,
    specSyncReportImpl, type SpecSyncDeps, type SpecSyncRunner,
} from '../spec-sync-tools.js';
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
        assert.equal(SPEC_SYNC_TOOLS[0].name, 'tomAi_specSyncReport');
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

// ---------------------------------------------------------------------------
// The writes (part-tools sections 3–4)
// ---------------------------------------------------------------------------

/**
 *   SW-1 backfill: the Blueprint's new stage (YAML and rendition) is written into the current step folder before the
 *        document of record and its rendition move; the answer: written, revision, changes paged by `limit` with the
 *        count, left with its reason and counts by code, the stage folder; `--stage-folder` and `--json` passed
 *   SW-2 dryRun writes nothing (no stage, no record) and answers the diff, cut at 2,000 lines (`diffTruncated`,
 *        `diffLinesLeftOut`); nothing to do: `written: false`, `changeCount: 0`, no diff
 *   SW-3 the refusals of the table: setHasMarks (the places counted per document), dirtyInEditor (a read document,
 *        before anything runs), revisionConflict (`expectedRevision`, `expectedRevisions`), readOnly (a Markdown
 *        document), modelTooNew, noStageFolder, binaryOutdated, setRefused, usageError, timedOut — none writes
 *   SW-4 prefill: the default target named from the Blueprint's file name, created with its rendition; an existing
 *        target of another root `rootMismatch`; a target appearing while it is staged `exists` (not overwritten)
 *   SW-5 deriveFields: marked by default, signed `agent_<role>` and `at`; `marked: false` writes plain values, no author
 *   SW-6 renameId: every changed document staged and written, the command given `--from` / `--to` (no stage folder)
 *   SW-7 registration: the four writers need approval, are selectable and in the TomSpecs (edit) category; documented
 *   SW-8 the real binary: deriveFields as a dry run on a shipped document answers its changes and writes nothing
 */

/** A store whose writes are recorded, with what the step folders held at that moment. */
function recordingDeps(runSync: SpecSyncRunner, over: Partial<SpecSyncDeps> = {}): { deps: SpecSyncDeps; writes: Array<{ file: string; stageExisted: boolean }> } {
    const writes: Array<{ file: string; stageExisted: boolean }> = [];
    const io = {
        ...nodeSomDocumentIo,
        isDirty: (p: string) => dirty.has(path.resolve(p)),
        write: async (p: string, t: string) => {
            const step = currentStepFolder(path.dirname(p));
            writes.push({ file: path.relative(ws, p), stageExisted: !!step && fs.existsSync(path.join(step, path.basename(p))) });
            return nodeSomDocumentIo.write(p, t);
        },
    };
    return { deps: { wsRoot: ws, store: new SomDocumentStore(SomModelService.instance, io), service: SomModelService.instance, runSync, agentAuthor: () => 'agent_spec_author', ...over }, writes };
}

/** A runner playing a write command: `edit` changes the copies it names (and writes their renditions beside), then the JSON. */
function writer(edit: (copies: string[], args: string[]) => void, result: unknown, exitCode = 0): { runner: SpecSyncRunner; calls: string[][] } {
    const calls: string[][] = [];
    return {
        calls,
        runner: async (_command, args) => {
            calls.push(args);
            const copies = args.filter((a) => a.endsWith('.tomspecs.yaml') && fs.existsSync(a));
            edit(copies, args);
            return { exitCode, stdout: `${JSON.stringify(result)}\n`, stderr: '' };
        },
    };
}
const rewrite = (copy: string, text: string): void => { fs.writeFileSync(copy, text); fs.writeFileSync(copy.replace(/\.yaml$/, '.md'), `# ${path.basename(copy)}\n\n${text}`); };

/** A spec root with step folders (the last in process order: phase 2's 03_01_01, phase 3's W2_05_Result). */
function writeRoot(name: string): string {
    const root = `${name}/tom_specs`;
    put(`${root}/phase2_solution_blueprint/tom_uam.sbp.tomspecs.yaml`, SBP);
    put(`${root}/phase2_solution_blueprint/tom_uam.sbp.tomspecs.md`, '# old rendition\n');
    for (const step of ['01_Initial Version', '03_01_01_Questions Round']) { fs.mkdirSync(path.join(ws, root, 'phase2_solution_blueprint', step), { recursive: true }); }
    put(`${root}/phase3_detailed_specifications/tom_uam.rsp.tomspecs.yaml`, RSP);
    for (const step of ['03_04_04_Consistency Round', 'W2_05_Result']) { fs.mkdirSync(path.join(ws, root, 'phase3_detailed_specifications', step), { recursive: true }); }
    return root;
}
const NEW_SBP = SBP.replace('The Blueprint.', 'The Blueprint, backfilled.');
const BACKFILLED = {
    changes: [{ pair: 'FR', kind: 'value', path: 'SBP/content', old: 'The Blueprint.', new: 'The Blueprint, backfilled.' }, { pair: 'FR', kind: 'revision', path: 'SBP/DOCTL', old: null, new: '1.1' }],
    left: [{ finding: finding('crossInverseMissing', 'agent'), reason: 'agent' }],
    blueprint: { huge: true },
};

describe('TomSpecs document-set writes', () => {
    test('SW-1: backfill, staged before the record', async () => {
        const root = writeRoot('sw1');
        const w = writer((copies) => rewrite(copies.find((c) => c.includes('sbp'))!, NEW_SBP), BACKFILLED, 1);
        const { deps: d, writes } = recordingDeps(w.runner);
        const answer = await withTiming('tomAi_specBackfill:typical', () => parse(specBackfillImpl(d, { specRoot: root, pairs: ['FR'], limit: 1 })));
        assert.equal(answer.ok, true, JSON.stringify(answer));
        const sbp = `${root}/phase2_solution_blueprint/tom_uam.sbp.tomspecs.yaml`;
        const step = `${root}/phase2_solution_blueprint/03_01_01_Questions Round`;
        assert.deepEqual([answer.written, answer.file, answer.rendition], [true, sbp, sbp.replace(/\.yaml$/, '.md')]);
        assert.deepEqual(answer.stageFolders, [step], 'the last step folder in process order');
        assert.equal(fs.readFileSync(path.join(ws, sbp), 'utf8'), NEW_SBP);
        assert.equal(fs.readFileSync(path.join(ws, step, 'tom_uam.sbp.tomspecs.yaml'), 'utf8'), NEW_SBP, 'the stage in the step folder');
        assert.ok(fs.existsSync(path.join(ws, step, 'tom_uam.sbp.tomspecs.md')), 'its rendition beside it');
        assert.match(fs.readFileSync(path.join(ws, sbp.replace(/\.yaml$/, '.md')), 'utf8'), /backfilled/, 'the record\'s rendition');
        assert.deepEqual(writes.map((x) => [x.file, x.stageExisted]), [[sbp, true], [sbp.replace(/\.yaml$/, '.md'), true]], 'the stage was complete before the record moved');
        assert.equal(answer.revision, d.store.readText(path.join(ws, sbp)).revision);
        assert.deepEqual([answer.changeCount, answer.changes.length, answer.changesTruncated], [2, 1, true], 'changes paged by limit, the count complete');
        assert.deepEqual([answer.leftCount, answer.left[0].reason, answer.leftCountsByCode], [1, 'agent', { crossInverseMissing: 1 }]);
        assert.equal('blueprint' in answer, false, 'the whole document is not answered');
        const args = w.calls[0];
        assert.deepEqual([args[args.length - 5], args[args.length - 4], args[args.length - 3], args[args.length - 1]], ['--pairs', 'FR', '--stage-folder', '--json']);
        assert.ok(args[args.length - 2].startsWith(path.join(ws, 'ztmp')), 'the command stages in the scratch folder');
        assert.deepEqual(fs.readdirSync(path.join(ws, 'ztmp')), [], 'the scratch folder removed');
    });

    test('SW-2: dryRun writes nothing and answers the diff, cut at 2,000 lines', async () => {
        const root = writeRoot('sw2');
        const sbp = path.join(ws, root, 'phase2_solution_blueprint/tom_uam.sbp.tomspecs.yaml');
        const before = fs.readFileSync(sbp, 'utf8');
        const long = `${SBP}${Array.from({ length: 3000 }, (_, i) => `# line ${i}`).join('\n')}\n`;
        const w = writer((copies) => rewrite(copies.find((c) => c.includes('sbp'))!, long), BACKFILLED, 1);
        const { deps: d, writes } = recordingDeps(w.runner);
        const answer = await parse(specBackfillImpl(d, { specRoot: root, dryRun: true }));
        assert.deepEqual([answer.ok, answer.written, answer.dryRun], [true, false, true]);
        assert.equal(fs.readFileSync(sbp, 'utf8'), before, 'the record unchanged');
        assert.deepEqual(writes, [], 'nothing written through the store');
        assert.deepEqual(fs.readdirSync(path.join(ws, root, 'phase2_solution_blueprint/03_01_01_Questions Round')), [], 'no stage');
        assert.equal(answer.diff.split('\n').length, 2000);
        assert.equal(answer.diffTruncated, true);
        assert.ok(answer.diffLinesLeftOut > 1000);
        // Nothing to do: nothing written, no diff.
        const none = await parse(specBackfillImpl(recordingDeps(writer(() => undefined, { changes: [], left: [] }).runner).deps, { specRoot: root }));
        assert.deepEqual([none.ok, none.written, none.changeCount, 'diff' in none], [true, false, 0, false]);
    });

    test('SW-3: the refusals write nothing', async () => {
        const root = writeRoot('sw3');
        const sbpRel = `${root}/phase2_solution_blueprint/tom_uam.sbp.tomspecs.yaml`;
        const sbp = path.join(ws, sbpRel);
        const before = fs.readFileSync(sbp, 'utf8');
        const refused = (json: unknown, stderr = 'refused: …'): SpecSyncRunner => async () => ({ exitCode: 2, stdout: `${JSON.stringify(json)}\n`, stderr });
        const backfill = async (run: SpecSyncRunner, input: Json = {}) => parse(specBackfillImpl(recordingDeps(run).deps, { specRoot: root, ...input }));
        const marks = await backfill(refused({ refused: { code: 'setHasMarks', places: [{ document: 'tom_uam.rsp.tomspecs.yaml', path: 'RSP/a' }, { document: 'tom_uam.rsp.tomspecs.yaml', path: 'RSP/b' }] } }), { limit: 1 });
        // eslint-disable-next-line @typescript-eslint/naming-convention -- keyed by the documents' file names
        assert.deepEqual([marks.code, marks.placeCount, marks.placeCountsByDocument, marks.places.length, marks.placesTruncated], ['setHasMarks', 2, { 'tom_uam.rsp.tomspecs.yaml': 2 }, 1, true]);
        const notRun: SpecSyncRunner = async () => { throw new Error('must not run'); };
        const rsp = path.join(ws, root, 'phase3_detailed_specifications/tom_uam.rsp.tomspecs.yaml');
        dirty.add(rsp);
        try { assert.equal((await backfill(notRun)).code, 'dirtyInEditor', 'a read document dirty refuses backfill'); } finally { dirty.delete(rsp); }
        assert.equal((await backfill(notRun, { expectedRevision: 'stale' })).code, 'revisionConflict');
        assert.equal((await backfill(notRun, { expectedRevisions: { [`${root}/phase3_detailed_specifications/tom_uam.rsp.tomspecs.yaml`]: 'stale' } })).code, 'revisionConflict');
        assert.equal((await backfill(refused({ refused: { code: 'notYaml', file: 'x.tomspecs.md' } }))).code, 'readOnly');
        assert.equal((await backfill(refused({ refused: { refusal: 'twoDocumentsOneRoot', documents: ['tom_uam.sbp.tomspecs.yaml'] } }))).code, 'setRefused');
        assert.equal((await backfill(async () => ({ exitCode: 2, stdout: '', stderr: 'Unknown command: :spec-backfill' }))).code, 'binaryOutdated');
        assert.equal((await backfill(async () => ({ exitCode: 2, stdout: '', stderr: 'error: --path is outside the Blueprint' }))).code, 'usageError');
        assert.equal((await backfill(async () => { throw new BinaryRunTimedOut('tomspecs', SPEC_CHECKS_TIMEOUT_MS); })).code, 'timedOut');
        assert.equal((await backfill(refused({ refused: { code: 'verification', file: 'x' } }))).code, 'verification');
        // A newer model's document is never read.
        const [major, minor] = SomModelService.instance.modelVersion.split('.').map(Number);
        put('sw3c/tom_specs/phase2_solution_blueprint/tom_uam.sbp.tomspecs.yaml', SBP.replace('version: 2\n', `version: 2\nmodelVersion: "${major}.${minor + 1}"\n`));
        put('sw3c/tom_specs/phase3_detailed_specifications/tom_uam.rsp.tomspecs.yaml', RSP);
        const tooNew = await parse(specBackfillImpl(recordingDeps(notRun).deps, { specRoot: 'sw3c/tom_specs' }));
        assert.equal(tooNew.code, 'modelTooNew', JSON.stringify(tooNew));
        // No step folder to stage in.
        put('sw3b/tom_specs/phase2_solution_blueprint/tom_uam.sbp.tomspecs.yaml', SBP);
        put('sw3b/tom_specs/phase3_detailed_specifications/tom_uam.rsp.tomspecs.yaml', RSP);
        const noStage = await parse(specBackfillImpl(recordingDeps(writer((c) => rewrite(c.find((x) => x.includes('sbp'))!, NEW_SBP), BACKFILLED).runner).deps, { specRoot: 'sw3b/tom_specs' }));
        assert.equal(noStage.code, 'noStageFolder');
        assert.equal(fs.readFileSync(path.join(ws, 'sw3b/tom_specs/phase2_solution_blueprint/tom_uam.sbp.tomspecs.yaml'), 'utf8'), SBP);
        assert.equal(fs.readFileSync(sbp, 'utf8'), before, 'no refusal wrote');
        assert.deepEqual(fs.readdirSync(path.join(ws, root, 'phase2_solution_blueprint/03_01_01_Questions Round')), [], 'no stage either');
    });

    test('SW-4: prefill — the default target, rootMismatch, exists', async () => {
        const root = writeRoot('sw4');
        const target = `${root}/phase3_detailed_specifications/tom_uam.ats.tomspecs.yaml`;
        assert.equal(prefillTargetName('x/tom_uam.sbp.tomspecs.yaml', 'ATS'), 'tom_uam.ats.tomspecs.yaml');
        const atsType = SomModelService.instance.model.roots.find((r) => r.sectionId === 'ATS')!.type;
        const ATS = `version: 2\ndocument:\n  ATS ${atsType}:\n    content: Prefilled.\n`;
        const create = writer((_c, args) => { rewrite(args[args.indexOf('--target') + 1], ATS); }, { name: 'tom_uam.ats.tomspecs.yaml', created: true, filledPairs: ['ACC'], skippedPairs: [], derived: { changes: [{ kind: 'count' }], unresolved: [{ path: 'ATS/x', code: 'unresolved' }] }, findings: [{ path: 'ATS/y', code: 'missing' }], document: {} }, 1);
        const answer = await withTiming('tomAi_specPrefill:typical', () => parse(specPrefillImpl(recordingDeps(create.runner).deps, { specRoot: root, root: 'ATS' })));
        assert.equal(answer.ok, true, JSON.stringify(answer));
        assert.deepEqual([answer.created, answer.written, answer.file, answer.filledPairs, answer.derivedChangeCount, answer.findingCount], [true, true, target, ['ACC'], 1, 2]);
        assert.equal(fs.readFileSync(path.join(ws, target), 'utf8'), ATS);
        assert.ok(fs.existsSync(path.join(ws, root, 'phase3_detailed_specifications/W2_05_Result/tom_uam.ats.tomspecs.yaml')), 'staged in the last step folder');
        assert.ok(fs.existsSync(path.join(ws, target.replace(/\.yaml$/, '.md'))), 'its rendition');
        const args = create.calls[0];
        assert.deepEqual(args.slice(args.indexOf('--root'), args.indexOf('--root') + 2), ['--root', atsType]);
        // An existing target of another root.
        const mismatch = await parse(specPrefillImpl(recordingDeps(create.runner).deps, { specRoot: root, root: 'ATS', target: `${root}/phase3_detailed_specifications/tom_uam.rsp.tomspecs.yaml` }));
        assert.equal(mismatch.code, 'rootMismatch');
        assert.equal((await parse(specPrefillImpl(recordingDeps(create.runner).deps, { files: [`${root}/phase2_solution_blueprint/tom_uam.sbp.tomspecs.yaml`], root: 'ATS' }))).code, 'usageError', 'target required with files');
        // The target appears while it is staged: not overwritten.
        const qap = `${root}/phase3_detailed_specifications/tom_uam.qap.tomspecs.yaml`;
        const race = writer((_c, args) => { rewrite(args[args.indexOf('--target') + 1], ATS); put(qap, 'someone else\n'); }, { filledPairs: ['ACC'], skippedPairs: [], derived: {}, findings: [] });
        const exists = await parse(specPrefillImpl(recordingDeps(race.runner).deps, { specRoot: root, root: 'ATS', target: qap }));
        assert.equal(exists.code, 'exists');
        assert.equal(fs.readFileSync(path.join(ws, qap), 'utf8'), 'someone else\n');
    });

    test('SW-5: deriveFields — marked, signed agent_<role>', async () => {
        const root = writeRoot('sw5');
        const rsp = `${root}/phase3_detailed_specifications/tom_uam.rsp.tomspecs.yaml`;
        const derive = writer((c) => rewrite(c[0], RSP.replace('requirements.', 'requirements, derived.')), { changes: [{ step: 1, kind: 'count', path: 'RSP/x', old: '1', new: '2' }], unresolved: [], document: {} });
        const answer = await withTiming('tomAi_specDeriveFields:typical', () => parse(specDeriveFieldsImpl(recordingDeps(derive.runner).deps, { file: rsp, at: '2026-11-25T10:00+01:00' })));
        assert.deepEqual([answer.ok, answer.written, answer.marked, answer.author, answer.changeCount], [true, true, true, 'agent_spec_author', 1]);
        assert.ok(derive.calls[0].includes('--author') && derive.calls[0].includes('agent_spec_author') && derive.calls[0].includes('2026-11-25T10:00+01:00'));
        assert.ok(!derive.calls[0].includes('--unmarked'));
        const plain = writer(() => undefined, { changes: [], unresolved: [] });
        const none = await parse(specDeriveFieldsImpl(recordingDeps(plain.runner).deps, { file: rsp, marked: false, dryRun: true }));
        assert.deepEqual([none.written, none.changeCount], [false, 0], 'the closing check: nothing left to derive');
        assert.ok(plain.calls[0].includes('--unmarked') && !plain.calls[0].includes('--author'));
    });

    test('SW-6: renameId — every changed document', async () => {
        const root = writeRoot('sw6');
        const rename = writer((c) => { for (const copy of c) { rewrite(copy, fs.readFileSync(copy, 'utf8').replace('The ', 'Renamed: The ')); } }, { changes: [{ document: 'tom_uam.sbp.tomspecs.yaml', kind: 'id' }, { document: 'tom_uam.rsp.tomspecs.yaml', kind: 'link' }] });
        const answer = await withTiming('tomAi_specRenameId:typical', () => parse(specRenameIdImpl(recordingDeps(rename.runner).deps, { specRoot: root, from: 'FR-1', to: 'FR-2' })));
        assert.deepEqual([answer.ok, answer.written, answer.changeCount, answer.files.length], [true, true, 2, 2]);
        assert.deepEqual(rename.calls[0].slice(-5), ['--from', 'FR-1', '--to', 'FR-2', '--json']);
        assert.ok(!rename.calls[0].includes('--stage-folder'), 'rename-id stages nothing itself: the tool does');
        assert.deepEqual(answer.stageFolders.sort(), [`${root}/phase2_solution_blueprint/03_01_01_Questions Round`, `${root}/phase3_detailed_specifications/W2_05_Result`]);
        assert.equal((await parse(specRenameIdImpl(recordingDeps(rename.runner).deps, { specRoot: root, from: '', to: 'x' }))).code, 'usageError');
        const taken = await parse(specRenameIdImpl(recordingDeps(async () => ({ exitCode: 2, stdout: '{"refused":{"code":"exists","documents":["tom_uam.rsp.tomspecs.yaml"]}}\n', stderr: 'refused' })).deps, { specRoot: root, from: 'A', to: 'B' }));
        assert.deepEqual([taken.code, taken.documents], ['exists', ['tom_uam.rsp.tomspecs.yaml']]);
    });

    test('SW-7: registration and documentation', () => {
        const writers = ['tomAi_specBackfill', 'tomAi_specPrefill', 'tomAi_specDeriveFields', 'tomAi_specRenameId'];
        assert.deepEqual(SPEC_SYNC_TOOLS.map((t) => t.name), ['tomAi_specSyncReport', ...writers]);
        const doc = fs.readFileSync(path.join(EXT, 'doc', 'llm_tools.md'), 'utf8');
        for (const name of writers) {
            const tool = ALL_SHARED_TOOLS.find((t) => t.name === name)!;
            assert.ok(tool, `${name} registered`);
            assert.deepEqual([tool.readOnly, tool.requiresApproval], [false, true], `${name} writes with approval`);
            assert.ok(!READ_ONLY_TOOLS.some((t) => t.name === name), `${name} not on the read-only floor`);
            assert.ok((AVAILABLE_LLM_TOOLS as readonly string[]).includes(name), `${name} selectable`);
            assert.ok(CATEGORY_MAP['TomSpecs (edit)'].includes(name), `${name} in TomSpecs (edit)`);
            assert.match(doc, new RegExp(`\\| \`${name}\` \\|`), `${name}: a row in §4.23b`);
            assert.match(doc, new RegExp(`### \`${name}\``), `${name}: a long form`);
        }
    });

    test('SW-8: the real binary — a deriveFields dry run', { skip: !fs.existsSync(BINARY) ? `no tomspecs at ${BINARY}` : !fs.existsSync(SAMPLE) ? `no ${SAMPLE}` : false }, async () => {
        const file = put('real-write/uam_access_hub.tomspecs.yaml', fs.readFileSync(SAMPLE, 'utf8'));
        const before = fs.readFileSync(file, 'utf8');
        const real: SpecSyncRunner = (command, args) => runDartBinary('tomspecs', [SPEC_COMMANDS[command], ...args], { timeoutMs: SPEC_CHECKS_TIMEOUT_MS });
        const answer = await parse(specDeriveFieldsImpl(recordingDeps(real).deps, { file: 'real-write/uam_access_hub.tomspecs.yaml', dryRun: true, limit: 3 }));
        assert.equal(answer.ok, true, JSON.stringify(answer).slice(0, 400));
        assert.deepEqual([answer.written, answer.dryRun, answer.marked], [false, true, true]);
        assert.equal(typeof answer.changeCount, 'number');
        assert.ok(answer.changes.length <= 3);
        if (answer.changeCount > 0) { assert.match(answer.diff, /^--- |^\+\+\+ |@@/m, 'the diff of the changes'); }
        assert.equal(fs.readFileSync(file, 'utf8'), before, 'a dry run writes nothing');
    });
});
