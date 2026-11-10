/**
 * The TomSpecs process-check tools (src/tools/spec-checks-tools.ts) over the bundled spec_checks binary
 * (src/services/spec-checks.ts), and its lines read back as structure.
 *
 *   SK-1 the reading: each check's lines as tom_specs_clitool prints them — findings by tag, the summary counts,
 *        the exit verdict (0 clean, 1 findings, 2 usage error, 2 with REFUSED lines a refused import)
 *   SK-2 the read-only checks with the real binary on the Meridian Blueprint (tom_som_dart_v0's shipped document,
 *        copied into a spec root of its own): required fields, the feature register, the question register with the
 *        project's checks/question_register.yaml, authorization without its role model (a usage error naming
 *        checks/authorization_cross_check.yaml), coverage without its rows (the same), a path outside the workspace
 *   SK-3 the answer import with the real binary: an answer typed into the rendition is written into the YAML and the
 *        rendition regenerated, both through the store; `dryRun` answers the diffs and writes nothing; a YAML dirty in
 *        an editor or past `expectedRevision` is refused and nothing is written; a rendition edited beyond its
 *        answers is refused (exit 2)
 *   SK-4 the question register's `write`: the counts rewritten in the index through the store (a runner standing in)
 *   SK-5 no binary for the platform: `binaryMissing` with the expected path, `help` and `page`
 *   SK-6 Tom UAM, when the workspace holds it: each tool's verdict and finding count equal the binary's own run
 *   SK-7 registration, the tool descriptions and doc/llm_tools.md
 *
 * SK-2, SK-3 and SK-6 need the binary in bin/<platform>/ (npm run codespecs:build) and the ai_build checkout;
 * they are skipped, saying why, without them.
 */

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { execFileSync } from 'child_process';
import test, { after, describe } from 'node:test';
import assert from 'node:assert/strict';

import { installVscodeStub } from './_vscode-stub.js';
installVscodeStub({});

import { withTiming } from './_timing.js';
import { SomModelService } from '../../services/som-model-service.js';
import { SomDocumentStore, nodeSomDocumentIo } from '../../services/som-document-store.js';
import { DartBinaryMissing, binaryFileName, setDartBinariesExtensionRoot } from '../../services/dartBinariesStatus.js';
import { readSpecCheckRun, type SpecCheck } from '../../services/spec-checks.js';
import { getCurrentPlatform } from '../../utils/executableResolver.js';
import {
    SPEC_CHECKS_TOOLS, specAuthorizationCheckImpl, specCoverageImpl, specFeatureRegisterImpl, specImportAnswersImpl,
    specProjectIdeaCoverageImpl, specQuestionRegisterImpl, specRequiredFieldsImpl, type SpecChecksDeps,
} from '../spec-checks-tools.js';

const EXT = path.join(__dirname, '..', '..', '..');
setDartBinariesExtensionRoot(EXT);
const WORKSPACE = path.resolve(EXT, '..', '..', '..');
const AI_BUILD = path.resolve(EXT, '..', '..', 'ai_build');
const MERIDIAN = path.join(AI_BUILD, 'tom_som_dart_v0', 'documents', 'meridian_order_management.docspecs.yaml');
const ANSWER_FIXTURE = path.join(AI_BUILD, 'tom_specs_clitool', 'test', 'spec_checks', 'sbp_fixture.dart');
const BINARY = path.join(EXT, 'bin', getCurrentPlatform(), binaryFileName('spec_checks'));
const UAM = path.join(WORKSPACE, 'tom_uam', 'tom_specs');

/** Why the real-binary tests cannot run here, or '' when they can. */
function cannotRun(...files: string[]): string {
    if (!fs.existsSync(BINARY)) { return `no spec_checks at ${BINARY} (npm run codespecs:build)`; }
    const missing = files.find((f) => !fs.existsSync(f));
    return missing ? `no ${missing}` : '';
}

const ws = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'spec-checks-')));
after(() => fs.rmSync(ws, { recursive: true, force: true }));
const dirty = new Set<string>();
const deps = (over: Partial<SpecChecksDeps> = {}): SpecChecksDeps => ({
    wsRoot: ws,
    store: new SomDocumentStore(SomModelService.instance, { ...nodeSomDocumentIo, isDirty: (p) => dirty.has(path.resolve(p)) }),
    service: SomModelService.instance,
    ...over,
});
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Json = any;
const parse = async (p: Promise<string>): Promise<Json> => JSON.parse(await p);
const read = (rel: string): string => fs.readFileSync(path.join(ws, rel), 'utf8');
const run = (check: SpecCheck, out: string, err = '', exitCode = 0) => readSpecCheckRun(check, { exitCode, stdout: out, stderr: err });

