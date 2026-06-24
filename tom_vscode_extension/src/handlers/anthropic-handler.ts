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
import { ANTHROPIC_SUBSYSTEM } from '../services/trailSubsystems';
import { ToolTrail, setActiveToolTrail, type ToolTrailEntry } from '../services/tool-trail';
import { LiveTrailWriter, type PromptSource } from '../services/live-trail';
import { QuestRefreshStore } from '../managers/questRefreshStore';
import { QuestRefreshService } from '../services/quest-refresh-service';
import { classifyAnthropicError, Interruption } from '../utils/anthropicErrorClassifier';
import { withRetryBudget } from '../utils/retryWithBudget';
import { runWithToolContext } from '../services/tool-execution-context';
import {
    compactHistory,
    ConversationMessage,
    HistoryMode,
} from '../services/history-compaction';
import { TwoTierMemoryService } from '../services/memory-service';
import {
    clearCompactionRounds,
    loadCompactionRounds,
    rawTurnsToRounds,
    roundsToRawTurns,
    saveCompactionRounds,
} from '../services/compaction-rounds';
import {
    type Block,
    concatenateBodies,
    dedupAndSort,
    diffAndStamp,
    loadFromDisk as loadBlocksFromDisk,
    parseBlocks,
    renderBlocksForLlm,
    saveToDisk as saveBlocksToDisk,
} from '../services/compacted-history';
import {
    load as loadRawTurns,
    save as saveRawTurns,
    pushAndCap as pushRawTurnAndCap,
} from '../services/raw-turns-store';
import { TomAiConfiguration } from '../utils/tomAiConfiguration';
import { runAgentSdkQuery, selectTransportRetryTemplateBody, DEFAULT_INTERACTIVE_QUESTIONS_TEMPLATE } from './agent-sdk-transport';
import * as anthropicOutput from './anthropic-output-channels';
import { WsPaths } from '../utils/workspacePaths';
import { resolveVariables } from '../utils/variableResolver';
import { debugLog } from '../utils/debugLogger';
import { logInfo as logHistoryInfo, logError as logHistoryError } from '../services/compaction-log';

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
/**
 * `localLlm` is a **runtime-synthesised** transport used only when an
 * Anthropic profile's configurationId resolves to an entry in
 * `config.localLlm.configurations[]` (see spec §4.3). The caller
 * (queue dispatcher / chat panel) fabricates an AnthropicConfiguration
 * with `transport: 'localLlm'` and the `localLlm` fields populated, so
 * the handler can dispatch uniformly. It is never written to disk.
 */
export type AnthropicTransport = 'direct' | 'agentSdk' | 'vscodeLm' | 'localLlm';

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
    /**
     * VS Code LM options; applies when `transport === 'vscodeLm'`. Model
     * identity pinned at configure-time via the status-page picker (see
     * multi_transport_prompt_queue_revised.md §4.2). Sends filter the
     * cached `selectChatModels()` list by this tuple rather than
     * re-enumerating providers.
     */
    vscodeLm?: {
        vendor: string;
        family: string;
        modelId: string;
    };
    /**
     * Synthesised payload for the `'localLlm'` transport — see spec §4.3.
     * Never persisted to disk; populated by the dispatcher when the
     * Anthropic profile's configurationId resolves to a Local LLM entry.
     */
    localLlm?: {
        baseUrl: string;
        model: string;
        temperature: number;
        keepAlive?: string;
        /** Backend protocol; `'ollama'` (default) or `'openai'` for vLLM-like endpoints. */
        apiStyle?: 'ollama' | 'openai';
        /**
         * Name of the env var holding the bearer API key for this endpoint.
         * When set (and non-empty), requests carry `Authorization: Bearer …`.
         */
        apiKeyEnv?: string;
        /**
         * Master switch for tool use through this Local-LLM-backed Anthropic
         * profile. When `false`, the dispatcher never sends a `tools` array
         * to the backend regardless of profile-level tool settings. This is
         * the right setting for vLLM / LM Studio / llama.cpp servers that
         * were launched without `--enable-auto-tool-choice` and a
         * `--tool-call-parser`; they reject any request that includes
         * `tools` otherwise. Defaults to `true`.
         */
        toolsEnabled?: boolean;
    };
    /**
     * Per-configuration override for the global `compaction.disabled` flag.
     *   'default' / undefined — use the status-page checkbox (global).
     *   'on'                   — force compaction ON for this configuration,
     *                            even when the global flag disables it.
     *   'off'                  — force compaction OFF for this configuration,
     *                            even when the global flag enables it.
     */
    compactionOverride?: 'default' | 'on' | 'off';
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
    /**
     * Max response tokens override. When set (and > 0), overrides
     * `AnthropicConfiguration.maxTokens` for this profile. Useful when
     * the same backend configuration is shared across personas with
     * different verbosity needs.
     */
    maxTokens?: number;
    /**
     * Maximum total wait time (in minutes) for the retry-on-busy loop.
     * Applies uniformly to all backends (Anthropic direct SDK, Ollama,
     * OpenAI/vLLM). The retry loop uses exponential backoff capped at
     * 5 minutes and keeps retrying transient errors (429 / 503 / 529 /
     * "rate limit" / "overloaded" / "service unavailable") until the
     * cumulative elapsed time since the first failure exceeds this
     * budget. Defaults to 10 minutes when unset. Set to 240 (4 hours)
     * on profiles you expect to survive Claude session-limit resets.
     */
    retryMaxTotalWaitMinutes?: number;
    isDefault?: boolean;
    /** Extended thinking — sends `thinking: { type: 'enabled', budget_tokens }`. */
    thinkingEnabled?: boolean;
    /** Budget in tokens for extended thinking. Default 8192 when `thinkingEnabled`. */
    thinkingBudgetTokens?: number;
    /** Prompt caching — overrides configuration.promptCachingEnabled. Default true at profile level. */
    promptCachingEnabled?: boolean;
    /**
     * Approval gate for write tool calls. `always` shows the approval bar
     * for every write call (the user can elevate that single call to a
     * session-wide allow by clicking "Allow All (session)" at the bar).
     * `never` skips the gate entirely. Defaults to `always`. Lives on the
     * profile (persona + behavior), not the configuration (API capacity).
     */
    toolApprovalMode?: 'always' | 'never';
    /**
     * Agent SDK path only — enable the built-in Claude Code tool preset
     * (Read, Write, Edit, Glob, Grep, Bash, WebFetch, etc.) and suppress
     * extension tools that would duplicate them. Has no effect on the
     * direct Anthropic SDK path.
     */
    useBuiltInTools?: boolean;
    /**
     * Agent SDK path only — when the agent invokes the built-in
     * `AskUserQuestion` tool, prompt the user with a VS Code QuickPick per
     * question and feed the selections back as the tool result. Default
     * `false`: the questions are answered with the fallback template
     * (`interactiveQuestionsTemplateId`), telling the agent to proceed
     * autonomously. Requires `useBuiltInTools` and has no effect when
     * `toolApprovalMode === 'never'` (canUseTool isn't fired under
     * bypassPermissions).
     */
    allowInteractiveQuestions?: boolean;
    /** Selected fallback template id from `anthropic.interactiveQuestionsTemplates`. Empty = built-in default. */
    interactiveQuestionsTemplateId?: string;
    /**
     * When true, append a `${memory}` block to the resolved system prompt
     * automatically, so the user doesn't have to add the placeholder by
     * hand. Default `false` — memory is only included when the profile's
     * `systemPrompt` / `userPromptWrapper` / `userMessageTemplate`
     * explicitly references `${memory}` / `${memory-shared}` / `${memory-quest}`.
     *
     * Note: file-injection placeholders (`${role-description}` /
     * `${quest-description}`) recursively expand any `${memory*}` tokens
     * that happen to appear inside the injected file. Set this to `false`
     * AND audit those files if you want zero memory in the prompt.
     */
    autoInjectMemory?: boolean;
    /**
     * Profile-level wrapper applied *after* the `userMessageTemplate`
     * has expanded. Meant for "system-like" injections the profile wants
     * to attach at the user-prompt layer so the system prompt itself can
     * stay byte-identical across turns (better for prompt caching).
     *
     * Must contain `${wrappedPrompt}` where the user-message-template
     * result should be inlined. Leave empty to skip this wrapping stage.
     *
     * Expansion order on every send:
     *   1. raw user text
     *   2. userMessageTemplate wraps it (via `${userMessage}`) → `wrappedPrompt`
     *   3. profile.userPromptWrapper wraps *that* (via `${wrappedPrompt}`) → final
     */
    userPromptWrapper?: string;
}

interface AnthropicSection {
    apiKeyEnvVar?: string;
    configurations?: AnthropicConfiguration[];
    profiles?: AnthropicProfile[];
    /** Agent SDK transport retry settings (spec §18, "Anthropic Transport Retry"). */
    transportRetry?: {
        maxAttempts?: number;
        templateId?: string;
        templates?: Array<{ id: string; name: string; description?: string; template: string }>;
    };
    /** Fallback templates for the Agent SDK built-in `AskUserQuestion` tool (spec §18, "Anthropic Interactive Questions"). */
    interactiveQuestionsTemplates?: Array<{ id: string; name: string; description?: string; template: string }>;
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
    /**
     * Agent SDK continuity bucket. The SDK session id is persisted to
     * `<sessionKey>.session.json` in the quest's history folder and resumed
     * from there on the next send with the same key. Keeping each entry
     * point on its own key prevents the chat panel and the prompt queue
     * from sharing — or clobbering — one another's session. Defaults to
     * `DEFAULT_AGENT_SDK_SESSION_KEY` (the prompt queue's bucket). Only
     * meaningful for the agentSdk transport in `historyMode: 'sdk-managed'`.
     */
    sessionKey?: string;
    /**
     * Quest Refresh exemption. When `true`, this send does not count toward the
     * Quest Refresh interval and never triggers an auto-refresh. Set on the
     * refresh prompt itself (so it can't recurse) and on any internal /
     * follow-up send that shouldn't advance the user-prompt counter.
     */
    skipQuestRefresh?: boolean;
    /**
     * Originator of this send — `'queue'` for prompt-queue dispatch, `'chat'`
     * for direct sends (panel Send, Send-to-Chat, Telegram `send_prompt`).
     * Threaded onto the live-trail writer so observers (e.g. the Telegram
     * forwarder) can attribute the run to its source. Defaults to `'chat'`.
     */
    source?: PromptSource;
}

/** Prompt-queue Agent SDK session bucket → `default.session.json`. */
export const DEFAULT_AGENT_SDK_SESSION_KEY = 'default';
/** Anthropic chat-panel Agent SDK session bucket → `chat.session.json`. */
export const ANTHROPIC_CHAT_SESSION_KEY = 'chat';


/**
 * Build the full-payload markdown dump (system + tools + rolling history +
 * current user message) written alongside the `.userprompt.md` file. Rolling
 * history entries are summarized (role + char count + first ~200 chars) so
 * the file stays compact on long sessions while still letting you see what
 * shape of history went out — the per-turn raw trail already has the full
 * text for each exchange, and the request ids correlate.
 */
// Pure payload / parameter helpers live in `../services/anthropicPayload.ts`.
// `temperatureField` is re-exported here because external callers (tests,
// trail utilities) import it from this module by name.
import { buildPayloadDump, temperatureField, isConversationMessage, resolveEffectiveHistoryMode } from '../services/anthropicPayload';
export { temperatureField };

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

// `isConversationMessage` lives in `../services/anthropicPayload.ts`
// (imported at the top of the file alongside buildPayloadDump /
// temperatureField).

/**
 * Shared leaf-catch tail: classify the thrown error, write the right
 * live-trail marker (`endPromptWithInterruption` for rate-limit / quota
 * / overload / cancellation / mid-stream interruption; `endPromptWithError`
 * for everything else), and stamp classification metadata onto the thrown
 * value so the outer queue/chat layer can decorate its UI without having
 * to re-classify. The err is rethrown unchanged by the caller.
 */
function closeLiveTrailForThrown(liveTrail: LiveTrailWriter | null | undefined, err: unknown, rawMessage: string): Interruption | null {
    const classified = classifyAnthropicError(err);
    if (classified) {
        liveTrail?.endPromptWithInterruption(classified.kind, classified.message);
        try {
            // Stash on the error object so the queue layer can read it
            // without re-running the classifier on a possibly-mutated
            // stack. Non-enumerable so it doesn't leak into JSON dumps
            // of the error body.
            Object.defineProperty(err as object, '__tomAnthropicInterruption', {
                value: classified,
                enumerable: false,
                configurable: true,
            });
        } catch { /* best-effort */ }
    } else {
        liveTrail?.endPromptWithError(rawMessage);
    }
    return classified;
}

/**
 * Read a previously-stamped Interruption off a thrown error. Returns
 * `null` when the error was not one of the classified kinds.
 */
