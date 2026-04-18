/**
 * Agent SDK Transport — routes an Anthropic handler request through
 * `@anthropic-ai/claude-agent-sdk` instead of `@anthropic-ai/sdk`.
 *
 * Spec: anthropic_sdk_integration.md §18. The direct-SDK path
 * (`AnthropicHandler.sendMessage`) remains default; this transport runs
 * only when `configuration.transport === 'agentSdk'`.
 *
 * What we delegate to the SDK:
 *  - tool-use loop
 *  - prompt caching
 *  - context compaction (so `history-compaction.ts` is skipped for this path)
 *
 * What stays in-extension:
 *  - profile system prompt + `${...}` placeholder resolution (done by the caller)
 *  - trail logging (§4)
 *  - tool trail (§9)
 *  - approval gate (§8.1) — bridged via the SDK's `canUseTool` callback
 *  - keyword triggers (§5.4) — stripped by the caller before we run
 *
 * Memory is NOT injected into the system prompt (§18.4); the agent pulls
 * it via `tomAi_memory_*` tools on demand, which are still exposed through
 * our MCP server when the configuration enables them.
 */

import * as vscode from 'vscode';
import { z } from 'zod';

// The Agent SDK ships as ESM-only (`sdk.mjs`), while the VS Code extension
// host compiles to CommonJS. We load it via dynamic `import()` and cache
// the module. We type the imported module with a local interface that
// mirrors the subset of the SDK we actually use — this avoids pulling the
// SDK's d.ts into the TS compilation (which would emit a `require()` at
// build time and fail for an ESM-only package).

type PermissionMode = 'default' | 'acceptEdits' | 'plan' | 'bypassPermissions' | 'dontAsk' | 'auto';
type SettingSource = 'user' | 'project' | 'local';

type PermissionResult =
    | { behavior: 'allow'; updatedInput?: Record<string, unknown> }
    | { behavior: 'deny'; message: string };

type CanUseTool = (
    toolName: string,
    input: Record<string, unknown>,
    options: { signal: AbortSignal; toolUseID: string },
) => Promise<PermissionResult>;

interface AssistantBody {
    content?: unknown[];
}
interface SDKAssistantMessage {
    type: 'assistant';
    message: AssistantBody;
}
interface SDKUserMessage {
    type: 'user';
    message: unknown;
}
interface SDKResultMessage {
    type: 'result';
    subtype: string;
    num_turns: number;
    stop_reason?: string | null;
    result?: string;
}
type SDKMessage = SDKAssistantMessage | SDKUserMessage | SDKResultMessage | { type: string };

interface McpToolDefinition {
    name: string;
    description: string;
    inputSchema: Record<string, z.ZodTypeAny>;
    handler: (args: Record<string, unknown>, extra: unknown) => Promise<unknown>;
}

interface AgentSdkModule {
    query(params: {
        prompt: string | AsyncIterable<unknown>;
        options?: {
            model?: string;
            systemPrompt?: string;
            maxTurns?: number;
            permissionMode?: PermissionMode;
            settingSources?: SettingSource[];
            abortController?: AbortController;
            canUseTool?: CanUseTool;
            mcpServers?: Record<string, unknown>;
            tools?: string[] | { type: 'preset'; preset: 'claude_code' };
        };
    }): AsyncIterable<SDKMessage>;
    tool(
        name: string,
        description: string,
        inputSchema: Record<string, z.ZodTypeAny>,
        handler: (args: Record<string, unknown>, extra: unknown) => Promise<unknown>,
    ): McpToolDefinition;
    createSdkMcpServer(options: {
        name: string;
        version?: string;
        tools?: McpToolDefinition[];
    }): unknown;
}

let cachedSdk: Promise<AgentSdkModule> | undefined;
async function loadSdk(): Promise<AgentSdkModule> {
    if (!cachedSdk) {
        // `new Function('m', 'return import(m)')` keeps the `import()` out
        // of the TS emit — otherwise `tsc --module commonjs` would rewrite
        // it to `require()` and the ESM-only SDK would fail to load.
        cachedSdk = (new Function('m', 'return import(m)') as (m: string) => Promise<AgentSdkModule>)(
            '@anthropic-ai/claude-agent-sdk',
        );
    }
    return cachedSdk;
}

