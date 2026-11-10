/**
 * The TomSpecs process checks as tools — tom_specs_clitool's `spec_checks`
 * (bundled per platform, src/services/spec-checks.ts), one tool per check:
 *
 *   - tomAi_specImportAnswers        — the answers typed into the rendition, into the YAML (writes)
 *   - tomAi_specRequiredFields       — required form fields filled, int / bool / enum values typed
 *   - tomAi_specQuestionRegister     — a question index against the document's question blocks (`write` rewrites its counts)
 *   - tomAi_specFeatureRegister      — every functional requirement linked by exactly one feature
 *   - tomAi_specProjectIdeaCoverage  — the requirements' coverage of the Project Idea
 *   - tomAi_specAuthorizationCheck   — operations, role matrix, screens and use cases agree
 *   - tomAi_specCoverage             — how much of the model the document fills
 *
 * `spec_checks validate` and `accept-marks` have none: tomAi_specValidate and
 * tomAi_specDecideMarks (`all: "accept"`) do the same.
 *
 * The two writes go through the document store like every spec write: the
 * check runs on copies of the files in a temporary folder of the workspace's
 * `ztmp/` (removed afterwards: a tool writes nowhere outside the workspace),
 * and what it changed
 * is written with the store's checks (a file dirty in an editor, a revision
 * moved since it was read, `expectedRevision`) — or only diffed on `dryRun`.
 */

import * as fs from 'fs';
import * as path from 'path';
import type { SharedToolDefinition } from './shared-tool-registry';
import { FILE_PARAM, FIRST_LOOK, failure, json, liveDeps, resolveInput, toWorkspacePath, type SpecToolDeps } from './spec-tool-common';
import { DartBinaryMissing, dartBinariesHelp, type BinaryRun } from '../services/dartBinariesStatus';
import { readSpecCheckRun, runSpecChecks, type SpecCheck, type SpecCheckReport } from '../services/spec-checks';

/** How a check is run: `spec_checks` with the arguments; replaceable in a test. */
export type SpecChecksRunner = (check: SpecCheck, args: string[], options: { specRoot?: string }) => Promise<BinaryRun>;

export interface SpecChecksDeps extends SpecToolDeps {
    runChecks?: SpecChecksRunner;
}

const runnerOf = (deps: SpecChecksDeps): SpecChecksRunner => deps.runChecks ?? ((check, args, options) => runSpecChecks(check, args, options));

/** The answer for a missing binary, any other failure, or the run's report. */
function answerFor(report: SpecCheckReport, extra: Record<string, unknown> = {}): string {
    const ok = report.outcome === 'clean' || report.outcome === 'findings';
    const { check, outcome, exitCode, findings, summary, lines, stderr } = report;
    return json({
        ok, check, outcome, exitCode, findingCount: findings.length, findings, summary,
        ...(lines.length ? { lines } : {}),
        ...(stderr.length ? (ok ? { stderr } : { error: stderr.join('\n') || `spec_checks ${check} exited ${exitCode}` }) : {}),
        ...extra,
    });
}

function missingOrFailure(e: unknown): string {
    if (e instanceof DartBinaryMissing) {
        return json({ ok: false, outcome: 'binaryMissing', error: e.message, expected: e.expected, ...dartBinariesHelp() });
    }
    return failure(e);
}

/** A read-only check: resolve the inputs, run, read the lines back. */
async function runReadOnly(deps: SpecChecksDeps, check: SpecCheck, args: string[], specRoot: string | undefined, extra?: (r: SpecCheckReport) => Record<string, unknown>): Promise<string> {
    try {
        const run = await runnerOf(deps)(check, args, { specRoot: specRoot ? resolveInput(deps, specRoot) : undefined });
        const report = readSpecCheckRun(check, run);
        return answerFor(report, extra?.(report));
    } catch (e) {
        return missingOrFailure(e);
    }
}

/** The check's output with the temporary copies' paths named as the files they stand for. */
function renamePaths(report: SpecCheckReport, renames: Array<[string, string]>): void {
    const fix = (s: string): string => renames.reduce((t, [from, to]) => t.split(from).join(to), s);
    report.lines = report.lines.map(fix);
    report.stderr = report.stderr.map(fix);
    report.findings = report.findings.map((f) => ({ ...f, text: fix(f.text) }));
}

