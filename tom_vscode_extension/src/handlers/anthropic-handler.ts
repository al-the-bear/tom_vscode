/**
 * Anthropic Handler — sends messages to the Anthropic Messages API with
 * an automatic tool-call loop, approval gate, raw trail logging, and tool
 * trail injection. Mirrors the shape of `ollamaGenerateWithTools()` in
 * `localLlm-handler.ts` but adapted for Anthropic's content-block protocol.
 *
 * This is the Phase 1 baseline: no memory service, no history compaction,
 * no persistent history across turns. The panel, approval UI, memory
 * injection, and compaction wire-up arrive in later phases (see §12 of
 * the anthropic_sdk_integration spec).
 */

import Anthropic from '@anthropic-ai/sdk';
import * as vscode from 'vscode';
import {
    executeToolCall,
    SharedToolDefinition,
    toAnthropicTools,
} from '../tools/shared-tool-registry';
import { TrailService } from '../services/trailService';
import { ToolTrail } from '../services/tool-trail';
import { runWithToolContext } from '../services/tool-execution-context';
import {
    compactHistory,
    ConversationMessage,
    HistoryMode,
} from '../services/history-compaction';
import { TwoTierMemoryService } from '../services/memory-service';
import { TomAiConfiguration } from '../utils/tomAiConfiguration';
import { runAgentSdkQuery } from './agent-sdk-transport';
import * as anthropicOutput from './anthropic-output-channels';
import { WsPaths } from '../utils/workspacePaths';
import { resolveVariables } from '../utils/variableResolver';

// ============================================================================
// Configuration shapes (subset — full schema in §14 of the spec)
// ============================================================================

/**
 * Spec §18.2 — `transport: 'direct'` (default) routes through
 * `@anthropic-ai/sdk` (the original Phase 1–5 path). `'agentSdk'` routes
 * through `@anthropic-ai/claude-agent-sdk`, inheriting auth from the host
 * Claude Code install and delegating the tool-use loop, prompt caching,
 * and context compaction to the SDK.
 */
export type AnthropicTransport = 'direct' | 'agentSdk';

/** Spec §18.2 — per-configuration Agent SDK knobs. */
export interface AnthropicAgentSdkOptions {
    /** SDK `permissionMode`; `default` prompts for dangerous ops. */
    permissionMode?: 'default' | 'acceptEdits' | 'plan' | 'bypassPermissions';
    /** Which filesystem settings layers the SDK should load. Empty (default) = isolation mode. */
    settingSources?: Array<'user' | 'project' | 'local'>;
    /** Turn cap; when omitted, the configuration's `maxRounds` is used. */
    maxTurns?: number;
}

export interface AnthropicConfiguration {
    id: string;
    name: string;
    model: string;
    maxTokens: number;
    temperature?: number;
    memoryToolsEnabled?: boolean;
    historyMode?: string;
    maxHistoryTokens?: number;
    maxRounds: number;
    memoryExtractionTemplateId?: string;
    promptCachingEnabled?: boolean;
    /** Spec §18 — backend selector; `'direct'` when omitted. */
    transport?: AnthropicTransport;
    /** Spec §18.2 — Agent SDK specific options; ignored when `transport !== 'agentSdk'`. */
    agentSdk?: AnthropicAgentSdkOptions;
    isDefault?: boolean;
}

/**
 * Spec §7.2 `AnthropicProfileTemplate` (aliased as `AnthropicProfile` in
 * §12.2). Stored in `anthropic.profiles[]` in the workspace config JSON;
 * the Global Template Editor's `anthropicProfiles` category is the UI.
 *
 * Profile-level overrides (thinkingEnabled, promptCachingEnabled,
 * toolApprovalMode, useBuiltInTools) take precedence over the
 * configuration's settings when provided.
 */
export interface AnthropicProfile {
    id: string;
    name: string;
    description: string;
    systemPrompt: string;
    configurationId?: string;
    toolsEnabled?: boolean;
    enabledTools?: string[];
    maxRounds?: number;
    historyMode?: string | null;
    isDefault?: boolean;
    /** Extended thinking — sends `thinking: { type: 'enabled', budget_tokens }`. */
    thinkingEnabled?: boolean;
    /** Budget in tokens for extended thinking. Default 8192 when `thinkingEnabled`. */
    thinkingBudgetTokens?: number;
    /** Prompt caching — overrides configuration.promptCachingEnabled. Default true at profile level. */
    promptCachingEnabled?: boolean;
    /**
     * Approval policy for write tool calls. `always` prompts every time,
     * `session` prompts once per tool per session, `never` skips approval
     * entirely. Defaults to `always` when absent. Lives on the profile
     * (which captures persona + behavior), not the configuration (which
     * is API capacity).
     */
    toolApprovalMode?: 'always' | 'session' | 'never';
    /**
     * Agent SDK path only — enable the built-in Claude Code tool preset
     * (Read, Write, Edit, Glob, Grep, Bash, WebFetch, etc.) and suppress
     * extension tools that would duplicate them. Has no effect on the
     * direct Anthropic SDK path.
     */
    useBuiltInTools?: boolean;
}