import { SharedToolDefinition } from '../tools/shared-tool-registry';
import { TrailService } from '../services/trailService';
import { ToolTrail } from '../services/tool-trail';
import { runWithToolContext } from '../services/tool-execution-context';
import type {
    AnthropicConfiguration,
    AnthropicSendResult,
    AnthropicToolApprovalRequest,
} from './anthropic-handler';
import { ANTHROPIC_SUBSYSTEM } from './anthropic-handler';

// ============================================================================
// Context — provided by AnthropicHandler.sendMessage when it delegates here
// ============================================================================

/**
 * Per-call context the handler injects so this transport can reuse the
 * handler's approval gate, tool trail, and trail-logging identifiers.
 */
export interface AgentSdkTransportContext {
    /** Await approval for a write tool (identical semantics to direct path). */
    requestApproval: (req: AnthropicToolApprovalRequest) => Promise<boolean>;
    /** Session-scoped approval bypass set (shared with direct path). */
    sessionApprovals: Set<string>;
    /** Round-aware tool trail shared with the direct path. */
    toolTrail: ToolTrail;
    /** Monotonic round number for this send call. */
    round: number;
    /** Quest id for trail path resolution. */
    questId: string;
    /** VS Code session id. */
    windowId: string;
    /** Unique id for this request in the raw trail. */
    requestId: string;
}

export interface AgentSdkSendParams {
    configuration: AnthropicConfiguration;
    tools: SharedToolDefinition[];
    /** Fully-resolved system prompt (profile + placeholders; no memory injection). */
    systemPrompt: string;
    /** Fully-expanded user message (already wrapped with any `anthropicUserMessage` template). */
    userText: string;
    /** Caller-selected cancellation token. */
    cancellationToken?: vscode.CancellationToken;
    /** Handler-level injected context. */
    context: AgentSdkTransportContext;
    /**
     * Profile-level approval gate. `never` skips the gate and forces the
     * SDK permissionMode to `bypassPermissions`. Session-wide elevation of
     * a single call is offered at the approval bar, not configured here.
     * Defaults to `always`.
     */
    toolApprovalMode?: 'always' | 'never';
    /** Profile-level override: enable Claude Code's built-in tool preset (Read, Write, Bash, …). */
    useBuiltInTools?: boolean;
    /** Profile-level override: extended thinking budget (tokens). Forwarded to the SDK. */
    thinkingBudgetTokens?: number;
    /**
     * When provided, passed as `resume` to the SDK so the agent continues a
     * previous session (Claude Code's own continuity mechanism). Typically
     * populated from the per-window session-id file when the configuration
     * uses `historyMode: 'sdk-managed'`. Ignored when the stored id
     * doesn't match anything the SDK recognises — the SDK silently starts
     * a new session in that case.
     */
    resumeSessionId?: string;
    /**
     * When true, automatically include `'project'` in `settingSources` if
     * a CLAUDE.md exists at the workspace root. This is how the SDK picks
     * up CLAUDE.md and the project-level settings file. Requested by the
     * handler's SDK-managed path; ignored on other paths (which use
     * whatever the configuration specifies).
     */
    autoLoadProjectSettings?: boolean;
}

export interface AgentSdkResult {
    text: string;
    turnsUsed: number;
    toolCallCount: number;
    stopReason?: string;
    /** Session id returned by the SDK's init/result messages; used by the
     *  handler to persist continuity for the next call in sdk-managed mode. */
    sessionId?: string;
}

// ============================================================================
// MCP server name — the SDK prefixes tool names as `mcp__{server}__{tool}`
// when surfacing them to the model and to `canUseTool`. We strip this prefix
// before looking up a tool's `requiresApproval` flag.
// ============================================================================

const MCP_SERVER_NAME = 'tom-ai';

// ============================================================================
// JSON Schema -> Zod raw shape
//
// `tool()` takes a Zod raw shape (object properties map), not JSON Schema.
// Our shared tools store `inputSchema` as JSON Schema. This helper converts
// the subset we actually use (string, number, integer, boolean, array,
// enum, object), good enough for every tool in `tool-executors.ts`.
// ============================================================================

function jsonSchemaPropertyToZod(prop: unknown): z.ZodTypeAny {
    if (!prop || typeof prop !== 'object') {
        return z.unknown();
    }
    const p = prop as Record<string, unknown>;
    const enumVals = Array.isArray(p.enum) ? (p.enum as unknown[]).filter((v): v is string => typeof v === 'string') : undefined;
    if (enumVals && enumVals.length > 0) {
        return z.enum(enumVals as [string, ...string[]]);
    }
    switch (p.type) {
        case 'string':
            return z.string();
        case 'number':
            return z.number();
        case 'integer':
            return z.number().int();
        case 'boolean':
            return z.boolean();
        case 'array': {
            const item = p.items ? jsonSchemaPropertyToZod(p.items) : z.unknown();
            return z.array(item);
        }
        case 'object':
            return z.record(z.string(), z.unknown());
        default:
            return z.unknown();
    }
}

