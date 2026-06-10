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
 * Configuration lives in the `localLlm` section of tom_vscode_extension.json.
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
import { READ_ONLY_TOOLS, ALL_SHARED_TOOLS } from '../tools/tool-executors';
import { loadSendToChatConfig } from '../utils/sendToChatConfig';
import { apiKeyAuthHeader } from '../utils/apiKeyAuthHeader';
import { withRetryBudget } from '../utils/retryWithBudget';
import {
    logPrompt, logResponse, logToolRequest, logToolResult,
    logContinuationPrompt, isTrailEnabled, loadTrailConfig,
    type TrailType,
} from '../services/trailLogging';
import { ToolTrail, setActiveToolTrail } from '../services/tool-trail';
import { writeToolResult } from '../services/tool-result-store';
import { TwoTierMemoryService } from '../services/memory-service';
import { LiveTrailWriter, LOCAL_LLM_LIVE_TRAIL_FILENAME } from '../services/live-trail';
import { QuestRefreshStore } from '../managers/questRefreshStore';
import { QuestRefreshService } from '../services/quest-refresh-service';

// `LOCAL_LLM_LIVE_TRAIL_FILENAME` now lives in `../services/live-trail` so
// stateless consumers (Quest Refresh) can resolve the same path without
// importing this handler. Re-exported here for existing importers.
export { LOCAL_LLM_LIVE_TRAIL_FILENAME };

// ============================================================================
// Interfaces
// ============================================================================

/** A named model configuration. */
export interface ModelConfig {
    /** Server URL (Ollama or OpenAI-compatible per `apiStyle`). */
    ollamaUrl: string;
    /** Backend protocol; defaults to `'ollama'`. See {@link LocalLlmApiStyle}. */
    apiStyle?: LocalLlmApiStyle;
    /** Model name as known by the backend. */
    model: string;
    /** Sampling temperature.  0 = deterministic, 2 = very random. */
    temperature: number;
    /** Whether to strip `<think>…</think>` tags from the response. */
    stripThinkingTags: boolean;
    /** Human-readable description shown in model selection quick-pick. */
    description?: string;
    /** If true this is the default model when no model is specified. */
    isDefault?: boolean;
    /** Ollama keep_alive duration (e.g. "5m", "1h", "0", "-1"). Default: "5m". Ignored for OpenAI-style endpoints. */
    keepAlive?: string;
    /**
     * Name of the environment variable holding the API key (bearer token) for
     * this endpoint — primarily for OpenAI-compatible hosts that require auth.
     * When set and the variable is non-empty, the request is sent with an
     * `Authorization: Bearer <value>` header; when unset the call is made
     * without authentication (current behaviour). The key itself is never
     * stored in config, only the variable name.
     */
    apiKeyEnv?: string;
}

/** Backend API protocol spoken by the endpoint. */
export type LocalLlmApiStyle = 'ollama' | 'openai';

/** An LLM configuration entity under `localLlm.configurations`. */
export interface LlmConfiguration {
    /** Unique identifier. */
    id: string;
    /** Human-readable name. */
    name: string;
    /** Server URL. Kept as `ollamaUrl` for backwards compatibility; used for OpenAI-compatible endpoints (vLLM, llama.cpp, etc.) as well when `apiStyle` is `'openai'`. */
    ollamaUrl: string;
    /**
     * Backend protocol. `'ollama'` calls `/api/chat` and `/api/tags` (default).
     * `'openai'` calls `/v1/chat/completions` and `/v1/models` (vLLM, LM Studio,
     * llama.cpp server, any OpenAI-compatible host).
     */
    apiStyle?: LocalLlmApiStyle;
    /** Model name as known by the backend (e.g. `qwen3:8b` for Ollama, `gemma4-26b-a4b` for vLLM). */
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
    /** Ollama keep_alive duration (e.g. "5m", "1h", "0", "-1"). Default: "5m". Ignored by OpenAI-style endpoints. */
    keepAlive?: string;
    /**
     * Name of the environment variable holding the API key (bearer token) for
     * this endpoint — primarily for OpenAI-compatible hosts that require auth.
     * When set and the variable is non-empty, requests carry an
     * `Authorization: Bearer <value>` header; when unset the call is made
     * without authentication (current behaviour). Only the variable name is
     * stored in config, never the key itself.
     */
    apiKeyEnv?: string;
    /**
     * Maximum tool-call rounds when this configuration drives an Anthropic
     * profile (`transport: 'localLlm'`). Defaults to 10 in
     * `resolveAnthropicTargets` when unset. The local-LLM leaf strips tools
     * on the final round to force a text answer, so set this >= 2 to allow
     * any tool use at all.
     */
    maxRounds?: number;
    /**
     * Master switch for tool use through this configuration. When `false`,
     * the dispatcher omits the `tools` array entirely. This is the right
     * setting for OpenAI-compatible endpoints (vLLM, llama.cpp, LM Studio)
     * launched without tool-call-parser support — sending `tools` triggers
     * a server-side `"auto" tool choice requires --enable-auto-tool-choice
     * and --tool-call-parser to be set` rejection. Defaults to `true`.
     */
    toolsEnabled?: boolean;
    /**
     * History injection mode when this configuration backs an Anthropic
     * profile. See `sendViaLocalLlm` for the per-mode behaviour. Defaults
     * to `'last'` for synthesised Local-LLM configs (small-context-friendly).
     */
    historyMode?: 'last' | 'all' | 'full' | 'summary' | 'trim_and_summary' | 'llm_extract';
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
    /** Profile-level tool subset; honored when toolsEnabled === false. */
    enabledTools?: string[];
    /** Strip <think>…</think> blocks from the model's response. */
    stripThinkingTags?: boolean;
    /**
     * Suffix for the per-profile history snapshot files in
     * `_ai/quests/<quest>/history/`. When set, the manager reads/writes
     * `history-<historySuffix>.{json,md}` instead of the canonical
     * `history.{json,md}` pair so each profile can own its own
     * conversation thread.
     */
    historySuffix?: string;
    /**
     * Suffix for the per-profile memory file. When set, the `${memory}`
     * placeholder injects only `facts-<memorySuffix>.md` from each scope.
     */
    memorySuffix?: string;
    /**
     * When true, append `\n\n## Memory\n\n${memory}` to the resolved
     * system prompt automatically. Mirrors `AnthropicProfile.autoInjectMemory`.
     */
    autoInjectMemory?: boolean;
}

/** History mode for Local LLM. */
export type LocalLlmHistoryMode = 'none' | 'full' | 'last' | 'summary' | 'trim_and_summary' | 'llm_extract';

