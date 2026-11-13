/**
 * Planning & delegation tools.
 *
 *   - tomAi_enterPlanMode  — flip the advisory "I am planning" flag
 *   - tomAi_exitPlanMode   — clear the flag, optionally attaching the plan
 *   - tomAi_spawnSubagent  — run a sub-agent conversation via a host-
 *                            registered spawner
 *
 * ## Coverage entry #25 refactor (audit notes)
 *
 *   - Plan mode **gates writes** (CC-3): while it is on, every transport
 *     refuses a write tool with {@link PLAN_MODE_REFUSAL} before it runs —
 *     the direct / Local LLM / VS Code LM tool loop in `runTool`, the Agent
 *     SDK in `canUseTool`, in its MCP tool handlers (which run even when
 *     `canUseTool` is bypassed) and through its own `plan` permission mode.
 *     {@link planModeRefusalFor} is the one rule.
 *   - **Only the user leaves it** (CC-27): `tomAi_exitPlanMode {plan}`
 *     shows the plan to the user ({@link registerPlanDecider}, the chat
 *     panel) with "Accept and leave plan mode" / "Keep planning"; the
 *     panel's plan-mode badge leaves it directly ({@link leavePlanModeByUser}).
 *   - **Nested enter** is now surfaced explicitly: a second
 *     `enterPlanMode` while already active returns `nested: true` and
 *     preserves the original `enteredAt` / `originalReason`, so the
 *     model can tell it's already in the state instead of getting a
 *     silent overwrite that loses the original entry context.
 *   - **Inactive exit** now returns `wasActive: false, noOp: true` so
 *     "exit called twice" is detectable.
 *   - **Spawner contract** is documented at the dep boundary:
 *     spawners are expected to be re-entrant (multiple parallel calls
 *     are the host's responsibility) and to throw on unrecoverable
 *     errors; the impl catches and wraps in `ok: false`.
 *   - All three tools now use the `{ok, ...}` / `{ok: false, error,
 *     ...}` envelope; before, `spawnSubagent` returned raw spawner
 *     results without an `ok` flag, indistinguishable from a free-form
 *     error string.
 */

import { currentInteractionRun } from '../services/userWaits';
import { SharedToolDefinition } from './shared-tool-registry';
import { builtInToolNeedsApproval } from '../utils/agentSdkPermissionMode';

// ===========================================================================
// JSON envelopes
// ===========================================================================

function ok<T extends object>(extra: T): string { return JSON.stringify({ ok: true, ...extra }); }
function err(message: string, extra: Record<string, unknown> = {}): string {
    return JSON.stringify({ ok: false, error: message, ...extra });
}

// ===========================================================================
// Plan-mode state: one per process run (vscimpb81)
// ===========================================================================

interface PlanModeState {
    active: boolean;
    enteredAt: number | null;
    reason?: string;
}

/**
 * Plan mode per process run: a turn of one run that enters it does not hold
 * another run's writes. The run is the calling turn's (`currentInteractionRun`).
 */
const planModes = new Map<string, PlanModeState>();

function stateOf(run: string = currentInteractionRun()): PlanModeState {
    let state = planModes.get(run);
    if (!state) { state = { active: false, enteredAt: null, reason: undefined }; planModes.set(run, state); }
    return state;
}

/** Whether plan mode is on in run `run` (default: the calling turn's run). */
export function isPlanModeActive(run?: string): boolean { return stateOf(run).active; }

/** What a write tool answers while plan mode is on, on every transport. */
export const PLAN_MODE_REFUSAL = 'plan mode: read and plan only — present your plan and call tomAi_exitPlanMode';

/**
 * Tools that run in plan mode although they are not read-only: entering and
 * leaving it, and talking to the user (asking is part of planning; nothing in
 * the workspace changes).
 */
export const PLAN_MODE_ALLOWED_TOOLS: ReadonlySet<string> = new Set([
    'tomAi_enterPlanMode', 'tomAi_exitPlanMode', 'tomAi_askUser', 'tomAi_askUserPicker', 'tomAi_notifyUser',
]);