/** A temporary folder for the copies in the workspace's `ztmp/`, removed afterwards whatever happens. */
async function withScratch<T>(deps: SpecChecksDeps, work: (dir: string) => Promise<T>): Promise<T> {
    const scratch = path.join(deps.wsRoot, 'ztmp');
    fs.mkdirSync(scratch, { recursive: true });
    const dir = fs.mkdtempSync(path.join(scratch, 'tom-spec-checks-'));
    try { return await work(dir); } finally { fs.rmSync(dir, { recursive: true, force: true }); }
}

// ---------------------------------------------------------------------------
// The read-only checks
// ---------------------------------------------------------------------------

export interface SpecDocumentCheckInput { file: string; specRoot?: string }

export function specRequiredFieldsImpl(deps: SpecChecksDeps, input: SpecDocumentCheckInput): Promise<string> {
    return guarded(() => runReadOnly(deps, 'required-fields', [resolveInput(deps, input.file)], undefined));
}

export function specFeatureRegisterImpl(deps: SpecChecksDeps, input: SpecDocumentCheckInput): Promise<string> {
    return guarded(() => runReadOnly(deps, 'feature-register', [resolveInput(deps, input.file)], undefined));
}

export function specAuthorizationCheckImpl(deps: SpecChecksDeps, input: SpecDocumentCheckInput): Promise<string> {
    return guarded(() => runReadOnly(deps, 'authorization', [resolveInput(deps, input.file)], input.specRoot));
}

export interface SpecProjectIdeaCoverageInput { projectIdea: string; file: string; exclusions?: string; all?: boolean; specRoot?: string }

export function specProjectIdeaCoverageImpl(deps: SpecChecksDeps, input: SpecProjectIdeaCoverageInput): Promise<string> {
    return guarded(() => runReadOnly(deps, 'project-idea-coverage', [
        resolveInput(deps, input.projectIdea), resolveInput(deps, input.file),
        ...(input.exclusions ? ['--exclusions', resolveInput(deps, input.exclusions)] : []),
        ...(input.all ? ['--all'] : []),
    ], input.specRoot));
}

export interface SpecCoverageInput { sample: string; file: string; old?: string; tsv?: boolean; specRoot?: string }

export function specCoverageImpl(deps: SpecChecksDeps, input: SpecCoverageInput): Promise<string> {
    return guarded(() => withScratch(deps, async (dir) => {
        const tsvFile = path.join(dir, 'coverage.tsv');
        return runReadOnly(deps, 'coverage', [
            resolveInput(deps, input.sample), resolveInput(deps, input.file),
            ...(input.old ? [resolveInput(deps, input.old)] : []),
            ...(input.tsv ? ['--tsv', tsvFile] : []),
        ], input.specRoot, () => (input.tsv && fs.existsSync(tsvFile) ? { tsv: fs.readFileSync(tsvFile, 'utf8') } : {}));
    }));
}

/** Input errors (a path outside the workspace) answer like the check's own refusals. */
async function guarded(work: () => Promise<string>): Promise<string> {
    try { return await work(); } catch (e) { return missingOrFailure(e); }
}

// ---------------------------------------------------------------------------
// The two writes
// ---------------------------------------------------------------------------

/** One file the check may change: its copy, and what it was when read. */
interface Staged { abs: string; copy: string; text: string; revision: string }

function stage(deps: SpecChecksDeps, dir: string, file: string, name: string): Staged {
    const abs = resolveInput(deps, file);
    const { text, revision } = deps.store.readText(abs);
    const copy = path.join(dir, name);
    fs.writeFileSync(copy, text);
    return { abs, copy, text, revision };
}