export function getAttachedInterruption(err: unknown): Interruption | null {
    if (!err || typeof err !== 'object') { return null; }
    const attached = (err as { __tomAnthropicInterruption?: unknown }).__tomAnthropicInterruption;
    if (attached && typeof attached === 'object' && 'kind' in attached && 'message' in attached) {
        return attached as Interruption;
    }
    return null;
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
     * Session history is split into three parallel stores:
     *
     *   - `compactedHistoryBlocks` — block-formatted distilled state
     *     persisted at `_ai/quests/<quest>/history/compacted_history.md`.
     *     Each block carries a `created` stamp (identity) and a
     *     `modified` stamp (freshness for merge). Replaces the old
     *     single-string `compactedSummary` so two machines can compact
     *     concurrently and the union-by-created merge keeps the freshest
     *     version of each block.
     *   - `compactionRounds` — the per-machine accumulator. Holds
     *     rounds that have happened since the last successful
     *     compaction; CLEARS entirely when compaction succeeds. Stored
     *     at `_ai/quests/<quest>/history/compaction_rounds.json`
     *     (gitignored). Drives the every-N-rounds compaction trigger.
     *   - `rawTurnsRolling` — the rolling tail of the last N rounds,
     *     stored at `_ai/quests/<quest>/history/rawTurns.json`
     *     (gitignored). Capped at `rawTurnsKept`; never clears, just
     *     rotates. Survives a compaction pass so the next outgoing
     *     prompt always has fresh complete-fidelity context, even
     *     immediately after the accumulator was just cleared.
     *
     * `rawTurns` (the flattened legacy field) is now derived: it is the
     * deduped union of `rawTurnsRolling` ∪ `compactionRounds` flattened
     * back into `[user, assistant, user, assistant, …]` form. It is
     * still what the outgoing wire-payload reads, so existing call
     * sites keep working — but the source of truth is now the two
     * round-shaped arrays.
     */
    private compactedHistoryBlocks: Block[] = [];
    private compactionRounds: ConversationMessage[][] = [];
    private rawTurnsRolling: ConversationMessage[][] = [];
    private rawTurns: ConversationMessage[] = [];

    /**
     * The most-recent non-empty assistant text the model produced —
     * updated per round (so it tracks the latest answer even mid-turn,
     * between tool rounds) and again at `finalize`. Exposed via
     * {@link lastAssistantText} so the prompt queue's manual-continue
     * path can capture "the answer the LLM gave but that wasn't
     * detected as the final answer" when the user aborts an in-flight
     * send. Not session-scoped — it reflects the latest send across all
     * transports; consumers read it right after cancelling a dispatch.
     */
    private _lastAssistantText = '';

    /**
     * Concatenated bodies of `compactedHistoryBlocks` — what the
     * outgoing-message build injects as the "Additional context"
     * synthetic pair. Empty string when no blocks. Computing on read
     * (rather than caching) is fine: blocks rarely exceed a few KB
     * and the join is O(n).
     */
    private get compactedSummaryText(): string {
        return concatenateBodies(this.compactedHistoryBlocks);
    }
    /**
     * Live-trail writers are **per-`sendMessage` call**, not a field on the
     * singleton. The top of `sendMessage` creates a local `liveTrail` and
     * threads it through to `sendViaVsCodeLm`, `sendViaLocalLlm`,
     * `runTool`, and `finalize`. Isolated sub-agent calls pass `null` so
     * their intermediate work doesn't hit the parent turn's trail file.
     *
     * Why not a field: sub-agent calls and concurrent sends (chat panel +
     * queue dispatch on the same singleton) used to stomp a shared field,
     * leaving the outer turn's writes silently no-op'd — the classic
     * "live-trail disconnect" symptom.
     */
    private historySeeded = false;

    /**
     * Fire-and-forget in-flight work from a just-completed turn. The next
     * `sendMessage()` awaits these so the user's next prompt goes out with
     * the freshest compaction/memory state — and emits a status update so
     * the chat panel can show "waiting for history compaction…" /
     * "waiting for memory extraction…" / "Rebuild history from last N
     * prompts…" instead of a bare "Sending…".
     */
    private compactionInFlight: Promise<void> | null = null;
    private memoryExtractionInFlight: Promise<void> | null = null;
    private historyRebuildInFlight: Promise<void> | null = null;

    private readonly _onApprovalNeeded = new vscode.EventEmitter<AnthropicToolApprovalRequest>();
    /**
     * Fired when a `requiresApproval` tool is about to run. Phase 4 wires
     * the chat panel to this event; the panel must call
     * `handleApprovalResponse()` with the same `toolUseId` once the user
     * decides.
     */
    readonly onApprovalNeeded: vscode.Event<AnthropicToolApprovalRequest> = this._onApprovalNeeded.event;

    private readonly _onStatusUpdate = new vscode.EventEmitter<string>();
    /**
     * Fired while the handler is doing preparatory work before a send
     * (awaiting a compaction pass, awaiting memory extraction, awaiting a
     * trail-based history rebuild). Text is UI-ready ("waiting for
     * history compaction…"), no prefix needed.
     */
    readonly onStatusUpdate: vscode.Event<string> = this._onStatusUpdate.event;

    static init(context: vscode.ExtensionContext): AnthropicHandler {
        if (!AnthropicHandler._instance) {
            AnthropicHandler._instance = new AnthropicHandler();
            context.subscriptions.push({
                dispose: () => {
                    AnthropicHandler._instance?._onApprovalNeeded.dispose();
                    AnthropicHandler._instance?._onStatusUpdate.dispose();
                },
            });
        }
        return AnthropicHandler._instance;
    }

    static get instance(): AnthropicHandler {
        if (!AnthropicHandler._instance) {
            AnthropicHandler._instance = new AnthropicHandler();
        }
        return AnthropicHandler._instance;
    }

    /**
     * The most-recent non-empty assistant text the model produced. See
     * {@link _lastAssistantText}. Empty string until the first send
     * yields text.
     */
    get lastAssistantText(): string {
        return this._lastAssistantText;
    }

    /** Record the latest non-empty assistant text. No-op for blank text. */
    private rememberAssistantText(text: string | undefined): void {
        if (text && text.trim().length > 0) {
            this._lastAssistantText = text;
        }
    }

    private constructor() {
        this.toolTrail = new ToolTrail();
        // Register this handler's ToolTrail as the session-wide active
        // one so the `tomAi_listPastToolCalls` / `searchPastToolResults`
        // / `readPastToolResult` tools can reach it without a circular
        // import on the handler module.
        setActiveToolTrail(this.toolTrail);
        // Persist every tool result to disk under the per-quest store so
        // older entries — replaced inline with a stub once the round drops
        // out of `toolTrailKeepRounds` — remain readable via
        // `tomAi_readPastToolResult`. Import lazily to avoid cycles.
        this.toolTrail.setPersistHook((entry) => {
            try {
                // eslint-disable-next-line @typescript-eslint/no-var-requires
                const { writeToolResult } = require('../services/tool-result-store');
                writeToolResult('anthropic', entry, WsPaths.getWorkspaceQuestId());
            } catch {
                // best-effort — disk persistence is not on the critical path
            }
        });
        // Eager init per spec §17 Step 1.8; falls back to lazy creation in
        // `getClient()` if the env var was unset at activation time.
        try {
            this.getClient();
        } catch {
            // ignore — getClient already returns undefined when env var missing
        }
    }

    /**
     * Clear all in-session state (blocks, rolling tail, accumulator, tool
     * trail, session-mode approvals, persisted SDK session id).
     *
     * `sessionKey` selects which Agent SDK session file to drop — the chat
     * panel clears its own `chat.session.json`, leaving the prompt queue's
     * `default.session.json` untouched. Defaults to the prompt-queue bucket.
     */
    clearSession(sessionKey: string = DEFAULT_AGENT_SDK_SESSION_KEY): void {
        this.compactedHistoryBlocks = [];
        this.compactionRounds = [];
        this.rawTurnsRolling = [];
        this.rawTurns = [];
        this.historySeeded = true; // an explicit clear should not reload a prior snapshot
        this.toolTrail.clear();
        this.sessionApprovals.clear();
        this.roundCounter = 0;
        this.compactionInFlight = null;
        this.memoryExtractionInFlight = null;
        this.historyRebuildInFlight = null;
        // Drop the Agent SDK session-id file so the next sdk-managed
        // send starts a brand-new conversation rather than resuming the
        // one we just cleared.
        try {
            const quest = TwoTierMemoryService.instance.currentQuest();
            TwoTierMemoryService.instance.clearAgentSdkSessionId(quest, sessionKey);
            // Also drop the uncompacted-rounds accumulator + rolling
            // tail so the next turn starts from a clean slate. Both
            // files are per-machine (gitignored).
            clearCompactionRounds(quest);
            const historyFolder = TwoTierMemoryService.instance.historyFolder(quest);
            saveRawTurns(historyFolder, []);
            // Also wipe the compacted blocks on disk so a fresh session
            // doesn't inherit yesterday's distilled state.
            saveBlocksToDisk(historyFolder, []);
        } catch { /* best-effort */ }
    }

    /**
     * Push the last round into the accumulator and rolling-tail files
     * and reload the deduped union into `this.rawTurns`. Called from
     * the post-send append path on every transport.
     *
     * Why both files: the accumulator drives the every-N-rounds
     * compaction trigger (clears on success); the rolling tail
     * survives compaction so the very next outgoing payload still
     * has fresh complete-fidelity context. See the field declaration
     * above for the full picture.
     */
    private persistRoundAndReloadUnion(
        round: ConversationMessage[],
        questId: string | undefined,
        rawTurnsKept: number,
    ): void {
        try {
            const historyFolder = TwoTierMemoryService.instance.historyFolder(questId);
            // Accumulator: append every round; cap-free (cleared on compaction success).
            this.compactionRounds = [...this.compactionRounds, round];
            saveCompactionRounds(this.compactionRounds, questId);
            // Rolling tail: push + cap so the file stays bounded.
            this.rawTurnsRolling = pushRawTurnAndCap(historyFolder, round, rawTurnsKept);
            // Recompute the in-memory union — what the API call reads.
            this.rawTurns = this.computeDedupedUnion();
        } catch {
            // best-effort — the in-memory state is the source of truth for the
            // current turn; on-disk failures recover on the next persistence call.
        }
    }

    /**
     * Deduped union of `rawTurnsRolling` ∪ `compactionRounds`, flattened
     * into the contiguous `[user, assistant, …]` shape the wire payload
     * builder consumes.
     *
     * Compaction rounds is a superset most of the time (it doesn't cap),
     * so we start from it and merge in any rolling-tail rounds whose
     * content isn't already present. Identity comparison is by
     * stringified content per round — exact-byte match — which is
     * adequate because each round originates from a single send and
     * isn't independently mutated.
     */
    private computeDedupedUnion(): ConversationMessage[] {
        const seen = new Set<string>();
        const keyOf = (round: ConversationMessage[]): string =>
            round.map((m) => `${m.role}|${m.content}`).join('\n');
        const out: ConversationMessage[][] = [];
        for (const round of this.compactionRounds) {
            const key = keyOf(round);
            if (seen.has(key)) { continue; }
            seen.add(key);
            out.push(round);
        }
        for (const round of this.rawTurnsRolling) {
            const key = keyOf(round);
            if (seen.has(key)) { continue; }
            seen.add(key);
            out.push(round);
        }
        return roundsToRawTurns(out);
    }

    /**
     * Seed the split state from disk on the first `sendMessage()`.
     *
     * Three-step fallback (most preferred first):
     *
     *   1. **`compacted_history.md`** — the new block-format file
     *      committed to git. When present, parses into
     *      `this.compactedHistoryBlocks` and the rolling tail / accumulator
     *      come from the per-machine files alongside.
     *   2. **`history.json` one-shot migration** — the legacy file. Its
     *      `compactedSummary` string is wrapped in a single synthetic
     *      block (`created = modified = savedAt`); its `rawTurns` seed
     *      the rolling tail when no separate `rawTurns.json` exists.
     *      The legacy file is left in place — the formal migration
     *      command (`tomAi.migrate.compactionFormat`) does the cleanup.
     *   3. **Trail rebuild** — fire-and-forget walk of the quest's
     *      `.anthropic.prompts.md` / `.answers.md` files into chunked
     *      compaction passes. Same path as before; just writes blocks
     *      instead of a summary string.
     *
     * The per-machine files (`rawTurns.json`, `compaction_rounds.json`)
     * are loaded regardless of which fallback wins.
     */
    private seedHistoryFromSnapshot(questId: string): void {
        if (this.historySeeded) {
            return;
        }
        this.historySeeded = true;
        try {
            const historyFolder = TwoTierMemoryService.instance.historyFolder(questId);

            // (1) Try the new block-format file first.
            const blocks = loadBlocksFromDisk(historyFolder);
            let seededFromDisk = false;
            if (blocks.length > 0) {
                this.compactedHistoryBlocks = dedupAndSort(blocks);
                seededFromDisk = true;
            } else {
                // (2) Fall back to history.json with one-shot in-memory
                //     migration. The legacy file stays on disk; the
                //     formal migration command rewrites it.
                const raw = TwoTierMemoryService.instance.loadLatestHistorySnapshot<unknown>(questId);
                if (raw && typeof raw === 'object' && !Array.isArray(raw)) {
                    const obj = raw as { compactedSummary?: unknown; rawTurns?: unknown; savedAt?: unknown };
                    if (typeof obj.compactedSummary === 'string' && obj.compactedSummary.trim().length > 0) {
                        const savedAt = typeof obj.savedAt === 'string' && obj.savedAt.length > 0
                            ? obj.savedAt
                            : new Date().toISOString();
                        this.compactedHistoryBlocks = [{
                            created: savedAt,
                            modified: savedAt,
                            body: obj.compactedSummary.trim(),
                        }];
                        seededFromDisk = true;
                    }
                    if (Array.isArray(obj.rawTurns)) {
                        // Use legacy rawTurns only when the per-machine rolling
                        // tail is missing — the file under our control takes
                        // precedence.
                        const rolling = loadRawTurns(historyFolder);
                        if (!rolling || rolling.rounds.length === 0) {
                            const flat = obj.rawTurns.filter(isConversationMessage);
                            this.rawTurnsRolling = rawTurnsToRounds(flat);
                        }
                    }
                }
            }

            // Per-machine state — always load (independent of which
            // compaction source seeded the blocks).
            if (this.rawTurnsRolling.length === 0) {
                const rolling = loadRawTurns(historyFolder);
                if (rolling) { this.rawTurnsRolling = rolling.rounds; }
            }
            const accumulator = loadCompactionRounds(questId);
            if (accumulator) { this.compactionRounds = accumulator.rounds; }
            this.rawTurns = this.computeDedupedUnion();

            if (seededFromDisk) {
                logHistoryInfo(`history seed: restored from disk (quest=${questId}, blocks=${this.compactedHistoryBlocks.length}, rawRounds=${this.rawTurnsRolling.length})`);
                return;
            }

            // When compaction is disabled, the automatic trail rebuild is off
            // entirely: skip it so no "Rebuild history…" status fires and no
            // LLM/Ollama calls happen on a fresh session. Raw turns still
            // accumulate normally on subsequent sends (the live path keeps
            // writing them), so context is not lost — it just isn't folded.
            if (this.getCompactionConfig().disabled) {
                logHistoryInfo(`history seed: no disk state and compaction disabled — automatic trail rebuild skipped (quest=${questId})`);
                return;
            }

            // (3) No disk state at all — kick off the trail rebuild as
            //     fire-and-forget. Subsequent sends await
            //     historyRebuildInFlight with a status update.
            logHistoryInfo(`history seed: no disk state — kicking off trail rebuild (quest=${questId})`);
            this.historyRebuildInFlight = this.rebuildHistoryFromTrail(questId)
                .finally(() => { this.historyRebuildInFlight = null; });
        } catch {
            // ignore — fresh session is a safe fallback
        }
    }

    /**
     * Returns a shallow, flattened view of the current session for
     * diagnostics / test callers. `getHistory()` predates the
     * compacted-summary + raw-tail split; it now returns the raw turns
     * only so existing callers (dry-run, etc.) keep working without
     * accidentally seeing the synthetic summary pair we inject at send
     * time. Use `getSessionState()` to read both fields.
     */
    getHistory(): ConversationMessage[] {
        return [...this.rawTurns];
    }

    /** New accessor: read both fields together for diagnostics. */
    getSessionState(): { compactedSummary: string; rawTurns: ConversationMessage[]; compactedHistoryBlocks: Block[] } {
        return {
            compactedSummary: this.compactedSummaryText,
            rawTurns: [...this.rawTurns],
            compactedHistoryBlocks: this.compactedHistoryBlocks.map((b) => ({ ...b })),
        };
    }

    /**
     * Await any in-flight compaction / memory extraction / history
     * rebuild before sending the next message, emitting status updates
     * so the chat panel can show what the delay is. Called at the top of
     * every sendMessage().
     */
    private async awaitInFlightBackgroundWork(): Promise<void> {
        if (this.historyRebuildInFlight) {
            this._onStatusUpdate.fire('Rebuild history from last N prompts…');
            try { await this.historyRebuildInFlight; } catch { /* swallowed */ }
        }
        if (this.compactionInFlight) {
            this._onStatusUpdate.fire('waiting for history compaction…');
            try { await this.compactionInFlight; } catch { /* swallowed */ }
        }
        if (this.memoryExtractionInFlight) {
            this._onStatusUpdate.fire('waiting for memory extraction…');
            try { await this.memoryExtractionInFlight; } catch { /* swallowed */ }
        }
    }

    /**
     * Persist the compacted blocks to `compacted_history.md`. Each
     * compaction success writes here so the on-disk view matches the
     * in-memory `compactedHistoryBlocks`.
     *
     * `rawTurns.json` and `compaction_rounds.json` are written
     * independently by `persistRoundAndReloadUnion` / the compaction
     * pass; this method only owns the block-format file.
     *
     * The legacy `history.json` / `history.md` pair is also rewritten
     * (via `persistHistorySnapshot`) so the chat panel's "Open session
     * history" button still works without a custom block-format
     * renderer — and so a pre-migration machine can read what a
     * migrated machine produced. The migration command deletes the
     * legacy files; until then both formats live side-by-side.
     */
    private persistSessionHistory(questId: string | undefined): void {
        try {
            const archive = this.getCompactionConfig().archiveHistoryEveryTurn;
            const historyFolder = TwoTierMemoryService.instance.historyFolder(questId);
            saveBlocksToDisk(historyFolder, this.compactedHistoryBlocks);
            // Keep the legacy file populated for the readability/MD-Browser path.
            // The migration command removes it; pre-migration installs still need it.
            TwoTierMemoryService.instance.persistHistorySnapshot(
                { compactedSummary: this.compactedSummaryText, rawTurns: this.rawTurns },
                questId,
                archive,
            );
        } catch {
            // best-effort — a failed save must never affect the turn result
        }
    }

    /**
     * Read the compaction config section from TomAiConfiguration. Centralised
     * so the same defaults apply everywhere (sendMessage, background
     * compaction, background memory extraction).
     */
    private getCompactionConfig(): {
        disabled: boolean;
        llmProvider: 'localLlm' | 'anthropic';
        llmConfigId: string;
        compactionTemplateId?: string;
        memoryExtractionTemplateId?: string;
        compactionMaxRounds: number;
        maxHistoryTokens: number;
        historyMaxChars: number;
        memoryMaxChars: number;
        rawTurnsKept: number;
        runEveryNRounds: number;
        toolTrailMaxResultChars: number;
        toolTrailKeepRounds: number;
        fullTrailMaxTurns: number;
        runMemoryExtractionOnCompaction: boolean;
        rebuildFromLastNPrompts: number;
        archiveHistoryEveryTurn: boolean;
    } {
        const section = TomAiConfiguration.instance.getSection<{
            disabled?: boolean;
            llmProvider?: 'localLlm' | 'anthropic';
            llmConfigId?: string;
            compactionTemplateId?: string;
            memoryExtractionTemplateId?: string;
            compactionMaxRounds?: number;
            maxHistoryTokens?: number;
            historyMaxChars?: number;
            memoryMaxChars?: number;
            rawTurnsKept?: number;
            runEveryNRounds?: number;
            toolTrailMaxResultChars?: number;
            toolTrailKeepRounds?: number;
            fullTrailMaxTurns?: number;
            runMemoryExtractionOnCompaction?: boolean;
            rebuildFromLastNPrompts?: number;
            archiveHistoryEveryTurn?: boolean;
        }>('compaction') ?? {};
        return {
            disabled: section.disabled === true,
            llmProvider: section.llmProvider === 'anthropic' ? 'anthropic' : 'localLlm',
            llmConfigId: section.llmConfigId ?? '',
            compactionTemplateId: section.compactionTemplateId,
            memoryExtractionTemplateId: section.memoryExtractionTemplateId,
            compactionMaxRounds: Number.isFinite(section.compactionMaxRounds) ? (section.compactionMaxRounds as number) : 4,
            maxHistoryTokens: Number.isFinite(section.maxHistoryTokens) ? (section.maxHistoryTokens as number) : 8000,
            historyMaxChars: Number.isFinite(section.historyMaxChars) ? (section.historyMaxChars as number) : 24000,
            memoryMaxChars: Number.isFinite(section.memoryMaxChars) ? (section.memoryMaxChars as number) : 8000,
            rawTurnsKept: Number.isFinite(section.rawTurnsKept) ? (section.rawTurnsKept as number) : 4,
            runEveryNRounds: Number.isFinite(section.runEveryNRounds) ? Math.max(1, section.runEveryNRounds as number) : 15,
            toolTrailMaxResultChars: Number.isFinite(section.toolTrailMaxResultChars) ? (section.toolTrailMaxResultChars as number) : 1000,
            toolTrailKeepRounds: Number.isFinite(section.toolTrailKeepRounds) ? (section.toolTrailKeepRounds as number) : 2,
            fullTrailMaxTurns: Number.isFinite(section.fullTrailMaxTurns) ? (section.fullTrailMaxTurns as number) : 200,
            runMemoryExtractionOnCompaction: section.runMemoryExtractionOnCompaction !== false,
            rebuildFromLastNPrompts: Number.isFinite(section.rebuildFromLastNPrompts) ? (section.rebuildFromLastNPrompts as number) : 200,
            archiveHistoryEveryTurn: section.archiveHistoryEveryTurn === true,
        };
    }

    /**
     * Resolve the effective tool-trail / history caps for a given
     * configuration. Per-configuration `historyMaxChars` / `memoryMaxChars`
     * / `rawTurnsKept` / `toolTrailMaxResultChars` / `toolTrailKeepRounds`
     * win over the compaction-section fallback so a single workspace can
     * tune different models (200k Opus vs 128k local) without forking the
     * whole compaction block.
     */
    private resolveEffectiveCaps(configuration: AnthropicConfiguration): {
        historyMaxChars: number;
        memoryMaxChars: number;
        rawTurnsKept: number;
        toolTrailMaxResultChars: number;
        toolTrailKeepRounds: number;
        maxHistoryTokens: number;
    } {
        const cfg = this.getCompactionConfig();
        const c = configuration as unknown as {
            historyMaxChars?: number;
            memoryMaxChars?: number;
            rawTurnsKept?: number;
            toolTrailMaxResultChars?: number;
            toolTrailKeepRounds?: number;
            maxHistoryTokens?: number;
        };
        return {
            historyMaxChars: Number.isFinite(c.historyMaxChars) ? (c.historyMaxChars as number) : cfg.historyMaxChars,
            memoryMaxChars: Number.isFinite(c.memoryMaxChars) ? (c.memoryMaxChars as number) : cfg.memoryMaxChars,
            rawTurnsKept: Number.isFinite(c.rawTurnsKept) ? (c.rawTurnsKept as number) : cfg.rawTurnsKept,
            toolTrailMaxResultChars: Number.isFinite(c.toolTrailMaxResultChars) ? (c.toolTrailMaxResultChars as number) : cfg.toolTrailMaxResultChars,
            toolTrailKeepRounds: Number.isFinite(c.toolTrailKeepRounds) ? (c.toolTrailKeepRounds as number) : cfg.toolTrailKeepRounds,
            maxHistoryTokens: Number.isFinite(c.maxHistoryTokens) ? (c.maxHistoryTokens as number) : cfg.maxHistoryTokens,
        };
    }

    /**
     * Walk back through `messages[]` and replace any tool_result block
     * older than `keepRounds` rounds with a short stub that names the
     * replay key. The pairing of tool_use / tool_result blocks is
     * preserved (Anthropic's API rejects unpaired blocks); only the
     * `content` of tool_result is shortened.
     *
     * Each `user` message in `messages[]` that contains tool_result blocks
     * corresponds to one round; we count those from the end and start
     * stubbing once the per-round counter exceeds `keepRounds`.
     */
    private applyToolTrailRetentionPolicy(
        messages: AnthropicMessageParam[],
        caps: { toolTrailKeepRounds: number; toolTrailMaxResultChars: number },
    ): void {
        const tt = this.toolTrail;
        tt.inlineMaxChars = Math.max(100, caps.toolTrailMaxResultChars);
        tt.keepRounds = Math.max(0, caps.toolTrailKeepRounds);

        // Walk newest-first, counting tool_result-bearing user turns.
        let roundsSeen = 0;
        for (let i = messages.length - 1; i >= 0; i--) {
            const msg = messages[i];
            if (msg.role !== 'user' || !Array.isArray(msg.content)) {
                continue;
            }
            const blocks = msg.content as unknown as Array<Record<string, unknown>>;
            const hasToolResult = blocks.some((b) => b.type === 'tool_result');
            if (!hasToolResult) {
                continue;
            }
            roundsSeen += 1;
            if (roundsSeen <= tt.keepRounds) {
                // Inside the inline window — truncate the body but keep
                // it readable. The `truncateInline` marker tells the model
                // where to fetch the rest.
                for (const block of blocks) {
                    if (block.type !== 'tool_result') { continue; }
                    const id = String(block.tool_use_id ?? '');
                    const content = block.content;
                    const text = typeof content === 'string' ? content : this.flattenContentToString(content);
                    const entry = this.toolTrail.listEntries().find((e) => this.entryMatchesToolUseId(e, id));
                    if (!entry) { continue; }
                    block.content = tt.truncateInline(entry.key, entry.toolName, entry.inputSummary, text);
                }
            } else {
                // Beyond the inline window — replace with a stub. The
                // tool_result block stays (so tool_use stays paired), the
                // content shrinks to a one-line pointer.
                for (const block of blocks) {
                    if (block.type !== 'tool_result') { continue; }
                    const id = String(block.tool_use_id ?? '');
                    const entry = this.toolTrail.listEntries().find((e) => this.entryMatchesToolUseId(e, id));
                    block.content = entry
                        ? tt.renderStub(entry)
                        : `[Past tool call (id=${id}) — full body persisted at _ai/trail/anthropic/<quest>/tool_results/. Use tomAi_listPastToolCalls to enumerate.]`;
                }
            }
        }
    }

    private flattenContentToString(content: unknown): string {
        if (typeof content === 'string') { return content; }
        if (Array.isArray(content)) {
            return content
                .map((p) => (typeof p === 'string' ? p : typeof (p as { text?: unknown }).text === 'string' ? (p as { text: string }).text : ''))
                .join('');
        }
        return '';
    }

    /** Map an Anthropic `tool_use_id` to a ToolTrail entry. The handler
     *  stamps each entry's `inputSummary` with the same source so we have
     *  no direct id column; rely on insertion order — the most recent
     *  entry with a matching tool name is the correct one. Falls back to
     *  string search of inputSummary as a guard against duplicates. */
    private toolUseIdToKey: Map<string, string> = new Map();

    private entryMatchesToolUseId(entry: ToolTrailEntry, toolUseId: string): boolean {
        const mapped = this.toolUseIdToKey.get(toolUseId);
        return mapped !== undefined && mapped === entry.key;
    }

    /**
     * Update `this.compactedHistoryBlocks` from an LLM output string.
     *
     * Preferred path: the LLM emits the full updated block set in the
     * canonical `<!-- tom:block -->` format. We parse those, apply
     * `diffAndStamp` against the prior blocks (so unchanged blocks
     * keep their `modified` stamps and edited/new blocks get fresh
     * stamps), then `dedupAndSort`. Result is what we keep in memory
     * and persist.
     *
     * Fallback: the LLM is using a legacy template that emits prose
     * instead of blocks. We wrap the entire trimmed output as a single
     * brand-new block (created = modified = now). Over a few compaction
     * passes this produces a growing list of one-block-per-pass; the
     * model is expected to consolidate them when running with the new
     * template.
     */
    private applyCompactionOutput(rawLlmOutput: string): void {
        const trimmed = rawLlmOutput.trim();
        if (!trimmed) { return; }
        const parsed = parseBlocks(trimmed);
        if (parsed.length > 0) {
            const stamped = diffAndStamp(
                this.compactedHistoryBlocks,
                parsed.map((b) => ({ created: b.created, body: b.body })),
            );
            this.compactedHistoryBlocks = dedupAndSort(stamped);
            return;
        }
        // Legacy / malformed output — wrap as one fresh block so the
        // session keeps making forward progress. Repeated compactions
        // with a legacy template will pile up; the new template merges.
        const now = new Date().toISOString();
        this.compactedHistoryBlocks = dedupAndSort([
            ...this.compactedHistoryBlocks,
            { created: now, modified: now, body: trimmed },
        ]);
    }

    /**
     * Run one compaction pass in the background, integrating the just-
     * completed exchange into the existing compacted blocks. Updates
     * `this.compactedHistoryBlocks`, clears the accumulator file, and
     * persists the blocks file on success.
     *
     * The rolling-tail file (`rawTurns.json`) is untouched here — its
     * lifecycle is the rolling N-round window, independent of compaction
     * firings.
     *
     * Compaction is expected to be faster than the Anthropic round-trip
     * in the common case (small local LLM summarising a single exchange),
     * but may be slower on bigger models — which is why sendMessage
     * awaits `compactionInFlight` before sending the next turn.
     */
    private runCompactionInBackground(
        lastExchange: ConversationMessage[],
        questId: string | undefined,
        configuration?: AnthropicConfiguration,
    ): Promise<void> {
        const cfg = this.getCompactionConfig();
        if (!cfg.llmConfigId) {
            return Promise.resolve();
        }
        // Per-configuration override wins for char/turn caps so a 200k
        // Opus profile can use bigger budgets than a 128k local backend
        // without having to fork the global compaction block.
        const caps = configuration
            ? this.resolveEffectiveCaps(configuration)
            : { maxHistoryTokens: cfg.maxHistoryTokens, historyMaxChars: cfg.historyMaxChars, memoryMaxChars: cfg.memoryMaxChars, rawTurnsKept: cfg.rawTurnsKept, toolTrailMaxResultChars: cfg.toolTrailMaxResultChars, toolTrailKeepRounds: cfg.toolTrailKeepRounds };
        return (async () => {
            try {
                const existingSummaryText = this.compactedSummaryText;
                const existingBlocksRendered = renderBlocksForLlm(this.compactedHistoryBlocks);
                const { runIncrementalCompaction } = await import('../services/history-compaction.js');
                const llmOutput = await runIncrementalCompaction({
                    existingSummary: existingSummaryText,
                    existingBlocks: existingBlocksRendered,
                    lastTurn: lastExchange,
                    llmProvider: cfg.llmProvider,
                    llmConfigId: cfg.llmConfigId,
                    compactionTemplateId: cfg.compactionTemplateId,
                    maxHistoryTokens: caps.maxHistoryTokens,
                    historyMaxChars: caps.historyMaxChars,
                    questId,
                    // Surface retry countdowns ("compaction: HTTP 503
                    // — retry 3/9 in 30s…") to the Anthropic panel's
                    // status line via the existing emitter.
                    onProgress: (msg) => this._onStatusUpdate.fire(msg),
                });
                if (typeof llmOutput === 'string' && llmOutput.trim().length > 0) {
                    this.applyCompactionOutput(llmOutput);
                }
                // Compaction succeeded — the overflow batch is now
                // baked into `compactedHistoryBlocks`, so the accumulator
                // CLEARS entirely. The rolling tail (`rawTurnsRolling`)
                // is untouched so the very next outgoing prompt still
                // has fresh complete-fidelity context.
                this.compactionRounds = [];
                clearCompactionRounds(questId);
                this.rawTurns = this.computeDedupedUnion();
                this.persistSessionHistory(questId);
            } catch {
                // best-effort; a failed compaction is recoverable on the next turn
            }
        })();
    }

    /**
     * Run memory extraction in the background. Input: last exchange +
     * current compacted summary + existing memory file content. Output
     * is applied via the memory tools (or appended directly to the
     * target file) inside the compaction service.
     */
    private runMemoryExtractionInBackground(
        lastExchange: ConversationMessage[],
        questId: string | undefined,
        configuration?: AnthropicConfiguration,
    ): Promise<void> {
        const cfg = this.getCompactionConfig();
        if (!cfg.runMemoryExtractionOnCompaction || !cfg.llmConfigId) {
            return Promise.resolve();
        }
        const caps = configuration
            ? this.resolveEffectiveCaps(configuration)
            : { historyMaxChars: cfg.historyMaxChars, memoryMaxChars: cfg.memoryMaxChars };
        return (async () => {
            try {
                const { runIncrementalMemoryExtraction } = await import('../services/history-compaction.js');
                await runIncrementalMemoryExtraction({
                    lastTurn: lastExchange,
                    compactedSummary: this.compactedSummaryText,
                    llmProvider: cfg.llmProvider,
                    llmConfigId: cfg.llmConfigId,
                    memoryTemplateId: cfg.memoryExtractionTemplateId,
                    historyMaxChars: caps.historyMaxChars,
                    memoryMaxChars: caps.memoryMaxChars,
                    questId,
                    // Same retry-status surface as compaction (above).
                    onProgress: (msg) => this._onStatusUpdate.fire(msg),
                });
            } catch {
                // best-effort
            }
        })();
    }

    /**
     * Fallback history seed when no `{ts}.history.json` snapshot exists.
     * Parses the last N entries from the quest's compact trail files
     * (`<quest>.anthropic.prompts.md` + `.answers.md`), reconstructs a
     * rawTurns array, and runs one compaction pass over older entries so
     * the compactedSummary starts non-empty.
     */
    /**
     * Recreate `history.json` (and the per-machine
     * `compaction_rounds.json` accumulator) from the quest's trail
     * files. Public entry point for the "Recreate History" button on
     * the Anthropic chat panel; forces the chunked trail-rebuild path
     * regardless of whether a snapshot already exists.
     *
     * The user-facing semantics: replay the conversation history into
     * compactedSummary + accumulator-tail as if compaction had been
     * running every `runEveryNRounds` rounds all along. Existing
     * snapshot is overwritten on completion.
     *
     * Sharing with the auto-seed path: both eventually run
     * `rebuildHistoryFromTrail()`. The button just clears the
     * `historySeeded` latch first so the rebuild fires even when a
     * snapshot is already in memory.
     */
    async recreateHistoryFromTrail(questId?: string): Promise<void> {
        const quest = questId ?? TwoTierMemoryService.instance.currentQuest();
        // Drop the in-memory latch so the next sendMessage doesn't
        // skip rebuild ("already seeded"). Also drop the in-memory
        // state itself so a partial rebuild can't end up in a hybrid
        // state mixing fresh trail data with stale snapshot data.
        this.historySeeded = false;
        this.compactedHistoryBlocks = [];
        this.compactionRounds = [];
        this.rawTurnsRolling = [];
        this.rawTurns = [];
        // Explicit user action: force the LLM fold even if compaction is
        // globally disabled (the button exists precisely to rebuild on demand).
        await this.rebuildHistoryFromTrail(quest, { force: true });
        this.historySeeded = true;
    }

    /**
     * Recreate the quest memory file from the trail. Public entry
     * point for the "Recreate Memory" button. Walks the trail in
     * chunks of `runEveryNRounds − rawTurnsKept` rounds — the same
     * chunk size used by live compaction — and runs memory extraction
     * on each chunk, letting the extractor see the rolling
     * `compactedSummary` so per-chunk decisions are informed by the
     * accumulated session state.
     *
     * Existing memory is NOT cleared first. The memory-extraction
     * template is required to read `${existingMemory}` and skip
     * already-recorded facts, so a rebuild against current memory is
     * idempotent (new facts get appended; duplicates are suppressed
     * by the model).
     */
    async recreateMemoryFromTrail(questId?: string): Promise<void> {
        const quest = questId ?? TwoTierMemoryService.instance.currentQuest();
        const cfg = this.getCompactionConfig();
        if (!cfg.llmConfigId) {
            this._onStatusUpdate.fire('Memory rebuild skipped — no compaction LLM configured');
            return;
        }
        try {
            const limit = Math.max(1, cfg.rebuildFromLastNPrompts);
            const { loadLastNTrailExchanges, runIncrementalMemoryExtraction } = await import('../services/history-compaction.js');
            const exchanges = loadLastNTrailExchanges(quest, limit);
            if (exchanges.length === 0) {
                this._onStatusUpdate.fire('Memory rebuild: no trail entries to fold');
                return;
            }
            const rawTail = Math.max(0, cfg.rawTurnsKept);
            const chunkSize = Math.max(1, cfg.runEveryNRounds - rawTail);
            // Walk all exchanges including the tail — for memory
            // extraction the "tail" distinction doesn't apply (live
            // operation only spares the tail from compaction, not
            // from extraction). Drop only those exchanges that fall
            // inside the very last partial chunk if they're smaller
            // than `rawTurnsKept`; otherwise extract on them too.
            const totalChunks = Math.ceil(exchanges.length / chunkSize);
            for (let i = 0, c = 1; i < exchanges.length; i += chunkSize, c++) {
                const chunk = exchanges.slice(i, i + chunkSize);
                const chunkMessages: ConversationMessage[] = [];
                for (const pair of chunk) {
                    if (pair.user) { chunkMessages.push({ role: 'user', content: pair.user }); }
                    if (pair.assistant) { chunkMessages.push({ role: 'assistant', content: pair.assistant }); }
                }
                if (chunkMessages.length === 0) { continue; }
                this._onStatusUpdate.fire(
                    `Rebuild memory: extracting chunk ${c}/${totalChunks} (${chunk.length} round${chunk.length === 1 ? '' : 's'})…`,
                );
                try {
                    await runIncrementalMemoryExtraction({
                        lastTurn: chunkMessages,
                        compactedSummary: this.compactedSummaryText,
                        llmProvider: cfg.llmProvider,
                        llmConfigId: cfg.llmConfigId,
                        memoryTemplateId: cfg.memoryExtractionTemplateId,
                        historyMaxChars: cfg.historyMaxChars,
                        memoryMaxChars: cfg.memoryMaxChars,
                        questId: quest,
                        onProgress: (msg) => this._onStatusUpdate.fire(msg),
                    });
                } catch {
                    // Per-chunk failure: continue with the next chunk
                    // — the rebuild is incremental, so a partial result
                    // is still better than abort.
                }
            }
            this._onStatusUpdate.fire('Memory rebuild complete');
        } catch {
            this._onStatusUpdate.fire('Memory rebuild failed');
        }
    }

    /**
     * @param opts.force  Run the LLM-driven chunked fold even when compaction
     *   is globally disabled. Only the explicit "Recreate History" button sets
     *   this; the automatic seed path leaves it false so a disabled compaction
     *   setting is honored (no Ollama/LLM calls, no "folding chunk…" status).
     */
    private async rebuildHistoryFromTrail(
        questId: string,
        opts: { force?: boolean } = {},
    ): Promise<void> {
        const rebuildStartedAt = Date.now();
        try {
            const cfg = this.getCompactionConfig();
            const limit = Math.max(1, cfg.rebuildFromLastNPrompts);
            const { loadLastNTrailExchanges } = await import('../services/history-compaction.js');
            const exchanges = loadLastNTrailExchanges(questId, limit);
            if (exchanges.length === 0) {
                logHistoryInfo(`history rebuild: no trail exchanges found (quest=${questId}, limit=${limit})${opts.force ? ' [forced]' : ''}`);
                return;
            }
            logHistoryInfo(
                `history rebuild start: quest=${questId} exchanges=${exchanges.length} ` +
                `limit=${limit}${opts.force ? ' [forced]' : ''} ` +
                `provider=${cfg.llmProvider} config=${cfg.llmConfigId || '<none>'} disabled=${cfg.disabled}`,
            );

            // Chunked rebuild — mirror live operation's every-N-rounds
            // cadence so the seeded summary is the same shape it would
            // have been if compaction had run incrementally. Reserve the
            // last `rawTurnsKept` exchanges as the accumulator tail;
            // everything before that is the prefix to fold. Chunk size
            // is `runEveryNRounds − rawTurnsKept` — the same number of
            // rounds that get folded per live compaction pass.
            const rawTail = Math.max(0, cfg.rawTurnsKept);
            const chunkSize = Math.max(1, cfg.runEveryNRounds - rawTail);
            const prefixEnd = Math.max(0, exchanges.length - rawTail);
            const prefix = exchanges.slice(0, prefixEnd);
            const tail = exchanges.slice(prefixEnd);

            const pairToMessages = (pair: { user?: string; assistant?: string }): ConversationMessage[] => {
                const out: ConversationMessage[] = [];
                if (pair.user) { out.push({ role: 'user', content: pair.user }); }
                if (pair.assistant) { out.push({ role: 'assistant', content: pair.assistant }); }
                return out;
            };

            // Build the accumulator tail (the last rawTurnsKept rounds).
            const tailFlat: ConversationMessage[] = [];
            for (const pair of tail) { tailFlat.push(...pairToMessages(pair)); }

            // Fold the prefix in chunks, oldest → newest, into a rolling
            // block set. Each chunk's LLM call is given the running
            // `existingBlocks` so per-chunk decisions are informed by the
            // accumulated session state — the same way live compaction
            // sees the prior blocks. If no compactor is configured, fall
            // back to the pre-round-based behaviour: take the last
            // runEveryNRounds exchanges as raw + drop the rest.
            //
            // When compaction is globally disabled we never run the LLM fold
            // (the same rule the live sendMessage path applies): no Ollama /
            // Anthropic calls, no "folding chunk…" status — the raw-flatten
            // branch below still restores the most recent exchanges. The
            // explicit "Recreate History" button overrides this via `force`.
            const compactionAllowed = opts.force || !cfg.disabled;
            const canCompact = compactionAllowed && prefix.length > 0 && cfg.llmConfigId.length > 0;
            if (canCompact) {
                const { runIncrementalCompaction } = await import('../services/history-compaction.js');
                const totalChunks = Math.ceil(prefix.length / chunkSize);
                this.compactedHistoryBlocks = [];
                for (let i = 0, c = 1; i < prefix.length; i += chunkSize, c++) {
                    const chunk = prefix.slice(i, i + chunkSize);
                    const chunkMessages: ConversationMessage[] = [];
                    for (const pair of chunk) { chunkMessages.push(...pairToMessages(pair)); }
                    if (chunkMessages.length === 0) { continue; }
                    this._onStatusUpdate.fire(
                        `Rebuild history: folding chunk ${c}/${totalChunks} (${chunk.length} round${chunk.length === 1 ? '' : 's'})…`,
                    );
                    try {
                        const llmOutput = await runIncrementalCompaction({
                            existingSummary: this.compactedSummaryText,
                            existingBlocks: renderBlocksForLlm(this.compactedHistoryBlocks),
                            lastTurn: chunkMessages,
                            llmProvider: cfg.llmProvider,
                            llmConfigId: cfg.llmConfigId,
                            compactionTemplateId: cfg.compactionTemplateId,
                            maxHistoryTokens: cfg.maxHistoryTokens,
                            historyMaxChars: cfg.historyMaxChars,
                            questId,
                            onProgress: (msg) => this._onStatusUpdate.fire(msg),
                        });
                        if (typeof llmOutput === 'string' && llmOutput.trim().length > 0) {
                            this.applyCompactionOutput(llmOutput);
                        }
                    } catch {
                        // Per-chunk failure: keep whatever blocks we have
                        // so far and continue with the next chunk. A run
                        // of failures yields a partial summary; the next
                        // live compaction pass will pick up where this
                        // left off.
                    }
                }
                this.rawTurnsRolling = rawTurnsToRounds(tailFlat);
                this.compactionRounds = [];
            } else {
                // No compactor configured — flatten the prefix's tail
                // into the rolling tail so at least the most recent
                // exchanges are restored verbatim, then leave the blocks
                // empty.
                const allFlat: ConversationMessage[] = [];
                for (const pair of [...prefix, ...tail]) { allFlat.push(...pairToMessages(pair)); }
                const cap = cfg.runEveryNRounds * 2;
                const flatCapped = allFlat.length > cap ? allFlat.slice(-cap) : allFlat;
                this.rawTurnsRolling = rawTurnsToRounds(flatCapped);
                this.compactionRounds = [];
                this.compactedHistoryBlocks = [];
            }

            // Persist the rebuilt state to all three files (blocks file,
            // legacy history.json, rolling tail). The accumulator is
            // empty by construction here.
            const historyFolder = TwoTierMemoryService.instance.historyFolder(questId);
            saveRawTurns(historyFolder, this.rawTurnsRolling);
            clearCompactionRounds(questId);
            this.rawTurns = this.computeDedupedUnion();
            this.persistSessionHistory(questId);
            logHistoryInfo(
                `history rebuild end: quest=${questId} ` +
                `compacted=${canCompact ? 'yes' : 'raw-only'} ` +
                `blocks=${this.compactedHistoryBlocks.length} rawRounds=${this.rawTurnsRolling.length} ` +
                `${Date.now() - rebuildStartedAt}ms`,
            );
        } catch (e) {
            // best-effort — empty history is a safe fallback
            logHistoryError(`history rebuild failed (quest=${questId})`, e);
        }
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
     * Reject every outstanding tool-approval awaiter as `approved=false`.
     * Called from the Stop button path so cancelling the turn also
     * unblocks any `runTool` that's currently sitting on an approval
     * promise — without this, the CTS cancel only aborts the API call,
     * while the tool loop stays pinned inside `awaitApproval` forever.
     *
     * Idempotent — safe to call when no approvals are in flight.
     */
    abortPendingApprovals(): number {
        if (this.pendingApprovals.size === 0) {
            return 0;
        }
        const entries = Array.from(this.pendingApprovals.values());
        this.pendingApprovals.clear();
        for (const entry of entries) {
            try {
                entry.resolve(false);
            } catch {
                // defensive — a resolver throwing shouldn't stop the rest
            }
        }
        return entries.length;
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
        const { profile, tools, userText } = options;
        // Profile overrides configuration when set (non-null / non-empty /
        // positive). The profile carries persona-level runtime preferences
        // (verbosity via maxTokens, tool-loop depth via maxRounds, context
        // injection style via historyMode); the configuration carries
        // backend identity (model / URL / capacity defaults). Per-field
        // precedence is "profile wins if filled in, otherwise inherit".
        // The sendVia* leaves read these via `options.configuration` and
        // local `configuration`, so we shadow both here in one place.
        const rawConfiguration = options.configuration;
        const overrides: Partial<AnthropicConfiguration> = {};
        if (typeof profile.maxRounds === 'number' && profile.maxRounds > 0) {
            overrides.maxRounds = profile.maxRounds;
        }
        if (typeof (profile as { maxTokens?: number }).maxTokens === 'number'
            && (profile as { maxTokens?: number }).maxTokens! > 0) {
            overrides.maxTokens = (profile as { maxTokens?: number }).maxTokens!;
        }
        const profileHistoryMode = profile.historyMode;
        if (profileHistoryMode !== null && profileHistoryMode !== undefined
            && (typeof profileHistoryMode !== 'string' || profileHistoryMode.length > 0)) {
            overrides.historyMode = profileHistoryMode as AnthropicConfiguration['historyMode'];
        }
        const configuration: AnthropicConfiguration = Object.keys(overrides).length > 0
            ? { ...rawConfiguration, ...overrides } as AnthropicConfiguration
            : rawConfiguration;
        if (configuration !== rawConfiguration) {
            options = { ...options, configuration };
        }
        const transport = configuration.transport ?? 'direct';

        const quest = WsPaths.getWorkspaceQuestId();

        // Quest Refresh auto-trigger (anthropic panel). Before counting this
        // upcoming user prompt, fire a refresh if the interval has elapsed:
        // send the refresh prompt through this same transport (with
        // `skipQuestRefresh` so it neither counts nor recurses), await it,
        // truncate the live-trail back to base, reset the counter — then count
        // this prompt and proceed. Isolated sub-agent runs and the refresh
        // prompt itself are exempt. This single hook covers both the chat panel
        // and the prompt queue, since the queue dispatches through sendMessage.
        if (!options.isolated && !options.skipQuestRefresh) {
            if (QuestRefreshService.instance.shouldAutoRefresh('anthropic', quest)) {
                await QuestRefreshService.instance.runRefresh(
                    'anthropic',
                    (refreshText) => this.sendMessage({
                        ...options,
                        userText: refreshText,
                        skipQuestRefresh: true,
                    }).then(() => undefined),
                    quest,
                );
            }
            QuestRefreshStore.instance.incrementCount('anthropic', quest);
        }

        const windowId = vscode.env.sessionId;
        const requestId = this.generateRequestId();
        this.roundCounter += 1;
        const round = this.roundCounter;

        this.seedHistoryFromSnapshot(quest);
        // Under the new dual-file model the rolling tail's cap lives in
        // `rawTurns.json` (size = `rawTurnsKept`), and the accumulator
        // (`compaction_rounds.json`) is unbounded by design — it drives
        // the every-N-rounds compaction trigger. The in-memory union
        // is recomputed from those two files; nothing to trim here.
        this.rawTurns = this.computeDedupedUnion();

        // Live trail writer — appends step-by-step events to
        // `_ai/quests/<quest>/live-trail.md` as the turn runs so the
        // user can watch in the MD Browser. Isolated sub-agent runs
        // don't get a writer — their intermediate work shouldn't
        // clutter the parent quest's trail. The writer is a local to
        // this call (never a field on the singleton) so nested calls —
        // sub-agents, concurrent chat-panel vs queue dispatch — can't
        // stomp it and make the parent turn's writes no-ops.
        const liveTrail: LiveTrailWriter | null = options.isolated ? null : new LiveTrailWriter(quest);
        // While a refresh interval is active, retain every prompt since the
        // last refresh (base + interval) so the refresh prompt can read the
        // full recent history. `0` ⇒ default last-5-blocks behaviour.
        liveTrail?.setExtraBlockAllowance(
            QuestRefreshStore.instance.extraTrailAllowance('anthropic', quest),
        );

        // Await any background work from the previous turn before we
        // build the wire payload. This emits status events the chat
        // panel forwards to the webview ("waiting for history
        // compaction…", etc.). Isolated sub-agent calls skip it so
        // they don't stall on state they don't use.
        if (!options.isolated) {
            await this.awaitInFlightBackgroundWork();
        }

        // Scan the outgoing message for `Remember:` / `Forget:` keyword
        // triggers (spec §5.4). Matched lines are handled in-process and
        // stripped; what's left goes to the model. A message that consists
        // entirely of triggers still sends the original text so the user
        // sees a response turn rather than an empty prompt.
        const { cleaned: keywordCleanedText } = this.applyKeywordTriggers(userText, quest);
        const effectiveUserText = keywordCleanedText.trim() || userText;

        // Tool history for the `${toolHistory}` placeholder. Skipped on the
        // Agent SDK transport — the SDK carries its own tool context
        // forward via session resumption, so our injected block would be
        // redundant. An empty string resolves the placeholder to nothing
        // so profiles that mention `${toolHistory}` still work on SDK.
        const toolHistoryText = transport === 'agentSdk'
            ? ''
            : this.toolTrail.toSummaryString();

        // Agent SDK path: no memory injection into the system prompt (§18.4).
        // The agent pulls memory via `tomAi_memory_*` tools on demand.
        // Both transports still route through `buildSystemSegments` so the
        // profile's `${…}` and `${{…}}` placeholders are resolved before the
        // prompt is sent (and before it is written to the raw `.userprompt.md`
        // trail). `toolHistoryText` is already `''` on Agent SDK so the
        // `${toolHistory}` block stays empty there — matching the previous
        // behaviour, just with variable resolution turned back on.
        const systemSegments = this.buildSystemSegments(profile, quest, { toolHistory: toolHistoryText });
        const systemPrompt = systemSegments.filter((s) => s).join('\n\n');
        // Effective history mode for this call. Agent SDK configs may use
        // 'sdk-managed' (SDK session resumption); 'full' / 'trim_and_summary'
        // on either transport triggers our own history injection. The
        // fallback is transport-aware: an agentSdk config with no explicit
        // historyMode defaults to 'sdk-managed' (so it resumes — and
        // persists — its SDK session), every other transport defaults to
        // 'trim_and_summary'. See resolveEffectiveHistoryMode for why.
        const rawHistoryMode = configuration.historyMode as string | undefined;
        const effectiveHistoryMode = resolveEffectiveHistoryMode(rawHistoryMode, transport);
        // When a user-message template is set AND the history mode wants
        // us to inject our own history (anything except sdk-managed),
        // expose ${compactedSummary} and ${rawTurns} so a
        // memory-injection template can prepend them to the user prompt.
        // Only really used on the Agent SDK path — the direct path builds
        // rawTurns into messages[] separately.
        const shouldExposeOurHistory = effectiveHistoryMode !== 'sdk-managed' && !options.isolated;
        const expandedUser = this.buildUserMessage(
            { ...options, userText: effectiveUserText },
            {
                ...(shouldExposeOurHistory
                    ? { compactedSummary: this.compactedSummaryText, rawTurns: this.rawTurns }
                    : {}),
                toolHistory: toolHistoryText,
            },
        );
        // `userContent` previously carried an unconditional `${toolHistory}`
        // prefix built inline here. That block now lives behind a
        // `${toolHistory}` placeholder in the profile system prompt /
        // user-message template, so the raw user text is no longer
        // decorated before it reaches the model. The `.prompts.md`
        // summary trail (written from finalize) uses `effectiveUserText`
        // directly so it reflects only what the user typed — no
        // injections, templates, or prefixes.
        const userContent = expandedUser;

        // First live-trail event for this turn — shows up in the
        // MD Browser as soon as the send button is clicked.
        liveTrail?.beginPrompt({
            transport,
            config: configuration.id,
            userText: effectiveUserText,
            source: options.source ?? 'chat',
        });

        TrailService.instance.writeRawPrompt(
            ANTHROPIC_SUBSYSTEM,
            `SYSTEM:\n${systemPrompt}\n\nUSER:\n${userContent}`,
            windowId,
            requestId,
            quest,
        );

        // Write the summary-prompt entry here — before any API call —
        // so the trail has a paired prompt even when the turn is
        // interrupted via the Stop button or errors out mid-stream.
        // The summary-answer counterpart is written at each exit point
        // (finalize / agentSdk success / catch blocks).
        TrailService.instance.writeSummaryPrompt(ANTHROPIC_SUBSYSTEM, effectiveUserText, quest);

        // Full-payload log: the `.userprompt.md` only has system + user;
        // this captures tools, rolling history, caching/thinking flags, and
        // transport-specific settings so the user can audit exactly what
        // went out on every turn. History is summarized per-message (role
        // + length + first ~200 chars). Written *before* compaction so the
        // uncompacted rolling history is visible.
        const effectiveThinkingBudget = profile.thinkingEnabled
            ? (profile.thinkingBudgetTokens ?? 8192)
            : undefined;
        const payloadProfileCaching = profile.promptCachingEnabled;
        const payloadEffectiveCaching = payloadProfileCaching === undefined
            ? configuration.promptCachingEnabled === true
            : payloadProfileCaching !== false;
        const payloadEffectiveTools = (transport === 'agentSdk' && profile.useBuiltInTools)
            ? tools.filter((t) => !DUPLICATES_OF_CLAUDE_CODE_BUILTINS.has(t.name))
            : tools;
        const payloadHistory = options.isolated ? [] : this.rawTurns;
        TrailService.instance.writeRawPayload(
            ANTHROPIC_SUBSYSTEM,
            buildPayloadDump({
                requestId,
                transport,
                configuration,
                profile,
                systemPrompt,
                tools: payloadEffectiveTools,
                history: payloadHistory,
                userContent,
                effectiveCaching: payloadEffectiveCaching,
                thinkingBudgetTokens: effectiveThinkingBudget,
                useBuiltInTools: profile.useBuiltInTools === true,
                compactedSummary: this.compactedSummaryText,
            }),
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
            // SDK-managed mode: look up the saved session id for this
            // (window, quest) pair and pass it as `resume` so the SDK
            // continues its prior conversation. Also auto-include
            // 'project' in settingSources when a CLAUDE.md exists, so
            // workspace instructions reach the agent without the user
            // having to configure settingSources manually.
            const useSdkManagedContinuity = effectiveHistoryMode === 'sdk-managed' && !options.isolated;
            const sessionKey = options.sessionKey ?? DEFAULT_AGENT_SDK_SESSION_KEY;
            const resumeSessionId = useSdkManagedContinuity
                ? TwoTierMemoryService.instance.loadAgentSdkSessionId(quest, sessionKey)
                : undefined;
            debugLog(
                `[AgentSDK] continuity: quest=${quest} key=${sessionKey} resume=${resumeSessionId ?? '(none — new session)'}`,
                'INFO',
                'anthropic',
            );

            // Early-save callback: persist the session id the instant the
            // SDK's init message arrives, not after the stream completes.
            // Without this, a user-cancelled or window-reload-killed
            // stream leaves the on-disk id stale and the NEXT turn forks
            // a brand-new Claude Code session (the symptom we chased —
            // session selector filling up one-per-prompt).
            const onSessionIdCaptured = useSdkManagedContinuity
                ? (sid: string) => {
                    TwoTierMemoryService.instance.saveAgentSdkSessionId(
                        sid,
                        quest,
                        configuration.model,
                        sessionKey,
                    );
                    if (sid !== resumeSessionId) {
                        debugLog(
                            `[AgentSDK] session id changed: ${resumeSessionId ?? '(new)'} -> ${sid}`,
                            'INFO',
                            'anthropic',
                        );
                    }
                }
                : undefined;

            // Transport retry (spec §18, "Anthropic Transport Retry"):
            // resume the failed session with a continuation prompt built
            // from the selected template, or restart on a fresh session
            // when the id is missing/unusable. Disabled (single attempt)
            // when maxAttempts <= 1.
            const retrySection = this.getAnthropicSection().transportRetry;
            const retryMaxAttempts = Number.isFinite(retrySection?.maxAttempts)
                ? Math.max(1, retrySection!.maxAttempts as number)
                : 3;
            const retryParam = retryMaxAttempts > 1
                ? {
                    maxAttempts: retryMaxAttempts,
                    // Transient backend-busy errors (429/500/503/529/overloaded)
                    // are ridden out for the profile's full retry window with
                    // exponential backoff — same `retryMaxTotalWaitMinutes`
                    // budget the direct-SDK and Local-LLM paths honor — instead
                    // of being capped at the small `maxAttempts` count.
                    maxTotalWaitMs: (profile.retryMaxTotalWaitMinutes ?? 10) * 60 * 1000,
                    onRetryStatus: (text: string): void => this._onStatusUpdate.fire(text),
                    buildContinuationPrompt: (errorText: string): string => {
                        // Empty templateId ("use default") resolves to the
                        // template marked isDefault (seeded as "Default Retry"),
                        // falling back to the in-code constant only when no
                        // default exists on disk.
                        const body = selectTransportRetryTemplateBody(retrySection);
                        return resolveVariables(body, {
                            values: {
                                errorText,
                                userMessage: userContent,
                                originalPrompt: userContent,
                            },
                            enableJsExpressions: true,
                        });
                    },
                }
                : undefined;

            // Interactive questions (spec §18, "Anthropic Interactive
            // Questions"): when the agent calls the built-in AskUserQuestion
            // tool, either prompt the user (allowInteractiveQuestions) or
            // feed back the resolved fallback template telling it to proceed
            // autonomously. Only meaningful with useBuiltInTools.
            const interactiveSection = this.getAnthropicSection();
            const interactiveQuestionsParam = profile.useBuiltInTools
                ? {
                    enabled: profile.allowInteractiveQuestions === true,
                    buildFallbackText: (questionsDigest: string): string => {
                        const selected = profile.interactiveQuestionsTemplateId
                            ? interactiveSection.interactiveQuestionsTemplates?.find(
                                (t) => t.id === profile.interactiveQuestionsTemplateId,
                            )
                            : undefined;
                        const body = selected?.template ?? DEFAULT_INTERACTIVE_QUESTIONS_TEMPLATE;
                        return resolveVariables(body, {
                            values: { questions: questionsDigest },
                            enableJsExpressions: true,
                        });
                    },
                }
                : undefined;

            let result: AnthropicSendResult & { sessionId?: string };
            try {
                result = await runAgentSdkQuery({
                    configuration,
                    tools: effectiveTools,
                    systemPrompt,
                    userText: userContent,
                    cancellationToken: options.cancellationToken,
                    toolApprovalMode: profile.toolApprovalMode ?? 'always',
                    useBuiltInTools: profile.useBuiltInTools === true,
                    thinkingBudgetTokens: profile.thinkingEnabled ? (profile.thinkingBudgetTokens ?? 8192) : undefined,
                    resumeSessionId,
                    onSessionIdCaptured,
                    retry: retryParam,
                    interactiveQuestions: interactiveQuestionsParam,
                    autoLoadProjectSettings: useSdkManagedContinuity,
                    liveTrail: liveTrail ?? undefined,
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
            } catch (err) {
                const errMsg = err instanceof Error ? (err.stack || err.message) : String(err);
                const wasInterrupted = options.cancellationToken?.isCancellationRequested === true;
                TrailService.instance.writeSummaryAnswer(
                    ANTHROPIC_SUBSYSTEM,
                    wasInterrupted ? '(interrupted)' : `(error: ${err instanceof Error ? err.message : String(err)})`,
                    { requestId, model: configuration.model },
                    quest,
                );
                closeLiveTrailForThrown(liveTrail, err, errMsg);
                throw err;
            }

            // Safety-net save — the early callback usually fired already,
            // but if the stream somehow ended without ever carrying a
            // session_id this catches the result-message fallback.
            if (useSdkManagedContinuity && result.sessionId) {
                TwoTierMemoryService.instance.saveAgentSdkSessionId(
                    result.sessionId,
                    quest,
                    configuration.model,
                    sessionKey,
                );
            }

            // Summary answer: the prompt was already written at the top of
            // sendMessage() before the API call, so only the answer is
            // needed here. The SDK branch returns early (doesn't go through
            // finalize()), so we write the answer explicitly.
            this.rememberAssistantText(result.text);
            TrailService.instance.writeSummaryAnswer(
                ANTHROPIC_SUBSYSTEM,
                result.text,
                { requestId, model: configuration.model },
                quest,
            );

            // The Agent SDK runs its own context compaction, but we still
            // append to rawTurns so continuity carries across
            // direct/agentSdk transport switches in the same session. We
            // also schedule our own background compaction + memory
            // extraction so the compacted summary and memory files stay
            // up to date regardless of transport.
            if (!options.isolated) {
                const userMsg: ConversationMessage = { role: 'user', content: userContent };
                const assistantMsg: ConversationMessage = { role: 'assistant', content: result.text };
                const questId = TwoTierMemoryService.instance.currentQuest();
                const caps = this.resolveEffectiveCaps(configuration);
                // The accumulator file grows on every round (cleared on
                // compaction success). The rolling-tail file is capped
                // at `rawTurnsKept`. Both files plus the in-memory
                // union are updated in one call.
                this.persistRoundAndReloadUnion([userMsg, assistantMsg], questId, caps.rawTurnsKept);
                this.persistSessionHistory(questId);
                this.scheduleBackgroundCompactionAndExtraction([userMsg, assistantMsg], false, configuration);
            }
            // Close the live-trail block for this turn.
            liveTrail?.endPrompt({
                rounds: result.turnsUsed,
                toolCalls: result.toolCallCount,
            });
            return result;
        }

        // VS Code LM transport — routes through vscode.lm.selectChatModels
        // + model.sendRequest. Model identity is pinned at configure-time
        // (see multi_transport_prompt_queue_revised.md §4.2), so we filter
        // the cached provider list by {vendor, family, modelId} rather
        // than re-enumerating on each send. The dedicated send method
        // implements the full tool-use loop matching the Direct branch's
        // behaviour; VS Code LM's `LanguageModelToolCallPart` /
        // `LanguageModelToolResultPart` are translated to Anthropic
        // ToolUseBlock / tool_result shapes inside.
        if (transport === 'vscodeLm') {
            return await this.sendViaVsCodeLm(
                options,
                systemSegments,
                userContent,
                windowId,
                requestId,
                round,
                quest,
                effectiveUserText,
                liveTrail,
            );
        }

        // Local LLM transport — synthesised by the dispatcher when a
        // Local LLM config is referenced from an Anthropic profile
        // (spec §4.3). Single-shot leaf, same shape as vscodeLm.
        if (transport === 'localLlm') {
            return await this.sendViaLocalLlm(
                options,
                systemSegments,
                userContent,
                windowId,
                requestId,
                round,
                quest,
                effectiveUserText,
                liveTrail,
            );
        }

        const client = this.getClient();
        if (!client) {
            throw new Error('Anthropic client not available — set the configured API key env var');
        }

        const anthropicTools = toAnthropicTools(tools);
        // Wire payload shape:
        //
        //   [...rawTurns, <summary-prefix user>, <ack assistant>, currentUser]
        //
        // The compacted summary is placed *after* the raw turns (most-
        // recent-first isn't what we want — rawTurns ARE the most recent
        // complete-fidelity exchanges; the summary covers everything
        // that preceded them and sits between the raw tail and the
        // current prompt so the model reads it last before the new
        // question). Empty `compactedSummary` = no synthetic pair.
        const rollingHistory: AnthropicMessageParam[] = options.isolated
            ? []
            : this.rawTurns.map((m) => ({
                role: m.role === 'system' ? 'user' : m.role as 'user' | 'assistant',
                content: m.content,
            }));
        const compactedSummary = this.compactedSummaryText;
        const summaryBlock: AnthropicMessageParam[] = (!options.isolated && compactedSummary)
            ? [
                {
                    role: 'user',
                    content: `## Additional context (compacted from earlier turns)\n\n${compactedSummary}`,
                },
                {
                    role: 'assistant',
                    content: 'Understood — continuing with this context in mind.',
                },
            ]
            : [];
        const messages: AnthropicMessageParam[] = [
            ...rollingHistory,
            ...summaryBlock,
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

        // Dump the initial assembled request (system + compactedSummary
        // pair + rawTurns + current user) to `_ai/trail/anthropic/<quest>/
        // last_request.json`. Fires once per user prompt — NOT on each
        // tool round — so the file reflects what the model first saw,
        // not mid-loop tool churn.
        try {
            const { writeLastRequest, quickStats } = await import('../services/lastRequestDump.js');
            writeLastRequest({
                timestamp: new Date().toISOString(),
                subsystem: 'anthropic',
                endpoint: 'client.messages.create (direct SDK)',
                configId: configuration.id,
                model: configuration.model,
                profile: profile.id,
                stats: quickStats({ messages, tools: anthropicTools }),
                body: {
                    model: configuration.model,
                    max_tokens: configuration.maxTokens,
                    ...temperatureField(configuration.temperature),
                    ...(thinkingBlock ? { thinking: thinkingBlock } : {}),
                    system: systemParam,
                    ...(anthropicTools.length > 0 ? { tools: anthropicTools } : {}),
                    messages,
                },
            }, quest);
        } catch { /* best-effort */ }

        try {
            for (let turn = 0; turn < configuration.maxRounds; turn++) {
                if (options.cancellationToken?.isCancellationRequested) {
                    break;
                }

                const createParams = {
                    model: configuration.model,
                    max_tokens: configuration.maxTokens,
                    ...temperatureField(configuration.temperature),
                    ...(thinkingBlock ? { thinking: thinkingBlock } : {}),
                    system: systemParam,
                    ...(anthropicTools.length > 0 ? { tools: anthropicTools } : {}),
                    messages,
                };
                const response = await withRetryBudget({
                    call: () => client.messages.create(createParams),
                    totalWaitMs: (profile.retryMaxTotalWaitMinutes ?? 10) * 60 * 1000,
                    backendLabel: 'Anthropic API busy',
                    cancellationToken: options.cancellationToken,
                    onRetryStatus: (text: string, cause?: string): void => {
                        this._onStatusUpdate.fire(text);
                        liveTrail?.appendRetry(text, cause);
                    },
                });

                lastStopReason = response.stop_reason ?? undefined;
                lastText = this.extractText(response.content) || lastText;
                this.rememberAssistantText(lastText);

                // Live-trail each content block from this response so
                // the MD Browser shows thinking / text before we go
                // back out to the tools (or finalize).
                for (const block of response.content) {
                    const b = block as { type?: string; text?: unknown; thinking?: unknown };
                    if (b.type === 'thinking' && typeof b.thinking === 'string') {
                        liveTrail?.appendThinking(b.thinking);
                    } else if (b.type === 'text' && typeof b.text === 'string') {
                        liveTrail?.appendAssistantText(b.text);
                    }
                }

                if (response.stop_reason !== 'tool_use') {
                    return this.finalize(userContent, lastText, turn + 1, totalToolCalls, lastStopReason, windowId, requestId, quest, configuration, options.isolated === true, effectiveUserText, liveTrail);
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
                        liveTrail,
                    );
                    toolResults.push(toolResultBlock);
                }

                messages.push({ role: 'user', content: toolResults });

                // Apply the configured tool-trail retention policy: the
                // most-recent `toolTrailKeepRounds` rounds keep their
                // (truncated) bodies inline; older rounds get a stub that
                // names the replay key. This is what actually shrinks the
                // outgoing prompt — full bodies live on disk under
                // `_ai/trail/anthropic/<quest>/tool_results/<key>.json`
                // and are recoverable via tomAi_readPastToolResult.
                const caps = this.resolveEffectiveCaps(configuration);
                this.applyToolTrailRetentionPolicy(messages, caps);
            }
        } catch (err) {
            // Guarantee the raw answer file exists even when the API
            // call throws (network error, 400, token exhaustion, …).
            // Without this, the trail stops at the userprompt/payload
            // files and subsequent history/compaction work operates
            // on a missing trail entry.
            const errMsg = err instanceof Error ? (err.stack || err.message) : String(err);
            const body = lastText
                ? `${lastText}\n\n---\n(request error after partial output)\n${errMsg}`
                : `(no text produced — request errored before any assistant text)\n${errMsg}`;
            TrailService.instance.writeRawAnswer(ANTHROPIC_SUBSYSTEM, body, windowId, requestId, quest);
            const wasInterrupted = options.cancellationToken?.isCancellationRequested === true;
            const summaryAnswer = wasInterrupted
                ? (lastText ? `${lastText}\n\n(interrupted)` : '(interrupted)')
                : (lastText ? `${lastText}\n\n(error: ${err instanceof Error ? err.message : String(err)})` : `(error: ${err instanceof Error ? err.message : String(err)})`);
            TrailService.instance.writeSummaryAnswer(ANTHROPIC_SUBSYSTEM, summaryAnswer, { requestId, model: configuration.model }, quest);
            closeLiveTrailForThrown(liveTrail, err, errMsg);
            throw err;
        }

        return this.finalize(userContent, lastText, configuration.maxRounds, totalToolCalls, lastStopReason, windowId, requestId, quest, configuration, options.isolated === true, effectiveUserText, liveTrail);
    }

    /**
     * VS Code LM leaf — full tool-use loop. Resolves the pinned model
     * via `vscode.lm.selectChatModels` filtered by the configuration's
     * stored `{vendor, family, modelId}` tuple, iterates
     * `model.sendRequest` until the model stops producing
     * `LanguageModelToolCallPart` entries or `configuration.maxRounds`
     * is exhausted. Every tool call funnels through `runTool` so the
     * Anthropic approval gate, trail writers, and live-trail hooks
     * observe identical events regardless of which leaf produced them.
     * Exits through shared `finalize()` so trails / live-trail /
     * rawTurns history match every other leaf (spec §4.4).
     *
     * Prompt shape: per spec §2.8, the first turn concatenates
     * `{systemPrompt}\n\n{userContent}` into a single User message
     * because VS Code LM's single-shot form has no system/user split.
     */
    private async sendViaVsCodeLm(
        options: AnthropicSendOptions,
        systemSegments: string[],
        userContent: string,
        windowId: string,
        requestId: string,
        round: number,
        quest: string,
        effectiveUserText: string,
        liveTrail: LiveTrailWriter | null,
    ): Promise<AnthropicSendResult> {
        const { configuration, tools } = options;
        const vscodeLm = configuration.vscodeLm;
        if (!vscodeLm || !vscodeLm.modelId) {
            throw new Error(
                `Anthropic configuration "${configuration.id}" has transport='vscodeLm' but no vscodeLm.modelId set. Edit the configuration to pick a model.`,
            );
        }

        const models = await vscode.lm.selectChatModels({
            vendor: vscodeLm.vendor,
            family: vscodeLm.family,
        });
        const model = models.find((m) => m.id === vscodeLm.modelId) ?? models[0];
        if (!model) {
            throw new Error(
                `VS Code LM model not available for vendor="${vscodeLm.vendor}" family="${vscodeLm.family}" modelId="${vscodeLm.modelId}". Install the provider or reopen VS Code and retry.`,
            );
        }

        const systemPrompt = systemSegments.filter((s) => s).join('\n\n');

        // Build initial chat history. Prior turns come in as plain
        // User/Assistant messages — we deliberately don't carry over
        // tool_call/tool_result parts from past turns (VS Code LM
        // requires paired callIds inside the same conversation, and
        // we don't retain enough state to reconstruct those).
        const chatMessages: vscode.LanguageModelChatMessage[] = [];
        if (!options.isolated) {
            for (const turn of this.rawTurns) {
                if (turn.role === 'assistant') {
                    chatMessages.push(vscode.LanguageModelChatMessage.Assistant(turn.content));
                } else {
                    chatMessages.push(vscode.LanguageModelChatMessage.User(turn.content));
                }
            }
            const compactedSummaryForLm = this.compactedSummaryText;
            if (compactedSummaryForLm) {
                chatMessages.push(vscode.LanguageModelChatMessage.User(
                    `## Additional context (compacted from earlier turns)\n\n${compactedSummaryForLm}`,
                ));
                chatMessages.push(vscode.LanguageModelChatMessage.Assistant('Understood — continuing with this context in mind.'));
            }
        }
        // The spec §2.8 concatenation applies to the CURRENT user
        // prompt: system prompt + user text joined by a blank line.
        const combined = systemPrompt ? `${systemPrompt}\n\n${userContent}` : userContent;
        chatMessages.push(vscode.LanguageModelChatMessage.User(combined));

        // Convert SharedToolDefinition[] → LanguageModelChatTool[].
        const lmTools: vscode.LanguageModelChatTool[] = tools.map((t) => ({
            name: t.name,
            description: t.description,
            inputSchema: t.inputSchema ?? { type: 'object', properties: {} },
        }));

        let totalToolCalls = 0;
        let lastText = '';
        let lastStopReason: string | undefined;

        // Dump the initial vscodeLm payload once per user prompt.
        // `chatMessages` is a live SDK array of LanguageModelChatMessage
        // instances; we serialise a JSON-friendly view so the file is
        // re-openable later.
        try {
            const { writeLastRequest, quickStats } = await import('../services/lastRequestDump.js');
            const serialisedMessages = chatMessages.map((cm) => {
                const content = (cm as { content?: unknown }).content;
                const parts = Array.isArray(content)
                    ? content.map((p) => {
                        if (p instanceof vscode.LanguageModelTextPart) {
                            return { type: 'text', text: p.value };
                        }
                        if (p instanceof vscode.LanguageModelToolCallPart) {
                            return { type: 'tool_call', name: p.name, callId: p.callId, input: p.input };
                        }
                        if (p instanceof vscode.LanguageModelToolResultPart) {
                            return { type: 'tool_result', callId: p.callId, content: p.content };
                        }
                        return { type: 'unknown' };
                    })
                    : content;
                return { role: cm.role, parts };
            });
            writeLastRequest({
                timestamp: new Date().toISOString(),
                subsystem: 'anthropic-vscodelm',
                endpoint: 'model.sendRequest',
                configId: configuration.id,
                model: configuration.model,
                stats: quickStats({ messages: serialisedMessages as unknown as Array<{ role?: string; content?: unknown }>, tools: lmTools, systemPrompt }),
                body: {
                    model: { id: model.id, vendor: model.vendor, family: model.family },
                    messages: serialisedMessages,
                    tools: lmTools,
                },
            }, quest);
        } catch { /* best-effort */ }

        try {
            for (let turn = 0; turn < configuration.maxRounds; turn++) {
                if (options.cancellationToken?.isCancellationRequested) {
                    break;
                }
                // Suppress tools on the last round so the model produces
                // a final text answer instead of a hung tool_call we
                // can't service.
                const remaining = configuration.maxRounds - turn;
                const requestOptions: vscode.LanguageModelChatRequestOptions = remaining <= 1
                    ? {}
                    : { tools: lmTools };

                const request = await model.sendRequest(chatMessages, requestOptions, options.cancellationToken);

                // Collect both text parts and tool_call parts from the
                // streamed response into parallel arrays so we can (a)
                // append them to the Assistant message for the next
                // round, and (b) act on tool_calls afterwards.
                const assistantParts: Array<vscode.LanguageModelTextPart | vscode.LanguageModelToolCallPart> = [];
                const toolCalls: vscode.LanguageModelToolCallPart[] = [];
                let turnText = '';
                for await (const part of request.stream) {
                    if (part instanceof vscode.LanguageModelTextPart) {
                        turnText += part.value;
                        assistantParts.push(part);
                        liveTrail?.appendAssistantText(part.value);
                    } else if (part instanceof vscode.LanguageModelToolCallPart) {
                        assistantParts.push(part);
                        toolCalls.push(part);
                    }
                    // Other part types (if any) are ignored silently.
                }
                if (turnText) { lastText = turnText; this.rememberAssistantText(lastText); }

                if (toolCalls.length === 0) {
                    lastStopReason = 'end_turn';
                    return this.finalize(
                        userContent,
                        lastText,
                        turn + 1,
                        totalToolCalls,
                        lastStopReason,
                        windowId,
                        requestId,
                        quest,
                        configuration,
                        options.isolated === true,
                        effectiveUserText,
                        liveTrail,
                    );
                }

                // Append the assistant turn so the next round has
                // the matching tool_call parts in history.
                chatMessages.push(vscode.LanguageModelChatMessage.Assistant(assistantParts));

                // Execute each tool via runTool; build a User message
                // with the paired LanguageModelToolResultPart entries.
                const toolResultParts: vscode.LanguageModelToolResultPart[] = [];
                for (const tc of toolCalls) {
                    totalToolCalls++;
                    const toolUseBlock = {
                        type: 'tool_use' as const,
                        id: tc.callId,
                        name: tc.name,
                        input: (tc.input as Record<string, unknown>) ?? {},
                        caller: { type: 'direct' as const },
                    } as unknown as Extract<AnthropicContentBlock, { type: 'tool_use' }>;
                    const toolResultBlock = await this.runTool(
                        toolUseBlock,
                        tools,
                        configuration,
                        options,
                        round,
                        quest,
                        windowId,
                        requestId,
                        liveTrail,
                    );
                    const resultText = typeof toolResultBlock.content === 'string'
                        ? toolResultBlock.content
                        : Array.isArray(toolResultBlock.content)
                            ? toolResultBlock.content
                                .map((p) => (p && typeof p === 'object' && 'type' in p && p.type === 'text' && 'text' in p ? String(p.text) : ''))
                                .join('')
                            : '';
                    toolResultParts.push(new vscode.LanguageModelToolResultPart(
                        tc.callId,
                        [new vscode.LanguageModelTextPart(resultText)],
                    ));
                }
                chatMessages.push(vscode.LanguageModelChatMessage.User(toolResultParts));
            }

            // Exhausted maxRounds.
            lastStopReason = 'max_tokens';
            return this.finalize(
                userContent,
                lastText,
                configuration.maxRounds,
                totalToolCalls,
                lastStopReason,
                windowId,
                requestId,
                quest,
                configuration,
                options.isolated === true,
                effectiveUserText,
                liveTrail,
            );
        } catch (err) {
            const errMsg = err instanceof Error ? (err.stack || err.message) : String(err);
            const body = lastText
                ? `${lastText}\n\n---\n(VS Code LM request errored after partial output)\n${errMsg}`
                : `(VS Code LM request failed before completing)\n${errMsg}`;
            TrailService.instance.writeRawAnswer(ANTHROPIC_SUBSYSTEM, body, windowId, requestId, quest);
            const wasInterrupted = options.cancellationToken?.isCancellationRequested === true;
            const summaryAnswer = wasInterrupted
                ? (lastText ? `${lastText}\n\n(interrupted)` : '(interrupted)')
                : (lastText ? `${lastText}\n\n(error: ${err instanceof Error ? err.message : String(err)})` : `(error: ${err instanceof Error ? err.message : String(err)})`);
            TrailService.instance.writeSummaryAnswer(ANTHROPIC_SUBSYSTEM, summaryAnswer, { requestId, model: configuration.model }, quest);
            closeLiveTrailForThrown(liveTrail, err, errMsg);
            throw err;
        }
    }

    /**
     * Local LLM leaf — full tool-use loop. Resolves the Local LLM HTTP
     * call via `LocalLlmManager.callLocalLlmOnce` (extracted per spec
     * §4.4a) in a loop until the model stops producing tool calls or
     * `configuration.maxRounds` is exhausted. Every tool call goes
     * through `runTool` so the Anthropic approval gate, trail writers,
     * and live-trail hooks see identical events regardless of which
     * leaf produced them. Exits through shared `finalize()` so trails
     * + rawTurns history match every other leaf — Local-LLM-backed
     * profiles therefore trail under `_ai/trail/anthropic/*` not the
     * Local LLM panel's own `_ai/trail/local/*` (the profile authored
     * the request).
     */
    private async sendViaLocalLlm(
        options: AnthropicSendOptions,
        systemSegments: string[],
        userContent: string,
        windowId: string,
        requestId: string,
        round: number,
        quest: string,
        effectiveUserText: string,
        liveTrail: LiveTrailWriter | null,
    ): Promise<AnthropicSendResult> {
        const { configuration, tools } = options;
        const llm = configuration.localLlm;
        if (!llm || !llm.baseUrl || !llm.model) {
            throw new Error(
                `Anthropic configuration "${configuration.id}" uses transport='localLlm' but the localLlm fields (baseUrl/model) are missing. Dispatcher should have synthesised them — check resolveStageTransport in the queue.`,
            );
        }

        const systemPrompt = systemSegments.filter((s) => s).join('\n\n');
        // Local LLM API takes separate system + user messages; pass them
        // as the canonical chat-completions shape. The concatenation
        // rule in spec §2.8 applies only when the underlying API has
        // no such split — Ollama does.
        // eslint-disable-next-line @typescript-eslint/naming-convention
        type OllamaToolCallMsg = { function: { name: string; arguments: Record<string, unknown> } };
        // eslint-disable-next-line @typescript-eslint/naming-convention
        interface OllamaMsg { role: string; content?: string; tool_calls?: OllamaToolCallMsg[] }
        const messages: OllamaMsg[] = [];
        if (systemPrompt) {
            messages.push({ role: 'system', content: systemPrompt });
        }
        // Prior turn history so the model has context across sends (spec
        // §2.8 / §5 — handler already owns continuity via rawTurns +
        // compactedSummary). Isolated sub-agent runs skip history.
        //
        // historyMode selects what gets forwarded — Local LLMs typically have
        // far smaller context windows than Anthropic, so blindly dumping
        // every rawTurn easily blows past the limit (vLLM rejects with
        // "maximum context length is N tokens" before the model runs).
        //   'last'              → just the most recent user+assistant pair
        //                         (default for synthesised localLlm configs)
        //   'summary'           → only the compactedSummary (no rawTurns)
        //   'trim_and_summary'  → rawTurns + summary (Anthropic default)
        //   'full' / 'all'      → everything verbatim
        //   anything else / unset → 'last'
        if (!options.isolated) {
            const historyMode = (configuration.historyMode as string | undefined) ?? 'last';
            const compactedSummary = this.compactedSummaryText;
            const includeRaw = historyMode === 'full' || historyMode === 'all' || historyMode === 'trim_and_summary' || historyMode === 'last';
            const includeSummary = (historyMode === 'summary' || historyMode === 'trim_and_summary' || historyMode === 'full' || historyMode === 'all') && Boolean(compactedSummary);
            const rawSlice = historyMode === 'last'
                ? this.rawTurns.slice(-2)
                : this.rawTurns;
            if (includeRaw) {
                for (const turn of rawSlice) {
                    messages.push({
                        role: turn.role === 'system' ? 'user' : turn.role,
                        content: turn.content,
                    });
                }
            }
            if (includeSummary) {
                messages.push({
                    role: 'user',
                    content: `## Additional context (compacted from earlier turns)\n\n${compactedSummary}`,
                });
                messages.push({ role: 'assistant', content: 'Understood — continuing with this context in mind.' });
            }
        }
        messages.push({ role: 'user', content: userContent });

        const { getLocalLlmManager } = await import('./localLlm-handler.js');
        const localLlmManager = getLocalLlmManager();
        if (!localLlmManager) {
            throw new Error('Local LLM manager is not initialised — the Local LLM handler must be activated before a Local-LLM-backed Anthropic profile can send.');
        }

        let totalToolCalls = 0;
        let lastText = '';
        let lastStopReason: string | undefined;

        // Dump the initial assembled Local-LLM request once per user
        // prompt. This is the path Anthropic profiles take when their
        // configuration has `transport: 'localLlm'` (e.g. Gemma routed
        // through vLLM via an Anthropic profile). Goes to the localllm
        // trail bucket because the wire endpoint is the local model.
        try {
            const { writeLastRequest, quickStats } = await import('../services/lastRequestDump.js');
            writeLastRequest({
                timestamp: new Date().toISOString(),
                subsystem: 'localllm',
                endpoint: `${llm.apiStyle === 'openai' ? 'POST /v1/chat/completions' : 'POST /api/chat'} (${llm.baseUrl}) — via Anthropic profile`,
                configId: configuration.id,
                model: llm.model,
                profile: options.profile.id,
                stats: quickStats({ messages, tools, systemPrompt }),
                body: {
                    model: llm.model,
                    apiStyle: llm.apiStyle ?? 'ollama',
                    temperature: llm.temperature,
                    keepAlive: llm.keepAlive,
                    messages,
                    ...(llm.toolsEnabled !== false && tools.length > 0 ? { tools: tools.map((t) => t.name) } : {}),
                },
            }, quest);
        } catch { /* best-effort */ }

        try {
            for (let turn = 0; turn < configuration.maxRounds; turn++) {
                if (options.cancellationToken?.isCancellationRequested) {
                    break;
                }
                // Only offer tools when we still have budget for another
                // round — otherwise force the model to produce a text
                // answer instead of a hung tool_calls reply we can't
                // service. Matches the Local LLM panel's own loop.
                //
                // Also: a Local LLM config can opt out of tool use entirely
                // (`localLlm.toolsEnabled === false`). This is required for
                // OpenAI-compatible servers (vLLM, LM Studio, llama.cpp)
                // that weren't launched with a tool-call parser — they
                // reject any request that includes a `tools` array with
                // `"auto" tool choice requires --enable-auto-tool-choice
                // and --tool-call-parser to be set`.
                const remaining = configuration.maxRounds - turn;
                const toolsEnabledForLeaf = llm.toolsEnabled !== false;
                const effectiveTools = (toolsEnabledForLeaf && remaining > 1) ? tools : [];

                const result = await localLlmManager.callLocalLlmOnce({
                    baseUrl: llm.baseUrl,
                    model: llm.model,
                    temperature: llm.temperature,
                    messages,
                    tools: effectiveTools,
                    keepAlive: llm.keepAlive,
                    apiStyle: llm.apiStyle,
                    apiKeyEnv: llm.apiKeyEnv,
                    cancellationToken: options.cancellationToken,
                    onToken: (fragment: string) => liveTrail?.appendAssistantText(fragment),
                    // Profile carries the retry budget (in minutes); the
                    // Local LLM dispatcher converts to ms. Same field, same
                    // semantics as the Anthropic direct path.
                    retryTotalWaitMs: (options.profile.retryMaxTotalWaitMinutes ?? 10) * 60 * 1000,
                    // Forward backend-busy retry waits to the chat panel
                    // status line (`AnthropicHandler._onStatusUpdate` is the
                    // existing channel the panel already subscribes to) and
                    // mirror them into the live-trail so the user sees the error.
                    onRetryStatus: (text: string, cause?: string): void => {
                        this._onStatusUpdate.fire(text);
                        liveTrail?.appendRetry(text, cause);
                    },
                });
                lastText = result.text || lastText;
                this.rememberAssistantText(lastText);

                if (!result.toolCalls || result.toolCalls.length === 0) {
                    lastStopReason = 'end_turn';
                    return this.finalize(
                        userContent,
                        lastText,
                        turn + 1,
                        totalToolCalls,
                        lastStopReason,
                        windowId,
                        requestId,
                        quest,
                        configuration,
                        options.isolated === true,
                        effectiveUserText,
                        liveTrail,
                    );
                }

                // Append assistant turn with tool_calls so Ollama sees the
                // conversation shape the next round expects.
                messages.push({
                    role: 'assistant',
                    content: result.text || '',
                    // eslint-disable-next-line @typescript-eslint/naming-convention
                    tool_calls: result.toolCalls,
                });

                // Execute each tool through the Anthropic approval gate
                // so the user's approval rules + trail writers apply
                // identically across leaves.
                for (const tc of result.toolCalls) {
                    totalToolCalls++;
                    const toolUseId = `local_${requestId}_${totalToolCalls}`;
                    const toolUseBlock = {
                        type: 'tool_use' as const,
                        id: toolUseId,
                        name: tc.function.name,
                        input: tc.function.arguments ?? {},
                        caller: { type: 'direct' as const },
                    } as unknown as Extract<AnthropicContentBlock, { type: 'tool_use' }>;
                    const toolResultBlock = await this.runTool(
                        toolUseBlock,
                        tools,
                        configuration,
                        options,
                        round,
                        quest,
                        windowId,
                        requestId,
                        liveTrail,
                    );
                    // runTool returns content as a string (see its
                    // implementation — the synthesised result block's
                    // `content` is always the tool's string output).
                    const resultText = typeof toolResultBlock.content === 'string'
                        ? toolResultBlock.content
                        : Array.isArray(toolResultBlock.content)
                            ? toolResultBlock.content
                                .map((p) => (p && typeof p === 'object' && 'type' in p && p.type === 'text' && 'text' in p ? String(p.text) : ''))
                                .join('')
                            : '';
                    messages.push({ role: 'tool', content: resultText });
                }
            }

            // Exhausted maxRounds — finalize with whatever text we have.
            lastStopReason = 'max_tokens';
            return this.finalize(
                userContent,
                lastText,
                configuration.maxRounds,
                totalToolCalls,
                lastStopReason,
                windowId,
                requestId,
                quest,
                configuration,
                options.isolated === true,
                effectiveUserText,
                liveTrail,
            );
        } catch (err) {
            const errMsg = err instanceof Error ? (err.stack || err.message) : String(err);
            const body = lastText
                ? `${lastText}\n\n---\n(Local LLM request errored after partial output)\n${errMsg}`
                : `(Local LLM request failed before completing)\n${errMsg}`;
            TrailService.instance.writeRawAnswer(ANTHROPIC_SUBSYSTEM, body, windowId, requestId, quest);
            const wasInterrupted = options.cancellationToken?.isCancellationRequested === true;
            const summaryAnswer = wasInterrupted
                ? (lastText ? `${lastText}\n\n(interrupted)` : '(interrupted)')
                : (lastText ? `${lastText}\n\n(error: ${err instanceof Error ? err.message : String(err)})` : `(error: ${err instanceof Error ? err.message : String(err)})`);
            TrailService.instance.writeSummaryAnswer(ANTHROPIC_SUBSYSTEM, summaryAnswer, { requestId, model: configuration.model }, quest);
            closeLiveTrailForThrown(liveTrail, err, errMsg);
            throw err;
        }
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
        /**
         * Raw user text for the summary prompt trail. Must be the user's
         * pure input — no template expansion, no tool-history block, no
         * userPromptWrapper. The `.userprompt.md` raw trail keeps the
         * fully-decorated `userContent` (audit record of what the model
         * saw); the summary `.anthropic.prompts.md` records only what the
         * user typed. Falls back to `userContent` for legacy callers.
         */
        rawUserText?: string,
        /**
         * Per-call live-trail writer for this send. `null` when the send
         * is isolated (sub-agent run) — in that case nothing is written
         * to the parent quest's live-trail.md. Threaded through from
         * sendMessage so sub-agent runs never stomp on the parent's
         * writer.
         */
        liveTrail?: LiveTrailWriter | null,
    ): AnthropicSendResult {
        const userTextForSummary = rawUserText ?? userContent;
        this.rememberAssistantText(text);
        // Never write a truly empty answer body to the trail — either
        // the text the model produced, or a short diagnostic line so
        // the `.answer.json` file is always informative.
        const trailBody = text && text.length > 0
            ? text
            : `(no text produced — stop_reason: ${stopReason ?? 'unknown'}, turns: ${turnsUsed})`;
        TrailService.instance.writeRawAnswer(
            ANTHROPIC_SUBSYSTEM,
            trailBody,
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

        // Write the summary answer. The matching prompt entry was already
        // written at the top of sendMessage() before the API call, so only
        // the answer half is needed here.
        TrailService.instance.writeSummaryAnswer(
            ANTHROPIC_SUBSYSTEM,
            text,
            { requestId, model: configuration.model },
            quest,
        );

        // Accumulate this exchange into rawTurns, then schedule the
        // background compaction + memory extraction passes for the next
        // turn. Isolated sub-agent runs skip this so the parent
        // conversation is unaffected by their intermediate reasoning.
        if (!isolated) {
            const userMsg: ConversationMessage = { role: 'user', content: userContent };
            const assistantMsg: ConversationMessage = { role: 'assistant', content: text };
            const questId = TwoTierMemoryService.instance.currentQuest();
            const caps = this.resolveEffectiveCaps(configuration);
            // The accumulator file grows on every round (cleared on
            // compaction success). The rolling-tail file is capped
            // at `rawTurnsKept`. Both files plus the in-memory union
            // are updated in one call.
            this.persistRoundAndReloadUnion([userMsg, assistantMsg], questId, caps.rawTurnsKept);
            this.persistSessionHistory(questId);
            this.scheduleBackgroundCompactionAndExtraction([userMsg, assistantMsg], false, configuration);
        }

        // Close the live-trail block for this turn. `endPrompt` emits
        // the ✅ DONE line with rounds + tool-call count so the user
        // sees when the turn is complete.
        liveTrail?.endPrompt({ rounds: turnsUsed, toolCalls: toolCallCount });

        return { text, turnsUsed, toolCallCount, stopReason };
    }

    /**
     * Fire-and-forget background work after a completed exchange:
     *   1. Run an incremental compaction pass so the compacted summary
     *      absorbs the just-completed turn. Trims rawTurns to the last
     *      `maxRounds * 2`.
     *   2. If `runMemoryExtractionOnCompaction` is enabled, run a memory
     *      extraction pass over the last turn + current summary +
     *      existing memory so durable facts move into the quest memory
     *      file.
     *
     * Both promises are stored on the handler so the next sendMessage
     * can await them and show "waiting for history compaction…" /
     * "waiting for memory extraction…" in the UI.
     *
     * Sub-agent (isolated) runs skip this entirely — their ephemeral
     * conversation must not leak into the parent session's state.
     */
    private scheduleBackgroundCompactionAndExtraction(
        lastExchange: ConversationMessage[],
        isolated: boolean,
        configuration?: AnthropicConfiguration,
    ): void {
        if (isolated) { return; }
        // Two-tier kill-switch:
        //   1. Per-configuration override wins when set. `'on'` forces
        //      compaction to run even if the global flag disables it;
        //      `'off'` forces it to be skipped even if the global flag
        //      enables it.
        //   2. Otherwise (undefined / 'default') fall back to the global
        //      `compaction.disabled` checkbox on the status page.
        // In both cases, disabling only suppresses the extra compaction
        // + memory-extraction API call; rawTurns and history.json still
        // get written.
        const override = configuration?.compactionOverride;
        if (override === 'off') { return; }
        const cfg = this.getCompactionConfig();
        if (override !== 'on' && cfg.disabled) { return; }
        // Round-based trigger (spec — `compaction.runEveryNRounds`).
        // Now driven by the accumulator file (`compactionRounds`): when
        // it holds at least `runEveryNRounds` rounds, compaction fires
        // and the file CLEARS entirely. The rolling tail (`rawTurnsRolling`)
        // is untouched by compaction so the very next outgoing prompt
        // still has fresh complete-fidelity context.
        const roundCount = this.compactionRounds.length;
        if (roundCount < cfg.runEveryNRounds) {
            // Threshold not reached — `lastExchange` stays in the
            // accumulator and is folded with the rest of the batch
            // when the next firing comes around.
            return;
        }
        // Fold the entire accumulator. Under the new model there's no
        // "tail to spare" — the rolling tail file already keeps the
        // most recent rounds; the accumulator goes to zero on success.
        const batch = roundsToRawTurns(this.compactionRounds);
        const questId = TwoTierMemoryService.instance.currentQuest();
        // Compaction runs first; memory extraction reads `compactedSummaryText`
        // so it benefits from any just-written blocks. Each pass is a
        // separate promise so sendMessage can await them independently
        // and emit precise status updates.
        this.compactionInFlight = this.runCompactionInBackground(batch, questId, configuration)
            .finally(() => { this.compactionInFlight = null; });
        this.memoryExtractionInFlight = (async () => {
            try {
                // Chain so memory extraction sees the freshly updated
                // blocks. If compaction failed we still run extraction
                // against whatever blocks we had before.
                if (this.compactionInFlight) {
                    try { await this.compactionInFlight; } catch { /* already handled */ }
                }
                await this.runMemoryExtractionInBackground(batch, questId, configuration);
            } catch {
                // swallowed
            }
        })().finally(() => { this.memoryExtractionInFlight = null; });
        // Silence the unused-param warning — `lastExchange` is preserved
        // in the signature for callers that still pass the just-completed
        // round (useful for future per-exchange instrumentation), but
        // the scheduler now derives the batch from the accumulator.
        void lastExchange;
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
        liveTrail: LiveTrailWriter | null,
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
            // Session-wide elevation is handled at the approval bar —
            // handleApprovalResponse adds the tool to sessionApprovals
            // when the user clicks "Allow All (session)".
        }

        TrailService.instance.writeRawToolRequest(
            ANTHROPIC_SUBSYSTEM,
            { id: block.id, name: block.name, input },
            windowId,
            quest,
        );

        anthropicOutput.logToolRequest(block.name, input);

        // Peek the key the ToolTrail will assign when we `add()` this
        // call after execution — so the live-trail tool_use heading
        // carries the replay key the user will see under
        // `tomAi_readPastToolResult({ key })`.
        const nextToolKey = this.toolTrail.peekNextKey();
        liveTrail?.beginToolCall(block.name, input, nextToolKey);

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

        const addedEntry = this.toolTrail.add({
            timestamp: new Date().toISOString().slice(11, 19),
            round,
            toolName: block.name,
            inputSummary,
            result,
            durationMs,
            error,
        });
        // Map the Anthropic tool_use id to the ToolTrail key so the
        // retention-policy walker (which only sees `tool_use_id` on the
        // tool_result block) can produce the right stub later.
        this.toolUseIdToKey.set(block.id, addedEntry.key);

        // Live-trail the result so the MD Browser shows the tool's
        // output immediately after the tool_use block it goes with.
        liveTrail?.appendToolResult(result, result.length);

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
    private buildSystemSegments(
        profile: AnthropicProfile,
        _questId?: string,
        extras?: { toolHistory?: string },
    ): string[] {
        // Memory injection is opt-in. By default the profile must
        // reference `${memory}` / `${memory-shared}` / `${memory-quest}`
        // explicitly in its `systemPrompt` (or a user-message template /
        // userPromptWrapper) to include a memory block.
        //
        // When `profile.autoInjectMemory === true`, we append `${memory}`
        // to the system prompt before placeholder resolution so the user
        // doesn't have to remember to add it. The placeholder resolver
        // reads `anthropic.memory.maxInjectedTokens` for the char budget.
        //
        // `${toolHistory}` is resolved from the caller's `extras` — it's
        // the compact YAML-style rendering of the last ~25 tool calls in
        // the ring buffer. Empty on Agent SDK (the SDK manages its own
        // tool context) and on the first turn of a session.
        const promptSource = profile.autoInjectMemory === true
            ? `${profile.systemPrompt ?? ''}\n\n## Memory\n\n\${memory}`
            : (profile.systemPrompt ?? '');
        const segments: string[] = [];
        const base = resolveVariables(promptSource, {
            values: {
                toolHistory: extras?.toolHistory ?? '',
            },
        });
        if (base) { segments.push(base); }
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

    /**
     * Expand the configured user-message template (if any) around the
     * current user text.
     *
     * In addition to `${userMessage}` (the raw user text), the template
     * can reference:
     *
     *   ${compactedSummary}  — running session summary (empty on first turn)
     *   ${rawTurns}          — last N user/assistant exchanges formatted
     *   ${rawTurnCount}      — number of messages in `${rawTurns}`
     *
     * These extras are the entire reason the `default-memory-injection`
     * user-message template works for Agent SDK calls: the SDK doesn't
     * accept a messages[] array, so the only way to hand it prior
     * context is via this prompt-prepended blob.
     */
    private buildUserMessage(
        options: AnthropicSendOptions,
        extras?: { compactedSummary?: string; rawTurns?: ConversationMessage[]; toolHistory?: string },
    ): string {
        const compactedSummary = extras?.compactedSummary ?? '';
        const rawTurns = extras?.rawTurns ?? [];
        const rawTurnsFormatted = rawTurns
            .map((m) => `[${m.role}] ${typeof m.content === 'string' ? m.content : String(m.content ?? '')}`)
            .join('\n\n');
        const toolHistory = extras?.toolHistory ?? '';

        // Stage 1: expand userMessageTemplate (if any) around the raw
        // user text via ${userMessage}. When no template is set, the
        // wrapped prompt is the raw text itself.
        const template = options.userMessageTemplate;
        const wrappedPrompt = template
            ? resolveVariables(template, {
                values: {
                    userMessage: options.userText,
                    compactedSummary,
                    rawTurns: rawTurnsFormatted,
                    rawTurnCount: String(rawTurns.length),
                    toolHistory,
                },
            })
            : options.userText;

        // Stage 2: expand profile.userPromptWrapper around wrappedPrompt
        // via ${wrappedPrompt}. This is the "system-like injection at
        // the user-prompt layer" slot — lets a profile attach context
        // (memory, role banner, etc.) without touching the system
        // prompt, so prompt caching on the system prefix keeps hitting.
        const profile = options.profile as AnthropicProfile & { userPromptWrapper?: string };
        const wrapper = profile?.userPromptWrapper;
        if (!wrapper || !wrapper.includes('${wrappedPrompt}')) {
            return wrappedPrompt;
        }
        return resolveVariables(wrapper, {
            values: {
                wrappedPrompt,
                userMessage: options.userText,
                compactedSummary,
                rawTurns: rawTurnsFormatted,
                rawTurnCount: String(rawTurns.length),
                toolHistory,
            },
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
