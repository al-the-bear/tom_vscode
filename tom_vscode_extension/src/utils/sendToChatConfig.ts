/**
 * Send-To-Chat Configuration Module
 *
 * This module is intentionally isolated from variableResolver.ts to avoid
 * circular dependencies. Both handler_shared.ts and variableResolver.ts
 * can safely import from this module.
 *
 * For path resolution, this module uses simple home directory expansion
 * rather than the full variable resolver.
 */

import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs';
import * as os from 'os';
import { WsPaths } from './workspacePaths';
import { TomAiConfiguration } from './tomAiConfiguration';
import { logConfigAccess } from './toolLog';

// ============================================================================
// Configuration Interface
// ============================================================================

export interface SendToChatConfig {
    localLlm: {
        profiles: { [key: string]: {
            label: string;
            systemPrompt?: string | null;
            resultTemplate?: string | null;
            temperature?: number | null;
            modelConfig?: string | null;
            /** When true (default), expose every tool in ALL_SHARED_TOOLS. When false, use enabledTools (or fall back to no tools). */
            toolsEnabled?: boolean;
            /** Profile-level tool subset; honored when toolsEnabled === false. */
            enabledTools?: string[];
            /** Optional override for the model-level history/turn cap. */
            maxRounds?: number;
            historyMode?: string;
            stripThinkingTags?: boolean | null;
            isDefault?: boolean;
            /**
             * Suffix for the per-profile history snapshot files in
             * `_ai/quests/<quest>/history/`. When set, the manager
             * reads/writes `history-<historySuffix>.{json,md}` instead
             * of the canonical `history.{json,md}` pair. Leaves the
             * Anthropic handler's snapshot untouched so the two panels
             * can run in parallel without clobbering each other.
             */
            historySuffix?: string;
            /**
             * Suffix for the per-profile memory file. When set, the
             * `${memory}` placeholder injects only `facts-<memorySuffix>.md`
             * from each scope (shared + current quest). Default
             * (omitted): inject every file in the scope, matching the
             * legacy Anthropic-side behaviour.
             */
            memorySuffix?: string;
            /**
             * When true, append `\n\n## Memory\n\n${memory}` to the
             * resolved system prompt automatically so the profile
             * doesn't have to spell out the placeholder. Mirrors
             * `AnthropicProfile.autoInjectMemory`. When false / unset,
             * memory is only injected when the profile references
             * `${memory}` / `${memory-shared}` / `${memory-quest}`
             * explicitly.
             */
            autoInjectMemory?: boolean;
        } };
        /** Default Ollama URL for LLM calls */
        ollamaUrl?: string;
        /** Default model name for LLM calls */
        model?: string;
        /** Named model configurations that can be referenced by profiles */
        models?: { [key: string]: {
            ollamaUrl?: string;
            model?: string;
            temperature?: number;
            stripThinkingTags?: boolean;
            description?: string;
            isDefault?: boolean;
            keepAlive?: string;
            /** Name of the env var holding the bearer API key (OpenAI-compatible auth). */
            apiKeyEnv?: string;
        } };
        tools?: {
            askCopilot?: unknown;
            askBigBrother?: unknown;
        };
        configurations?: Array<{
            id: string;
            name: string;
            ollamaUrl?: string;
            /** Backend protocol; defaults to `'ollama'`. Set to `'openai'` for vLLM, LM Studio, llama.cpp, etc. */
            apiStyle?: 'ollama' | 'openai';
            model?: string;
            temperature?: number;
            stripThinkingTags?: boolean;
            trailMaximumTokens?: number;
            removePromptTemplateFromTrail?: boolean;
            trailSummarizationTemperature?: number;
            trailSummarizationPrompt?: string;
            answerFolder?: string;
            logFolder?: string;
            historyMode?: string;
            enabledTools?: string[];
            isDefault?: boolean;
            keepAlive?: string;
            /** Name of the env var holding the bearer API key (OpenAI-compatible auth). */
            apiKeyEnv?: string;
            /** Max tool-call rounds when driving an Anthropic profile. Default 10. */
            maxRounds?: number;
            /** Max response tokens (`maxTokens` on the synthesised AnthropicConfiguration). Default 8192. */
            maxTokens?: number;
            /** Master switch: when `false`, no `tools` array is sent (required for vLLM without tool-call parser). Default `true`. */
            toolsEnabled?: boolean;
            /** Per-configuration override for `compaction.historyMaxChars` (chars). */
            historyMaxChars?: number;
            /** Per-configuration override for `compaction.memoryMaxChars` (chars). */
            memoryMaxChars?: number;
            /** Per-configuration override for `compaction.rawTurnsKept` (raw turn-pair count). */
            rawTurnsKept?: number;
            /** Per-configuration override for `compaction.toolTrailMaxResultChars`. */
            toolTrailMaxResultChars?: number;
            /** Per-configuration override for `compaction.toolTrailKeepRounds`. */
            toolTrailKeepRounds?: number;
            /** Per-configuration override for `compaction.maxHistoryTokens` token safety cap. */
            maxHistoryTokens?: number;
        }>;
        defaultTemplate?: string;
    };
    aiConversation: {
        profiles: { [key: string]: {
            label: string;
            description?: string;
            goal?: string;
            maxTurns?: number;
            initialPromptTemplate?: string | null;
            followUpTemplate?: string | null;
            temperature?: number | null;
        } };
        telegram?: {
            autostart?: boolean;
        };
        setups?: Array<{
            id: string;
            name: string;
            llmConfigA?: string;
            llmConfigB?: string;
            maxTurns?: number;
            pauseBetweenTurns?: boolean;
            historyMode?: string;
            trailSummarizationLlmConfig?: string;
            isDefault?: boolean;
        }>;
        defaultTemplate?: string;
    };
    tomAiChat?: {
        defaultTemplate?: string;
        templates?: { [key: string]: {
            label: string;
            description?: string;
            contextInstructions?: string;
            systemPromptOverride?: string | null;
            /** When true (default), expose every tool in ALL_SHARED_TOOLS. When false, use enabledTools. */
            toolsEnabled?: boolean;
            /** Template-level tool subset; honored when toolsEnabled === false. */
            enabledTools?: string[];
        } };
    };
    copilot?: {
        templates?: { [key: string]: { template: string; showInMenu?: boolean } };
        defaultTemplate?: string;
        answerFolder?: string;
    };

