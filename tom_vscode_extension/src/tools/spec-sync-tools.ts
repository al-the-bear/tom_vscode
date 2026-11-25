/**
 * The TomSpecs document-set tools: a project's specification documents read
 * side by side (the Blueprint and the Phase 3 documents it is detailed in),
 * run by the bundled `tomspecs` (`:spec-sync-report` and the operations of
 * spec_sync_cli.dart in tom_specs_clitool, `--json`):
 *
 *   - tomAi_specSyncReport   — the document-set validation, plus each document's own findings (read-only)
 *   - tomAi_specBackfill     — the Phase 3 documents' values into the Blueprint, plain (writes the Blueprint)
 *   - tomAi_specPrefill      — a Phase 3 document started from the Blueprint (creates or fills it)
 *   - tomAi_specDeriveFields — the derived places of one document, as review marks or plain
 *   - tomAi_specRenameId     — a section id renamed in every document of the set
 *
 * The writes are staged (part-tools section 4): the command runs on the copies
 * (`--stage-folder` a scratch folder); each changed document's new stage —
 * YAML and rendition, through a temporary file and a rename — is written into
 * the step folder (`stageFolder`, default the last step folder of the
 * document's phase folder), and only then over the document of record and its
 * rendition through the store.
 *
 * The documents are staged (spec-staging.ts): read through the document store
 * (an editor's buffer when open), copied into a scratch folder of `ztmp/`,
 * and the command runs on the copies; the copies' names are the files' names,
 * which are the names the command gives the documents. Each document's
 * revision is the one the copy was made from, so a write tool given it as
 * `expectedRevision` writes onto exactly what was reported.
 *
 * Which documents form the set: `files`, or `specRoot` — every
 * `*.tomspecs.yaml` / `*.docspecs.yaml` directly in its
 * `phase2_solution_blueprint/` and `phase3_detailed_specifications/`, never in
 * the step folders below them (they hold copies of the same documents).
 */

import * as fs from 'fs';
import * as path from 'path';
import type { SharedToolDefinition } from './shared-tool-registry';
import { FIRST_LOOK, failure, json, liveDeps, resolveInput, toWorkspacePath, type SpecToolDeps } from './spec-tool-common';
import { renameCopyPaths, stage, withScratch, type Staged } from './spec-staging';
import { BinaryRunTimedOut, DartBinaryMissing, dartBinariesHelp, type BinaryRun } from '../services/dartBinariesStatus';
import { readSpecJsonRun, runSpecSync, SPEC_CHECKS_TIMEOUT_MS, type SpecJsonRun, type SpecSyncCommand } from '../services/spec-checks';
import { SPEC_COMMANDS } from '../services/tomspecsCalls';
import { unifiedDiff } from '../utils/unifiedDiff';
import { SomEditability, validateDocument } from 'tom_som_typescript_runtime';

/** How a document-set command runs: `tomspecs :spec-<command> <args>`; replaceable in a test. */
export type SpecSyncRunner = (command: SpecSyncCommand, args: string[]) => Promise<BinaryRun>;

export interface SpecSyncDeps extends SpecToolDeps {
    runSync?: SpecSyncRunner;
}

const runnerOf = (deps: SpecSyncDeps): SpecSyncRunner => deps.runSync ?? ((command, args) => runSpecSync(command, args));

/** The phase folders of a spec root whose documents form the set. */
export const SPEC_SET_FOLDERS = ['phase2_solution_blueprint', 'phase3_detailed_specifications'] as const;
const SET_FILE = /\.(tomspecs|docspecs)\.yaml$/;

/** A refusal before anything ran: answered like the command's own. */
class SyncInputError extends Error {
    constructor(readonly code: string, message: string, readonly extra: Record<string, unknown> = {}) { super(message); }
}

/** The set's files (absolute): `files` as given, or the documents directly in `specRoot`'s phase folders, in name order. */
export function setFiles(deps: SpecToolDeps, input: { files?: string[]; specRoot?: string }): string[] {
    const hasFiles = Array.isArray(input.files) && input.files.length > 0;
    if (hasFiles === !!input.specRoot) {
        throw new SyncInputError('usageError', 'Give exactly one of `files` (the documents) and `specRoot` (the spec root of the tom_specs process).');
    }
    if (hasFiles) { return input.files!.map((f) => resolveInput(deps, f)); }
    const root = resolveInput(deps, input.specRoot!);
    const found: string[] = [];
    for (const folder of SPEC_SET_FOLDERS) {
        const dir = path.join(root, folder);
        if (!fs.existsSync(dir)) { continue; }
        // Directly in the phase folder only: the step folders below hold copies of the same documents.
        for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
            if (e.isFile() && SET_FILE.test(e.name)) { found.push(path.join(dir, e.name)); }
        }
    }
    found.sort((a, b) => a.localeCompare(b));
    if (!found.length) {
        throw new SyncInputError('usageError', `No *.tomspecs.yaml or *.docspecs.yaml directly in ${SPEC_SET_FOLDERS.join(' or ')} of ${toWorkspacePath(deps, root)}.`);
    }
    return found;
}

/** The set's documents staged: each copy named as its file (the name the command gives the document), in a folder of its own. */
function stageSet(deps: SpecToolDeps, dir: string, files: string[]): Array<Staged & { name: string }> {
    const names = new Set<string>();
    return files.map((abs, i) => {
        const name = path.basename(abs);
        if (names.has(name)) {
            throw new SyncInputError('usageError', `Two documents of the set have the file name ${name}: the command names documents by file name.`);
        }
        names.add(name);
        return { ...stage(deps, dir, abs, path.join(String(i), name)), name };
    });
}