/** Full localLlm section from tom_vscode_extension.json. */
export interface LocalLlmConfig {
    /** Default model settings for top-level localLlm configuration. */
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
    /** LLM configuration entities under `localLlm.configurations`. */
    configurations: LlmConfiguration[];
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

const DEFAULTS: LocalLlmConfig = {
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
    configurations: [],
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
// LocalLlmManager — singleton, created in extension.ts
// ============================================================================

/** A single conversation message for Local LLM history. */
export interface LocalLlmMessage {
    role: 'user' | 'assistant' | 'system';
    content: string;
    timestamp?: Date;
}

export class LocalLlmManager {
    private context: vscode.ExtensionContext;
    private registeredCommands: vscode.Disposable[] = [];
    /**
     * "Tom AI Local LLM" output channel — **conversation-shaped**
     * log. Headers per turn + user prompt + per-round tool calls +
     * final assistant text. The plain-text analogue of `live-trail-localLLM.md`.
     * Use for "what did the model actually say / do".
     */
    private outputChannel: vscode.OutputChannel;
    /**
     * "Tom AI Local Log" output channel — **technical diagnostics**.
     * HTTP POSTs (URL + apiStyle), compaction / memory-extraction
     * progress + outcomes, retry countdowns, errors. Use for "why is
     * vLLM returning N", "did compaction run", "how big did the
     * summary get". Lines are tagged `[openaiChat]`, `[ollamaChat]`,
     * `[process]`, `[history]`, `[memory]` so the source is obvious.
     */
    private logChannel: vscode.OutputChannel;
    /** Conversation history for Local LLM sessions. */
    private conversationHistory: LocalLlmMessage[] = [];
    /** Vestigial runtime kill-switch — historically gated all history
     *  injection. Defaults to `false`; the gating sites have moved to
     *  `effectiveHistoryMode !== 'none'` (the authoritative opt-out) so
     *  this field no longer affects behaviour. Kept so `setHistoryEnabled`
     *  / `isHistoryEnabled` callers still compile; remove once no one
     *  reads them. */
    private historyEnabled: boolean = false;
    /** Running summary of folded-out raw turns (incremental compaction).
     *  Mirrors `AnthropicHandler.compactedSummary` so the same template
     *  contract (`${existingSummary}` + `${lastTurn}`) works on both
     *  paths. Updated post-turn by `runCompactionInBackground`. */
    private compactedSummary: string = '';
    /** Raw user/assistant turn pairs kept verbatim in the next prompt.
     *  Trimmed to `rawTurnsKept * 2` messages after every compaction
     *  pass — older entries are baked into `compactedSummary`. */
    private rawTurns: LocalLlmMessage[] = [];
    /** In-memory ring buffer of tool calls + results (this session).
     *  Registered as the module-level active trail when a Local LLM
     *  call is in flight so `tomAi_readPastToolResult` resolves keys
     *  issued from the Local LLM path. */
    private readonly toolTrail: ToolTrail;
    /** Map from synthetic Ollama tool_call_id to the ToolTrail key
     *  assigned for that call. Used by the retention-policy walker to
     *  replace older `tool` messages with stubs referencing the same key
     *  the model already saw in earlier rounds. */
    private toolCallIdToKey: Map<string, string> = new Map();
    /** Counter used to synthesise stable per-call ids when Ollama / vLLM
     *  doesn't supply one. */
    private toolCallCounter = 0;
    /**
     * Status emitter for background events the panel can't observe
     * directly. Fires for compaction / memory-extraction retry
     * countdowns after the foreground send has returned. The chat
     * panel subscribes once and forwards each event to the webview as
     * a `localLlmStatus` message. Mirrors `AnthropicHandler._onStatusUpdate`.
     */
    private readonly _onStatusUpdate = new vscode.EventEmitter<string>();
    readonly onStatusUpdate: vscode.Event<string> = this._onStatusUpdate.event;
    /** Tracks which `(quest, historySuffix)` pair the in-memory
     *  `compactedSummary` + `rawTurns` were seeded from. When the next
     *  call's pair changes, we re-seed from disk so switching profiles
     *  (or quests) mid-session doesn't bleed one thread's history into
     *  another. `undefined` = never seeded. */
    private seededFor: string | undefined;

    constructor(context: vscode.ExtensionContext) {
        this.context = context;
        this.outputChannel = vscode.window.createOutputChannel('Tom AI Local LLM');
        this.logChannel = vscode.window.createOutputChannel('Tom AI Local Log');
        context.subscriptions.push(this.outputChannel, this.logChannel);
        this.toolTrail = new ToolTrail();
        this.toolTrail.setPersistHook((entry) => {
            try {
                writeToolResult('localLlm', entry, WsPaths.getWorkspaceQuestId());
            } catch {
                // best-effort
            }
        });
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
        this.compactedSummary = '';
        this.rawTurns = [];
        this.toolTrail.clear();
        this.toolCallIdToKey.clear();
        // Reset seed tracking so the next call rebuilds from disk
        // rather than treating the now-empty in-memory state as
        // authoritative.
        this.seededFor = undefined;
        this.logChannel.appendLine('[History] Cleared');
    }

    /**
     * Seed `compactedSummary` + `rawTurns` from
     * `_ai/quests/<quest>/history/<base>.json` (where `<base>` is
     * `history-<suffix>` when a profile supplies a `historySuffix`,
     * otherwise `history`). Mirrors `AnthropicHandler.seedHistoryFromSnapshot`
     * so both panels share the same on-disk schema and the rolling
     * pair can be read across panels when no suffix is set.
     *
     * Re-seeds whenever the `(quest, suffix)` pair changes vs. the
     * previous call — switching profiles mid-session pulls the right
     * thread back from disk instead of carrying the prior one over.
     * Per-call trim is applied by the caller (`process()`) so the
     * in-memory invariant respects the active configuration's cap.
     */
    private seedHistoryFromSnapshot(questId: string, suffix?: string): void {
        const key = `${questId || ''}::${suffix ?? ''}`;
        if (this.seededFor === key) {
            return;
        }
        this.seededFor = key;
        try {
            const raw = TwoTierMemoryService.instance.loadLatestHistorySnapshot<unknown>(questId, suffix);
            if (raw && typeof raw === 'object' && !Array.isArray(raw)) {
                const obj = raw as { compactedSummary?: unknown; rawTurns?: unknown };
                this.compactedSummary = typeof obj.compactedSummary === 'string' ? obj.compactedSummary : '';
                this.rawTurns = Array.isArray(obj.rawTurns)
                    ? (obj.rawTurns as Array<{ role?: unknown; content?: unknown }>)
                        .filter((m): m is LocalLlmMessage =>
                            !!m &&
                            (m.role === 'user' || m.role === 'assistant' || m.role === 'system') &&
                            typeof m.content === 'string')
                    : [];
                this.logChannel.appendLine(
                    `[history] Seeded from ${suffix ? `history-${suffix}.json` : 'history.json'}` +
                    ` — summary=${this.compactedSummary.length}c, rawTurns=${this.rawTurns.length}`,
                );
            } else {
                // No snapshot or unexpected shape — start clean so a
                // stale in-memory state from a prior profile doesn't
                // bleed through.
                this.compactedSummary = '';
                this.rawTurns = [];
            }
        } catch (e) {
            // Best-effort: failure to read the snapshot leaves state
            // empty rather than throwing — the next persist will write
            // a fresh file.
            this.compactedSummary = '';
            this.rawTurns = [];
            this.logChannel.appendLine(`[history] seedHistoryFromSnapshot failed: ${String(e)}`);
        }
    }

    /**
     * Write `{ compactedSummary, rawTurns }` to the per-profile history
     * snapshot, using `historySuffix` to pick the file basename. Always
     * a write of the canonical (non-archived) pair — archival is
     * Anthropic-side functionality not yet replicated here.
     *
     * Quietly no-ops on error — persistence failure must never affect
     * the user-visible turn result.
     */
    private persistSessionHistory(questId: string | undefined, suffix?: string): void {
        try {
            const written = TwoTierMemoryService.instance.persistHistorySnapshot(
                { compactedSummary: this.compactedSummary, rawTurns: this.rawTurns },
                questId,
                false,
                suffix,
            );
            this.logChannel.appendLine(
                `[history] Persisted snapshot → ${written ?? '(unknown path)'}` +
                ` (suffix=${suffix ?? '(none)'}, summary=${this.compactedSummary.length}c, rawTurns=${this.rawTurns.length})`,
            );
        } catch (e) {
            this.logChannel.appendLine(`[history] persistSessionHistory failed: ${String(e)}`);
        }
    }

    /**
     * Enforce the rawTurns cap independent of compaction. The cap is
     * derived **purely** from the active `rawTurnsKept` setting (per
     * the LLM configuration profile's per-config override, or the
     * global `compaction.rawTurnsKept`, or its default 4). No hard
     * floor is imposed — `rawTurnsKept = 0` honestly means "no raw
     * turns kept, rely entirely on `compactedSummary`", and `1` means
     * one user/assistant pair = 2 messages.
     *
     * Without this trim invariant, a profile with no compaction LLM
     * configured would grow `rawTurns` unboundedly and every snapshot
     * would carry the whole transcript. Mirrors the invariant on
     * `AnthropicHandler.rawTurns`.
     */
    private trimRawTurns(rawTurnsKept: number): void {
        const cap = Math.max(0, rawTurnsKept) * 2;
        if (this.rawTurns.length > cap) {
            this.rawTurns = cap === 0 ? [] : this.rawTurns.slice(-cap);
        }
    }

    /**
     * Resolve effective per-call caps from compaction + the active
     * configuration (per-config overrides win). Mirrors the Anthropic
     * side so the same template contract applies on both transports.
     */
    private resolveEffectiveLocalLlmCaps(mc: ModelConfig | LlmConfiguration | undefined): {
        historyMaxChars: number;
        memoryMaxChars: number;
        rawTurnsKept: number;
        toolTrailMaxResultChars: number;
        toolTrailKeepRounds: number;
        maxHistoryTokens: number;
    } {
        const cfg = (loadSendToChatConfig() as { compaction?: Record<string, unknown> })?.compaction ?? {};
        const def = (key: string, fallback: number): number => {
            const v = (cfg as Record<string, unknown>)[key];
            return typeof v === 'number' && Number.isFinite(v) ? v : fallback;
        };
        const c = (mc ?? {}) as Record<string, unknown>;
        const pick = (key: string, compactionKey: string, fallback: number): number => {
            const v = c[key];
            if (typeof v === 'number' && Number.isFinite(v)) { return v; }
            return def(compactionKey, fallback);
        };
        return {
            historyMaxChars: pick('historyMaxChars', 'historyMaxChars', 24000),
            memoryMaxChars: pick('memoryMaxChars', 'memoryMaxChars', 8000),
            rawTurnsKept: pick('rawTurnsKept', 'rawTurnsKept', 4),
            toolTrailMaxResultChars: pick('toolTrailMaxResultChars', 'toolTrailMaxResultChars', 1000),
            toolTrailKeepRounds: pick('toolTrailKeepRounds', 'toolTrailKeepRounds', 2),
            maxHistoryTokens: pick('maxHistoryTokens', 'maxHistoryTokens', 8000),
        };
    }

    /**
     * Fold overflow raw turns into the running compactedSummary using
     * the configured compaction template (`${existingSummary}` +
     * `${lastTurn}`). The summary stays detailed (template targets
     * ~`maxHistorySize` chars) and integrates the dropped turns so the
     * next prompt doesn't lose context.
     */
    private async foldOverflowIntoSummary(
        overflow: LocalLlmMessage[],
        mc: ModelConfig | LlmConfiguration,
        eCaps: ReturnType<LocalLlmManager['resolveEffectiveLocalLlmCaps']>,
    ): Promise<void> {
        try {
            const compactionCfg = (loadSendToChatConfig() as { compaction?: Record<string, unknown> })?.compaction ?? {};
            const { runIncrementalCompaction } = await import('../services/history-compaction.js');
            const lastTurn = overflow.map(m => ({
                role: m.role as 'user' | 'assistant' | 'system',
                content: m.content,
            }));
            const provider = (compactionCfg.llmProvider as 'localLlm' | 'anthropic') ?? 'localLlm';
            const llmConfigId = (compactionCfg.llmConfigId as string) ?? (mc as { id?: string }).id ?? 'default';
            const existingSummaryLen = this.compactedSummary.length;
            const lastTurnChars = lastTurn.reduce((sum, m) => sum + (m.content?.length ?? 0), 0);
            // Detailed entry log so the user can see compaction firing
            // even when `onProgress` retry events aren't emitted (the
            // happy path is silent on the wire — the only progress
            // notifications come from the retry wrapper).
            this.logChannel.appendLine(
                `[history] Performing history compaction ` +
                `(provider=${provider}, llmConfigId=${llmConfigId}, ` +
                `lastTurnChars=${lastTurnChars}, existingSummaryChars=${existingSummaryLen}, ` +
                `templateId=${compactionCfg.compactionTemplateId ?? '(default)'}, ` +
                `historyMaxChars=${eCaps.historyMaxChars}, maxHistoryTokens=${eCaps.maxHistoryTokens})…`,
            );
            const newSummary = await runIncrementalCompaction({
                existingSummary: this.compactedSummary,
                lastTurn,
                llmProvider: provider,
                llmConfigId,
                compactionTemplateId: compactionCfg.compactionTemplateId as string | undefined,
                maxHistoryTokens: eCaps.maxHistoryTokens,
                historyMaxChars: eCaps.historyMaxChars,
                questId: WsPaths.getWorkspaceQuestId(),
                // Surface retry countdowns to the LocalLLM panel via
                // the status emitter AND mirror to the logChannel so a
                // diagnostic trail is available even without the
                // status bar open. The chat panel subscribes once and
                // forwards each event to the webview's status bar.
                onProgress: (msg) => {
                    this._onStatusUpdate.fire(msg);
                    this.logChannel.appendLine(`[history] ${msg}`);
                },
            });
            if (typeof newSummary === 'string' && newSummary.trim().length > 0) {
                this.compactedSummary = newSummary.trim();
                this.logChannel.appendLine(
                    `[history] Compaction succeeded — new compactedSummary size: ${this.compactedSummary.length} chars ` +
                    `(was ${existingSummaryLen}, delta=${this.compactedSummary.length - existingSummaryLen})`,
                );
            } else {
                this.logChannel.appendLine(`[history] Compaction returned empty / no-op — keeping existing summary (${existingSummaryLen} chars)`);
            }
        } catch (e) {
            this.logChannel.appendLine(`[history] foldOverflowIntoSummary failed: ${String(e)}`);
        }
    }

    /**
     * Walk back through `messages[]` and replace the content of any
     * `role: 'tool'` message that's older than `toolTrailKeepRounds`
     * tool rounds with the ToolTrail stub. The most-recent rounds keep
     * their bodies but are truncated to `toolTrailMaxResultChars` so
     * even fresh results don't snowball.
     *
     * A "tool round" here = one contiguous run of `role: 'tool'`
     * messages following one `role: 'assistant'` with tool_calls.
     */
    private applyLocalLlmToolTrailPolicy(
        messages: Array<{ role: string; content?: string; tool_calls?: OllamaToolCall[]; tool_call_id?: string }>,
    ): void {
        // Resolve the active configuration once. We look up by the
        // current default config — per-call overrides are applied on
        // the message contents directly, so the trail's own state can
        // be set from compaction-level fallback here.
        const config = loadSendToChatConfig() as { localLlm?: { configurations?: Array<Record<string, unknown>> } };
        const def = (config.localLlm?.configurations ?? []).find((c) => c.isDefault) ?? (config.localLlm?.configurations ?? [])[0];
        const caps = this.resolveEffectiveLocalLlmCaps(def as unknown as LlmConfiguration | undefined);
        this.toolTrail.inlineMaxChars = Math.max(100, caps.toolTrailMaxResultChars);
        this.toolTrail.keepRounds = Math.max(0, caps.toolTrailKeepRounds);

        // Walk newest-first. A "tool round" boundary is each
        // `role: 'assistant'` message that has `tool_calls`. Count
        // boundaries to find which rounds are inside the inline window.
        // For each `role: 'tool'` message we encounter on the way down,
        // we know its round = (boundaries encountered so far + 1 once
        // we hit the next assistant-with-tool_calls).
        let roundsSeen = 0;
        for (let i = messages.length - 1; i >= 0; i--) {
            const msg = messages[i];
            if (msg.role === 'assistant' && Array.isArray(msg.tool_calls) && msg.tool_calls.length > 0) {
                // Boundary — the tool messages we just walked over belong
                // to round `roundsSeen + 1` counting from the end.
                roundsSeen += 1;
                continue;
            }
            if (msg.role !== 'tool') {
                continue;
            }
            const callId = msg.tool_call_id;
            const key = callId ? this.toolCallIdToKey.get(callId) : undefined;
            const entry = key ? this.toolTrail.getByKey(key) : undefined;
            // `roundsSeen` is the number of completed rounds AFTER this
            // tool message. The tool message itself is part of round
            // (roundsSeen + 1) from the end — but the boundary increment
            // happens on the assistant message that comes BEFORE it
            // (newer in message order). So a tool message walked while
            // `roundsSeen === N` is N rounds back from the newest tool
            // round.
            const isInsideInlineWindow = roundsSeen < this.toolTrail.keepRounds;
            const currentText = typeof msg.content === 'string' ? msg.content : '';
            if (isInsideInlineWindow) {
                if (entry) {
                    msg.content = this.toolTrail.truncateInline(entry.key, entry.toolName, entry.inputSummary, currentText);
                } else if (currentText.length > this.toolTrail.inlineMaxChars) {
                    msg.content = currentText.slice(0, this.toolTrail.inlineMaxChars) +
                        `\n[…truncated to ${this.toolTrail.inlineMaxChars} chars of ${currentText.length}; no ToolTrail key available]`;
                }
            } else {
                msg.content = entry
                    ? this.toolTrail.renderStub(entry)
                    : `[Past tool call (id=${callId ?? 'unknown'}) — full body persisted on disk under _ai/trail/localllm/<quest>/tool_results/. No active key.]`;
            }
        }
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
    loadConfig(): LocalLlmConfig {
        const config: LocalLlmConfig = { ...DEFAULTS, models: {}, profiles: {} };

        // VS Code settings
        const vsTomAi = vscode.workspace.getConfiguration('tomAi.ollama');
        const vsUrl = vsTomAi.get<string>('url');
        const vsModel = vsTomAi.get<string>('model');
        if (vsUrl) { config.ollamaUrl = vsUrl; }
        if (vsModel) { config.model = vsModel; }

        const configPath = this.getConfigPath();
        if (!configPath || !fs.existsSync(configPath)) { return config; }

        try {
            const raw = fs.readFileSync(configPath, 'utf-8');
            const parsed = JSON.parse(raw);
            const sec = parsed?.localLlm;
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
                            apiKeyEnv: typeof m.apiKeyEnv === 'string' && m.apiKeyEnv.length > 0 ? m.apiKeyEnv : undefined,
                        };
                    }
                }
            }

            // Profiles
            if (sec.profiles && typeof sec.profiles === 'object') {
                for (const [key, val] of Object.entries(sec.profiles)) {
                    const p = val as any;
                    if (p && typeof p === 'object') {
                        // NB: every profile field consumed downstream
                        // must be copied through here — `loadConfig` is
                        // the only path from on-disk JSON to the
                        // in-memory profile object. A missed field
                        // silently no-ops at the call site (this was
                        // the root cause of the historySuffix bug).
                        config.profiles[key] = {
                            label: typeof p.label === 'string' ? p.label : key,
                            systemPrompt: typeof p.systemPrompt === 'string' ? p.systemPrompt : null,
                            resultTemplate: typeof p.resultTemplate === 'string' ? p.resultTemplate : null,
                            temperature: typeof p.temperature === 'number' ? p.temperature : null,
                            modelConfig: typeof p.modelConfig === 'string' ? p.modelConfig : null,
                            isDefault: p.isDefault === true,
                            toolsEnabled: typeof p.toolsEnabled === 'boolean' ? p.toolsEnabled : undefined,
                            enabledTools: Array.isArray(p.enabledTools)
                                ? (p.enabledTools as unknown[]).filter((t): t is string => typeof t === 'string')
                                : undefined,
                            maxRounds: typeof p.maxRounds === 'number' ? p.maxRounds : undefined,
                            historyMode: typeof p.historyMode === 'string' ? p.historyMode as LocalLlmHistoryMode : undefined,
                            stripThinkingTags: typeof p.stripThinkingTags === 'boolean' ? p.stripThinkingTags : undefined,
                            historySuffix: typeof p.historySuffix === 'string' && p.historySuffix.length > 0 ? p.historySuffix : undefined,
                            memorySuffix: typeof p.memorySuffix === 'string' && p.memorySuffix.length > 0 ? p.memorySuffix : undefined,
                            autoInjectMemory: p.autoInjectMemory === true,
                        };
                    }
                }
            }

            // LLM configurations (localLlm array)
            if (Array.isArray(sec.configurations)) {
                config.configurations = [];
                for (const lc of sec.configurations) {
                    if (lc && typeof lc === 'object' && typeof lc.id === 'string') {
                        config.configurations.push({
                            id: lc.id,
                            name: typeof lc.name === 'string' ? lc.name : lc.id,
                            ollamaUrl: typeof lc.ollamaUrl === 'string' ? lc.ollamaUrl : config.ollamaUrl,
                            apiStyle: (lc.apiStyle === 'openai' || lc.apiStyle === 'ollama') ? lc.apiStyle : undefined,
                            model: typeof lc.model === 'string' ? lc.model : config.model,
                            temperature: typeof lc.temperature === 'number' ? lc.temperature : config.temperature,
                            stripThinkingTags: typeof lc.stripThinkingTags === 'boolean' ? lc.stripThinkingTags : config.stripThinkingTags,
                            trailMaximumTokens: typeof lc.trailMaximumTokens === 'number' ? lc.trailMaximumTokens : config.trailMaximumTokens,
                            removePromptTemplateFromTrail: typeof lc.removePromptTemplateFromTrail === 'boolean' ? lc.removePromptTemplateFromTrail : config.removePromptTemplateFromTrail,
                            trailSummarizationTemperature: typeof lc.trailSummarizationTemperature === 'number' ? lc.trailSummarizationTemperature : config.trailSummarizationTemperature,
                            enabledTools: Array.isArray(lc.enabledTools) ? lc.enabledTools.filter((t: any) => typeof t === 'string') : [],
                            isDefault: lc.isDefault === true,
                            keepAlive: typeof lc.keepAlive === 'string' ? lc.keepAlive : undefined,
                            apiKeyEnv: typeof lc.apiKeyEnv === 'string' && lc.apiKeyEnv.length > 0 ? lc.apiKeyEnv : undefined,
                            maxRounds: typeof lc.maxRounds === 'number' ? lc.maxRounds : undefined,
                            toolsEnabled: typeof lc.toolsEnabled === 'boolean' ? lc.toolsEnabled : undefined,
                            historyMode: typeof lc.historyMode === 'string'
                                ? lc.historyMode as LlmConfiguration['historyMode']
                                : undefined,
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
    getDefaultModelKey(config: LocalLlmConfig): string | undefined {
        for (const [key, m] of Object.entries(config.models)) {
            if (m.isDefault) { return key; }
        }
        // First model wins if none marked default
        const keys = Object.keys(config.models);
        return keys.length > 0 ? keys[0] : undefined;
    }

    /** Find the default profile key, or undefined if none. */
    getDefaultProfileKey(config: LocalLlmConfig): string | undefined {
        for (const [key, p] of Object.entries(config.profiles)) {
            if (p.isDefault) { return key; }
        }
        const keys = Object.keys(config.profiles);
        return keys.length > 0 ? keys[0] : undefined;
    }

    /** Resolve model config: explicit key → profile override → default model → configurations → top-level values. */
    resolveModelConfig(config: LocalLlmConfig, profile?: ExpanderProfile, explicitModelKey?: string): { key: string; mc: ModelConfig } {
        const modelKey = explicitModelKey ?? profile?.modelConfig ?? this.getDefaultModelKey(config);
        if (modelKey && config.models[modelKey]) {
            return { key: modelKey, mc: config.models[modelKey] };
        }
        // Check configurations array from localLlm section
        if (modelKey && config.configurations) {
            const llmConfig = config.configurations.find(c => c.id === modelKey);
            if (llmConfig) {
                return {
                    key: llmConfig.id,
                    mc: {
                        ollamaUrl: llmConfig.ollamaUrl,
                        apiStyle: llmConfig.apiStyle,
                        model: llmConfig.model,
                        temperature: llmConfig.temperature,
                        stripThinkingTags: llmConfig.stripThinkingTags,
                        description: llmConfig.name,
                        isDefault: llmConfig.isDefault,
                        keepAlive: llmConfig.keepAlive,
                        apiKeyEnv: llmConfig.apiKeyEnv,
                    },
                };
            }
        }
        // Check for default llmConfiguration
        if (config.configurations && config.configurations.length > 0) {
            const defaultLlm = config.configurations.find(c => c.isDefault) || config.configurations[0];
            if (defaultLlm && !modelKey) {
                return {
                    key: defaultLlm.id,
                    mc: {
                        ollamaUrl: defaultLlm.ollamaUrl,
                        apiStyle: defaultLlm.apiStyle,
                        model: defaultLlm.model,
                        temperature: defaultLlm.temperature,
                        stripThinkingTags: defaultLlm.stripThinkingTags,
                        description: defaultLlm.name,
                        isDefault: defaultLlm.isDefault,
                        keepAlive: defaultLlm.keepAlive,
                        apiKeyEnv: defaultLlm.apiKeyEnv,
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

    /**
     * Reachability check. For Ollama (default) GETs `/` and expects HTTP 200.
     * For OpenAI-style backends (vLLM, llama.cpp, LM Studio) GETs `/v1/models`
     * since they typically return 404 on `/`.
     */
    private async isOllamaRunning(baseUrl: string, apiStyle: LocalLlmApiStyle = 'ollama'): Promise<boolean> {
        return new Promise((resolve) => {
            const probePath = apiStyle === 'openai' ? '/v1/models' : '/';
            const u = new URL(probePath, baseUrl);
            const req = http.request(
                { hostname: u.hostname, port: u.port, path: u.pathname, method: 'GET', timeout: 3000 },
                (res) => { resolve(res.statusCode === 200); },
            );
            req.on('error', () => resolve(false));
            req.on('timeout', () => { req.destroy(); resolve(false); });
            req.end();
        });
    }

    /**
     * Check if a specific model is "loaded" on the backend.
     * Ollama: GET `/api/ps` (currently-loaded models — accurate gauge of warm-state).
     * OpenAI: GET `/v1/models` (exposed-models list — not the same as "warm",
     * but the best proxy on backends that don't surface a residency endpoint).
     */
    private async isModelLoaded(baseUrl: string, modelName: string, apiStyle: LocalLlmApiStyle = 'ollama'): Promise<boolean> {
        const probePath = apiStyle === 'openai' ? '/v1/models' : '/api/ps';
        return new Promise((resolve) => {
            const u = new URL(probePath, baseUrl);
            const req = http.request(
                { hostname: u.hostname, port: u.port, path: u.pathname, method: 'GET', timeout: 3000 },
                (res) => {
                    let body = '';
                    res.on('data', (chunk: Buffer) => { body += chunk.toString(); });
                    res.on('end', () => {
                        try {
                            const parsed = JSON.parse(body);
                            const list = apiStyle === 'openai'
                                ? (parsed.data ?? [])
                                : (parsed.models ?? []);
                            const loaded = list.some(
                                (m: any) => (m.id ?? m.name ?? m.model ?? '') === modelName,
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

    /**
     * Build the optional `Authorization` header for a Local LLM request.
     *
     * `apiKeyEnv` names an environment variable; when it is set and that
     * variable holds a non-empty value, the request gets an
     * `Authorization: Bearer <value>` header. When `apiKeyEnv` is unset the
     * call is unauthenticated (the original behaviour). A configured-but-empty
     * variable is logged and treated as unset so a typo'd env name fails
     * loud-ish rather than silently sending `Bearer undefined`.
     */
    private apiKeyAuthHeader(apiKeyEnv?: string): Record<string, string> {
        return apiKeyAuthHeader(apiKeyEnv, process.env, (name) => {
            this.logChannel.appendLine(`[localLlm] apiKeyEnv='${name}' is configured but the environment variable is empty/undefined — sending the request without Authorization.`);
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
        apiStyle: LocalLlmApiStyle = 'ollama',
        apiKeyEnv?: string,
    ): Promise<{ text: string; stats?: OllamaStats; toolCalls?: OllamaToolCall[] }> {
        const messages = [
            { role: 'system', content: systemPrompt },
            { role: 'user', content: userPrompt },
        ];
        if (apiStyle === 'openai') {
            return this.openaiChat(baseUrl, model, messages, temperature, onToken, cancellationToken, tools, apiKeyEnv);
        }
        return this.ollamaChat(baseUrl, model, messages, temperature, onToken, cancellationToken, keepAlive, tools, apiKeyEnv);
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
        apiKeyEnv?: string,
    ): Promise<{ text: string; stats?: OllamaStats; toolCalls?: OllamaToolCall[] }> {
        return new Promise((resolve, reject) => {
            const url = new URL('/api/chat', baseUrl);
            // Diagnostic log so a /api/chat 404 in the vLLM server log
            // can be traced back to a specific code path. If the user
            // ever sees this URL hit a server that only speaks OpenAI,
            // the line in "Tom AI Local Log" will name the offender.
            this.logChannel.appendLine(`[ollamaChat] POST ${url.toString()} (apiStyle=ollama)`);
            // Capture a stack so we can identify the offending caller
            // when /api/chat lands on a vLLM URL by mistake. Only
            // emitted when the hostname doesn't look local — keeps
            // the channel quiet for legitimate Ollama servers.
            if (!/^(localhost|127\.|0\.0\.0\.0)/.test(url.hostname)) {
                const stack = new Error().stack ?? '(no stack)';
                this.logChannel.appendLine(`[ollamaChat] WARNING: /api/chat against non-local host '${url.hostname}'. Stack:\n${stack}`);
            }
            const ollamaStartedAt = Date.now();
            // Single-settle guards + outcome logging so a failure
            // shows ✗ <url> → <status> after Nms in the log channel.
            let ollamaSettled = false;
            const ollamaSafeResolve = (value: { text: string; stats?: OllamaStats; toolCalls?: OllamaToolCall[] }): void => {
                if (ollamaSettled) { return; }
                ollamaSettled = true;
                this.logChannel.appendLine(
                    `[ollamaChat] ✓ ${url.toString()} → ${value.text.length} chars + ${value.toolCalls?.length ?? 0} tool_call(s) after ${Date.now() - ollamaStartedAt}ms`,
                );
                resolve(value);
            };
            const ollamaSafeReject = (err: Error): void => {
                if (ollamaSettled) { return; }
                ollamaSettled = true;
                this.logChannel.appendLine(
                    `[ollamaChat] ✗ ${url.toString()} → ${err.message} after ${Date.now() - ollamaStartedAt}ms`,
                );
                reject(err);
            };
            const requestBody = {
                model,
                messages,
                stream: true,
                options: { temperature },
                // eslint-disable-next-line @typescript-eslint/naming-convention
                ...(keepAlive !== undefined ? { keep_alive: keepAlive } : {}),
                ...(tools && tools.length > 0 ? { tools } : {}),
            };
            const body = JSON.stringify(requestBody);

            const req = http.request(
                {
                    hostname: url.hostname,
                    port: url.port,
                    path: url.pathname,
                    method: 'POST',
                    headers: {
                        // eslint-disable-next-line @typescript-eslint/naming-convention
                        'Content-Type': 'application/json',
                        ...this.apiKeyAuthHeader(apiKeyEnv),
                    },
                },
                (res) => {
                    let fullResponse = '';
                    let buffer = '';
                    let stats: OllamaStats | undefined;
                    let toolCalls: OllamaToolCall[] | undefined;
                    let ollamaError: string | undefined;

                    // Check for HTTP-level errors (e.g. 404 model not found)
                    if (res.statusCode && res.statusCode >= 400) {
                        const status = res.statusCode;
                        let errorBody = '';
                        res.on('data', (chunk: Buffer) => { errorBody += chunk.toString(); });
                        res.on('end', () => {
                            let errorMsg = `Ollama HTTP ${status}`;
                            try {
                                const parsed = JSON.parse(errorBody);
                                if (parsed.error) { errorMsg = parsed.error; }
                            } catch { /* use default message */ }
                            // Attach the statusCode so callers (e.g. the
                            // compaction retry wrapper) can branch on it
                            // without parsing the message.
                            const err = new Error(errorMsg) as Error & { statusCode?: number };
                            err.statusCode = status;
                            ollamaSafeReject(err);
                        });
                        res.on('error', (e) => ollamaSafeReject(e instanceof Error ? e : new Error(String(e))));
                        return;
                    }

                    res.on('data', (chunk: Buffer) => {
                        buffer += chunk.toString();
                        const lines = buffer.split('\n');
                        buffer = lines.pop() ?? '';
                        for (const line of lines) {
                            if (!line.trim()) { continue; }
                            try {
                                const parsed = JSON.parse(line);
                                // Detect Ollama error in streaming response
                                if (parsed.error) {
                                    ollamaError = parsed.error;
                                }
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
                                if (parsed.error) {
                                    ollamaError = parsed.error;
                                }
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
                        // If Ollama returned an error in the stream, reject with it
                        if (ollamaError && !fullResponse.trim()) {
                            ollamaSafeReject(new Error(ollamaError));
                        } else {
                            ollamaSafeResolve({ text: fullResponse, stats, toolCalls });
                        }
                    });
                    res.on('error', (e) => ollamaSafeReject(e instanceof Error ? e : new Error(String(e))));
                },
            );

            if (cancellationToken) {
                cancellationToken.onCancellationRequested(() => {
                    req.destroy();
                    ollamaSafeReject(new Error('Cancelled'));
                });
            }

            req.on('error', (e) => ollamaSafeReject(e instanceof Error ? e : new Error(String(e))));
            req.write(body);
            req.end();
        });
    }

    /**
     * OpenAI-compatible chat completion (vLLM, llama.cpp server, LM Studio,
     * any /v1/chat/completions endpoint). Signature mirrors {@link ollamaChat}
     * so callers can branch on apiStyle without restructuring.
     *
     * **Streaming (SSE).** Sends `stream: true` and parses Server-Sent
     * Events incrementally so `onToken` fires per content delta (used by
     * the live-trail writer to show the answer arriving). `stream_options.
     * include_usage` asks the server to emit a final non-content chunk
     * with `usage: {...}` so we still get prompt/completion token counts
     * — vLLM and llama.cpp honour this; servers that ignore the option
     * just don't get stats.
     *
     * Tool calls in OpenAI streaming arrive as **fragments keyed by `index`**.
     * The first fragment for an index carries the `name` and `id`; subsequent
     * fragments append to `arguments` as a streaming JSON string. We
     * accumulate them in `partialTools[]` and only parse the JSON once the
     * stream ends.
     */
    private async openaiChat(
        baseUrl: string,
        model: string,
        // eslint-disable-next-line @typescript-eslint/naming-convention
        messages: Array<{ role: string; content?: string; tool_calls?: OllamaToolCall[] }>,
        temperature: number,
        onToken?: (token: string) => void,
        cancellationToken?: vscode.CancellationToken,
        tools?: OllamaTool[],
        apiKeyEnv?: string,
    ): Promise<{ text: string; stats?: OllamaStats; toolCalls?: OllamaToolCall[] }> {
        return new Promise((resolve, reject) => {
            const url = new URL('/v1/chat/completions', baseUrl);
            this.logChannel.appendLine(`[openaiChat] POST ${url.toString()} (apiStyle=openai, stream=true)`);
            const startedAt = Date.now();
            // Double-settle guards. We deliberately do NOT install an
            // idle-stream watchdog here — local LLMs (especially large
            // MoE models like Gemma 4 26B) can legitimately think for
            // minutes between data chunks, especially after they
            // recover from a transient backend hiccup. The only valid
            // stop signal is the user clicking the stop button, which
            // trips `cancellationToken.onCancellationRequested` below.
            // safeResolve / safeReject also log the outcome so every
            // call has a paired ✓/✗ line in logChannel — easier to
            // correlate with the vLLM access log than entry-only logs.
            let settled = false;
            const safeResolve = (value: { text: string; stats?: OllamaStats; toolCalls?: OllamaToolCall[] }): void => {
                if (settled) { return; }
                settled = true;
                const elapsed = Date.now() - startedAt;
                const toolCount = value.toolCalls?.length ?? 0;
                this.logChannel.appendLine(`[openaiChat] ✓ ${url.toString()} → ${value.text.length} chars + ${toolCount} tool_call(s) after ${elapsed}ms`);
                resolve(value);
            };
            const safeReject = (err: Error): void => {
                if (settled) { return; }
                settled = true;
                const elapsed = Date.now() - startedAt;
                const status = (err as Error & { statusCode?: number }).statusCode;
                this.logChannel.appendLine(`[openaiChat] ✗ ${url.toString()} → ${status ?? 'no-status'} after ${elapsed}ms: ${err.message}`);
                reject(err);
            };
            // The Ollama wire shape matches OpenAI's tool-call shape closely
            // but with two gaps the OpenAI spec demands: (1) each tool_call
            // entry must have an `id`, and (2) each `role:'tool'` response
            // message must carry a matching `tool_call_id`. Ollama omits both.
            // We synthesise them here in a single forward pass: assign deterministic
            // ids to assistant tool_calls, then queue them so subsequent
            // `role:'tool'` messages (which the upper-layer loop appends in
            // emission order) can pop the next id off the front.
            // eslint-disable-next-line @typescript-eslint/naming-convention
            type OaMsg = { role: string; content: string; tool_calls?: Array<{ id: string; type: 'function'; function: { name: string; arguments: string } }>; tool_call_id?: string };
            const pendingIds: string[] = [];
            let callCounter = 0;
            const oaMessages: OaMsg[] = messages.map((m) => {
                if (m.tool_calls && m.tool_calls.length > 0) {
                    const calls = m.tool_calls.map((tc) => {
                        const id = (tc as { id?: string }).id ?? `call_${callCounter++}`;
                        pendingIds.push(id);
                        return {
                            id,
                            type: 'function' as const,
                            function: {
                                name: tc.function.name,
                                arguments: typeof tc.function.arguments === 'string'
                                    ? tc.function.arguments
                                    : JSON.stringify(tc.function.arguments ?? {}),
                            },
                        };
                    });
                    return { role: m.role, content: m.content ?? '', tool_calls: calls };
                }
                if (m.role === 'tool') {
                    const toolCallId = (m as { tool_call_id?: string }).tool_call_id ?? pendingIds.shift() ?? `call_${callCounter++}`;
                    return { role: 'tool', content: m.content ?? '', tool_call_id: toolCallId };
                }
                return { role: m.role, content: m.content ?? '' };
            });
            const requestBody = {
                model,
                messages: oaMessages,
                temperature,
                stream: true,
                // eslint-disable-next-line @typescript-eslint/naming-convention
                stream_options: { include_usage: true },
                ...(tools && tools.length > 0 ? { tools } : {}),
            };
            const body = JSON.stringify(requestBody);

            const req = http.request(
                {
                    hostname: url.hostname,
                    port: url.port,
                    path: url.pathname,
                    method: 'POST',
                    headers: {
                        // eslint-disable-next-line @typescript-eslint/naming-convention
                        'Content-Type': 'application/json',
                        // eslint-disable-next-line @typescript-eslint/naming-convention
                        Accept: 'text/event-stream',
                        ...this.apiKeyAuthHeader(apiKeyEnv),
                    },
                },
                (res) => {
                    // HTTP error: drain the body once so we can include the
                    // server's error message in the rejection.
                    if (res.statusCode && res.statusCode >= 400) {
                        // Tag the status onto the rejection so the
                        // compaction retry wrapper (and any other
                        // caller that branches on retryable status)
                        // can read it directly without parsing.
                        const status = res.statusCode;
                        let errorBody = '';
                        res.on('data', (chunk: Buffer) => { errorBody += chunk.toString(); });
                        res.on('end', () => {
                            let errorMsg = `OpenAI-compatible HTTP ${status}`;
                            try {
                                const parsed = JSON.parse(errorBody);
                                if (parsed.error?.message) { errorMsg = parsed.error.message; }
                                else if (parsed.detail) { errorMsg = typeof parsed.detail === 'string' ? parsed.detail : JSON.stringify(parsed.detail); }
                            } catch { /* use default */ }
                            const err = new Error(errorMsg) as Error & { statusCode?: number };
                            err.statusCode = status;
                            safeReject(err);
                        });
                        res.on('error', (err) => safeReject(err instanceof Error ? err : new Error(String(err))));
                        return;
                    }

                    let buffer = '';
                    let fullText = '';
                    let stats: OllamaStats | undefined;
                    // Partial tool calls indexed by the `index` field on each
                    // delta — name + id arrive once on the first fragment,
                    // arguments stream in concatenated string fragments.
                    type PartialTool = { id?: string; name: string; args: string };
                    const partialTools: PartialTool[] = [];
                    let sawDone = false;

                    const handleEvent = (eventData: string): void => {
                        if (eventData === '[DONE]') {
                            sawDone = true;
                            return;
                        }
                        let parsed: any;
                        try { parsed = JSON.parse(eventData); }
                        catch { return; /* malformed/partial — skip */ }
                        // Usage frames have no `choices` — they arrive after
                        // the last content chunk when stream_options.include_usage
                        // is set.
                        if (parsed?.usage) {
                            const u = parsed.usage;
                            stats = {
                                promptTokens: u.prompt_tokens ?? 0,
                                completionTokens: u.completion_tokens ?? 0,
                                totalDurationMs: 0,
                                loadDurationMs: 0,
                            };
                        }
                        const choice = parsed?.choices?.[0];
                        if (!choice) { return; }
                        const delta = choice.delta ?? {};
                        if (typeof delta.content === 'string' && delta.content.length > 0) {
                            fullText += delta.content;
                            try { onToken?.(delta.content); } catch { /* listener errors must not abort the stream */ }
                        }
                        const tcDelta = delta.tool_calls;
                        if (Array.isArray(tcDelta)) {
                            for (const frag of tcDelta) {
                                const idx = typeof frag.index === 'number' ? frag.index : 0;
                                if (!partialTools[idx]) {
                                    partialTools[idx] = { id: undefined, name: '', args: '' };
                                }
                                const slot = partialTools[idx];
                                if (typeof frag.id === 'string' && frag.id.length > 0) { slot.id = frag.id; }
                                const fnName = frag.function?.name;
                                if (typeof fnName === 'string' && fnName.length > 0) { slot.name = fnName; }
                                const fnArgs = frag.function?.arguments;
                                if (typeof fnArgs === 'string') { slot.args += fnArgs; }
                            }
                        }
                    };

                    res.setEncoding('utf-8');
                    res.on('data', (chunk: string) => {
                        buffer += chunk;
                        // SSE event boundary: two consecutive newlines.
                        // We split on either `\n\n` or `\r\n\r\n` to be
                        // forgiving of intermediaries that rewrite line
                        // endings. Each event is a block of `field: value`
                        // lines; we only care about `data:` here.
                        let sepIdx: number;
                        // eslint-disable-next-line no-constant-condition
                        while (true) {
                            const idxLf = buffer.indexOf('\n\n');
                            const idxCrLf = buffer.indexOf('\r\n\r\n');
                            if (idxLf === -1 && idxCrLf === -1) { break; }
                            // Prefer whichever comes first
                            if (idxCrLf !== -1 && (idxLf === -1 || idxCrLf < idxLf)) {
                                sepIdx = idxCrLf;
                                const block = buffer.slice(0, sepIdx);
                                buffer = buffer.slice(sepIdx + 4);
                                processBlock(block);
                            } else {
                                sepIdx = idxLf;
                                const block = buffer.slice(0, sepIdx);
                                buffer = buffer.slice(sepIdx + 2);
                                processBlock(block);
                            }
                        }
                    });

                    const processBlock = (block: string): void => {
                        const dataLines: string[] = [];
                        for (const line of block.split(/\r?\n/)) {
                            if (line.startsWith('data:')) {
                                dataLines.push(line.slice(5).trimStart());
                            }
                            // We ignore `event:` / `id:` / comment lines —
                            // OpenAI-compat servers only use `data:`.
                        }
                        if (dataLines.length > 0) {
                            // Multi-line data fields are joined with newlines
                            // per the SSE spec; in practice OpenAI/vLLM
                            // always send one `data:` per event.
                            handleEvent(dataLines.join('\n'));
                        }
                    };

                    res.on('end', () => {
                        // Drain anything left in the buffer (some servers
                        // omit the trailing blank line before closing).
                        if (buffer.trim().length > 0) { processBlock(buffer); }

                        const toolCalls: OllamaToolCall[] | undefined = partialTools.length > 0
                            ? partialTools
                                .filter((t): t is PartialTool => !!t && (t.name.length > 0 || t.args.length > 0))
                                .map((t) => {
                                    let args: Record<string, unknown> = {};
                                    if (t.args) {
                                        try { args = JSON.parse(t.args); } catch { args = { _raw: t.args }; }
                                    }
                                    return {
                                        id: t.id,
                                        function: { name: t.name, arguments: args },
                                    } as OllamaToolCall;
                                })
                            : undefined;
                        // A clean stream end without [DONE] is unusual but
                        // not fatal — the body we've accumulated is still
                        // the answer. Log so it's visible if a server
                        // misbehaves.
                        if (!sawDone && fullText.length === 0 && (!toolCalls || toolCalls.length === 0)) {
                            return safeReject(new Error('OpenAI stream ended without any content or tool calls'));
                        }
                        safeResolve({ text: fullText, stats, toolCalls });
                    });
                    res.on('error', (err) => safeReject(err instanceof Error ? err : new Error(String(err))));
                },
            );

            if (cancellationToken) {
                cancellationToken.onCancellationRequested(() => {
                    req.destroy();
                    safeReject(new Error('Cancelled'));
                });
            }

            req.on('error', (err) => safeReject(err instanceof Error ? err : new Error(String(err))));
            req.write(body);
            req.end();
        });
    }

    /**
     * Single-round Ollama API call — the "call API" primitive extracted per
     * multi_transport_prompt_queue_revised.md §4.4a. Takes already-composed
     * messages and a `SharedToolDefinition[]` (converted to Ollama's tool
     * schema inside), calls `/api/chat` once, returns one model response.
     * NO tool loop, NO approval gate, NO template handling — those live
     * one layer up (in `ollamaGenerateWithTools` for the Local LLM panel's
     * own flow, or in `AnthropicHandler` when a Local-LLM-backed Anthropic
     * profile is being driven through the shared agent loop).
     *
     * Intentionally additive: `ollamaGenerateWithTools` is unchanged
     * publicly and delegates here for its HTTP call so panel behaviour
     * stays byte-identical.
     */
    public async callLocalLlmOnce(opts: {
        baseUrl: string;
        model: string;
        temperature: number;
        messages: Array<{ role: string; content?: string; tool_calls?: OllamaToolCall[] }>;
        tools: SharedToolDefinition[];
        keepAlive?: string;
        onToken?: (token: string) => void;
        cancellationToken?: vscode.CancellationToken;
        /** Backend protocol. Defaults to `'ollama'`. */
        apiStyle?: LocalLlmApiStyle;
        /**
         * Name of the env var holding the bearer API key for this endpoint.
         * When set (and non-empty), requests carry `Authorization: Bearer …`.
         */
        apiKeyEnv?: string;
        /**
         * Status callback fired before each retry on a busy backend (HTTP
         * 429 / 503 / 529 / textual hints). The string is meant for direct
         * UI display. Plumbed to the Anthropic panel's status line by
         * `sendViaLocalLlm` so the user can watch the retry budget tick down.
         */
        onRetryStatus?: (message: string) => void;
        /**
         * Total cumulative wait time (ms) the retry loop is allowed before
         * giving up. Defaults to 10 minutes. Applies uniformly to both
         * Ollama and OpenAI/vLLM paths; the same backoff policy keeps
         * behaviour predictable across backends.
         */
        retryTotalWaitMs?: number;
    }): Promise<{ text: string; stats?: OllamaStats; toolCalls?: OllamaToolCall[] }> {
        const ollamaTools = toOllamaTools(opts.tools, () => true);
        const totalWaitMs = opts.retryTotalWaitMs ?? 10 * 60 * 1000;
        const label = opts.apiStyle === 'openai' ? 'OpenAI/vLLM busy' : 'Ollama busy';
        return withRetryBudget({
            call: () => opts.apiStyle === 'openai'
                ? this.openaiChat(
                    opts.baseUrl,
                    opts.model,
                    opts.messages,
                    opts.temperature,
                    opts.onToken,
                    opts.cancellationToken,
                    ollamaTools.length > 0 ? ollamaTools : undefined,
                    opts.apiKeyEnv,
                )
                : this.ollamaChat(
                    opts.baseUrl,
                    opts.model,
                    opts.messages,
                    opts.temperature,
                    opts.onToken,
                    opts.cancellationToken,
                    opts.keepAlive,
                    ollamaTools.length > 0 ? ollamaTools : undefined,
                    opts.apiKeyEnv,
                ),
            totalWaitMs,
            backendLabel: label,
            cancellationToken: opts.cancellationToken,
            onRetryStatus: opts.onRetryStatus,
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
        /** Backend protocol; defaults to `'ollama'`. */
        apiStyle?: LocalLlmApiStyle;
        /**
         * Name of the env var holding the bearer API key for this endpoint.
         * When set (and non-empty), requests carry `Authorization: Bearer …`.
         */
        apiKeyEnv?: string;
        /**
         * Optional live-trail writer. When provided, `beginToolCall`
         * fires before each tool invocation and `appendToolResult`
         * after, so the panel's Open Live Trail button can stream the
         * tool loop as it runs. Caller owns the prompt-start / prompt-end
         * events.
         */
        liveTrail?: LiveTrailWriter | null;
    }): Promise<{ text: string; stats?: OllamaStats; toolCallCount: number; turnsUsed: number }> {
        const {
            baseUrl, model, systemPrompt, userPrompt, temperature,
            tools, onToken: callerOnToken, onToolCall, cancellationToken, keepAlive, apiStyle, apiKeyEnv, liveTrail,
        } = options;
        // When a live-trail writer is provided, wrap the caller's
        // `onToken` so each streamed content delta is also folded into
        // the live-trail's current `### 💬 assistant` heading. The
        // writer's `currentlyInAssistantText` flag keeps subsequent
        // chunks under the same heading; a `beginToolCall` event in
        // between resets the flag so the next text chunk starts a new
        // heading after the tool result.
        const onToken = liveTrail
            ? (tok: string): void => {
                try { callerOnToken?.(tok); } catch { /* upstream listener errors must not abort the stream */ }
                try { liveTrail.appendAssistantText(tok); } catch { /* trail writes must never affect the turn */ }
            }
            : callerOnToken;
        const maxRounds = options.maxRounds ?? 20;
        const trailType = options.trailType ?? 'local';
        const history = options.history ?? [];
        const ollamaTools = toOllamaTools(tools, () => true); // send all provided tools

        // Register this manager's ToolTrail as the session-wide active
        // one so `tomAi_readPastToolResult` resolves keys issued from the
        // Local LLM path (and any inflight tool can call back into the
        // trail). Reset the call-id → key map per invocation so old
        // sessions don't leak.
        setActiveToolTrail(this.toolTrail);
        this.toolCallIdToKey.clear();

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
        const messages: Array<{ role: string; content?: string; tool_calls?: OllamaToolCall[]; tool_call_id?: string }> = [
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

        // Dump the initial assembled request (system + history +
        // current user prompt + tools) to the per-quest
        // `last_request.json`. This is the snapshot the user wanted —
        // fires once per user message, NOT on each tool-loop iteration,
        // so the file always reflects what the model first saw for the
        // current prompt rather than mid-loop tool churn.
        try {
            const { writeLastRequest, quickStats } = await import('../services/lastRequestDump.js');
            writeLastRequest({
                timestamp: new Date().toISOString(),
                subsystem: 'localllm',
                endpoint: `${apiStyle === 'openai' ? 'POST /v1/chat/completions' : 'POST /api/chat'} (${baseUrl})`,
                model,
                stats: quickStats({ messages, tools: ollamaTools, systemPrompt }),
                body: {
                    model,
                    apiStyle: apiStyle ?? 'ollama',
                    temperature,
                    keepAlive,
                    messages,
                    ...(ollamaTools.length > 0 ? { tools: ollamaTools } : {}),
                },
            }, WsPaths.getWorkspaceQuestId());
        } catch { /* best-effort */ }

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

            // On the very last round, don't offer tools — force a text-only
            // response. Route through callLocalLlmOnce so the panel's loop
            // exercises the exact same primitive the Anthropic handler's
            // Local LLM leaf uses (see §4.4a) — keeps behaviour aligned.
            const roundTools: SharedToolDefinition[] = remaining <= 1 ? [] : tools;

            const result = await this.callLocalLlmOnce({
                baseUrl,
                model,
                messages,
                temperature,
                tools: roundTools,
                onToken,
                cancellationToken,
                keepAlive,
                apiStyle,
                apiKeyEnv,
            });

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

            // Append assistant message with tool_calls. Stamp a synthetic
            // tool_call_id on every call so we can pair the tool result
            // back to its ToolTrail key when applying the retention
            // policy. Ollama/vLLM responses sometimes lack ids, which
            // would otherwise break the stub mapping.
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            const stampedCalls = result.toolCalls.map((tc: any) => {
                if (!tc.id || typeof tc.id !== 'string' || tc.id.length === 0) {
                    tc.id = `lcall_${this.toolCallCounter++}`;
                }
                return tc;
            });
            messages.push({
                role: 'assistant',
                content: result.text || undefined,
                // eslint-disable-next-line @typescript-eslint/naming-convention
                tool_calls: stampedCalls,
            });

            // Execute each tool and append results
            for (const tc of stampedCalls) {
                totalToolCalls++;

                // Trail: Log tool request
                logToolRequest(trailType, tc.function.name, tc.function.arguments);

                const tStart = Date.now();
                let toolResult = '';
                let toolError: string | undefined;
                // The replay key is assigned AFTER `executeToolCall` so
                // we emit the live-trail heading with a provisional `?`
                // placeholder if it's needed earlier, but the Anthropic
                // side passes the real key here — replicate that shape
                // by computing the input summary first and recording the
                // ToolTrail entry after execution, then back-fill the
                // live-trail with the same key. For now we pre-compute
                // the heading with the synthetic call id so the user
                // sees the tool call appear immediately, then the
                // result fills in below.
                liveTrail?.beginToolCall(tc.function.name, tc.function.arguments, tc.id);
                try {
                    toolResult = await executeToolCall(tools, tc);
                } catch (err) {
                    toolError = err instanceof Error ? err.message : String(err);
                    toolResult = `Error: ${toolError}`;
                }
                const tDur = Date.now() - tStart;
                onToolCall?.(tc.function.name, tc.function.arguments, toolResult);
                liveTrail?.appendToolResult(toolResult, toolResult.length);

                // Trail: Log tool result
                logToolResult(trailType, tc.function.name, toolResult);

                // Record in the ToolTrail (in-memory ring + disk store)
                // so this call is recoverable by key via
                // `tomAi_readPastToolResult` after the retention policy
                // replaces the inline body with a stub.
                const inputSummary = (() => {
                    try { return JSON.stringify(tc.function.arguments).slice(0, 200); }
                    catch { return ''; }
                })();
                const addedEntry = this.toolTrail.add({
                    timestamp: new Date().toISOString().slice(11, 19),
                    round: round + 1,
                    toolName: tc.function.name,
                    inputSummary,
                    result: toolResult,
                    durationMs: tDur,
                    error: toolError,
                });
                this.toolCallIdToKey.set(tc.id, addedEntry.key);

                // Log tool call to log channel
                this.logChannel.appendLine(`[Round ${round + 1}] Tool #${totalToolCalls} key=${addedEntry.key}: ${tc.function.name}`);
                this.logChannel.appendLine(`  Args: ${JSON.stringify(tc.function.arguments)}`);
                const shortResult = toolResult.length > 300 ? toolResult.substring(0, 297) + '...' : toolResult;
                this.logChannel.appendLine(`  Result (${toolResult.length} chars): ${shortResult}`);

                messages.push({
                    role: 'tool',
                    content: toolResult,
                    // eslint-disable-next-line @typescript-eslint/naming-convention
                    tool_call_id: tc.id,
                });
            }

            // Apply the tool-trail retention policy after each tool
            // round. Newest `toolTrailKeepRounds` rounds keep their
            // (truncated) bodies; older rounds collapse to a one-line
            // stub naming the replay key. Full bodies live on disk under
            // `_ai/trail/localllm/<quest>/tool_results/<key>.json`.
            this.applyLocalLlmToolTrailPolicy(messages);
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
    // Public API — for use by other handlers (e.g. AiConversationManager)
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
        /**
         * Optional tool override. When provided, uses these tools instead of the
         * default READ_ONLY_TOOLS. Used by AI Conversation per-persona tool
         * resolution.
         */
        tools?: SharedToolDefinition[];
    }): Promise<{ text: string; rawText: string; thinkContent: string; stats?: OllamaStats; toolCallCount?: number; turnsUsed?: number }> {
        const config = this.loadConfig();
        const { mc } = this.resolveModelConfig(config, undefined, options.modelConfigKey);
        const temp = options.temperature ?? mc.temperature;
        const strip = options.stripThinkingTags ?? mc.stripThinkingTags;
        const trailType = options.trailType ?? 'local';

        // Check the endpoint is reachable (Ollama GET /, OpenAI GET /v1/models)
        const running = await this.isOllamaRunning(mc.ollamaUrl, mc.apiStyle);
        if (!running) {
            const label = mc.apiStyle === 'openai' ? 'OpenAI-compatible endpoint' : 'Ollama';
            throw new Error(`${label} is not running at ${mc.ollamaUrl}`);
        }

        // Trail: Log prompt before sending to Ollama
        logPrompt(trailType, 'ollama', options.userPrompt, options.systemPrompt, {
            model: mc.model,
            modelConfig: options.modelConfigKey,
            temperature: temp,
            maxRounds: options.maxRounds ?? 20,
            source: 'chatWithOllama',
        });

        // Always use tool-call loop — model decides whether to use tools.
        // Tool set: caller override (e.g. per-persona for AI Conversation), else
        // the conservative READ_ONLY_TOOLS default for general chat.
        const result = await this.ollamaGenerateWithTools({
            baseUrl: mc.ollamaUrl,
            model: mc.model,
            apiStyle: mc.apiStyle,
            apiKeyEnv: mc.apiKeyEnv,
            systemPrompt: options.systemPrompt,
            userPrompt: options.userPrompt,
            temperature: temp,
            tools: options.tools ?? READ_ONLY_TOOLS,
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

    /**
     * Check if a specific model is loaded.
     *
     * Resolves the `(url, apiStyle)` pair from the requested model
     * config key (or the default) so the probe hits the right endpoint:
     *
     *   apiStyle='ollama' → GET /api/ps (warm-model list)
     *   apiStyle='openai' → GET /v1/models (exposed-model list)
     *
     * The previous version ignored `apiStyle` and always probed
     * `/api/ps`, which returns 404 on vLLM / llama.cpp / LM Studio. That
     * made the panel's "Loading <model>..." progress notification stick
     * forever because the poll never observed "loaded".
     */
    public async checkModelLoaded(modelName?: string, llmConfigKey?: string): Promise<boolean> {
        const config = this.loadConfig();
        const { mc } = this.resolveModelConfig(config, undefined, llmConfigKey);
        const name = modelName ?? mc.model ?? config.model;
        const url = mc.ollamaUrl ?? config.ollamaUrl;
        const apiStyle = (mc as { apiStyle?: 'ollama' | 'openai' }).apiStyle ?? 'ollama';
        return this.isModelLoaded(url, name, apiStyle);
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
        skipQuestRefresh = false,
    ): Promise<ExpanderProcessResult> {
        const config = this.loadConfig();

        // Quest Refresh auto-trigger (localLlm panel). Mirror of the Anthropic
        // handler's hook: before counting this upcoming user prompt, fire a
        // refresh through this same path if the interval has elapsed (with
        // `skipQuestRefresh` so the refresh prompt neither counts nor recurses),
        // then count this prompt. Programmatic / bridge sends pass
        // `skipQuestRefresh = true` so only genuine panel sends advance the
        // counter.
        const refreshQuest = WsPaths.getWorkspaceQuestId();
        if (!skipQuestRefresh) {
            if (QuestRefreshService.instance.shouldAutoRefresh('localLlm', refreshQuest)) {
                await QuestRefreshService.instance.runRefresh(
                    'localLlm',
                    (refreshText) => this.process(
                        refreshText, profileKey, modelConfigKey, editor, cancellationToken, onToolCall, true,
                    ).then(() => undefined),
                    refreshQuest,
                );
            }
            QuestRefreshStore.instance.incrementCount('localLlm', refreshQuest);
        }

        // Load trail config for new session
        loadTrailConfig();

        // Resolve profile
        const effectiveProfileKey = profileKey ?? this.getDefaultProfileKey(config) ?? '_default';
        const profile = config.profiles[effectiveProfileKey];

        // Resolve model config — check both models dict AND configurations array
        const effectiveModelKey = modelConfigKey ?? profile?.modelConfig ?? this.getDefaultModelKey(config);
        const { key: resolvedModelKey, mc } = this.resolveModelConfig(config, profile, effectiveModelKey ?? undefined);

        // Per-profile knobs that govern memory + history wiring.
        // historySuffix → which snapshot file we read/write.
        // memorySuffix  → which `facts-<suffix>.md` file the ${memory}
        //                 placeholder injects (else: all memory files).
        // autoInjectMemory → when true, append `\n\n## Memory\n\n${memory}`
        //                    to the system prompt source before
        //                    placeholder resolution so the profile
        //                    doesn't have to spell the placeholder out.
        const historySuffix = profile?.historySuffix;
        const memorySuffix = profile?.memorySuffix;
        const autoInjectMemory = profile?.autoInjectMemory === true;

        // Seed in-memory history from disk on first send for this
        // (quest, suffix) pair so the LocalLLM panel behaves like the
        // Anthropic panel: history survives reloads, and switching
        // between profiles with different suffixes loads the right
        // thread. Per-call trim immediately after caps the array per
        // the active configuration so a legacy oversized snapshot
        // can't blow out the next request.
        const questForHistory = WsPaths.getWorkspaceQuestId();
        this.seedHistoryFromSnapshot(questForHistory, historySuffix);
        const seedCaps = this.resolveEffectiveLocalLlmCaps(mc);
        this.trimRawTurns(seedCaps.rawTurnsKept);

        const rawSystemPrompt = profile?.systemPrompt ?? config.systemPrompt;
        // Auto-inject: identical contract to AnthropicHandler — append
        // a `## Memory` heading + `${memory}` placeholder so the
        // resolver below substitutes the real memory block. Resolution
        // honours `memorySuffix` via `preValues`.
        const effectiveSystemPrompt = autoInjectMemory
            ? `${rawSystemPrompt ?? ''}\n\n## Memory\n\n\${memory}`
            : rawSystemPrompt;
        const effectiveResultTemplate = profile?.resultTemplate ?? config.resultTemplate;
        const effectiveTemperature = profile?.temperature ?? mc.temperature;

        // Resolve ${instructions} content from .tom/local-instructions/
        const instructionsContent = this.resolveInstructionsContent(mc.model);
        // Bundle the profile-derived knobs into the placeholder values
        // so the `${memory}` resolver in utils/variableResolver.ts can
        // pick up `memorySuffix` without a per-call API parameter.
        const instructionsExtra: Record<string, string> = { instructions: instructionsContent };
        if (memorySuffix) {
            instructionsExtra.memorySuffix = memorySuffix;
        }

        // Pre-values for system prompt placeholder resolution
        const preValues = this.buildPlaceholderValues(
            editor, prompt, '', '', '', mc.model, resolvedModelKey, effectiveProfileKey,
            undefined, instructionsExtra,
        );
        const resolvedSystemPrompt = this.resolvePlaceholders(effectiveSystemPrompt, preValues);

        // Log process() invocation
        this.logChannel.appendLine(`[process] Requested modelConfigKey: ${modelConfigKey ?? '(none)'} → effectiveModelKey: ${effectiveModelKey ?? '(none)'} → resolved: ${resolvedModelKey}`);
        this.logChannel.appendLine(`[process] Profile: ${effectiveProfileKey} | Model: ${resolvedModelKey} (${mc.model}) | URL: ${mc.ollamaUrl}`);
        this.logChannel.appendLine(`[process] Temperature: ${effectiveTemperature} | Instructions: ${instructionsContent.length} chars`);
        this.logChannel.appendLine(`[process] Prompt: ${prompt.length} chars | System prompt: ${resolvedSystemPrompt.length} chars`);

        // Resolve history mode
        const effectiveHistoryMode = profile?.historyMode ?? config.historyMode;
        this.logChannel.appendLine(`[process] History mode: ${effectiveHistoryMode} | History enabled: ${this.historyEnabled} | History length: ${this.conversationHistory.length}`);

        // Hoisted so the outer `catch` can close the trail block with
        // a visible ERROR marker. Assigned inside the try once the
        // reachability check passes.
        let liveTrail: LiveTrailWriter | null = null;
        try {
            // Check the endpoint is reachable (apiStyle-aware)
            const running = await this.isOllamaRunning(mc.ollamaUrl, mc.apiStyle);
            if (!running) {
                const label = mc.apiStyle === 'openai' ? 'OpenAI-compatible endpoint' : 'Ollama';
                return {
                    success: false,
                    result: '',
                    rawResponse: '',
                    response: '',
                    thinkTagContent: '',
                    profile: effectiveProfileKey,
                    modelConfig: resolvedModelKey,
                    error: `${label} is not running at ${mc.ollamaUrl}`,
                };
            }

            // Always use the tool-call loop — even if the model doesn't call tools,
            // it goes through ollamaGenerateWithTools which handles messages correctly.
            // The model can choose to use tools or just produce a direct answer.
            const effectiveMaxRounds = profile?.maxRounds ?? 20;

            // Tool resolution (matches the "All Tools Enabled" checkbox in
            // the profile editor — see globalTemplateEditor-handler.ts):
            //  1. profile.toolsEnabled !== false  → ALL tools (every entry in
            //     ALL_SHARED_TOOLS).
            //  2. profile.toolsEnabled === false  → use profile.enabledTools
            //     subset; empty subset = no tools.
            // Top-level config.toolsEnabled supplies the default when the
            // profile omits the field entirely.
            const profileToolsEnabled = (profile as { toolsEnabled?: boolean } | undefined)?.toolsEnabled;
            const profileEnabledTools = (profile as { enabledTools?: string[] } | undefined)?.enabledTools;
            const allToolsEnabled = (profileToolsEnabled ?? config.toolsEnabled) !== false;
            let toolsToUse: SharedToolDefinition[];
            if (allToolsEnabled) {
                toolsToUse = [...ALL_SHARED_TOOLS];
            } else {
                const enabledIds = Array.isArray(profileEnabledTools) ? profileEnabledTools : [];
                toolsToUse = enabledIds.length > 0
                    ? ALL_SHARED_TOOLS.filter((t) => enabledIds.includes(t.name))
                    : [];
            }

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

            // Build history for Ollama based on mode. We support five
            // modes (anthropic_sdk_integration.md §6):
            //   none / last       — degenerate fast paths
            //   full              — every prior turn (capped by
            //                       compaction.fullTrailMaxTurns in the
            //                       compactor)
            //   trim_and_summary  — incremental: kept raw turns +
            //                       running compactedSummary prepended
            //                       as a synthetic exchange. Mirrors the
            //                       Anthropic handler so both share the
            //                       `${existingSummary}` / `${lastTurn}`
            //                       compaction template contract.
            //   summary / llm_extract — delegate to compactHistory()
            const eCaps = this.resolveEffectiveLocalLlmCaps(mc);
            let historyForOllama: Array<{ role: string; content: string }> = [];
            // History is gated solely on `effectiveHistoryMode`. A profile
            // (or top-level config) that opts out sets it to 'none';
            // anything else means "inject what the mode prescribes". The
            // legacy `this.historyEnabled` runtime kill-switch is no
            // longer consulted — no caller flips it and the gate left
            // the entire history feature dark by default.
            if (effectiveHistoryMode !== 'none') {
                if (effectiveHistoryMode === 'full') {
                    historyForOllama = this.getHistoryAsMessages();
                } else if (effectiveHistoryMode === 'last') {
                    const hist = this.conversationHistory;
                    const lastUser = hist.slice().reverse().find(m => m.role === 'user');
                    const lastAssistant = hist.slice().reverse().find(m => m.role === 'assistant');
                    if (lastUser) { historyForOllama.push({ role: 'user', content: lastUser.content }); }
                    if (lastAssistant) { historyForOllama.push({ role: 'assistant', content: lastAssistant.content }); }
                } else if (effectiveHistoryMode === 'trim_and_summary') {
                    // Incremental: prepend a synthetic user/assistant pair
                    // carrying `compactedSummary`, then the most recent
                    // `rawTurnsKept * 2` raw messages from `rawTurns`.
                    if (this.compactedSummary) {
                        historyForOllama.push({
                            role: 'user',
                            content: `## Additional context (compacted from earlier turns)\n\n${this.compactedSummary}`,
                        });
                        historyForOllama.push({
                            role: 'assistant',
                            content: 'Understood — continuing with this context in mind.',
                        });
                    }
                    const keep = Math.max(0, eCaps.rawTurnsKept) * 2;
                    const rawSlice = keep > 0 ? this.rawTurns.slice(-keep) : [];
                    for (const m of rawSlice) {
                        historyForOllama.push({ role: m.role, content: m.content });
                    }
                } else {
                    // 'summary' / 'llm_extract' — delegate to shared
                    // compactor for a one-shot rewrite.
                    try {
                        const { compactHistory } = await import('../services/history-compaction.js');
                        const compactionCfg = (loadSendToChatConfig() as { compaction?: Record<string, unknown> })?.compaction ?? {};
                        const input = this.getHistoryAsMessages().map(m => ({
                            role: (m.role === 'system' ? 'user' : m.role) as 'user' | 'assistant' | 'system',
                            content: m.content,
                        }));
                        const compacted = await compactHistory(input, {
                            mode: effectiveHistoryMode as 'summary' | 'llm_extract',
                            maxHistoryTokens: eCaps.maxHistoryTokens,
                            historyMaxChars: eCaps.historyMaxChars,
                            memoryMaxChars: eCaps.memoryMaxChars,
                            maxRounds: Math.max(1, eCaps.rawTurnsKept),
                            llmProvider: (compactionCfg.llmProvider as 'localLlm' | 'anthropic') ?? 'localLlm',
                            llmConfigId: (compactionCfg.llmConfigId as string) ?? (mc as { id?: string }).id ?? 'default',
                            compactionTemplateId: compactionCfg.compactionTemplateId as string | undefined,
                            memoryTemplateId: compactionCfg.memoryExtractionTemplateId as string | undefined,
                            compactionMaxRounds: (compactionCfg.compactionMaxRounds as number | undefined) ?? 1,
                        });
                        historyForOllama = compacted.map(m => ({ role: m.role, content: m.content }));
                    } catch (e) {
                        this.logChannel.appendLine(`[process] compactHistory failed, falling back to full: ${String(e)}`);
                        historyForOllama = this.getHistoryAsMessages();
                    }
                }
                this.logChannel.appendLine(`[process] Passing ${historyForOllama.length} history message(s) to Ollama (mode=${effectiveHistoryMode}, summaryChars=${this.compactedSummary.length}, rawTurns=${this.rawTurns.length})`);
            }

            this.logChannel.appendLine(`[process] All tools enabled: ${allToolsEnabled} | Tools count: ${toolsToUse.length}`);

            // Per-call live-trail writer — appends a fresh `## 🚀 PROMPT`
            // block + tool calls / results / final text to
            // `_ai/quests/<quest>/live-trail-localLLM.md`. Parallel to the
            // Anthropic `live-trail.md` so the user can follow both
            // transports side by side. Local to this call (never a field
            // on the singleton) so concurrent invocations don't stomp.
            liveTrail = new LiveTrailWriter(questForHistory, LOCAL_LLM_LIVE_TRAIL_FILENAME);
            // While a refresh interval is active, retain every prompt since the
            // last refresh (base + interval) so the refresh prompt can read the
            // full recent history. `0` ⇒ default last-5-blocks behaviour.
            liveTrail.setExtraBlockAllowance(
                QuestRefreshStore.instance.extraTrailAllowance('localLlm', questForHistory),
            );
            liveTrail.beginPrompt({
                transport: 'localLlm',
                config: `${effectiveProfileKey} / ${resolvedModelKey}`,
                userText: prompt,
            });

            const result = await this.ollamaGenerateWithTools({
                baseUrl: mc.ollamaUrl,
                model: mc.model,
                apiStyle: mc.apiStyle,
                apiKeyEnv: mc.apiKeyEnv,
                systemPrompt: resolvedSystemPrompt,
                userPrompt: prompt,
                temperature: effectiveTemperature,
                tools: toolsToUse,
                cancellationToken,
                keepAlive: mc.keepAlive,
                maxRounds: effectiveMaxRounds,
                onToolCall,
                history: historyForOllama,
                liveTrail,
            });
            const rawResponse = result.text;
            const stats = result.stats;
            const toolCallCount = result.toolCallCount;
            const turnsUsed = result.turnsUsed;

            if (!rawResponse.trim()) {
                liveTrail.endPromptWithError('Ollama returned an empty response');
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

            // Live-trail close: tokens already streamed in real time via
            // the onToken wrapper inside `ollamaGenerateWithTools`, so
            // the `### 💬 assistant` heading and body are already in the
            // file. `<think>…</think>` content is part of that stream
            // (the model emits it inline), so we deliberately do NOT
            // call `appendThinking(thinkContent)` here — that would
            // duplicate text already in the file. `endPrompt` closes
            // the block with the rounds / tool-call / duration summary.
            // `thinkContent` is still used downstream for the
            // `${thinkTagInfo}` placeholder.
            void cleaned;
            void thinkContent;
            liveTrail.endPrompt({
                rounds: turnsUsed ?? 0,
                toolCalls: toolCallCount ?? 0,
            });

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

            // Record the just-completed exchange. Same gate as the
            // history-injection block above: `effectiveHistoryMode !== 'none'`
            // is the single source of truth.
            if (effectiveHistoryMode !== 'none') {
                this.addToHistory('user', prompt);
                this.addToHistory('assistant', cleaned);
                this.logChannel.appendLine(`[process] Added exchange to history. Total: ${this.conversationHistory.length} messages`);

                // Maintain the incremental compactedSummary + rawTurns
                // pair used by `trim_and_summary` mode. Once raw turns
                // grow past `rawTurnsKept * 2`, fold the overflow into
                // the running summary via the configured compaction
                // template (`${existingSummary}` + `${lastTurn}`).
                if (effectiveHistoryMode === 'trim_and_summary') {
                    this.rawTurns.push({ role: 'user', content: prompt });
                    this.rawTurns.push({ role: 'assistant', content: cleaned });
                    const cap = Math.max(0, eCaps.rawTurnsKept) * 2;
                    if (this.rawTurns.length > cap) {
                        // Slice out what's about to be dropped so we
                        // can fold it into the running summary before
                        // trimming. `cap === 0` is a legitimate setting
                        // ("rely entirely on `compactedSummary`"); in
                        // that case every just-pushed message becomes
                        // overflow and `rawTurns` ends up empty.
                        const overflow = cap === 0
                            ? this.rawTurns.slice()
                            : this.rawTurns.slice(0, this.rawTurns.length - cap);
                        // Shared trim helper — keeps seed/push/compaction
                        // identical (mirrors AnthropicHandler).
                        this.trimRawTurns(eCaps.rawTurnsKept);
                        // Fire and forget — failure to fold leaves the
                        // raw turns trimmed but the summary stale, which
                        // self-heals on the next turn.
                        void this.foldOverflowIntoSummary(overflow, mc, eCaps);
                    }
                }

                // Persist the per-profile snapshot to disk so the
                // history survives a window reload — matches the
                // Anthropic handler's behaviour. The Anthropic panel
                // uses the canonical `history.{json,md}`; LocalLLM
                // profiles use their own `history-<historySuffix>.{json,md}`
                // when `historySuffix` is set, otherwise share the
                // canonical pair.
                this.persistSessionHistory(questForHistory, historySuffix);
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
            // Close the live-trail block with a visible ERROR marker
            // so the user sees in the file *why* the trail stopped
            // mid-stream. No-op when the writer was never initialised
            // (reachability check failed before assignment).
            const message = err?.message ?? String(err);
            liveTrail?.endPromptWithError(message);
            return {
                success: false,
                result: '',
                rawResponse: '',
                response: '',
                thinkTagContent: '',
                profile: effectiveProfileKey,
                modelConfig: resolvedModelKey,
                error: message,
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
            undefined,
            undefined,
            // Programmatic bridge/scripting send — does not advance the Quest
            // Refresh counter nor trigger an auto-refresh.
            true,
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
            if (!data.localLlm) { data.localLlm = {}; }

            // Update the default model config entry, or create one
            if (defaultModelKey && data.localLlm.models?.[defaultModelKey]) {
                data.localLlm.models[defaultModelKey].model = picked.modelName;
            } else if (data.localLlm.models && Object.keys(data.localLlm.models).length > 0) {
                // Find the default one
                const key = Object.entries(data.localLlm.models as Record<string, any>)
                    .find(([_, v]) => v.isDefault)?.[0]
                    ?? Object.keys(data.localLlm.models)[0];
                data.localLlm.models[key].model = picked.modelName;
            } else {
                // Also update top-level fallback
                data.localLlm.model = picked.modelName;
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
            if (!data.localLlm) { data.localLlm = {}; }
            if (!data.localLlm[section]) { data.localLlm[section] = {}; }
            data.localLlm[section][key] = value;
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
            if (data.localLlm?.[section]?.[key]) {
                delete data.localLlm[section][key];
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
            // Check the endpoint is reachable (apiStyle-aware)
            const running = await this.isOllamaRunning(mc.ollamaUrl, mc.apiStyle);
            if (!running) {
                const isOpenAi = mc.apiStyle === 'openai';
                const label = isOpenAi ? 'OpenAI-compatible endpoint' : 'Ollama';
                if (isOpenAi) {
                    await vscode.window.showErrorMessage(`${label} is not reachable at ${mc.ollamaUrl} (probed GET /v1/models).`);
                } else {
                    const action = await vscode.window.showErrorMessage(
                        `Ollama is not running at ${mc.ollamaUrl}. Start it with: brew services start ollama`,
                        'Copy Command',
                    );
                    if (action === 'Copy Command') {
                        await vscode.env.clipboard.writeText('brew services start ollama');
                    }
                }
                return;
            }

            // Check if model is loaded — if not, pre-load with distinct progress.
            // OpenAI-style endpoints don't expose a residency endpoint, so the
            // check degrades to "model is listed in /v1/models" — true once the
            // server is up, which makes the pre-load step a no-op there.
            const modelLoaded = await this.isModelLoaded(mc.ollamaUrl, mc.model, mc.apiStyle);
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
                                undefined, mc.apiStyle, mc.apiKeyEnv,
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
let _manager: LocalLlmManager | undefined;

export function setLocalLlmManager(mgr: LocalLlmManager): void {
    _manager = mgr;
    bridgeLog(`[LocalLlmManager] singleton set (instance=${!!mgr})`, 'INFO');
}

export function getLocalLlmManager(): LocalLlmManager | undefined {
    return _manager;
}

/**
 * Get or lazily create the LocalLlmManager singleton.
 * Use this in webview handlers where the manager MUST be available,
 * even if activate() didn't finish setting up the singleton.
 */
export function ensureLocalLlmManager(context: vscode.ExtensionContext): LocalLlmManager {
    if (!_manager) {
        bridgeLog('[LocalLlmManager] Auto-creating manager (singleton was null during ensureLocalLlmManager)', 'INFO');
        _manager = new LocalLlmManager(context);
    }
    return _manager;
}

/**
 * Command handler for `tomAi.sendToLocalLlm`.
 * Delegates to the global LocalLlmManager.
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
