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
 * Build the full-payload markdown dump (system + tools + rolling history +
 * current user message) written alongside the `.userprompt.md` file. Rolling
 * history entries are summarized (role + char count + first ~200 chars) so
 * the file stays compact on long sessions while still letting you see what
 * shape of history went out — the per-turn raw trail already has the full
 * text for each exchange, and the request ids correlate.
 */
function buildPayloadDump(params: {
    requestId: string;
    transport: 'direct' | 'agentSdk';
    configuration: AnthropicConfiguration;
    profile: AnthropicProfile;
    systemPrompt: string;
    tools: SharedToolDefinition[];
    history: ConversationMessage[];
    userContent: string;
    effectiveCaching: boolean;
    thinkingBudgetTokens?: number;
    useBuiltInTools?: boolean;
    compactedSummary?: string;
}): string {
    const { requestId, transport, configuration, profile, systemPrompt, tools, history, userContent, compactedSummary } = params;
    const lines: string[] = [];

    lines.push('# Anthropic API payload');
    lines.push('');
    lines.push(`- requestId: \`${requestId}\``);
    lines.push(`- transport: \`${transport}\``);
    lines.push(`- profile: \`${profile.id}\` (${profile.name})`);
    lines.push(`- configuration: \`${configuration.id}\` → model \`${configuration.model}\``);
    lines.push(`- maxTokens: ${configuration.maxTokens}, maxRounds: ${configuration.maxRounds}`);
    if (typeof configuration.temperature === 'number') {
        lines.push(`- temperature: ${configuration.temperature}`);
    }
    lines.push(`- promptCachingEnabled (effective): ${params.effectiveCaching}`);
    if (params.thinkingBudgetTokens !== undefined) {
        lines.push(`- thinking.budget_tokens: ${params.thinkingBudgetTokens}`);
    }
    if (transport === 'agentSdk') {
        lines.push(`- useBuiltInTools: ${params.useBuiltInTools === true}`);
        lines.push(`- agentSdk.permissionMode: ${configuration.agentSdk?.permissionMode ?? 'default'}`);
        lines.push(`- agentSdk.settingSources: ${(configuration.agentSdk?.settingSources ?? []).join(', ') || '(isolation mode)'}`);
    }
    lines.push(`- toolApprovalMode: ${profile.toolApprovalMode ?? 'always'}`);
    lines.push('');

    lines.push(`## System prompt (${systemPrompt.length} chars)`);
    lines.push('');
    lines.push('```text');
    lines.push(systemPrompt);
    lines.push('```');
    lines.push('');

    lines.push(`## Tools (${tools.length})`);
    lines.push('');
    if (tools.length === 0) {
        lines.push('_(none)_');
    } else {
        for (const t of tools) {
            lines.push(`- \`${t.name}\``);
        }
    }
    lines.push('');

    lines.push(`## Raw turns (${history.length} messages — sent verbatim)`);
    lines.push('');
    if (history.length === 0) {
        lines.push('_(empty — first turn of the session or just after a clear)_');
    } else {
        for (let i = 0; i < history.length; i++) {
            const m = history[i];
            const content = typeof m.content === 'string' ? m.content : String(m.content ?? '');
            const head = content.slice(0, 200).replace(/\s+/g, ' ').trim();
            const tail = content.length > 200 ? ' …' : '';
            lines.push(`- **[${i}] ${m.role}** — ${content.length} chars`);
            lines.push(`  > ${head}${tail}`);
        }
    }
    lines.push('');

    // The compacted summary is injected into the wire payload *after* the
    // raw turns and *before* the current user message. Show the actual
    // content here (it tends to be a few KB — small enough not to
    // dominate the file, and this is the only place the reconstructed
    // summary is visible).
    lines.push(`## Compacted summary (${(compactedSummary ?? '').length} chars — injected after raw turns)`);
    lines.push('');
    if (!compactedSummary) {
        lines.push('_(empty — no turns have been compacted yet, or session was just cleared)_');
    } else {
        lines.push('```text');
        lines.push(compactedSummary);
        lines.push('```');
    }
    lines.push('');

    lines.push(`## Current user message (${userContent.length} chars)`);
    lines.push('');
    lines.push('```text');
    lines.push(userContent);
    lines.push('```');
    lines.push('');

    return lines.join('\n');
}

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

