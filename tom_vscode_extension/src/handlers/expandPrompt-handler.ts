/**
 * Handler for the Prompt Expander feature (local Ollama LLM).
 *
 * Provides:
 *  - Multiple **model configurations** (with one marked as default)
 *  - Multiple **profiles** (system prompt + result template + temperature + model override),
 *    with one marked as default
 *  - Per-invocation config reload (always fresh from tom_vscode_extension.json)
 *  - Placeholders in systemPrompt and resultTemplate, including ${rawResponse}
 *    and ${thinkTagInfo}
 *  - Bridge API so Dart/JS scripts can access profiles, models, and
 *    trigger prompt expansion programmatically
 *  - Context-menu commands mirroring Send to Chat (submenu lists profiles)
 *
 * Configuration lives in the `promptExpander` section of tom_vscode_extension.json.
 */

import * as vscode from 'vscode';
import * as http from 'http';
import * as fs from 'fs';
import * as path from 'path';
import { handleError, bridgeLog, getBridgeClient, getConfigPath } from './handler_shared';
import { WsPaths } from '../utils/workspacePaths';
import {
    resolveTemplate,
    formatDateTime,
} from './promptTemplate';
import {
    OllamaTool, OllamaToolCall, SharedToolDefinition,
    executeToolCall, toOllamaTools,
} from '../tools/shared-tool-registry';
import { READ_ONLY_TOOLS } from '../tools/tool-executors';
import {
    clearTrail, logPrompt, logResponse, logToolRequest, logToolResult,
    logContinuationPrompt, isTrailEnabled, loadTrailConfig,
    type TrailType,
} from './trailLogger-handler';

// ============================================================================
// Interfaces
// ============================================================================

/** A named model configuration. */
export interface ModelConfig {
    /** Ollama server URL */
    ollamaUrl: string;
    /** Model name as known by Ollama (e.g. qwen3:8b) */
    model: string;
    /** Sampling temperature.  0 = deterministic, 2 = very random. */
    temperature: number;
    /** Whether to strip `<think>…</think>` tags from the response. */
    stripThinkingTags: boolean;
    /** Human-readable description shown in model selection quick-pick. */
    description?: string;
    /** If true this is the default model when no model is specified. */
    isDefault?: boolean;
    /** Ollama keep_alive duration (e.g. "5m", "1h", "0", "-1"). Default: "5m". */
    keepAlive?: string;
}

/** An LLM configuration entity (root level). */
export interface LlmConfiguration {
    /** Unique identifier. */
    id: string;
    /** Human-readable name. */
    name: string;
    /** Ollama server URL. */
    ollamaUrl: string;
    /** Model name as known by Ollama (e.g. qwen3:8b). */
    model: string;
    /** Sampling temperature.  0 = deterministic, 2 = very random. */
    temperature: number;
    /** Whether to strip `<think>…</think>` tags from the response. */
    stripThinkingTags: boolean;
    /** Maximum tokens for trail/history. */
    trailMaximumTokens: number;
    /** Remove prompt template from trail log. */
    removePromptTemplateFromTrail: boolean;
    /** Temperature for trail summarization. */
    trailSummarizationTemperature: number;
    /** List of enabled tool names for this configuration. */
    enabledTools: string[];
    /** If true this is the default configuration. */
    isDefault?: boolean;
    /** Ollama keep_alive duration (e.g. "5m", "1h", "0", "-1"). Default: "5m". */
    keepAlive?: string;
}

/** A named expansion profile. */
export interface ExpanderProfile {
    /** Human-readable label shown in quick-pick / context menu. */
    label: string;
    /** Override system prompt (null → inherit top-level). */
    systemPrompt: string | null;
    /** Override result template (null → inherit top-level). */
    resultTemplate: string | null;
    /** Override temperature (null → inherit from model config). */
    temperature: number | null;
    /** Override model config key (null → use default model). */
    modelConfig: string | null;
    /** If true this is the default profile when no profile is specified. */
    isDefault?: boolean;
    /** When true, provide read-only tools (web search, file read, etc.) to the model. */
    toolsEnabled?: boolean;
    /** Maximum tool-call rounds for this profile (default: 20). */
    maxRounds?: number;
    /** Override history mode (null → inherit top-level). */
    historyMode?: LocalLlmHistoryMode | null;
}

/** History mode for Local LLM. */
export type LocalLlmHistoryMode = 'none' | 'full' | 'last' | 'summary' | 'trim_and_summary';

/** Full promptExpander section from tom_vscode_extension.json. */
export interface PromptExpanderConfig {
    /** Default model settings (backward compat, used when models section is absent). */
    ollamaUrl: string;
    model: string;
    temperature: number;
    stripThinkingTags: boolean;
    /** Default system prompt. */
    systemPrompt: string;
    /** Default result template. */
    resultTemplate: string;
    /** Named model configurations. */
    models: { [key: string]: ModelConfig };
    /** Named profiles. */
    profiles: { [key: string]: ExpanderProfile };
    /** Global setting: enable tools by default. */
    toolsEnabled: boolean;
    /** Default expansion profile key. */
    expansionProfile: string | null;
    /** Maximum tokens for trail/history. */
    trailMaximumTokens: number;
    /** Temperature for trail summarization. */
    trailSummarizationTemperature: number;
    /** Remove prompt template from trail log. */
    removePromptTemplateFromTrail: boolean;
    /** How much history to pass to the local model. */
    historyMode: LocalLlmHistoryMode;
    /** Maximum token count for history passed to local model. */
    maxHistoryTokens: number;
    /** LLM configuration entities (root level). */
    llmConfigurations: LlmConfiguration[];
}

/** Result returned by the process() bridge API. */
export interface ExpanderProcessResult {
    success: boolean;
    /** The final text after template expansion. */
    result: string;
    /** The raw LLM response before any processing. */
    rawResponse: string;
    /** The cleaned response (after think-tag stripping). */
    response: string;
    /** Extracted <think> tag content, if any. */
    thinkTagContent: string;
    /** Profile key used. */
    profile: string;
    /** Model config key used. */
    modelConfig: string;
    error?: string;
    /** Token usage statistics from Ollama. */
    tokenInfo?: {
        promptTokens: number;
        completionTokens: number;
        totalDurationMs: number;
        loadDurationMs: number;
    };
    /** Number of tool calls made during generation (0 if tools not used). */
    toolCallCount?: number;
    /** Number of tool-call rounds used. */
    turnsUsed?: number;
    /** Maximum tool-call rounds allowed. */
    maxTurns?: number;
}

/** Stats returned by Ollama in the final streaming chunk. */
export interface OllamaStats {
    promptTokens: number;
    completionTokens: number;
    totalDurationMs: number;
    loadDurationMs: number;
}

// ============================================================================
// Hardcoded defaults
// ============================================================================

const DEFAULT_SYSTEM_PROMPT = `You are a prompt expansion assistant. Your job is to take a short, terse user prompt and expand it into a detailed, well-structured prompt that will produce better results from an AI coding assistant (GitHub Copilot).

Rules:
- Keep the original intent exactly — do not add tasks the user did not ask for.
- Add structure: break vague requests into clear, numbered steps if appropriate.
- Add specificity: if the user mentions a file, technology, or pattern, reference it explicitly.
- Add quality cues: remind the assistant to handle edge cases, follow conventions, write tests if applicable.
- Keep it concise — expand, don't bloat. A good expansion is 2-5x the original length, not 20x.
- Output ONLY the expanded prompt text. No explanations, no markdown fences, no preamble.
- Do NOT wrap your output in thinking tags or chain-of-thought. Output the final prompt directly.
- Preserve any special syntax the user wrote (e.g., !prompt, $prompt, file paths, code snippets).
- Write in the same language/tone as the original prompt.`;

const DEFAULTS: PromptExpanderConfig = {
    ollamaUrl: 'http://localhost:11434',
    model: 'qwen3:8b',
    temperature: 0.4,
    stripThinkingTags: true,
    systemPrompt: DEFAULT_SYSTEM_PROMPT,
    resultTemplate: '${response}',
    models: {},
    profiles: {},
    toolsEnabled: true,
    expansionProfile: null,
    trailMaximumTokens: 8000,
    trailSummarizationTemperature: 0.3,
    removePromptTemplateFromTrail: true,
    historyMode: 'none',
    maxHistoryTokens: 4000,
    llmConfigurations: [],
};

// ============================================================================
// Module-level logging helper for exported handler functions
// ============================================================================

/**
 * Logs messages to the Tom AI Local Log output channel via the manager.
 * Falls back to console.log if the manager is not yet initialised.
 */
function logLocalAi(message: string, level: 'INFO' | 'WARN' | 'ERROR' = 'INFO'): void {
    const timestamp = new Date().toISOString().slice(11, 23);
    const line = `[${timestamp}] [${level}] ${message}`;
    if (_manager) {
        _manager.appendToLog(line);
    } else {
        console.log(`[LocalAI] ${line}`);
    }
}

// ============================================================================
// PromptExpanderManager — singleton, created in extension.ts
// ============================================================================