/** The answer of a failed run, by its outcome. */
function runFailure(deps: SpecToolDeps, run: SpecJsonRun, staged: Array<Staged & { name: string }>): string {
    const command = SPEC_COMMANDS[run.command] ?? run.command;
    const error = renameCopyPaths(run.stderr.join('\n'), deps, staged) || `tomspecs ${command} exited ${run.exitCode}`;
    const base = { ok: false, outcome: run.outcome, exitCode: run.exitCode };
    switch (run.outcome) {
        case 'binaryOutdated':
            return json({ ...base, code: 'binaryOutdated', error: `The bundled tomspecs does not know ${command} (built before it existed): rebuild the extension's binaries (./compile_and_install.sh) and reload the window.`, ...dartBinariesHelp() });
        case 'refused': {
            const r = run.refused ?? {};
            const fileOf = new Map(staged.map((s) => [s.name, toWorkspacePath(deps, s.abs)]));
            const documents = Array.isArray(r.documents) ? (r.documents as unknown[]).map((d) => fileOf.get(String(d)) ?? String(d)) : [];
            return json({ ...base, code: 'setRefused', refusal: r.refusal, documents, ...(r.className ? { className: r.className } : {}), error });
        }
        case 'usageError':
            return json({ ...base, code: 'usageError', error });
        default:
            return json({ ...base, code: 'failed', error });
    }
}

/** A thrown failure: a missing binary, a run past its time limit, an input refusal, or the store's. */
function thrownFailure(e: unknown): string {
    if (e instanceof DartBinaryMissing) {
        return json({ ok: false, outcome: 'binaryMissing', code: 'binaryMissing', error: e.message, expected: e.expected, ...dartBinariesHelp() });
    }
    if (e instanceof BinaryRunTimedOut) {
        return json({ ok: false, outcome: 'timedOut', code: 'timedOut', error: e.message, timeoutMs: e.timeoutMs });
    }
    if (e instanceof SyncInputError) {
        return json({ ok: false, code: e.code, error: e.message, ...e.extra });
    }
    return failure(e);
}

/** `[[key, value], …]` (the command's ordered form) as an object. */
const pairsToObject = (v: unknown): Record<string, unknown> =>
    Array.isArray(v) ? Object.fromEntries((v as unknown[]).filter((e) => Array.isArray(e) && e.length === 2).map((e) => [String((e as unknown[])[0]), (e as unknown[])[1]])) : {};

// ---------------------------------------------------------------------------
// tomAi_specSyncReport
// ---------------------------------------------------------------------------

export interface SpecSyncReportInput {
    files?: string[];
    specRoot?: string;
    pairs?: string[];
    codes?: string[];
    resolutions?: string[];
    includeInfo?: boolean;
    limit?: number;
    offset?: number;
    output?: string;
}

/** One finding as the tool lists it. */
interface SyncFinding {
    code: string;
    pair: string;
    blueprint: Record<string, unknown>;
    detail: Record<string, unknown>;
    holder: string;
    resolution: string;
    message?: string;
    info: boolean;
}

export const SYNC_REPORT_DEFAULT_LIMIT = 200;

export function specSyncReportImpl(deps: SpecSyncDeps, input: SpecSyncReportInput): Promise<string> {
    return (async () => {
        try {
            const files = setFiles(deps, input);
            const outputAbs = input.output ? resolveInput(deps, input.output) : undefined;
            if (outputAbs && fs.existsSync(outputAbs) && deps.store.isDirty(outputAbs)) {
                throw new SyncInputError('dirtyInEditor', `${path.basename(outputAbs)} has unsaved changes in an editor. Save or revert it there first.`);
            }
            return await withScratch(deps, async (dir) => {
                const staged = stageSet(deps, dir, files);
                const pairs = (input.pairs ?? []).map((p) => p.trim()).filter(Boolean);
                const run = readSpecJsonRun('sync-report', await runnerOf(deps)('sync-report', [
                    ...staged.map((s) => s.copy), ...(pairs.length ? ['--pairs', pairs.join(',')] : []), '--json',
                ]));
                if (run.outcome !== 'clean' && run.outcome !== 'findings') { return runFailure(deps, run, staged); }
                const report = run.json ?? {};
                const documents = staged.map((s) => {
                    const peek = deps.store.peek(s.abs);
                    return {
                        name: s.name,
                        file: toWorkspacePath(deps, s.abs),
                        root: peek?.root.sectionId ?? peek?.root.type ?? null,
                        revision: s.revision,
                        modelVersion: peek?.stamp ?? null,
                        dirty: deps.store.isDirty(s.abs),
                    };
                });
                const all: SyncFinding[] = (Array.isArray(report.findings) ? report.findings as Array<Record<string, unknown>> : []).map((f) => ({
                    code: String(f.code), pair: String(f.pair ?? ''),
                    blueprint: (f.blueprint ?? {}) as Record<string, unknown>, detail: (f.detail ?? {}) as Record<string, unknown>,
                    holder: String(f.holder ?? ''), resolution: String(f.resolution ?? ''),
                    ...(typeof f.message === 'string' ? { message: f.message } : {}),
                    info: f.info === true,
                }));
                const documentFindings: Record<string, unknown> = {};
                for (const [name, list] of Object.entries(pairsToObject(report.documentFindings))) {
                    documentFindings[name] = Array.isArray(list) ? list : [];
                }
                const whole = {
                    clean: report.clean === true,
                    documents,
                    notStarted: Array.isArray(report.notStarted) ? report.notStarted : [],
                    notStartedPairs: Array.isArray(report.notStartedPairs) ? report.notStartedPairs : [],
                    countsByCode: pairsToObject(report.countsByCode),
                    countsByResolution: pairsToObject(report.countsByResolution),
                    findingCount: all.length,
                };
                // The listed findings: the filters, then the page; the counts above always cover the whole set.
                const codes = new Set(input.codes ?? []);
                const resolutions = new Set(input.resolutions ?? []);
                const includeInfo = input.includeInfo !== false;
                const matched = all.filter((f) => (!codes.size || codes.has(f.code)) && (!resolutions.size || resolutions.has(f.resolution)) && (includeInfo || !f.info));
                const limit = Math.max(1, Math.floor(input.limit ?? SYNC_REPORT_DEFAULT_LIMIT));
                const offset = Math.max(0, Math.floor(input.offset ?? 0));
                const page = matched.slice(offset, offset + limit);
                const truncated = offset + page.length < matched.length;
                let written: string | undefined;
                if (outputAbs) {
                    // The full report (every finding, no filter, no page): the gate's evidence.
                    const text = `${JSON.stringify({ ...whole, findings: all, documentFindings }, null, 2)}\n`;
                    if (fs.existsSync(outputAbs)) {
                        const { revision } = deps.store.readText(outputAbs);
                        await deps.store.writeText(outputAbs, text, { baseRevision: revision });
                    } else {
                        fs.mkdirSync(path.dirname(outputAbs), { recursive: true });
                        fs.writeFileSync(outputAbs, text);
                    }
                    written = toWorkspacePath(deps, outputAbs);
                }
                return json({
                    ok: true,
                    ...whole,
                    matchedCount: matched.length,
                    findings: page,
                    documentFindings,
                    truncated,
                    nextOffset: truncated ? offset + page.length : null,
                    ...(written ? { output: written } : {}),
                });
            }, 'tom-spec-sync-');
        } catch (e) {
            return thrownFailure(e);
        }
    })();
}