/**
 * The refusal for a tool call while plan mode is on, or undefined when it may
 * run. `def` is the extension tool's definition — a write tool is one that is
 * not `readOnly` (the MCP read-only floor's rule); without one the name is a
 * Claude Code built-in, refused when it writes (agentSdkPermissionMode's
 * writer / reader lists; a built-in neither knows counts as a writer).
 */
export function planModeRefusalFor(toolName: string, def: { readOnly?: boolean } | undefined): string | undefined {
    if (!stateOf().active || PLAN_MODE_ALLOWED_TOOLS.has(toolName)) { return undefined; }
    if (def) { return def.readOnly ? undefined : PLAN_MODE_REFUSAL; }
    return builtInToolNeedsApproval(toolName) ? PLAN_MODE_REFUSAL : undefined;
}

type PlanModeListener = (active: boolean, run: string) => void;
const listeners = new Set<PlanModeListener>();

/** Be told when plan mode goes on or off (the chat panel's badge, a running Agent SDK query). Answers the unsubscribe. */
export function onPlanModeChanged(listener: PlanModeListener): () => void {
    listeners.add(listener);
    return () => { listeners.delete(listener); };
}

function notifyPlanMode(run: string = currentInteractionRun()): void {
    for (const l of [...listeners]) {
        try { l(stateOf(run).active, run); } catch { /* a listener's failure is its own */ }
    }
}

/** The user's answer to a proposed plan. */
export interface PlanDecision {
    accepted: boolean;
    /** What the user said along with "Keep planning", if anything. */
    feedback?: string;
    /** The prompt that proposed the plan ended (or was cancelled) before the user decided (vscimpb78). */
    promptEnded?: boolean;
}

/** The note of a plan closed because the prompt that proposed it ended. */
export const PLAN_PROMPT_ENDED_NOTE = 'The prompt that proposed this plan has ended; the plan was closed undecided and plan mode stays on.';

/** Shows a proposed plan to the user and answers their decision (registered by the chat panel). */
export type PlanDecider = (plan: string) => Promise<PlanDecision>;
let planDecider: PlanDecider | undefined;

/** Register how a proposed plan reaches the user; `undefined` unregisters. */
export function registerPlanDecider(decider: PlanDecider | undefined): void {
    planDecider = decider;
}

function clearPlanMode(run?: string): number | null {
    const planMode = stateOf(run);
    const durationMs = planMode.enteredAt ? Date.now() - planMode.enteredAt : null;
    planMode.active = false;
    planMode.enteredAt = null;
    planMode.reason = undefined;
    return durationMs;
}

/** The user leaves plan mode (the panel's badge, or accepting a plan). Answers whether it was on. */
export function leavePlanModeByUser(run?: string): boolean {
    const target = run ?? currentInteractionRun();
    if (!stateOf(target).active) { return false; }
    clearPlanMode(target);
    notifyPlanMode(target);
    return true;
}
export function getPlanModeState(run?: string): { active: boolean; enteredAt: number | null; reason?: string } {
    const planMode = stateOf(run);
    return { active: planMode.active, enteredAt: planMode.enteredAt, reason: planMode.reason };
}

/**
 * Test-only reset of the plan-mode flag.  Each test should call this
 * in a `beforeEach` to avoid order-dependence; the live impl shares
 * the same singleton so production callers must not invoke it.
 */
export function resetPlanModeForTests(): void {
    planModes.clear();
    planDecider = undefined;
    listeners.clear();
}

// ===========================================================================
// `tomAi_enterPlanMode`
// ===========================================================================

export interface EnterPlanModeInput { reason?: string }

/**
 * Optional clock dep so tests can pin `enteredAt`.  Production calls
 * the no-arg overload which uses `Date.now()`.
 */
export interface PlanModeClock { now(): number }
const realClock: PlanModeClock = { now: () => Date.now() };