describe('TomSpecs process checks', () => {
    test('SK-1: the lines read back', () => {
        const req = run('required-fields', 'MISSING   SBP/A/form: owner\nTYPE      SBP/B/form: priority is not an int\nforms checked 12 missing 1 bad types 1\n', '', 1);
        assert.equal(req.outcome, 'findings');
        assert.deepEqual(req.findings, [{ kind: 'MISSING', text: 'SBP/A/form: owner' }, { kind: 'TYPE', text: 'SBP/B/form: priority is not an int' }]);
        assert.deepEqual(req.summary, { forms: 12, missing: 1, badTypes: 1 });
        const feat = run('feature-register', 'features  30 features, 102 functional requirements, 7 prototype features — 0 finding(s)\n');
        assert.deepEqual([feat.outcome, feat.summary], ['clean', { features: 30, functionalRequirements: 102, prototypeFeatures: 7, findings: 0 }]);
        const reg = run('question-register', 'counts    rewritten\nREGISTER  BQ-7 is open but has no block\nanswered in the Blueprint, not yet applied: BQ-3, BQ-4\nregister  573 index rows, 2 blocks in the Blueprint, 1 waiting (1 ★) — 1 finding(s)\n', '', 1);
        assert.deepEqual(reg.findings, [{ kind: 'REGISTER', text: 'BQ-7 is open but has no block' }]);
        assert.deepEqual(reg.summary, { countsRewritten: true, answeredNotApplied: ['BQ-3', 'BQ-4'], indexRows: 573, blocks: 2, waiting: 1, waitingStarred: 1, findings: 1 });
        const pic = run('project-idea-coverage', [
            'covered   C1.1   capability  FRE-REQU-ITEM-SHARING, SECRQ-REQU-TENANT-ISOLATION',
            'uncovered N-4    expectation ',
            'UNKNOWN   D-9 — in the exclusion list, not in the Project Idea',
            'ids       362 (150 capability, 12 expectation, 8 constraint, 192 decision); 147 requirements read',
            'coverage  covered 342, area 9, via 2, excluded 9, uncovered 1',
        ].join('\n'), '', 1);
        assert.deepEqual(pic.findings, [{ kind: 'uncovered', text: 'N-4 expectation' }, { kind: 'UNKNOWN', text: 'D-9 — in the exclusion list, not in the Project Idea' }]);
        assert.equal(pic.summary.ids, 362);
        assert.deepEqual(pic.summary.idKinds, { capability: 150, expectation: 12, constraint: 8, decision: 192 });
        assert.deepEqual(pic.summary.classes, { covered: 342, area: 9, via: 2, excluded: 9, uncovered: 1 });
        assert.deepEqual((pic.summary.entries as Json[])[0], { class: 'covered', id: 'C1.1', kind: 'capability', detail: 'FRE-REQU-ITEM-SHARING, SECRQ-REQU-TENANT-ISOLATION' });
        const authz = run('authorization', [
            '## A operations reachable: 1 finding(s)', '  - liftLockout: no role reaches it',
            '## B screen actions: 0 finding(s)',
            '## C use cases — steps performed by another actor than the primary one (consistent): 1', '  - UC-04 step: by another actor',
            'SUMMARY {A operations reachable: 1, B screen actions: 0} operations 295 screens 58 use cases 77',
        ].join('\n'), '', 1);
        assert.deepEqual(authz.findings, [{ kind: 'A operations reachable', text: 'liftLockout: no role reaches it' }]);
        assert.deepEqual(authz.summary.checks, { 'A operations reachable': 1, 'B screen actions': 0 }); // eslint-disable-line @typescript-eslint/naming-convention -- the check's own section names
        assert.deepEqual(authz.summary.notes, [{ name: 'C use cases — steps performed by another actor than the primary one (consistent)', count: 1, items: ['UC-04 step: by another actor'] }]);
        assert.deepEqual([authz.summary.operations, authz.summary.screens, authz.summary.useCases], [295, 58, 77]);
        const imp = run('import-answers', 'decode    OK\nPR-901  SBP > DOCTL > content  "(a)"\nBQ-902  SBP > X > form  (cleared)\nVALUE  SBP > INSC > SYDSC > content\nimport    1 answer(s), 1 other value(s)\nwritten   a.yaml\nrendition a.md\nschema    1 finding(s)\ninstance  0 finding(s)\n', 'SCHEMA   line 19: missing\n', 1);
        assert.deepEqual(imp.summary.imported, [{ questionId: 'PR-901', path: 'SBP > DOCTL > content', answer: '"(a)"' }, { questionId: 'BQ-902', path: 'SBP > X > form', answer: '(cleared)' }]);
        assert.deepEqual([imp.summary.values, imp.summary.answers, imp.summary.schema, imp.summary.decode], [['SBP > INSC > SYDSC > content'], 1, 1, 'OK']);
        assert.deepEqual(imp.findings, [{ kind: 'SCHEMA', text: 'line 19: missing' }]);
        assert.deepEqual(imp.lines, ['written   a.yaml', 'rendition a.md']);
        assert.equal(run('import-answers', 'decode    OK\n', 'REFUSED   the rendition differs beyond answers\n', 2).outcome, 'refused');
        const usage = run('authorization', '', 'usage: spec_checks authorization <sbp.docspecs.yaml>\nthe role model is the project\'s: x/checks/authorization_cross_check.yaml\n', 2);
        assert.equal(usage.outcome, 'usageError');
        assert.equal(usage.stderr.length, 2);
    });

    test('SK-2: the read-only checks on the Meridian Blueprint', async (t) => {
        const why = cannotRun(MERIDIAN);
        if (why) { t.skip(why); return; }
        fs.mkdirSync(path.join(ws, 'mer', 'phase2'), { recursive: true });
        fs.copyFileSync(MERIDIAN, path.join(ws, 'mer', 'phase2', 'sbp.docspecs.yaml'));
        const doc = 'mer/phase2/sbp.docspecs.yaml';
        const req = await withTiming('tomAi_specRequiredFields:typical', () => parse(specRequiredFieldsImpl(deps(), { file: doc })));
        assert.equal(req.ok, true);
        assert.equal(req.check, 'required-fields');
        assert.ok(req.summary.forms > 0, 'forms counted');
        assert.equal(req.outcome, req.findingCount === 0 ? 'clean' : 'findings');
        const feat = await withTiming('tomAi_specFeatureRegister:typical', () => parse(specFeatureRegisterImpl(deps(), { file: doc })));
        assert.equal(feat.ok, true);
        assert.ok(feat.summary.functionalRequirements > 0);
        assert.equal(feat.findingCount, feat.summary.findings);
        fs.writeFileSync(path.join(ws, 'mer', 'phase2', 'index.md'), '# Questions\n');
        fs.mkdirSync(path.join(ws, 'mer', 'checks'));
        fs.writeFileSync(path.join(ws, 'mer', 'checks', 'question_register.yaml'),
            'prefixes: [ZZ]\ngroups:\n  - {key: z, label: "ZZ-01 to ZZ-{max}", prefix: ZZ}\nstatuses:\n  - {key: open, label: open, waiting: true}\n');
        const reg = await withTiming('tomAi_specQuestionRegister:typical', () => parse(specQuestionRegisterImpl(deps(), { file: doc, index: 'mer/phase2/index.md' })));
        assert.equal(reg.ok, true);
        assert.equal(reg.summary.blocks, 0, 'with checks/question_register.yaml naming ZZ only, no block counts');
        const authz = await withTiming('tomAi_specAuthorizationCheck:typical', () => parse(specAuthorizationCheckImpl(deps(), { file: doc })));
        assert.deepEqual([authz.ok, authz.outcome, authz.exitCode], [false, 'usageError', 2]);
        assert.match(authz.error, /mer\/checks\/authorization_cross_check\.yaml/);
        const cov = await withTiming('tomAi_specCoverage:typical', () => parse(specCoverageImpl(deps(), { sample: doc, file: doc, tsv: true })));
        assert.deepEqual([cov.ok, cov.outcome], [false, 'usageError']);
        assert.match(cov.error, /coverage_rows\.yaml/);
        fs.writeFileSync(path.join(ws, 'mer', 'idea.md'), '# Project Idea\n');
        const pic = await withTiming('tomAi_specProjectIdeaCoverage:typical', () => parse(specProjectIdeaCoverageImpl(deps(), { projectIdea: 'mer/idea.md', file: doc })));
        assert.equal(pic.ok, true);
        assert.equal(pic.summary.ids, 0, 'an idea without ids');
        assert.match((await parse(specRequiredFieldsImpl(deps(), { file: '../outside.docspecs.yaml' }))).error, /outside the workspace/);
    });

    test('SK-3: the answer import', async (t) => {
        const why = cannotRun(ANSWER_FIXTURE);
        if (why) { t.skip(why); return; }
        const yamlText = /const String fixtureYaml = '''([\s\S]*?)''';/.exec(fs.readFileSync(ANSWER_FIXTURE, 'utf8'))![1];
        fs.mkdirSync(path.join(ws, 'imp'), { recursive: true });
        const yaml = 'imp/sbp.docspecs.yaml';
        const md = 'imp/sbp.md';
        fs.writeFileSync(path.join(ws, yaml), yamlText);
        // The rendition, as spec_checks validate writes it (exit 1: the fixture is not complete enough for the schema tier).
        try { execFileSync(BINARY, ['validate', path.join(ws, yaml), path.join(ws, md)], { stdio: 'ignore' }); } catch { /* findings, not a failure */ }
        const rendition = read(md);
        assert.match(rendition, /> \*\*Answer:\*\*\n/);
        fs.writeFileSync(path.join(ws, md), rendition.replace('> **Answer:**\n', '> **Answer:** (a)\n'));
        const yamlBefore = read(yaml);
        const mdBefore = read(md);
        // Dry run: diffs, nothing written.
        const dry = await withTiming('tomAi_specImportAnswers:typical', () => parse(specImportAnswersImpl(deps(), { file: yaml, rendition: md, dryRun: true })));
        assert.equal(dry.ok, true, JSON.stringify(dry));
        assert.equal(dry.summary.answers, 1);
        assert.equal(dry.summary.imported[0].questionId, 'PR-901');
        assert.equal(dry.files[0].file, yaml);
        assert.equal(dry.files[0].changed, true);
        assert.equal(dry.files[0].written, false);
        assert.match(dry.files[0].diff, /\(a\)/);
        assert.deepEqual([read(yaml), read(md)], [yamlBefore, mdBefore], 'nothing written');
        assert.ok(!JSON.stringify(dry).includes('tom-spec-checks-'), 'the copies\' paths never show');
        assert.deepEqual(fs.readdirSync(path.join(ws, 'ztmp')), [], 'the copies are gone');
        // Dirty in an editor, or past expectedRevision: refused, nothing written.
        dirty.add(path.join(ws, yaml));
        assert.equal((await parse(specImportAnswersImpl(deps(), { file: yaml, rendition: md }))).code, 'dirtyInEditor');
        dirty.clear();
        assert.equal((await parse(specImportAnswersImpl(deps(), { file: yaml, rendition: md, expectedRevision: 'f'.repeat(64) }))).code, 'revisionConflict');
        assert.equal(read(yaml), yamlBefore);
        // The import.
        const done = await parse(specImportAnswersImpl(deps(), { file: yaml, rendition: md }));
        assert.equal(done.ok, true, JSON.stringify(done));
        // The YAML takes the answer; the regenerated rendition reads as the one the answer was typed into, so it is left as it is.
        assert.deepEqual(done.files.map((f: Json) => [f.file, f.changed, f.written]), [[yaml, true, true], [md, false, undefined]]);
        assert.notEqual(read(yaml), yamlBefore);
        assert.match(read(yaml), /> \*\*Answer:\*\* \(a\)/);
        assert.match(read(md), /> \*\*Answer:\*\* \(a\)/);
        // A rendition changed beyond its answers is refused.
        fs.writeFileSync(path.join(ws, md), read(md).replace('Fixture Blueprint for the answer import.', 'Edited narrative.'));
        const refused = await parse(specImportAnswersImpl(deps(), { file: yaml, rendition: md }));
        assert.deepEqual([refused.ok, refused.outcome, refused.exitCode], [false, 'refused', 2]);
        assert.ok(refused.findings.some((f: Json) => f.kind === 'REFUSED'));
        assert.deepEqual(refused.files, []);
    });

    test('SK-4: the question register\'s write', async () => {
        fs.mkdirSync(path.join(ws, 'reg'), { recursive: true });
        fs.writeFileSync(path.join(ws, 'reg', 'doc.docspecs.yaml'), 'document:\n');
        fs.writeFileSync(path.join(ws, 'reg', 'index.md'), '# Questions\n\nopen 1\n');
        const calls: Array<{ check: string; args: string[] }> = [];
        const runner: SpecChecksDeps['runChecks'] = async (check, args) => {
            calls.push({ check, args });
            const index = args[1];
            fs.writeFileSync(index, fs.readFileSync(index, 'utf8').replace('open 1', 'open 0'));
            return { exitCode: 0, stdout: `counts    rewritten\nregister  1 index rows, 0 blocks in the Blueprint, 0 waiting (0 ★) — 0 finding(s)\n`, stderr: '' };
        };
        const dry = await parse(specQuestionRegisterImpl(deps({ runChecks: runner }), { file: 'reg/doc.docspecs.yaml', index: 'reg/index.md', write: true, dryRun: true }));
        assert.equal(dry.ok, true);
        assert.equal(dry.summary.countsRewritten, true);
        assert.match(dry.files[0].diff, /\+open 0/);
        assert.equal(read('reg/index.md'), '# Questions\n\nopen 1\n');
        assert.equal(calls[0].args[0], path.join(ws, 'reg', 'doc.docspecs.yaml'), 'the document where it is (its spec root)');
        assert.notEqual(calls[0].args[1], path.join(ws, 'reg', 'index.md'), 'the index is a copy');
        assert.equal(calls[0].args[2], '--write');
        const written = await parse(specQuestionRegisterImpl(deps({ runChecks: runner }), { file: 'reg/doc.docspecs.yaml', index: 'reg/index.md', write: true }));
        assert.equal(written.files[0].written, true);
        assert.equal(read('reg/index.md'), '# Questions\n\nopen 0\n');
    });

    test('SK-5: no binary for the platform', async () => {
        const missing: SpecChecksDeps['runChecks'] = async () => { throw new DartBinaryMissing('spec_checks', '/ext/bin/x/spec_checks', 'x'); };
        const r = await parse(specFeatureRegisterImpl(deps({ runChecks: missing }), { file: 'reg/doc.docspecs.yaml' }));
        assert.deepEqual([r.ok, r.outcome, r.expected], [false, 'binaryMissing', '/ext/bin/x/spec_checks']);
        assert.match(r.error, /spec_checks \(TomSpecs process checks\) is not available on x/);
        assert.match(r.help, /tomAi\.showDartBinariesHelp/);
        assert.ok(r.page);
    });

    test('SK-6: Tom UAM gives what the binary gives', async (t) => {
        const why = cannotRun(path.join(UAM, 'checks'));
        if (why) { t.skip(why); return; }
        const B = 'tom_uam/tom_specs/phase2_solution_blueprint';
        const live = deps({ wsRoot: WORKSPACE });
        const cases: Array<[string, Promise<string>, string[]]> = [
            ['required-fields', specRequiredFieldsImpl(live, { file: `${B}/tom_uam.sbp.docspecs.yaml` }), [`${B}/tom_uam.sbp.docspecs.yaml`]],
            ['feature-register', specFeatureRegisterImpl(live, { file: `${B}/tom_uam.sbp.docspecs.yaml` }), [`${B}/tom_uam.sbp.docspecs.yaml`]],
            ['authorization', specAuthorizationCheckImpl(live, { file: `${B}/tom_uam.sbp.docspecs.yaml` }), [`${B}/tom_uam.sbp.docspecs.yaml`]],
            ['question-register', specQuestionRegisterImpl(live, { file: `${B}/tom_uam.sbp.docspecs.yaml`, index: `${B}/clarifications.sbp.md` }), [`${B}/tom_uam.sbp.docspecs.yaml`, `${B}/clarifications.sbp.md`]],
            ['project-idea-coverage', specProjectIdeaCoverageImpl(live, { projectIdea: 'tom_uam/tom_specs/phase1_project_idea/project_idea.tom_uam.md', file: `${B}/tom_uam.sbp.docspecs.yaml` }),
                ['tom_uam/tom_specs/phase1_project_idea/project_idea.tom_uam.md', `${B}/tom_uam.sbp.docspecs.yaml`]],
        ];
        for (const [check, call, args] of cases) {
            const tool = JSON.parse(await call);
            let exitCode = 0;
            let stdout = '';
            try { stdout = execFileSync(BINARY, [check, ...args.map((a) => path.join(WORKSPACE, a))], { encoding: 'utf8', maxBuffer: 256 << 20 }); }
            catch (e) { exitCode = (e as { status: number }).status; stdout = String((e as { stdout: string }).stdout); }
            assert.equal(tool.exitCode, exitCode, check);
            const findingLines = stdout.split('\n').filter((l) => /^(MISSING|TYPE|FEATURES|REGISTER|UNKNOWN|uncovered)\s/.test(l)).length;
            if (check !== 'authorization') { assert.equal(tool.findingCount, findingLines, check); }
            if (check === 'authorization') { assert.equal(tool.findingCount, Object.values(tool.summary.checks as Record<string, number>).reduce((a, b) => a + b, 0)); }
        }
        // Coverage: the table is the binary's report, line for line.
        const sample = path.join(AI_BUILD, 'tom_som_conformance', 'samples', 'exercise_full_model.docspecs.yaml');
        if (fs.existsSync(sample)) {
            const cov = JSON.parse(await specCoverageImpl(live, { sample: path.relative(WORKSPACE, sample), file: `${B}/tom_uam.sbp.docspecs.yaml` }));
            const out = execFileSync(BINARY, ['coverage', sample, path.join(WORKSPACE, B, 'tom_uam.sbp.docspecs.yaml')], { encoding: 'utf8', maxBuffer: 256 << 20 });
            assert.deepEqual(cov.summary.table, out.split(/\r?\n/).filter((l) => l.trim() !== ''));
        }
        // The import, as a dry run: what the binary's --dry-run reports, nothing written.
        const yaml = path.join(WORKSPACE, B, 'tom_uam.sbp.docspecs.yaml');
        const before = fs.statSync(yaml).mtimeMs;
        const imp = JSON.parse(await specImportAnswersImpl(live, { file: `${B}/tom_uam.sbp.docspecs.yaml`, rendition: `${B}/tom_uam.sbp.md`, dryRun: true }));
        let impOut = '';
        let impCode = 0;
        try { impOut = execFileSync(BINARY, ['import-answers', '--dry-run', yaml, path.join(WORKSPACE, B, 'tom_uam.sbp.md')], { encoding: 'utf8', maxBuffer: 256 << 20 }); }
        catch (e) { impCode = (e as { status: number }).status; impOut = String((e as { stdout: string }).stdout); }
        assert.equal(imp.exitCode, impCode);
        const counts = /import\s+(\d+) answer\(s\), (\d+) other value\(s\)/.exec(impOut);
        if (counts) { assert.deepEqual([imp.summary.answers, imp.summary.otherValues], [Number(counts[1]), Number(counts[2])]); }
        assert.equal(fs.statSync(yaml).mtimeMs, before, 'a dry run writes nothing');
    });

    test('SK-7: registration and documentation', () => {
        const names = SPEC_CHECKS_TOOLS.map((t) => t.name);
        assert.deepEqual(names, ['tomAi_specImportAnswers', 'tomAi_specRequiredFields', 'tomAi_specQuestionRegister', 'tomAi_specFeatureRegister',
            'tomAi_specProjectIdeaCoverage', 'tomAi_specAuthorizationCheck', 'tomAi_specCoverage']);
        assert.deepEqual(SPEC_CHECKS_TOOLS.filter((t) => !t.readOnly).map((t) => t.name), ['tomAi_specImportAnswers', 'tomAi_specQuestionRegister']);
        assert.ok(SPEC_CHECKS_TOOLS.filter((t) => !t.readOnly).every((t) => t.requiresApproval));
        const executors = fs.readFileSync(path.join(EXT, 'src', 'tools', 'tool-executors.ts'), 'utf8');
        assert.match(executors, /\.\.\.SPEC_CHECKS_TOOLS,/);
        const doc = fs.readFileSync(path.join(EXT, 'doc', 'llm_tools.md'), 'utf8');
        for (const name of names) { assert.ok(doc.includes(`\`${name}\``), `${name} in doc/llm_tools.md`); }
    });
});