/** A single conversation message for Local LLM history. */
export interface LocalLlmMessage {
    role: 'user' | 'assistant' | 'system';
    content: string;
    timestamp?: Date;
}

export class PromptExpanderManager {
    private context: vscode.ExtensionContext;
    private registeredCommands: vscode.Disposable[] = [];
    private outputChannel: vscode.OutputChannel;
    private logChannel: vscode.OutputChannel;
    /** Conversation history for Local LLM sessions. */
    private conversationHistory: LocalLlmMessage[] = [];
    /** Whether history mode is enabled. */
    private historyEnabled: boolean = false;

    constructor(context: vscode.ExtensionContext) {
        this.context = context;
        this.outputChannel = vscode.window.createOutputChannel('Tom AI Local LLM');
        this.logChannel = vscode.window.createOutputChannel('Tom AI Local Log');
        context.subscriptions.push(this.outputChannel, this.logChannel);
    }

    dispose(): void {
        for (const cmd of this.registeredCommands) {
            cmd.dispose();
        }
        this.registeredCommands = [];
    }

    /** Append a line to the Tom AI Local Log output channel (used by module-level helpers). */
    appendToLog(line: string): void {
        this.logChannel.appendLine(line);
    }

    // -----------------------------------------------------------------------
    // History Management
    // -----------------------------------------------------------------------

    /** Enable or disable history mode. */
    setHistoryEnabled(enabled: boolean): void {
        this.historyEnabled = enabled;
        this.logChannel.appendLine(`[History] Mode ${enabled ? 'enabled' : 'disabled'}`);
    }

    /** Check if history mode is enabled. */
    isHistoryEnabled(): boolean {
        return this.historyEnabled;
    }

    /** Clear conversation history. */
    clearHistory(): void {
        this.conversationHistory = [];
        this.logChannel.appendLine('[History] Cleared');
    }

    /** Get current conversation history. */
    getHistory(): LocalLlmMessage[] {
        return [...this.conversationHistory];
    }

    /** Get history as Ollama-compatible messages. */
    private getHistoryAsMessages(): Array<{ role: string; content: string }> {
        return this.conversationHistory.map(m => ({
            role: m.role,
            content: m.content,
        }));
    }

    /** Add a message to conversation history. */
    private addToHistory(role: 'user' | 'assistant', content: string): void {
        this.conversationHistory.push({
            role,
            content,
            timestamp: new Date(),
        });
    }

    // -----------------------------------------------------------------------
    // Config loading — always fresh on every invocation
    // -----------------------------------------------------------------------

    private getConfigPath(): string | undefined {
        return getConfigPath();
    }

    /** Load config fresh from disk + VS Code settings. Never cached. */
    loadConfig(): PromptExpanderConfig {
        const config: PromptExpanderConfig = { ...DEFAULTS, models: {}, profiles: {} };

        // VS Code settings fallback
        const vsTomAi = vscode.workspace.getConfiguration('tomAi.ollama');
        const vsLegacy = vscode.workspace.getConfiguration('tomAi.ollama');
        const vsUrl = vsTomAi.get<string>('url') || vsLegacy.get<string>('url');
        const vsModel = vsTomAi.get<string>('model') || vsLegacy.get<string>('model');
        if (vsUrl) { config.ollamaUrl = vsUrl; }
        if (vsModel) { config.model = vsModel; }

        const configPath = this.getConfigPath();
        if (!configPath || !fs.existsSync(configPath)) { return config; }

        try {
            const raw = fs.readFileSync(configPath, 'utf-8');
            const parsed = JSON.parse(raw);
            const sec = parsed?.promptExpander;
            if (!sec || typeof sec !== 'object') { return config; }

            // Top-level scalars
            if (typeof sec.ollamaUrl === 'string') { config.ollamaUrl = sec.ollamaUrl; }
            if (typeof sec.model === 'string') { config.model = sec.model; }
            if (typeof sec.temperature === 'number') { config.temperature = sec.temperature; }
            if (typeof sec.stripThinkingTags === 'boolean') { config.stripThinkingTags = sec.stripThinkingTags; }
            if (typeof sec.systemPrompt === 'string') { config.systemPrompt = sec.systemPrompt; }
            if (typeof sec.resultTemplate === 'string') { config.resultTemplate = sec.resultTemplate; }
            if (typeof sec.toolsEnabled === 'boolean') { config.toolsEnabled = sec.toolsEnabled; }
            if (typeof sec.expansionProfile === 'string') { config.expansionProfile = sec.expansionProfile; }
            if (typeof sec.trailMaximumTokens === 'number') { config.trailMaximumTokens = sec.trailMaximumTokens; }
            if (typeof sec.trailSummarizationTemperature === 'number') { config.trailSummarizationTemperature = sec.trailSummarizationTemperature; }
            if (typeof sec.removePromptTemplateFromTrail === 'boolean') { config.removePromptTemplateFromTrail = sec.removePromptTemplateFromTrail; }
            if (typeof sec.historyMode === 'string') { config.historyMode = sec.historyMode as LocalLlmHistoryMode; }
            if (typeof sec.maxHistoryTokens === 'number') { config.maxHistoryTokens = sec.maxHistoryTokens; }

            // Model configurations
            if (sec.models && typeof sec.models === 'object') {
                for (const [key, val] of Object.entries(sec.models)) {
                    const m = val as any;
                    if (m && typeof m === 'object') {
                        config.models[key] = {
                            ollamaUrl: typeof m.ollamaUrl === 'string' ? m.ollamaUrl : config.ollamaUrl,
                            model: typeof m.model === 'string' ? m.model : config.model,
                            temperature: typeof m.temperature === 'number' ? m.temperature : config.temperature,
                            stripThinkingTags: typeof m.stripThinkingTags === 'boolean' ? m.stripThinkingTags : config.stripThinkingTags,
                            description: typeof m.description === 'string' ? m.description : undefined,
                            isDefault: m.isDefault === true,
                            keepAlive: typeof m.keepAlive === 'string' ? m.keepAlive : undefined,
                        };
                    }
                }
            }

            // Profiles
            if (sec.profiles && typeof sec.profiles === 'object') {
                for (const [key, val] of Object.entries(sec.profiles)) {
                    const p = val as any;
                    if (p && typeof p === 'object') {
                        config.profiles[key] = {
                            label: typeof p.label === 'string' ? p.label : key,
                            systemPrompt: typeof p.systemPrompt === 'string' ? p.systemPrompt : null,
                            resultTemplate: typeof p.resultTemplate === 'string' ? p.resultTemplate : null,
                            temperature: typeof p.temperature === 'number' ? p.temperature : null,
                            modelConfig: typeof p.modelConfig === 'string' ? p.modelConfig : null,
                            isDefault: p.isDefault === true,
                            toolsEnabled: typeof p.toolsEnabled === 'boolean' ? p.toolsEnabled : undefined,
                            maxRounds: typeof p.maxRounds === 'number' ? p.maxRounds : undefined,
                            historyMode: typeof p.historyMode === 'string' ? p.historyMode as LocalLlmHistoryMode : undefined,
                        };
                    }
                }
            }

            // Backward compat: old "defaultProfile" field
            if (typeof sec.defaultProfile === 'string' && config.profiles[sec.defaultProfile]) {
                // If no profile is marked isDefault, mark the old defaultProfile
                const anyDefault = Object.values(config.profiles).some((p) => p.isDefault);
                if (!anyDefault) {
                    config.profiles[sec.defaultProfile].isDefault = true;
                }
            }

            // LLM configurations (root-level array)
            if (Array.isArray(parsed.llmConfigurations)) {
                config.llmConfigurations = [];
                for (const lc of parsed.llmConfigurations) {
                    if (lc && typeof lc === 'object' && typeof lc.id === 'string') {
                        config.llmConfigurations.push({
                            id: lc.id,
                            name: typeof lc.name === 'string' ? lc.name : lc.id,
                            ollamaUrl: typeof lc.ollamaUrl === 'string' ? lc.ollamaUrl : config.ollamaUrl,
                            model: typeof lc.model === 'string' ? lc.model : config.model,
                            temperature: typeof lc.temperature === 'number' ? lc.temperature : config.temperature,
                            stripThinkingTags: typeof lc.stripThinkingTags === 'boolean' ? lc.stripThinkingTags : config.stripThinkingTags,
                            trailMaximumTokens: typeof lc.trailMaximumTokens === 'number' ? lc.trailMaximumTokens : config.trailMaximumTokens,
                            removePromptTemplateFromTrail: typeof lc.removePromptTemplateFromTrail === 'boolean' ? lc.removePromptTemplateFromTrail : config.removePromptTemplateFromTrail,
                            trailSummarizationTemperature: typeof lc.trailSummarizationTemperature === 'number' ? lc.trailSummarizationTemperature : config.trailSummarizationTemperature,
                            enabledTools: Array.isArray(lc.enabledTools) ? lc.enabledTools.filter((t: any) => typeof t === 'string') : [],
                            isDefault: lc.isDefault === true,
                            keepAlive: typeof lc.keepAlive === 'string' ? lc.keepAlive : undefined,
                        });
                    }
                }
            }
        } catch (err) {
            bridgeLog(`[Prompt Expander] Failed to parse config: ${err}`);
        }

        return config;
    }

