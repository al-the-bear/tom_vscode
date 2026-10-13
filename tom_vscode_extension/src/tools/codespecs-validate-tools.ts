/**
 * CodeSpecs validation and step context (vsctsa20).
 *
 *   - tomAi_specCodeSpecsValidate     — the 37 `codespecs_derivation_contract.md`
 *                                       §6 checks over a generated trio, through
 *                                       the bundled validate_codespecs binary
 *   - tomAi_specCodeSpecsStepContext  — everything a Stage 3–4 authoring step
 *                                       may read (§2.9): the step, its areas'
 *                                       extracts, its contract entries, its
 *                                       output project
 *
 * Both are read-only. Validation keeps three outcomes apart: `clean`,
 * `violations` (both `ok: true` — the checks ran) and a usage error
 * (`ok: false`, the binary refused its input).
 */

import * as path from 'path';
import type { SharedToolDefinition } from './shared-tool-registry';
import { FILE_PARAM, json, liveDeps, resolveInput, toWorkspacePath, type SpecToolDeps } from './spec-tool-common';
import { codeSpecsFailure } from './codespecs-tools';
import { extractsDirOf, type ExtractsLocator } from './codespecs-trace-tools';
import {
    CodeSpecsBinaryMissing,
    CodeSpecsUsageError,
    resolveTrio,
    validateCodeSpecs,
    type CodeSpecsValidationReport,
    type Trio,
} from '../services/codespecs-validator';
import { CONTRACT_FILE, entriesForStep, readContract } from '../services/codespecs-contract';
import { entryView, readExtractDirectory } from '../services/codespecs-trace';

// ---------------------------------------------------------------------------
// Validate
// ---------------------------------------------------------------------------

export interface CodeSpecsValidateInput {
    shared?: string;
    client?: string;
    server?: string;
    extractsDir?: string;
    migrations?: string;
    regenerated?: { shared?: string; client?: string; server?: string };
    csVocabulary?: string;
    coreSource?: string;
    /** Most violations to return. */
    limit?: number;
}

const DEFAULT_VIOLATION_LIMIT = 200;

/** Run the binary over the input; the report as written, with workspace-relative inputs echoed. */
export async function codeSpecsValidationReport(deps: SpecToolDeps, input: CodeSpecsValidateInput): Promise<CodeSpecsValidationReport> {
    const abs = (p?: string): string | undefined => (p === undefined ? undefined : resolveInput(deps, p));
    const trio = resolveTrio({ shared: abs(input.shared), client: abs(input.client), server: abs(input.server) });
    let regenerated: Trio | undefined;
    if (input.regenerated) {
        regenerated = resolveTrio({ shared: abs(input.regenerated.shared), client: abs(input.regenerated.client), server: abs(input.regenerated.server) });
    }
    return validateCodeSpecs({
        ...trio,
        extracts: abs(input.extractsDir),
        migrations: abs(input.migrations),
        csVocabulary: abs(input.csVocabulary),
        coreSource: abs(input.coreSource),
        regenerated,
    });
}

function validateFailure(e: unknown): string {
    if (e instanceof CodeSpecsBinaryMissing) {
        return json({ ok: false, outcome: 'binaryMissing', error: e.message, expected: e.expected });
    }
    if (e instanceof CodeSpecsUsageError) {
        return json({ ok: false, outcome: 'usageError', error: e.message });
    }
    return codeSpecsFailure(e);
}

export async function codeSpecsValidateImpl(deps: SpecToolDeps, input: CodeSpecsValidateInput): Promise<string> {
    try {
        const report = await codeSpecsValidationReport(deps, input);
        const rel = (p: string | null): string | null => (p === null ? null : toWorkspacePath(deps, p));
        const limit = Math.max(1, Math.min(input.limit ?? DEFAULT_VIOLATION_LIMIT, 5000));
        const byCheck: Record<string, number> = {};
        for (const v of report.violations) { byCheck[v.check] = (byCheck[v.check] ?? 0) + 1; }
        return json({
            ok: true,
            outcome: report.passed ? 'clean' : 'violations',
            passed: report.passed,
            summary: report.summary,
            inputs: Object.fromEntries(Object.entries(report.inputs).filter(([, v]) => v !== null).map(([k, v]) => [k, rel(v)])),
            checksRun: report.checks.length - report.notRun.reduce((n, r) => n + r.checks.length, 0),
            checkCount: report.checks.length,
            notRun: report.notRun,
            ...(report.excludedAreas.length > 0 ? { excludedAreas: report.excludedAreas } : {}),
            ...(report.passed ? {} : { violationCount: report.violations.length, byCheck }),
            violations: report.violations.slice(0, limit).map((v) => ({
                check: v.check,
                checkTitle: v.checkTitle,
                definedIn: v.definedIn,
                file: v.file,
                line: v.line,
                ...(v.token ? { token: v.token } : {}),
                ...(v.area ? { area: v.area } : {}),
                message: v.message,
            })),
            ...(report.violations.length > limit ? { truncated: true } : {}),
        });
    } catch (e) {
        return validateFailure(e);
    }
}