interface AnthropicSection {
    apiKeyEnvVar?: string;
    configurations?: AnthropicConfiguration[];
    profiles?: AnthropicProfile[];
}

export interface AnthropicSendOptions {
    /** Raw text the user typed into the panel. */
    userText: string;
    /** Profile that supplies the system prompt. */
    profile: AnthropicProfile;
    /** Configuration that supplies model, tokens, temperature, round cap. */
    configuration: AnthropicConfiguration;
    /** Tools available to the model (already filtered by `enabledTools`). */
    tools: SharedToolDefinition[];
    /** Optional user-message template to wrap `userText`. Expanded with `${userMessage}` set to `userText`. */
    userMessageTemplate?: string;
    /** Optional cancellation token. */
    cancellationToken?: vscode.CancellationToken;
    /**
     * Run the request in isolation: do not prepend the handler's rolling
     * history to the messages, do not push this exchange onto the history
     * afterwards, and do not trigger background compaction. Used by
     * `spawnAnthropicSubagent()` so a sub-agent call cannot pollute the
     * parent conversation's history.
     */
    isolated?: boolean;
}

/** Reusable TrailSubsystem literal — avoids `ANTHROPIC_SUBSYSTEM` scattered across calls. */
export const ANTHROPIC_SUBSYSTEM = { type: 'anthropic' as const } satisfies import('../services/trailService').TrailSubsystem;

/**
 * Decide whether to send a `temperature` parameter to the API. Omit it when
 * it is undefined OR equal to the server default (1.0). Some newer models
 * (e.g. claude-opus-4-7) return 400 "Temperature is deprecated for this
 * model" if it is sent at all — and the server default already matches
 * what callers get when omitting, so this is safe across every model. Any
 * explicit non-1 value (e.g. 0.3, 0.5) is forwarded unchanged.
 */
export function temperatureField(temperature: number | undefined): { temperature?: number } {
    if (typeof temperature !== 'number' || temperature === 1) { return {}; }
    return { temperature };
}

/**
 * Extension tools that duplicate Claude Code's built-in preset. When a
 * profile opts into `useBuiltInTools`, we suppress these so the agent sees
 * only the SDK's native versions (same capability, single source of truth).
 * Extension-only tools (memory_*, chatvar_*, git, askBigBrother, askCopilot,
 * getErrors, manageTodo, readGuideline) are kept.
 */
export const DUPLICATES_OF_CLAUDE_CODE_BUILTINS: ReadonlySet<string> = new Set([
    'tomAi_readFile',
    'tomAi_createFile',
    'tomAi_editFile',
    'tomAi_multiEditFile',
    'tomAi_deleteFile',
    'tomAi_moveFile',
    'tomAi_listDirectory',
    'tomAi_findFiles',
    'tomAi_findTextInFiles',
    'tomAi_runCommand',
    'tomAi_fetchWebpage',
    'tomAi_webSearch',
]);

export interface AnthropicSendResult {
    text: string;
    turnsUsed: number;
    toolCallCount: number;
    stopReason?: string;
}

/**
 * Approval request emitted by the handler when a `requiresApproval` tool
 * is about to run. The panel listens via `onApprovalNeeded`, shows UI,
 * and reports back through `handleApprovalResponse(toolUseId, approved)`.
 */
export interface AnthropicToolApprovalRequest {
    toolUseId: string;
    toolName: string;
    inputSummary: string;
}

// ============================================================================
// Anthropic SDK message shapes (the subset we actually use)
// ============================================================================

type AnthropicMessageParam = Anthropic.MessageParam;
type AnthropicContentBlock = Anthropic.ContentBlock;
type AnthropicToolResultBlockParam = Anthropic.ToolResultBlockParam;

// ============================================================================
// Handler
// ============================================================================

export class AnthropicHandler {
    private static _instance: AnthropicHandler | undefined;
    private client: Anthropic | undefined;
    private readonly toolTrail: ToolTrail;
    private roundCounter = 0;
    private sessionApprovals = new Set<string>();
    private readonly pendingApprovals = new Map<string, { resolve: (approved: boolean) => void; toolName: string }>();
    /**
     * Rolling conversation history kept across `sendMessage()` calls,
     * compacted after each exchange per the configuration's `historyMode`.
     * Phase 3.5 introduces this — Phase 1 treated each call as stateless.
     * Seeded on the first send from the most recent compacted-history
     * snapshot (spec §5.2) so context carries across sessions.
     */
    private history: ConversationMessage[] = [];
    private historySeeded = false;

    private readonly _onApprovalNeeded = new vscode.EventEmitter<AnthropicToolApprovalRequest>();
    /**
     * Fired when a `requiresApproval` tool is about to run. Phase 4 wires
     * the chat panel to this event; the panel must call
     * `handleApprovalResponse()` with the same `toolUseId` once the user
     * decides.
     */
    readonly onApprovalNeeded: vscode.Event<AnthropicToolApprovalRequest> = this._onApprovalNeeded.event;