    // -----------------------------------------------------------------------
    // Resolve helpers
    // -----------------------------------------------------------------------

    /** Find the default model config key, or undefined if none. */
    getDefaultModelKey(config: PromptExpanderConfig): string | undefined {
        for (const [key, m] of Object.entries(config.models)) {
            if (m.isDefault) { return key; }
        }
        // First model wins if none marked default
        const keys = Object.keys(config.models);
        return keys.length > 0 ? keys[0] : undefined;
    }

    /** Find the default profile key, or undefined if none. */
    getDefaultProfileKey(config: PromptExpanderConfig): string | undefined {
        for (const [key, p] of Object.entries(config.profiles)) {
            if (p.isDefault) { return key; }
        }
        const keys = Object.keys(config.profiles);
        return keys.length > 0 ? keys[0] : undefined;
    }

    /** Resolve model config: explicit key → profile override → default model → llmConfigurations → top-level values. */
    resolveModelConfig(config: PromptExpanderConfig, profile?: ExpanderProfile, explicitModelKey?: string): { key: string; mc: ModelConfig } {
        const modelKey = explicitModelKey ?? profile?.modelConfig ?? this.getDefaultModelKey(config);
        if (modelKey && config.models[modelKey]) {
            return { key: modelKey, mc: config.models[modelKey] };
        }
        // Check llmConfigurations array (root-level entities)
        if (modelKey && config.llmConfigurations) {
            const llmConfig = config.llmConfigurations.find(c => c.id === modelKey);
            if (llmConfig) {
                return {
                    key: llmConfig.id,
                    mc: {
                        ollamaUrl: llmConfig.ollamaUrl,
                        model: llmConfig.model,
                        temperature: llmConfig.temperature,
                        stripThinkingTags: llmConfig.stripThinkingTags,
                        description: llmConfig.name,
                        isDefault: llmConfig.isDefault,
                        keepAlive: llmConfig.keepAlive,
                    },
                };
            }
        }
        // Check for default llmConfiguration
        if (config.llmConfigurations && config.llmConfigurations.length > 0) {
            const defaultLlm = config.llmConfigurations.find(c => c.isDefault) || config.llmConfigurations[0];
            if (defaultLlm && !modelKey) {
                return {
                    key: defaultLlm.id,
                    mc: {
                        ollamaUrl: defaultLlm.ollamaUrl,
                        model: defaultLlm.model,
                        temperature: defaultLlm.temperature,
                        stripThinkingTags: defaultLlm.stripThinkingTags,
                        description: defaultLlm.name,
                        isDefault: defaultLlm.isDefault,
                        keepAlive: defaultLlm.keepAlive,
                    },
                };
            }
        }
        // Synthesize from top-level values
        return {
            key: '_default',
            mc: {
                ollamaUrl: config.ollamaUrl,
                model: config.model,
                temperature: config.temperature,
                stripThinkingTags: config.stripThinkingTags,
                isDefault: true,
                keepAlive: '5m',
            },
        };
    }

    // -----------------------------------------------------------------------
    // Think-tag processing
    // -----------------------------------------------------------------------

    /** Extract <think>…</think> content and return cleaned text + extracted content. */
    private processThinkTags(text: string, strip: boolean): { cleaned: string; thinkContent: string } {
        const thinkMatch = text.match(/<think>([\s\S]*?)<\/think>/g);
        let thinkContent = '';
        if (thinkMatch) {
            thinkContent = thinkMatch
                .map((m) => m.replace(/<\/?think>/g, '').trim())
                .join('\n---\n');
        }
        const cleaned = strip
            ? text.replace(/<think>[\s\S]*?<\/think>/g, '').trim()
            : text;
        return { cleaned, thinkContent };
    }

    // -----------------------------------------------------------------------
    // Placeholder resolution (delegates to promptTemplate module)
    // -----------------------------------------------------------------------

    /**
     * Available placeholders:
     *   ${original}      - The original prompt text before expansion
     *   ${response}      - The cleaned LLM response (after think-tag stripping if enabled)
     *   ${rawResponse}   - The raw LLM response exactly as received
     *   ${thinkTagInfo}  - Extracted content from <think> tags (empty if none)
     *   ${filename}      - Basename of the active file
     *   ${filePath}      - Full path to the active file
     *   ${languageId}    - VS Code language ID
     *   ${workspaceName} - Name of the first workspace folder
     *   ${datetime}      - Current date/time as yyyymmdd_hhmmss
     *   ${model}         - The Ollama model name used
     *   ${modelConfig}   - The model config key used
     *   ${profile}       - The profile key used
     *   ${lineStart}     - Start line of the selection (1-based)
     *   ${lineEnd}       - End line of the selection (1-based)
     *   ${turnsUsed}     - Number of tool-call rounds completed so far
     *   ${turnsRemaining} - Remaining tool-call rounds before the hard limit
     *   ${maxTurns}      - Maximum tool-call rounds allowed
     *   ${instructions}   - Content from .tom/local-instructions/local-instructions[.modelid].md
     */
    private resolvePlaceholders(template: string, values: { [key: string]: string }): string {
        return resolveTemplate(template, values);
    }

    private buildPlaceholderValues(
        editor: vscode.TextEditor | undefined,
        original: string,
        rawResponse: string,
        cleanedResponse: string,
        thinkContent: string,
        modelName: string,
        modelConfigKey: string,
        profileName: string,
        turnInfo?: { turnsUsed: number; maxTurns: number },
        extraValues?: { [key: string]: string },
    ): { [key: string]: string } {
        const now = new Date();
        const wf = vscode.workspace.workspaceFolders;
        const doc = editor?.document;
        const sel = editor?.selection;
        const used = turnInfo?.turnsUsed ?? 0;
        const max = turnInfo?.maxTurns ?? 0;

        return {
            original,
            response: cleanedResponse,
            rawResponse,
            thinkTagInfo: thinkContent,
            filename: doc ? path.basename(doc.fileName) : '',
            filePath: doc?.fileName ?? '',
            languageId: doc?.languageId ?? '',
            workspaceName: wf?.[0]?.name ?? '',
            datetime: formatDateTime(now),
            model: modelName,
            modelConfig: modelConfigKey,
            profile: profileName,
            lineStart: sel ? String(sel.start.line + 1) : '0',
            lineEnd: sel ? String(sel.end.line + 1) : '0',
            turnsUsed: String(used),
            turnsRemaining: String(Math.max(0, max - used)),
            maxTurns: String(max),
            ...extraValues,
        };
    }

    /**
     * Resolve the ${instructions} placeholder content.
     * Looks for `.tom/local-instructions/local-instructions.<modelid>.md` first,
     * then `.tom/local-instructions/local-instructions.md`.
     * Returns empty string if neither exists.
     */
    private resolveInstructionsContent(modelName: string): string {
        const dir = WsPaths.wsConfig('local-instructions');
        if (!dir) { return ''; }

        // Model-specific file first (strip tag after colon, e.g. "qwen3:8b" → "qwen3-8b")
        const safeModelId = modelName.replace(/[:/\\]/g, '-');
        const modelSpecific = path.join(dir, `local-instructions.${safeModelId}.md`);
        if (fs.existsSync(modelSpecific)) {
            try { return fs.readFileSync(modelSpecific, 'utf-8'); } catch { /* fall through */ }
        }

        // Generic fallback
        const generic = path.join(dir, 'local-instructions.md');
        if (fs.existsSync(generic)) {
            try { return fs.readFileSync(generic, 'utf-8'); } catch { /* fall through */ }
        }

        return '';
    }

    // -----------------------------------------------------------------------
    // Ollama API
    // -----------------------------------------------------------------------

    private async isOllamaRunning(baseUrl: string): Promise<boolean> {
        return new Promise((resolve) => {
            const url = new URL(baseUrl);
            const req = http.request(
                { hostname: url.hostname, port: url.port, path: '/', method: 'GET', timeout: 3000 },
                (res) => { resolve(res.statusCode === 200); },
            );
            req.on('error', () => resolve(false));
            req.on('timeout', () => { req.destroy(); resolve(false); });
            req.end();
        });
    }

    /** Check if a specific model is currently loaded in Ollama via GET /api/ps. */
    private async isModelLoaded(baseUrl: string, modelName: string): Promise<boolean> {
        return new Promise((resolve) => {
            const u = new URL('/api/ps', baseUrl);
            const req = http.request(
                { hostname: u.hostname, port: u.port, path: u.pathname, method: 'GET', timeout: 3000 },
                (res) => {
                    let body = '';
                    res.on('data', (chunk: Buffer) => { body += chunk.toString(); });
                    res.on('end', () => {
                        try {
                            const parsed = JSON.parse(body);
                            const loaded = (parsed.models ?? []).some(
                                (m: any) => (m.name ?? m.model ?? '') === modelName,
                            );
                            resolve(loaded);
                        } catch {
                            resolve(false);
                        }
                    });
                    res.on('error', () => resolve(false));
                },
            );
            req.on('error', () => resolve(false));
            req.on('timeout', () => { req.destroy(); resolve(false); });
            req.end();
        });
    }

