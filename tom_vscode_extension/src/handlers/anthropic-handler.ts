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
import * as https from 'https';
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
import { WsPaths } from '../utils/workspacePaths';
import { resolveVariables } from '../utils/variableResolver';

// ============================================================================
// Configuration shapes (subset — full schema in §14 of the spec)
// ============================================================================

export interface AnthropicConfiguration {
    id: string;
    name: string;
    model: string;
    maxTokens: number;
    temperature?: number;
    enabledTools: string[];
    memoryToolsEnabled?: boolean;
    historyMode?: string;
    maxHistoryTokens?: number;
    maxRounds: number;
    toolApprovalMode?: 'always' | 'session' | 'never';
    memoryExtractionTemplateId?: string;
    promptCachingEnabled?: boolean;
    isDefault?: boolean;
}

/**
 * Spec §7.2 `AnthropicProfileTemplate` (aliased as `AnthropicProfile` in
 * §12.2). Stored in `anthropic.profiles[]` in the workspace config JSON;
 * the Global Template Editor's `anthropicProfiles` category is the UI.
 */
export interface AnthropicProfile {
    id: string;
    name: string;
    description: string;
    systemPrompt: string;
    configurationId?: string;
    toolsEnabled?: boolean;
    maxRounds?: number;
    historyMode?: string | null;
    isDefault?: boolean;
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
}

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
            ...(params.temperature !== undefined ? { temperature: params.temperature } : {}),
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
     *
     * Uses a raw GET because the `models` resource only exists on newer
     * SDK versions; the stable 0.32 line does not expose it. The endpoint
     * itself is stable on the API side.
     */
    async fetchModels(): Promise<{ models: Array<{ id: string; display_name?: string }>; error?: string }> {
        const section = this.getAnthropicSection();
        const envVar = section.apiKeyEnvVar || 'ANTHROPIC_API_KEY';
        const apiKey = process.env[envVar];
        if (!apiKey) {
            return { models: [], error: `${envVar} environment variable not set` };
        }
        try {
            const json = await this.httpsGetJson('api.anthropic.com', '/v1/models?limit=100', {
                'x-api-key': apiKey,
                'anthropic-version': '2023-06-01',
            });
            const data = (json as { data?: Array<{ id: string; display_name?: string }> }).data;
            return { models: data ?? [] };
        } catch (err) {
            const msg = err instanceof Error ? err.message : String(err);
            return { models: [], error: msg };
        }
    }

    /** Main entry point — send a message and run the tool-call loop to completion. */
    async sendMessage(options: AnthropicSendOptions): Promise<AnthropicSendResult> {
        const client = this.getClient();
        if (!client) {
            throw new Error('Anthropic client not available — set the configured API key env var');
        }

        const { profile, configuration, tools, userText } = options;
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

        const systemPrompt = this.buildSystemPrompt(profile, quest);
        const expandedUser = this.buildUserMessage({ ...options, userText: effectiveUserText });
        const trailLinePrefix = this.toolTrail.toSummaryString();
        const userContent = trailLinePrefix
            ? `${trailLinePrefix}\n\n${expandedUser}`
            : expandedUser;

        TrailService.instance.writeRawPrompt(
            { type: 'anthropic' },
            `SYSTEM:\n${systemPrompt}\n\nUSER:\n${userContent}`,
            windowId,
            requestId,
            quest,
        );

        const anthropicTools = toAnthropicTools(tools);
        const messages: AnthropicMessageParam[] = [
            // Rolling history from prior exchanges — compacted per-turn
            // by the handler's post-exchange `compactHistory()` call.
            ...this.history.map((m) => ({
                role: m.role === 'system' ? 'user' : m.role as 'user' | 'assistant',
                content: m.content,
            })),
            { role: 'user', content: userContent },
        ];

        const systemParam = this.buildSystemParam(systemPrompt, configuration);
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
                ...(configuration.temperature !== undefined ? { temperature: configuration.temperature } : {}),
                system: systemParam,
                ...(anthropicTools.length > 0 ? { tools: anthropicTools } : {}),
                messages,
            });

            lastStopReason = response.stop_reason ?? undefined;
            lastText = this.extractText(response.content) || lastText;

            if (response.stop_reason !== 'tool_use') {
                return this.finalize(userContent, lastText, turn + 1, totalToolCalls, lastStopReason, windowId, requestId, quest, configuration);
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

        return this.finalize(userContent, lastText, configuration.maxRounds, totalToolCalls, lastStopReason, windowId, requestId, quest, configuration);
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
    ): AnthropicSendResult {
        TrailService.instance.writeRawAnswer(
            { type: 'anthropic' },
            text,
            windowId,
            requestId,
            quest,
        );
        this.toolTrail.evictOldRounds();

        // Accumulate this exchange into the rolling history, then
        // compact it asynchronously for the next turn.
        this.history.push({ role: 'user', content: userContent });
        this.history.push({ role: 'assistant', content: text });
        void this.compactHistoryAsync(configuration);

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
        _options: AnthropicSendOptions,
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
        // — e.g. `tomAi_chatvar_write` opts out because it has its own
        // real-time visibility mechanism (§8.5).
        const defaultRequiresApproval = def ? !def.readOnly : false;
        const requiresApproval = def?.requiresApproval ?? defaultRequiresApproval;
        const approvalMode = configuration.toolApprovalMode ?? 'always';
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
            { type: 'anthropic' },
            { id: block.id, name: block.name, input },
            windowId,
            quest,
        );

        const start = Date.now();
        let result = '';
        let error: string | undefined;
        try {
            // Ambient context so tools (e.g. tomAi_chatvar_write) can log
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
            { type: 'anthropic' },
            { id: block.id, name: block.name, result, durationMs, error },
            windowId,
            quest,
        );

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
        const base = resolveVariables(profile.systemPrompt ?? '');
        const memorySection = TomAiConfiguration.instance.getSection<{
            enabled?: boolean;
            injectIntoSystemPrompt?: boolean;
            maxInjectedTokens?: number;
        }>('memory') ?? {};
        if (memorySection.enabled === false || memorySection.injectIntoSystemPrompt === false) {
            return base;
        }
        const injection = TwoTierMemoryService.instance.injectForSystemPrompt(
            memorySection.maxInjectedTokens,
            questId,
        );
        if (!injection.text) {
            return base;
        }
        return base ? `${base}\n\n${injection.text}` : injection.text;
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
     *
     * The `cache_control` field is not declared on `TextBlockParam` in
     * SDK 0.32.1 (it graduated from the beta namespace in a later
     * release), so the caching branch is widened to `unknown[]` and cast
     * at the call site. The field is accepted by the stable API at
     * runtime regardless.
     */
    private buildSystemParam(
        systemPrompt: string,
        configuration: AnthropicConfiguration,
    ): string | Anthropic.TextBlockParam[] {
        if (!systemPrompt) {
            return '';
        }
        if (configuration.promptCachingEnabled) {
            const block = {
                type: 'text' as const,
                text: systemPrompt,
                cache_control: { type: 'ephemeral' },
            };
            return [block as unknown as Anthropic.TextBlockParam];
        }
        return systemPrompt;
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

    private httpsGetJson(host: string, pathAndQuery: string, headers: Record<string, string>): Promise<unknown> {
        return new Promise((resolve, reject) => {
            const req = https.request(
                {
                    method: 'GET',
                    host,
                    path: pathAndQuery,
                    headers,
                },
                (res) => {
                    const chunks: Buffer[] = [];
                    res.on('data', (c) => chunks.push(Buffer.from(c)));
                    res.on('end', () => {
                        const body = Buffer.concat(chunks).toString('utf8');
                        if (res.statusCode && res.statusCode >= 200 && res.statusCode < 300) {
                            try {
                                resolve(JSON.parse(body));
                            } catch (e) {
                                reject(new Error(`invalid JSON response: ${(e as Error).message}`));
                            }
                        } else {
                            reject(new Error(`HTTP ${res.statusCode ?? '?'} ${res.statusMessage ?? ''}: ${body.slice(0, 200)}`));
                        }
                    });
                },
            );
            req.on('error', reject);
            req.end();
        });
    }
}