export async function enterPlanModeImpl(input: EnterPlanModeInput, clock: PlanModeClock = realClock): Promise<string> {
    // The calling turn's run (vscimpb81): plan mode is per process run.
    const planMode = stateOf();
    if (planMode.active) {
        // Nested entry: report it explicitly, preserve the original
        // state.  The model can decide whether to ignore (it was
        // already planning) or to exit-then-re-enter to refresh the
        // reason.
        return ok({
            planMode: 'entered',
            nested: true,
            active: true,
            originalEnteredAt: planMode.enteredAt ? new Date(planMode.enteredAt).toISOString() : null,
            originalReason: planMode.reason ?? null,
            note: 'Plan mode was already active. Original enteredAt/reason preserved.',
        });
    }
    planMode.active = true;
    planMode.enteredAt = clock.now();
    planMode.reason = input.reason;
    notifyPlanMode();
    return ok({
        planMode: 'entered',
        nested: false,
        active: true,
        enteredAt: new Date(planMode.enteredAt).toISOString(),
        reason: input.reason ?? null,
        note: 'Write tools are refused until the user leaves plan mode: read, plan, then call tomAi_exitPlanMode with your plan.',
    });
}

export const ENTER_PLAN_MODE_DESCRIPTION =
    'Enter plan mode for your process run (other runs are not affected): until the user leaves it, every write tool — the ' +
    '`tomAi_*` writers and Claude Code\'s writing built-ins (Bash, Write, ' +
    'Edit, …) — is refused with "' + PLAN_MODE_REFUSAL + '", on every ' +
    'transport; reading tools, tomAi_askUser / tomAi_askUserPicker / ' +
    'tomAi_notifyUser still run. Read and plan, then propose the plan with ' +
    '`tomAi_exitPlanMode {plan}`: the user accepts it (plan mode ends) or ' +
    'asks you to keep planning. You cannot leave plan mode yourself. ' +
    'Calling this while already in plan mode returns `{nested: true}` ' +
    'and keeps the original entry context.';

export const ENTER_PLAN_MODE_TOOL: SharedToolDefinition<EnterPlanModeInput> = {
    name: 'tomAi_enterPlanMode',
    displayName: 'Enter Plan Mode',
    description: ENTER_PLAN_MODE_DESCRIPTION,
    tags: ['planning', 'state', 'tom-ai-chat'],
    readOnly: false,
    requiresApproval: false,
    inputSchema: {
        type: 'object',
        properties: {
            reason: { type: 'string', description: 'Why you are entering plan mode.' },
        },
    },
    execute: (input) => enterPlanModeImpl(input),
};

// ===========================================================================
// `tomAi_exitPlanMode`
// ===========================================================================

export interface ExitPlanModeInput { plan?: string }

export async function exitPlanModeImpl(input: ExitPlanModeInput, clock: PlanModeClock = realClock): Promise<string> {
    // The calling turn's run (vscimpb81): plan mode is per process run.
    const planMode = stateOf();
    if (!planMode.active) {
        return ok({
            planMode: 'exited',
            wasActive: false,
            noOp: true,
            plan: input.plan ?? null,
            note: 'exitPlanMode called while plan mode was not active.',
        });
    }
    const plan = typeof input.plan === 'string' ? input.plan.trim() : '';
    if (!plan) {
        return err('Pass the plan you propose in `plan`: the user reads it and accepts it (plan mode ends) or asks you to keep planning.', { planMode: 'active' });
    }
    if (!planDecider) {
        return err('Plan mode is left by the user, and there is no panel here to show the plan in. The user can leave it with the plan-mode badge of the ANTHROPIC/LLM panel.', { planMode: 'active', plan });
    }
    let decision: PlanDecision;
    try {
        decision = await planDecider(plan);
    } catch (e) {
        return err(`The plan could not be shown to the user: ${(e as Error).message}`, { planMode: 'active', plan });
    }
    if (!decision.accepted && decision.promptEnded) {
        return ok({ planMode: 'active', accepted: false, promptEnded: true, plan, note: PLAN_PROMPT_ENDED_NOTE });
    }
    if (!decision.accepted) {
        return ok({
            planMode: 'active',
            accepted: false,
            plan,
            ...(decision.feedback ? { feedback: decision.feedback } : {}),
            note: 'The user wants you to keep planning: plan mode stays on. Revise the plan and propose it again.',
        });
    }
    // The user may have left plan mode with the badge while the plan was shown.
    const enteredAt = planMode.enteredAt;
    const durationMs = enteredAt ? clock.now() - enteredAt : null;
    leavePlanModeByUser();
    return ok({
        planMode: 'exited',
        accepted: true,
        wasActive: true,
        noOp: false,
        durationMs,
        plan,
        note: 'The user accepted the plan: plan mode is off, write tools run again. Carry out the plan.',
    });
}