    private async ollamaGenerate(
        baseUrl: string,
        model: string,
        systemPrompt: string,
        userPrompt: string,
        temperature: number,
        onToken?: (token: string) => void,
        cancellationToken?: vscode.CancellationToken,
        keepAlive?: string,
        tools?: OllamaTool[],
    ): Promise<{ text: string; stats?: OllamaStats; toolCalls?: OllamaToolCall[] }> {
        return this.ollamaChat(baseUrl, model, [
            { role: 'system', content: systemPrompt },
            { role: 'user', content: userPrompt },
        ], temperature, onToken, cancellationToken, keepAlive, tools);
    }

    /**
     * Low-level Ollama /api/chat call with full message history support.
     * Handles streaming, stats extraction, and tool-call detection.
     */
    private async ollamaChat(
        baseUrl: string,
        model: string,
        // eslint-disable-next-line @typescript-eslint/naming-convention
        messages: Array<{ role: string; content?: string; tool_calls?: OllamaToolCall[] }>,
        temperature: number,
        onToken?: (token: string) => void,
        cancellationToken?: vscode.CancellationToken,
        keepAlive?: string,
        tools?: OllamaTool[],
    ): Promise<{ text: string; stats?: OllamaStats; toolCalls?: OllamaToolCall[] }> {
        return new Promise((resolve, reject) => {
            const url = new URL('/api/chat', baseUrl);
            const body = JSON.stringify({
                model,
                messages,
                stream: true,
                options: { temperature },
                // eslint-disable-next-line @typescript-eslint/naming-convention
                ...(keepAlive !== undefined ? { keep_alive: keepAlive } : {}),
                ...(tools && tools.length > 0 ? { tools } : {}),
            });

            const req = http.request(
                {
                    hostname: url.hostname,
                    port: url.port,
                    path: url.pathname,
                    method: 'POST',
                    // eslint-disable-next-line @typescript-eslint/naming-convention
                    headers: { 'Content-Type': 'application/json' },
                },
                (res) => {
                    let fullResponse = '';
                    let buffer = '';
                    let stats: OllamaStats | undefined;
                    let toolCalls: OllamaToolCall[] | undefined;

                    res.on('data', (chunk: Buffer) => {
                        buffer += chunk.toString();
                        const lines = buffer.split('\n');
                        buffer = lines.pop() ?? '';
                        for (const line of lines) {
                            if (!line.trim()) { continue; }
                            try {
                                const parsed = JSON.parse(line);
                                if (parsed.message?.content) {
                                    fullResponse += parsed.message.content;
                                    onToken?.(parsed.message.content);
                                }
                                // Detect tool calls from model
                                if (parsed.message?.tool_calls && parsed.message.tool_calls.length > 0) {
                                    toolCalls = parsed.message.tool_calls;
                                }
                                if (parsed.done === true) {
                                    stats = {
                                        promptTokens: parsed.prompt_eval_count ?? 0,
                                        completionTokens: parsed.eval_count ?? 0,
                                        totalDurationMs: Math.round((parsed.total_duration ?? 0) / 1e6),
                                        loadDurationMs: Math.round((parsed.load_duration ?? 0) / 1e6),
                                    };
                                }
                            } catch { /* partial JSON */ }
                        }
                    });

                    res.on('end', () => {
                        if (buffer.trim()) {
                            try {
                                const parsed = JSON.parse(buffer);
                                if (parsed.message?.content) {
                                    fullResponse += parsed.message.content;
                                }
                                if (parsed.message?.tool_calls && parsed.message.tool_calls.length > 0) {
                                    toolCalls = parsed.message.tool_calls;
                                }
                                if (parsed.done === true && !stats) {
                                    stats = {
                                        promptTokens: parsed.prompt_eval_count ?? 0,
                                        completionTokens: parsed.eval_count ?? 0,
                                        totalDurationMs: Math.round((parsed.total_duration ?? 0) / 1e6),
                                        loadDurationMs: Math.round((parsed.load_duration ?? 0) / 1e6),
                                    };
                                }
                            } catch { /* ignore */ }
                        }
                        resolve({ text: fullResponse, stats, toolCalls });
                    });
                    res.on('error', reject);
                },
            );

            if (cancellationToken) {
                cancellationToken.onCancellationRequested(() => {
                    req.destroy();
                    reject(new Error('Cancelled'));
                });
            }

            req.on('error', reject);
            req.write(body);
            req.end();
        });
    }

    /**
     * Run an Ollama chat with automatic tool-call loop.
     *
     * When the model requests tool calls, the tools are executed and results
     * are fed back as `tool` role messages. The loop continues until the model
     * produces a final text response (no tool calls) or the max round limit
     * is reached.
     *
     * @param maxRounds Safety cap on tool-call iterations (default 10)
     * @param onToolCall Optional callback for UI feedback per tool invocation
     */
    public async ollamaGenerateWithTools(options: {
        baseUrl: string;
        model: string;
        systemPrompt: string;
        userPrompt: string;
        temperature: number;
        tools: SharedToolDefinition[];
        onToken?: (token: string) => void;
        onToolCall?: (toolName: string, args: Record<string, unknown>, result: string) => void;
        cancellationToken?: vscode.CancellationToken;
        keepAlive?: string;
        maxRounds?: number;
        /** Trail type for logging (defaults to 'local'). */
        trailType?: TrailType;
        /** Optional conversation history to prepend. */
        history?: Array<{ role: string; content: string }>;
    }): Promise<{ text: string; stats?: OllamaStats; toolCallCount: number; turnsUsed: number }> {
        const {
            baseUrl, model, systemPrompt, userPrompt, temperature,
            tools, onToken, onToolCall, cancellationToken, keepAlive,
        } = options;
        const maxRounds = options.maxRounds ?? 20;
        const trailType = options.trailType ?? 'local';
        const history = options.history ?? [];
        const ollamaTools = toOllamaTools(tools, () => true); // send all provided tools

        // Log tool registrations and prompts
        this.logChannel.appendLine('═══════════════════════════════════════════════════');
        this.logChannel.appendLine(`Ollama Request — ${new Date().toLocaleTimeString()}`);
        this.logChannel.appendLine(`  Model: ${model} | URL: ${baseUrl}`);
        this.logChannel.appendLine(`  Max rounds: ${maxRounds} | Temperature: ${temperature}`);
        this.logChannel.appendLine(`  Keep alive: ${keepAlive ?? 'default'}`);
        this.logChannel.appendLine(`  History messages: ${history.length}`);
        this.logChannel.appendLine('───────────────────────────────────────────────────');
        this.logChannel.appendLine(`Registered tools (${ollamaTools.length}):`);
        for (const t of ollamaTools) {
            this.logChannel.appendLine(`  • ${t.function.name}: ${(t.function.description ?? '').substring(0, 120)}`);
        }
        this.logChannel.appendLine('───────────────────────────────────────────────────');
        this.logChannel.appendLine('System Prompt:');
        this.logChannel.appendLine(systemPrompt);
        this.logChannel.appendLine('───────────────────────────────────────────────────');
        this.logChannel.appendLine('User Prompt:');
        this.logChannel.appendLine(userPrompt);
        this.logChannel.appendLine('═══════════════════════════════════════════════════');

        // Build initial message history
        // eslint-disable-next-line @typescript-eslint/naming-convention
        const messages: Array<{ role: string; content?: string; tool_calls?: OllamaToolCall[] }> = [
            { role: 'system', content: systemPrompt },
        ];

        // Include conversation history if provided
        if (history.length > 0) {
            this.logChannel.appendLine(`Including ${history.length} history message(s)`);
            for (const h of history) {
                messages.push({ role: h.role, content: h.content });
            }
        }

        // Current user prompt
        messages.push({ role: 'user', content: userPrompt });

        let totalToolCalls = 0;

        for (let round = 0; round < maxRounds; round++) {
            // Inject turn budget as a system-level note so the model knows its limits
            const remaining = maxRounds - round;
            if (round > 0) {
                let budgetNote = `[Turn ${round + 1}/${maxRounds} — ${remaining - 1} tool rounds remaining after this one.`;
                if (remaining <= 2) {
                    budgetNote += ` URGENT: You are almost out of turns. Provide your FINAL answer now without calling more tools.`;
                } else if (remaining <= 5) {
                    budgetNote += ` You are running low on turns. Start wrapping up and produce your answer soon.`;
                } else {
                    budgetNote += ` When you have enough context, produce your final answer without calling tools.`;
                }
                budgetNote += ']';
                messages.push({ role: 'system', content: budgetNote });

                // Trail: Log continuation prompt with turn budget
                logContinuationPrompt(trailType, 'ollama', [{
                    role: 'system',
                    content: budgetNote,
                    round: round + 1,
                    remaining: remaining - 1,
                    totalToolCallsSoFar: totalToolCalls,
                }]);
            }

            // On the very last round, don't offer tools — force a text-only response
            const roundTools = remaining <= 1 ? [] : ollamaTools;

            const result = await this.ollamaChat(
                baseUrl, model, messages, temperature,
                onToken, cancellationToken, keepAlive,
                roundTools.length > 0 ? roundTools : undefined,
            );

            // No tool calls → model produced a final text response
            if (!result.toolCalls || result.toolCalls.length === 0) {
                this.logChannel.appendLine(`✅ Final response after ${round + 1} round(s), ${totalToolCalls} tool call(s)`);
                this.logChannel.appendLine('');
                return { text: result.text, stats: result.stats, toolCallCount: totalToolCalls, turnsUsed: round + 1 };
            }

            // Trail: Log intermediate response with tool calls
            logResponse(trailType, 'ollama', result.text || '', false, {
                round: round + 1,
                toolCallsInRound: result.toolCalls.length,
                toolNames: result.toolCalls.map(tc => tc.function.name),
            });

            // Append assistant message with tool_calls
            messages.push({
                role: 'assistant',
                content: result.text || undefined,
                // eslint-disable-next-line @typescript-eslint/naming-convention
                tool_calls: result.toolCalls,
            });

            // Execute each tool and append results
            for (const tc of result.toolCalls) {
                totalToolCalls++;

                // Trail: Log tool request
                logToolRequest(trailType, tc.function.name, tc.function.arguments);

                const toolResult = await executeToolCall(tools, tc);
                onToolCall?.(tc.function.name, tc.function.arguments, toolResult);

                // Trail: Log tool result
                logToolResult(trailType, tc.function.name, toolResult);

                // Log tool call to log channel
                this.logChannel.appendLine(`[Round ${round + 1}] Tool #${totalToolCalls}: ${tc.function.name}`);
                this.logChannel.appendLine(`  Args: ${JSON.stringify(tc.function.arguments)}`);
                const shortResult = toolResult.length > 300 ? toolResult.substring(0, 297) + '...' : toolResult;
                this.logChannel.appendLine(`  Result (${toolResult.length} chars): ${shortResult}`);

                messages.push({
                    role: 'tool',
                    content: toolResult,
                });
            }
        }

        // Max rounds exceeded — return whatever text we have
        this.logChannel.appendLine(`⚠️  Tool call limit reached after ${maxRounds} rounds (${totalToolCalls} total tool calls)`);
        return {
            text: `[Tool call limit reached after ${maxRounds} rounds]\n\n` +
                  (messages.filter(m => m.role === 'assistant').pop()?.content ?? ''),
            toolCallCount: totalToolCalls,
            turnsUsed: maxRounds,
        };
    }