function toRawShape(schema: Record<string, unknown> | undefined): Record<string, z.ZodTypeAny> {
    const shape: Record<string, z.ZodTypeAny> = {};
    const props = (schema?.properties ?? {}) as Record<string, unknown>;
    const required = new Set<string>(Array.isArray(schema?.required) ? (schema!.required as string[]) : []);
    for (const [name, prop] of Object.entries(props)) {
        let zt = jsonSchemaPropertyToZod(prop);
        const desc = (prop as { description?: unknown } | undefined)?.description;
        if (typeof desc === 'string' && desc) {
            zt = zt.describe(desc);
        }
        if (!required.has(name)) {
            zt = zt.optional();
        }
        shape[name] = zt;
    }
    return shape;
}

// ============================================================================
// Tool adapter — SharedToolDefinition[] -> MCP tools with full trail + trail
// ============================================================================

function buildMcpServer(
    sdk: AgentSdkModule,
    tools: SharedToolDefinition[],
    ctx: AgentSdkTransportContext,
) {
    const mcpTools = tools.map((def) =>
        sdk.tool(
            def.name,
            def.description,
            toRawShape(def.inputSchema),
            async (args) => {
                const input = (args ?? {}) as Record<string, unknown>;
                const inputSummary = summarizeInput(input);

                TrailService.instance.writeRawToolRequest(
                    ANTHROPIC_SUBSYSTEM,
                    { id: `${ctx.requestId}-${def.name}-${Date.now()}`, name: def.name, input },
                    ctx.windowId,
                    ctx.questId,
                );

                const start = Date.now();
                let result = '';
                let error: string | undefined;
                try {
                    result = await runWithToolContext(
                        { source: 'anthropic', requestId: ctx.requestId },
                        () => def.execute(input),
                    );
                } catch (e) {
                    error = e instanceof Error ? e.message : String(e);
                    result = `Error: ${error}`;
                }
                const durationMs = Date.now() - start;

                TrailService.instance.writeRawToolAnswer(
                    ANTHROPIC_SUBSYSTEM,
                    { name: def.name, result, durationMs, error },
                    ctx.windowId,
                    ctx.questId,
                );

                ctx.toolTrail.add({
                    timestamp: new Date().toISOString().slice(11, 19),
                    round: ctx.round,
                    toolName: def.name,
                    inputSummary,
                    result,
                    durationMs,
                    error,
                });

                return {
                    content: [{ type: 'text' as const, text: result }],
                    isError: error !== undefined,
                };
            },
        ),
    );

    return sdk.createSdkMcpServer({
        name: MCP_SERVER_NAME,
        version: '1.0.0',
        tools: mcpTools,
    });
}

// ============================================================================
// canUseTool bridge — routes write tools through our approval gate
// ============================================================================

/**
 * Strip the `mcp__{server}__` prefix the SDK adds to MCP tool names before
 * handing them to `canUseTool`. Built-in tools (Bash, Read, ...) don't have
 * this prefix — we leave those names untouched, but because we disable
 * built-ins via `tools: []` they should never reach this callback anyway.
 */
function stripMcpPrefix(toolName: string): string {
    const match = /^mcp__[^_]+__(.+)$/.exec(toolName);
    return match ? match[1] : toolName;
}

function makeCanUseTool(
    tools: SharedToolDefinition[],
    ctx: AgentSdkTransportContext,
    approvalMode: 'always' | 'never' = 'always',
): CanUseTool {
    return async (toolName, input): Promise<PermissionResult> => {
        const bare = stripMcpPrefix(toolName);
        const def = tools.find((t) => t.name === bare);

        // Built-ins the SDK itself manages when useBuiltInTools is on —
        // we don't know their approval semantics, so accept them.
        if (!def) {
            return { behavior: 'allow', updatedInput: input };
        }

        const defaultRequiresApproval = !def.readOnly;
        const requiresApproval = def.requiresApproval ?? defaultRequiresApproval;
        const needsApproval = requiresApproval && approvalMode !== 'never';

        if (!needsApproval || ctx.sessionApprovals.has(bare)) {
            return { behavior: 'allow', updatedInput: input };
        }

        const approved = await ctx.requestApproval({
            toolUseId: `${ctx.requestId}-${bare}-${Date.now()}`,
            toolName: bare,
            inputSummary: summarizeInput(input),
        });
        if (!approved) {
            return {
                behavior: 'deny',
                message: `Tool "${bare}" was denied by the user.`,
            };
        }
        // Session-wide elevation is handled at the approval bar via the
        // handler's handleApprovalResponse + this.sessionApprovals set;
        // no action needed here.
        return { behavior: 'allow', updatedInput: input };
    };
}

