/**
 * CodeSpecs Stage C (vsctsa21): the Phase-4 todo tree.
 *
 *   tomAi_specCodeSpecsPlanTodos  propose (dryRun) or create the csopen / csproj / csgen todos
 *
 * The tree's shape is fixed by the documents, not chosen here
 * (codespecs_prompt.md §7, codespecs_mapping.md §1.1.3):
 *   - L0 `csopen<n>`: decision-needed, one per gap line of every area whose
 *     Stage-B verdict is `insufficient` and not yet resolved (`resolution:
 *     descoped`), its title the gap line verbatim; an insufficient entry
 *     recorded without gap lines gets one L0 for the area, carrying its note;
 *   - L1 `csproj1`: the trio scaffolding, one todo because the three projects
 *     are not separable (§4.2);
 *   - L2 `csgen<n>`: all thirty-one authoring steps, `<n>` the step ordinal.
 *     A step whose areas are all out of scope is still created: completing it
 *     with an empty L3 rung is the recorded outcome §1.1.3 asks for.
 * L3 is never created here: each csgen todo creates its own as its first act.
 *
 * The queue walks `csopen*`, `csproj*` and `csgen*` lowest number first and
 * refuses a decision-needed todo, so the order is carried by the numbering and
 * the statuses; `dependencies` record it for the reader. Nothing is `blocked`:
 * a todo that waits only on earlier todos is not-started.
 *
 * Creating is idempotent per item: every todo carries a run tag (the extract
 * folder) and an item tag (area, `proj` or step), and an item whose tags are
 * already on a todo of the quest — live, archived or deleted — is reported as
 * existing and not created again.
 */

import * as path from 'path';
import { K_CODE_SPECS_EXTRACT_FILE_SUFFIX, CodeSpecsGateVerdict } from 'tom_som_typescript_runtime';
import type { CodeSpecsArea, CodeSpecsGateEntry, CodeSpecsStep } from 'tom_som_typescript_runtime';

import type { SharedToolDefinition } from './shared-tool-registry';
import { FILE_PARAM, json, liveDeps, toWorkspacePath, type SpecToolDeps } from './spec-tool-common';
import { CodeSpecsRefusal, codeSpecsFailure } from './codespecs-tools';
import { missingAreas, readRecord, recordPath, stageA } from './codespecs-gate-tools';
import { createQuestTodoImpl, type QuestTodoToolsDeps, type TodoDecision } from './quest-todo-tools';
import { buildIdPrefix } from './id-prefix-tools';

export interface CodeSpecsPlanTodosInput {
    /** The specification document; its record and extracts sit beside it. Also runs Stage A. */
    file?: string;
    /** The folder holding the specification document. */
    specRoot?: string;
    questId: string;
    /** The application name `<app>` in the trio's project names. */
    appName?: string;
    /** A `*.todo.yaml` in the quest folder; default the quest's own todo file. */
    todoFile?: string;
    dryRun?: boolean;
}

/** What the planner needs besides the spec deps: the quest's todos, and the clock for ids. */
export interface PlanTodoDeps {
    todos: QuestTodoToolsDeps;
    /** Every todo of the quest, archived and deleted included. */
    allTodos(questId: string): Array<{ id: string; status?: string; tags?: string[] }>;
    now(): Date;
}

const STEP_COUNT_NOTE = 'codespecs_mapping.md §4.4.6';
const CONTRACT = 'tom_ai/core/tom_core_codespecs/doc/codespecs_derivation_contract.md';
const MAPPING = 'tom_ai/core/tom_core_codespecs/doc/codespecs_mapping.md';

type Kind = 'csopen' | 'csproj' | 'csgen';

/** One todo of the tree before ids are assigned. */
interface PlannedItem {
    kind: Kind;
    /** The item tag; with the run tag it identifies the item across runs. */
    itemTag: string;
    /** The ordinal for csproj/csgen; csopen ordinals are assigned later. */
    ordinal?: number;
    slug: string;
    title: (id: string) => string;
    description: string;
    status: 'not-started' | 'decision-needed';
    priority: 'high' | 'medium';
    decisions?: TodoDecision[];
    /** Item tags of the todos this one comes after. */
    after: string[];
    references: Array<{ path?: string; description?: string }>;
    extraTags: string[];
}