    // -----------------------------------------------------------------------
    // Core processing — used by both the command handler and the bridge API
    // -----------------------------------------------------------------------

    // -----------------------------------------------------------------------
    // Public API — for use by other handlers (e.g. BotConversationManager)
    // -----------------------------------------------------------------------

    /**
     * Public method to chat with Ollama using the configured model.
     * Used by other handlers that need Ollama interaction without full prompt-expansion logic.
     *
     * Always uses the tool-call loop with read-only tools. The model can
     * choose whether to invoke tools or just produce a direct answer.
     * Tool invocations are logged via the optional `onToolCall` callback.
     */
    public async chatWithOllama(options: {
        systemPrompt: string;
        userPrompt: string;
        modelConfigKey?: string;
        temperature?: number;
        stripThinkingTags?: boolean;
        cancellationToken?: vscode.CancellationToken;
        maxRounds?: number;
        onToolCall?: (toolName: string, args: Record<string, unknown>, result: string) => void;
        /** Trail type for logging (defaults to 'local'). Pass 'conversation' for bot conversations. */
        trailType?: TrailType;
    }): Promise<{ text: string; rawText: string; thinkContent: string; stats?: OllamaStats; toolCallCount?: number; turnsUsed?: number }> {
        const config = this.loadConfig();
        const { mc } = this.resolveModelConfig(config, undefined, options.modelConfigKey);
        const temp = options.temperature ?? mc.temperature;
        const strip = options.stripThinkingTags ?? mc.stripThinkingTags;
        const trailType = options.trailType ?? 'local';

        // Check Ollama is running
        const running = await this.isOllamaRunning(mc.ollamaUrl);
        if (!running) {
            throw new Error(`Ollama is not running at ${mc.ollamaUrl}`);
        }

        // Trail: Log prompt before sending to Ollama
        logPrompt(trailType, 'ollama', options.userPrompt, options.systemPrompt, {
            model: mc.model,
            modelConfig: options.modelConfigKey,
            temperature: temp,
            maxRounds: options.maxRounds ?? 20,
            source: 'chatWithOllama',
        });

        // Always use tool-call loop — model decides whether to use tools
        const result = await this.ollamaGenerateWithTools({
            baseUrl: mc.ollamaUrl,
            model: mc.model,
            systemPrompt: options.systemPrompt,
            userPrompt: options.userPrompt,
            temperature: temp,
            tools: READ_ONLY_TOOLS,
            onToolCall: options.onToolCall,
            cancellationToken: options.cancellationToken,
            keepAlive: mc.keepAlive,
            maxRounds: options.maxRounds ?? 20,
            trailType,
        });

        const { cleaned, thinkContent } = this.processThinkTags(result.text, strip);

        // Trail: Log final response from Ollama
        logResponse(trailType, 'ollama', result.text, true, {
            cleanedResponse: cleaned,
            thinkTagContent: thinkContent,
            toolCallCount: result.toolCallCount,
            turnsUsed: result.turnsUsed,
            stats: result.stats,
            source: 'chatWithOllama',
        });

        return { text: cleaned, rawText: result.text, thinkContent, stats: result.stats, toolCallCount: result.toolCallCount, turnsUsed: result.turnsUsed };
    }

    /** Check if a specific model is loaded in Ollama. Uses configured URL if no baseUrl given. */
    public async checkModelLoaded(modelName?: string, baseUrl?: string): Promise<boolean> {
        const config = this.loadConfig();
        const name = modelName ?? config.model;
        const url = baseUrl ?? config.ollamaUrl;
        return this.isModelLoaded(url, name);
    }

    /** Get the resolved model name for a given config key (or default). */
    public getResolvedModelName(modelConfigKey?: string): string {
        const config = this.loadConfig();
        const { mc } = this.resolveModelConfig(config, undefined, modelConfigKey);
        return mc.model;
    }

    // -----------------------------------------------------------------------
    // Core process()
    // -----------------------------------------------------------------------

