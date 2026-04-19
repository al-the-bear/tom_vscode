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
     * Optional live-trail writer — when set, the transport emits
     * thinking / tool_use / assistant text events into it as the
     * stream arrives so the user can follow along in the MD Browser.
     * Owned by the handler; no ownership semantics for this module.
     */
    liveTrail?: {
        appendThinking(text: string): void;
        appendAssistantText(text: string): void;
        beginToolCall(toolName: string, input: unknown, replayKey: string): void;
        appendToolResult(resultPreview: string, fullLength: number): void;
    };
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
     * Fires the instant the SDK's init `system` message arrives (or a
     * later stream message if the init was missed). The handler uses
     * this to persist the session id *early* — waiting until the end of
     * the call was the old behavior, but a stream that gets cancelled
     * (window reload, user abort) would then leave the sdk-managed
     * session-id file stale and every subsequent prompt would fork a
     * new Claude Code session. Saving early means we at worst lose the
     * trailing turns of a cancelled stream, not the whole session.
     */
    onSessionIdCaptured?: (sessionId: string) => void;
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

    // Built-in tool tracking — when the profile opts into the Claude
    // Code preset (Read, Write, Bash, Grep, …), the SDK executes those
    // tools itself and we never hit the MCP wrapper that would normally
    // write raw trail files. We still see every `tool_use` in assistant
    // messages and the matching `tool_result` in synthetic user
    // messages, so we mirror the MCP wrapper's side effects (raw
    // trail + tool trail) from the stream. Keyed by tool_use.id so the
    // paired result can look its request up.
    interface PendingBuiltinCall {
        name: string;
        input: Record<string, unknown>;
        inputSummary: string;
        startedAt: number;
    }
    const pendingBuiltins = new Map<string, PendingBuiltinCall>();
    const isMcpToolName = (name: string): boolean => name.startsWith('mcp__');

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
            // non-empty one we see and forward it to the handler via the
            // callback so the on-disk session-id file gets rewritten
            // early in the turn. On first send the SDK emits a fresh
            // id; on resume (with forkSession=false, the default) it
            // echoes the id we passed. Either way, persist ASAP: a
            // window reload that kills the stream must not invalidate
            // the continuity we already have.
            const sid = (msg as { session_id?: unknown }).session_id;
            if (typeof sid === 'string' && sid.length > 0 && !capturedSessionId) {
                capturedSessionId = sid;
                try {
                    params.onSessionIdCaptured?.(sid);
                } catch { /* persistence is best-effort */ }
            }
            switch (msg.type) {
                case 'assistant': {
                    handleAssistantMessage(msg as SDKAssistantMessage, context);
                    lastText = extractAssistantText(msg as SDKAssistantMessage) || lastText;
                    totalToolCalls += countToolUses(msg as SDKAssistantMessage);

                    const body = (msg as SDKAssistantMessage).message as { content?: unknown } | undefined;
                    const blocks = Array.isArray(body?.content) ? (body?.content as unknown[]) : [];
                    for (const blk of blocks) {
                        if (!blk || typeof blk !== 'object') { continue; }
                        const b = blk as { type?: string; text?: unknown; thinking?: unknown; name?: unknown; input?: unknown; id?: unknown };

                        // Live-trail: emit thinking / text / tool_use
                        // events in order. tool_result lives on the
                        // synthetic user message and is handled below.
                        if (params.liveTrail) {
                            if (b.type === 'thinking' && typeof b.thinking === 'string') {
                                params.liveTrail.appendThinking(b.thinking);
                            } else if (b.type === 'text' && typeof b.text === 'string') {
                                params.liveTrail.appendAssistantText(b.text);
                            } else if (b.type === 'tool_use' && typeof b.name === 'string') {
                                // Use the SDK tool_use id as the replay
                                // key — the paired tool_result carries
                                // the same id so the live trail can
                                // correlate when it renders.
                                const replayKey = typeof b.id === 'string' ? b.id : 'sdk';
                                params.liveTrail.beginToolCall(b.name, b.input ?? {}, replayKey);
                            }
                        }

                        // Raw trail + tool trail for BUILT-IN tool
                        // calls. MCP tools (name starts with `mcp__`)
                        // go through our own wrapper in buildMcpServer
                        // which already writes these files; mirroring
                        // them here would produce duplicates.
                        if (b.type === 'tool_use' && typeof b.name === 'string' && typeof b.id === 'string' && !isMcpToolName(b.name)) {
                            const input = (b.input && typeof b.input === 'object') ? (b.input as Record<string, unknown>) : {};
                            const inputSummary = summarizeInput(input);
                            pendingBuiltins.set(b.id, {
                                name: b.name,
                                input,
                                inputSummary,
                                startedAt: Date.now(),
                            });
                            TrailService.instance.writeRawToolRequest(
                                ANTHROPIC_SUBSYSTEM,
                                { id: b.id, name: b.name, input },
                                context.windowId,
                                context.questId,
                            );
                        }
                    }
                    break;
                }
                case 'user': {
                    // Tool results appear as synthetic user messages
                    // whose `content` is an array of tool_result blocks.
                    // Feed each into the live trail so the MD Browser
                    // shows output immediately after the tool_use block
                    // it matches, AND close out any built-in pending
                    // entry we opened on the assistant side.
                    const body = (msg as SDKUserMessage).message as { content?: unknown } | undefined;
                    const blocks = Array.isArray(body?.content) ? (body?.content as unknown[]) : [];
                    for (const blk of blocks) {
                        if (!blk || typeof blk !== 'object') { continue; }
                        const b = blk as { type?: string; content?: unknown; tool_use_id?: unknown; is_error?: unknown };
                        if (b.type !== 'tool_result') { continue; }

                        const raw = b.content;
                        let text = '';
                        if (typeof raw === 'string') {
                            text = raw;
                        } else if (Array.isArray(raw)) {
                            text = (raw as unknown[])
                                .map((part) => (part && typeof part === 'object' && typeof (part as { text?: unknown }).text === 'string' ? (part as { text: string }).text : ''))
                                .join('');
                        }

                        params.liveTrail?.appendToolResult(text, text.length);

                        // Close out built-in tool call: write raw
                        // answer + commit to toolTrail so the replay
                        // key / past-tool-access tools can find it.
                        const toolUseId = typeof b.tool_use_id === 'string' ? b.tool_use_id : undefined;
                        if (toolUseId && pendingBuiltins.has(toolUseId)) {
                            const pending = pendingBuiltins.get(toolUseId)!;
                            pendingBuiltins.delete(toolUseId);
                            const durationMs = Date.now() - pending.startedAt;
                            const isError = b.is_error === true;
                            const errorMsg = isError ? (text || 'tool reported error') : undefined;

                            TrailService.instance.writeRawToolAnswer(
                                ANTHROPIC_SUBSYSTEM,
                                { id: toolUseId, name: pending.name, result: text, durationMs, error: errorMsg },
                                context.windowId,
                                context.questId,
                            );

                            context.toolTrail.add({
                                timestamp: new Date().toISOString().slice(11, 19),
                                round: context.round,
                                toolName: pending.name,
                                inputSummary: pending.inputSummary,
                                result: text,
                                durationMs,
                                error: errorMsg,
                            });
                        }
                    }
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
    } catch (err) {
        // Always write *something* to the raw answer trail so the file
        // pair (prompt + answer) is complete even when the SDK stream
        // errors out. Re-throw afterwards — the chat panel reports the
        // error on its side; this just guarantees the trail stays intact
        // so subsequent history/compaction steps have a record to read.
        const errMsg = err instanceof Error ? (err.stack || err.message) : String(err);
        const body = lastText
            ? `${lastText}\n\n---\n(stream error after partial output)\n${errMsg}`
            : `(no text produced — stream errored before any assistant text)\n${errMsg}`;
        TrailService.instance.writeRawAnswer(
            ANTHROPIC_SUBSYSTEM,
            body,
            context.windowId,
            context.requestId,
            context.questId,
        );
        throw err;
    } finally {
        cancelSub?.dispose();
    }

    // Clean exit — write the final text (with an informative placeholder
    // when the SDK produced none) *before* returning, so the trail file
    // is always present and the caller's subsequent compaction work
    // can reference it.
    const finalBody = lastText || `(no text produced — stop_reason: ${stopReason ?? 'unknown'})`;
    TrailService.instance.writeRawAnswer(
        ANTHROPIC_SUBSYSTEM,
        finalBody,
        context.windowId,
        context.requestId,
        context.questId,
    );

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
