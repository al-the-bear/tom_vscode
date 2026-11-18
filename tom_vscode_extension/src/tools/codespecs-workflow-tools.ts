/**
 * The Phase-4 workflow as a whole (vsctasb9):
 *
 *   tomAi_specCodeSpecsStatus  where a specification is in Phase 4 — every stage
 *                              (Stage A gate, extraction, Stage B verdicts, the
 *                              todo tree, authoring, validation) with its state,
 *                              and the next step;
 *   tomAi_specCodeSpecsGuide   the workflow guides (codespecs_prompt.md,
 *                              codespecs_mapping.md) section by section, and the
 *                              stage runbooks built from them.
 *
 * The status is built from the stage tools' own answers (gate, write-extracts
 * dry run, verdicts, plan-todos dry run, validate), so it says what they say.
 */

import * as fs from 'fs';
import * as path from 'path';
import { parse as parseYaml } from 'yaml';

import type { SharedToolDefinition } from './shared-tool-registry';
import { FILE_PARAM, json, liveDeps, resolveInput, toWorkspacePath, type SpecToolDeps } from './spec-tool-common';
import { IR_DIR, IR_SUFFIX } from './codespecs-units';
import { EXTRACTS_DIR, codeSpecsWriteExtractsImpl } from './codespecs-tools';
import { codeSpecsGateImpl, codeSpecsVerdictsImpl } from './codespecs-gate-tools';
import { codeSpecsPlanTodosImpl, type PlanTodoDeps } from './codespecs-plan-tools';
import { codeSpecsValidateImpl } from './codespecs-validate-tools';
import { noteValidationSkipped, validatorMissingWarning } from '../services/codespecs-validator';
import {
    GUIDES,
    RUNBOOKS,
    guideOutline,
    guideSection,
    runbookText,
} from '../services/codespecs-guides';

// ---------------------------------------------------------------------------
// Status
// ---------------------------------------------------------------------------

export type StageName = 'gate' | 'extraction' | 'verdicts' | 'coverageGaps' | 'todoTree' | 'authoring' | 'validation';

export type StageState =
    /** The stage's work is complete and current. */
    | 'done'
    /** Nothing of the stage exists yet. */
    | 'notStarted'
    /** Its output exists but no longer matches the document. */
    | 'outdated'
    /** Partly done. */
    | 'incomplete'
    /** It ran and found problems. */
    | 'failing'
    /** It cannot run until an earlier stage is done. */
    | 'blocked'
    /** Not checked: an input is missing (named in `summary`). */
    | 'notChecked'
    /** The run stops here: an open coverage gap waits for its review (contract §2.11). */
    | 'interrupted';

export interface StageStatus {
    stage: StageName;
    state: StageState;
    summary: string;
    /** The tool that moves the stage on. */
    tool: string;
    details?: Record<string, unknown>;
}

export interface CodeSpecsStatusInput {
    file: string;
    /** The quest holding the Phase-4 todo tree; default the active quest. */
    questId?: string;
    /** The generated <app>_codespec_shared folder, to run the validation stage. */
    shared?: string;
    /** Instead of `shared`: the trio's IR folder (`*.ir.yaml`), validated in its place. */
    ir?: string;
}