    /**
     * Process a prompt through a model with a given profile.
     *
     * @param prompt        The text to expand
     * @param profileKey    Profile key (null → default profile)
     * @param modelConfigKey Model config key (null → profile's modelConfig or default model)
     * @param editor        Optional editor for placeholder context
     * @param cancellationToken Optional cancellation
     */
    async process(
        prompt: string,
        profileKey?: string | null,
        modelConfigKey?: string | null,
        editor?: vscode.TextEditor,
        cancellationToken?: vscode.CancellationToken,
        onToolCall?: (toolName: string, args: Record<string, unknown>, result: string) => void,
    ): Promise<ExpanderProcessResult> {
        const config = this.loadConfig();

        // Load trail config and clear trail for new session
        loadTrailConfig();
        clearTrail('local');

        // Resolve profile
        const effectiveProfileKey = profileKey ?? this.getDefaultProfileKey(config) ?? '_default';
        const profile = config.profiles[effectiveProfileKey];

        // Resolve model config
        const effectiveModelKey = modelConfigKey ?? profile?.modelConfig ?? this.getDefaultModelKey(config);
        const { key: resolvedModelKey, mc } = effectiveModelKey && config.models[effectiveModelKey]
            ? { key: effectiveModelKey, mc: config.models[effectiveModelKey] }
            : this.resolveModelConfig(config, profile);

        const effectiveSystemPrompt = profile?.systemPrompt ?? config.systemPrompt;
        const effectiveResultTemplate = profile?.resultTemplate ?? config.resultTemplate;
        const effectiveTemperature = profile?.temperature ?? mc.temperature;

        // Resolve ${instructions} content from .tom/local-instructions/
        const instructionsContent = this.resolveInstructionsContent(mc.model);
        const instructionsExtra = { instructions: instructionsContent };

        // Pre-values for system prompt placeholder resolution
        const preValues = this.buildPlaceholderValues(
            editor, prompt, '', '', '', mc.model, resolvedModelKey, effectiveProfileKey,
            undefined, instructionsExtra,
        );
        const resolvedSystemPrompt = this.resolvePlaceholders(effectiveSystemPrompt, preValues);

        // Log process() invocation
        this.logChannel.appendLine(`[process] Profile: ${effectiveProfileKey} | Model: ${resolvedModelKey} (${mc.model})`);
        this.logChannel.appendLine(`[process] Temperature: ${effectiveTemperature} | Instructions: ${instructionsContent.length} chars`);
        this.logChannel.appendLine(`[process] Prompt: ${prompt.length} chars | System prompt: ${resolvedSystemPrompt.length} chars`);

        // Resolve history mode
        const effectiveHistoryMode = profile?.historyMode ?? config.historyMode;
        this.logChannel.appendLine(`[process] History mode: ${effectiveHistoryMode} | History enabled: ${this.historyEnabled} | History length: ${this.conversationHistory.length}`);

        try {
            // Check Ollama
            const running = await this.isOllamaRunning(mc.ollamaUrl);
            if (!running) {
                return {
                    success: false,
                    result: '',
                    rawResponse: '',
                    response: '',
                    thinkTagContent: '',
                    profile: effectiveProfileKey,
                    modelConfig: resolvedModelKey,
                    error: `Ollama is not running at ${mc.ollamaUrl}`,
                };
            }

            // Always use the tool-call loop — even if the model doesn't call tools,
            // it goes through ollamaGenerateWithTools which handles messages correctly.
            // The model can choose to use tools or just produce a direct answer.
            const effectiveMaxRounds = profile?.maxRounds ?? 20;

            // Resolve toolsEnabled from profile or config
            const effectiveToolsEnabled = profile?.toolsEnabled ?? config.toolsEnabled;
            const toolsToUse = effectiveToolsEnabled ? READ_ONLY_TOOLS : [];

            // Trail: Log full prompt with system prompt and metadata
            logPrompt('local', 'ollama', prompt, resolvedSystemPrompt, {
                model: mc.model,
                modelConfig: resolvedModelKey,
                profile: effectiveProfileKey,
                temperature: effectiveTemperature,
                maxRounds: effectiveMaxRounds,
                instructionsLength: instructionsContent.length,
                registeredTools: toolsToUse.map(t => t.name),
                historyMode: effectiveHistoryMode,
                historyEnabled: this.historyEnabled,
            });

            // Build history for Ollama based on mode
            let historyForOllama: Array<{ role: string; content: string }> = [];
            if (this.historyEnabled && effectiveHistoryMode !== 'none' && this.conversationHistory.length > 0) {
                if (effectiveHistoryMode === 'full') {
                    // Include all history
                    historyForOllama = this.getHistoryAsMessages();
                } else if (effectiveHistoryMode === 'last') {
                    // Only include the last exchange (user + assistant)
                    const hist = this.conversationHistory;
                    const lastUser = hist.slice().reverse().find(m => m.role === 'user');
                    const lastAssistant = hist.slice().reverse().find(m => m.role === 'assistant');
                    if (lastUser) { historyForOllama.push({ role: 'user', content: lastUser.content }); }
                    if (lastAssistant) { historyForOllama.push({ role: 'assistant', content: lastAssistant.content }); }
                } else {
                    // 'summary' or 'trim_and_summary' - for now, use full history (summary implementation TBD)
                    historyForOllama = this.getHistoryAsMessages();
                }
                this.logChannel.appendLine(`[process] Passing ${historyForOllama.length} history message(s) to Ollama`);
            }

            this.logChannel.appendLine(`[process] Tools enabled: ${effectiveToolsEnabled} | Tools count: ${toolsToUse.length}`);

            const result = await this.ollamaGenerateWithTools({
                baseUrl: mc.ollamaUrl,
                model: mc.model,
                systemPrompt: resolvedSystemPrompt,
                userPrompt: prompt,
                temperature: effectiveTemperature,
                tools: toolsToUse,
                cancellationToken,
                keepAlive: mc.keepAlive,
                maxRounds: effectiveMaxRounds,
                onToolCall,
                history: historyForOllama,
            });
            const rawResponse = result.text;
            const stats = result.stats;
            const toolCallCount = result.toolCallCount;
            const turnsUsed = result.turnsUsed;

            if (!rawResponse.trim()) {
                return {
                    success: false,
                    result: '',
                    rawResponse,
                    response: '',
                    thinkTagContent: '',
                    profile: effectiveProfileKey,
                    modelConfig: resolvedModelKey,
                    error: 'Ollama returned an empty response',
                };
            }

            // Process think tags
            const { cleaned, thinkContent } = this.processThinkTags(rawResponse, mc.stripThinkingTags);

            // Trail: Log final response
            logResponse('local', 'ollama', rawResponse, true, {
                cleanedResponse: cleaned,
                thinkTagContent: thinkContent,
                toolCallCount,
                turnsUsed,
                maxTurns: effectiveMaxRounds,
                stats,
            });

            // Apply result template (with turn info)
            const postValues = this.buildPlaceholderValues(
                editor, prompt, rawResponse, cleaned, thinkContent,
                mc.model, resolvedModelKey, effectiveProfileKey,
                { turnsUsed, maxTurns: effectiveMaxRounds },
                instructionsExtra,
            );
            const finalText = this.resolvePlaceholders(effectiveResultTemplate, postValues);

            // Update conversation history if history mode is enabled
            if (this.historyEnabled && effectiveHistoryMode !== 'none') {
                this.addToHistory('user', prompt);
                this.addToHistory('assistant', cleaned);
                this.logChannel.appendLine(`[process] Added exchange to history. Total: ${this.conversationHistory.length} messages`);
            }

            return {
                success: true,
                result: finalText,
                rawResponse,
                response: cleaned,
                thinkTagContent: thinkContent,
                profile: effectiveProfileKey,
                modelConfig: resolvedModelKey,
                tokenInfo: stats,
                toolCallCount,
                turnsUsed,
                maxTurns: effectiveMaxRounds,
            };
        } catch (err: any) {
            return {
                success: false,
                result: '',
                rawResponse: '',
                response: '',
                thinkTagContent: '',
                profile: effectiveProfileKey,
                modelConfig: resolvedModelKey,
                error: err.message ?? String(err),
            };
        }
    }

    // -----------------------------------------------------------------------
    // Bridge API
    // -----------------------------------------------------------------------

    /**
     * Handle bridge API calls (called from vscode-bridge.ts handleDartRequest).
     *
     * Methods:
     *   localLlm.getProfilesVce     → list configured profiles
     *   localLlm.getModelsVce       → list configured model configurations
     *   localLlm.updateProfileVce   → add/update a profile
     *   localLlm.removeProfileVce   → remove a profile
     *   localLlm.updateModelVce     → add/update a model configuration
     *   localLlm.removeModelVce     → remove a model configuration
     *   localLlm.processVce         → process a prompt through model + profile
     */
    async handleBridgeRequest(method: string, params: any): Promise<any> {
        switch (method) {
            case 'localLlm.getProfilesVce':
                return this.bridgeGetProfiles();
            case 'localLlm.getModelsVce':
                return this.bridgeGetModels();
            case 'localLlm.updateProfileVce':
                return this.bridgeUpdateProfile(params);
            case 'localLlm.removeProfileVce':
                return this.bridgeRemoveProfile(params);
            case 'localLlm.updateModelVce':
                return this.bridgeUpdateModel(params);
            case 'localLlm.removeModelVce':
                return this.bridgeRemoveModel(params);
            case 'localLlm.processVce':
                return this.bridgeProcess(params);
            default:
                throw new Error(`Unknown localLlm method: ${method}`);
        }
    }

    private bridgeGetProfiles(): any {
        const config = this.loadConfig();
        const defaultKey = this.getDefaultProfileKey(config);
        return {
            profiles: Object.entries(config.profiles).map(([key, p]) => ({
                key,
                label: p.label,
                isDefault: key === defaultKey,
                systemPrompt: p.systemPrompt,
                resultTemplate: p.resultTemplate,
                temperature: p.temperature,
                modelConfig: p.modelConfig,
            })),
        };
    }

    private bridgeGetModels(): any {
        const config = this.loadConfig();
        const defaultKey = this.getDefaultModelKey(config);
        return {
            models: Object.entries(config.models).map(([key, m]) => ({
                key,
                ollamaUrl: m.ollamaUrl,
                model: m.model,
                temperature: m.temperature,
                stripThinkingTags: m.stripThinkingTags,
                description: m.description ?? null,
                isDefault: key === defaultKey,
            })),
            // Include synthesized default if no models are configured
            effectiveDefault: {
                ollamaUrl: config.ollamaUrl,
                model: config.model,
                temperature: config.temperature,
                stripThinkingTags: config.stripThinkingTags,
            },
        };
    }

    private bridgeUpdateProfile(params: any): any {
        return this.updateConfigSection('profiles', params.key, params.profile);
    }

    private bridgeRemoveProfile(params: any): any {
        return this.removeConfigSection('profiles', params.key);
    }

    private bridgeUpdateModel(params: any): any {
        return this.updateConfigSection('models', params.key, params.model);
    }

    private bridgeRemoveModel(params: any): any {
        return this.removeConfigSection('models', params.key);
    }

    private async bridgeProcess(params: any): Promise<ExpanderProcessResult> {
        const prompt = params.prompt as string;
        if (!prompt) {
            return {
                success: false, result: '', rawResponse: '', response: '',
                thinkTagContent: '', profile: '', modelConfig: '',
                error: 'Missing required parameter: prompt',
            };
        }
        return this.process(
            prompt,
            params.profile ?? null,
            params.model ?? null,
            vscode.window.activeTextEditor,
        );
    }

    // -----------------------------------------------------------------------
    // Ollama model listing + switch
    // -----------------------------------------------------------------------