/** Write what the check changed in `files` through the store; the answer's `files` entries. */
async function writeBack(deps: SpecChecksDeps, files: Array<Staged & { expectedRevision?: string }>, dryRun: boolean): Promise<Array<Record<string, unknown>>> {
    const out: Array<Record<string, unknown>> = [];
    for (const f of files) {
        const after = fs.readFileSync(f.copy, 'utf8');
        if (after === f.text) { out.push({ file: toWorkspacePath(deps, f.abs), changed: false }); continue; }
        const saved = await deps.store.writeText(f.abs, after, { baseRevision: f.revision, expectedRevision: f.expectedRevision, dryRun });
        out.push({ file: toWorkspacePath(deps, f.abs), changed: true, written: saved.written, revision: saved.revision, ...(dryRun ? { diff: saved.diff } : {}) });
    }
    return out;
}

export interface SpecImportAnswersInput {
    file: string;
    rendition: string;
    dryRun?: boolean;
    allowOtherEdits?: boolean;
    expectedRevision?: string;
}

export function specImportAnswersImpl(deps: SpecChecksDeps, input: SpecImportAnswersInput): Promise<string> {
    return guarded(() => withScratch(deps, async (dir) => {
        const yaml = { ...stage(deps, dir, input.file, path.basename(input.file)), expectedRevision: input.expectedRevision };
        const md = stage(deps, dir, input.rendition, path.basename(input.rendition));
        // The check writes the copies (the YAML in place, the rendition regenerated); the store writes the files.
        const run = await runnerOf(deps)('import-answers', [...(input.allowOtherEdits ? ['--allow-other-edits'] : []), yaml.copy, md.copy], {});
        const report = readSpecCheckRun('import-answers', run);
        renamePaths(report, [[yaml.copy, toWorkspacePath(deps, yaml.abs)], [md.copy, toWorkspacePath(deps, md.abs)]]);
        if (report.outcome === 'usageError' || report.outcome === 'refused') { return answerFor(report, { files: [] }); }
        const files = await writeBack(deps, [yaml, md], input.dryRun === true);
        return answerFor(report, { dryRun: input.dryRun === true, files });
    }));
}

export interface SpecQuestionRegisterInput {
    file: string;
    index: string;
    write?: boolean;
    dryRun?: boolean;
    expectedRevision?: string;
    specRoot?: string;
}

export function specQuestionRegisterImpl(deps: SpecChecksDeps, input: SpecQuestionRegisterInput): Promise<string> {
    if (!input.write) {
        return guarded(() => runReadOnly(deps, 'question-register', [resolveInput(deps, input.file), resolveInput(deps, input.index)], input.specRoot));
    }
    return guarded(() => withScratch(deps, async (dir) => {
        // The document is read where it is (its spec root holds checks/question_register.yaml); the index is a copy.
        const index = { ...stage(deps, dir, input.index, path.basename(input.index)), expectedRevision: input.expectedRevision };
        const specRoot = input.specRoot ? resolveInput(deps, input.specRoot) : undefined;
        const run = await runnerOf(deps)('question-register', [resolveInput(deps, input.file), index.copy, '--write'], { specRoot });
        const report = readSpecCheckRun('question-register', run);
        renamePaths(report, [[index.copy, toWorkspacePath(deps, index.abs)]]);
        if (report.outcome === 'usageError') { return answerFor(report, { files: [] }); }
        const files = await writeBack(deps, [index], input.dryRun === true);
        return answerFor(report, { dryRun: input.dryRun === true, files });
    }));
}

// ---------------------------------------------------------------------------
// The tool definitions
// ---------------------------------------------------------------------------

const COMMON =
    ' Answers `{ok, check, outcome, exitCode, findingCount, findings: [{kind, text}], summary}` — `outcome` `clean` (exit 0) or `findings` (exit 1);'
    + ' `usageError` / `refused` (exit 2) and `binaryMissing` (no spec_checks for this platform, with `help` and `page`) with ok false.'
    + ' Runs the bundled spec_checks (tom_specs_clitool); the project\'s data is read from `<spec root>/checks/`.'
    + FIRST_LOOK;

const SPEC_ROOT_PARAM = {
    type: 'string',
    description: 'The spec root whose `checks/` folder holds the project\'s data. Default: the nearest folder above the document holding `checks/`, else the document folder\'s parent.',
};
const YAML_FILE = { ...FILE_PARAM, description: 'The specification document (`*.docspecs.yaml`), workspace-relative or absolute (inside the workspace).' };
const TAGS = ['tomspecs', 'spec-checks', 'tom-ai-chat'];