    static init(context: vscode.ExtensionContext): AnthropicHandler {
        if (!AnthropicHandler._instance) {
            AnthropicHandler._instance = new AnthropicHandler();
            context.subscriptions.push({ dispose: () => AnthropicHandler._instance?._onApprovalNeeded.dispose() });
        }
        return AnthropicHandler._instance;
    }

    static get instance(): AnthropicHandler {
        if (!AnthropicHandler._instance) {
            AnthropicHandler._instance = new AnthropicHandler();
        }
        return AnthropicHandler._instance;
    }

    private constructor() {
        this.toolTrail = new ToolTrail();
        // Eager init per spec §17 Step 1.8; falls back to lazy creation in
        // `getClient()` if the env var was unset at activation time.
        try {
            this.getClient();
        } catch {
            // ignore — getClient already returns undefined when env var missing
        }
    }

    /** Clear all in-session state (rolling history, tool trail, session-mode approvals). */
    clearSession(): void {
        this.history = [];
        this.historySeeded = true; // an explicit clear should not reload a prior snapshot
        this.toolTrail.clear();
        this.sessionApprovals.clear();
        this.roundCounter = 0;
    }

    /**
     * Seed `this.history` from the most recent `{timestamp}.history.json`
     * under `_ai/memory/{quest}/history/` — called at the start of the
     * first `sendMessage()` for multi-session continuity (spec §5.2).
     */
    private seedHistoryFromSnapshot(questId: string): void {
        if (this.historySeeded) {
            return;
        }
        this.historySeeded = true;
        try {
            const snapshot = TwoTierMemoryService.instance.loadLatestHistorySnapshot<ConversationMessage[]>(questId);
            if (Array.isArray(snapshot) && snapshot.length > 0) {
                this.history = snapshot.filter(
                    (m): m is ConversationMessage =>
                        !!m && typeof m === 'object' &&
                        (m.role === 'user' || m.role === 'assistant' || m.role === 'system') &&
                        typeof m.content === 'string',
                );
            }
        } catch {
            // ignore — fresh session is a safe fallback
        }
    }

    /** Returns a shallow copy of the current rolling history (for diagnostics / tests). */
    getHistory(): ConversationMessage[] {
        return [...this.history];
    }

    /**
     * Resolve the Promise awaiting approval for `toolUseId`. Called by
     * the chat panel when it receives the `anthropicToolApprovalResponse`
     * webview message. No-op if the id is unknown (already resolved or
     * never requested).
     */
    handleApprovalResponse(toolUseId: string, approved: boolean, approveAll: boolean = false): void {
        const entry = this.pendingApprovals.get(toolUseId);
        if (!entry) {
            return;
        }
        this.pendingApprovals.delete(toolUseId);
        // "Approve All" = "approve every subsequent invocation of this tool
        // in the current session" (spec §11.4 `approveAll`). It only takes
        // effect when the decision is approve — denying with approveAll
        // would be nonsensical.
        if (approved && approveAll && entry.toolName) {
            this.sessionApprovals.add(entry.toolName);
        }
        entry.resolve(approved);
    }

    /**
     * Emit `onApprovalNeeded` and return a Promise that resolves when
     * `handleApprovalResponse(toolUseId, ...)` is called. Phase 4 wires
     * the chat panel as the listener; before then, callers must register
     * their own listener on `onApprovalNeeded` (or only invoke tools with
     * `requiresApproval: false`) to avoid hanging.
     */
    private awaitApproval(req: AnthropicToolApprovalRequest): Promise<boolean> {
        return new Promise<boolean>((resolve) => {
            this.pendingApprovals.set(req.toolUseId, { resolve, toolName: req.toolName });
            this._onApprovalNeeded.fire(req);
        });
    }

    /**
     * Read the API key from the environment variable named in config and
     * (re)build the SDK client. Returns `undefined` if the env var is unset.
     */
    private getClient(): Anthropic | undefined {
        if (this.client) {
            return this.client;
        }
        const section = this.getAnthropicSection();
        const envVar = section.apiKeyEnvVar || 'ANTHROPIC_API_KEY';
        const apiKey = process.env[envVar];
        if (!apiKey) {
            return undefined;
        }
        this.client = new Anthropic({ apiKey });
        return this.client;
    }

    /** Clear the cached client so the next call re-reads the env var. */
    resetClient(): void {
        this.client = undefined;
    }