function isConversationMessage(m: unknown): m is ConversationMessage {
    return !!m && typeof m === 'object' &&
        ((m as ConversationMessage).role === 'user' ||
         (m as ConversationMessage).role === 'assistant' ||
         (m as ConversationMessage).role === 'system') &&
        typeof (m as ConversationMessage).content === 'string';
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
     * Session history is split into two parallel fields:
     *
     *   - `compactedSummary` — a single running summary of everything that
     *     happened before the last few raw turns. Updated by a background
     *     local-LLM compaction call after every exchange; initially empty
     *     and seeded from disk on the first send. Sent to the model as a
     *     synthetic user/assistant pair positioned *after* the raw turns
     *     (so the most recent complete-fidelity turns come first).
     *   - `rawTurns` — user/assistant messages kept verbatim, trimmed to
     *     the last `compactionMaxRounds * 2` messages after each
     *     compaction pass so older turns are never duplicated in the wire
     *     payload (they live in the summary already).
     */
    private compactedSummary: string = '';
    private rawTurns: ConversationMessage[] = [];
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

    /** Clear all in-session state (compacted summary, raw turns, tool trail, session-mode approvals, persisted SDK session id). */
    clearSession(): void {
        this.compactedSummary = '';
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
            const windowId = vscode.env.sessionId;
            const quest = TwoTierMemoryService.instance.currentQuest();
            TwoTierMemoryService.instance.clearAgentSdkSessionId(windowId, quest);
        } catch { /* best-effort */ }
    }

    /**
     * Seed the split state from the most recent
     * `_ai/quests/<quest>/history/<ts>.history.json` — called at the start
     * of the first `sendMessage()` for multi-session continuity. The
     * snapshot stores `{ compactedSummary, rawTurns }`; legacy snapshots
     * that stored a flat `ConversationMessage[]` still load (folded into
     * rawTurns with an empty summary).
     *
     * When no snapshot exists, a trail-based rebuild (parsing the quest's
     * `<quest>.anthropic.prompts.md` + `.answers.md` files) is kicked off
     * as fire-and-forget; subsequent sendMessage() calls await the
     * rebuild via historyRebuildInFlight.
     */
    private seedHistoryFromSnapshot(questId: string): void {
        if (this.historySeeded) {
            return;
        }
        this.historySeeded = true;
        try {
            const raw = TwoTierMemoryService.instance.loadLatestHistorySnapshot<unknown>(questId);
            // New shape: { compactedSummary: string, rawTurns: ConversationMessage[] }
            if (raw && typeof raw === 'object' && !Array.isArray(raw)) {
                const obj = raw as { compactedSummary?: unknown; rawTurns?: unknown };
                if (typeof obj.compactedSummary === 'string') {
                    this.compactedSummary = obj.compactedSummary;
                }
                if (Array.isArray(obj.rawTurns)) {
                    this.rawTurns = obj.rawTurns.filter(isConversationMessage);
                }
                return;
            }
            // Legacy shape: flat ConversationMessage[].
            if (Array.isArray(raw) && raw.length > 0) {
                this.rawTurns = raw.filter(isConversationMessage);
                return;
            }
            // No snapshot — kick off trail-based rebuild if prompts.md/answers.md
            // exist. The first user send after this point will await
            // historyRebuildInFlight with a "Rebuild history from last N
            // prompts…" status update.
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
    getSessionState(): { compactedSummary: string; rawTurns: ConversationMessage[] } {
        return { compactedSummary: this.compactedSummary, rawTurns: [...this.rawTurns] };
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
     * Serialize the split state to the quest-folder history file. Always
     * overwrites `history.json`; when the compaction config has
     * `archiveHistoryEveryTurn` on, also writes a timestamped copy.
     */
    private persistSessionHistory(questId: string | undefined): void {
        try {
            const archive = this.getCompactionConfig().archiveHistoryEveryTurn;
            TwoTierMemoryService.instance.persistHistorySnapshot(
                { compactedSummary: this.compactedSummary, rawTurns: this.rawTurns },
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
        llmProvider: 'localLlm' | 'anthropic';
        llmConfigId: string;
        compactionTemplateId?: string;
        memoryExtractionTemplateId?: string;
        compactionMaxRounds: number;
        maxHistoryTokens: number;
        fullTrailMaxTurns: number;
        runMemoryExtractionOnCompaction: boolean;
        rebuildFromLastNPrompts: number;
        archiveHistoryEveryTurn: boolean;
    } {
        const section = TomAiConfiguration.instance.getSection<{
            llmProvider?: 'localLlm' | 'anthropic';
            llmConfigId?: string;
            compactionTemplateId?: string;
            memoryExtractionTemplateId?: string;
            compactionMaxRounds?: number;
            maxHistoryTokens?: number;
            fullTrailMaxTurns?: number;
            runMemoryExtractionOnCompaction?: boolean;
            rebuildFromLastNPrompts?: number;
            archiveHistoryEveryTurn?: boolean;
        }>('compaction') ?? {};
        return {
            llmProvider: section.llmProvider === 'anthropic' ? 'anthropic' : 'localLlm',
            llmConfigId: section.llmConfigId ?? '',
            compactionTemplateId: section.compactionTemplateId,
            memoryExtractionTemplateId: section.memoryExtractionTemplateId,
            compactionMaxRounds: Number.isFinite(section.compactionMaxRounds) ? (section.compactionMaxRounds as number) : 4,
            maxHistoryTokens: Number.isFinite(section.maxHistoryTokens) ? (section.maxHistoryTokens as number) : 8000,
            fullTrailMaxTurns: Number.isFinite(section.fullTrailMaxTurns) ? (section.fullTrailMaxTurns as number) : 200,
            runMemoryExtractionOnCompaction: section.runMemoryExtractionOnCompaction !== false,
            rebuildFromLastNPrompts: Number.isFinite(section.rebuildFromLastNPrompts) ? (section.rebuildFromLastNPrompts as number) : 200,
            archiveHistoryEveryTurn: section.archiveHistoryEveryTurn === true,
        };
    }

    /**
     * Run one compaction pass in the background, integrating the just-
     * completed exchange into the existing compacted summary. Updates
     * `this.compactedSummary` and trims `this.rawTurns` when done.
     *
     * Compaction is expected to be faster than the Anthropic round-trip
     * in the common case (small local LLM summarising a single exchange),
     * but may be slower on bigger models — which is why sendMessage
     * awaits `compactionInFlight` before sending the next turn.
     */
    private runCompactionInBackground(
        lastExchange: ConversationMessage[],
        questId: string | undefined,
    ): Promise<void> {
        const cfg = this.getCompactionConfig();
        if (!cfg.llmConfigId) {
            return Promise.resolve();
        }
        return (async () => {
            try {
                const existingSummary = this.compactedSummary;
                const { runIncrementalCompaction } = await import('../services/history-compaction.js');
                const newSummary = await runIncrementalCompaction({
                    existingSummary,
                    lastTurn: lastExchange,
                    llmProvider: cfg.llmProvider,
                    llmConfigId: cfg.llmConfigId,
                    compactionTemplateId: cfg.compactionTemplateId,
                    maxHistoryTokens: cfg.maxHistoryTokens,
                    questId,
                });
                if (typeof newSummary === 'string' && newSummary.trim().length > 0) {
                    this.compactedSummary = newSummary.trim();
                }
                // Trim raw turns so we only keep the last `maxRounds * 2`
                // messages in memory. Older turns are already baked into
                // `compactedSummary`.
                const keep = Math.max(2, cfg.compactionMaxRounds * 2);
                if (this.rawTurns.length > keep) {
                    this.rawTurns = this.rawTurns.slice(-keep);
                }
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
    ): Promise<void> {
        const cfg = this.getCompactionConfig();
        if (!cfg.runMemoryExtractionOnCompaction || !cfg.llmConfigId) {
            return Promise.resolve();
        }
        return (async () => {
            try {
                const { runIncrementalMemoryExtraction } = await import('../services/history-compaction.js');
                await runIncrementalMemoryExtraction({
                    lastTurn: lastExchange,
                    compactedSummary: this.compactedSummary,
                    llmProvider: cfg.llmProvider,
                    llmConfigId: cfg.llmConfigId,
                    memoryTemplateId: cfg.memoryExtractionTemplateId,
                    questId,
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
    private async rebuildHistoryFromTrail(questId: string): Promise<void> {
        try {
            const cfg = this.getCompactionConfig();
            const limit = Math.max(1, cfg.rebuildFromLastNPrompts);
            const { loadLastNTrailExchanges } = await import('../services/history-compaction.js');
            const exchanges = loadLastNTrailExchanges(questId, limit);
            if (exchanges.length === 0) {
                return;
            }
            // Keep the last N turns raw; any extra gets folded into the
            // summary so the next turn's payload stays small.
            const rawLimit = Math.max(2, cfg.compactionMaxRounds * 2);
            const flat: ConversationMessage[] = [];
            for (const pair of exchanges) {
                if (pair.user) { flat.push({ role: 'user', content: pair.user }); }
                if (pair.assistant) { flat.push({ role: 'assistant', content: pair.assistant }); }
            }
            if (flat.length <= rawLimit) {
                this.rawTurns = flat;
            } else {
                this.rawTurns = flat.slice(-rawLimit);
                // Fold the older prefix into the summary.
                const older = flat.slice(0, flat.length - rawLimit);
                if (older.length > 0 && cfg.llmConfigId) {
                    try {
                        const { runIncrementalCompaction } = await import('../services/history-compaction.js');
                        const summary = await runIncrementalCompaction({
                            existingSummary: '',
                            lastTurn: older,
                            llmProvider: cfg.llmProvider,
                            llmConfigId: cfg.llmConfigId,
                            compactionTemplateId: cfg.compactionTemplateId,
                            maxHistoryTokens: cfg.maxHistoryTokens,
                            questId,
                        });
                        if (typeof summary === 'string') { this.compactedSummary = summary.trim(); }
                    } catch {
                        // leave compactedSummary empty
                    }
                }
            }
            this.persistSessionHistory(questId);
        } catch {
            // best-effort — empty history is a safe fallback
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

        // Agent SDK path: no memory injection into the system prompt (§18.4).
        // The agent pulls memory via `tomAi_memory_*` tools on demand.
        const systemSegments = transport === 'agentSdk'
            ? [profile.systemPrompt ?? ''].filter((s): s is string => !!s)
            : this.buildSystemSegments(profile, quest);
        const systemPrompt = systemSegments.filter((s) => s).join('\n\n');
        // Effective history mode for this call. Agent SDK configs may use
        // 'sdk-managed' (SDK session resumption); 'full' / 'trim_and_summary'
        // on either transport triggers our own history injection. Direct
        // transport defaults to trim_and_summary.
        const rawHistoryMode = configuration.historyMode as string | undefined;
        const effectiveHistoryMode: 'sdk-managed' | 'full' | 'summary' | 'trim_and_summary' | 'llm_extract' =
            rawHistoryMode === 'sdk-managed' ? 'sdk-managed'
                : rawHistoryMode === 'full' ? 'full'
                : rawHistoryMode === 'summary' ? 'summary'
                : rawHistoryMode === 'llm_extract' ? 'llm_extract'
                : 'trim_and_summary';
        // When a user-message template is set AND the history mode wants
        // us to inject our own history (anything except sdk-managed),
        // expose ${compactedSummary} and ${rawTurns} so a
        // memory-injection template can prepend them to the user prompt.
        // Only really used on the Agent SDK path — the direct path builds
        // rawTurns into messages[] separately.
        const shouldExposeOurHistory = effectiveHistoryMode !== 'sdk-managed' && !options.isolated;
        const expandedUser = this.buildUserMessage(
            { ...options, userText: effectiveUserText },
            shouldExposeOurHistory
                ? { compactedSummary: this.compactedSummary, rawTurns: this.rawTurns }
                : undefined,
        );
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
                compactedSummary: this.compactedSummary,
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
            const resumeSessionId = useSdkManagedContinuity
                ? TwoTierMemoryService.instance.loadAgentSdkSessionId(windowId, quest)
                : undefined;

            const result = await runAgentSdkQuery({
                configuration,
                tools: effectiveTools,
                systemPrompt,
                userText: userContent,
                cancellationToken: options.cancellationToken,
                toolApprovalMode: profile.toolApprovalMode ?? 'always',
                useBuiltInTools: profile.useBuiltInTools === true,
                thinkingBudgetTokens: profile.thinkingEnabled ? (profile.thinkingBudgetTokens ?? 8192) : undefined,
                resumeSessionId,
                autoLoadProjectSettings: useSdkManagedContinuity,
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

            // Persist the session id so the next call can resume it.
            // Only in sdk-managed mode — the other modes don't rely on
            // SDK continuity and persisting would leak stale ids.
            if (useSdkManagedContinuity && result.sessionId) {
                TwoTierMemoryService.instance.saveAgentSdkSessionId(
                    windowId,
                    result.sessionId,
                    quest,
                    configuration.model,
                );
            }

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

            // The Agent SDK runs its own context compaction, but we still
            // append to rawTurns so continuity carries across
            // direct/agentSdk transport switches in the same session. We
            // also schedule our own background compaction + memory
            // extraction so the compacted summary and memory files stay
            // up to date regardless of transport.
            if (!options.isolated) {
                const userMsg: ConversationMessage = { role: 'user', content: userContent };
                const assistantMsg: ConversationMessage = { role: 'assistant', content: result.text };
                this.rawTurns.push(userMsg, assistantMsg);
                // Persist the raw-turn append immediately (same as the
                // direct-transport finalize()). Without this, the
                // history.json / history.md files only get the new turn
                // once background compaction completes, so inspecting
                // the files right after a send can show a stale
                // user-only view.
                this.persistSessionHistory(TwoTierMemoryService.instance.currentQuest());
                this.scheduleBackgroundCompactionAndExtraction([userMsg, assistantMsg], false);
            }
            return result;
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
        const summaryBlock: AnthropicMessageParam[] = (!options.isolated && this.compactedSummary)
            ? [
                {
                    role: 'user',
                    content: `## Additional context (compacted from earlier turns)\n\n${this.compactedSummary}`,
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

        // Accumulate this exchange into rawTurns, then schedule the
        // background compaction + memory extraction passes for the next
        // turn. Isolated sub-agent runs skip this so the parent
        // conversation is unaffected by their intermediate reasoning.
        if (!isolated) {
            const userMsg: ConversationMessage = { role: 'user', content: userContent };
            const assistantMsg: ConversationMessage = { role: 'assistant', content: text };
            this.rawTurns.push(userMsg, assistantMsg);
            // Persist the raw-turn append *now* (before compaction
            // finishes) so a crash during compaction doesn't lose this
            // exchange.
            this.persistSessionHistory(TwoTierMemoryService.instance.currentQuest());
            this.scheduleBackgroundCompactionAndExtraction([userMsg, assistantMsg], false);
        }

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
    ): void {
        if (isolated) { return; }
        const questId = TwoTierMemoryService.instance.currentQuest();
        // Compaction runs first; memory extraction reads `this.compactedSummary`
        // so it benefits from any just-written summary. Each pass is a
        // separate promise so sendMessage can await them independently
        // and emit precise status updates.
        this.compactionInFlight = this.runCompactionInBackground(lastExchange, questId)
            .finally(() => { this.compactionInFlight = null; });
        this.memoryExtractionInFlight = (async () => {
            try {
                // Chain so memory extraction sees the freshly updated
                // compactedSummary. If compaction failed we still run
                // extraction against whatever summary we had before.
                if (this.compactionInFlight) {
                    try { await this.compactionInFlight; } catch { /* already handled */ }
                }
                await this.runMemoryExtractionInBackground(lastExchange, questId);
            } catch {
                // swallowed
            }
        })().finally(() => { this.memoryExtractionInFlight = null; });
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
    private buildSystemSegments(profile: AnthropicProfile, _questId?: string): string[] {
        // Memory injection is no longer automatic. Drop `${memory}`,
        // `${memory-shared}`, or `${memory-quest}` into the profile's
        // system prompt (or a user-message template — usually better
        // for prompt caching) to include a memory block. The placeholder
        // resolver reads anthropic.memory.maxInjectedTokens for the
        // char budget.
        const segments: string[] = [];
        const base = resolveVariables(profile.systemPrompt ?? '');
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
        extras?: { compactedSummary?: string; rawTurns?: ConversationMessage[] },
    ): string {
        const compactedSummary = extras?.compactedSummary ?? '';
        const rawTurns = extras?.rawTurns ?? [];
        const rawTurnsFormatted = rawTurns
            .map((m) => `[${m.role}] ${typeof m.content === 'string' ? m.content : String(m.content ?? '')}`)
            .join('\n\n');

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
