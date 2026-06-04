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
            /** Selected continuation-prompt template id (from `templates`). Empty = built-in default. */
            templateId?: string;
            /** Continuation-prompt templates. Bodies typically reference `${errorText}` + `${userMessage}`. */
            templates?: Array<{
                id: string;
                name: string;
                description?: string;
                template: string;
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
        /**
         * When true, the CLI integration server is automatically started
         * after the Dart bridge connects during extension activation.
         */
        cliServerAutostart?: boolean;
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
 * Expand home directory in a path (simple version without full variable resolution).
 * Handles both `~` prefix and `${home}` placeholder.
 */
function expandHomePath(p: string): string {
    const home = os.homedir();
    if (p.startsWith('~/')) {
        return path.join(home, p.slice(2));
    }
    if (p.startsWith('~\\')) {
        return path.join(home, p.slice(2));
    }
    // Also handle ${home} placeholder
    return p.replace(/\$\{home\}/g, home);
}

/**
 * Get the config file path using simple expansion (avoids variableResolver).
 *
 * Resolution order:
 *   1. Workspace `.tom/tom_vscode_extension.json` (if it exists)
 *   2. Explicit `tomAi.configPath` setting (with ~ expansion)
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
        return wsConfigPath;
    }

    // 2. Explicit setting
    const configSetting = vscode.workspace
        .getConfiguration('tomAi')
        .get<string>('configPath');
    if (configSetting) {
        return expandHomePath(configSetting);
    }

    // 3. Workspace default target
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