    /**
     * Low-level one-shot call for internal consumers (history compaction,
     * memory extraction) — no tool loop, no trail write, no history
     * accumulation, no recursive compaction (spec §6.5 Step 3.4:
     * "Anthropic → internal, no tool loop, no trail write"). Callers
     * supply a fully-formed system and user prompt.
     */
    async runInternalCall(params: {
        systemPrompt: string;
        userPrompt: string;
        model: string;
        maxTokens?: number;
        temperature?: number;
    }): Promise<string> {
        const client = this.getClient();
        if (!client) {
            throw new Error('Anthropic client not available — set the configured API key env var');
        }
        const response = await client.messages.create({
            model: params.model,
            max_tokens: params.maxTokens ?? 2048,
            ...temperatureField(params.temperature),
            ...(params.systemPrompt ? { system: params.systemPrompt } : {}),
            messages: [{ role: 'user', content: params.userPrompt }],
        });
        return response.content
            .filter((b): b is Extract<AnthropicContentBlock, { type: 'text' }> => b.type === 'text')
            .map((b) => b.text)
            .join('');
    }

    /**
     * List available models from the Anthropic API. No fallback — callers
     * must be prepared for `{ models: [], error }` on failure.
     */
    async fetchModels(): Promise<{ models: Array<{ id: string; display_name?: string }>; error?: string }> {
        const client = this.getClient();
        if (!client) {
            const section = this.getAnthropicSection();
            const envVar = section.apiKeyEnvVar || 'ANTHROPIC_API_KEY';
            return { models: [], error: `${envVar} environment variable not set` };
        }
        try {
            const page = await client.models.list({ limit: 100 });
            return {
                models: (page.data ?? []).map((m) => ({
                    id: m.id,
                    ...(m.display_name ? { display_name: m.display_name } : {}),
                })),
            };
        } catch (err) {
            const msg = err instanceof Error ? err.message : String(err);
            return { models: [], error: msg };
        }
    }

    /** Main entry point — send a message and run the tool-call loop to completion. */
    async sendMessage(options: AnthropicSendOptions): Promise<AnthropicSendResult> {
        const { profile, configuration, tools, userText } = options;
        const transport = configuration.transport ?? 'direct';

        const quest = WsPaths.getWorkspaceQuestId();
        const windowId = vscode.env.sessionId;
        const requestId = this.generateRequestId();
        this.roundCounter += 1;
        const round = this.roundCounter;

        this.seedHistoryFromSnapshot(quest);

        // Scan the outgoing message for `Remember:` / `Forget:` keyword
        // triggers (spec §5.4). Matched lines are handled in-process and
        // stripped; what's left goes to the model. A message that consists
        // entirely of triggers still sends the original text so the user
        // sees a response turn rather than an empty prompt.
        const { cleaned: keywordCleanedText } = this.applyKeywordTriggers(userText, quest);
        const effectiveUserText = keywordCleanedText.trim() || userText;

        // Agent SDK path: no memory injection into the system prompt (§18.4).
        // The agent pulls memory via `tomAi_memory_*` tools on demand.
        const systemSegments = transport === 'agentSdk'
            ? [profile.systemPrompt ?? ''].filter((s): s is string => !!s)
            : this.buildSystemSegments(profile, quest);
        const systemPrompt = systemSegments.filter((s) => s).join('\n\n');
        const expandedUser = this.buildUserMessage({ ...options, userText: effectiveUserText });
        const trailLinePrefix = this.toolTrail.toSummaryString();
        const userContent = trailLinePrefix
            ? `${trailLinePrefix}\n\n${expandedUser}`
            : expandedUser;

        TrailService.instance.writeRawPrompt(
            ANTHROPIC_SUBSYSTEM,
            `SYSTEM:\n${systemPrompt}\n\nUSER:\n${userContent}`,
            windowId,
            requestId,
            quest,
        );

        anthropicOutput.logTurnStart({
            requestId,
            transport,
            model: configuration.model,
            systemPromptLength: systemPrompt.length,
            userText: userContent,
        });

        if (transport === 'agentSdk') {
            // When useBuiltInTools is on, hide our duplicates of Claude Code
            // built-ins so the model sees the SDK's native versions instead
            // (single source of truth per capability).
            const effectiveTools = profile.useBuiltInTools
                ? tools.filter((t) => !DUPLICATES_OF_CLAUDE_CODE_BUILTINS.has(t.name))
                : tools;
            const result = await runAgentSdkQuery({
                configuration,
                tools: effectiveTools,
                systemPrompt,
                userText: userContent,
                cancellationToken: options.cancellationToken,
                toolApprovalMode: profile.toolApprovalMode ?? 'always',
                useBuiltInTools: profile.useBuiltInTools === true,
                thinkingBudgetTokens: profile.thinkingEnabled ? (profile.thinkingBudgetTokens ?? 8192) : undefined,
                context: {
                    requestApproval: (req) => this.awaitApproval(req),
                    sessionApprovals: this.sessionApprovals,
                    toolTrail: this.toolTrail,
                    round,
                    questId: quest,
                    windowId,
                    requestId,
                },
            });

            // Summary trails: the direct-Anthropic path writes them via
            // finalize(), but the SDK branch returns early so we write them
            // here. Without this the Prompt Summary Viewer never sees
            // agentSdk prompts (only the raw files get the write above).
            TrailService.instance.writeSummaryPrompt(ANTHROPIC_SUBSYSTEM, userContent, quest);
            TrailService.instance.writeSummaryAnswer(
                ANTHROPIC_SUBSYSTEM,
                result.text,
                { requestId, model: configuration.model },
                quest,
            );
            this.toolTrail.evictOldRounds();

            // Skip history compaction (§18.4) — the SDK manages its own
            // context window — but still record the exchange in our rolling
            // history so users see continuity across direct/agentSdk
            // switches within the same session.
            if (!options.isolated) {
                this.history.push({ role: 'user', content: userContent });
                this.history.push({ role: 'assistant', content: result.text });
            }
            return result;
        }

        const client = this.getClient();
        if (!client) {
            throw new Error('Anthropic client not available — set the configured API key env var');
        }

        const anthropicTools = toAnthropicTools(tools);
        const rollingHistory = options.isolated
            ? []
            : this.history.map((m) => ({
                role: m.role === 'system' ? 'user' : m.role as 'user' | 'assistant',
                content: m.content,
            }));
        const messages: AnthropicMessageParam[] = [
            // Rolling history from prior exchanges — compacted per-turn
            // by the handler's post-exchange `compactHistory()` call.
            // Skipped when options.isolated (subagent path).
            ...rollingHistory,
            { role: 'user', content: userContent },
        ];

        // Profile-level overrides: prompt caching defaults to on when the
        // profile omits it; extended thinking is off unless the profile
        // opts in.
        const profileCachingOverride = profile.promptCachingEnabled;
        const effectiveCaching = profileCachingOverride === undefined
            ? configuration.promptCachingEnabled === true
            : profileCachingOverride !== false;
        const systemParam = this.buildSystemParam(
            systemSegments,
            { ...configuration, promptCachingEnabled: effectiveCaching },
        );
        const thinkingBlock: Anthropic.ThinkingConfigParam | undefined = profile.thinkingEnabled
            ? { type: 'enabled', budget_tokens: profile.thinkingBudgetTokens ?? 8192 }
            : undefined;

        let totalToolCalls = 0;
        let lastText = '';
        let lastStopReason: string | undefined;

        for (let turn = 0; turn < configuration.maxRounds; turn++) {
            if (options.cancellationToken?.isCancellationRequested) {
                break;
            }

            const response = await client.messages.create({
                model: configuration.model,
                max_tokens: configuration.maxTokens,
                ...temperatureField(configuration.temperature),
                ...(thinkingBlock ? { thinking: thinkingBlock } : {}),
                system: systemParam,
                ...(anthropicTools.length > 0 ? { tools: anthropicTools } : {}),
                messages,
            });

            lastStopReason = response.stop_reason ?? undefined;
            lastText = this.extractText(response.content) || lastText;

            if (response.stop_reason !== 'tool_use') {
                return this.finalize(userContent, lastText, turn + 1, totalToolCalls, lastStopReason, windowId, requestId, quest, configuration, options.isolated === true);
            }

            messages.push({ role: 'assistant', content: response.content });

            const toolResults: AnthropicToolResultBlockParam[] = [];
            for (const block of response.content) {
                if (block.type !== 'tool_use') {
                    continue;
                }
                totalToolCalls += 1;
                const toolResultBlock = await this.runTool(
                    block,
                    tools,
                    configuration,
                    options,
                    round,
                    quest,
                    windowId,
                    requestId,
                );
                toolResults.push(toolResultBlock);
            }

            messages.push({ role: 'user', content: toolResults });
        }

        return this.finalize(userContent, lastText, configuration.maxRounds, totalToolCalls, lastStopReason, windowId, requestId, quest, configuration, options.isolated === true);
    }