    /** Query Ollama /api/tags to list locally available models. */
    async listOllamaModels(baseUrl?: string): Promise<Array<{ name: string; size: number; modifiedAt: string }>> {
        const config = this.loadConfig();
        const url = baseUrl ?? config.ollamaUrl;

        return new Promise((resolve) => {
            const u = new URL('/api/tags', url);
            const req = http.request(
                { hostname: u.hostname, port: u.port, path: u.pathname, method: 'GET', timeout: 5000 },
                (res) => {
                    let body = '';
                    res.on('data', (chunk: Buffer) => { body += chunk.toString(); });
                    res.on('end', () => {
                        try {
                            const parsed = JSON.parse(body);
                            const models = (parsed.models ?? []).map((m: any) => ({
                                name: m.name ?? m.model ?? '',
                                size: m.size ?? 0,
                                modifiedAt: m.modified_at ?? '',
                            }));
                            resolve(models);
                        } catch {
                            resolve([]);
                        }
                    });
                    res.on('error', () => resolve([]));
                },
            );
            req.on('error', () => resolve([]));
            req.on('timeout', () => { req.destroy(); resolve([]); });
            req.end();
        });
    }

    /** Format bytes as human-readable size. */
    private formatSize(bytes: number): string {
        if (bytes < 1024) { return `${bytes} B`; }
        if (bytes < 1024 * 1024) { return `${(bytes / 1024).toFixed(1)} KB`; }
        if (bytes < 1024 * 1024 * 1024) { return `${(bytes / (1024 * 1024)).toFixed(1)} MB`; }
        return `${(bytes / (1024 * 1024 * 1024)).toFixed(1)} GB`;
    }

    /**
     * Interactive command: switch the default Ollama model.
     * Queries the Ollama API for locally available models, shows a quick-pick,
     * and updates the default model config in tom_vscode_extension.json.
     */
    async switchModelCommand(): Promise<void> {
        const config = this.loadConfig();

        // Query Ollama for available models
        const ollamaModels = await vscode.window.withProgress(
            { location: vscode.ProgressLocation.Notification, title: 'Querying Ollama for available models...' },
            async () => this.listOllamaModels(),
        );

        if (ollamaModels.length === 0) {
            vscode.window.showErrorMessage(
                `No models found. Is Ollama running at ${config.ollamaUrl}? Pull models with: ollama pull <model>`,
            );
            return;
        }

        // Find current default model
        const defaultModelKey = this.getDefaultModelKey(config);
        const currentDefault = defaultModelKey ? config.models[defaultModelKey] : undefined;
        const currentModelName = currentDefault?.model ?? config.model;

        // Build quick-pick items
        const items = ollamaModels.map((m) => {
            const isCurrent = m.name === currentModelName;
            return {
                label: `${isCurrent ? '$(check) ' : ''}${m.name}`,
                description: `${this.formatSize(m.size)}${isCurrent ? ' (current)' : ''}`,
                modelName: m.name,
            };
        });

        const picked = await vscode.window.showQuickPick(items, {
            placeHolder: `Current model: ${currentModelName} — select new default model`,
        });
        if (!picked) { return; }

        // Update the default model config
        const configPath = this.getConfigPath();
        if (!configPath) {
            vscode.window.showErrorMessage('No config file path found');
            return;
        }

        try {
            let data: any = {};
            if (fs.existsSync(configPath)) {
                data = JSON.parse(fs.readFileSync(configPath, 'utf-8'));
            }
            if (!data.promptExpander) { data.promptExpander = {}; }

            // Update the default model config entry, or create one
            if (defaultModelKey && data.promptExpander.models?.[defaultModelKey]) {
                data.promptExpander.models[defaultModelKey].model = picked.modelName;
            } else if (data.promptExpander.models && Object.keys(data.promptExpander.models).length > 0) {
                // Find the default one
                const key = Object.entries(data.promptExpander.models as Record<string, any>)
                    .find(([_, v]) => v.isDefault)?.[0]
                    ?? Object.keys(data.promptExpander.models)[0];
                data.promptExpander.models[key].model = picked.modelName;
            } else {
                // Also update top-level fallback
                data.promptExpander.model = picked.modelName;
            }

            fs.writeFileSync(configPath, JSON.stringify(data, null, 2), 'utf-8');

            bridgeLog(`[Prompt Expander] Switched default model to: ${picked.modelName}`);

            // Pre-load the model by sending a minimal generation request.
            // Ollama loads models on demand — this ensures the model is warm
            // in memory so the first real expansion is fast.
            await vscode.window.withProgress(
                {
                    location: vscode.ProgressLocation.Notification,
                    title: `Loading ${picked.modelName} into memory...`,
                    cancellable: true,
                },
                async (_progress, token) => {
                    try {
                        await this.ollamaGenerate(
                            config.ollamaUrl,
                            picked.modelName,
                            'Respond with OK.',
                            'OK',
                            0,
                            undefined,
                            token,
                            '5m',
                        );
                        bridgeLog(`[Prompt Expander] Model ${picked.modelName} loaded successfully`);
                    } catch (err: any) {
                        if (err.message !== 'Cancelled') {
                            bridgeLog(`[Prompt Expander] Warning: pre-load failed: ${err.message}`);
                        }
                    }
                },
            );

            vscode.window.showInformationMessage(`Local LLM model switched to: ${picked.modelName}`);
        } catch (err: any) {
            vscode.window.showErrorMessage(`Failed to update config: ${err.message}`);
        }
    }

    /** Write a section update to the config file. */
    private updateConfigSection(section: 'profiles' | 'models', key: string, value: any): any {
        const configPath = this.getConfigPath();
        if (!configPath) { return { success: false, error: 'No config file path' }; }

        try {
            let data: any = {};
            if (fs.existsSync(configPath)) {
                data = JSON.parse(fs.readFileSync(configPath, 'utf-8'));
            }
            if (!data.promptExpander) { data.promptExpander = {}; }
            if (!data.promptExpander[section]) { data.promptExpander[section] = {}; }
            data.promptExpander[section][key] = value;
            fs.writeFileSync(configPath, JSON.stringify(data, null, 2), 'utf-8');
            return { success: true };
        } catch (err: any) {
            return { success: false, error: err.message };
        }
    }

    /** Remove a key from a section in the config file. */
    private removeConfigSection(section: 'profiles' | 'models', key: string): any {
        const configPath = this.getConfigPath();
        if (!configPath) { return { success: false, error: 'No config file path' }; }

        try {
            if (!fs.existsSync(configPath)) {
                return { success: false, error: 'Config file does not exist' };
            }
            const data = JSON.parse(fs.readFileSync(configPath, 'utf-8'));
            if (data.promptExpander?.[section]?.[key]) {
                delete data.promptExpander[section][key];
                fs.writeFileSync(configPath, JSON.stringify(data, null, 2), 'utf-8');
                return { success: true };
            }
            return { success: false, error: `Key "${key}" not found in ${section}` };
        } catch (err: any) {
            return { success: false, error: err.message };
        }
    }

    // -----------------------------------------------------------------------
    // VS Code command handler — interactive (with UI)
    // -----------------------------------------------------------------------