    trail?: {
        /** Max total raw trail files per quest directory before oldest are deleted (default: 1000). */
        maxRawFiles?: number;
        /** Max entries in consolidated summary trail files before trimming (default: 1000). */
        maxEntries?: number;
    };

    /**
     * Anthropic SDK integration (see anthropic_sdk_integration.md §14).
     * Partial schema — configurations/profiles/userMessageTemplates go
     * through the Global Template Editor (§7.2).
     */
    anthropic?: {
        apiKeyEnvVar?: string;
        configurations?: Array<{
            id: string;
            name: string;
            model: string;
            maxTokens?: number;
            temperature?: number;
            memoryToolsEnabled?: boolean;
            historyMode?: string;
            maxHistoryTokens?: number;
            maxRounds?: number;
            memoryExtractionTemplateId?: string;
            promptCachingEnabled?: boolean;
            /** Backend selector — anthropic_sdk_integration.md §18 and
             *  multi_transport_prompt_queue_revised.md §4.2. */
            transport?: 'direct' | 'agentSdk' | 'vscodeLm';
            /** Agent SDK options; applies when transport === 'agentSdk'. */
            agentSdk?: {
                permissionMode?: 'default' | 'acceptEdits' | 'plan' | 'bypassPermissions';
                settingSources?: Array<'user' | 'project' | 'local'>;
                maxTurns?: number;
            };
            /**
             * VS Code LM options; applies when `transport === 'vscodeLm'`.
             * Model identity is pinned at configure-time (the user picks a
             * model from the list `vscode.lm.selectChatModels()` returns),
             * so sends don't need to re-enumerate providers. See
             * multi_transport_prompt_queue_revised.md §4.2.
             */
            vscodeLm?: {
                vendor: string;        // e.g. 'copilot'
                family: string;        // e.g. 'gpt-4o' or 'claude-sonnet-4.5'
                modelId: string;       // exact id picked at configure-time
            };
            /**
             * Per-configuration override for `compaction.disabled`.
             *   undefined / 'default' — use the global checkbox.
             *   'on'  — force compaction ON (ignore global).
             *   'off' — force compaction OFF (ignore global).
             */
            compactionOverride?: 'default' | 'on' | 'off';
            /** Per-configuration override for `compaction.historyMaxChars` (chars). */
            historyMaxChars?: number;
            /** Per-configuration override for `compaction.memoryMaxChars` (chars). */
            memoryMaxChars?: number;
            /** Per-configuration override for `compaction.rawTurnsKept` (raw turn-pair count). */
            rawTurnsKept?: number;
            /** Per-configuration override for `compaction.toolTrailMaxResultChars`. */
            toolTrailMaxResultChars?: number;
            /** Per-configuration override for `compaction.toolTrailKeepRounds`. */
            toolTrailKeepRounds?: number;
            isDefault?: boolean;
        }>;
        profiles?: Array<{
            id: string;
            name: string;
            description?: string;
            systemPrompt: string;
            /**
             * Profile-level wrapper applied after `userMessageTemplate`
             * has expanded. Must include `${wrappedPrompt}`. Intended
             * for "system-like" context injection kept at the user-
             * prompt layer for prompt-caching friendliness.
             */
            userPromptWrapper?: string;
            configurationId?: string;
            toolsEnabled?: boolean;
            enabledTools?: string[];
            maxRounds?: number;
            historyMode?: string | null;
            thinkingEnabled?: boolean;
            thinkingBudgetTokens?: number;
            promptCachingEnabled?: boolean;
            toolApprovalMode?: 'always' | 'never';
            useBuiltInTools?: boolean;
            /** When true, auto-append `${memory}` to the resolved system prompt. */
            autoInjectMemory?: boolean;
            /**
             * Agent SDK only — when the agent invokes the built-in
             * `AskUserQuestion` tool, show a VS Code QuickPick per question
             * and feed the user's selections back to the model. Default
             * false: the questions are answered with the autonomous fallback
             * template instead. Requires `useBuiltInTools` and a non-`never`
             * `toolApprovalMode`. See `anthropic.interactiveQuestionsTemplates`.
             */
            allowInteractiveQuestions?: boolean;
            /** Selected fallback template id (from `anthropic.interactiveQuestionsTemplates`). Empty = built-in default. */
            interactiveQuestionsTemplateId?: string;
            isDefault?: boolean;
        }>;
        userMessageTemplates?: Array<{
            id: string;
            name: string;
            description?: string;
            template: string;
            isDefault?: boolean;
        }>;
        /** Memory subsystem cross-config defaults (anthropic_sdk_integration.md §10). */
        memory?: {
            memoryToolsEnabled?: boolean;
            memoryExtractionTemplateId?: string;
            /** Which history modes trigger background memory extraction. */
            autoExtractMode?: 'never' | 'summary' | 'trim_and_summary' | 'llm_extract' | 'all';
            maxInjectedTokens?: number;
        };
        /**
         * Agent SDK transport retry. When the SDK stream errors out, the
         * transport retries the prompt up to `maxAttempts` times. On a
         * resumable error it continues the same session with a continuation
         * prompt built from the selected template (which can inject the error
         * via `${errorText}`); when there is no session id, or the error names
         * an unknown/missing session, it repeats the original prompt on a
         * fresh session instead. See agent-sdk-transport.ts.
         */
        transportRetry?: {
            /** Total attempts including the first. Default 3; minimum 1 (no retry). */
            maxAttempts?: number;
            /**
             * Selected continuation-prompt template id (from `templates`).
             * Empty = "use default" → the template marked `isDefault`, falling
             * back to the built-in constant only when no default exists on disk.
             */
            templateId?: string;
            /** Continuation-prompt templates. Bodies typically reference `${errorText}` + `${userMessage}`. */
            templates?: Array<{
                id: string;
                name: string;
                description?: string;
                template: string;
                /**
                 * Marks the template "use default" resolves to. At most one
                 * template should carry this flag (enforced by the editor).
                 */
                isDefault?: boolean;
            }>;
        };
        /**
         * Fallback templates for the Agent SDK built-in `AskUserQuestion`
         * tool. When a profile does not allow interactive questions (or the
         * user dismisses the picker), the agent receives the selected
         * template's body as the tool result, telling it to proceed
         * autonomously. Bodies may reference `${questions}` (a digest of the
         * skipped questions). Selected per-profile via
         * `interactiveQuestionsTemplateId`. See agent-sdk-questions.ts.
         */
        interactiveQuestionsTemplates?: Array<{
            id: string;
            name: string;
            description?: string;
            template: string;
        }>;
    };