/** Lowercase, hyphenated, at most five words / 40 characters. */
export function slugOf(text: string): string {
    const words = text.toLowerCase().replace(/[`*_§]/g, ' ').split(/[^a-z0-9]+/).filter(Boolean);
    let slug = '';
    for (const w of words.slice(0, 5)) {
        const next = slug ? `${slug}-${w}` : w;
        if (next.length > 40) { break; }
        slug = next;
    }
    return slug || 'item';
}

const isOutOfScope = (e: CodeSpecsGateEntry | null): boolean =>
    e !== null && (e.verdict === CodeSpecsGateVerdict.notApplicable || e.descoped);

const verdictLabel = (e: CodeSpecsGateEntry | null): string =>
    !e ? 'no verdict' : `${e.verdict.word}${e.descoped ? ', descoped' : ''}`;

/** The tree for a complete gate record, before ids. */
function planItems(
    deps: SpecToolDeps,
    verdictFor: (code: string) => CodeSpecsGateEntry | null,
    extractsRel: string,
    appName: string | undefined,
): PlannedItem[] {
    const catalog = deps.service.codeSpecsCatalog;
    const extractPath = (code: string): string => path.posix.join(extractsRel, `${code}${K_CODE_SPECS_EXTRACT_FILE_SUFFIX}`);
    const app = appName ?? '<app>';
    const items: PlannedItem[] = [];

    // L0 — one per unresolved insufficient area, in catalogue order.
    const open = catalog.activeAreas.filter((a) => {
        const e = verdictFor(a.code);
        return e?.verdict === CodeSpecsGateVerdict.insufficient && !e.descoped;
    });
    for (const area of open) {
        const entry = verdictFor(area.code);
        const note = entry?.note ?? null;
        const what = `${area.code} (${area.canonicalId})`;
        if (entry && entry.gaps.length > 0) {
            for (const gap of entry.gaps) {
                items.push({
                    kind: 'csopen',
                    // Section and carrier name the gap; two sections missing one field are two todos.
                    itemTag: `codespecs-open:${area.code}:${gap.sectionId}:${gap.carrier}`,
                    slug: slugOf(`${area.code} ${gap.carrier}`),
                    title: (id) => `${id.split('_')[0]}: ${gap.line}`,
                    description: [
                        `Stage B found ${what} insufficient. This is one of its gap lines (codespecs_prompt.md §6.3):`,
                        `  ${gap.line}`,
                        `Open ${gap.carrier}: it is what should carry "${gap.required}".`,
                        ...(note ? [`Gate note: ${note}`] : []),
                        `Extract: ${extractPath(area.code)}`,
                        'Resolve it one of two ways:',
                        `- complete the specification: fill ${gap.carrier}, re-run the extraction `
                            + '(tomAi_specCodeSpecsWriteExtracts) and re-take the verdict (tomAi_specCodeSpecsSetVerdict);',
                        `- descope ${area.code} for this pass: tomAi_specCodeSpecsSetVerdict with verdict \`insufficient\` and `
                            + 'resolution `descoped`; that resolves every gap line of the area.',
                        'Until it is resolved the queue pauses here: csopen* runs before csproj* and csgen*.',
                    ].join('\n'),
                    status: 'decision-needed',
                    priority: 'high',
                    decisions: [{
                        summary: `${gap.carrier}: fill it, or descope ${area.code} for this pass`,
                        // The todo schema's own field name (todo.schema.json).
                        // eslint-disable-next-line @typescript-eslint/naming-convention
                        decision_needed: `${gap.line}. Either ${gap.carrier} is filled (what it says is yours to state) and `
                            + `the verdict re-taken, or ${area.code} is descoped from this Phase-4 pass and shipped later.`,
                    }],
                    after: [],
                    references: [{ path: extractPath(area.code), description: `${area.code} extract` }],
                    extraTags: [area.code],
                });
            }
            continue;
        }
        items.push({
            kind: 'csopen',
            itemTag: `codespecs-open:${area.code}`,
            slug: slugOf(`${area.code} insufficient`),
            title: (id) => `${id.split('_')[0]}: ${what} is insufficient — complete its inputs or descope it`,
            description: [
                `Stage B found ${what} insufficient: its extract does not carry every input `
                    + 'codespecs_derivation_contract.md §3 requires to author the area (codespecs_prompt.md §6).',
                `Gate note: ${note ?? '(none recorded, and the record carries no gap lines for the area: they are in the Stage-B output)'}`,
                `Extract: ${extractPath(area.code)}`,
                'Resolve it one of two ways:',
                '- complete the specification: fill the missing inputs in the document, re-run the extraction '
                    + '(tomAi_specCodeSpecsWriteExtracts) and re-take the verdict (tomAi_specCodeSpecsSetVerdict);',
                '- descope the area for this pass: tomAi_specCodeSpecsSetVerdict with verdict `insufficient` and '
                    + 'resolution `descoped`; the validator then leaves the area out of checks 35 and 36.',
                'Until it is resolved the queue pauses here: csopen* runs before csproj* and csgen*.',
            ].join('\n'),
            status: 'decision-needed',
            priority: 'high',
            decisions: [{
                summary: `${area.code}: complete the missing inputs, or descope the area for this pass`,
                // The todo schema's own field name (todo.schema.json).
                // eslint-disable-next-line @typescript-eslint/naming-convention
                decision_needed: `${what} has no complete set of the inputs its derivation needs. Either the `
                    + 'specification is completed (which inputs, and what they say, is yours to state) and the verdict '
                    + 're-taken, or the area is descoped from this Phase-4 pass and shipped later. '
                    + `Gate note: ${note ?? '(none)'}`,
            }],
            after: [],
            references: [{ path: extractPath(area.code), description: `${area.code} extract` }],
            extraTags: [area.code],
        });
    }

    // L1 — the trio, one todo.
    const projects = new Map<string, string[]>();
    for (const area of catalog.activeAreas) {
        if (isOutOfScope(verdictFor(area.code))) { continue; }
        for (const s of area.slices) {
            const project = catalog.sliceNumbered(s)?.project.replace('<app>', app) ?? `slice ${s}`;
            const list = projects.get(project) ?? [];
            if (!list.includes(area.code)) { list.push(area.code); }
            projects.set(project, list);
        }
    }
    const outOfScope = catalog.activeAreas.filter((a) => isOutOfScope(verdictFor(a.code)))
        .map((a) => `${a.code} (${verdictLabel(verdictFor(a.code))})`);
    items.push({
        kind: 'csproj',
        itemTag: 'codespecs-proj',
        ordinal: 1,
        slug: 'scaffold-codespecs-trio',
        title: (id) => `${id.split('_')[0]}: scaffold the CodeSpecs trio ${app}_codespec_shared / _client / _server`,
        description: [
            'Create the three generated projects of codespecs_mapping.md §4.2 in one pass, because they are not '
                + `separable: ${app}_codespec_client and ${app}_codespec_server depend on ${app}_codespec_shared by path.`,
            'Create their pubspecs and dependency edges, and the per-area folders under the project each area is emitted into:',
            ...[...projects].map(([project, codes]) => `- ${project}: ${codes.join(', ')}`),
            ...(outOfScope.length > 0 ? [`Out of this pass (no folders): ${outOfScope.join(', ')}.`] : []),
            'Nothing in it is chosen: given §4.2 and the application name, the whole rung is determined (codespecs_mapping.md §1.1.3).',
        ].join('\n'),
        status: appName ? 'not-started' : 'decision-needed',
        priority: 'medium',
        ...(appName ? {} : {
            decisions: [{
                summary: 'The application name <app> the three projects are named after',
                // The todo schema's own field name (todo.schema.json).
                // eslint-disable-next-line @typescript-eslint/naming-convention
                decision_needed: 'The trio is <app>_codespec_shared, <app>_codespec_client and <app>_codespec_server. '
                    + 'Which application name replaces <app>, and where do the three projects live?',
            }],
        }),
        after: items.map((i) => i.itemTag),
        references: [{ path: MAPPING, description: '§4.2 the three generated projects; §1.1.3 L1' }],
        extraTags: [],
    });

    // L2 — all thirty-one steps, in authoring order.
    const steps: CodeSpecsStep[] = [...catalog.steps].sort((a, b) => a.number - b.number);
    for (const step of steps) {
        const slice = catalog.sliceNumbered(step.slice);
        const areas = step.areaCodes.map((c) => catalog.byCode(c)).filter((a): a is CodeSpecsArea => a !== null);
        const inScope = areas.filter((a) => !isOutOfScope(verdictFor(a.code)));
        const isLast = step.number === steps[steps.length - 1].number;
        items.push({
            kind: 'csgen',
            itemTag: `codespecs-step:${step.number}`,
            ordinal: step.number,
            slug: slugOf(step.title),
            title: (id) => `${id.split('_')[0]}: ${step.title}`,
            description: [
                `Authoring step ${step.number} of ${steps.length} (${STEP_COUNT_NOTE}), slice ${step.slice}`
                    + `${slice ? ` (${slice.title})` : ''}, writing into ${slice?.project.replace('<app>', app) ?? '?'}.`,
                `Areas: ${areas.map((a) => `${a.code} (${verdictLabel(verdictFor(a.code))})`).join(', ')}. Placed by: ${step.placedBy}.`,
                `Read only what tomAi_specCodeSpecsStepContext({extractsDir: '${extractsRel}', step: ${step.number}}) returns: `
                    + 'the step\'s extracts, its §3 contract entries and its output project (codespecs_derivation_contract.md §2.9). '
                    + 'Do not open the specification documents.',
                'First, check the three preconditions of codespecs_mapping.md §1.1.3: the extracts exist and are fresh, the '
                    + 'slice is ready, and every part this step cites was authored by an earlier, completed step. A failed '
                    + 'precondition is not a decision: do not start, fix the cause.',
                'Then create this step\'s L3 todos (cs<area><k>, one per extract entry, in codespecs_mapping.md §4.4.8 order) '
                    + 'and author the step with the §2.9 prompt. A derivation with no admissible output files a csopen todo '
                    + '(decision-needed) and the step continues with the next entry.',
                ...(/SCC-/.test(step.title)
                    ? ['This step is a strongly connected component: author it in the two passes of codespecs_mapping.md §4.4.7, inside this one todo.']
                    : []),
                ...(inScope.length === 0
                    ? ['Every area of this step is out of this pass: confirm there is nothing to author and complete the step '
                        + 'with an empty L3 rung; that outcome is what this todo records.']
                    : []),
                ...(isLast
                    ? [`After this step, validate the trio: tomAi_specCodeSpecsValidate with extractsDir '${extractsRel}'.`]
                    : []),
            ].join('\n'),
            status: 'not-started',
            priority: 'medium',
            after: ['codespecs-proj', ...(step.number > 1 ? [`codespecs-step:${step.number - 1}`] : [])],
            references: [
                ...areas.map((a) => ({ path: extractPath(a.code), description: `${a.code} extract` })),
                { path: CONTRACT, description: '§2.9 the authoring prompt; §3 the contract entries' },
            ],
            extraTags: inScope.length === 0 ? ['out-of-scope'] : [],
        });
    }
    return items;
}