export const EXIT_PLAN_MODE_DESCRIPTION =
    'Propose your plan to the user and ask to leave plan mode: `plan` ' +
    '(required, markdown) is shown in the user-input panel on your run\'s tab and in the ANTHROPIC/LLM panel with ' +
    '"Accept and leave plan mode" / "Keep planning", and the call waits ' +
    'for the answer. Accepted: `{accepted: true, planMode: "exited"}` — ' +
    'write tools run again, carry out the plan. Keep planning: ' +
    '`{accepted: false, planMode: "active", feedback?}` — revise and ' +
    'propose again. Only the user ends plan mode. Called while plan ' +
    'mode is not on: `{wasActive: false, noOp: true}`.';

export const EXIT_PLAN_MODE_TOOL: SharedToolDefinition<ExitPlanModeInput> = {
    name: 'tomAi_exitPlanMode',
    displayName: 'Exit Plan Mode',
    description: EXIT_PLAN_MODE_DESCRIPTION,
    tags: ['planning', 'state', 'tom-ai-chat'],
    readOnly: false,
    requiresApproval: false,
    inputSchema: {
        type: 'object',
        properties: {
            plan: { type: 'string', description: 'The plan you propose, as markdown; the user accepts it or asks you to keep planning. Required while plan mode is on.' },
        },
    },
    execute: (input) => exitPlanModeImpl(input),
};

// ===========================================================================
// Sub-agent spawner — plug-in point
// ===========================================================================

export interface SubagentSpawnOptions {
    prompt: string;
    /** A Claude Code subagent definition (`.claude/agents/<name>.md`) to run as. */
    agent?: string;
    systemPrompt?: string;
    enabledTools?: string[];
    maxRounds?: number;
    temperature?: number;
}

export interface SubagentSpawnResult {
    summary: string;
    rounds: number;
    toolCalls: number;
    stopReason?: string;
    /** The definition it ran as, the model it ran on, and anything adjusted (unmapped tools, a model not found). */
    agent?: string;
    model?: string;
    notes?: string[];
}

export type SubagentSpawner = (options: SubagentSpawnOptions) => Promise<SubagentSpawnResult>;

/**
 * The host calls this at activation to wire a spawner.  Passing
 * `null` unregisters (used during deactivation + tests).
 *
 * Concurrency contract: the spawner is shared by every caller of
 * `tomAi_spawnSubagent`, so multiple parallel sub-agent calls all
 * arrive at the same closure.  If the host's spawner is not safe to
 * call re-entrantly, the host must serialise internally — the impl
 * does not.
 */
let SUBAGENT_SPAWNER: SubagentSpawner | null = null;

export function registerSubagentSpawner(fn: SubagentSpawner | null): void {
    SUBAGENT_SPAWNER = fn;
}

export function isSubagentSpawnerRegistered(): boolean { return SUBAGENT_SPAWNER !== null; }

// ===========================================================================
// `tomAi_spawnSubagent`
// ===========================================================================

export interface SpawnSubagentInput {
    prompt: string;
    agent?: string;
    systemPrompt?: string;
    enabledTools?: string[];
    maxRounds?: number;
    temperature?: number;
}

/** Optional dep so tests can inject a spawner without touching the singleton. */
export interface SubagentSpawnerLookup { get(): SubagentSpawner | null }
const realLookup: SubagentSpawnerLookup = { get: () => SUBAGENT_SPAWNER };