    /**
     * Interactive expand: shows model quick-pick (if multiple), then profile quick-pick, progress, replaces in editor.
     *
     * @param forceProfileKey  If set, skip the profile quick-pick and use this profile.
     * @param forceModelKey    If set, skip the model quick-pick and use this model.
     */
    async expandPromptCommand(forceProfileKey?: string, forceModelKey?: string): Promise<void> {
        const editor = vscode.window.activeTextEditor;
        if (!editor) {
            vscode.window.showErrorMessage('No active editor');
            return;
        }

        const config = this.loadConfig();

        // Resolve model config — ask if multiple and not forced
        let selectedModelKey: string | null = forceModelKey ?? null;
        const modelKeys = Object.keys(config.models);
        if (!selectedModelKey && modelKeys.length > 1) {
            const defaultModelKey = this.getDefaultModelKey(config);
            const modelItems = modelKeys.map((key) => {
                const m = config.models[key];
                const isDefault = key === defaultModelKey;
                const desc = m.description
                    ? `${m.model} — ${m.description}${isDefault ? ' (default)' : ''}`
                    : `${m.model}${isDefault ? ' (default)' : ''}`;
                return { label: key, description: desc, key };
            });
            const pickedModel = await vscode.window.showQuickPick(modelItems, {
                placeHolder: 'Select model configuration',
            });
            if (!pickedModel) { return; }
            selectedModelKey = pickedModel.key;
        }

        // Resolve profile
        let profileKey: string;
        bridgeLog(`[expandPromptCommand] forceProfileKey=${forceProfileKey ?? 'undefined'}, availableProfiles=${Object.keys(config.profiles).join(',')}`);
        if (forceProfileKey && config.profiles[forceProfileKey]) {
            profileKey = forceProfileKey;
        } else {
            const profileKeys = Object.keys(config.profiles);
            if (profileKeys.length > 1) {
                const defaultKey = this.getDefaultProfileKey(config);
                const items = profileKeys.map((key) => {
                    const p = config.profiles[key];
                    const desc = key === defaultKey ? `${key} (default)` : key;
                    return { label: p.label, description: desc, key };
                });
                const picked = await vscode.window.showQuickPick(items, {
                    placeHolder: 'Select expansion profile',
                });
                if (!picked) { return; }
                profileKey = picked.key;
            } else if (profileKeys.length === 1) {
                profileKey = profileKeys[0];
            } else {
                profileKey = '_default';
            }
        }

        // Get text
        const selection = editor.selection;
        const hasSelection = !selection.isEmpty;
        const originalText = hasSelection
            ? editor.document.getText(selection)
            : editor.document.getText();

        if (!originalText.trim()) {
            vscode.window.showWarningMessage('Nothing to expand — editor or selection is empty.');
            return;
        }

        const profile = config.profiles[profileKey];
        const { mc } = this.resolveModelConfig(config, profile, selectedModelKey ?? undefined);

        try {
            // Check Ollama
            const running = await this.isOllamaRunning(mc.ollamaUrl);
            if (!running) {
                const action = await vscode.window.showErrorMessage(
                    `Ollama is not running at ${mc.ollamaUrl}. Start it with: brew services start ollama`,
                    'Copy Command',
                );
                if (action === 'Copy Command') {
                    await vscode.env.clipboard.writeText('brew services start ollama');
                }
                return;
            }

            // Check if model is loaded — if not, pre-load with distinct progress
            const modelLoaded = await this.isModelLoaded(mc.ollamaUrl, mc.model);
            if (!modelLoaded) {
                let preloadCancelled = false;
                await vscode.window.withProgress(
                    {
                        location: vscode.ProgressLocation.Notification,
                        title: `Loading model ${mc.model}...`,
                        cancellable: true,
                    },
                    async (_progress, token) => {
                        try {
                            await this.ollamaGenerate(
                                mc.ollamaUrl, mc.model, 'Respond with OK.', 'OK', 0,
                                undefined, token, mc.keepAlive,
                            );
                        } catch (err: any) {
                            if (err.message === 'Cancelled') { preloadCancelled = true; }
                        }
                    },
                );
                if (preloadCancelled) {
                    vscode.window.showInformationMessage('Prompt expansion cancelled.');
                    return;
                }
            }

            // Log start to output channel
            const startTime = Date.now();
            this.outputChannel.appendLine('═══════════════════════════════════════════════════');
            this.outputChannel.appendLine(`Prompt Expansion — ${new Date().toLocaleTimeString()}`);
            this.outputChannel.appendLine(`  Model: ${mc.model} | Profile: ${profileKey}`);
            this.outputChannel.appendLine(`  Prompt: ${originalText.length} chars`);
            this.outputChannel.appendLine('═══════════════════════════════════════════════════');

            // Process with progress (includes live tool-call feedback)
            let toolCallIndex = 0;
            const result = await vscode.window.withProgress(
                {
                    location: vscode.ProgressLocation.Notification,
                    title: `Processing prompt with ${mc.model}...`,
                    cancellable: true,
                },
                async (progress, cancellationToken) => {
                    return this.process(originalText, profileKey, selectedModelKey, editor, cancellationToken,
                        (toolName, args, toolResult) => {
                            toolCallIndex++;
                            // Shorten args for display
                            const argSummary = Object.entries(args)
                                .map(([k, v]) => {
                                    const s = String(v);
                                    return `${k}=${s.length > 60 ? s.substring(0, 57) + '...' : s}`;
                                })
                                .join(', ');
                            const shortResult = toolResult.length > 200
                                ? toolResult.substring(0, 197) + '...'
                                : toolResult;

                            // Update progress notification
                            progress.report({
                                message: `Tool #${toolCallIndex}: ${toolName}(${argSummary.substring(0, 80)})`,
                            });

                            // Log to output channel
                            this.outputChannel.appendLine(`--- Tool call #${toolCallIndex}: ${toolName} ---`);
                            this.outputChannel.appendLine(`  Args: ${JSON.stringify(args, null, 2)}`);
                            this.outputChannel.appendLine(`  Result (${toolResult.length} chars): ${shortResult}`);
                            this.outputChannel.appendLine('');
                        },
                    );
                },
            );

            if (!result.success) {
                if (result.error === 'Cancelled') {
                    vscode.window.showInformationMessage('Prompt expansion cancelled.');
                } else {
                    vscode.window.showErrorMessage(`Expansion failed: ${result.error}`);
                }
                return;
            }

            // Replace in editor
            const success = await editor.edit((editBuilder) => {
                if (hasSelection) {
                    editBuilder.replace(selection, result.result);
                } else {
                    const fullRange = new vscode.Range(
                        editor.document.positionAt(0),
                        editor.document.positionAt(editor.document.getText().length),
                    );
                    editBuilder.replace(fullRange, result.result);
                }
            });

            if (success) {
                const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
                const tokenStr = result.tokenInfo
                    ? ` | ${result.tokenInfo.promptTokens}+${result.tokenInfo.completionTokens} tokens, ${(result.tokenInfo.totalDurationMs / 1000).toFixed(1)}s`
                    : '';
                const toolStr = result.toolCallCount
                    ? ` | ${result.toolCallCount} tool calls in ${result.turnsUsed}/${result.maxTurns} turns`
                    : '';

                // Output channel summary
                this.outputChannel.appendLine('───────────────────────────────────────────────────');
                this.outputChannel.appendLine(`Done in ${elapsed}s — ${originalText.length} → ${result.result.length} chars`);
                if (result.toolCallCount) {
                    this.outputChannel.appendLine(`  Tool calls: ${result.toolCallCount} in ${result.turnsUsed}/${result.maxTurns} turns`);
                } else {
                    this.outputChannel.appendLine(`  No tool calls (direct answer in 1 turn)`);
                }
                if (result.tokenInfo) {
                    this.outputChannel.appendLine(`  Tokens: ${result.tokenInfo.promptTokens} prompt + ${result.tokenInfo.completionTokens} completion`);
                }
                this.outputChannel.appendLine('');

                bridgeLog(`[Prompt Expander] ${originalText.length} → ${result.result.length} chars [${profileKey}/${result.modelConfig}]${tokenStr}${toolStr}`);
                vscode.window.showInformationMessage(
                    `Expanded (${originalText.length} → ${result.result.length} chars) [${profileKey}]${tokenStr}${toolStr}`,
                );
            }
        } catch (error) {
            if (error instanceof Error && error.message === 'Cancelled') {
                vscode.window.showInformationMessage('Prompt expansion cancelled.');
                return;
            }
            handleError('Failed to expand prompt', error);
        }
    }
}

// ============================================================================
// Exported standalone handler (backward compat for extension.ts)
// ============================================================================

/** Global manager instance — set by extension.ts during activation. */
let _manager: PromptExpanderManager | undefined;

export function setPromptExpanderManager(mgr: PromptExpanderManager): void {
    _manager = mgr;
}

export function getPromptExpanderManager(): PromptExpanderManager | undefined {
    return _manager;
}

/**
 * Command handler for `tomAi.sendToLocalLlm`.
 * Delegates to the global PromptExpanderManager.
 */
export async function expandPromptHandler(): Promise<void> {
    logLocalAi('expandPrompt command invoked');
    try {
        if (!_manager) {
            logLocalAi('Prompt Expander not initialized', 'ERROR');
            vscode.window.showErrorMessage('Prompt Expander not initialized');
            return;
        }
        await _manager.expandPromptCommand();
        logLocalAi('expandPrompt completed');
    } catch (error) {
        logLocalAi(`expandPrompt FAILED: ${error}`, 'ERROR');
        vscode.window.showErrorMessage(`Expand Prompt failed: ${error}`);
    }
}

/**
 * Command handler for profile-specific context menu commands.
 * Used by `tomAi.sendToLocalLlm.default.<profileKey>`.
 */
export function createProfileHandler(profileKey: string): () => Promise<void> {
    return async () => {
        logLocalAi(`sendToLocalLlm.${profileKey} command invoked`);
        try {
            if (!_manager) {
                logLocalAi('Prompt Expander not initialized', 'ERROR');
                vscode.window.showErrorMessage('Prompt Expander not initialized');
                return;
            }
            await _manager.expandPromptCommand(profileKey);
            logLocalAi(`sendToLocalLlm.${profileKey} completed`);
        } catch (error) {
            logLocalAi(`sendToLocalLlm.${profileKey} FAILED: ${error}`, 'ERROR');
            vscode.window.showErrorMessage(`Send to Local LLM (${profileKey}) failed: ${error}`);
        }
    };
}

/**
 * Command handler for `tomAi.localLlm.switchModel`.
 * Shows available Ollama models and switches the default.
 */
export async function switchModelHandler(): Promise<void> {
    logLocalAi('switchLocalModel command invoked');
    try {
        if (!_manager) {
            logLocalAi('Prompt Expander not initialized', 'ERROR');
            vscode.window.showErrorMessage('Prompt Expander not initialized');
            return;
        }
        await _manager.switchModelCommand();
        logLocalAi('switchLocalModel completed');
    } catch (error) {
        logLocalAi(`switchLocalModel FAILED: ${error}`, 'ERROR');
        vscode.window.showErrorMessage(`Switch Local Model failed: ${error}`);
    }
}
