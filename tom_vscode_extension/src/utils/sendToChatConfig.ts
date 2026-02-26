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
    templates: { [key: string]: { template: string; showInMenu?: boolean } };
    defaultTemplates?: {
        copilot?: string;      // Template key from `templates` applied to every copilot send
        localLlm?: string;     // Template key from `templates` applied to every local LLM send
        tomAiChat?: string;    // Template key from `templates` applied to every Tom AI Chat send
        conversation?: string; // Template key from `templates` applied to every conversation start
    };
    promptExpander: {
        profiles: { [key: string]: {
            label: string;
            systemPrompt?: string | null;
            resultTemplate?: string | null;
            temperature?: number | null;
            modelConfig?: string | null;
            toolsEnabled?: boolean;
            stripThinkingTags?: boolean | null;
            isDefault?: boolean;
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
    };
    botConversation: {
        profiles: { [key: string]: {
            label: string;
            description?: string;
            goal?: string;
            maxTurns?: number;
            initialPromptTemplate?: string | null;
            followUpTemplate?: string | null;
            temperature?: number | null;
        } };
    };
    tomAiChat?: {
        defaultTemplate?: string;
        templates?: { [key: string]: {
            label: string;
            description?: string;
            contextInstructions?: string;
            systemPromptOverride?: string | null;
        } };
    };
    copilotAnswerPath?: string;  // Path for extracting Copilot answers, relative to workspace root
    copilotChatAnswerFolder?: string;  // Folder for Copilot chat answer JSON files, relative to workspace root (default: _ai/answers/copilot)

    /** Todo panel configuration */
    todoPanel?: {
        /** Default template preselected in the todo panel template dropdown */
        defaultTemplate?: string;
    };

    /** Trail cleanup: days to keep individual trail files (default: 2) */
    trailCleanupDays?: number;
    /** Trail cleanup: max entries in consolidated trail files before trimming (default: 1000) */
    trailMaxEntries?: number;

    /**
     * Platform-specific binary path directory.
     * Used as ${binaryPath} in commandlines.
     * Keys are platform identifiers (e.g., "darwin-arm64", "linux-x64", "darwin-*", "*").
     * Values are directory paths (can use ~ for home directory).
     * Fallback: $HOME/.tom/bin/<platform>/
     */
    binaryPath?: { [platform: string]: string };

    /**
     * Cross-platform executable configuration.
     * Keys are executable names (e.g., "marktext", "tom_bs").
     * Values are objects mapping platform keys to file paths.
     * Platform keys: darwin-arm64, darwin-x64, linux-x64, windows-x64, darwin-*, linux-*, windows-*, *
     * Paths can use ~ for home directory.
     */
    executables?: { [name: string]: { [platform: string]: string } };

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
     * DartScript bridge configuration.
     */
    dartscriptBridge?: {
        profiles: { [name: string]: {
            label: string;
            /** Executable name from `executables` config (preferred) */
            executable?: string;
            /** Direct command path (deprecated - use executable instead) */
            command?: string;
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
     * When true, the CLI integration server is automatically started
     * after the Dart bridge connects during extension activation.
     */
    cliServerAutostart?: boolean;

    /**
     * When true, Telegram polling is automatically started
     * after the Dart bridge connects during extension activation.
     */
    telegramAutostart?: boolean;

    /**
     * LLM configuration entities (root level).
     * Each config defines a complete LLM setup with model settings and enabled tools.
     */
    llmConfigurations?: Array<{
        id: string;
        name: string;
        ollamaUrl?: string;
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
    }>;

    /**
     * AI Conversation setup entities (root level).
     * Each setup defines a conversation configuration with LLM config references.
     */
    aiConversationSetups?: Array<{
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
}

export function validateStrictAiConfiguration(config: SendToChatConfig | null | undefined): string[] {
    const errors: string[] = [];
    if (!config) {
        errors.push('Configuration is missing. Expected a valid tom_vscode_extension.json file.');
        return errors;
    }

    const llmConfigs = Array.isArray(config.llmConfigurations) ? config.llmConfigurations : [];
    if (llmConfigs.length === 0) {
        errors.push('Missing llmConfigurations: at least one LLM configuration is required.');
    }

    const llmIds = new Set<string>();
    for (const entry of llmConfigs) {
        const id = (entry?.id || '').trim();
        if (!id) {
            errors.push('Each llmConfigurations entry must define a non-empty id.');
            continue;
        }
        llmIds.add(id);
        if (!(entry?.name || '').trim()) { errors.push(`llmConfigurations.${id}.name is required.`); }
        if (!(entry?.ollamaUrl || '').trim()) { errors.push(`llmConfigurations.${id}.ollamaUrl is required.`); }
        if (!(entry?.model || '').trim()) { errors.push(`llmConfigurations.${id}.model is required.`); }
        if (typeof entry?.temperature !== 'number') { errors.push(`llmConfigurations.${id}.temperature must be a number.`); }
        if (typeof entry?.trailMaximumTokens !== 'number') { errors.push(`llmConfigurations.${id}.trailMaximumTokens must be a number.`); }
        if (typeof entry?.removePromptTemplateFromTrail !== 'boolean') { errors.push(`llmConfigurations.${id}.removePromptTemplateFromTrail must be boolean.`); }
        if (typeof entry?.trailSummarizationTemperature !== 'number') { errors.push(`llmConfigurations.${id}.trailSummarizationTemperature must be a number.`); }
        if (!(entry?.trailSummarizationPrompt || '').trim()) { errors.push(`llmConfigurations.${id}.trailSummarizationPrompt is required.`); }
        if (!(entry?.answerFolder || '').trim()) { errors.push(`llmConfigurations.${id}.answerFolder is required.`); }
        if (!(entry?.logFolder || '').trim()) { errors.push(`llmConfigurations.${id}.logFolder is required.`); }
        if (!(entry?.historyMode || '').trim()) { errors.push(`llmConfigurations.${id}.historyMode is required.`); }
    }

    const setups = Array.isArray(config.aiConversationSetups) ? config.aiConversationSetups : [];
    if (setups.length === 0) {
        errors.push('Missing aiConversationSetups: at least one AI conversation setup is required.');
    }

    for (const setup of setups) {
        const id = (setup?.id || '').trim() || '(unknown-setup)';
        if (!(setup?.id || '').trim()) { errors.push('Each aiConversationSetups entry must define a non-empty id.'); }
        if (!(setup?.name || '').trim()) { errors.push(`aiConversationSetups.${id}.name is required.`); }
        if (!(setup?.llmConfigA || '').trim()) { errors.push(`aiConversationSetups.${id}.llmConfigA is required.`); }
        if (typeof setup?.maxTurns !== 'number') { errors.push(`aiConversationSetups.${id}.maxTurns must be a number.`); }
        if (typeof setup?.pauseBetweenTurns !== 'boolean') { errors.push(`aiConversationSetups.${id}.pauseBetweenTurns must be boolean.`); }
        if (!(setup?.historyMode || '').trim()) { errors.push(`aiConversationSetups.${id}.historyMode is required.`); }
        if (!(setup?.trailSummarizationLlmConfig || '').trim()) { errors.push(`aiConversationSetups.${id}.trailSummarizationLlmConfig is required.`); }

        if ((setup?.llmConfigA || '').trim() && !llmIds.has((setup!.llmConfigA || '').trim())) {
            errors.push(`aiConversationSetups.${id}.llmConfigA references unknown llmConfigurations id "${setup!.llmConfigA}".`);
        }
        if ((setup?.llmConfigB || '').trim() && setup!.llmConfigB !== 'copilot' && !llmIds.has((setup!.llmConfigB || '').trim())) {
            errors.push(`aiConversationSetups.${id}.llmConfigB references unknown llmConfigurations id "${setup!.llmConfigB}".`);
        }
        if ((setup?.trailSummarizationLlmConfig || '').trim() && !llmIds.has((setup!.trailSummarizationLlmConfig || '').trim())) {
            errors.push(`aiConversationSetups.${id}.trailSummarizationLlmConfig references unknown llmConfigurations id "${setup!.trailSummarizationLlmConfig}".`);
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
 *   2. Explicit `dartscript.configPath` setting (with ~ expansion)
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
        .getConfiguration('dartscript')
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
 */
export function saveSendToChatConfig(config: SendToChatConfig): boolean {
    const configPath = getConfigPathSimple();
    if (!configPath) {
        return false;
    }
    try {
        fs.writeFileSync(configPath, JSON.stringify(config, null, 2), 'utf-8');
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
 * Reads from config `copilotChatAnswerFolder`, defaults to `_ai/answers/copilot`.
 */
export function getCopilotChatAnswerFolder(): string {
    const config = loadSendToChatConfig();
    return config?.copilotChatAnswerFolder || WsPaths.aiRelative('answersCopilot');
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