// ---------------------------------------------------------------------------
// Step context
// ---------------------------------------------------------------------------

export interface CodeSpecsStepContextInput extends ExtractsLocator {
    step: number;
    /** Also return §2 (universal rules) in full; by default only its section list. */
    includeUniversalRules?: boolean;
}

class StepContextError extends Error {
    constructor(readonly code: string, message: string) {
        super(message);
    }
}

export async function codeSpecsStepContextImpl(deps: SpecToolDeps, input: CodeSpecsStepContextInput): Promise<string> {
    try {
        const catalog = deps.service.codeSpecsCatalog;
        const step = Number.isInteger(input.step) ? catalog.stepNumbered(input.step) : null;
        if (!step) {
            throw new StepContextError('unknownStep', `There is no authoring step ${input.step}; the steps are numbered 1–${catalog.steps.length}.`);
        }
        const slice = catalog.sliceNumbered(step.slice);
        const areas = step.areaCodes.map((code) => {
            const area = catalog.byCode(code);
            if (!area) { throw new StepContextError('catalogueError', `Step ${step.number} names ${code}, which the catalogue does not hold.`); }
            return area;
        });

        const dir = readExtractDirectory(extractsDirOf(deps, input));
        const extracts = areas.map((area) => {
            const file = dir.files.find((f) => f.extract.area.code === area.code);
            if (!file) {
                const unreadable = dir.unreadable.find((u) => u.file.startsWith(`${area.code}.`));
                return { area: area.code, missing: true, ...(unreadable ? { unreadable: unreadable.error } : {}) };
            }
            return {
                area: area.code,
                file: toWorkspacePath(deps, path.join(dir.dir, file.file)),
                ...(file.inScope ? {} : { outOfScope: true }),
                entryCount: file.extract.entries.length,
                entries: file.extract.entries.map(entryView),
            };
        });

        const contract = readContract();
        const chosen = entriesForStep(contract, step.slice, areas.map((a) => ({ code: a.code, annotations: a.annotations })));
        const universalRoot = contract.universal.find((s) => s.number === '2');

        return json({
            ok: true,
            step: {
                number: step.number,
                todo: `csgen${step.number}`,
                title: step.title,
                placedBy: step.placedBy,
                slice: { number: step.slice, title: slice?.title ?? null },
                areas: areas.map((a) => ({ code: a.code, canonicalId: a.canonicalId, markers: a.annotations.map((m) => `@${m}`) })),
            },
            outputProject: slice?.project ?? null,
            extractsDir: toWorkspacePath(deps, dir.dir),
            ...(dir.gateError ? { gateRecordError: dir.gateError } : {}),
            extracts,
            contract: {
                file: path.basename(CONTRACT_FILE),
                universalRules: input.includeUniversalRules && universalRoot
                    ? { number: '2', text: universalRoot.text }
                    : contract.universal.filter((s) => s.number !== '2').map((s) => ({ number: s.number, title: s.title, line: s.line })),
                matchedBy: chosen.matchedBy,
                entries: chosen.entries.map((s) => ({ number: s.number, title: s.title, line: s.line, text: s.text })),
            },
        });
    } catch (e) {
        if (e instanceof StepContextError) {
            return json({ ok: false, code: e.code, error: e.message });
        }
        return codeSpecsFailure(e);
    }
}

// ---------------------------------------------------------------------------
// Tool definitions
// ---------------------------------------------------------------------------

const PACKAGE_DIR = (locus: string, more = ''): { type: string; description: string } => ({
    type: 'string',
    description: `The generated <app>_codespec_${locus} package folder.${more}`,
});