    /**
     * History compaction (see anthropic_sdk_integration.md §6 and §14).
     * Full schema pass arrives in Phase 3; Phase 2 only wires the two
     * template arrays consumed by the Global Template Editor.
     */
    compaction?: {
        /**
         * Global kill-switch. When true, suppresses the extra compaction +
         * memory-extraction API call after every Anthropic turn. rawTurns
         * and history.json are still written. Per-configuration
         * `compactionOverride` can force on/off regardless of this flag.
         */
        disabled?: boolean;
        llmProvider?: 'localLlm' | 'anthropic';
        llmConfigId?: string;
        compactionTemplateId?: string;
        memoryExtractionTemplateId?: string;
        compactionMaxRounds?: number;
        maxHistoryTokens?: number;
        /** Max chars of history content injected into compaction + memory-extraction
         *  prompts; also exposed as ${historyMaxChars} in the compaction template. */
        historyMaxChars?: number;
        /** Max chars of existing memory injected into the memory-extraction prompt. */
        memoryMaxChars?: number;
        /** Cap on turns returned in 'full' history mode (runFull). */
        fullTrailMaxTurns?: number;
        toolTrailMaxResultChars?: number;
        toolTrailKeepRounds?: number;
        /** Number of recent user/assistant turn pairs (2 messages each) kept verbatim in
         *  the prompt before incremental compaction folds them into the running summary.
         *  Per-configuration `rawTurnsKept` takes precedence. */
        rawTurnsKept?: number;
        /**
         * Round-based trigger for compaction + memory extraction. A "round"
         * is one completed user→assistant exchange. The uncompacted accumulator
         * (`compaction_rounds.json`, sibling of `history.json`) grows by one
         * round per turn; when it reaches this threshold compaction fires,
         * folds the oldest `length - rawTurnsKept` rounds into the running
         * summary, and shrinks back to `rawTurnsKept`. Memory extraction runs
         * in the same pass (controlled by `runMemoryExtractionOnCompaction`).
         *
         * Default 15. Used for both history compaction and memory extraction
         * so they share a single cadence — the prompt prefix (system +
         * compactedSummary) stays cache-stable for N-1 turns at a time.
         *
         * Also used as the chunk size when rebuilding history from trail
         * files: the trail is processed in groups of this many rounds so the
         * rebuilt summary mirrors what live operation would have produced.
         */
        runEveryNRounds?: number;
        backgroundExtractionEnabled?: boolean;
        /** Whether memory extraction runs after every compaction pass. */
        runMemoryExtractionOnCompaction?: boolean;
        /**
         * Fallback seed size when the handler finds no history file but
         * compact trail files (prompts.md / answers.md) do exist in the
         * quest folder. Default 200.
         */
        rebuildFromLastNPrompts?: number;
        /**
         * When true, each compaction pass writes a timestamped archive
         * file (`YYYYMMDD_HHMMSS.history.json`) in addition to overwriting
         * the canonical `history.json`. Off by default; useful for
         * debugging turn-by-turn changes. Produces one new file per turn
         * so leave it off for normal operation.
         */
        archiveHistoryEveryTurn?: boolean;
        templates?: Array<{
            id: string;
            name: string;
            description?: string;
            template: string;
            targetMode: string; // HistoryMode | 'all'
            /** When false, use enabledTools subset; otherwise ALL_SHARED_TOOLS. */
            toolsEnabled?: boolean;
            /** Per-template tool allow-list. */
            enabledTools?: string[];
        }>;
        memoryExtractionTemplates?: Array<{
            id: string;
            name: string;
            description?: string;
            template: string;
            targetFile: string;
            scope: 'quest' | 'shared' | 'both';
            toolsEnabled?: boolean;
            enabledTools?: string[];
        }>;
    };