    /**
     * Shared exit path: write the answer trail, evict old tool-trail
     * rounds, append the exchange to the rolling session history, fire a
     * background compaction pass (spec §12.1 — "async, non-blocking"),
     * and return the result. Every `sendMessage()` exit funnels through
     * here so history accumulation and trail writes stay in lockstep.
     */
    private finalize(
        userContent: string,
        text: string,
        turnsUsed: number,
        toolCallCount: number,
        stopReason: string | undefined,
        windowId: string,
        requestId: string,
        quest: string,
        configuration: AnthropicConfiguration,
        isolated: boolean = false,
    ): AnthropicSendResult {
        TrailService.instance.writeRawAnswer(
            ANTHROPIC_SUBSYSTEM,
            text,
            windowId,
            requestId,
            quest,
        );

        anthropicOutput.logAssistantText(text);
        anthropicOutput.logTurnEnd({
            requestId,
            rounds: turnsUsed,
            toolCallCount,
            stopReason,
        });

        // Also write the compact summary trail (_ai/quests/{quest}/{quest}.anthropic.prompts.md
        // and .answers.md) so the Raw Trail Files Viewer (per-file view) can open it. Same
        // pattern copilot uses via writeSummaryPrompt + writeSummaryAnswer.
        TrailService.instance.writeSummaryPrompt(ANTHROPIC_SUBSYSTEM, userContent, quest);
        TrailService.instance.writeSummaryAnswer(
            ANTHROPIC_SUBSYSTEM,
            text,
            { requestId, model: configuration.model },
            quest,
        );
        this.toolTrail.evictOldRounds();

        // Accumulate this exchange into the rolling history, then
        // compact it asynchronously for the next turn.
        // Isolated sub-agent runs skip this so the parent conversation
        // is unaffected by their intermediate reasoning.
        if (!isolated) {
            this.history.push({ role: 'user', content: userContent });
            this.history.push({ role: 'assistant', content: text });
            void this.compactHistoryAsync(configuration);
        }

        return { text, turnsUsed, toolCallCount, stopReason };
    }