export interface StatusDeps {
    plan: PlanTodoDeps;
    /** The active quest, `''` when none. */
    activeQuest(): string;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Json = any;
const parse = (text: string): Json => JSON.parse(text);

const DONE_TODO = new Set(['completed', 'cancelled']);

async function gateStage(deps: SpecToolDeps, file: string): Promise<StageStatus> {
    const r = parse(await codeSpecsGateImpl(deps, { file }));
    if (!r.ok) {
        return { stage: 'gate', state: 'failing', summary: `The gate could not run: ${r.error}`, tool: 'tomAi_specCodeSpecsGate' };
    }
    if (r.gateOpen) {
        return { stage: 'gate', state: 'done', summary: 'Stage A passes: A1–A5 all clean.', tool: 'tomAi_specCodeSpecsGate' };
    }
    const failing = r.checks.filter((c: Json) => !c.passed);
    const notRun = failing.filter((c: Json) => !c.ran);
    return {
        stage: 'gate',
        state: 'failing',
        summary: `Stage A does not pass: ${failing.map((c: Json) => c.check).join(', ')}. Fix the findings in the specification (the spec edit tools), then run tomAi_specCodeSpecsGate again.`,
        tool: 'tomAi_specCodeSpecsGate',
        details: {
            failing: failing.filter((c: Json) => c.ran).map((c: Json) => ({
                check: c.check,
                findings: c.findings.length,
                first: c.findings.slice(0, 3).map((f: Json) => ({ code: f.code, ...(f.path ? { path: f.path } : {}), message: f.message })),
                fix: c.fix,
            })),
            ...(notRun.length > 0 ? { notRun: notRun.map((c: Json) => ({ check: c.check, reason: c.notRunReason })) } : {}),
        },
    };
}

async function extractionStage(deps: SpecToolDeps, file: string): Promise<StageStatus> {
    const r = parse(await codeSpecsWriteExtractsImpl(deps, { file, dryRun: true }));
    const tool = 'tomAi_specCodeSpecsWriteExtracts';
    if (!r.ok) {
        return { stage: 'extraction', state: 'blocked', summary: `The document cannot be extracted: ${r.error}`, tool };
    }
    const { new: added, changed, unchanged } = r.counts as Record<string, number>;
    const details = { outDir: r.outDir, areas: r.areas, counts: r.counts };
    if (unchanged === 0 && changed === 0) {
        return { stage: 'extraction', state: 'notStarted', summary: `No extracts yet in ${r.outDir}.`, tool, details };
    }
    if (added + changed > 0) {
        return {
            stage: 'extraction', state: 'outdated', tool, details,
            summary: `The extracts in ${r.outDir} are behind the document: ${changed} file(s) would change, ${added} would be added. Write them again.`,
        };
    }
    return { stage: 'extraction', state: 'done', summary: `All ${r.areas} areas' extracts are current.`, tool, details };
}

async function verdictsStage(deps: SpecToolDeps, file: string): Promise<StageStatus> {
    const r = parse(await codeSpecsVerdictsImpl(deps, { file }));
    const tool = 'tomAi_specCodeSpecsSetVerdict';
    if (!r.ok) {
        return { stage: 'verdicts', state: 'failing', summary: `The gate record cannot be read: ${r.error}`, tool };
    }
    const insufficient = (r.verdicts as Json[]).filter((v) => v.verdict === 'insufficient' && v.resolution !== 'descoped');
    const details = { record: r.file, counts: r.counts, ...(r.missing.length > 0 ? { missing: r.missing } : {}),
        ...(insufficient.length > 0 ? { insufficient: insufficient.map((v) => v.area) } : {}) };
    if (!r.exists) {
        return { stage: 'verdicts', state: 'notStarted', summary: `No gate record yet: every active area (${r.missing.length}) needs a verdict.`, tool, details };
    }
    // An area without a verdict is also a disagreement with its extract, so the missing ones are named first.
    if (r.missing.length > 0) {
        return { stage: 'verdicts', state: 'incomplete', summary: `${r.missing.length} active area(s) have no verdict yet: ${r.missing.join(', ')}.`, tool, details };
    }
    if (r.againstExtracts && !r.againstExtracts.ok) {
        return { stage: 'verdicts', state: 'failing', summary: `The record and the extracts disagree: ${r.againstExtracts.message}`, tool, details };
    }
    const tail = insufficient.length > 0 ? ` ${insufficient.length} insufficient area(s) become csopen questions in the todo tree.` : '';
    return { stage: 'verdicts', state: 'done', summary: `Every active area has a verdict.${tail}`, tool, details };
}

/** The coverage-gap record's file name, beside the extracts (codespecs_derivation_contract.md §2.11). */
export const COVERAGE_GAP_FILE = 'coverage_gaps.yaml';
/** The record's `formatVersion` this reader knows. */
const COVERAGE_GAP_FORMAT = 1;
/** Open gaps listed in the stage's details at most. */
const OPEN_GAP_LIST_LIMIT = 20;

/**
 * The run's coverage-gap record (contract §2.11): facts the specification
 * states that CodeSpecs has no place for, recorded by Stage B, the authoring
 * steps and `validate_codespecs --record-gaps`. An open gap stops the run until
 * the review settles it (added, fixed or leaveAsIs); then Phase 4 restarts.
 */
function coverageGapsStage(deps: SpecToolDeps, file: string): StageStatus {
    const tool = 'tomAi_specCodeSpecsGuide';
    const recordFile = path.join(path.dirname(resolveInput(deps, file)), EXTRACTS_DIR, COVERAGE_GAP_FILE);
    const record = toWorkspacePath(deps, recordFile);
    if (!fs.existsSync(recordFile)) {
        return { stage: 'coverageGaps', state: 'done', summary: `No coverage gap recorded (no ${COVERAGE_GAP_FILE} beside the extracts).`, tool, details: { record } };
    }
    let gaps: Json[];
    try {
        const doc = parseYaml(fs.readFileSync(recordFile, 'utf8')) as Json;
        const root = doc?.coverageGaps;
        if (!root || typeof root !== 'object') { throw new Error('no `coverageGaps` map'); }
        if (root.formatVersion !== COVERAGE_GAP_FORMAT) { throw new Error(`formatVersion ${root.formatVersion}, this reader knows ${COVERAGE_GAP_FORMAT}`); }
        gaps = Array.isArray(root.gaps) ? root.gaps : [];
    } catch (e) {
        return { stage: 'coverageGaps', state: 'failing', summary: `The coverage-gap record ${record} cannot be read: ${(e as Error).message}.`, tool, details: { record } };
    }
    const counts: Record<string, number> = {};
    for (const g of gaps) { const r = String(g?.resolution ?? 'open'); counts[r] = (counts[r] ?? 0) + 1; }
    const open = gaps.filter((g) => (g?.resolution ?? 'open') === 'open');
    const details: Record<string, unknown> = { record, gaps: gaps.length, counts };
    if (open.length === 0) {
        return { stage: 'coverageGaps', state: 'done', tool, details,
            summary: `No open coverage gap: ${gaps.length} recorded, all settled (${Object.entries(counts).map(([k, v]) => `${v} ${k}`).join(', ')}).` };
    }
    details.open = open.slice(0, OPEN_GAP_LIST_LIMIT).map((g) => ({
        id: g.id, sectionId: g.sectionId, ...(g.field ? { field: g.field } : {}), area: g.area, needs: g.needs, foundBy: g.foundBy,
        ...(g.step !== undefined ? { step: g.step } : {}), ...(g.note ? { note: g.note } : {}),
    }));
    if (open.length > OPEN_GAP_LIST_LIMIT) { details.openTruncated = true; }
    return {
        stage: 'coverageGaps', state: 'interrupted', tool, details,
        summary: `${open.length} open coverage gap(s) stop the run (${open.slice(0, 5).map((g) => g.id).join(', ')}${open.length > 5 ? ', …' : ''}): `
            + `facts the specification states that CodeSpecs has no place for. The review settles each in ${record}; then Phase 4 restarts from Stage A.`,
    };
}

interface TreeView { stage: StageStatus; tree?: Json }

async function todoTreeStage(deps: SpecToolDeps, status: StatusDeps, file: string, questId: string): Promise<TreeView> {
    const tool = 'tomAi_specCodeSpecsPlanTodos';
    if (!questId) {
        return { stage: { stage: 'todoTree', state: 'notChecked', summary: 'No quest: pass `questId` (or set the active quest) to look for the todo tree.', tool } };
    }
    const r = parse(await codeSpecsPlanTodosImpl(deps, status.plan, { file, questId, dryRun: true }));
    if (!r.ok) {
        return { stage: { stage: 'todoTree', state: 'blocked', summary: `The tree cannot be planned yet: ${r.error}`, tool, details: { code: r.code } } };
    }
    const items: Json[] = [...r.tree.csopen, ...r.tree.csproj, ...r.tree.csgen];
    const existing = items.filter((i) => i.existing).length;
    const details = { questId, items: items.length, existing };
    if (existing === 0) {
        return { stage: { stage: 'todoTree', state: 'notStarted', summary: `No todo tree in quest ${questId} yet (${items.length} todos to create).`, tool, details }, tree: r.tree };
    }
    if (existing < items.length) {
        return { stage: { stage: 'todoTree', state: 'incomplete', summary: `${items.length - existing} of ${items.length} todos are not in quest ${questId} yet.`, tool, details }, tree: r.tree };
    }
    return { stage: { stage: 'todoTree', state: 'done', summary: `The tree is in quest ${questId}: ${items.length} todos.`, tool, details }, tree: r.tree };
}

function authoringStage(status: StatusDeps, questId: string, tree: Json | undefined, treeState: StageState): StageStatus {
    const tool = 'tomAi_specCodeSpecsStepContext';
    if (!tree || treeState === 'notStarted' || treeState === 'notChecked' || treeState === 'blocked') {
        return { stage: 'authoring', state: treeState === 'notChecked' ? 'notChecked' : 'blocked', summary: 'Authoring starts once the todo tree exists.', tool };
    }
    const statusOf = new Map(status.plan.allTodos(questId).map((t) => [t.id, t.status ?? 'not-started']));
    const items: Array<Json & { kind: string }> = [
        ...tree.csopen.map((t: Json) => ({ ...t, kind: 'csopen' })),
        ...tree.csproj.map((t: Json) => ({ ...t, kind: 'csproj' })),
        ...tree.csgen.map((t: Json) => ({ ...t, kind: 'csgen' })),
    ].filter((t) => t.existing);
    const open = items.filter((t) => !DONE_TODO.has(statusOf.get(t.id) ?? 'not-started'));
    const steps = items.filter((t) => t.kind === 'csgen');
    const stepsDone = steps.filter((t) => DONE_TODO.has(statusOf.get(t.id) ?? '')).length;
    const details = {
        csopenOpen: open.filter((t) => t.kind === 'csopen').length,
        scaffoldingDone: items.filter((t) => t.kind === 'csproj').every((t) => DONE_TODO.has(statusOf.get(t.id) ?? '')),
        stepsDone,
        steps: steps.length,
        ...(open.length > 0 ? { nextTodo: { id: open[0].id, status: statusOf.get(open[0].id) } } : {}),
    };
    if (open.length === 0) {
        return { stage: 'authoring', state: 'done', summary: `All ${items.length} todos of the tree are done.`, tool, details };
    }
    const next = open[0];
    const what = next.kind === 'csopen' ? 'answer the open question' : next.kind === 'csproj' ? 'scaffold the package' : 'author the step into its IR documents';
    return {
        stage: 'authoring',
        state: stepsDone === 0 && open.length === items.length ? 'notStarted' : 'incomplete',
        summary: `${stepsDone} of ${steps.length} authoring steps done; next ${next.id} (${what}).`,
        tool,
        details,
    };
}

async function validationStage(deps: SpecToolDeps, file: string, trio: { shared?: string; ir?: string }): Promise<StageStatus> {
    const tool = 'tomAi_specCodeSpecsValidate';
    // Without `shared` / `ir`: the run's own IR folder, <spec-root>/irspecs/, once the authoring steps wrote it.
    const ownIr = path.join(path.dirname(resolveInput(deps, file)), IR_DIR);
    let usedOwnIr = false;
    if (!trio.shared && !trio.ir) {
        if (!fs.existsSync(ownIr) || !fs.readdirSync(ownIr).some((f) => f.endsWith(IR_SUFFIX))) {
            return { stage: 'validation', state: 'notChecked', summary: `No IR at ${toWorkspacePath(deps, ownIr)} yet (the authoring steps write it); `
                + 'or pass `shared` (a generated <app>_codespec_shared folder) or `ir` (an IR folder).', tool };
        }
        trio = { ir: toWorkspacePath(deps, ownIr) };
        usedOwnIr = true;
    }
    // The run's extracts corroborate checks 19 and 32–36; without them those checks are reported not run.
    const extractsDir = path.join(path.dirname(resolveInput(deps, file)), EXTRACTS_DIR);
    // Both given: passed on as given, and refused as a usage error, as the binary refuses them.
    const given = { ...(trio.shared !== undefined ? { shared: trio.shared } : {}), ...(trio.ir !== undefined ? { ir: trio.ir } : {}) };
    const r = parse(await codeSpecsValidateImpl(deps, { ...given, ...(fs.existsSync(extractsDir) ? { extractsDir } : {}) }));
    if (!r.ok && r.outcome === 'binaryMissing') {
        // Not a failure of the trio: this host cannot check it. The stage stays
        // open as if validation had not been asked for; the answer says why.
        noteValidationSkipped('tomAi_specCodeSpecsStatus');
        const warning = validatorMissingWarning('the trio is not validated (the validation stage is notChecked)');
        return { stage: 'validation', state: 'notChecked', summary: `${warning}. Validate on a host that has tomspecs, or configure one (${r.help}).`, tool, details: { warnings: [warning], help: r.help, page: r.page } };
    }
    if (!r.ok) {
        return { stage: 'validation', state: 'failing', summary: `Validation could not run (${r.outcome}): ${r.error}`, tool };
    }
    const details = { ...(trio.ir ? { ir: trio.ir, ...(usedOwnIr ? { irFolder: 'the run\'s own, <spec-root>/irspecs/' } : {}) } : { shared: trio.shared }),
        checksRun: r.checksRun, checkCount: r.checkCount, notRun: r.notRun.map((n: Json) => n.checks).flat(),
        ...(r.violationCount ? { violations: r.violationCount, byCheck: r.byCheck } : {}) };
    if (r.outcome === 'violations') {
        return { stage: 'validation', state: 'failing', summary: `${r.violationCount} violation(s) of the derivation contract.`, tool, details };
    }
    return { stage: 'validation', state: 'done', summary: `Clean: ${r.checksRun} of ${r.checkCount} checks ran and passed`
        + `${trio.ir ? ` on the IR at ${trio.ir}` : ''}.`, tool, details };
}

export const NEXT_ACTION: Record<StageName, string> = {
    gate: 'Fix the Stage-A findings in the specification (runbook codespecs-stage-a).',
    extraction: 'Write the extracts (runbook codespecs-extraction).',
    verdicts: 'Record the missing Stage-B verdicts (runbook codespecs-stage-b).',
    coverageGaps: 'Review the open coverage gaps (codespecs_derivation_contract.md §2.11; the csopen gap-review todo): settle each in coverage_gaps.yaml to added, fixed or leaveAsIs — a gap that needs vocabulary becomes a todo and stays open until it lands — then restart Phase 4 from Stage A (runbook codespecs-next-step).',
    todoTree: 'Create the todo tree (runbook codespecs-stage-c).',
    authoring: 'Work the tree: the next todo; an authoring step writes IR (runbook codespecs-authoring-step).',
    validation: 'Map each generation unit from the IR (tomAi_specCodeSpecsMap) and validate (runbook codespecs-validate).',
};

export async function codeSpecsStatusImpl(deps: SpecToolDeps, status: StatusDeps, input: CodeSpecsStatusInput): Promise<string> {
    try {
        if (!input.file) { return json({ ok: false, code: 'invalidInput', error: 'Pass `file`: the specification document.' }); }
        const questId = input.questId ?? status.activeQuest();
        const gate = await gateStage(deps, input.file);
        const extraction = await extractionStage(deps, input.file);
        const verdicts = await verdictsStage(deps, input.file);
        const gaps = coverageGapsStage(deps, input.file);
        const tree = await todoTreeStage(deps, status, input.file, questId);
        const authoring = authoringStage(status, questId, tree.tree, tree.stage.state);
        const validation = await validationStage(deps, input.file, { shared: input.shared, ir: input.ir });
        const stages = [gate, extraction, verdicts, gaps, tree.stage, authoring, validation];
        // An open coverage gap stops the run wherever it stands: its review comes first (contract §2.11).
        const first = gaps.state === 'interrupted' ? gaps : stages.find((s) => s.state !== 'done');
        const skipped = validation.details?.warnings as string[] | undefined;
        return json({
            ok: true,
            file: input.file,
            ...(questId ? { questId } : {}),
            ...(skipped ? { warnings: skipped, help: validation.details?.help, page: validation.details?.page } : {}),
            stages,
            next: first
                ? { stage: first.stage, state: first.state, tool: first.tool, action: first.state === 'notChecked' ? first.summary : NEXT_ACTION[first.stage] }
                : { stage: null, action: 'Phase 4 is complete for this document: the gate passes, no coverage gap is open, the tree is done and the trio validates clean.' },
        });
    } catch (e) {
        return json({ ok: false, code: 'statusError', error: (e as Error).message });
    }
}

// ---------------------------------------------------------------------------
// Guide
// ---------------------------------------------------------------------------

export interface CodeSpecsGuideInput {
    guide?: string;
    section?: string;
    runbook?: string;
    file?: string;
    questId?: string;
    step?: number;
    shared?: string;
}

export async function codeSpecsGuideImpl(input: CodeSpecsGuideInput): Promise<string> {
    try {
        if (input.runbook) {
            const r = runbookText(input.runbook, {
                file: input.file, questId: input.questId, shared: input.shared,
                ...(input.step !== undefined ? { step: String(input.step) } : {}),
            });
            return json(r.ok ? { ok: true, runbook: input.runbook, title: r.title, text: r.text } : { ok: false, code: 'unknownRunbook', error: r.error });
        }
        if (!input.guide) {
            return json({
                ok: true,
                guides: GUIDES.map((g) => ({ id: g.id, title: g.title, source: g.source, summary: g.summary,
                    sections: guideOutline(g.id).sections.filter((s) => s.level <= 3).map((s) => `${s.number} ${s.title}`) })),
                runbooks: RUNBOOKS.map((r) => ({ name: r.name, title: r.title, description: r.description,
                    arguments: r.arguments.map((a) => a.name) })),
            });
        }
        const g = GUIDES.find((x) => x.id === input.guide);
        if (!g) { return json({ ok: false, code: 'unknownGuide', error: `Unknown guide "${input.guide}". Guides: ${GUIDES.map((x) => x.id).join(', ')}.` }); }
        if (!input.section) {
            const o = guideOutline(g.id);
            return json({ ok: true, guide: g.id, title: g.title, source: g.source, sections: o.sections });
        }
        const s = guideSection(g.file, input.section);
        return json(s.ok ? { guide: g.id, ...s } : { ok: false, code: 'unknownSection', error: s.error });
    } catch (e) {
        return json({ ok: false, code: 'guideError', error: (e as Error).message });
    }
}

// ---------------------------------------------------------------------------
// Tool definitions
// ---------------------------------------------------------------------------

/** The live quest-todo access and active quest, loaded on first use (they import vscode). */
function liveStatusDeps(): StatusDeps {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const live = require('./chat-enhancement-tools') as typeof import('./chat-enhancement-tools');
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const chat = require('../managers/chatVariablesStore') as typeof import('../managers/chatVariablesStore');
    return {
        plan: { todos: live.liveQuestTodoDeps, allTodos: live.readQuestTodosIncludingTerminal, now: () => new Date() },
        activeQuest: () => { try { return chat.ChatVariablesStore.instance.quest; } catch { return ''; } },
    };
}

export const CODESPECS_STATUS_TOOL: SharedToolDefinition<CodeSpecsStatusInput> = {
    name: 'tomAi_specCodeSpecsStatus',
    displayName: 'CodeSpecs: Status',
    description:
        'Where a TomSpecs document is in Phase 4 (CodeSpecs), in one call: each stage in order — `gate` (Stage A, A1–A5), '
        + '`extraction` (are the extracts on disk current?), `verdicts` (Stage B: does the gate record cover every active area?), '
        + '`todoTree` (Stage C: is the csopen/csproj/csgen tree in the quest?), `authoring` (how many of the tree\'s todos are '
        + 'done, and the next one), `validation` (the IR, or a generated trio, against the derivation contract; by default '
        + 'the run\'s own IR folder `<spec-root>/irspecs/` once it holds IR) — with its state '
        + '(done, notStarted, outdated, incomplete, failing, blocked, notChecked), a summary, the tool that moves it and '
        + 'details; and `next`: the first stage not done and what to do. Reads only: every stage is checked with its own '
        + 'tool\'s dry run. `questId` defaults to the active quest; pass `shared` (the generated trio) or `ir` (its IR folder, '
        + '`*.ir.yaml`, before any code exists; not both) to include validation (without '
        + 'tomspecs on this platform it is notChecked, with `warnings` and `help`). How to do each '
        + 'stage: tomAi_specCodeSpecsGuide with `runbook`.',
    tags: ['tomspecs', 'codespecs', 'tom-ai-chat'],
    readOnly: true,
    inputSchema: {
        type: 'object',
        properties: {
            file: { ...FILE_PARAM, description: 'The specification document; its extracts and gate record sit beside it.' },
            questId: { type: 'string', description: 'The quest holding the Phase-4 todo tree. Default: the active quest.' },
            shared: { type: 'string', description: 'The generated <app>_codespec_shared folder; given, the trio is validated too.' },
            ir: { type: 'string', description: 'Instead of `shared`: the trio\'s IR (a folder of `*.ir.yaml` documents, irspecs_ir.md), validated in the trio\'s place. Default (neither given): the run\'s own `<spec-root>/irspecs/` once it holds IR.' },
        },
        required: ['file'],
    },
    execute: async (input) => codeSpecsStatusImpl(liveDeps(), liveStatusDeps(), input),
};

export const CODESPECS_GUIDE_TOOL: SharedToolDefinition<CodeSpecsGuideInput> = {
    name: 'tomAi_specCodeSpecsGuide',
    displayName: 'CodeSpecs: Guide',
    description:
        'The CodeSpecs (Phase 4) guides and stage runbooks bundled with the extension. Without arguments: the guides (`prompt`, `mapping`) with their main sections, and the runbooks. `guide`: its outline; with `section` (e.g. `6.2`) that section. `runbook` (codespecs-next-step, -stage-a, -extraction, -stage-b, -stage-c, -authoring-step, -validate): the stage\'s instructions with `file` / `questId` / `step` / `shared` filled in. Also MCP resources and prompts.',
    tags: ['tomspecs', 'codespecs', 'tom-ai-chat'],
    readOnly: true,
    inputSchema: {
        type: 'object',
        properties: {
            guide: { type: 'string', enum: ['prompt', 'mapping'], description: 'Which guide.' },
            section: { type: 'string', description: 'A section number, e.g. `6.2`.' },
            runbook: { type: 'string', enum: RUNBOOKS.map((r) => r.name), description: 'A stage runbook.' },
            file: { type: 'string', description: 'For a runbook: the specification document.' },
            questId: { type: 'string', description: 'For a runbook: the quest of the todo tree.' },
            step: { type: 'number', description: 'For codespecs-authoring-step: the step number, 1–31.' },
            shared: { type: 'string', description: 'For a runbook: the generated <app>_codespec_shared folder.' },
        },
    },
    execute: async (input) => codeSpecsGuideImpl(input),
};

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export const CODESPECS_WORKFLOW_TOOLS: SharedToolDefinition<any>[] = [CODESPECS_STATUS_TOOL, CODESPECS_GUIDE_TOOL];