    /**
     * Window status panel configuration.
     */
    windowStatus?: {
        /** Folder path for window-state files (supports ${ai} token). Default: ${ai}/local */
        localFolder?: string;
    };

    /**
     * External application mappings for file types.
     * Used to open files in appropriate external applications.
     */
    externalApplications?: {
        mappings: Array<{
            /** File extensions to match (e.g., [".md", ".markdown"]) */
            extensions?: string[];
            /** Regex pattern to match filename */
            pattern?: string;
            /** Name of executable from `executables` config */
            executable: string;
            /** Display name for the application */
            label?: string;
        }>;
    };

    /**
     * Tom AI bridge configuration.
     */
    bridge?: {
        current?: string;
        /** Platform-specific binary path directory used as ${binaryPath}. */
        binaryPath?: { [platform: string]: string };
        /** Cross-platform executable configuration. */
        executables?: { [name: string]: { [platform: string]: string } };
        profiles: { [name: string]: {
            label: string;
            /** Executable name from `executables` config. */
            executable?: string;
            arguments?: string[];
        } };
    };

    /**
     * Username for auto-filling completion "by" fields.
     * Supports placeholders: ${env:VARNAME}, ~, ${home}.
     * Default: OS username (os.userInfo().username).
     */
    userName?: string;

    /**
     * Which chat transport "Send to Chat" routes to.
     *  - 'anthropic' (default): handle as if entered in the Anthropic chat
     *    panel — same profile + tools, answer comes from the Anthropic
     *    transport, shows in the live trail, blocks while executing.
     *  - 'copilot': legacy behaviour — route to GitHub Copilot Chat.
     * Read via {@link getSendToChatTarget} which applies the default.
     */
    sendToChatTarget?: 'anthropic' | 'copilot';