export const SPEC_IMPORT_ANSWERS_TOOL: SharedToolDefinition<SpecImportAnswersInput> = {
    name: 'tomAi_specImportAnswers',
    displayName: 'TomSpecs: Import Answers',
    description:
        'Import the answers typed into a document\'s rendition (`*.md`) into its YAML, in place and verified (spec_checks import-answers), then regenerate the rendition. A rendition that differs in more than answers is refused (`refused`, the REFUSED lines) unless `allowOtherEdits` (narrative values replaced too). Both files are written through the editor checks: refused when dirty in an editor or changed since read (`expectedRevision` for the YAML); `dryRun` answers the diffs and writes nothing. `summary.imported` lists the answers (question id, path, first line), `files` what was written.'
        + COMMON,
    tags: TAGS,
    readOnly: false,
    requiresApproval: true,
    inputSchema: {
        type: 'object',
        properties: {
            file: YAML_FILE,
            rendition: { type: 'string', description: 'The rendition the answers were typed into (`*.md`).' },
            dryRun: { type: 'boolean', description: 'Answer the diffs, write nothing. Default false.' },
            allowOtherEdits: { type: 'boolean', description: 'Also take other narrative values changed in the rendition. Default false.' },
            expectedRevision: { type: 'string', description: 'The YAML\'s `revision` from the last read; refused when it changed since.' },
        },
        required: ['file', 'rendition'],
    },
    execute: async (input) => specImportAnswersImpl(liveDeps(), input),
};

export const SPEC_REQUIRED_FIELDS_TOOL: SharedToolDefinition<SpecDocumentCheckInput> = {
    name: 'tomAi_specRequiredFields',
    displayName: 'TomSpecs: Required Fields',
    description:
        'Every form holds the fields the model marks required, and its int, bool and enum fields hold values of their type (spec_checks required-fields). Findings `MISSING` / `TYPE`; `summary` {forms, missing, badTypes}.'
        + COMMON,
    tags: TAGS,
    readOnly: true,
    inputSchema: { type: 'object', properties: { file: YAML_FILE }, required: ['file'] },
    execute: async (input) => specRequiredFieldsImpl(liveDeps(), input),
};

export const SPEC_QUESTION_REGISTER_TOOL: SharedToolDefinition<SpecQuestionRegisterInput> = {
    name: 'tomAi_specQuestionRegister',
    displayName: 'TomSpecs: Question Register',
    description:
        'A question index file against the document\'s question blocks (spec_checks question-register; conventions from `checks/question_register.yaml`). Findings `REGISTER`; `summary` {indexRows, blocks, waiting, waitingStarred, findings, answeredNotApplied}. `write: true` rewrites the index\'s status counts, the sentence below them and the id range (refused when the index is dirty in an editor or changed since read; `expectedRevision`, `dryRun` answers the diff).'
        + COMMON,
    tags: TAGS,
    readOnly: false,
    requiresApproval: true,
    inputSchema: {
        type: 'object',
        properties: {
            file: YAML_FILE,
            index: { type: 'string', description: 'The question index (`*.md`), e.g. clarifications.sbp.md.' },
            write: { type: 'boolean', description: 'Rewrite the index\'s counts. Default false.' },
            dryRun: { type: 'boolean', description: 'With `write`: answer the diff, write nothing.' },
            expectedRevision: { type: 'string', description: 'With `write`: the index\'s `revision` from the last read.' },
            specRoot: SPEC_ROOT_PARAM,
        },
        required: ['file', 'index'],
    },
    execute: async (input) => specQuestionRegisterImpl(liveDeps(), input),
};

export const SPEC_FEATURE_REGISTER_TOOL: SharedToolDefinition<SpecDocumentCheckInput> = {
    name: 'tomAi_specFeatureRegister',
    displayName: 'TomSpecs: Feature Register',
    description:
        'Every functional requirement linked by exactly one feature; every linked id and prototype feature resolving; the stated total matching (spec_checks feature-register, on a solution blueprint). Findings `FEATURES`; `summary` {features, functionalRequirements, prototypeFeatures, findings}.'
        + COMMON,
    tags: TAGS,
    readOnly: true,
    inputSchema: { type: 'object', properties: { file: YAML_FILE }, required: ['file'] },
    execute: async (input) => specFeatureRegisterImpl(liveDeps(), input),
};