// ---------------------------------------------------------------------------
// The writes: backfill, prefill, deriveFields, renameId
// ---------------------------------------------------------------------------

/** A diff longer than this is cut (`diffTruncated`, `diffLinesLeftOut`). */
export const SYNC_DIFF_MAX_LINES = 2000;
/** The lists of a write answer (`changes`, `left`, `findings`, `unresolved`) hold at most this many by default. */
export const SYNC_WRITE_DEFAULT_LIMIT = 200;

/** A step folder of a phase folder: `01_Initial Version`, `03_01_04_Consistency Round`, `W2_05_Result`. */
const STEP_FOLDER = /^(W\d+_)?\d{2}(_\d{2})*_/;

/**
 * The current step folder of the phase folder `phaseDir`: the last of its step folders in process order (their
 * names sort so), or undefined when it has none.
 */
export function currentStepFolder(phaseDir: string): string | undefined {
    if (!fs.existsSync(phaseDir)) { return undefined; }
    const steps = fs.readdirSync(phaseDir, { withFileTypes: true })
        .filter((e) => e.isDirectory() && STEP_FOLDER.test(e.name))
        .map((e) => e.name)
        .sort((a, b) => a.localeCompare(b, 'en'));
    return steps.length ? path.join(phaseDir, steps[steps.length - 1]) : undefined;
}

/** `text` written to `file` through a temporary file and a rename. */
function writeAtomic(file: string, text: string): void {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const tmp = `${file}.tmp`;
    fs.writeFileSync(tmp, text);
    fs.renameSync(tmp, file);
}

/** The rendition beside a YAML document: `<stem>.tomspecs.md` for `<stem>.tomspecs.yaml`. */
const renditionOf = (yamlFile: string): string => yamlFile.replace(/\.yaml$/, '.md');

/** The diffs of the changed documents, cut at {@link SYNC_DIFF_MAX_LINES} lines altogether. */
function cutDiff(diffs: string[]): { diff: string; diffTruncated?: true; diffLinesLeftOut?: number } {
    const lines = diffs.filter(Boolean).join('\n').split('\n');
    if (lines.length <= SYNC_DIFF_MAX_LINES) { return { diff: lines.join('\n') }; }
    return { diff: lines.slice(0, SYNC_DIFF_MAX_LINES).join('\n'), diffTruncated: true, diffLinesLeftOut: lines.length - SYNC_DIFF_MAX_LINES };
}

/** At most `limit` of `items`, with their count and whether some were left out. */
function page<T>(items: readonly T[], limit: number, name: string): Record<string, unknown> {
    return { [name]: items.slice(0, limit), [`${name}Count`]: items.length, ...(items.length > limit ? { [`${name}Truncated`]: true } : {}) };
}

/** One document a write changed: where, what it was, what it becomes. */
interface ChangedDocument {
    /** The document of record (absolute). */
    abs: string;
    /** Its text and revision when staged; null for a document the write creates (prefill). */
    before: { text: string; revision: string } | null;
    /** Its new YAML and rendition (the command's copies). */
    yaml: string;
    rendition: string | null;
}

/** A refusal found before or after the run, with its code. */
class SyncWriteRefusal extends Error {
    constructor(readonly code: string, message: string, readonly extra: Record<string, unknown> = {}) { super(message); }
}

/** The command's own refusals of a write (`{"refused": …}` on stdout) as the tool's codes. */
function writeRefusal(deps: SpecToolDeps, run: SpecJsonRun, staged: Array<Staged & { name: string }>, limit: number): string {
    const r = run.refused ?? {};
    const error = renameCopyPaths(run.stderr.join('\n'), deps, staged) || `the command refused (${JSON.stringify(r)})`;
    const fileOf = (v: unknown): string => {
        const s = String(v ?? '');
        const hit = staged.find((x) => x.copy === s || x.name === s || x.name === path.basename(s));
        return hit ? toWorkspacePath(deps, hit.abs) : s;
    };
    const base = { ok: false, outcome: 'refused', exitCode: run.exitCode, error };
    if (r.refusal !== undefined) {
        const documents = Array.isArray(r.documents) ? (r.documents as unknown[]).map(fileOf) : [];
        return json({ ...base, code: 'setRefused', refusal: r.refusal, documents, ...(r.className ? { className: r.className } : {}) });
    }
    const code = String(r.code ?? 'refused');
    switch (code) {
        case 'setHasMarks': {
            // The places holding marks or annotation blocks: counted per document, listed up to `limit`.
            const places = asList(r.places);
            return json({ ...base, code, placeCount: places.length, placeCountsByDocument: countBy(places, 'document'), places: places.slice(0, limit), ...(places.length > limit ? { placesTruncated: true } : {}) });
        }
        case 'noBlueprint':
            return json({ ...base, code: 'setRefused', refusal: 'noBlueprint', documents: staged.map((s) => toWorkspacePath(deps, s.abs)) });
        case 'rootMismatch':
            return json({ ...base, code, file: fileOf(r.file) });
        case 'rootTaken':
            return json({ ...base, code, document: r.document });
        case 'exists':
            return json({ ...base, code, documents: Array.isArray(r.documents) ? r.documents : [] });
        case 'fragments':
            return json({ ...base, code: 'readOnly', reason: 'assembled from fragments', files: Array.isArray(r.files) ? (r.files as unknown[]).map(fileOf) : [] });
        case 'notYaml':
            return json({ ...base, code: 'readOnly', reason: 'not a *.tomspecs.yaml document (Markdown is read, never written)', file: fileOf(r.file) });
        case 'unknownRoot':
            return json({ ...base, code: 'usageError' });
        default:
            return json({ ...base, code });
    }
}