    /**
     * Quest Refresh — an automatic "refresh prompt" that fires every *N* prompts
     * to run maintenance work off the recent trail (update the overview, prune
     * todos, refresh quest-notes). Global (shared across quests); the per-quest
     * activation checkbox and the prompt counter live in
     * `_ai/quests/{questId}/quest-refresh.{hostname}.{questId}.yaml` (see
     * `QuestRefreshStore`), not here. Read via {@link getQuestRefreshSettings}
     * which applies defaults.
     */
    questRefresh?: QuestRefreshConfig;

}

/**
 * On-disk shape of the Quest Refresh config block. One sub-block per chat
 * transport. All fields optional; {@link getQuestRefreshSettings} resolves them
 * against defaults. Copilot is wired into the config/UI but its auto-trigger is
 * deferred (see quest_refresh_implementation_plan.md, Open decision option 3).
 */
export interface QuestRefreshConfig {
    anthropic?: QuestRefreshPanelConfig;
    localLlm?: QuestRefreshPanelConfig;
    copilot?: QuestRefreshPanelConfig;
}

/** Per-panel Quest Refresh configuration. Global (shared across quests). */
export interface QuestRefreshPanelConfig {
    /** Number of prompts between refreshes. `0` (default) ⇒ never auto-refresh. */
    promptInterval?: number;
    /** The refresh prompt text dispatched through the panel's transport. */
    refreshPrompt?: string;
}

/**
 * On-disk shape of the standalone MCP server config block. Persisted as the
 * machine-independent `mcpServer` section of `extension_config.{quest}.yaml`
 * (owned by `extensionConfigStore`); the machine-scoped `autostart` flag lives
 * separately in the per-host file. All fields are optional;
 * {@link getMcpServerSettings} resolves them against sane defaults.
 */
export interface McpServerConfig {
    /** Master on/off switch for the MCP server. Default `false`. */
    enabled?: boolean;
    /** Bind address. Default `0.0.0.0` (reachable over the VPN). */
    host?: string;
    /**
     * First port to try. The server probes upward from here to the first free
     * port; the actually-bound port is runtime state, not stored. Default
     * `19920` (clear of the CLI server's `19900`).
     */
    basePort?: number;
    /**
     * NAME of the env var holding the expected inbound bearer token (never the
     * secret). Empty ⇒ no auth configured ⇒ read-only floor applies.
     */
    apiKeyEnv?: string;
    /**
     * When `true`, unauthenticated clients also get the configured write tools.
     * Default `false` ⇒ unauthenticated access is read-only.
     */
    allowWriteWithoutAuth?: boolean;
    /** `true` ⇒ expose all tools; `false` ⇒ use {@link enabledTools}. Default `true`. */
    toolsEnabled?: boolean;
    /** Independent allow-list (own picker, NOT the chat profile). Honored when `toolsEnabled === false`. */
    enabledTools?: string[];
}

/** Default MCP bind address — VPN-reachable per plan decision (b). */
export const MCP_SERVER_DEFAULT_HOST = '0.0.0.0';

/** First port the MCP server tries before probing upward (plan decision (c)). */
export const MCP_SERVER_DEFAULT_BASE_PORT = 19920;

/** Fully-resolved MCP server settings with all defaults applied. */
export interface ResolvedMcpServerSettings {
    enabled: boolean;
    host: string;
    basePort: number;
    apiKeyEnv: string;
    allowWriteWithoutAuth: boolean;
    toolsEnabled: boolean;
    enabledTools: string[];
}

/**
 * Resolve the MCP server settings from a (possibly partial / absent)
 * {@link McpServerConfig}, applying the documented defaults. The single source
 * of truth for the MCP defaults, mirroring {@link getSendToChatTarget}'s
 * default-applying role.
 *
 * The MCP config is machine-independent per-quest state — it lives in
 * `extension_config.{quest}.yaml` (owned by `extensionConfigStore`), NOT in the
 * shared send-to-chat config. Callers therefore feed the section read from the
 * quest file here (see `extensionConfigStore.readEffectiveMcpServerSettings`).
 *
 * Note: the bound port is runtime state and is deliberately NOT part of this
 * shape — only `basePort` (the starting point of the probe) is configured.
 */