// ============================================================================
// Main entry point
// ============================================================================

/**
 * Run a query through the Claude Agent SDK and map its message stream onto
 * our raw trail + tool trail, returning an `AnthropicSendResult`.
 *
 * The SDK handles retries, caching, and compaction internally. We only
 * observe the event stream and forward it to our logging / UI surfaces.
 */
export async function runAgentSdkQuery(params: AgentSdkSendParams): Promise<AgentSdkResult> {
    const { configuration, tools, systemPrompt, userText, cancellationToken, context } = params;

    const sdk = await loadSdk();
    const mcpServer = buildMcpServer(sdk, tools, context);
    const approvalMode = params.toolApprovalMode ?? 'always';
    const canUseToolFn = makeCanUseTool(tools, context, approvalMode);

    const abortController = new AbortController();
    const cancelSub = cancellationToken?.onCancellationRequested(() => abortController.abort());

    const maxTurns = configuration.agentSdk?.maxTurns ?? configuration.maxRounds;
    const configuredMode = (configuration.agentSdk?.permissionMode ?? 'default') as PermissionMode;
    // toolApprovalMode === 'never' forces 'bypassPermissions' so the SDK
    // doesn't fire canUseTool at all.
    const permissionMode: PermissionMode = approvalMode === 'never'
        ? 'bypassPermissions'
        : configuredMode;
    let settingSources: SettingSource[] = (configuration.agentSdk?.settingSources ?? []) as SettingSource[];
    let effectiveSystemPrompt = systemPrompt;
    // Auto-load workspace instructions when the handler asks for it
    // (SDK-managed mode). Priority:
    //   1. CLAUDE.md at workspace root  → include 'project' in settingSources;
    //      the SDK picks up CLAUDE.md + .claude/settings.json natively.
    //   2. else .github/copilot-instructions.md → inject its contents into
    //      the system prompt; the SDK has no native loader for that file.
    //   3. else no-op.
    if (params.autoLoadProjectSettings === true) {
        try {
            const wsRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
            if (wsRoot) {
                const fsMod = require('fs') as typeof import('fs');
                const pathMod = require('path') as typeof import('path');
                const claudeMdPath = pathMod.join(wsRoot, 'CLAUDE.md');
                const copilotPath = pathMod.join(wsRoot, '.github', 'copilot-instructions.md');
                if (fsMod.existsSync(claudeMdPath)) {
                    if (!settingSources.includes('project')) {
                        settingSources = [...settingSources, 'project'];
                    }
                } else if (fsMod.existsSync(copilotPath)) {
                    const body = fsMod.readFileSync(copilotPath, 'utf-8');
                    if (body && body.trim().length > 0) {
                        const block = `## Workspace instructions (from .github/copilot-instructions.md)\n\n${body}`;
                        effectiveSystemPrompt = effectiveSystemPrompt
                            ? `${effectiveSystemPrompt}\n\n${block}`
                            : block;
                    }
                }
            }
        } catch { /* leave systemPrompt + settingSources as configured */ }
    }

    // Built-in tool preset: when the profile opts in, pass the Claude Code
    // preset so Read/Write/Edit/Bash/Grep/… become available. Otherwise
    // suppress all built-ins so only our MCP tools are exposed.
    const toolsOption: string[] | { type: 'preset'; preset: 'claude_code' } = params.useBuiltInTools === true
        ? { type: 'preset', preset: 'claude_code' }
        : [];

    let lastText = '';
    let totalToolCalls = 0;
    let stopReason: string | undefined;
    let turnsUsed = 0;
    let capturedSessionId: string | undefined;

    try {
        // `cwd` anchors the SDK's filesystem lookups (CLAUDE.md,
        // `.claude/settings.json`, project-scoped settingSources, etc.)
        // to the VS Code workspace root. Without it the SDK defaults to
        // the extension host's process.cwd() — usually the user's home
        // or wherever VS Code was launched from — and would silently
        // find no CLAUDE.md even when 'project' is in settingSources.
        const workspaceCwd = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
        const queryOptions: Record<string, unknown> = {
            model: configuration.model,
            systemPrompt: effectiveSystemPrompt || undefined,
            maxTurns,
            permissionMode,
            settingSources,
            abortController,
            canUseTool: canUseToolFn,
            mcpServers: { [MCP_SERVER_NAME]: mcpServer },
            tools: toolsOption,
            ...(workspaceCwd ? { cwd: workspaceCwd } : {}),
        };
        // Continuity: passing `resume` tells the SDK to continue a prior
        // session so it sees the full turn history it produced earlier.
        if (params.resumeSessionId && params.resumeSessionId.length > 0) {
            queryOptions.resume = params.resumeSessionId;
        }
        const stream = sdk.query({
            prompt: userText,
            options: queryOptions as Parameters<typeof sdk.query>[0]['options'],
        });

        for await (const msg of stream) {
            if (cancellationToken?.isCancellationRequested) {
                break;
            }
            // Every SDK message carries a session_id — capture the first
            // non-empty one we see. On first send the SDK emits a new id
            // (persist it); on resume it echoes the id we passed back
            // (safe to re-persist — same value).
            const sid = (msg as { session_id?: unknown }).session_id;
            if (typeof sid === 'string' && sid.length > 0 && !capturedSessionId) {
                capturedSessionId = sid;
            }
            switch (msg.type) {
                case 'assistant':
                    handleAssistantMessage(msg as SDKAssistantMessage, context);
                    lastText = extractAssistantText(msg as SDKAssistantMessage) || lastText;
                    totalToolCalls += countToolUses(msg as SDKAssistantMessage);
                    break;
                case 'user': {
                    // Tool results appear as synthetic user messages; we
                    // already logged the answer from inside the handler.
                    // Nothing to do here — kept for completeness.
                    void (msg as SDKUserMessage);
                    break;
                }
                case 'result': {
                    const res = msg as SDKResultMessage;
                    stopReason = res.stop_reason ?? res.subtype;
                    turnsUsed = res.num_turns;
                    if ('result' in res && typeof res.result === 'string' && res.result) {
                        lastText = res.result;
                    }
                    break;
                }
                default:
                    break;
            }
        }
    } finally {
        cancelSub?.dispose();
    }

    TrailService.instance.writeRawAnswer(
        ANTHROPIC_SUBSYSTEM,
        lastText,
        context.windowId,
        context.requestId,
        context.questId,
    );
    context.toolTrail.evictOldRounds();

    return {
        text: lastText,
        turnsUsed: turnsUsed || maxTurns,
        toolCallCount: totalToolCalls,
        stopReason,
        sessionId: capturedSessionId,
    };
}