interface SyncWriteInput {
    files?: string[];
    specRoot?: string;
    expectedRevision?: string;
    expectedRevisions?: Record<string, string>;
    stageFolder?: string;
    dryRun?: boolean;
    limit?: number;
}

/** What one operation adds to the shared write. */
interface SyncWritePlan {
    command: SpecSyncCommand;
    /** The set's files (absolute). */
    files: string[];
    /** The command's own arguments, given the copies and the scratch folder. */
    args: (copies: Array<Staged & { name: string }>, scratch: string) => string[];
    /** The command stages itself (`--stage-folder`): backfill, prefill, deriveFields. */
    stages: boolean;
    /** A read document dirty in an editor refuses the write (backfill). */
    refuseDirtyReads: boolean;
    /** The file `expectedRevision` is checked against (the document written). */
    expectedFor?: string;
    /** prefill: the document it creates when it does not exist (absolute), and its copy's name. */
    create?: { abs: string; name: string };
    /** The answer from the command's JSON and what was written. */
    answer: (result: Record<string, unknown>, written: Array<{ file?: string; revision?: string; rendition?: string }>, limit: number) => Record<string, unknown>;
}

/** The validation counts of a YAML text before and after (the TypeScript runtime's validateDocument). */
function validationOf(deps: SpecToolDeps, dir: string, before: string | null, after: string, name: string): Record<string, unknown> | undefined {
    try {
        const load = (text: string, tag: string): Array<{ path: string; code: string }> => {
            const file = path.join(dir, 'validation', tag, name);
            fs.mkdirSync(path.dirname(file), { recursive: true });
            fs.writeFileSync(file, text);
            return validateDocument(deps.service.model, deps.store.load(file).document).map((e) => ({ path: e.path, code: String(e.code) }));
        };
        const a = load(after, 'after');
        const b = before === null ? [] : load(before, 'before');
        const key = (e: { path: string; code: string }): string => `${e.path}|${e.code}`;
        const bk = new Set(b.map(key));
        const ak = new Set(a.map(key));
        return { introduced: a.filter((e) => !bk.has(key(e))).length, resolved: b.filter((e) => !ak.has(key(e))).length, total: a.length };
    } catch { return undefined; }
}

/**
 * The write every operation shares (part-tools section 4): the set staged in `ztmp/`; the revision, dirty and
 * model-version checks; the command run on the copies; the changed documents diffed; then — unless `dryRun` —
 * each changed document's new stage (YAML and rendition, through a temporary file and a rename) written into the
 * step folder, and only then the document of record and its rendition through the store.
 */