    /**
     * Fire-and-forget: compact the rolling history per the configuration's
     * `historyMode` and reassign `this.history`. Errors are swallowed so a
     * failed compaction can never corrupt the user-visible result.
     */
    private async compactHistoryAsync(configuration: AnthropicConfiguration): Promise<void> {
        try {
            const mode = (configuration.historyMode as HistoryMode | undefined) ?? 'last';
            const section = TomAiConfiguration.instance.getSection<{
                llmProvider?: 'localLlm' | 'anthropic';
                llmConfigId?: string;
                compactionTemplateId?: string;
                memoryExtractionTemplateId?: string;
                compactionMaxRounds?: number;
            }>('compaction') ?? {};
            const snapshot = [...this.history];
            const compacted = await compactHistory(snapshot, {
                mode,
                maxHistoryTokens: configuration.maxHistoryTokens,
                maxRounds: 1,
                llmProvider: section.llmProvider ?? 'anthropic',
                llmConfigId: section.llmConfigId ?? configuration.id,
                compactionTemplateId: section.compactionTemplateId,
                memoryTemplateId: configuration.memoryExtractionTemplateId ?? section.memoryExtractionTemplateId,
                compactionMaxRounds: section.compactionMaxRounds ?? 1,
                memoryPath: TwoTierMemoryService.instance.memoryRoot(),
                questId: TwoTierMemoryService.instance.currentQuest(),
            });
            // Only adopt the result if the history hasn't been mutated
            // in the meantime (e.g. by a concurrent sendMessage call).
            if (this.history.length === snapshot.length) {
                this.history = compacted;
            }
            // Persist the freshly compacted snapshot for multi-session
            // continuity (spec §5.2). Only writes when there's something
            // worth saving — an empty compaction has no recall value.
            if (compacted.length > 0) {
                TwoTierMemoryService.instance.persistHistorySnapshot(
                    compacted,
                    TwoTierMemoryService.instance.currentQuest(),
                );
            }
        } catch {
            // Swallow — compaction is best-effort background work.
        }
    }

    // ------------------------------------------------------------------------
    // Tool execution
    // ------------------------------------------------------------------------

    private async runTool(
        block: Extract<AnthropicContentBlock, { type: 'tool_use' }>,
        tools: SharedToolDefinition[],
        configuration: AnthropicConfiguration,
        options: AnthropicSendOptions,
        round: number,
        quest: string,
        windowId: string,
        requestId: string,
    ): Promise<AnthropicToolResultBlockParam> {
        const def = tools.find((t) => t.name === block.name);
        const input = (block.input ?? {}) as Record<string, unknown>;
        const inputSummary = this.summarizeInput(input);

        // Per spec §8.1: `requiresApproval` defaults to `true` for write
        // tools (i.e. `!readOnly`). An explicit value overrides the default
        // — e.g. `tomAi_writeChatVariable` opts out because it has its own
        // real-time visibility mechanism (§8.5).
        const defaultRequiresApproval = def ? !def.readOnly : false;
        const requiresApproval = def?.requiresApproval ?? defaultRequiresApproval;
        const approvalMode = options.profile.toolApprovalMode ?? 'always';
        const needsApproval = requiresApproval && approvalMode !== 'never';
        if (needsApproval && !this.sessionApprovals.has(block.name)) {
            const approved = await this.awaitApproval({
                toolUseId: block.id,
                toolName: block.name,
                inputSummary,
            });
            if (!approved) {
                return {
                    type: 'tool_result',
                    tool_use_id: block.id,
                    is_error: true,
                    content: `Tool "${block.name}" was denied by the user.`,
                };
            }
            if (approvalMode === 'session') {
                this.sessionApprovals.add(block.name);
            }
        }

        TrailService.instance.writeRawToolRequest(
            ANTHROPIC_SUBSYSTEM,
            { id: block.id, name: block.name, input },
            windowId,
            quest,
        );

        anthropicOutput.logToolRequest(block.name, input);

        const start = Date.now();
        let result = '';
        let error: string | undefined;
        try {
            // Ambient context so tools (e.g. tomAi_writeChatVariable) can log
            // change-log entries with the correct source and request ID.
            result = await runWithToolContext(
                { source: 'anthropic', requestId },
                () => executeToolCall(tools, {
                    function: { name: block.name, arguments: input },
                }),
            );
        } catch (e) {
            error = e instanceof Error ? e.message : String(e);
            result = `Error: ${error}`;
        }
        const durationMs = Date.now() - start;

        TrailService.instance.writeRawToolAnswer(
            ANTHROPIC_SUBSYSTEM,
            { id: block.id, name: block.name, result, durationMs, error },
            windowId,
            quest,
        );

        anthropicOutput.logToolResult(block.name, input, result, durationMs, error);

        this.toolTrail.add({
            timestamp: new Date().toISOString().slice(11, 19),
            round,
            toolName: block.name,
            inputSummary,
            result,
            durationMs,
            error,
        });

        return {
            type: 'tool_result',
            tool_use_id: block.id,
            is_error: error !== undefined,
            content: result,
        };
    }