// ============================================================================
// Message helpers
// ============================================================================

/**
 * Previously emitted a `writeRawAnswer` for every streaming text block,
 * which produced a duplicate of the final answer in the raw trail (one
 * per block + one at the end of runAgentSdkQuery). The final write in
 * runAgentSdkQuery covers the canonical answer content; the per-block
 * writes were noise. The hook stays so future callers can add streaming
 * UI side-effects here without reintroducing the duplicate trail file.
 */
function handleAssistantMessage(_msg: SDKAssistantMessage, _ctx: AgentSdkTransportContext): void {
    /* no-op on trail; final answer is written once in runAgentSdkQuery */
}

function extractAssistantText(msg: SDKAssistantMessage): string {
    const body = msg.message as { content?: unknown } | undefined;
    if (!body || !Array.isArray(body.content)) {
        return '';
    }
    return (body.content as unknown[])
        .filter((b): b is { type: 'text'; text: string } =>
            !!b && typeof b === 'object' && (b as { type?: unknown }).type === 'text' &&
            typeof (b as { text?: unknown }).text === 'string',
        )
        .map((b) => b.text)
        .join('');
}

function countToolUses(msg: SDKAssistantMessage): number {
    const body = msg.message as { content?: unknown } | undefined;
    if (!body || !Array.isArray(body.content)) {
        return 0;
    }
    return (body.content as unknown[]).filter(
        (b) => !!b && typeof b === 'object' && (b as { type?: unknown }).type === 'tool_use',
    ).length;
}

function summarizeInput(input: Record<string, unknown>): string {
    try {
        const s = JSON.stringify(input);
        return s.length > 200 ? s.slice(0, 197) + '...' : s;
    } catch {
        return '[unserializable input]';
    }
}
