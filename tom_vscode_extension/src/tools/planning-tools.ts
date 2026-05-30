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
 *   - Plan mode is **advisory** — flipping the flag does NOT gate any
 *     tool by itself.  Host handlers read `isPlanModeActive()` and may
 *     refuse to execute approval-gated tools while it is true.  The
 *     description was rewritten to say this explicitly (old text
 *     "Mirrors the Agent SDK's plan mode" was opaque to consumers
 *     not already familiar with the SDK).
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

import { SharedToolDefinition } from './shared-tool-registry';

// ===========================================================================
// JSON envelopes
// ===========================================================================

function ok<T extends object>(extra: T): string { return JSON.stringify({ ok: true, ...extra }); }
function err(message: string, extra: Record<string, unknown> = {}): string {
    return JSON.stringify({ ok: false, error: message, ...extra });
}

// ===========================================================================
// Plan-mode state (process-global advisory flag)
// ===========================================================================

interface PlanModeState {
    active: boolean;
    enteredAt: number | null;
    reason?: string;
}

const planMode: PlanModeState = { active: false, enteredAt: null, reason: undefined };

/** Public read of the plan-mode flag for host handlers. */
export function isPlanModeActive(): boolean { return planMode.active; }
export function getPlanModeState(): { active: boolean; enteredAt: number | null; reason?: string } {
    return { active: planMode.active, enteredAt: planMode.enteredAt, reason: planMode.reason };
}

/**
 * Test-only reset of the plan-mode flag.  Each test should call this
 * in a `beforeEach` to avoid order-dependence; the live impl shares
 * the same singleton so production callers must not invoke it.
 */
export function resetPlanModeForTests(): void {
    planMode.active = false;
    planMode.enteredAt = null;
    planMode.reason = undefined;
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
    return ok({
        planMode: 'entered',
        nested: false,
        active: true,
        enteredAt: new Date(planMode.enteredAt).toISOString(),
        reason: input.reason ?? null,
        note: 'Advisory flag — approval-gated tools are still executable. The host handler decides whether to enforce restrictions while planning.',
    });
}

export const ENTER_PLAN_MODE_DESCRIPTION =
    'Flip the **advisory** plan-mode flag, signalling that you are ' +
    'planning and would prefer to read/think rather than mutate. ' +
    '**This does not gate any tool by itself** — host handlers may ' +
    'read `isPlanModeActive()` and decide to refuse approval-gated ' +
    'tools while the flag is set, but the flag alone never causes a ' +
    'refusal. Calling this while already in plan mode returns ' +
    '`{nested: true}` and preserves the original entry context ' +
    '(`originalEnteredAt`, `originalReason`); call ' +
    '`tomAi_exitPlanMode` first if you want to refresh the reason.';

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
    if (!planMode.active) {
        return ok({
            planMode: 'exited',
            wasActive: false,
            noOp: true,
            plan: input.plan ?? null,
            note: 'exitPlanMode called while plan mode was not active.',
        });
    }
    const durationMs = planMode.enteredAt ? clock.now() - planMode.enteredAt : null;
    planMode.active = false;
    planMode.enteredAt = null;
    planMode.reason = undefined;
    return ok({
        planMode: 'exited',
        wasActive: true,
        noOp: false,
        durationMs,
        plan: input.plan ?? null,
    });
}

export const EXIT_PLAN_MODE_DESCRIPTION =
    'Clear the advisory plan-mode flag and report how long planning ' +
    'took (`durationMs`). Optionally attach the final `plan` text — ' +
    'the value is echoed back in the response so caller-side tools can ' +
    'capture it. Calling this while plan mode is NOT active returns ' +
    '`{wasActive: false, noOp: true}` (not an error) so "exit twice" is ' +
    'safe and observable.';

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
            plan: { type: 'string', description: 'Summary of the plan the model has arrived at.' },
        },
    },
    execute: (input) => exitPlanModeImpl(input),
};

// ===========================================================================
// Sub-agent spawner — plug-in point
// ===========================================================================

export interface SubagentSpawnOptions {
    prompt: string;
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
        });
    } catch (e) {
        return err(`Sub-agent failed: ${(e as Error).message}`);
    }
}

export const SPAWN_SUBAGENT_DESCRIPTION =
    'Run a sub-agent conversation with a narrower system prompt and ' +
    'tool-name allow-list; the sub-agent returns a final summary plus ' +
    'metadata (`rounds`, `toolCalls`, `stopReason`). The sub-agent is ' +
    'an independent conversation — it does NOT see this conversation\'s ' +
    'history and cannot mutate this conversation\'s tool-result store. ' +
    'On the Agent SDK transport, prefer the built-in Task tool ' +
    '(enable `useBuiltInTools` in the profile) — `spawnSubagent` is the ' +
    'direct-transport equivalent. Requires the host to register a ' +
    'spawner at activation; until then the tool returns ' +
    '`{ok: false, error: "Sub-agent spawner is not registered."}`. ' +
    '**Concurrency**: multiple parallel sub-agent calls share one ' +
    'spawner closure — the host is responsible for serialising if its ' +
    'implementation is not re-entrant.';

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
