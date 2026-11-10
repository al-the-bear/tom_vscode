/**
 * The agent's tools for nested processes (CC-54): look at the quest's process
 * stack and suggest — never start or abort — a subprocess or branch.
 *
 * - `tomAi_getProcessStack`: every level, bottom to top.
 * - `tomAi_listSubprocessCandidates`: what the running step lists (both lists).
 * - `tomAi_suggestSubprocess`: suggestions with reasons, kept with the step;
 *   the user sees them in the process branching editor once the step's queue
 *   items are done (or at once when nothing runs).
 * - `tomAi_getSubprocessRuns`: what was started from a level so far.
 *
 * `tomAi_getProcessState {level}` reads any level; `tomAi_setProcessState`
 * moves only the running one (quest-process-tools.ts).
 */

import type { SharedToolDefinition } from './shared-tool-registry';
import type { LevelPosition, ProcessDefinition, ProcessState, ProcessChangeResult, NestedFollowUp, NestedKind } from '../utils/processDefinition';
import { positionText } from '../utils/processActionPrompt';
import { branchingCards } from '../utils/processBranchingPlan';
import { NESTED_FOLLOW_UP_LABELS, startedHere, type SuggestionInput } from '../utils/processStack';
import { resolveLevelIndex } from './quest-process-tools';

/** What the tools read and do. */
export interface ProcessStackDeps {
    activeQuest(): string;
    /** The quest's process stack, bottom first. */
    levels(): ProcessState[];
    definitions(): ReadonlyMap<string, ProcessDefinition>;
    suggest(input: SuggestionInput[]): ProcessChangeResult;
    /** Whether a queue run of the running level's step is open (its suggestions wait for it). */
    stepRunning(): boolean;
    /** Show the running step's suggestions now (the process branching editor). */
    showSuggestions(): void;
}

const json = (v: unknown): string => JSON.stringify(v, null, 2);

function where(deps: ProcessStackDeps, level: ProcessState): string {
    const def = deps.definitions().get(level.process);
    return def ? positionText(def, level) : [level.phase, level.step].filter(Boolean).join(' › ');
}

// ---- tomAi_getProcessStack ---------------------------------------------------

export async function getProcessStackImpl(deps: ProcessStackDeps): Promise<string> {
    const levels = deps.levels();
    return json({
        ok: true,
        quest: deps.activeQuest(),
        levels: levels.map((l, i) => ({
            level: i,
            running: i === levels.length - 1,
            kind: l.nested?.kind ?? 'process',
            process: l.process,
            name: deps.definitions().get(l.process)?.name ?? l.process,
            phase: l.phase, phaseIteration: l.phaseIteration,
            step: l.step, stepIteration: l.stepIteration,
            substep: l.substep, substepIteration: l.substepIteration,
            position: where(deps, l),
            ...(i > 0 ? { startedFrom: `${levels[i - 1].process} › ${where(deps, levels[i - 1])}` } : {}),
            ...(l.nested ? { followUp: l.nested.followUp, followUpText: NESTED_FOLLOW_UP_LABELS[l.nested.followUp], startedAt: l.nested.startedAt } : {}),
            ...(l.inputs ? { inputs: l.inputs } : {}),
            ...(l.outputs ? { outputs: l.outputs } : {}),
            ...(l.subOutputs ? { subOutputs: l.subOutputs } : {}),
            ...(l.suggestions?.length ? { suggestions: l.suggestions } : {}),
            ...(l.completed ? { completed: true } : {}),
            ...(l.decision || l.nestedEnded ? { atDecision: true } : {}),
        })),
    });
}

export const GET_PROCESS_STACK_TOOL: SharedToolDefinition<Record<string, never>> = {
    name: 'tomAi_getProcessStack',
    displayName: 'Get Process Stack',
    description:
        'The active quest\'s process stack, bottom to top: level 0 is the quest\'s own process, every level above a subprocess ' +
        'or branch started from the step of the level below, which waits for it; the last one runs. Per level: kind, process, ' +
        'phase / step / sub-step with iterations, the position as text, the step it was started from, its follow-up (what that ' +
        'step does when it ends) and start time, inputs, outputs, outputs handed back to it, open suggestions. Read-only; ' +
        'tomAi_getProcessState {level} gives one level\'s context.',
    tags: ['process', 'quest', 'tom-ai-chat'],
    readOnly: true,
    inputSchema: { type: 'object', properties: {} },
    execute: async () => getProcessStackImpl(liveDeps()),
};