    // ------------------------------------------------------------------------
    // Helpers
    // ------------------------------------------------------------------------

    private getAnthropicSection(): AnthropicSection {
        return TomAiConfiguration.instance.getSection<AnthropicSection>('anthropic') ?? {};
    }

    private buildSystemPrompt(profile: AnthropicProfile, questId?: string): string {
        const segments = this.buildSystemSegments(profile, questId);
        return segments.filter((s) => s).join('\n\n');
    }

    /**
     * Return the system prompt as ordered segments — base profile first, then
     * the memory injection (if enabled and non-empty). When `promptCachingEnabled`
     * is on, `buildSystemParam` puts `cache_control` on the *last* segment so
     * everything up to and including it becomes a cache checkpoint (per spec
     * §5.2 / §16: "the memory injection block after Phase 3").
     */
    private buildSystemSegments(profile: AnthropicProfile, questId?: string): string[] {
        const segments: string[] = [];
        const base = resolveVariables(profile.systemPrompt ?? '');
        if (base) { segments.push(base); }
        const memorySection = TomAiConfiguration.instance.getSection<{
            enabled?: boolean;
            injectIntoSystemPrompt?: boolean;
            maxInjectedTokens?: number;
        }>('memory') ?? {};
        if (memorySection.enabled === false || memorySection.injectIntoSystemPrompt === false) {
            return segments;
        }
        const injection = TwoTierMemoryService.instance.injectForSystemPrompt(
            memorySection.maxInjectedTokens,
            questId,
        );
        if (injection.text) {
            segments.push(injection.text);
        }
        return segments;
    }

    /**
     * Scan `userText` line-by-line for `Remember: ...` and `Forget: ...`
     * triggers (spec §5.4). Remember writes the fact to `shared/facts.md`;
     * Forget removes matching lines from `shared/facts.md` (and, if absent
     * there, from every quest-scope memory file). Triggers are stripped
     * from the returned `cleaned` text. The leading keyword is matched
     * case-insensitively and may be followed by optional whitespace.
     */
    private applyKeywordTriggers(userText: string, questId?: string): { cleaned: string; applied: string[] } {
        const section = TomAiConfiguration.instance.getSection<{
            keywordTriggers?: { remember?: boolean; forget?: boolean };
            enabled?: boolean;
        }>('memory') ?? {};
        if (section.enabled === false) {
            return { cleaned: userText, applied: [] };
        }
        const triggers = section.keywordTriggers ?? {};
        const rememberOn = triggers.remember !== false;
        const forgetOn = triggers.forget !== false;
        if (!rememberOn && !forgetOn) {
            return { cleaned: userText, applied: [] };
        }
        const applied: string[] = [];
        const remaining: string[] = [];
        for (const line of userText.split(/\r?\n/)) {
            const rem = /^\s*remember\s*:\s*(.+)$/i.exec(line);
            const fgt = /^\s*forget\s*:\s*(.+)$/i.exec(line);
            if (rem && rememberOn) {
                try {
                    TwoTierMemoryService.instance.append('shared', 'facts.md', rem[1].trim(), questId);
                    applied.push(`remember: ${rem[1].trim()}`);
                } catch { /* ignore — model still sees the cleaned message */ }
                continue;
            }
            if (fgt && forgetOn) {
                try {
                    this.forgetFact(fgt[1].trim(), questId);
                    applied.push(`forget: ${fgt[1].trim()}`);
                } catch { /* ignore */ }
                continue;
            }
            remaining.push(line);
        }
        return { cleaned: remaining.join('\n'), applied };
    }

    /**
     * Remove lines containing `needle` from `shared/facts.md` first; if no
     * match, walk every quest-scope memory file and remove there. Case-
     * insensitive substring match. Empties left behind are kept as files
     * so the user sees the history of what was removed.
     */
    private forgetFact(needle: string, questId?: string): void {
        const svc = TwoTierMemoryService.instance;
        const match = needle.toLowerCase();
        const strip = (body: string) => body
            .split(/\r?\n/)
            .filter((l) => !l.toLowerCase().includes(match))
            .join('\n');
        const sharedBody = svc.read('shared', 'facts.md', questId);
        if (sharedBody && sharedBody.toLowerCase().includes(match)) {
            svc.write('shared', 'facts.md', strip(sharedBody), questId);
            return;
        }
        for (const file of svc.list('quest', questId)) {
            const body = svc.read('quest', file, questId);
            if (body && body.toLowerCase().includes(match)) {
                svc.write('quest', file, strip(body), questId);
            }
        }
    }

