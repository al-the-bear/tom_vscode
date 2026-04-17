/**
 * Planning & delegation tools.
 *
 * Integration points for host handlers:
 *   - Plan-mode flag: callers read `isPlanModeActive()` to decide whether to
 *     refuse approval-gated tool calls.
 *   - Sub-agent spawner: host calls `registerSubagentSpawner(fn)` at
 *     activation. Until registered, `tomAi_spawnSubagent` returns an
 *     instructive error.
 */

import { SharedToolDefinition } from './shared-tool-registry';

// ---------------------------------------------------------------------------
// Plan-mode state
// ---------------------------------------------------------------------------

let PLAN_MODE_ACTIVE = false;
let PLAN_MODE_ENTERED_AT: number | null = null;
let PLAN_MODE_REASON: string | undefined;

export function isPlanModeActive(): boolean { return PLAN_MODE_ACTIVE; }
export function getPlanModeState(): { active: boolean; enteredAt: number | null; reason?: string } {
    return { active: PLAN_MODE_ACTIVE, enteredAt: PLAN_MODE_ENTERED_AT, reason: PLAN_MODE_REASON };
}

interface EnterPlanModeInput { reason?: string }

async function executeEnterPlanMode(input: EnterPlanModeInput): Promise<string> {
    PLAN_MODE_ACTIVE = true;
    PLAN_MODE_ENTERED_AT = Date.now();
    PLAN_MODE_REASON = input.reason;
    return JSON.stringify({
        planMode: 'entered',
        enteredAt: new Date(PLAN_MODE_ENTERED_AT).toISOString(),
        reason: input.reason ?? null,
        note: 'Approval-gated tools are still executable; plan mode is a signal to prefer reading/thinking over acting. Host handler may tighten enforcement.',
    });
}

export const ENTER_PLAN_MODE_TOOL: SharedToolDefinition<EnterPlanModeInput> = {
    name: 'tomAi_enterPlanMode',
    displayName: 'Enter Plan Mode',
    description:
        'Signal that the model is planning and should avoid mutating tools. Mirrors the Agent SDK\'s plan mode on the direct transport.',
    tags: ['planning', 'state', 'tom-ai-chat'],
    readOnly: false,
    requiresApproval: false,
    inputSchema: {
        type: 'object',
        properties: {
            reason: { type: 'string', description: 'Why you are entering plan mode.' },
        },
    },
    execute: executeEnterPlanMode,
};

interface ExitPlanModeInput { plan?: string }

async function executeExitPlanMode(input: ExitPlanModeInput): Promise<string> {
    const wasActive = PLAN_MODE_ACTIVE;
    const durationMs = PLAN_MODE_ENTERED_AT ? Date.now() - PLAN_MODE_ENTERED_AT : null;
    PLAN_MODE_ACTIVE = false;
    PLAN_MODE_ENTERED_AT = null;
    PLAN_MODE_REASON = undefined;
    return JSON.stringify({
        planMode: 'exited',
        wasActive,
        durationMs,
        plan: input.plan ?? null,
    });
}

export const EXIT_PLAN_MODE_TOOL: SharedToolDefinition<ExitPlanModeInput> = {
    name: 'tomAi_exitPlanMode',
    displayName: 'Exit Plan Mode',
    description:
        'Signal that planning is done and execution can proceed. Optionally attach the final plan text.',
    tags: ['planning', 'state', 'tom-ai-chat'],
    readOnly: false,
    requiresApproval: false,
    inputSchema: {
        type: 'object',
        properties: {
            plan: { type: 'string', description: 'Summary of the plan the model has arrived at.' },
        },
    },
    execute: executeExitPlanMode,
};

// ---------------------------------------------------------------------------
// Sub-agent spawner — plug-in point
// ---------------------------------------------------------------------------

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

type SubagentSpawner = (options: SubagentSpawnOptions) => Promise<SubagentSpawnResult>;

let SUBAGENT_SPAWNER: SubagentSpawner | null = null;

export function registerSubagentSpawner(fn: SubagentSpawner | null): void {
    SUBAGENT_SPAWNER = fn;
}

interface SpawnSubagentInput {
    prompt: string;
    systemPrompt?: string;
    enabledTools?: string[];
    maxRounds?: number;
    temperature?: number;
}

async function executeSpawnSubagent(input: SpawnSubagentInput): Promise<string> {
    if (!input.prompt) { return JSON.stringify({ error: 'prompt is required' }); }
    if (!SUBAGENT_SPAWNER) {
        return JSON.stringify({
            error: 'Sub-agent spawner is not registered.',
            hint: 'The Anthropic handler must call registerSubagentSpawner() at activation to wire this tool. On the Agent SDK transport, prefer the built-in Task tool (enable useBuiltInTools in the profile).',
        });
    }
    try {
        const result = await SUBAGENT_SPAWNER({
            prompt: input.prompt,
            systemPrompt: input.systemPrompt,
            enabledTools: input.enabledTools,
            maxRounds: input.maxRounds,
            temperature: input.temperature,
        });
        return JSON.stringify(result, null, 2);
    } catch (err: any) {
        return JSON.stringify({ error: `Sub-agent failed: ${err?.message ?? err}` });
    }
}

export const SPAWN_SUBAGENT_TOOL: SharedToolDefinition<SpawnSubagentInput> = {
    name: 'tomAi_spawnSubagent',
    displayName: 'Spawn Sub-Agent',
    description:
        'Run a sub-agent conversation with a narrower system prompt and tool set; returns the final summary. ' +
        'On the Agent SDK transport, prefer the built-in Task tool. ' +
        'Requires the host handler to register a spawner; until registered this tool reports an integration error.',
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
            maxRounds: { type: 'number', description: 'Max tool-use rounds. Default 10.' },
            temperature: { type: 'number', description: 'Optional temperature override.' },
        },
    },
    execute: executeSpawnSubagent,
};

// ---------------------------------------------------------------------------
// Master list
// ---------------------------------------------------------------------------

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export const PLANNING_TOOLS: SharedToolDefinition<any>[] = [
    ENTER_PLAN_MODE_TOOL,
    EXIT_PLAN_MODE_TOOL,
    SPAWN_SUBAGENT_TOOL,
];