// ---- tomAi_listSubprocessCandidates -----------------------------------------

export async function listSubprocessCandidatesImpl(deps: ProcessStackDeps): Promise<string> {
    const levels = deps.levels();
    const top = levels[levels.length - 1];
    const def = top?.process ? deps.definitions().get(top.process) ?? null : null;
    if (!def) { return json({ ok: false, error: 'the quest has no process running' }); }
    const suggested = (top.suggestions ?? []).map((x) => ({ kind: x.kind, process: x.process, reason: x.reason, ...(x.followUp ? { followUp: x.followUp } : {}) }));
    const cards = branchingCards(def, top, deps.definitions(), positionText, suggested);
    return json({
        ok: true,
        step: positionText(def, top),
        candidates: cards.map((c) => ({
            kind: c.kind, process: c.process, name: c.name, summary: c.summary,
            ...(c.description ? { description: c.description } : {}),
            startsAt: c.startsAt, valid: c.valid,
            inputs: c.inputs,
            ...(c.reason ? { suggested: c.reason } : {}),
        })),
        note: cards.length
            ? 'Only these may start from this step. Suggest one (tomAi_suggestSubprocess) as the last thing of the step; the user starts it or not.'
            : 'This step lists no subprocesses or branches.',
    });
}

export const LIST_SUBPROCESS_CANDIDATES_TOOL: SharedToolDefinition<Record<string, never>> = {
    name: 'tomAi_listSubprocessCandidates',
    displayName: 'List Subprocess Candidates',
    description:
        'The processes the running step may start — its `subprocesses:` (a level that hands a result back) and `branches:` ' +
        '(hands nothing back); closed lists, nothing else starts from it. Each with kind, name, summary, the step\'s description of ' +
        'it, where it starts, the inputs the step fills, and whether it was suggested already. What tomAi_suggestSubprocess picks ' +
        'from. Read-only.',
    tags: ['process', 'quest', 'tom-ai-chat'],
    readOnly: true,
    inputSchema: { type: 'object', properties: {} },
    execute: async () => listSubprocessCandidatesImpl(liveDeps()),
};

// ---- tomAi_suggestSubprocess --------------------------------------------------

export interface SuggestSubprocessInput {
    suggestions: Array<{ process: string; kind?: NestedKind; reason: string; followUp?: NestedFollowUp }>;
}

export async function suggestSubprocessImpl(deps: ProcessStackDeps, input: SuggestSubprocessInput): Promise<string> {
    const list = Array.isArray(input?.suggestions) ? input.suggestions : [];
    const result = deps.suggest(list);
    if (!result.ok) { return json(result); }
    const running = deps.stepRunning();
    if (!running) { deps.showSuggestions(); }
    return json({
        ok: true,
        suggestions: result.state.suggestions ?? [],
        shown: running
            ? 'when the step\'s queue items are done: the process branching editor opens then, and the step\'s move waits for the user\'s choice'
            : 'now: no queue run of this step is open, so the process branching editor is open for the user',
        note: 'Nothing was started. The user starts one of them, or dismisses them.',
    });
}

export const SUGGEST_SUBPROCESS_TOOL: SharedToolDefinition<SuggestSubprocessInput> = {
    name: 'tomAi_suggestSubprocess',
    displayName: 'Suggest Subprocess',
    description:
        'Suggest processes the running step lists (tomAi_listSubprocessCandidates) to the user, each with your `reason` and ' +
        'optionally the `followUp` you recommend for the step when it ends (`go-on` past the step, `run-again`, `ask`). Call it ' +
        'as the LAST thing of the step, never in the middle. Answers at once and starts nothing: the suggestions are kept with ' +
        'the step; once the step\'s queue items are done the process branching editor opens and the step\'s move waits for the ' +
        'user, who starts one or dismisses them. A process suggested again replaces its earlier suggestion; one the step does ' +
        'not list is refused.',
    tags: ['process', 'quest', 'tom-ai-chat'],
    readOnly: false,
    // Starts nothing: a note for the user, visible in the PROCESS view.
    requiresApproval: false,
    inputSchema: {
        type: 'object',
        required: ['suggestions'],
        properties: {
            suggestions: {
                type: 'array',
                minItems: 1,
                items: {
                    type: 'object',
                    required: ['process', 'reason'],
                    properties: {
                        process: { type: 'string', description: 'A process id the step lists.' },
                        kind: { type: 'string', enum: ['subprocess', 'branch'], description: 'Needed only when the step lists it in both.' },
                        reason: { type: 'string', description: 'Why it is worth starting now.' },
                        followUp: { type: 'string', enum: ['ask', 'go-on', 'run-again'], description: 'What you recommend the step does when it ends.' },
                    },
                },
            },
        },
    },
    execute: async (input) => suggestSubprocessImpl(liveDeps(), input),
};