export function getMcpServerSettings(
    mcp: McpServerConfig | null | undefined,
): ResolvedMcpServerSettings {
    const host = (mcp?.host ?? '').trim();
    const basePort = mcp?.basePort;
    return {
        enabled: mcp?.enabled === true,
        host: host || MCP_SERVER_DEFAULT_HOST,
        basePort: typeof basePort === 'number' && basePort > 0 ? basePort : MCP_SERVER_DEFAULT_BASE_PORT,
        apiKeyEnv: (mcp?.apiKeyEnv ?? '').trim(),
        allowWriteWithoutAuth: mcp?.allowWriteWithoutAuth === true,
        toolsEnabled: mcp?.toolsEnabled !== false,
        enabledTools: Array.isArray(mcp?.enabledTools) ? mcp.enabledTools : [],
    };
}

/** Panel keys for Quest Refresh — one per chat transport. */
export type QuestRefreshPanel = 'anthropic' | 'localLlm' | 'copilot';

/** Fully-resolved per-panel Quest Refresh settings with defaults applied. */
export interface ResolvedQuestRefreshPanel {
    /** `0` ⇒ never auto-refresh. */
    promptInterval: number;
    refreshPrompt: string;
}

/**
 * Resolve the Quest Refresh settings for a single panel from a (possibly
 * partial / absent) config, applying defaults (`promptInterval: 0`,
 * `refreshPrompt: ''`). The single source of truth for the global half of the
 * Quest Refresh state — the per-quest `active` flag + prompt counter live in
 * `QuestRefreshStore`, not here.
 */
export function getQuestRefreshSettings(
    config: SendToChatConfig | null | undefined,
    panel: QuestRefreshPanel,
): ResolvedQuestRefreshPanel {
    const block = config?.questRefresh?.[panel];
    const interval = block?.promptInterval;
    return {
        promptInterval: typeof interval === 'number' && interval > 0 ? Math.floor(interval) : 0,
        refreshPrompt: typeof block?.refreshPrompt === 'string' ? block.refreshPrompt : '',
    };
}

/**
 * Resolve the configured Send-to-Chat target, defaulting to 'anthropic'.
 */
export function getSendToChatTarget(
    config: SendToChatConfig | null | undefined,
): 'anthropic' | 'copilot' {
    return config?.sendToChatTarget === 'copilot' ? 'copilot' : 'anthropic';
}

export function validateStrictAiConfiguration(config: SendToChatConfig | null | undefined): string[] {
    const errors: string[] = [];
    if (!config) {
        errors.push('Configuration is missing. Expected a valid tom_vscode_extension.json file.');
        return errors;
    }

    const llmConfigs = Array.isArray(config.localLlm?.configurations) ? config.localLlm.configurations : [];
    if (llmConfigs.length === 0) {
        errors.push('Missing configurations: at least one LLM configuration is required.');
    }

    const llmIds = new Set<string>();
    for (const entry of llmConfigs) {
        const id = (entry?.id || '').trim();
        if (!id) {
            errors.push('Each configurations entry must define a non-empty id.');
            continue;
        }
        llmIds.add(id);
        if (!(entry?.name || '').trim()) { errors.push(`configurations.${id}.name is required.`); }
        if (!(entry?.ollamaUrl || '').trim()) { errors.push(`configurations.${id}.ollamaUrl is required.`); }
        if (!(entry?.model || '').trim()) { errors.push(`configurations.${id}.model is required.`); }
        if (typeof entry?.temperature !== 'number') { errors.push(`configurations.${id}.temperature must be a number.`); }
        if (typeof entry?.trailMaximumTokens !== 'number') { errors.push(`configurations.${id}.trailMaximumTokens must be a number.`); }
        if (typeof entry?.removePromptTemplateFromTrail !== 'boolean') { errors.push(`configurations.${id}.removePromptTemplateFromTrail must be boolean.`); }
        if (typeof entry?.trailSummarizationTemperature !== 'number') { errors.push(`configurations.${id}.trailSummarizationTemperature must be a number.`); }
        if (!(entry?.trailSummarizationPrompt || '').trim()) { errors.push(`configurations.${id}.trailSummarizationPrompt is required.`); }
        if (!(entry?.answerFolder || '').trim()) { errors.push(`configurations.${id}.answerFolder is required.`); }
        if (!(entry?.logFolder || '').trim()) { errors.push(`configurations.${id}.logFolder is required.`); }
        if (!(entry?.historyMode || '').trim()) { errors.push(`configurations.${id}.historyMode is required.`); }
    }

    const setups = Array.isArray(config.aiConversation?.setups) ? config.aiConversation.setups : [];
    if (setups.length === 0) {
        errors.push('Missing setups: at least one AI conversation setup is required.');
    }

    for (const setup of setups) {
        const id = (setup?.id || '').trim() || '(unknown-setup)';
        if (!(setup?.id || '').trim()) { errors.push('Each setups entry must define a non-empty id.'); }
        if (!(setup?.name || '').trim()) { errors.push(`setups.${id}.name is required.`); }
        if (!(setup?.llmConfigA || '').trim()) { errors.push(`setups.${id}.llmConfigA is required.`); }
        if (typeof setup?.maxTurns !== 'number') { errors.push(`setups.${id}.maxTurns must be a number.`); }
        if (typeof setup?.pauseBetweenTurns !== 'boolean') { errors.push(`setups.${id}.pauseBetweenTurns must be boolean.`); }
        if (!(setup?.historyMode || '').trim()) { errors.push(`setups.${id}.historyMode is required.`); }
        if (!(setup?.trailSummarizationLlmConfig || '').trim()) { errors.push(`setups.${id}.trailSummarizationLlmConfig is required.`); }

        if ((setup?.llmConfigA || '').trim() && !llmIds.has((setup!.llmConfigA || '').trim())) {
            errors.push(`setups.${id}.llmConfigA references unknown configurations id "${setup!.llmConfigA}".`);
        }
        if ((setup?.llmConfigB || '').trim() && setup!.llmConfigB !== 'copilot' && !llmIds.has((setup!.llmConfigB || '').trim())) {
            errors.push(`setups.${id}.llmConfigB references unknown configurations id "${setup!.llmConfigB}".`);
        }
        if ((setup?.trailSummarizationLlmConfig || '').trim() && !llmIds.has((setup!.trailSummarizationLlmConfig || '').trim())) {
            errors.push(`setups.${id}.trailSummarizationLlmConfig references unknown configurations id "${setup!.trailSummarizationLlmConfig}".`);
        }
    }

    return errors;
}