/** The tree with ids, existing todos recognised. */
interface ResolvedItem {
    item: PlannedItem;
    id: string;
    existing: boolean;
}

function resolveIds(items: PlannedItem[], runTag: string, quest: Array<{ id: string; tags?: string[] }>, prefix: string): ResolvedItem[] {
    const existingFor = (itemTag: string): string | undefined =>
        quest.find((t) => t.tags?.includes(runTag) && t.tags.includes(itemTag))?.id;
    // A new csopen continues the quest's csopen numbering, so two runs never share a stem.
    let nextOpen = 1 + Math.max(0, ...quest.map((t) => /^csopen(\d+)/.exec(t.id)).filter((m): m is RegExpExecArray => m !== null)
        .map((m) => Number(m[1])));
    return items.map((item) => {
        const found = existingFor(item.itemTag);
        if (found) { return { item, id: found, existing: true }; }
        const n = item.kind === 'csopen' ? nextOpen++ : item.ordinal;
        return { item, id: `${item.kind}${n}_${prefix}-${item.slug}`, existing: false };
    });
}

export async function codeSpecsPlanTodosImpl(deps: SpecToolDeps, plan: PlanTodoDeps, input: CodeSpecsPlanTodosInput): Promise<string> {
    try {
        if (!input.questId) { throw new CodeSpecsRefusal('invalidInput', 'Pass `questId`: the quest the tree is created in.'); }
        const file = recordPath(deps, input);
        const state = readRecord(deps, file);
        if (!state.exists) {
            throw new CodeSpecsRefusal('noGateRecord', `No gate record at ${toWorkspacePath(deps, file)}. Stage B comes first: `
                + 'record a verdict per area (tomAi_specCodeSpecsSetVerdict).');
        }
        const missing = missingAreas(deps, state.record);
        if (missing.length > 0) {
            throw new CodeSpecsRefusal('incompleteGateRecord',
                `The gate record has no verdict for ${missing.join(', ')}. Every active area needs one before the tree is created `
                + '(codespecs_prompt.md §6).', { missing });
        }
        let gate: { checked: boolean; open?: boolean; failing?: string[] } = { checked: false };
        if (input.file) {
            const a = stageA(deps, input.file);
            gate = { checked: true, open: a.open, failing: a.failing };
            if (!a.open) {
                throw new CodeSpecsRefusal('gateClosed', `Stage A does not pass (${a.failing.join(', ')}): on rejection no todo is `
                    + 'created (codespecs_prompt.md §8.2). Run tomAi_specCodeSpecsGate for the findings.', { stageA: gate });
            }
        }

        const extractsDir = path.dirname(file);
        const extractsRel = toWorkspacePath(deps, extractsDir);
        const runTag = `codespecs-run:${extractsRel}`;
        const items = planItems(deps, (code) => state.record.verdictFor(code), extractsRel, input.appName);
        const resolved = resolveIds(items, runTag, plan.allTodos(input.questId), buildIdPrefix(plan.now()));
        const idOf = new Map(resolved.map((r) => [r.item.itemTag, r.id]));

        const created: string[] = [];
        const warnings: string[] = [];
        if (!input.dryRun) {
            for (const r of resolved.filter((x) => !x.existing)) {
                const result = JSON.parse(await createQuestTodoImpl(plan.todos, {
                    questId: input.questId,
                    ...(input.todoFile ? { file: input.todoFile } : {}),
                    todo: {
                        id: r.id,
                        title: r.item.title(r.id),
                        description: r.item.description,
                        status: r.item.status,
                        priority: r.item.priority,
                        tags: ['codespecs', 'phase4', r.item.kind, runTag, r.item.itemTag, ...r.item.extraTags],
                        dependencies: r.item.after.map((t) => idOf.get(t)).filter((id): id is string => id !== undefined),
                        references: r.item.references,
                        ...(r.item.decisions ? { decisions: r.item.decisions } : {}),
                    },
                } as Parameters<typeof createQuestTodoImpl>[1])) as { ok: boolean; error?: string; warning?: string };
                if (!result.ok) {
                    return json({
                        ok: false, code: 'createFailed', error: `Creating ${r.id} failed: ${result.error}`, created,
                        hint: 'Run the tool again once the cause is fixed: todos already created are recognised and not duplicated.',
                    });
                }
                created.push(r.id);
                if (result.warning) { warnings.push(result.warning); }
            }
        }

        const view = (kind: Kind) => resolved.filter((r) => r.item.kind === kind).map((r) => ({
            id: r.id,
            title: r.item.title(r.id),
            status: r.item.status,
            ...(r.existing ? { existing: true } : {}),
            ...(r.item.extraTags.includes('out-of-scope') ? { outOfScope: true } : {}),
        }));
        const counts: Record<string, number> = {};
        for (const e of state.record.verdicts) {
            const k = e.descoped ? 'descoped' : e.verdict.word;
            counts[k] = (counts[k] ?? 0) + 1;
        }
        const openCount = resolved.filter((r) => r.item.kind === 'csopen').length;
        return json({
            ok: true,
            dryRun: input.dryRun === true,
            questId: input.questId,
            extractsDir: extractsRel,
            gateRecord: toWorkspacePath(deps, file),
            stageA: gate.checked ? gate : { checked: false, note: 'Pass `file` (the spec document) to check Stage A before creating.' },
            verdicts: counts,
            tree: { csopen: view('csopen'), csproj: view('csproj'), csgen: view('csgen') },
            ...(input.dryRun ? {} : { created, existing: resolved.filter((r) => r.existing).map((r) => r.id) }),
            ...(warnings.length > 0 ? { warnings } : {}),
            next: openCount > 0
                ? `Answer the ${openCount} csopen todo(s) first; the queue pauses on them. Then run csproj*, then csgen*.`
                : 'No open questions: run csproj*, then csgen*.',
        });
    } catch (e) {
        return codeSpecsFailure(e);
    }
}