async function runSyncWrite(deps: SpecSyncDeps, input: SyncWriteInput, plan: SyncWritePlan): Promise<string> {
    const dryRun = input.dryRun === true;
    const limit = Math.max(1, Math.floor(input.limit ?? SYNC_WRITE_DEFAULT_LIMIT));
    return withScratch(deps, async (dir) => {
        const staged = stageSet(deps, dir, plan.files);
        // 1. Revisions: nothing runs on a document that moved since the caller read it.
        const expected: Array<[string, string]> = Object.entries(input.expectedRevisions ?? {}).map(([f, r]) => [resolveInput(deps, f), r]);
        if (input.expectedRevision !== undefined && plan.expectedFor) { expected.push([plan.expectedFor, input.expectedRevision]); }
        for (const [abs, revision] of expected) {
            const s = staged.find((x) => x.abs === abs);
            const current = s ? s.revision : (fs.existsSync(abs) ? deps.store.readText(abs).revision : undefined);
            if (current !== revision) {
                throw new SyncWriteRefusal('revisionConflict', `${toWorkspacePath(deps, abs)} is at revision ${current?.slice(0, 12) ?? '(none)'}, not the expected ${revision.slice(0, 12)}. Read it again.`, { file: toWorkspacePath(deps, abs), revision: current ?? null });
            }
        }
        // 2. Dirty documents: a backfill reads none that an editor is about to change.
        if (plan.refuseDirtyReads) {
            const dirty = staged.filter((s) => deps.store.isDirty(s.abs)).map((s) => toWorkspacePath(deps, s.abs));
            if (dirty.length) { throw new SyncWriteRefusal('dirtyInEditor', `Open with unsaved changes: ${dirty.join(', ')}. Save or revert them first.`, { files: dirty }); }
        }
        // 3. Model versions: a document stamped with a newer model is never read with an older one.
        for (const s of staged) {
            const peek = deps.store.peek(s.abs);
            if (peek && peek.editability !== SomEditability.editable && peek.editability !== SomEditability.readOnlyCrossMajor) {
                throw new SyncWriteRefusal('modelTooNew', `${toWorkspacePath(deps, s.abs)} is stamped ${peek.stamp}, which this model (${deps.service.modelVersion}) cannot read: ${peek.versionReason ?? ''}`.trim(), { file: toWorkspacePath(deps, s.abs), stamp: peek.stamp });
            }
        }
        // 4. Run on the copies (a document prefill creates is written into the scratch folder's `new/`).
        if (plan.create) { fs.mkdirSync(path.join(dir, 'new'), { recursive: true }); }
        const args = [...plan.args(staged, dir), ...(plan.stages ? ['--stage-folder', path.join(dir, 'stage')] : []), '--json'];
        const run = readSpecJsonRun(plan.command, await runnerOf(deps)(plan.command, args));
        if (run.outcome === 'refused') { return writeRefusal(deps, run, staged, limit); }
        if (run.outcome !== 'clean' && run.outcome !== 'findings') { return runFailure(deps, run, staged); }
        const result = run.json ?? {};
        // 5. What changed: each copy against the text it was made from, and a document the write created.
        const changed: ChangedDocument[] = [];
        for (const s of staged) {
            const now = fs.readFileSync(s.copy, 'utf8');
            if (now === s.text) { continue; }
            const md = renditionOf(s.copy);
            changed.push({ abs: s.abs, before: { text: s.text, revision: s.revision }, yaml: now, rendition: fs.existsSync(md) ? fs.readFileSync(md, 'utf8') : null });
        }
        if (plan.create) {
            const copy = path.join(dir, 'new', plan.create.name);
            if (fs.existsSync(copy)) {
                const md = renditionOf(copy);
                changed.push({ abs: plan.create.abs, before: null, yaml: fs.readFileSync(copy, 'utf8'), rendition: fs.existsSync(md) ? fs.readFileSync(md, 'utf8') : null });
            }
        }
        for (const c of changed) {
            if (!c.abs.endsWith('.yaml')) { throw new SyncWriteRefusal('readOnly', `${toWorkspacePath(deps, c.abs)} is not a YAML document and is never written.`, { file: toWorkspacePath(deps, c.abs) }); }
        }
        const validation = changed.length === 1 ? validationOf(deps, dir, changed[0].before?.text ?? null, changed[0].yaml, path.basename(changed[0].abs)) : undefined;
        if (dryRun || changed.length === 0) {
            const answer = plan.answer(result, changed.map((c) => ({ file: toWorkspacePath(deps, c.abs), revision: c.before?.revision })), limit);
            const dirty = changed.filter((c) => deps.store.isDirty(c.abs)).map((c) => toWorkspacePath(deps, c.abs));
            return json({
                ok: true, written: false, dryRun,
                ...answer,
                ...(validation ? { validation } : {}),
                ...(changed.length ? cutDiff(changed.map((c) => unifiedDiff(c.before?.text ?? '', c.yaml, toWorkspacePath(deps, c.abs)))) : {}),
                ...(dirty.length ? { dirty } : {}),
            });
        }
        // 6. A written document dirty in an editor refuses the write; nothing is written then.
        const dirty = changed.filter((c) => deps.store.isDirty(c.abs)).map((c) => toWorkspacePath(deps, c.abs));
        if (dirty.length) { throw new SyncWriteRefusal('dirtyInEditor', `Open with unsaved changes: ${dirty.join(', ')}. Save or revert them first.`, { files: dirty }); }
        // 7. The stage folders, settled before anything is written.
        const stageOf = new Map<string, string>();
        for (const c of changed) {
            const folder = input.stageFolder ? resolveInput(deps, input.stageFolder) : currentStepFolder(path.dirname(c.abs));
            if (!folder) {
                throw new SyncWriteRefusal('noStageFolder', `${toWorkspacePath(deps, path.dirname(c.abs))} has no step folder to stage ${path.basename(c.abs)} in: pass \`stageFolder\` (the current step's folder).`);
            }
            stageOf.set(c.abs, folder);
        }
        // 8. The stage: the new document and its rendition in the step folder, complete before the record moves.
        for (const c of changed) {
            const folder = stageOf.get(c.abs)!;
            writeAtomic(path.join(folder, path.basename(c.abs)), c.yaml);
            if (c.rendition !== null) { writeAtomic(path.join(folder, path.basename(renditionOf(c.abs))), c.rendition); }
        }
        // 9. The documents of record and their renditions, through the store's checks.
        const written: Array<{ file?: string; revision?: string; rendition?: string }> = [];
        for (const c of changed) {
            let revision: string;
            if (c.before) {
                const expectedRevision = plan.expectedFor === c.abs ? input.expectedRevision : input.expectedRevisions?.[toWorkspacePath(deps, c.abs)];
                revision = (await deps.store.writeText(c.abs, c.yaml, { baseRevision: c.before.revision, expectedRevision })).revision;
            } else {
                if (fs.existsSync(c.abs)) {
                    throw new SyncWriteRefusal('exists', `${toWorkspacePath(deps, c.abs)} appeared while the document was staged; it is not overwritten.`, { file: toWorkspacePath(deps, c.abs), stageFolder: toWorkspacePath(deps, stageOf.get(c.abs)!) });
                }
                writeAtomic(c.abs, c.yaml);
                revision = deps.store.readText(c.abs).revision;
            }
            let rendition: string | undefined;
            if (c.rendition !== null) {
                const md = renditionOf(c.abs);
                if (fs.existsSync(md)) {
                    await deps.store.writeText(md, c.rendition, { baseRevision: deps.store.readText(md).revision });
                } else { writeAtomic(md, c.rendition); }
                rendition = toWorkspacePath(deps, md);
            }
            written.push({ file: toWorkspacePath(deps, c.abs), revision, ...(rendition ? { rendition } : {}) });
        }
        return json({
            ok: true, written: true, dryRun: false,
            ...plan.answer(result, written, limit),
            ...(validation ? { validation } : {}),
            stageFolders: [...new Set(stageOf.values())].map((f) => toWorkspacePath(deps, f)),
        });
    }, 'tom-spec-sync-');
}

/** A sync finding of the command's JSON as the report lists it. */
const listedFinding = (f: Record<string, unknown>): Record<string, unknown> => ({
    code: String(f.code), pair: String(f.pair ?? ''), blueprint: f.blueprint ?? {}, detail: f.detail ?? {},
    holder: String(f.holder ?? ''), resolution: String(f.resolution ?? ''), ...(typeof f.message === 'string' ? { message: f.message } : {}), info: f.info === true,
});
const asList = (v: unknown): Array<Record<string, unknown>> => (Array.isArray(v) ? v as Array<Record<string, unknown>> : []);
const countBy = (items: Array<Record<string, unknown>>, key: string): Record<string, number> => {
    const out: Record<string, number> = {};
    for (const i of items) { const k = String(i[key]); out[k] = (out[k] ?? 0) + 1; }
    return out;
};

/** The Blueprint of a set: the document whose root is the solution blueprint. */
function blueprintOf(deps: SpecToolDeps, files: string[]): string | undefined {
    return files.find((f) => deps.store.peek(f)?.root.sectionId === 'SBP');
}

/** A write's thrown refusal or failure as its answer. */
function syncWriteFailure(e: unknown): string {
    if (e instanceof SyncWriteRefusal) { return json({ ok: false, code: e.code, error: e.message, ...e.extra }); }
    return thrownFailure(e);
}