// ============================================================================
// Simple Path Helpers (no circular dependencies)
// ============================================================================

/**
 * Expand path placeholders in a config path (simple version without the full
 * variableResolver). Handles `~` prefix, `${home}`, and `${workspaceFolder}` —
 * the same tokens `tomAi.configPath` is documented to accept — so this
 * early-startup fallback resolves to the same absolute path the main resolver
 * would produce.
 */
function expandHomePath(p: string): string {
    const home = os.homedir();
    let result = p;
    if (result.startsWith('~/') || result.startsWith('~\\')) {
        result = path.join(home, result.slice(2));
    }
    result = result.replace(/\$\{home\}/g, home);
    const wsRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
    if (wsRoot) {
        result = result.replace(/\$\{workspaceFolder\}/g, wsRoot);
    }
    return result;
}

/**
 * Get the config file path using simple expansion (avoids variableResolver).
 *
 * Resolution order:
 *   1. Workspace `.tom/tom_vscode_extension.json` (if it exists)
 *   2. Explicit `tomAi.configPath` setting (with ~, ${home}, ${workspaceFolder} expansion)
 *   3. Workspace `.tom/tom_vscode_extension.json` default target
 */
function getConfigPathSimple(): string | undefined {
    try {
        return TomAiConfiguration.instance.configPath;
    } catch {
        // Continue with local fallback logic during early startup.
    }

    // 1. Check workspace .tom/ first
    const wsConfigPath = WsPaths.wsConfig(WsPaths.configFileName);
    if (wsConfigPath && fs.existsSync(wsConfigPath)) {
        logConfigAccess('sendToChatConfig.getConfigPathSimple', wsConfigPath, {
            action: 'resolve',
            branch: 'fallback / workspace .tom (exists)',
        });
        return wsConfigPath;
    }

    // 2. Explicit setting
    const configSetting = vscode.workspace
        .getConfiguration('tomAi')
        .get<string>('configPath');
    if (configSetting) {
        const resolved = expandHomePath(configSetting);
        logConfigAccess('sendToChatConfig.getConfigPathSimple', resolved, {
            action: 'resolve',
            branch: 'fallback / setting',
            setting: configSetting,
        });
        return resolved;
    }

    // 3. Workspace default target
    logConfigAccess('sendToChatConfig.getConfigPathSimple', wsConfigPath, {
        action: 'resolve',
        branch: 'fallback / workspace default target',
    });
    return wsConfigPath;
}

// ============================================================================
// Configuration Loading/Saving
// ============================================================================

/**
 * Load the send-to-chat configuration from the config file.
 */
export function loadSendToChatConfig(): SendToChatConfig | null {
    const configPath = getConfigPathSimple();
    if (!configPath || !fs.existsSync(configPath)) {
        return null;
    }
    try {
        const content = fs.readFileSync(configPath, 'utf-8');
        return JSON.parse(content);
    } catch {
        return null;
    }
}