export const CODESPECS_VALIDATE_TOOL: SharedToolDefinition<CodeSpecsValidateInput> = {
    name: 'tomAi_specCodeSpecsValidate',
    displayName: 'CodeSpecs: Validate',
    description:
        'Run the 37 codespecs_derivation_contract.md §6 checks over a generated CodeSpecs trio (shared, client, server '
        + 'packages), through the validate_codespecs binary bundled with the extension (no Dart SDK needed). `outcome` is '
        + '`clean` or `violations` (both ok: the checks ran) or, with ok false, `usageError` (the input was refused: a '
        + 'missing folder, a partial regenerated trio) or `binaryMissing`. Each violation: check number and title, the '
        + 'section that defines it, file and line, section-id token or area, message. `notRun` names each check whose '
        + 'corroborating input was not given (extracts for 19 and 32–36, migrations for 13, csVocabulary + coreSource '
        + 'for 9, regenerated for 31) — a check that did not run is not a pass.',
    tags: ['tomspecs', 'codespecs', 'tom-ai-chat'],
    readOnly: true,
    inputSchema: {
        type: 'object',
        properties: {
            shared: PACKAGE_DIR('shared'),
            client: PACKAGE_DIR('client', ' Default: the shared folder\'s sibling, its name ending in `client` instead of `shared`.'),
            server: PACKAGE_DIR('server', ' Default: the shared folder\'s sibling, its name ending in `server` instead of `shared`.'),
            extractsDir: { type: 'string', description: 'The run\'s whole extract folder (`generated-doc/codespecs_extracts`), for checks 19 and 32–36.' },
            migrations: { type: 'string', description: 'The CE-MG migration artifacts (*.sql), for check 13.' },
            regenerated: {
                type: 'object',
                properties: { shared: { type: 'string' }, client: { type: 'string' }, server: { type: 'string' } },
                description: 'A second generation run\'s trio, for the determinism check (31).',
            },
            csVocabulary: { type: 'string', description: 'tom_code_specs\' vocabulary source, for check 9 (with coreSource).' },
            coreSource: { type: 'string', description: 'The tom_core source holding the mirrored catalogues, for check 9 (with csVocabulary).' },
            limit: { type: 'number', description: `Most violations to return. Default ${DEFAULT_VIOLATION_LIMIT}.` },
        },
        required: ['shared'],
    },
    execute: async (input) => codeSpecsValidateImpl(liveDeps(), input),
};

export const CODESPECS_STEP_CONTEXT_TOOL: SharedToolDefinition<CodeSpecsStepContextInput> = {
    name: 'tomAi_specCodeSpecsStepContext',
    displayName: 'CodeSpecs: Step Context',
    description:
        'Everything a CodeSpecs authoring step (csgen<n>, 1–31) may read, per codespecs_derivation_contract.md §2.9: the '
        + 'step\'s title, slice, placement and areas (from the catalogue\'s step table); those areas\' extracts, entry by '
        + 'entry (token, path, class, field, verbatim value), flagged when the gate record puts an area out of the pass '
        + 'or when an extract is missing; the §3 contract entries for the markers those areas emit (text included, with '
        + 'how each area was matched); §2\'s section list (or its full text with includeUniversalRules); and the output '
        + 'project. Nothing else is for the step to read — not the Phase-3 specification documents.',
    tags: ['tomspecs', 'codespecs', 'tom-ai-chat'],
    readOnly: true,
    inputSchema: {
        type: 'object',
        properties: {
            step: { type: 'number', description: 'The authoring step number, 1–31.' },
            extractsDir: { type: 'string', description: 'The run\'s extract folder. Or pass `file`.' },
            file: { ...FILE_PARAM, description: 'The specification document; its run is `generated-doc/codespecs_extracts/` beside it. Or pass `extractsDir`.' },
            includeUniversalRules: { type: 'boolean', description: 'Return §2 (universal rules) in full rather than its section list. Default false.' },
        },
        required: ['step'],
    },
    execute: async (input) => codeSpecsStepContextImpl(liveDeps(), input),
};

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export const CODESPECS_VALIDATE_TOOLS: SharedToolDefinition<any>[] = [
    CODESPECS_VALIDATE_TOOL,
    CODESPECS_STEP_CONTEXT_TOOL,
];