// ----- tomAi_specBackfill ----------------------------------------------------

export interface SpecBackfillInput extends SyncWriteInput { pairs?: string[]; path?: string }

export function specBackfillImpl(deps: SpecSyncDeps, input: SpecBackfillInput): Promise<string> {
    return (async () => {
        try {
            const files = setFiles(deps, input);
            const blueprint = blueprintOf(deps, files);
            const pairs = (input.pairs ?? []).map((p) => p.trim()).filter(Boolean);
            return await runSyncWrite(deps, input, {
                command: 'backfill',
                files,
                stages: true,
                refuseDirtyReads: true,
                expectedFor: blueprint,
                args: (copies) => [...copies.map((c) => c.copy), ...(pairs.length ? ['--pairs', pairs.join(',')] : []), ...(input.path ? ['--path', input.path] : [])],
                answer: (r, written, limit) => {
                    const changes = asList(r.changes);
                    const left = asList(r.left).map((l) => ({ ...listedFinding((l.finding ?? {}) as Record<string, unknown>), reason: l.reason }));
                    return {
                        file: written[0]?.file ?? (blueprint ? toWorkspacePath(deps, blueprint) : null),
                        ...(written[0]?.revision ? { revision: written[0].revision } : {}),
                        ...(written[0]?.rendition ? { rendition: written[0].rendition } : {}),
                        changeCount: changes.length,
                        ...page(changes, limit, 'changes'),
                        ...page(left, limit, 'left'),
                        leftCountsByCode: countBy(left, 'code'),
                    };
                },
            });
        } catch (e) { return syncWriteFailure(e); }
    })();
}

// ----- tomAi_specPrefill -----------------------------------------------------

export interface SpecPrefillInput extends SyncWriteInput { root: string; target?: string; pairs?: string[] }

/** The default target of prefill under a spec root: `<project>.<abbreviation>.tomspecs.yaml`, the project from the Blueprint's file name. */
export function prefillTargetName(blueprintFile: string, rootSectionId: string): string {
    const project = path.basename(blueprintFile).replace(/\.sbp\.(tomspecs|docspecs)\.yaml$/, '').replace(/\.(tomspecs|docspecs)\.yaml$/, '');
    return `${project}.${rootSectionId.toLowerCase()}.tomspecs.yaml`;
}

export function specPrefillImpl(deps: SpecSyncDeps, input: SpecPrefillInput): Promise<string> {
    return (async () => {
        try {
            const root = deps.service.model.roots.find((r) => r.type === input.root || r.sectionId === input.root);
            if (!root) { throw new SyncInputError('usageError', `root ${input.root} names no root of the model.`); }
            const files = setFiles(deps, input);
            let target: string;
            if (input.target) {
                target = resolveInput(deps, input.target);
            } else if (input.specRoot) {
                const blueprint = blueprintOf(deps, files);
                if (!blueprint) { throw new SyncInputError('setRefused', 'The set has no Blueprint to name the target after.', { refusal: 'noBlueprint' }); }
                target = path.join(resolveInput(deps, input.specRoot), 'phase3_detailed_specifications', prefillTargetName(blueprint, root.sectionId ?? root.type));
            } else {
                throw new SyncInputError('usageError', '`target` is required with `files` (the default is named under `specRoot`).');
            }
            if (!target.endsWith('.tomspecs.yaml')) { throw new SyncInputError('usageError', '`target` names a *.tomspecs.yaml file.'); }
            const exists = fs.existsSync(target);
            if (exists && deps.store.peek(target)?.root.type !== root.type) {
                throw new SyncInputError('rootMismatch', `${toWorkspacePath(deps, target)} is no document of ${root.type}.`, { file: toWorkspacePath(deps, target) });
            }
            const set = exists && !files.includes(target) ? [...files, target] : files;
            const pairs = (input.pairs ?? []).map((p) => p.trim()).filter(Boolean);
            return await runSyncWrite(deps, input, {
                command: 'prefill',
                files: set,
                stages: true,
                refuseDirtyReads: false,
                expectedFor: exists ? target : undefined,
                ...(exists ? {} : { create: { abs: target, name: path.basename(target) } }),
                args: (copies, scratch) => [
                    ...copies.map((c) => c.copy),
                    '--root', root.type,
                    '--target', exists ? copies.find((c) => c.abs === target)!.copy : path.join(scratch, 'new', path.basename(target)),
                    ...(pairs.length ? ['--pairs', pairs.join(',')] : []),
                ],
                answer: (r, written, limit) => {
                    const derived = (r.derived ?? {}) as Record<string, unknown>;
                    const findings = [...asList(r.findings), ...asList(derived.unresolved)];
                    return {
                        created: !exists && written.length > 0,
                        file: toWorkspacePath(deps, target),
                        ...(written[0]?.revision ? { revision: written[0].revision } : {}),
                        ...(written[0]?.rendition ? { rendition: written[0].rendition } : {}),
                        filledPairs: Array.isArray(r.filledPairs) ? r.filledPairs : [],
                        skippedPairs: Array.isArray(r.skippedPairs) ? r.skippedPairs : [],
                        derivedChangeCount: asList(derived.changes).length,
                        findingCount: findings.length,
                        ...page(findings, limit, 'findings'),
                    };
                },
            });
        } catch (e) { return syncWriteFailure(e); }
    })();
}

// ----- tomAi_specDeriveFields -------------------------------------------------

export interface SpecDeriveFieldsInput { file: string; marked?: boolean; author?: string; at?: string; expectedRevision?: string; stageFolder?: string; dryRun?: boolean; limit?: number }