/**
 * Save the send-to-chat configuration to the config file.
 *
 * After writing, re-hydrates `TomAiConfiguration.instance` so any
 * running handler that reads via `getSection()` sees the new values
 * immediately. Without this reload the in-memory cache stays stuck
 * on whatever was loaded at extension init — e.g. toggling
 * `compaction.disabled` on the status page would persist to disk
 * but wouldn't actually stop the background compaction/extraction
 * LLM calls until the window was reloaded (the symptom that crashed
 * the user's machine: local LLM memory compaction kept running under
 * a "disabled" setting).
 */
export function saveSendToChatConfig(config: SendToChatConfig): boolean {
    const configPath = getConfigPathSimple();
    if (!configPath) {
        return false;
    }
    try {
        fs.writeFileSync(configPath, JSON.stringify(config, null, 2), 'utf-8');
        try { TomAiConfiguration.instance.reload(); } catch { /* early startup — no instance yet */ }
        return true;
    } catch {
        return false;
    }
}

// ============================================================================
// Transport Retry Default Template
// ============================================================================

/** Id of the seeded, on-disk "Default Retry" transport-retry template. */
export const DEFAULT_TRANSPORT_RETRY_TEMPLATE_ID = 'default-retry';

/** Display name of the seeded "Default Retry" template. */
export const DEFAULT_TRANSPORT_RETRY_TEMPLATE_NAME = 'Default Retry';

/**
 * Canonical continuation-prompt body for the seeded "Default Retry" template
 * and for newly-added transport-retry templates. This is the same text the
 * Agent SDK retry used to hard-code internally; it now lives in the config so
 * it can be edited/picked like any other template. The in-code constant
 * (`DEFAULT_TRANSPORT_RETRY_TEMPLATE` in agent-sdk-retry.ts) is kept only as an
 * error-case fallback for when no default template exists on disk.
 * References `${errorText}`.
 */
export const DEFAULT_TRANSPORT_RETRY_TEMPLATE_BODY =
    'The previous attempt failed with the following error:\n\n${errorText}\n\n' +
    'Please continue from where you left off and complete the original request. ' +
    'Do not repeat work that already succeeded.';

/**
 * Ensure the config carries a transport-retry template marked `isDefault`, so
 * the "use default" selection resolves to an on-disk template rather than the
 * in-code fallback constant. Idempotent and mutating:
 *  - if a template already has `isDefault: true`, does nothing;
 *  - else if a template with id `default-retry` exists, marks it default;
 *  - else appends a fresh "Default Retry" template (seeded from the canonical
 *    body) and marks it default.
 *
 * Returns `true` when it changed `config` (caller should persist).
 */
export function ensureDefaultTransportRetryTemplate(config: SendToChatConfig): boolean {
    const anthropic = (config.anthropic ??= {});
    const retry = (anthropic.transportRetry ??= {});
    const templates = (retry.templates ??= []);

    if (templates.some((t) => t.isDefault === true)) {
        return false;
    }

    const existing = templates.find((t) => t.id === DEFAULT_TRANSPORT_RETRY_TEMPLATE_ID);
    if (existing) {
        existing.isDefault = true;
        return true;
    }

    templates.push({
        id: DEFAULT_TRANSPORT_RETRY_TEMPLATE_ID,
        name: DEFAULT_TRANSPORT_RETRY_TEMPLATE_NAME,
        description: 'Built-in default continuation prompt used when an Agent SDK attempt fails and the session is resumed.',
        template: DEFAULT_TRANSPORT_RETRY_TEMPLATE_BODY,
        isDefault: true,
    });
    return true;
}

// ============================================================================
// Copilot Answer Folder Functions
// ============================================================================

/**
 * Get the Copilot chat answer folder (workspace-relative path string).
 * Reads from config `copilot.answerFolder`, defaults to `_ai/answers/copilot`.
 */
export function getCopilotChatAnswerFolder(): string {
    const config = loadSendToChatConfig();
    return config?.copilot?.answerFolder || WsPaths.aiRelative('answersCopilot');
}

/**
 * Get the absolute path to the Copilot chat answer folder.
 * Falls back to `~/.tom/copilot-chat-answers/` when no workspace is open.
 */
export function getCopilotChatAnswerFolderAbsolute(): string {
    const wsRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
    if (wsRoot) {
        return path.join(wsRoot, getCopilotChatAnswerFolder());
    }
    return WsPaths.home('copilotChatAnswers');
}