export async function spawnSubagentImpl(input: SpawnSubagentInput, lookup: SubagentSpawnerLookup = realLookup): Promise<string> {
    if (!input.prompt || !input.prompt.trim()) {
        return err('`prompt` is required.');
    }
    if (input.maxRounds !== undefined && (!Number.isFinite(input.maxRounds) || input.maxRounds < 1)) {
        return err('`maxRounds` must be a positive integer when provided.');
    }
    if (input.temperature !== undefined && (!Number.isFinite(input.temperature) || input.temperature < 0 || input.temperature > 2)) {
        return err('`temperature` must be a finite number in [0, 2] when provided.');
    }
    const spawner = lookup.get();
    if (!spawner) {
        return err('Sub-agent spawner is not registered.', {
            hint: 'The Anthropic handler must call registerSubagentSpawner() at activation to wire this tool. On the Agent SDK transport, prefer the built-in Task tool (enable useBuiltInTools in the profile).',
        });
    }
    try {
        const result = await spawner({
            prompt: input.prompt,
            ...(input.agent ? { agent: input.agent } : {}),
            systemPrompt: input.systemPrompt,
            enabledTools: input.enabledTools,
            maxRounds: input.maxRounds,
            temperature: input.temperature,
        });
        return ok({
            summary: result.summary,
            rounds: result.rounds,
            toolCalls: result.toolCalls,
            stopReason: result.stopReason ?? null,
            ...(result.agent ? { agent: result.agent } : {}),
            ...(result.model ? { model: result.model } : {}),
            ...(result.notes && result.notes.length > 0 ? { notes: result.notes } : {}),
        });
    } catch (e) {
        return err(`Sub-agent failed: ${(e as Error).message}`);
    }
}

export const SPAWN_SUBAGENT_DESCRIPTION =
    'Run a sub-agent conversation with a narrower system prompt and ' +
    'tool-name allow-list; the sub-agent returns a final summary plus ' +
    'metadata (`rounds`, `toolCalls`, `stopReason`, `model`). The sub-agent is ' +
    'an independent conversation — it does NOT see this conversation\'s ' +
    'history. `agent` runs it as a Claude Code subagent definition ' +
    '(`.claude/agents/<name>.md`, the workspace\'s or a parent folder\'s): its body is ' +
    'the system prompt, its `tools` the allow-list (Read, Edit, Bash, … mapped to the ' +
    'tomAi_* equivalents; `notes` names any left out), its `model` the configuration; ' +
    '`systemPrompt` / `enabledTools` given here win. Without an allow-list it gets the ' +
    'read-only tools; it never asks for approval. Its progress shows in the status line. ' +
    'On the Agent SDK the built-in Task tool knows the same definitions. ' +
    'Requires the host to register a spawner at activation; until then the tool returns ' +
    '`{ok: false, error: "Sub-agent spawner is not registered."}`.';

export const SPAWN_SUBAGENT_TOOL: SharedToolDefinition<SpawnSubagentInput> = {
    name: 'tomAi_spawnSubagent',
    displayName: 'Spawn Sub-Agent',
    description: SPAWN_SUBAGENT_DESCRIPTION,
    tags: ['agent', 'delegation', 'tom-ai-chat'],
    readOnly: false,
    requiresApproval: true,
    inputSchema: {
        type: 'object',
        required: ['prompt'],
        properties: {
            prompt: { type: 'string', description: 'Task for the sub-agent.' },
            agent: { type: 'string', description: 'Name of a Claude Code subagent definition (`.claude/agents/<name>.md`) to run as.' },
            systemPrompt: { type: 'string', description: 'Optional system prompt override.' },
            enabledTools: { type: 'array', items: { type: 'string' }, description: 'Tool-name allow-list for the sub-agent.' },
            maxRounds: { type: 'number', description: 'Max tool-use rounds. Default 10. Must be a positive integer.' },
            temperature: { type: 'number', description: 'Optional temperature override. Must be in [0, 2].' },
        },
    },
    execute: (input) => spawnSubagentImpl(input),
};

// ===========================================================================
// Master list
// ===========================================================================

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export const PLANNING_TOOLS: SharedToolDefinition<any>[] = [
    ENTER_PLAN_MODE_TOOL,
    EXIT_PLAN_MODE_TOOL,
    SPAWN_SUBAGENT_TOOL,
];