export const SPEC_PROJECT_IDEA_COVERAGE_TOOL: SharedToolDefinition<SpecProjectIdeaCoverageInput> = {
    name: 'tomAi_specProjectIdeaCoverage',
    displayName: 'TomSpecs: Project Idea Coverage',
    description:
        'Every Project Idea id cited by a requirement\'s source, carried by a covered id, or excluded by a record (spec_checks project-idea-coverage; exclusions from `checks/project_idea_coverage.yaml` or `exclusions`). Findings: the `uncovered` ids and `UNKNOWN` exclusions; `summary.entries` each id that is not plainly covered ({class, id, kind, detail}; `all` lists the covered too), `summary.classes` the counts per class.'
        + COMMON,
    tags: TAGS,
    readOnly: true,
    inputSchema: {
        type: 'object',
        properties: {
            projectIdea: { type: 'string', description: 'The Project Idea (`*.md`).' },
            file: YAML_FILE,
            exclusions: { type: 'string', description: 'An exclusions YAML instead of `checks/project_idea_coverage.yaml`.' },
            all: { type: 'boolean', description: 'List the covered ids too. Default false.' },
            specRoot: SPEC_ROOT_PARAM,
        },
        required: ['projectIdea', 'file'],
    },
    execute: async (input) => specProjectIdeaCoverageImpl(liveDeps(), input),
};

export const SPEC_AUTHORIZATION_CHECK_TOOL: SharedToolDefinition<SpecDocumentCheckInput> = {
    name: 'tomAi_specAuthorizationCheck',
    displayName: 'TomSpecs: Authorization Check',
    description:
        'Operations, the role matrix, screens and use cases agree (spec_checks authorization; the role model is `checks/authorization_cross_check.yaml`, required). Findings: one per item, `kind` the check (A operations reachable … F called by); `summary.checks` the count per check, `summary.notes` the consistent other-actor steps and the steps waiting for an open question, {operations, screens, useCases}.'
        + COMMON,
    tags: TAGS,
    readOnly: true,
    inputSchema: { type: 'object', properties: { file: YAML_FILE, specRoot: SPEC_ROOT_PARAM }, required: ['file'] },
    execute: async (input) => specAuthorizationCheckImpl(liveDeps(), input),
};

export const SPEC_COVERAGE_TOOL: SharedToolDefinition<SpecCoverageInput> = {
    name: 'tomAi_specCoverage',
    displayName: 'TomSpecs: Coverage',
    description:
        'How much of the model the document fills, per configured row, and the class of every empty section (spec_checks coverage; rows and reasons from `checks/coverage_rows.yaml` and `coverage_reasons.yaml`, both required). `summary.table` is the report\'s lines; `tsv: true` adds `tsv`, the empty sections as tab-separated text. Always exit 0.'
        + COMMON,
    tags: TAGS,
    readOnly: true,
    inputSchema: {
        type: 'object',
        properties: {
            sample: { type: 'string', description: 'The full-model sample (`*.docspecs.yaml`), e.g. tom_som_conformance/samples/exercise_full_model.docspecs.yaml.' },
            file: YAML_FILE,
            old: { type: 'string', description: 'An older version of the document, to compare with.' },
            tsv: { type: 'boolean', description: 'Add the TSV of the empty sections. Default false.' },
            specRoot: SPEC_ROOT_PARAM,
        },
        required: ['sample', 'file'],
    },
    execute: async (input) => specCoverageImpl(liveDeps(), input),
};

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export const SPEC_CHECKS_TOOLS: SharedToolDefinition<any>[] = [
    SPEC_IMPORT_ANSWERS_TOOL,
    SPEC_REQUIRED_FIELDS_TOOL,
    SPEC_QUESTION_REGISTER_TOOL,
    SPEC_FEATURE_REGISTER_TOOL,
    SPEC_PROJECT_IDEA_COVERAGE_TOOL,
    SPEC_AUTHORIZATION_CHECK_TOOL,
    SPEC_COVERAGE_TOOL,
];