// ---- tomAi_getSubprocessRuns --------------------------------------------------

export async function getSubprocessRunsImpl(deps: ProcessStackDeps, input: { level?: number; all?: boolean } = {}): Promise<string> {
    const levels = deps.levels();
    const index = resolveLevelIndex(levels.length, input.level);
    if (typeof index !== 'number') { return json({ ok: false, error: index.error }); }
    const level = levels[index];
    const runs = (level.nestedRuns ?? []).filter((r) => input.all === true || startedHere(r, level));
    const def = deps.definitions().get(level.process);
    const at = (p: LevelPosition, process: string): string => {
        const d = deps.definitions().get(process);
        return d ? positionText(d, { process, ...p, completed: false }) : [p.phase, p.step].filter(Boolean).join(' › ');
    };
    return json({
        ok: true,
        level: index,
        process: level.process,
        step: def ? positionText(def, level) : level.step,
        scope: input.all === true ? 'every step of this level' : 'this step, in its current iteration',
        runs: runs.map((r) => ({
            process: r.process, kind: r.kind, outcome: r.outcome,
            followUp: r.followUp, startedAt: r.startedAt, endedAt: r.endedAt,
            from: at(r.from, level.process),
            // Where it stood when it ended: an aborted one was left there.
            left: at(r.left, r.process),
            ...(r.outputs ? { outputs: r.outputs } : {}),
        })),
    });
}

export const GET_SUBPROCESS_RUNS_TOOL: SharedToolDefinition<{ level?: number; all?: boolean }> = {
    name: 'tomAi_getSubprocessRuns',
    displayName: 'Get Subprocess Runs',
    description:
        'The subprocesses and branches started from a level of the quest\'s process stack (`level`: 0 the bottom, -1 the running ' +
        'level and the default), from its current step and iteration (`all: true`: from every step): finished or aborted, when, ' +
        'the follow-up chosen, where an aborted one was left, the outputs a finished subprocess handed back — so a step run ' +
        'again can work their results in. Read-only.',
    tags: ['process', 'quest', 'tom-ai-chat'],
    readOnly: true,
    inputSchema: {
        type: 'object',
        properties: {
            level: { type: 'number', description: '0 the bottom, -1 the top (default), -2 the one below it.' },
            all: { type: 'boolean', description: 'Every step of the level, not only the current one.' },
        },
    },
    execute: async (input) => getSubprocessRunsImpl(liveDeps(), input ?? {}),
};

// ---- Live wiring ---------------------------------------------------------------

function liveDeps(): ProcessStackDeps {
    // Required lazily: the store and the queue need `vscode`; the impls above are tested without it.
    const store = (): import('../managers/processStateStore').ProcessStateStore => {
        // eslint-disable-next-line @typescript-eslint/no-require-imports
        const s = require('../managers/processStateStore.js').ProcessStateStore.instance;
        if (!s) { throw new Error('the process store is not initialised'); }
        return s;
    };
    return {
        activeQuest: () => store().activeQuest,
        levels: () => store().levels,
        definitions: () => store().definitions(),
        suggest: (input) => store().suggest(input, 'anthropic'),
        stepRunning: () => {
            try {
                // eslint-disable-next-line @typescript-eslint/no-require-imports
                const queue = require('../managers/promptQueueManager.js').PromptQueueManager.instance;
                const progress = queue?.stepRunProgress(store().activeQuest, store().levelIndex);
                return !!progress && !progress.held;
            } catch { return false; }
        },
        showSuggestions: () => {
            // eslint-disable-next-line @typescript-eslint/no-require-imports
            try { require('../services/processActionService.js').suggestionsDue(); } catch { /* the view lists them too */ }
        },
    };
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export const PROCESS_STACK_TOOLS: SharedToolDefinition<any>[] = [
    GET_PROCESS_STACK_TOOL,
    LIST_SUBPROCESS_CANDIDATES_TOOL,
    SUGGEST_SUBPROCESS_TOOL,
    GET_SUBPROCESS_RUNS_TOOL,
];
