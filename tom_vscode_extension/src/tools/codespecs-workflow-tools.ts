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

import type { SharedToolDefinition } from './shared-tool-registry';
import { FILE_PARAM, json, liveDeps, resolveInput, type SpecToolDeps } from './spec-tool-common';
import { EXTRACTS_DIR, codeSpecsWriteExtractsImpl } from './codespecs-tools';
import { codeSpecsGateImpl, codeSpecsVerdictsImpl } from './codespecs-gate-tools';
import { codeSpecsPlanTodosImpl, type PlanTodoDeps } from './codespecs-plan-tools';
import { codeSpecsValidateImpl } from './codespecs-validate-tools';
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

export type StageName = 'gate' | 'extraction' | 'verdicts' | 'todoTree' | 'authoring' | 'validation';

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
    | 'notChecked';

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
    const what = next.kind === 'csopen' ? 'answer the open question' : next.kind === 'csproj' ? 'scaffold the trio' : 'author the step';
    return {
        stage: 'authoring',
        state: stepsDone === 0 && open.length === items.length ? 'notStarted' : 'incomplete',
        summary: `${stepsDone} of ${steps.length} authoring steps done; next ${next.id} (${what}).`,
        tool,
        details,
    };
}

async function validationStage(deps: SpecToolDeps, file: string, shared: string | undefined): Promise<StageStatus> {
    const tool = 'tomAi_specCodeSpecsValidate';
    if (!shared) {
        return { stage: 'validation', state: 'notChecked', summary: 'Pass `shared` (the generated <app>_codespec_shared folder) to validate the trio.', tool };
    }
    // The run's extracts corroborate checks 19 and 32–36; without them those checks are reported not run.
    const extractsDir = path.join(path.dirname(resolveInput(deps, file)), EXTRACTS_DIR);
    const r = parse(await codeSpecsValidateImpl(deps, { shared, ...(fs.existsSync(extractsDir) ? { extractsDir } : {}) }));
    if (!r.ok) {
        return { stage: 'validation', state: 'failing', summary: `Validation could not run (${r.outcome}): ${r.error}`, tool };
    }
    const details = { checksRun: r.checksRun, checkCount: r.checkCount, notRun: r.notRun.map((n: Json) => n.checks).flat(),
        ...(r.violationCount ? { violations: r.violationCount, byCheck: r.byCheck } : {}) };
    if (r.outcome === 'violations') {
        return { stage: 'validation', state: 'failing', summary: `${r.violationCount} violation(s) of the derivation contract.`, tool, details };
    }
    return { stage: 'validation', state: 'done', summary: `Clean: ${r.checksRun} of ${r.checkCount} checks ran and passed.`, tool, details };
}

const NEXT_ACTION: Record<StageName, string> = {
    gate: 'Fix the Stage-A findings in the specification (runbook codespecs-stage-a).',
    extraction: 'Write the extracts (runbook codespecs-extraction).',
    verdicts: 'Record the missing Stage-B verdicts (runbook codespecs-stage-b).',
    todoTree: 'Create the todo tree (runbook codespecs-stage-c).',
    authoring: 'Work the tree: the next todo (runbook codespecs-authoring-step).',
    validation: 'Validate the generated trio (runbook codespecs-validate).',
};

export async function codeSpecsStatusImpl(deps: SpecToolDeps, status: StatusDeps, input: CodeSpecsStatusInput): Promise<string> {
    try {
        if (!input.file) { return json({ ok: false, code: 'invalidInput', error: 'Pass `file`: the specification document.' }); }
        const questId = input.questId ?? status.activeQuest();
        const gate = await gateStage(deps, input.file);
        const extraction = await extractionStage(deps, input.file);
        const verdicts = await verdictsStage(deps, input.file);
        const tree = await todoTreeStage(deps, status, input.file, questId);
        const authoring = authoringStage(status, questId, tree.tree, tree.stage.state);
        const validation = await validationStage(deps, input.file, input.shared);
        const stages = [gate, extraction, verdicts, tree.stage, authoring, validation];
        const first = stages.find((s) => s.state !== 'done');
        return json({
            ok: true,
            file: input.file,
            ...(questId ? { questId } : {}),
            stages,
            next: first
                ? { stage: first.stage, state: first.state, tool: first.tool, action: first.state === 'notChecked' ? first.summary : NEXT_ACTION[first.stage] }
                : { stage: null, action: 'Phase 4 is complete for this document: the gate passes, the tree is done and the trio validates clean.' },
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
        + 'done, and the next one), `validation` (the generated trio against the derivation contract) — with its state '
        + '(done, notStarted, outdated, incomplete, failing, blocked, notChecked), a summary, the tool that moves it and '
        + 'details; and `next`: the first stage not done and what to do. Reads only: every stage is checked with its own '
        + 'tool\'s dry run. `questId` defaults to the active quest; pass `shared` to include validation. How to do each '
        + 'stage: tomAi_specCodeSpecsGuide with `runbook`.',
    tags: ['tomspecs', 'codespecs', 'tom-ai-chat'],
    readOnly: true,
    inputSchema: {
        type: 'object',
        properties: {
            file: { ...FILE_PARAM, description: 'The specification document; its extracts and gate record sit beside it.' },
            questId: { type: 'string', description: 'The quest holding the Phase-4 todo tree. Default: the active quest.' },
            shared: { type: 'string', description: 'The generated <app>_codespec_shared folder; given, the trio is validated too.' },
        },
        required: ['file'],
    },
    execute: async (input) => codeSpecsStatusImpl(liveDeps(), liveStatusDeps(), input),
};

export const CODESPECS_GUIDE_TOOL: SharedToolDefinition<CodeSpecsGuideInput> = {
    name: 'tomAi_specCodeSpecsGuide',
    displayName: 'CodeSpecs: Guide',
    description:
        'The CodeSpecs (Phase 4) workflow guides and stage runbooks, packaged with the extension. Without arguments: the '
        + 'two guides — `prompt` (codespecs_prompt.md: Stage A, the extraction run, Stage B, Stage C) and `mapping` '
        + '(codespecs_mapping.md: concepts, the Phase-4 contract and run procedure §1.1, the todo tree, the parts '
        + 'catalogue, slices and authoring order §4.4, DocSpecs ↔ CodeSpecs linking §9) — with their main sections, and '
        + 'the runbooks. `guide` alone: its full outline. `guide` + `section` (a number such as `6.2` or `1.1.2`): that '
        + 'section with its subsections (a very long one answers its own text and lists its children). `runbook` '
        + '(codespecs-next-step, -stage-a, -extraction, -stage-b, -stage-c, -authoring-step, -validate): the stage\'s '
        + 'instructions with `file` / `questId` / `step` / `shared` filled in and its guide sections appended. The same '
        + 'guides are MCP resources (`codespecs-guide://prompt`, `codespecs-guide://mapping`) and the runbooks MCP prompts.',
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