export function specDeriveFieldsImpl(deps: SpecSyncDeps, input: SpecDeriveFieldsInput): Promise<string> {
    return (async () => {
        try {
            const file = resolveInput(deps, input.file);
            const marked = input.marked !== false;
            // An operation's marks are the agent's work: signed agent_<role> unless the call names an author.
            const author = typeof input.author === 'string' ? input.author.trim() : (deps.agentAuthor?.() ?? '');
            return await runSyncWrite(deps, { files: [file], expectedRevision: input.expectedRevision, stageFolder: input.stageFolder, dryRun: input.dryRun, limit: input.limit }, {
                command: 'derive-fields',
                files: [file],
                stages: true,
                refuseDirtyReads: false,
                expectedFor: file,
                args: (copies) => [copies[0].copy, ...(marked ? [] : ['--unmarked']), ...(marked && author ? ['--author', author] : []), ...(marked && input.at ? ['--at', input.at] : [])],
                answer: (r, written, limit) => {
                    const changes = asList(r.changes);
                    return {
                        file: toWorkspacePath(deps, file),
                        marked,
                        ...(marked && author ? { author } : {}),
                        ...(written[0]?.revision ? { revision: written[0].revision } : {}),
                        ...(written[0]?.rendition ? { rendition: written[0].rendition } : {}),
                        changeCount: changes.length,
                        ...page(changes, limit, 'changes'),
                        ...page(asList(r.unresolved), limit, 'unresolved'),
                    };
                },
            });
        } catch (e) { return syncWriteFailure(e); }
    })();
}

// ----- tomAi_specRenameId -----------------------------------------------------

export interface SpecRenameIdInput extends SyncWriteInput { from: string; to: string }

export function specRenameIdImpl(deps: SpecSyncDeps, input: SpecRenameIdInput): Promise<string> {
    return (async () => {
        try {
            if (!input.from?.trim() || !input.to?.trim()) { throw new SyncInputError('usageError', '`from` and `to` are required.'); }
            const files = setFiles(deps, input);
            return await runSyncWrite(deps, input, {
                command: 'rename-id',
                files,
                stages: false,
                refuseDirtyReads: false,
                args: (copies) => [...copies.map((c) => c.copy), '--from', input.from.trim(), '--to', input.to.trim()],
                answer: (r, written, limit) => {
                    const changes = asList(r.changes);
                    return { changeCount: changes.length, ...page(changes, limit, 'changes'), files: written };
                },
            });
        } catch (e) { return syncWriteFailure(e); }
    })();
}

// ---------------------------------------------------------------------------
// The tool definitions
// ---------------------------------------------------------------------------

const SET_PARAMS = {
    files: {
        type: 'array',
        items: { type: 'string' },
        description: 'The documents of the set, workspace-relative or absolute: `*.tomspecs.yaml` or SOM Markdown; files of one root are fragments, assembled. Or pass `specRoot`.',
    },
    specRoot: {
        type: 'string',
        description: 'The spec root of the tom_specs process (e.g. `tom_uam/tom_specs`): the set is every `*.tomspecs.yaml` / `*.docspecs.yaml` directly in `phase2_solution_blueprint/` and `phase3_detailed_specifications/`, never in their step folders. Or pass `files`.',
    },
    pairs: {
        type: 'array',
        items: { type: 'string' },
        description: 'Only these pairs: the section ids of the `@DetailedIn` classes (`FR`, …), as the report names them.',
    },
};
const TAGS = ['tomspecs', 'spec-sync', 'tom-ai-chat'];
const SET_REFUSALS =
    ' Refusals: `binaryMissing`, `binaryOutdated` (rebuild, reload), `setRefused` (`refusal`, `documents`), `usageError`, `timedOut` (past '
    + `${Math.round(SPEC_CHECKS_TIMEOUT_MS / 60_000)} min).`
    + ' Runs the bundled tomspecs on copies of the documents; details: tomAi_describeTool.';

export const SPEC_SYNC_REPORT_TOOL: SharedToolDefinition<SpecSyncReportInput> = {
    name: 'tomAi_specSyncReport',
    displayName: 'TomSpecs: Sync Report',
    description:
        'The document-set validation (tomspecs :spec-sync-report): the Blueprint against the Phase 3 documents it is detailed in, pair by pair, plus each document\'s own findings. Read-only. The set: `files` or `specRoot`; `pairs` narrows it. Answers `{ok, clean, documents: [{name, file, root, revision, modelVersion, dirty}], notStarted, countsByCode, countsByResolution, findingCount, findings: [{code, pair, blueprint, detail, holder, resolution, info}], documentFindings, truncated, nextOffset}`; `codes` / `resolutions` / `includeInfo` filter the listed findings, `limit` (200) / `offset` page them, the counts cover the whole set. `revision` is the write tools\' `expectedRevision`; `output` writes the full report JSON.'
        + SET_REFUSALS + FIRST_LOOK,
    tags: TAGS,
    readOnly: true,
    inputSchema: {
        type: 'object',
        properties: {
            ...SET_PARAMS,
            codes: { type: 'array', items: { type: 'string' }, description: 'List only findings of these codes (the counts cover every code).' },
            resolutions: { type: 'array', items: { type: 'string' }, description: 'List only findings of these resolutions, e.g. `agent`, `backfill`.' },
            includeInfo: { type: 'boolean', description: 'List the `info` entries too (flagged `info: true`). Default true.' },
            limit: { type: 'number', description: `Most findings to list. Default ${SYNC_REPORT_DEFAULT_LIMIT}.` },
            offset: { type: 'number', description: 'Index of the first listed finding (paging); the previous answer\'s `nextOffset`. Default 0.' },
            output: { type: 'string', description: 'A workspace file to write the full report JSON to (every finding, unfiltered); refused when it is dirty in an editor.' },
        },
    },
    execute: async (input) => specSyncReportImpl(liveDeps(), input),
};

const WRITE_PARAMS = {
    expectedRevision: { type: 'string', description: 'The written document\'s `revision` (tomAi_specSyncReport\'s `documents[].revision`); refused when it moved since.' },
    stageFolder: { type: 'string', description: 'The step folder the new stage is written into (YAML and rendition) before the document of record. Default: the last step folder of the document\'s phase folder.' },
    dryRun: { type: 'boolean', description: 'Answer the changes and the diff (cut at 2,000 lines), write nothing. Default false.' },
    limit: { type: 'number', description: `Most entries per list (changes, left, findings, unresolved); their counts are always complete. Default ${SYNC_WRITE_DEFAULT_LIMIT}.` },
};
const EXPECTED_REVISIONS = { type: 'object', additionalProperties: { type: 'string' }, description: '`{file: revision}` of the documents it reads; one that moved since is refused (`revisionConflict`).' };
const STAGED =
    ' Staged: the new document and rendition into the step folder, then over the record through the store; `dryRun` answers the diff, writes nothing.'
    + ' Also refused: `dirtyInEditor`, `revisionConflict`, `readOnly`, `modelTooNew`, `noStageFolder`, `verification`.';

