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
    private readonly pendingApprovals = new Map<string, (approved: boolean) => void>();

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

    /**
     * Resolve the Promise awaiting approval for `toolUseId`. Called by
     * the chat panel when it receives the `anthropicToolApprovalResponse`
     * webview message. No-op if the id is unknown (already resolved or
     * never requested).
     */
    handleApprovalResponse(toolUseId: string, approved: boolean): void {
        const resolver = this.pendingApprovals.get(toolUseId);
        if (!resolver) {
            return;
        }
        this.pendingApprovals.delete(toolUseId);
        resolver(approved);
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
            this.pendingApprovals.set(req.toolUseId, resolve);
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

        const systemPrompt = this.buildSystemPrompt(profile);
        const expandedUser = this.buildUserMessage(options);
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
                return this.finalize(lastText, turn + 1, totalToolCalls, lastStopReason, windowId, requestId, quest);
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

        return this.finalize(lastText, configuration.maxRounds, totalToolCalls, lastStopReason, windowId, requestId, quest);
    }

    /**
     * Shared exit path: write the answer trail, evict old tool-trail
     * rounds, and return the result. Used by both the normal-stop and
     * max-rounds branches so each exchange always closes the same way.
     */
    private finalize(
        text: string,
        turnsUsed: number,
        toolCallCount: number,
        stopReason: string | undefined,
        windowId: string,
        requestId: string,
        quest: string,
    ): AnthropicSendResult {
        TrailService.instance.writeRawAnswer(
            { type: 'anthropic' },
            text,
            windowId,
            requestId,
            quest,
        );
        this.toolTrail.evictOldRounds();
        return { text, turnsUsed, toolCallCount, stopReason };
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

    private buildSystemPrompt(profile: AnthropicProfile): string {
        return resolveVariables(profile.systemPrompt ?? '');
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
