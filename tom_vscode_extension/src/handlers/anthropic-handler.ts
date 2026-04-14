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

export interface AnthropicProfile {
    label: string;
    systemPrompt: string | null;
    configurationId: string;
    userMessageTemplateId?: string;
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
    /** Called when a write tool needs approval; resolve with `true` to allow. */
    requestApproval?: (toolName: string, inputSummary: string, toolUseId: string) => Promise<boolean>;
}

export interface AnthropicSendResult {
    text: string;
    turnsUsed: number;
    toolCallCount: number;
    stopReason?: string;
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

    static init(_context: vscode.ExtensionContext): AnthropicHandler {
        if (!AnthropicHandler._instance) {
            AnthropicHandler._instance = new AnthropicHandler();
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
     */
    async fetchModels(): Promise<{ models: Array<{ id: string; display_name?: string }>; error?: string }> {
        const client = this.getClient();
        if (!client) {
            return { models: [], error: 'ANTHROPIC_API_KEY environment variable not set' };
        }
        try {
            const page = await client.models.list({ limit: 100 });
            return {
                models: page.data.map((m) => ({ id: m.id, display_name: m.display_name })),
            };
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
                return {
                    text: lastText,
                    turnsUsed: turn + 1,
                    toolCallCount: totalToolCalls,
                    stopReason: lastStopReason,
                };
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
                );
                toolResults.push(toolResultBlock);
            }

            messages.push({ role: 'user', content: toolResults });
        }

        this.toolTrail.evictOldRounds();
        TrailService.instance.writeRawAnswer(
            { type: 'anthropic' },
            lastText,
            windowId,
            requestId,
            quest,
        );

        return {
            text: lastText,
            turnsUsed: configuration.maxRounds,
            toolCallCount: totalToolCalls,
            stopReason: lastStopReason,
        };
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
    ): Promise<AnthropicToolResultBlockParam> {
        const def = tools.find((t) => t.name === block.name);
        const input = (block.input ?? {}) as Record<string, unknown>;
        const inputSummary = this.summarizeInput(input);

        const approvalMode = configuration.toolApprovalMode ?? 'always';
        const needsApproval = def?.requiresApproval === true && approvalMode !== 'never';
        if (needsApproval && approvalMode === 'always' && !this.sessionApprovals.has(block.name)) {
            const approved = options.requestApproval
                ? await options.requestApproval(block.name, inputSummary, block.id)
                : false;
            if (!approved) {
                return {
                    type: 'tool_result',
                    tool_use_id: block.id,
                    is_error: true,
                    content: `Tool "${block.name}" was denied by the user.`,
                };
            }
        } else if (needsApproval && approvalMode === 'session' && !this.sessionApprovals.has(block.name)) {
            const approved = options.requestApproval
                ? await options.requestApproval(block.name, inputSummary, block.id)
                : false;
            if (!approved) {
                return {
                    type: 'tool_result',
                    tool_use_id: block.id,
                    is_error: true,
                    content: `Tool "${block.name}" was denied by the user.`,
                };
            }
            this.sessionApprovals.add(block.name);
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
            result = await executeToolCall(tools, {
                function: { name: block.name, arguments: input },
            });
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
        const raw = profile.systemPrompt ?? '';
        return resolveVariables(raw);
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
     * Build the `system` parameter. When `promptCachingEnabled`, returns a
     * block array with `cache_control: { type: 'ephemeral' }` so Anthropic
     * will cache the (typically long) system prompt. Otherwise a plain
     * string works and costs nothing extra.
     */
    private buildSystemParam(
        systemPrompt: string,
        configuration: AnthropicConfiguration,
    ): string | Anthropic.TextBlockParam[] {
        if (!systemPrompt) {
            return '';
        }
        if (configuration.promptCachingEnabled) {
            return [
                {
                    type: 'text',
                    text: systemPrompt,
                    cache_control: { type: 'ephemeral' },
                },
            ];
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
}