export const SPEC_BACKFILL_TOOL: SharedToolDefinition<SpecBackfillInput> = {
    name: 'tomAi_specBackfill',
    displayName: 'TomSpecs: Backfill',
    description:
        'Carry the Phase 3 documents\' values into the Blueprint as plain values (tomspecs :spec-backfill): no marks, no author. Writes the Blueprint only. A set still holding marks or comment / question blocks is refused (`setHasMarks`, the places counted per document); a read document dirty in an editor too (`dirtyInEditor`). `path` keeps the findings at or below a Blueprint path. Answers `{ok, written, file, revision, changeCount, changes: [{kind, pair, path, field, old, new}], left: [findings with reason], leftCountsByCode, validation, rendition, diff}`.'
        + STAGED + SET_REFUSALS + FIRST_LOOK,
    tags: TAGS,
    readOnly: false,
    requiresApproval: true,
    inputSchema: {
        type: 'object',
        properties: {
            ...SET_PARAMS,
            path: { type: 'string', description: 'Only the findings at or below this Blueprint path, e.g. `SBP/introductionAndScope/requirements/functionalRequirements/FRE-REQU-LST-1`.' },
            expectedRevisions: EXPECTED_REVISIONS,
            ...WRITE_PARAMS,
        },
    },
    execute: async (input) => specBackfillImpl(liveDeps(), input),
};

export const SPEC_PREFILL_TOOL: SharedToolDefinition<SpecPrefillInput> = {
    name: 'tomAi_specPrefill',
    displayName: 'TomSpecs: Prefill',
    description:
        'Start a Phase 3 document from the Blueprint (tomspecs :spec-prefill): every pair it holds nothing of yet filled once, then its derived places; a filled pair is skipped, so a second run writes nothing. `root` (`RSP`, or the type); `target` — default under `specRoot`: `phase3_detailed_specifications/<project>.<abbreviation>.tomspecs.yaml` (the project from the Blueprint\'s file name); required with `files`. An existing target of another root: `rootMismatch`; a new one appearing meanwhile: `exists`. Answers `{ok, created, written, file, revision, filledPairs, skippedPairs, findingCount, findings}`: the agent\'s work list.'
        + STAGED + SET_REFUSALS + FIRST_LOOK,
    tags: TAGS,
    readOnly: false,
    requiresApproval: true,
    inputSchema: {
        type: 'object',
        properties: {
            ...SET_PARAMS,
            root: { type: 'string', description: 'The Phase 3 root to fill: its section id (`RSP`) or type.' },
            target: { type: 'string', description: 'The document\'s file (`*.tomspecs.yaml`), created when missing. Default under `specRoot` (see the description).' },
            ...WRITE_PARAMS,
            expectedRevision: { type: 'string', description: 'When the target exists: its `revision`; refused when it moved since.' },
        },
        required: ['root'],
    },
    execute: async (input) => specPrefillImpl(liveDeps(), input),
};

export const SPEC_DERIVE_FIELDS_TOOL: SharedToolDefinition<SpecDeriveFieldsInput> = {
    name: 'tomAi_specDeriveFields',
    displayName: 'TomSpecs: Derive Fields',
    description:
        'Derive the derived places of one document (tomspecs :spec-derive-fields): inverses, extracted links, derived values, summaries, counts. `marked` (default true) writes them as review marks signed `author` (default `agent_<role>`, the role you work in) at `at`; `marked: false` writes plain values (a new document). `dryRun: true` with `changeCount: 0` is the closing check "nothing left to derive". Answers `{ok, written, file, revision, changeCount, changes: [{step, kind, path, field, old, new}], unresolved: [{path, code}], validation, rendition, diff}`.'
        + STAGED + SET_REFUSALS + FIRST_LOOK,
    tags: TAGS,
    readOnly: false,
    requiresApproval: true,
    inputSchema: {
        type: 'object',
        properties: {
            file: { type: 'string', description: 'The document (`*.tomspecs.yaml`), workspace-relative or absolute.' },
            marked: { type: 'boolean', description: 'Write review marks (default true) or plain values (false).' },
            author: { type: 'string', description: 'The review member the marks are attributed to. Default `agent_<role>`; "" signs none.' },
            at: { type: 'string', description: 'The change time the marks record, `2026-11-07T14:05+01:00`. Default now.' },
            ...WRITE_PARAMS,
        },
        required: ['file'],
    },
    execute: async (input) => specDeriveFieldsImpl(liveDeps(), input),
};

export const SPEC_RENAME_ID_TOOL: SharedToolDefinition<SpecRenameIdInput> = {
    name: 'tomAi_specRenameId',
    displayName: 'TomSpecs: Rename Id',
    description:
        'Rename a section id in every document of the set at once (tomspecs :spec-rename-id): the item\'s own id and every link naming it. Refused when `to` exists already (`exists`, the documents named). Answers `{ok, written, changeCount, changes: [{document, kind, path, field, old, new}], files: [{file, revision, rendition}], diff}`.'
        + STAGED + SET_REFUSALS + FIRST_LOOK,
    tags: TAGS,
    readOnly: false,
    requiresApproval: true,
    inputSchema: {
        type: 'object',
        properties: {
            ...SET_PARAMS,
            from: { type: 'string', description: 'The section id to rename.' },
            to: { type: 'string', description: 'Its new id.' },
            expectedRevisions: EXPECTED_REVISIONS,
            ...WRITE_PARAMS,
        },
        required: ['from', 'to'],
    },
    execute: async (input) => specRenameIdImpl(liveDeps(), input),
};

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export const SPEC_SYNC_TOOLS: SharedToolDefinition<any>[] = [
    SPEC_SYNC_REPORT_TOOL,
    SPEC_BACKFILL_TOOL,
    SPEC_PREFILL_TOOL,
    SPEC_DERIVE_FIELDS_TOOL,
    SPEC_RENAME_ID_TOOL,
];