    private buildUserMessage(options: AnthropicSendOptions): string {
        const template = options.userMessageTemplate;
        if (!template) {
            return options.userText;
        }
        return resolveVariables(template, {
            values: { userMessage: options.userText },
        });
    }

    /**
     * Build the `system` parameter. When `promptCachingEnabled`, emits a
     * block array carrying `cache_control: { type: 'ephemeral' }` so the
     * server caches the (typically long) system prompt; otherwise a plain
     * string works and costs nothing extra.
     */
    private buildSystemParam(
        systemSegments: string[],
        configuration: AnthropicConfiguration,
    ): string | Anthropic.TextBlockParam[] {
        const segments = systemSegments.filter((s) => typeof s === 'string' && s.length > 0);
        if (segments.length === 0) {
            return '';
        }
        if (!configuration.promptCachingEnabled) {
            return segments.join('\n\n');
        }
        return segments.map<Anthropic.TextBlockParam>((text, idx) => ({
            type: 'text',
            text,
            ...(idx === segments.length - 1 ? { cache_control: { type: 'ephemeral' } } : {}),
        }));
    }

    private extractText(content: AnthropicContentBlock[]): string {
        return content
            .filter((b): b is Extract<AnthropicContentBlock, { type: 'text' }> => b.type === 'text')
            .map((b) => b.text)
            .join('');
    }

    private summarizeInput(input: Record<string, unknown>): string {
        try {
            const s = JSON.stringify(input);
            return s.length > 200 ? s.slice(0, 197) + '...' : s;
        } catch {
            return '[unserializable input]';
        }
    }

    private generateRequestId(): string {
        const hex = () => Math.random().toString(16).substring(2, 10);
        return `${hex()}_${hex()}`;
    }
}

// ============================================================================
// Sub-agent spawner — wired to planning-tools.ts registerSubagentSpawner()
// ============================================================================

import { ALL_SHARED_TOOLS } from '../tools/tool-executors';

/**
 * Spawn an isolated Anthropic sub-agent. Reuses the singleton handler's
 * `sendMessage()` loop with `isolated: true` so no state (history, session
 * approvals) crosses the sub-agent boundary.
 *
 * The sub-agent always runs with `toolApprovalMode = 'never'` because it's
 * unattended — the parent conversation can't pause for an approval bar.
 * Callers must therefore constrain the tool set (`enabledTools`) to only
 * trusted capabilities.
 *
 * Registered from extension activation via:
 *     registerSubagentSpawner(spawnAnthropicSubagent);
 */
export async function spawnAnthropicSubagent(options: {
    prompt: string;
    systemPrompt?: string;
    enabledTools?: string[];
    maxRounds?: number;
    temperature?: number;
}): Promise<{ summary: string; rounds: number; toolCalls: number; stopReason?: string }> {
    const section = TomAiConfiguration.instance.getSection<AnthropicSection>('anthropic') ?? {};
    const configurations = section.configurations ?? [];
    const configuration = configurations.find((c) => c.isDefault) ?? configurations[0];
    if (!configuration) {
        throw new Error(
            'No Anthropic configuration is available. Add at least one in the Status page before spawning a sub-agent.',
        );
    }

    // Tool set: explicit allow-list from caller, or fall back to read-only tools.
    // Sub-agents run autonomously so an empty / unspecified list should
    // never default to "all tools".
    const allow = Array.isArray(options.enabledTools) && options.enabledTools.length > 0
        ? new Set(options.enabledTools)
        : undefined;
    const tools: SharedToolDefinition[] = allow
        ? ALL_SHARED_TOOLS.filter((t) => allow.has(t.name))
        : ALL_SHARED_TOOLS.filter((t) => t.readOnly);

    const effectiveConfiguration: AnthropicConfiguration = {
        ...configuration,
        maxRounds: Math.max(1, options.maxRounds ?? 10),
        ...(typeof options.temperature === 'number' ? { temperature: options.temperature } : {}),
    };

    // Ephemeral profile for the sub-agent. Approval is pinned to 'never'
    // because the parent conversation can't pause for an approval bar.
    const profile: AnthropicProfile = {
        id: '__subagent__',
        name: '__subagent__',
        description: 'Ephemeral sub-agent profile',
        systemPrompt: options.systemPrompt
            ?? 'You are a sub-agent. Complete the requested task using the available tools and return a concise summary. Be direct.',
        toolApprovalMode: 'never',
        promptCachingEnabled: false, // no benefit for one-shot runs
    };

    const result = await AnthropicHandler.instance.sendMessage({
        userText: options.prompt,
        profile,
        configuration: effectiveConfiguration,
        tools,
        isolated: true,
    });

    return {
        summary: result.text,
        rounds: result.turnsUsed,
        toolCalls: result.toolCallCount,
        stopReason: result.stopReason ?? undefined,
    };
}
