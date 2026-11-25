/**
 * The TomSpecs document-set tools: a project's specification documents read
 * side by side (the Blueprint and the Phase 3 documents it is detailed in),
 * run by the bundled `tomspecs` (`:spec-sync-report` and the operations of
 * spec_sync_cli.dart in tom_specs_clitool, `--json`):
 *
 *   - tomAi_specSyncReport — the document-set validation, plus each document's own findings (read-only)
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

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export const SPEC_SYNC_TOOLS: SharedToolDefinition<any>[] = [
    SPEC_SYNC_REPORT_TOOL,
];