// ---------------------------------------------------------------------------
// Tool definition
// ---------------------------------------------------------------------------

/** The live quest-todo access, loaded on first use (it imports vscode). */
function livePlanDeps(): PlanTodoDeps {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const live = require('./chat-enhancement-tools') as typeof import('./chat-enhancement-tools');
    return { todos: live.liveQuestTodoDeps, allTodos: live.readQuestTodosIncludingTerminal, now: () => new Date() };
}

export const CODESPECS_PLAN_TODOS_TOOL: SharedToolDefinition<CodeSpecsPlanTodosInput> = {
    name: 'tomAi_specCodeSpecsPlanTodos',
    displayName: 'CodeSpecs: Plan Todos',
    description:
        'Stage C of Phase 4 (codespecs_prompt.md §7): propose (`dryRun`) or create the todo tree from the gate record. '
        + 'L0 `csopen<n>`: decision-needed, one per gap line of each area whose verdict is insufficient and not descoped '
        + '(its title the line verbatim), or one per such area carrying the gate note when its entry records no gap lines. L1 `csproj1`: the trio scaffolding (decision-needed when `appName` is not given). L2 `csgen<n>`: all 31 '
        + 'authoring steps, `<n>` the step number, each naming its areas and verdicts, its extracts, its output project and '
        + 'tomAi_specCodeSpecsStepContext as what it reads. Ids come from tomAi_generateIdPrefix; the queue walks csopen*, '
        + 'csproj*, csgen* lowest first and pauses on decision-needed. Refused when the record lacks a verdict for an active '
        + 'area, or (with `file`) when Stage A does not pass. Idempotent: an item already in the quest (live or archived) is '
        + 'reported as existing, not created again.',
    tags: ['tomspecs', 'codespecs', 'todo', 'tom-ai-chat'],
    readOnly: false,
    requiresApproval: true,
    approvalSummary: (input) => `${input.dryRun ? 'Propose' : 'Create'} the Phase-4 todo tree in quest ${input.questId}`
        + ` from ${input.file ?? input.specRoot ?? '?'}`,
    inputSchema: {
        type: 'object',
        properties: {
            file: { ...FILE_PARAM, description: 'The specification document; its record and extracts sit beside it. Also checks Stage A. Or pass `specRoot`.' },
            specRoot: { type: 'string', description: 'The folder holding the specification document (Stage A is then not checked).' },
            questId: { type: 'string', description: 'The quest the todos are created in.' },
            appName: { type: 'string', description: 'The application name in `<app>_codespec_shared` etc.' },
            todoFile: { type: 'string', description: 'A `*.todo.yaml` in the quest folder. Default: the quest\'s own todo file.' },
            dryRun: { type: 'boolean', description: 'Return the proposed tree without creating anything.' },
        },
        required: ['questId'],
    },
    execute: async (input) => codeSpecsPlanTodosImpl(liveDeps(), livePlanDeps(), input),
};

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export const CODESPECS_PLAN_TOOLS: SharedToolDefinition<any>[] = [CODESPECS_PLAN_TODOS_TOOL];
