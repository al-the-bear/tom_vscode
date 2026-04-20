/**
 * Status Page Handler
 * 
 * Custom webview panel for extension configuration and status control.
 * Shows toggle controls for:
 * - Tom CLI Integration Server (Start/Stop)
 * - Tom Bridge (Restart, Switch Profile)
 * - AI Trail (On/Off)
 * - Local LLM Settings
 * - AI Conversation Settings
 * - Telegram Settings
 */

import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import { getBridgeClient, getConfigPath, loadSendToChatConfig, saveSendToChatConfig } from './handler_shared';
import { AVAILABLE_LLM_TOOLS } from '../utils/constants';
import { notifyAnthropicConfigChanged } from './chatPanel-handler';
import { AnthropicHandler } from './anthropic-handler';
import { compactHistoryDetailed, type ConversationMessage, type HistoryMode, type CompactionLlmProvider } from '../services/history-compaction';
import { logRunBanner, showCompactionChannel, logError as logCompactionError } from '../services/compaction-log';
import { getCliServerStatus } from './cliServer-handler';
import { loadBridgeConfig, BridgeConfig } from './restartBridge-handler';
import { isTrailEnabled, setTrailEnabled, loadTrailConfig, toggleTrail } from '../services/trailLogging';
import { isTelegramPollingActive } from './telegram-commands';
import { 
    loadLocalLlmToolsConfig,
    saveLocalLlmToolsConfig,
    clearLocalLlmToolsConfigCache,
    AskCopilotConfig,
    AskBigBrotherConfig,
} from '../tools/local-llm-tools-config';
import { WsPaths } from '../utils/workspacePaths';
import { TomAiConfiguration } from '../utils/tomAiConfiguration';
import { validateStrictAiConfiguration, SendToChatConfig } from '../utils/sendToChatConfig';

/**
 * Subset of the `anthropic` config section that the status page reads
 * from the central {@link TomAiConfiguration} cache. Writes still go
 * through `loadSendToChatConfig()` + `saveSendToChatConfig()` because
 * those APIs do file I/O; reads prefer the cached singleton for
 * uniform reload semantics (Wave 2.5 of the review refactoring plan).
 */
interface AnthropicSectionForStatusPage {
    apiKeyEnvVar?: string;
    configurations?: Array<{
        id: string;
        name?: string;
        model?: string;
        transport?: 'direct' | 'agentSdk' | 'vscodeLm';
        maxTokens?: number;
        maxRounds?: number;
        temperature?: number;
        maxHistoryTokens?: number;
        memoryToolsEnabled?: boolean;
        promptCachingEnabled?: boolean;
        historyMode?: string;
        isDefault?: boolean;
        agentSdk?: {
            permissionMode?: string;
            settingSources?: Array<'user' | 'project' | 'local'>;
            maxTurns?: number;
        };
        vscodeLm?: {
            vendor?: string;
            family?: string;
            modelId?: string;
        };
    }>;
    memory?: {
        memoryToolsEnabled?: boolean;
        maxInjectedTokens?: number;
    };
}

function getAnthropicSection(): AnthropicSectionForStatusPage {
    return TomAiConfiguration.instance.getSection<AnthropicSectionForStatusPage>('anthropic') ?? {};
}
import type { TimerScheduleSlot } from '../managers/timerEngine';
import type { CommandlineEntry } from './commandline-handler';
import {
    readQueueSettings,
    writeQueueSettings,
    setQueueReloadAfterReloadSetting,
    getQueueReloadAfterReloadSetting,
} from '../storage/queueFileStorage';

/** A favorite entry stored in tom_vscode_extension.json → "favorites" */
export interface FavoriteEntry {
    key: string;
    label: string;
    /** VS Code command ID (canonical field name) */
    commandId: string;
    /** Multiple command IDs executed sequentially */
    commandIds?: string[];
    /** Alias - some favorites may use 'command' instead of 'commandId' */
    command?: string;
    description?: string;
}

/** 
 * LLM Configuration entity - complete settings for a local LLM configuration.
 * Used by Local LLM @CHAT panel dropdown.
 */
export interface LlmConfiguration {
    id: string;
    name: string;
    ollamaUrl: string;
    model: string;
    temperature: number;
    stripThinkingTags: boolean;
    trailMaximumTokens: number;
    removePromptTemplateFromTrail: boolean;
    trailSummarizationTemperature: number;
    trailSummarizationPrompt?: string;
    answerFolder?: string;
    logFolder?: string;
    historyMode?: 'full' | 'last' | 'summary' | 'trim_and_summary';
    /** List of enabled tool names for this configuration */
    enabledTools: string[];
    /** Ollama keep_alive parameter (e.g., '5m', '30m') */
    keepAlive?: string;
}

/**
 * AI Conversation Setup entity - complete settings for an AI conversation session.
 * Used by AI Conversation @CHAT panel dropdown.
 */
export interface AiConversationSetup {
    id: string;
    name: string;
    /** Reference to LlmConfiguration id for Person A */
    llmConfigA: string;
    /** Reference to LlmConfiguration id for Person B (ollama-ollama mode only) */
    llmConfigB?: string;
    maxTurns: number;
    pauseBetweenTurns: boolean;
    historyMode: 'full' | 'last' | 'summary' | 'trim_and_summary';
    trailSummarizationLlmConfig?: string;
}

// Re-exported for the few callers that import from this module.
// The canonical definition lives in utils/constants.ts.
export { AVAILABLE_LLM_TOOLS } from '../utils/constants';

let statusPanel: vscode.WebviewPanel | undefined;

function createEmptySendToChatConfig(): SendToChatConfig {
    return {
        localLlm: { profiles: {}, configurations: [] },
        aiConversation: { profiles: {}, setups: [] },
        trail: {},
        bridge: { profiles: {} },
        copilot: { templates: {} },
    };
}

// Config loading functions
export function loadConfig(): any {
    const configPath = getConfigPath();
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

export function saveConfig(config: any): boolean {
    const configPath = getConfigPath();
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

// Update functions for settings
async function updateLocalLlmSettings(settings: any): Promise<void> {
    const config = loadConfig();
    if (!config) { return; }
    
    if (!config.localLlm) {
        config.localLlm = {};
    }
    
    Object.assign(config.localLlm, {
        ollamaUrl: settings.ollamaUrl,
        model: settings.model,
        temperature: settings.temperature,
        stripThinkingTags: settings.stripThinkingTags,
        expansionProfile: settings.expansionProfile,
        toolsEnabled: settings.toolsEnabled,
        trailMaximumTokens: settings.trailMaximumTokens,
        trailSummarizationTemperature: settings.trailSummarizationTemperature,
        removePromptTemplateFromTrail: settings.removePromptTemplateFromTrail
    });
    
    if (saveConfig(config)) {
        vscode.window.showInformationMessage('Local LLM settings updated');
    }
}

async function updateAiConversationSettings(settings: any): Promise<void> {
    const config = loadConfig();
    if (!config) { return; }
    
    if (!config.aiConversation) {
        config.aiConversation = {};
    }
    
    Object.assign(config.aiConversation, {
        maxTurns: settings.maxTurns,
        temperature: settings.temperature,
        historyMode: settings.historyMode,
        conversationMode: settings.conversationMode,
        trailMaximumTokens: settings.trailMaximumTokens,
        trailSummarizationTemperature: settings.trailSummarizationTemperature,
        removePromptTemplateFromTrail: settings.removePromptTemplateFromTrail
    });
    
    if (saveConfig(config)) {
        vscode.window.showInformationMessage('AI Conversation settings updated');
    }
}

async function updateTelegramSettings(settings: any): Promise<void> {
    const config = loadConfig();
    if (!config) { return; }
    
    if (!config.aiConversation) {
        config.aiConversation = {};
    }
    if (!config.aiConversation.telegram) {
        config.aiConversation.telegram = {};
    }
    
    Object.assign(config.aiConversation.telegram, {
        enabled: settings.enabled,
        botTokenEnv: settings.botTokenEnv,
        defaultChatId: settings.defaultChatId,
        pollIntervalMs: settings.pollIntervalMs,
        notifyOnStart: settings.notifyOnStart,
        notifyOnTurn: settings.notifyOnTurn,
        notifyOnEnd: settings.notifyOnEnd
    });
    
    if (saveConfig(config)) {
        vscode.window.showInformationMessage('Telegram settings updated');
    }
}

async function updateAskCopilotSettings(settings: any): Promise<void> {
    // Save local-LLM tools config (askCopilot settings)
    const localLlmToolsConfig = loadLocalLlmToolsConfig();
    const { copilotAnswerFolder, ...askCopilotSettings } = settings;
    localLlmToolsConfig.askCopilot = { ...localLlmToolsConfig.askCopilot, ...askCopilotSettings };
    if (saveLocalLlmToolsConfig(localLlmToolsConfig)) {
        clearLocalLlmToolsConfigCache();
    }
    
    // Save copilot answer folder to tom_vscode_extension config
    if (copilotAnswerFolder !== undefined) {
        const sendToChatConfig = loadSendToChatConfig() || createEmptySendToChatConfig();
        if (!sendToChatConfig.copilot) {
            sendToChatConfig.copilot = {};
        }
        sendToChatConfig.copilot.answerFolder = copilotAnswerFolder;
        saveSendToChatConfig(sendToChatConfig);
    }
    
    vscode.window.showInformationMessage('Ask Copilot settings updated');
}

async function updateAskBigBrotherSettings(settings: any): Promise<void> {
    const config = loadLocalLlmToolsConfig();
    config.askBigBrother = { ...config.askBigBrother, ...settings };
    if (saveLocalLlmToolsConfig(config)) {
        clearLocalLlmToolsConfigCache();
        vscode.window.showInformationMessage('Ask Big Brother settings updated');
    }
}

/**
 * Show a QuickPick-based editor to create or edit a model configuration.
 */
async function editOrCreateModelConfig(modelKey: string, existing: any | null): Promise<void> {
    const model = existing?.model ?? '';
    const ollamaUrl = existing?.ollamaUrl ?? 'http://localhost:11434';
    const temperature = existing?.temperature ?? 0.4;
    const stripThinkingTags = existing?.stripThinkingTags ?? true;
    const description = existing?.description ?? '';
    const isDefault = existing?.isDefault ?? false;
    const keepAlive = existing?.keepAlive ?? '5m';
    
    // Use multi-step input to gather model config
    const newModel = await vscode.window.showInputBox({
        prompt: 'Ollama model name (e.g., qwen3:8b, llama3:70b)',
        value: model,
        placeHolder: 'qwen3:8b',
        validateInput: (v) => v.trim().length === 0 ? 'Model name is required' : null
    });
    if (newModel === undefined) { return; }
    
    const newUrl = await vscode.window.showInputBox({
        prompt: 'Ollama URL',
        value: ollamaUrl,
        placeHolder: 'http://localhost:11434'
    });
    if (newUrl === undefined) { return; }
    
    const newTempStr = await vscode.window.showInputBox({
        prompt: 'Temperature (0.0 - 2.0)',
        value: String(temperature),
        validateInput: (v) => {
            const n = parseFloat(v);
            if (isNaN(n) || n < 0 || n > 2) { return 'Enter a number between 0 and 2'; }
            return null;
        }
    });
    if (newTempStr === undefined) { return; }
    
    const newDesc = await vscode.window.showInputBox({
        prompt: 'Description (optional)',
        value: description,
        placeHolder: 'e.g., Fast reasoning model'
    });
    if (newDesc === undefined) { return; }
    
    const stripChoice = await vscode.window.showQuickPick(['Yes', 'No'], {
        placeHolder: `Strip thinking tags? (current: ${stripThinkingTags ? 'Yes' : 'No'})`
    });
    if (stripChoice === undefined) { return; }
    
    const defaultChoice = await vscode.window.showQuickPick(['No', 'Yes'], {
        placeHolder: `Set as default? (current: ${isDefault ? 'Yes' : 'No'})`
    });
    if (defaultChoice === undefined) { return; }
    
    const newKeepAlive = await vscode.window.showInputBox({
        prompt: 'Keep alive duration (e.g., 5m, 1h, 0 to unload immediately)',
        value: keepAlive,
        placeHolder: '5m'
    });
    if (newKeepAlive === undefined) { return; }
    
    // Save the model config
    const cfg = loadConfig() || {};
    if (!cfg.localLlm) { cfg.localLlm = {}; }
    if (!cfg.localLlm.models) { cfg.localLlm.models = {}; }
    
    // If setting as default, clear isDefault from other models
    if (defaultChoice === 'Yes') {
        for (const key of Object.keys(cfg.localLlm.models)) {
            if (cfg.localLlm.models[key].isDefault) {
                cfg.localLlm.models[key].isDefault = false;
            }
        }
    }
    
    cfg.localLlm.models[modelKey] = {
        ollamaUrl: newUrl.trim() || 'http://localhost:11434',
        model: newModel.trim(),
        temperature: parseFloat(newTempStr),
        stripThinkingTags: stripChoice === 'Yes',
        description: newDesc.trim(),
        isDefault: defaultChoice === 'Yes',
        keepAlive: newKeepAlive.trim() || '5m'
    };
    
    saveConfig(cfg);
    vscode.window.showInformationMessage(`Model configuration "${modelKey}" saved`);
    await refreshStatusPage();
}

/**
 * Multi-step input wizard that creates or edits an Anthropic configuration
 * (anthropic_sdk_integration.md §14, §18). When `configId` is null, a new
 * configuration is added; otherwise the existing entry with that id is
 * updated in place. Transport selection drives which follow-up prompts
 * appear (direct-only vs agentSdk-only fields).
 */
async function editOrCreateAnthropicConfiguration(configId: string | null): Promise<void> {
    const stcConfig = loadSendToChatConfig() || createEmptySendToChatConfig();
    if (!stcConfig.anthropic) { stcConfig.anthropic = {}; }
    if (!Array.isArray(stcConfig.anthropic.configurations)) { stcConfig.anthropic.configurations = []; }
    const all = stcConfig.anthropic.configurations;
    const existing = configId ? all.find((c) => c?.id === configId) : undefined;
    const isNew = !existing;

    if (configId && !existing) {
        vscode.window.showWarningMessage(`Anthropic configuration "${configId}" not found.`);
        return;
    }

    const newName = await vscode.window.showInputBox({
        prompt: 'Display name (shown in the panel dropdown)',
        value: existing?.name ?? '',
        placeHolder: 'e.g., Sonnet 4.6 — Direct API',
        validateInput: (v) => v.trim().length === 0 ? 'Name is required' : null,
    });
    if (newName === undefined) { return; }

    let newId = existing?.id;
    if (isNew) {
        newId = await vscode.window.showInputBox({
            prompt: 'Stable id (used for cross-references; lowercase, hyphenated)',
            value: newName.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/(^-|-$)/g, ''),
            placeHolder: 'e.g., sonnet-direct',
            validateInput: (v) => {
                const t = v.trim();
                if (!t) { return 'Id is required'; }
                if (!/^[a-z0-9][a-z0-9-]*$/i.test(t)) { return 'Use letters, digits and hyphens only'; }
                if (all.some((c) => c?.id === t)) { return `Id "${t}" already exists`; }
                return null;
            },
        });
        if (newId === undefined) { return; }
        newId = newId.trim();
    }

    const transportChoice = await vscode.window.showQuickPick(
        [
            { label: 'Direct API', description: 'Uses @anthropic-ai/sdk and the apiKeyEnvVar env var', value: 'direct' as const },
            { label: 'Claude Agent SDK', description: 'Inherits auth from the host Claude Code install', value: 'agentSdk' as const },
            { label: 'VS Code LM', description: 'Routes through vscode.lm.selectChatModels — no API key needed', value: 'vscodeLm' as const },
        ],
        {
            placeHolder: 'Transport',
            title: `Transport for ${newName}`,
            ignoreFocusOut: true,
        },
    );
    if (!transportChoice) { return; }
    const transport = transportChoice.value;

    // Model selection varies by transport:
    //   - direct / agentSdk: pick a Claude model id (or custom).
    //   - vscodeLm: pick a model from vscode.lm.selectChatModels() — we
    //     store {vendor, family, modelId} in `vscodeLm` and mirror the
    //     modelId into `model` for the summary display.
    let newModel: string;
    let vscodeLmOpts: { vendor: string; family: string; modelId: string } | undefined;

    if (transport === 'vscodeLm') {
        let models: vscode.LanguageModelChat[] = [];
        try {
            models = await vscode.lm.selectChatModels({});
        } catch (err) {
            vscode.window.showErrorMessage(`Failed to enumerate VS Code LM models: ${err instanceof Error ? err.message : String(err)}`);
            return;
        }
        if (models.length === 0) {
            vscode.window.showErrorMessage('No VS Code LM models are available. Install a chat provider (e.g. GitHub Copilot) and retry.');
            return;
        }
        // When editing an existing vscodeLm configuration, mark the
        // previously stored model as "(current)" so the user can tell
        // at a glance what their current selection is and avoid
        // accidentally changing it.
        const existingVscodeLm = (existing as { vscodeLm?: { vendor?: string; family?: string; modelId?: string } } | undefined)?.vscodeLm;
        const modelPickItems = models.map((m) => {
            const isCurrent = existingVscodeLm
                && existingVscodeLm.vendor === m.vendor
                && existingVscodeLm.family === m.family
                && existingVscodeLm.modelId === m.id;
            return {
                label: `${m.vendor} · ${m.family}`,
                description: `${m.name || m.id}${isCurrent ? ' (current)' : ''}`,
                detail: `id=${m.id}   maxTokens=${m.maxInputTokens ?? '?'}`,
                value: m,
                picked: !!isCurrent,
            };
        });
        const picked = await vscode.window.showQuickPick(modelPickItems, {
            placeHolder: 'VS Code LM model',
            title: 'Pick a VS Code LM model',
            ignoreFocusOut: true,
        });
        if (!picked) { return; }
        vscodeLmOpts = {
            vendor: picked.value.vendor,
            family: picked.value.family,
            modelId: picked.value.id,
        };
        newModel = picked.value.id;
    } else {
        const modelPick = await vscode.window.showQuickPick(
            [
                { label: 'Sonnet 4.6', description: 'claude-sonnet-4-6 — fast, cost-efficient', value: 'claude-sonnet-4-6' },
                { label: 'Opus 4.6', description: 'claude-opus-4-6 — deepest reasoning', value: 'claude-opus-4-6' },
                { label: 'Haiku 4.5', description: 'claude-haiku-4-5 — fastest', value: 'claude-haiku-4-5' },
                { label: 'Custom…', description: 'Enter a model id by hand', value: '__custom__' },
            ],
            {
                placeHolder: 'Model',
                title: 'Anthropic model',
                ignoreFocusOut: true,
            },
        );
        if (!modelPick) { return; }
        newModel = modelPick.value;
        if (newModel === '__custom__') {
            const customModel = await vscode.window.showInputBox({
                prompt: 'Anthropic model id',
                value: existing?.model ?? '',
                placeHolder: 'claude-sonnet-4-6',
                validateInput: (v) => v.trim().length === 0 ? 'Model id is required' : null,
            });
            if (customModel === undefined) { return; }
            newModel = customModel.trim();
        }
    }

    const maxTokensStr = await vscode.window.showInputBox({
        prompt: 'Max output tokens per response',
        value: String(existing?.maxTokens ?? 8192),
        validateInput: (v) => {
            const n = parseInt(v, 10);
            if (!Number.isFinite(n) || n < 1) { return 'Enter a positive integer'; }
            return null;
        },
    });
    if (maxTokensStr === undefined) { return; }

    const tempStr = await vscode.window.showInputBox({
        prompt: 'Temperature (0.0 - 2.0, blank to omit)',
        value: existing?.temperature !== undefined ? String(existing.temperature) : '0.5',
        validateInput: (v) => {
            if (v.trim() === '') { return null; }
            const n = parseFloat(v);
            if (!Number.isFinite(n) || n < 0 || n > 2) { return 'Enter a number between 0 and 2 (or leave blank)'; }
            return null;
        },
    });
    if (tempStr === undefined) { return; }

    const maxRoundsStr = await vscode.window.showInputBox({
        prompt: 'Max tool-use rounds per request',
        value: String(existing?.maxRounds ?? 20),
        validateInput: (v) => {
            const n = parseInt(v, 10);
            if (!Number.isFinite(n) || n < 1) { return 'Enter a positive integer'; }
            return null;
        },
    });
    if (maxRoundsStr === undefined) { return; }

    // Tool approval + enabledTools are no longer part of the configuration —
    // they live on the profile (see anthropic-handler.ts AnthropicProfile).

    const memoryToolsPick = await vscode.window.showQuickPick(
        [
            { label: 'No', value: false },
            { label: 'Yes', value: true },
        ],
        {
            placeHolder: `Expose memory write tools? (current: ${existing?.memoryToolsEnabled ? 'Yes' : 'No'})`,
            ignoreFocusOut: true,
        },
    );
    if (!memoryToolsPick) { return; }

    // Transport-specific fields
    let historyMode: string | undefined = existing?.historyMode ?? 'last';
    let maxHistoryTokens: number | undefined = existing?.maxHistoryTokens;
    let promptCachingEnabled = existing?.promptCachingEnabled === true;
    let agentSdkOpts: { permissionMode: 'default' | 'acceptEdits' | 'plan' | 'bypassPermissions'; settingSources: Array<'user' | 'project' | 'local'>; maxTurns?: number } | undefined;

    if (transport === 'vscodeLm') {
        // VS Code LM: same history handling as Direct (our own compaction
        // pipeline — the VS Code LM API doesn't give us SDK-managed
        // sessions). Prompt caching doesn't apply (no cache_control
        // headers on the VS Code LM API).
        const historyPick = await vscode.window.showQuickPick(
            [
                { label: 'trim_and_summary', description: 'Running summary + last N raw turns (recommended)', value: 'trim_and_summary' },
                { label: 'full', description: 'Every turn verbatim (capped by Full trail mode max turns)', value: 'full' },
                { label: 'summary', description: 'Replace history with a 2-message summary every turn', value: 'summary' },
            ],
            {
                placeHolder: 'History mode',
                ignoreFocusOut: true,
            },
        );
        if (!historyPick) { return; }
        historyMode = historyPick.value;
        if (historyMode === 'trim_and_summary' || historyMode === 'summary') {
            const maxHistStr = await vscode.window.showInputBox({
                prompt: 'Max history tokens (blank to omit)',
                value: existing?.maxHistoryTokens !== undefined ? String(existing.maxHistoryTokens) : '16000',
                validateInput: (v) => {
                    if (v.trim() === '') { return null; }
                    const n = parseInt(v, 10);
                    if (!Number.isFinite(n) || n < 0) { return 'Enter a non-negative integer (or leave blank)'; }
                    return null;
                },
            });
            if (maxHistStr === undefined) { return; }
            maxHistoryTokens = maxHistStr.trim() === '' ? undefined : parseInt(maxHistStr, 10);
        } else {
            maxHistoryTokens = undefined;
        }
        promptCachingEnabled = false;
    } else if (transport === 'direct') {
        const historyPick = await vscode.window.showQuickPick(
            [
                { label: 'trim_and_summary', description: 'Running summary + last N raw turns (recommended)', value: 'trim_and_summary' },
                { label: 'full', description: 'Every turn verbatim (capped by Full trail mode max turns)', value: 'full' },
                { label: 'summary', description: 'Replace history with a 2-message summary every turn', value: 'summary' },
                { label: 'llm_extract', description: 'Summarize + extract durable facts to memory', value: 'llm_extract' },
            ],
            {
                placeHolder: 'History mode',
                ignoreFocusOut: true,
            },
        );
        if (!historyPick) { return; }
        historyMode = historyPick.value;

        if (historyMode === 'trim_and_summary' || historyMode === 'summary' || historyMode === 'llm_extract') {
            const maxHistStr = await vscode.window.showInputBox({
                prompt: 'Max history tokens (blank to omit)',
                value: existing?.maxHistoryTokens !== undefined ? String(existing.maxHistoryTokens) : '16000',
                validateInput: (v) => {
                    if (v.trim() === '') { return null; }
                    const n = parseInt(v, 10);
                    if (!Number.isFinite(n) || n < 0) { return 'Enter a non-negative integer (or leave blank)'; }
                    return null;
                },
            });
            if (maxHistStr === undefined) { return; }
            maxHistoryTokens = maxHistStr.trim() === '' ? undefined : parseInt(maxHistStr, 10);
        } else {
            maxHistoryTokens = undefined;
        }

        const cachePick = await vscode.window.showQuickPick(
            [
                { label: 'No', value: false },
                { label: 'Yes', value: true },
            ],
            {
                placeHolder: `Prompt caching (cache_control on system prompt)? (current: ${promptCachingEnabled ? 'Yes' : 'No'})`,
                ignoreFocusOut: true,
            },
        );
        if (!cachePick) { return; }
        promptCachingEnabled = cachePick.value;
    } else {
        // agentSdk
        const modePick = await vscode.window.showQuickPick(
            [
                { label: 'default', description: 'Prompt for dangerous ops via canUseTool', value: 'default' as const },
                { label: 'acceptEdits', description: 'Auto-accept file edit operations', value: 'acceptEdits' as const },
                { label: 'plan', description: 'Planning mode — no execution of tools', value: 'plan' as const },
                { label: 'bypassPermissions', description: 'Bypass all permission checks (dangerous)', value: 'bypassPermissions' as const },
            ],
            {
                placeHolder: 'Agent SDK permission mode',
                ignoreFocusOut: true,
            },
        );
        if (!modePick) { return; }

        const sourcesPick = await vscode.window.showQuickPick(
            [
                { label: 'user', description: '~/.claude/settings.json', value: 'user' as const, picked: existing?.agentSdk?.settingSources?.includes('user') },
                { label: 'project', description: '.claude/settings.json (needed to load CLAUDE.md)', value: 'project' as const, picked: existing?.agentSdk?.settingSources?.includes('project') },
                { label: 'local', description: '.claude/settings.local.json', value: 'local' as const, picked: existing?.agentSdk?.settingSources?.includes('local') },
            ],
            {
                canPickMany: true,
                placeHolder: 'Setting sources to load (blank = isolation mode)',
                ignoreFocusOut: true,
            },
        );
        if (!sourcesPick) { return; }

        const maxTurnsStr = await vscode.window.showInputBox({
            prompt: 'Agent SDK maxTurns (blank to use maxRounds)',
            value: existing?.agentSdk?.maxTurns !== undefined ? String(existing.agentSdk.maxTurns) : '',
            placeHolder: 'leave blank to fall back to maxRounds',
            validateInput: (v) => {
                if (v.trim() === '') { return null; }
                const n = parseInt(v, 10);
                if (!Number.isFinite(n) || n < 1) { return 'Enter a positive integer (or leave blank)'; }
                return null;
            },
        });
        if (maxTurnsStr === undefined) { return; }

        agentSdkOpts = {
            permissionMode: modePick.value,
            settingSources: sourcesPick.map((s) => s.value),
            ...(maxTurnsStr.trim() === '' ? {} : { maxTurns: parseInt(maxTurnsStr, 10) }),
        };

        // Agent SDK history mode picker. 'sdk-managed' (default) uses the
        // SDK's own session-resume mechanism; the other two reuse our own
        // compaction pipeline and inject the compacted summary + raw
        // turns into the user prompt via a memory-injection template.
        const agentHistoryPick = await vscode.window.showQuickPick(
            [
                { label: 'sdk-managed', description: 'Claude Code SDK session resume (persisted per window). Default.', value: 'sdk-managed' as const },
                { label: 'trim_and_summary', description: 'Our running summary + last N raw turns, prepended to the prompt', value: 'trim_and_summary' as const },
                { label: 'full', description: 'Every turn verbatim, prepended to the prompt (capped by Full trail mode max turns)', value: 'full' as const },
            ],
            {
                placeHolder: 'Agent SDK history mode',
                ignoreFocusOut: true,
            },
        );
        if (!agentHistoryPick) { return; }
        historyMode = agentHistoryPick.value;
        // For the two memory-injection modes, let the user set the token
        // budget that the compaction template targets.
        if (historyMode === 'trim_and_summary') {
            const maxHistStr = await vscode.window.showInputBox({
                prompt: 'Compacted history max tokens (target for the summary prepended to the prompt)',
                value: existing?.maxHistoryTokens !== undefined ? String(existing.maxHistoryTokens) : '8000',
                validateInput: (v) => {
                    const n = parseInt(v, 10);
                    if (!Number.isFinite(n) || n < 0) { return 'Enter a non-negative integer'; }
                    return null;
                },
            });
            if (maxHistStr === undefined) { return; }
            maxHistoryTokens = parseInt(maxHistStr, 10);
        } else {
            maxHistoryTokens = existing?.maxHistoryTokens;
        }
    }

    const existingCompactionOverride = (existing as { compactionOverride?: 'default' | 'on' | 'off' } | undefined)?.compactionOverride ?? 'default';
    const compactionOverridePick = await vscode.window.showQuickPick(
        [
            { label: 'Default', description: 'Use the global "Disable compaction & memory extraction" checkbox on the status page', value: 'default' as const },
            { label: 'On',      description: 'Force compaction + memory extraction ON for this configuration, even if globally disabled', value: 'on' as const },
            { label: 'Off',     description: 'Force compaction + memory extraction OFF for this configuration, even if globally enabled', value: 'off' as const },
        ],
        {
            placeHolder: `Compaction & memory extraction override (current: ${existingCompactionOverride})`,
            ignoreFocusOut: true,
        },
    );
    if (!compactionOverridePick) { return; }

    const defaultPick = await vscode.window.showQuickPick(
        [
            { label: 'No', value: false },
            { label: 'Yes', value: true },
        ],
        {
            placeHolder: `Set as default configuration? (current: ${existing?.isDefault ? 'Yes' : 'No'})`,
            ignoreFocusOut: true,
        },
    );
    if (!defaultPick) { return; }

    const updated: NonNullable<NonNullable<ReturnType<typeof loadSendToChatConfig>>['anthropic']>['configurations'] extends (infer E)[] | undefined ? E : never =
        {
            id: newId!,
            name: newName.trim(),
            model: newModel,
            maxTokens: parseInt(maxTokensStr, 10),
            maxRounds: parseInt(maxRoundsStr, 10),
            memoryToolsEnabled: memoryToolsPick.value,
            isDefault: defaultPick.value,
            transport,
            // Store only the non-default values to keep the JSON clean —
            // 'default' is the same as "field absent" for the handler.
            ...(compactionOverridePick.value === 'default' ? {} : { compactionOverride: compactionOverridePick.value }),
            ...(tempStr.trim() === '' ? {} : { temperature: parseFloat(tempStr) }),
            ...(transport === 'direct'
                ? {
                    historyMode,
                    ...(maxHistoryTokens !== undefined ? { maxHistoryTokens } : {}),
                    promptCachingEnabled,
                }
                : transport === 'vscodeLm'
                    ? {
                        historyMode,
                        ...(maxHistoryTokens !== undefined ? { maxHistoryTokens } : {}),
                        vscodeLm: vscodeLmOpts!,
                    }
                    : { agentSdk: agentSdkOpts! }),
        };

    // If the user marked this one default, clear the flag on every other
    // configuration so the UI shows a single default.
    if (updated.isDefault) {
        for (const c of all) {
            if (c && c.id !== updated.id) { c.isDefault = false; }
        }
    }

    if (existing) {
        const idx = all.indexOf(existing);
        all[idx] = updated;
    } else {
        all.push(updated);
    }
    saveSendToChatConfig(stcConfig);
    vscode.window.showInformationMessage(
        isNew ? `Added Anthropic configuration "${updated.name}"` : `Updated Anthropic configuration "${updated.name}"`,
    );
    notifyAnthropicConfigChanged();
    await refreshStatusPage();
}

/**
 * Make a tiny one-shot Anthropic request to verify the API key env var
 * is set and accepted. Uses the first available model from `models.list()`
 * (or the configuration's default model when present) and asks for a
 * single-token reply. Reports success or the error message via a
 * VS Code notification.
 *
 * Spec §18 — works for direct transport. Agent SDK transport doesn't use
 * apiKeyEnvVar, so we surface a hint pointing the user at `claude login`.
 */
/**
 * Compaction/memory-extraction dry-run. Uses the values the user just picked
 * in the status page form (not the saved config), runs one full compaction
 * pass, and lets the existing compaction-log channel capture the details.
 *
 * Side-effects:
 *   - Writes raw prompts/answers to the trail (same place as normal runs).
 *   - Writes memory entries when the mode is `llm_extract` and the memory
 *     extraction template returns non-empty output. We surface this in the
 *     confirmation dialog so the user can opt out.
 *   - Does NOT mutate the active Anthropic handler's rolling history.
 */
async function runCompactionDryRun(settings: {
    llmProvider?: string;
    llmConfigId?: string;
    compactionTemplateId?: string;
    memoryExtractionTemplateId?: string;
    compactionMaxRounds?: number;
    maxHistoryTokens?: number;
    historyMaxChars?: number;
    memoryMaxChars?: number;
}): Promise<void> {
    const mode = await vscode.window.showQuickPick(
        [
            { label: 'summary', description: 'Replace history with a 2-message summary', value: 'summary' as const },
            { label: 'trim_and_summary', description: 'Trim-then-summarize (recommended for long sessions)', value: 'trim_and_summary' as const },
            { label: 'llm_extract', description: 'Extract facts from the latest exchange + keep last turn', value: 'llm_extract' as const },
        ],
        { placeHolder: 'History mode for the dry run', ignoreFocusOut: true },
    );
    if (!mode) { return; }

    // Use the live rolling history when non-empty; otherwise fabricate a
    // compact synthetic history so the LLM has something to compact.
    const liveHistory = AnthropicHandler.instance.getHistory();
    const syntheticHistory: ConversationMessage[] = [
        { role: 'user', content: 'Walk me through how the compaction subsystem decides when to run.' },
        { role: 'assistant', content: 'Compaction runs fire-and-forget after every exchange today (anthropic-handler.ts sendMessage). It has no awareness of the model context window; maxHistoryTokens is a static profile value.' },
        { role: 'user', content: 'And what about memory extraction — which modes do that?' },
        { role: 'assistant', content: 'Only the llm_extract mode. It runs a separate LLM call on the last user/assistant pair and appends the distilled facts via TwoTierMemoryService.append to the target memory file.' },
        { role: 'user', content: 'Where are the prompts/answers logged?' },
        { role: 'assistant', content: 'Raw prompts and answers are written under _ai/trail/anthropic/<quest>/compaction/ and .../memory/ by TrailService. The compaction-log output channel (new) also indexes every call with the template id, LLM config, turn counts, and memory write targets.' },
    ];
    const history = liveHistory.length > 0 ? liveHistory : syntheticHistory;

    const questId = WsPaths.getWorkspaceQuestId() ?? '';
    const saved = loadSendToChatConfig()?.compaction ?? {};
    const llmProvider: CompactionLlmProvider = (settings.llmProvider === 'anthropic' ? 'anthropic' : 'localLlm');
    const llmConfigId = String(settings.llmConfigId || saved.llmConfigId || '').trim();
    if (!llmConfigId) {
        vscode.window.showWarningMessage('Dry run: no LLM configuration selected. Pick one in the Compaction section first.');
        return;
    }
    const maxHistoryTokens = Number.isFinite(settings.maxHistoryTokens) ? settings.maxHistoryTokens : saved.maxHistoryTokens ?? 8000;
    const historyMaxChars = Number.isFinite(settings.historyMaxChars) ? settings.historyMaxChars : saved.historyMaxChars ?? 24000;
    const memoryMaxChars = Number.isFinite(settings.memoryMaxChars) ? settings.memoryMaxChars : saved.memoryMaxChars ?? 8000;
    const compactionMaxRounds = Number.isFinite(settings.compactionMaxRounds) ? settings.compactionMaxRounds : saved.compactionMaxRounds ?? 1;

    showCompactionChannel();
    logRunBanner('DRY RUN', [
        `mode=${mode.value}`,
        `provider=${llmProvider}  config=${llmConfigId}`,
        `history=${history.length} messages (${liveHistory.length > 0 ? 'from live session' : 'synthetic'})`,
        `maxHistoryTokens=${maxHistoryTokens}  historyMaxChars=${historyMaxChars}  memoryMaxChars=${memoryMaxChars}  maxRounds=${compactionMaxRounds}`,
        `quest=${questId || '(none)'}`,
    ]);

    try {
        await compactHistoryDetailed([...history], {
            mode: mode.value as HistoryMode,
            llmProvider,
            llmConfigId,
            compactionTemplateId: String(settings.compactionTemplateId || saved.compactionTemplateId || ''),
            memoryTemplateId: String(settings.memoryExtractionTemplateId || saved.memoryExtractionTemplateId || ''),
            compactionMaxRounds,
            maxHistoryTokens,
            historyMaxChars,
            memoryMaxChars,
            questId: questId || undefined,
            source: 'dry-run',
            onProgress: (m) => logRunBanner('progress', [m]),
        });
        vscode.window.showInformationMessage(
            `Compaction dry run complete — see "Tom AI Compaction and Memory Extraction" output channel and _ai/trail/anthropic/<quest>/compaction/ for details.${mode.value === 'llm_extract' ? ' Memory files were appended to if extraction produced output.' : ''}`,
        );
    } catch (e) {
        logCompactionError('dry run failed', e);
        vscode.window.showErrorMessage(`Compaction dry run failed: ${e instanceof Error ? e.message : String(e)}`);
    }
}

async function runTestAnthropicApiKey(): Promise<void> {
    const anthropic = getAnthropicSection();
    const envVar = anthropic.apiKeyEnvVar || 'ANTHROPIC_API_KEY';
    const present = !!process.env[envVar];
    if (!present) {
        vscode.window.showWarningMessage(
            `Env var "${envVar}" is not set in the extension host. Set it in your shell init (~/.profile), then restart VS Code from a shell that has the variable.`,
        );
        return;
    }

    const handler = AnthropicHandler.instance;
    const fetchResult = await handler.fetchModels();
    if (fetchResult.error) {
        vscode.window.showErrorMessage(`Anthropic API key test failed (models.list): ${fetchResult.error}`);
        return;
    }
    if (fetchResult.models.length === 0) {
        vscode.window.showWarningMessage('Anthropic API returned an empty model list — key may be valid but has no model access.');
        return;
    }
    // Only pick a Direct configuration for the API-key test — its model
    // must be a real Anthropic model id, which vscodeLm configs don't
    // carry (they store VS Code LM model ids there).
    const firstConfig = anthropic.configurations?.find(
        (c) => c && (c.transport === 'direct' || c.transport === undefined),
    );
    const model = firstConfig?.model || fetchResult.models[0].id;
    try {
        const reply = await handler.runInternalCall({
            systemPrompt: 'You are a connectivity probe.',
            userPrompt: 'Reply with the single word: pong',
            model,
            maxTokens: 16,
            temperature: 0,
        });
        const trimmed = (reply || '').trim();
        vscode.window.showInformationMessage(
            `Anthropic API key OK — model "${model}" replied "${trimmed.slice(0, 80) || '(empty)'}"`,
        );
    } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        vscode.window.showErrorMessage(`Anthropic API key test failed: ${msg}`);
    }
}

/**
 * Shared action handler for status panel actions.
 * Used by both the embedded sidebar panel and the full status page webview.
 */
export async function handleStatusAction(action: string, message: any): Promise<void> {
    switch (action) {
        // Queue & Timer
        case 'setQueueOn':
        case 'setQueueOff': {
            try {
                const { PromptQueueManager } = await import('../managers/promptQueueManager.js');
                PromptQueueManager.instance.autoSendEnabled = action === 'setQueueOn';
            } catch { /* not initialised */ }
            break;
        }
        case 'setQueueAutoStartOn':
        case 'setQueueAutoStartOff': {
            try {
                const { PromptQueueManager } = await import('../managers/promptQueueManager.js');
                PromptQueueManager.instance.autoStartEnabled = action === 'setQueueAutoStartOn';
            } catch { /* not initialised */ }
            break;
        }
        case 'setQueueAutoPauseOn':
        case 'setQueueAutoPauseOff': {
            try {
                const { PromptQueueManager } = await import('../managers/promptQueueManager.js');
                PromptQueueManager.instance.autoPauseEnabled = action === 'setQueueAutoPauseOn';
            } catch { /* not initialised */ }
            break;
        }
        case 'setQueueAutoContinueOn':
        case 'setQueueAutoContinueOff': {
            try {
                const { PromptQueueManager } = await import('../managers/promptQueueManager.js');
                PromptQueueManager.instance.autoContinueEnabled = action === 'setQueueAutoContinueOn';
            } catch { /* not initialised */ }
            break;
        }
        case 'setTimerOn':
        case 'setTimerOff': {
            try {
                const { TimerEngine } = await import('../managers/timerEngine.js');
                TimerEngine.instance.timerActivated = action === 'setTimerOn';
            } catch { /* not initialised */ }
            break;
        }
        case 'saveReloadPromptAfterReload': {
            const questId = WsPaths.getWorkspaceQuestId();
            const settings = readQueueSettings() || {};
            const updated = setQueueReloadAfterReloadSetting(settings, questId, {
                enabled: !!message.enabled,
                prompt: typeof message.prompt === 'string' ? message.prompt : '',
            });
            writeQueueSettings(updated);
            vscode.window.showInformationMessage(
                `Reload prompt setting saved${questId ? ` for quest ${questId}` : ''}`,
            );
            break;
        }
        // CLI Server
        case 'startCliServer':
            await vscode.commands.executeCommand('tomAi.cliServer.start');
            break;
        case 'stopCliServer':
            await vscode.commands.executeCommand('tomAi.cliServer.stop');
            break;
        case 'setCliAutostart': {
            const stcConfig = loadSendToChatConfig() || createEmptySendToChatConfig();
            if (!stcConfig.bridge) { stcConfig.bridge = { profiles: {} }; }
            stcConfig.bridge.cliServerAutostart = !!message.enabled;
            saveSendToChatConfig(stcConfig);
            break;
        }
        // Bridge
        case 'restartBridge':
            await vscode.commands.executeCommand('tomAi.bridge.restart');
            break;
        case 'switchProfile':
            await vscode.commands.executeCommand('tomAi.bridge.switchProfile', message.value);
            break;
        case 'switchToDevelopment':
            await vscode.commands.executeCommand('tomAi.bridge.switchProfile', 'development');
            break;
        case 'switchToProduction':
            await vscode.commands.executeCommand('tomAi.bridge.switchProfile', 'production');
            break;
        // Trail
        case 'setTrailOn':
            await setTrailEnabled(true);
            break;
        case 'setTrailOff':
            await setTrailEnabled(false);
            break;
        case 'updateTrailSettings': {
            const stcConfig = loadSendToChatConfig() || createEmptySendToChatConfig();
            if (!stcConfig.trail) { stcConfig.trail = {}; }
            if (message.cleanupDays !== undefined) { stcConfig.trail.cleanupDays = message.cleanupDays; }
            if (message.maxEntries !== undefined) { stcConfig.trail.maxEntries = message.maxEntries; }
            saveSendToChatConfig(stcConfig);
            vscode.window.showInformationMessage('Trail settings updated');
            break;
        }
        // Editors
        case 'openFullStatusPage':
            await vscode.commands.executeCommand('tomAi.statusPage');
            break;
        case 'openGlobalTemplateEditor':
            await vscode.commands.executeCommand('tomAi.editor.promptTemplates');
            break;
        case 'openReusablePromptEditor':
            await vscode.commands.executeCommand('tomAi.editor.reusablePrompts');
            break;
        case 'openContextSettingsEditor':
            await vscode.commands.executeCommand('tomAi.editor.contextSettings');
            break;
        case 'openChatVariablesEditor':
            await vscode.commands.executeCommand('tomAi.editor.chatVariables');
            break;
        case 'openTrailViewer':
            await vscode.commands.executeCommand('tomAi.editor.rawTrailViewer');
            break;
        case 'openTimedRequestsEditor':
            await vscode.commands.executeCommand('tomAi.editor.timedRequests');
            break;
        case 'openQueueEditor':
            await vscode.commands.executeCommand('tomAi.editor.promptQueue');
            break;
        case 'openTrailFile': {
            const questId = WsPaths.getWorkspaceQuestId();
            const wsRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
            const questFolder = WsPaths.ai('quests', questId) || (wsRoot ? path.join(wsRoot, '_ai', 'quests', questId) : '');
            if (questFolder) {
                const promptsPath = path.join(questFolder, `${questId}.copilot.prompts.md`);
                if (!fs.existsSync(promptsPath)) {
                    vscode.window.showInformationMessage('No summary trail exists yet. Send a prompt first.');
                    break;
                }
                await vscode.commands.executeCommand('vscode.openWith', vscode.Uri.file(promptsPath), 'tomAi.trailViewer');
            }
            break;
        }
        // Telegram
        case 'startTelegram':
        case 'stopTelegram':
            await vscode.commands.executeCommand('tomAi.telegram.toggle');
            break;
        case 'testTelegram':
            await vscode.commands.executeCommand('tomAi.telegram.testConnection');
            break;
        case 'setTelegramAutostart': {
            const stcConfig = loadSendToChatConfig() || createEmptySendToChatConfig();
            if (!stcConfig.aiConversation) { stcConfig.aiConversation = { profiles: {} }; }
            if (!stcConfig.aiConversation.telegram) { stcConfig.aiConversation.telegram = {}; }
            stcConfig.aiConversation.telegram.autostart = !!message.enabled;
            saveSendToChatConfig(stcConfig);
            break;
        }
        // Settings updates
        case 'updateLocalLlm':
            await updateLocalLlmSettings(message.settings || {});
            break;
        case 'updateAiConversation':
            await updateAiConversationSettings(message.settings || {});
            break;
        case 'updateTelegram':
            await updateTelegramSettings(message.settings || {});
            break;
        case 'updateAskCopilot':
            await updateAskCopilotSettings(message.settings || {});
            break;
        case 'updateAskBigBrother':
            await updateAskBigBrotherSettings(message.settings || {});
            break;
        case 'updateCompactionSettings': {
            const stcConfig = loadSendToChatConfig() || createEmptySendToChatConfig();
            if (!stcConfig.compaction) { stcConfig.compaction = {}; }
            const s = message.settings || {};
            stcConfig.compaction.disabled = s.disabled === true;
            stcConfig.compaction.llmProvider = s.llmProvider === 'anthropic' ? 'anthropic' : 'localLlm';
            stcConfig.compaction.llmConfigId = s.llmConfigId || '';
            stcConfig.compaction.compactionTemplateId = s.compactionTemplateId || '';
            stcConfig.compaction.memoryExtractionTemplateId = s.memoryExtractionTemplateId || '';
            stcConfig.compaction.compactionMaxRounds = Number.isFinite(s.compactionMaxRounds) ? s.compactionMaxRounds : 4;
            stcConfig.compaction.maxHistoryTokens = Number.isFinite(s.maxHistoryTokens) ? s.maxHistoryTokens : 8000;
            stcConfig.compaction.historyMaxChars = Number.isFinite(s.historyMaxChars) ? s.historyMaxChars : 24000;
            stcConfig.compaction.memoryMaxChars = Number.isFinite(s.memoryMaxChars) ? s.memoryMaxChars : 8000;
            stcConfig.compaction.fullTrailMaxTurns = Number.isFinite(s.fullTrailMaxTurns) ? s.fullTrailMaxTurns : 200;
            stcConfig.compaction.runMemoryExtractionOnCompaction = s.runMemoryExtractionOnCompaction !== false;
            stcConfig.compaction.rebuildFromLastNPrompts = Number.isFinite(s.rebuildFromLastNPrompts) ? s.rebuildFromLastNPrompts : 200;
            stcConfig.compaction.archiveHistoryEveryTurn = s.archiveHistoryEveryTurn === true;
            // Memory tool exposure + injection cap live under anthropic.memory
            // on disk (to match the handler that reads them) but are edited
            // in the Compaction panel now. The Anthropic Memory section has
            // been removed.
            if (!stcConfig.anthropic) { stcConfig.anthropic = {}; }
            if (!stcConfig.anthropic.memory) { stcConfig.anthropic.memory = {}; }
            if (typeof s.memoryToolsEnabled === 'boolean') {
                stcConfig.anthropic.memory.memoryToolsEnabled = s.memoryToolsEnabled;
            }
            if (Number.isFinite(s.memoryMaxInjectedTokens)) {
                stcConfig.anthropic.memory.maxInjectedTokens = s.memoryMaxInjectedTokens;
            }
            stcConfig.compaction.toolTrailMaxResultChars = Number.isFinite(s.toolTrailMaxResultChars) ? s.toolTrailMaxResultChars : 500;
            stcConfig.compaction.backgroundExtractionEnabled = s.backgroundExtractionEnabled === true;
            if (!stcConfig.trail) { stcConfig.trail = {}; }
            if (Number.isFinite(s.trailCleanupDays)) { stcConfig.trail.cleanupDays = s.trailCleanupDays; }
            saveSendToChatConfig(stcConfig);
            vscode.window.showInformationMessage('Compaction settings saved');
            break;
        }
        case 'runCompactionDryRun': {
            // Side-effect-free: uses the active rolling history if present
            // (or a small synthetic fallback), writes raw prompts/answers
            // under _ai/trail/anthropic/<quest>/compaction|memory/, logs a
            // structured summary to the 'Tom AI Compaction and Memory
            // Extraction' output channel, and discards the compacted
            // result. Memory writes DO happen (so the user can inspect
            // what was extracted) — they're always appends, and the user
            // is warned via the info message.
            await runCompactionDryRun(message.settings || {});
            break;
        }
        // `updateAnthropicMemorySettings` removed — the two settings
        // (memoryToolsEnabled, maxInjectedTokens) now live in the
        // Compaction section and are persisted by updateCompactionSettings.
        // -----------------------------------------------------------------
        // Anthropic configurations editor (spec §18.8)
        // -----------------------------------------------------------------
        case 'updateAnthropicApiKeyEnvVar': {
            const raw = typeof message.value === 'string' ? message.value.trim() : '';
            const envVar = raw || 'ANTHROPIC_API_KEY';
            const stcConfig = loadSendToChatConfig() || createEmptySendToChatConfig();
            if (!stcConfig.anthropic) { stcConfig.anthropic = {}; }
            stcConfig.anthropic.apiKeyEnvVar = envVar;
            saveSendToChatConfig(stcConfig);
            const present = !!process.env[envVar];
            vscode.window.showInformationMessage(
                `Anthropic API key env var set to "${envVar}"${present ? ' — variable is set' : ' — variable is NOT set in extension host env'}`,
            );
            // Push the change to the chat panel (resets the SDK client,
            // re-emits profiles/dots, and re-fetches models with the new
            // env var) so the user sees the model dropdown refresh
            // immediately, no panel reload required.
            notifyAnthropicConfigChanged();
            await refreshStatusPage();
            break;
        }
        case 'testAnthropicApiKey': {
            await runTestAnthropicApiKey();
            break;
        }
        case 'addAnthropicConfiguration': {
            await editOrCreateAnthropicConfiguration(null);
            break;
        }
        case 'editAnthropicConfiguration': {
            const configId = String(message.configId || '').trim();
            if (!configId) { break; }
            await editOrCreateAnthropicConfiguration(configId);
            break;
        }
        case 'deleteAnthropicConfiguration': {
            const configId = String(message.configId || '').trim();
            if (!configId) { break; }
            const confirm = await vscode.window.showWarningMessage(
                `Delete Anthropic configuration "${configId}"?`,
                { modal: true },
                'Delete',
            );
            if (confirm !== 'Delete') { break; }
            const stcConfig = loadSendToChatConfig() || createEmptySendToChatConfig();
            if (stcConfig.anthropic?.configurations) {
                stcConfig.anthropic.configurations = stcConfig.anthropic.configurations.filter((c) => c?.id !== configId);
                saveSendToChatConfig(stcConfig);
                vscode.window.showInformationMessage(`Deleted Anthropic configuration: ${configId}`);
                notifyAnthropicConfigChanged();
                await refreshStatusPage();
            }
            break;
        }
        case 'editCompactionTemplate': {
            await vscode.commands.executeCommand('tomAi.editor.promptTemplates', {
                category: 'compaction',
                itemId: message.itemId || undefined,
            });
            break;
        }
        case 'addCompactionTemplate': {
            await vscode.commands.executeCommand('tomAi.editor.promptTemplates', {
                category: 'compaction',
            });
            break;
        }
        case 'deleteCompactionTemplate': {
            const itemId = String(message.itemId || '').trim();
            if (!itemId) {
                vscode.window.showWarningMessage('Select a compaction template first.');
                break;
            }
            const stcConfig = loadSendToChatConfig() || createEmptySendToChatConfig();
            if (stcConfig.compaction?.templates) {
                stcConfig.compaction.templates = stcConfig.compaction.templates.filter(t => t.id !== itemId);
                saveSendToChatConfig(stcConfig);
                vscode.window.showInformationMessage(`Deleted compaction template: ${itemId}`);
            }
            break;
        }
        case 'editMemoryExtractionTemplate': {
            await vscode.commands.executeCommand('tomAi.editor.promptTemplates', {
                category: 'memoryExtraction',
                itemId: message.itemId || undefined,
            });
            break;
        }
        case 'addMemoryExtractionTemplate': {
            await vscode.commands.executeCommand('tomAi.editor.promptTemplates', {
                category: 'memoryExtraction',
            });
            break;
        }
        case 'deleteMemoryExtractionTemplate': {
            const itemId = String(message.itemId || '').trim();
            if (!itemId) {
                vscode.window.showWarningMessage('Select a memory extraction template first.');
                break;
            }
            const stcConfig = loadSendToChatConfig() || createEmptySendToChatConfig();
            if (stcConfig.compaction?.memoryExtractionTemplates) {
                stcConfig.compaction.memoryExtractionTemplates = stcConfig.compaction.memoryExtractionTemplates.filter(t => t.id !== itemId);
                saveSendToChatConfig(stcConfig);
                vscode.window.showInformationMessage(`Deleted memory extraction template: ${itemId}`);
            }
            break;
        }
        // `editCompactionToolSet` has been removed — compaction + memory
        // extraction tool sets are now configured per-template in the
        // Global Template Editor (compaction and memoryExtraction
        // categories), not at the section level.
        // Schedule
        case 'saveSchedule': {
            try {
                const { TimerEngine } = await import('../managers/timerEngine.js');
                TimerEngine.instance.setSchedule(message.schedule || []);
                vscode.window.showInformationMessage('Timer schedule saved');
            } catch { /* not initialised */ }
            break;
        }
        // Executables (includes binaryPath)
        case 'saveExecutables': {
            const stcConfig = loadSendToChatConfig() || createEmptySendToChatConfig();
            if (!stcConfig.bridge) { stcConfig.bridge = { profiles: {} }; }
            stcConfig.bridge.executables = message.executables || {};
            stcConfig.bridge.binaryPath = message.binaryPath || {};
            saveSendToChatConfig(stcConfig);
            vscode.window.showInformationMessage('Executables configuration saved');
            break;
        }
        // Commandlines
        case 'saveCommandlines': {
            const cfg = loadConfig() || {};
            cfg.commandlines = message.commandlines || [];
            saveConfig(cfg);
            vscode.window.showInformationMessage('Commandlines saved');
            break;
        }
        // Favorites
        case 'saveFavorites': {
            const cfg = loadConfig() || {};
            cfg.favorites = message.favorites || [];
            saveConfig(cfg);
            vscode.window.showInformationMessage('Favorites saved');
            break;
        }
        // LLM Profile model settings
        case 'saveLlmProfiles': {
            const cfg = loadConfig() || {};
            if (!cfg.localLlm) { cfg.localLlm = {}; }
            if (!cfg.localLlm.profiles) { cfg.localLlm.profiles = {}; }
            const profileSettings = message.profiles || {};
            for (const [name, settings] of Object.entries(profileSettings) as [string, any][]) {
                if (cfg.localLlm.profiles[name]) {
                    cfg.localLlm.profiles[name].modelConfig = settings.modelConfig || null;
                    cfg.localLlm.profiles[name].toolsEnabled = settings.toolsEnabled ?? true;
                }
            }
            saveConfig(cfg);
            vscode.window.showInformationMessage('LLM profile settings saved');
            break;
        }
        // AI Conversation profile model settings
        case 'saveConvProfiles': {
            const cfg = loadConfig() || {};
            if (!cfg.aiConversation) { cfg.aiConversation = {}; }
            if (!cfg.aiConversation.profiles) { cfg.aiConversation.profiles = {}; }
            const profileSettings = message.profiles || {};
            for (const [name, settings] of Object.entries(profileSettings) as [string, any][]) {
                if (cfg.aiConversation.profiles[name]) {
                    cfg.aiConversation.profiles[name].modelConfig = settings.modelConfig || null;
                }
            }
            saveConfig(cfg);
            vscode.window.showInformationMessage('AI Conversation profile settings saved');
            break;
        }
        // Model configuration management
        case 'addModelConfig': {
            const modelKey = await vscode.window.showInputBox({
                prompt: 'Enter a unique name for this model configuration',
                placeHolder: 'e.g., llama3-70b',
                validateInput: (value) => {
                    if (!value || value.trim().length === 0) { return 'Name is required'; }
                    const cfg = loadConfig() || {};
                    if (cfg.localLlm?.models?.[value.trim()]) { return 'Model configuration already exists'; }
                    return null;
                }
            });
            if (modelKey) {
                await editOrCreateModelConfig(modelKey.trim(), null);
            }
            break;
        }
        case 'editModelConfig': {
            const modelKey = message.modelKey;
            if (modelKey) {
                const cfg = loadConfig() || {};
                const existing = cfg.localLlm?.models?.[modelKey] || null;
                await editOrCreateModelConfig(modelKey, existing);
            }
            break;
        }
        case 'deleteModelConfig': {
            const modelKey = message.modelKey;
            if (modelKey) {
                const confirm = await vscode.window.showWarningMessage(
                    `Delete model configuration "${modelKey}"?`,
                    { modal: true },
                    'Delete'
                );
                if (confirm === 'Delete') {
                    const cfg = loadConfig() || {};
                    if (cfg.localLlm?.models?.[modelKey]) {
                        delete cfg.localLlm.models[modelKey];
                        saveConfig(cfg);
                        vscode.window.showInformationMessage(`Model configuration "${modelKey}" deleted`);
                        await refreshStatusPage();
                    }
                }
            }
            break;
        }
        // LLM Configuration management
        case 'saveLlmConfigurations': {
            const cfg = loadConfig() || {};
            cfg.localLlm = cfg.localLlm || {};
            cfg.localLlm.configurations = (message.configurations || []).map((config: LlmConfiguration) => ({
                id: config.id,
                name: config.name,
                ollamaUrl: config.ollamaUrl,
                model: config.model,
                temperature: config.temperature,
                stripThinkingTags: config.stripThinkingTags,
                trailMaximumTokens: config.trailMaximumTokens,
                removePromptTemplateFromTrail: config.removePromptTemplateFromTrail,
                trailSummarizationTemperature: config.trailSummarizationTemperature,
                trailSummarizationPrompt: config.trailSummarizationPrompt,
                answerFolder: config.answerFolder,
                logFolder: config.logFolder,
                historyMode: config.historyMode,
                enabledTools: config.enabledTools,
                keepAlive: config.keepAlive,
            }));
            saveConfig(cfg);
            vscode.window.showInformationMessage('LLM Configurations saved');
            break;
        }
        case 'deleteLlmConfiguration': {
            const configId = message.configId;
            if (configId) {
                const confirm = await vscode.window.showWarningMessage(
                    `Delete LLM Configuration "${configId}"?`,
                    { modal: true },
                    'Delete'
                );
                if (confirm === 'Delete') {
                    const cfg = loadConfig() || {};
                    cfg.localLlm = cfg.localLlm || {};
                    const arr = Array.isArray(cfg.localLlm.configurations) ? cfg.localLlm.configurations : [];
                    cfg.localLlm.configurations = arr.filter((c: any) => c.id !== configId);
                    saveConfig(cfg);
                    vscode.window.showInformationMessage(`LLM Configuration "${configId}" deleted`);
                    await refreshStatusPage();
                }
            }
            break;
        }
        // AI Conversation Setup management
        case 'saveAiConversationSetups': {
            const cfg = loadConfig() || {};
            cfg.aiConversation = cfg.aiConversation || {};
            cfg.aiConversation.setups = (message.setups || []).map((setup: AiConversationSetup) => ({
                id: setup.id,
                name: setup.name,
                llmConfigA: setup.llmConfigA,
                llmConfigB: setup.llmConfigB,
                maxTurns: setup.maxTurns,
                pauseBetweenTurns: setup.pauseBetweenTurns,
                historyMode: setup.historyMode,
                trailSummarizationLlmConfig: setup.trailSummarizationLlmConfig,
            }));
            saveConfig(cfg);
            vscode.window.showInformationMessage('AI Conversation Setups saved');
            break;
        }
        case 'deleteAiConversationSetup': {
            const setupId = message.setupId;
            if (setupId) {
                const confirm = await vscode.window.showWarningMessage(
                    `Delete AI Conversation Setup "${setupId}"?`,
                    'Delete'
                );
                if (confirm === 'Delete') {
                    const cfg = loadConfig() || {};
                    cfg.aiConversation = cfg.aiConversation || {};
                    const arr = Array.isArray(cfg.aiConversation.setups) ? cfg.aiConversation.setups : [];
                    cfg.aiConversation.setups = arr.filter((s: any) => s?.id !== setupId);
                    saveConfig(cfg);
                    vscode.window.showInformationMessage(`AI Conversation Setup "${setupId}" deleted`);
                    await refreshStatusPage();
                }
            }
            break;
        }
    }
}

/**
 * Status data for the webview
 */
export interface StatusData {
    queue: {
        autoSendEnabled: boolean;
        autoStartEnabled: boolean;
        autoPauseEnabled: boolean;
        autoContinueEnabled: boolean;
        reloadPromptAfterReloadEnabled: boolean;
        reloadPromptAfterReloadText: string;
        scopeLabel: string;
    };
    timer: {
        timerActivated: boolean;
    };
    cliServer: {
        running: boolean;
        port?: number;
        autostart: boolean;
    };
    bridge: {
        connected: boolean;
        currentProfile: string;
        profiles: string[];
    };
    trail: {
        enabled: boolean;
        cleanupDays: number;
        maxEntries: number;
    };
    telegram: {
        polling: boolean;
        enabled: boolean;
        autostart: boolean;
        botTokenEnv: string;
        defaultChatId: number;
        pollIntervalMs: number;
        notifyOnTurn: boolean;
        notifyOnStart: boolean;
        notifyOnEnd: boolean;
    };
    localLlm: {
        ollamaUrl: string;
        model: string;
        temperature: number;
        stripThinkingTags: boolean;
        expansionProfile: string;
        trailMaximumTokens: number;
        trailSummarizationTemperature: number;
        removePromptTemplateFromTrail: boolean;
        toolsEnabled: boolean;
        profiles: string[];
        models: string[];
        profileDetails: { [name: string]: { modelConfig: string | null; toolsEnabled?: boolean } };
        modelDetails: { [name: string]: { ollamaUrl: string; model: string; temperature: number; stripThinkingTags: boolean; description: string; isDefault: boolean; keepAlive: string } };
    };
    aiConversation: {
        maxTurns: number;
        temperature: number;
        historyMode: string;
        conversationMode: string;
        trailMaximumTokens: number;
        trailSummarizationTemperature: number;
        removePromptTemplateFromTrail: boolean;
        toolsEnabled: boolean;
        profiles: string[];
        profileDetails: { [name: string]: { modelConfig: string | null } };
    };
    askCopilot: AskCopilotConfig;
    copilotAnswerFolder: string;
    askBigBrother: AskBigBrotherConfig;
    templateNames: string[];
    schedule: TimerScheduleSlot[];
    executables: { [name: string]: { [platform: string]: string } };
    binaryPath: { [platform: string]: string };
    commandlines: CommandlineEntry[];
    favorites: FavoriteEntry[];
    /** Named LLM configurations for Local LLM @CHAT panel */
    configurations: LlmConfiguration[];
    /** Named AI Conversation setups for AI Conversation @CHAT panel */
    setups: AiConversationSetup[];
    /** Strict configuration validation errors shown in UI/output */
    configErrors: string[];
    /** History compaction settings (anthropic_sdk_integration.md §10). */
    compaction: {
        /** Global kill switch — skip the background compaction + memory
         *  extraction pass after every Anthropic turn. Default false. */
        disabled: boolean;
        llmProvider: 'localLlm' | 'anthropic';
        llmConfigId: string;
        compactionTemplateId: string;
        memoryExtractionTemplateId: string;
        /** Raw turns sent alongside the compacted summary. */
        compactionMaxRounds: number;
        /** Target size of the compacted-history summary (tokens). */
        maxHistoryTokens: number;
        /** Hard cap on history content injected into compaction + memory-
         *  extraction prompts (chars). Also surfaced to the compaction
         *  template as ${historyMaxChars}. */
        historyMaxChars: number;
        /** Hard cap on existing memory injected into the memory-extraction
         *  prompt (chars). */
        memoryMaxChars: number;
        /** Turn cap for `full` mode so it can't grow unbounded. */
        fullTrailMaxTurns: number;
        toolTrailMaxResultChars: number;
        backgroundExtractionEnabled: boolean;
        /** When true, memory extraction runs after every compaction call
         *  (checkbox in the status page). Default true. */
        runMemoryExtractionOnCompaction: boolean;
        /**
         * When no history file exists but compact trail files (the
         * quest's .prompts.md / .answers.md) do, we reconstruct a
         * history from the last N prompt/answer pairs. Default 200.
         */
        rebuildFromLastNPrompts: number;
        /**
         * Debug toggle: also persist a timestamped history snapshot
         * every turn (in addition to the rolling history.json).
         */
        archiveHistoryEveryTurn: boolean;
    };
    /**
     * Anthropic memory subsystem defaults. Previously rendered in its own
     * Status Page section; those two settings now live inside the History
     * Compaction section, but the shape is still exposed here so the
     * template reads the current values when rendering.
     */
    anthropicMemory: {
        memoryToolsEnabled: boolean;
        maxInjectedTokens: number;
    };
    /** Templates available for the compaction `<select>` controls. */
    compactionTemplateChoices: Array<{ id: string; name: string }>;
    memoryExtractionTemplateChoices: Array<{ id: string; name: string }>;
    /** Anthropic configurations (id+name) for the compaction provider select. */
    anthropicConfigurationChoices: Array<{ id: string; name: string }>;
    /** Environment variable name that holds the Anthropic API key (anthropic_sdk_integration.md §14). */
    anthropicApiKeyEnvVar: string;
    /** Anthropic configurations summary for the editor (anthropic_sdk_integration.md §18.8). */
    anthropicConfigurationsSummary: Array<{
        id: string;
        name: string;
        model: string;
        transport: 'direct' | 'agentSdk' | 'vscodeLm';
        permissionMode?: string;
        promptCachingEnabled: boolean;
        historyMode: string;
        isDefault: boolean;
        // Extended detail so the configurations table can render the
        // full settings inline and the user knows what `Edit` is
        // about to replace. Any field that's absent on an individual
        // configuration simply renders as "—" in the view.
        maxTokens?: number;
        maxRounds?: number;
        temperature?: number;
        maxHistoryTokens?: number;
        memoryToolsEnabled?: boolean;
        settingSources?: Array<'user' | 'project' | 'local'>;
        maxTurns?: number;
        // VS Code LM fields; populated when transport === 'vscodeLm'.
        vscodeLmVendor?: string;
        vscodeLmFamily?: string;
        vscodeLmModelId?: string;
    }>;
}

/**
 * Gather all status data
 */
export async function gatherStatusData(): Promise<StatusData> {
    // CLI Server status
    const cliStatus = await getCliServerStatus();
    
    // Bridge status
    const bridgeClient = getBridgeClient();
    const bridgeConfig = loadBridgeConfig();
    
    // Trail status
    loadTrailConfig();
    
    // Load config for local LLM, AI conversation, telegram, and trail settings
    const config = loadConfig();
    const sendToChatConfig = loadSendToChatConfig();
    const strictErrors = validateStrictAiConfiguration(sendToChatConfig);
    if (strictErrors.length > 0) {
        const msg = `[Status Page] Invalid strict AI configuration:\n- ${strictErrors.join('\n- ')}`;
        console.error(msg);
    }
    const localLlm = config?.localLlm || {};
    const aiConversation = config?.aiConversation || {};
    const telegram = aiConversation?.telegram || {};
    const questId = WsPaths.getWorkspaceQuestId();

    const configurations = Array.isArray(config?.localLlm?.configurations)
        ? config.localLlm.configurations
        : [];
    const setups = Array.isArray(config?.aiConversation?.setups)
        ? config.aiConversation.setups
        : [];
    const primarySetup = setups[0] as any;
    const primaryLlm = configurations.find((l: any) => l?.id === primarySetup?.llmConfigA) as any;

    // Queue and timer state
    let queueAutoSend = true;
    let queueAutoStart = false;
    let queueAutoPause = true;
    let queueAutoContinue = false;
    const queueSettings = readQueueSettings();
    const queueReloadPrompt = getQueueReloadAfterReloadSetting(queueSettings, questId);
    const queueReloadPromptEnabled = queueReloadPrompt.enabled === true;
    const queueReloadPromptText = queueReloadPrompt.prompt || '';
    try {
        const { PromptQueueManager } = await import('../managers/promptQueueManager.js');
        queueAutoSend = PromptQueueManager.instance.autoSendEnabled;
        queueAutoStart = PromptQueueManager.instance.autoStartEnabled;
        queueAutoPause = PromptQueueManager.instance.autoPauseEnabled;
        queueAutoContinue = PromptQueueManager.instance.autoContinueEnabled;
    } catch { /* not initialised yet */ }
    let timerActivated = true;
    let schedule: TimerScheduleSlot[] = [];
    try {
        const { TimerEngine } = await import('../managers/timerEngine.js');
        timerActivated = TimerEngine.instance.timerActivated;
        schedule = [...TimerEngine.instance.schedule];
    } catch { /* not initialised yet */ }
    
    return {
        queue: {
            autoSendEnabled: queueAutoSend,
            autoStartEnabled: queueAutoStart,
            autoPauseEnabled: queueAutoPause,
            autoContinueEnabled: queueAutoContinue,
            reloadPromptAfterReloadEnabled: queueReloadPromptEnabled,
            reloadPromptAfterReloadText: queueReloadPromptText,
            scopeLabel: questId ? `quest: ${questId}` : 'workspace',
        },
        timer: {
            timerActivated,
        },
        cliServer: {
            running: cliStatus.running,
            port: cliStatus.port,
            autostart: sendToChatConfig?.bridge?.cliServerAutostart ?? false,
        },
        bridge: {
            connected: bridgeClient !== null,
            currentProfile: bridgeConfig?.current ?? 'default',
            profiles: bridgeConfig ? Object.keys(bridgeConfig.profiles) : ['default'],
        },
        trail: {
            enabled: isTrailEnabled(),
            cleanupDays: sendToChatConfig?.trail?.cleanupDays ?? 2,
            maxEntries: sendToChatConfig?.trail?.maxEntries ?? 1000,
        },
        telegram: {
            polling: isTelegramPollingActive(),
            enabled: telegram.enabled ?? false,
            autostart: sendToChatConfig?.aiConversation?.telegram?.autostart ?? false,
            botTokenEnv: telegram.botTokenEnv ?? 'TELEGRAM_BOT_TOKEN',
            defaultChatId: telegram.defaultChatId ?? 0,
            pollIntervalMs: telegram.pollIntervalMs ?? 3000,
            notifyOnTurn: telegram.notifyOnTurn ?? true,
            notifyOnStart: telegram.notifyOnStart ?? true,
            notifyOnEnd: telegram.notifyOnEnd ?? true,
        },
        localLlm: {
            ollamaUrl: localLlm.ollamaUrl ?? 'http://localhost:11434',
            model: localLlm.model ?? 'qwen3:8b',
            temperature: localLlm.temperature ?? 0.4,
            stripThinkingTags: localLlm.stripThinkingTags ?? true,
            expansionProfile: localLlm.expansionProfile ?? 'expand',
            trailMaximumTokens: localLlm.trailMaximumTokens ?? 8000,
            trailSummarizationTemperature: localLlm.trailSummarizationTemperature ?? 0.3,
            removePromptTemplateFromTrail: localLlm.removePromptTemplateFromTrail ?? true,
            toolsEnabled: localLlm.toolsEnabled ?? true,
            profiles: localLlm.profiles ? Object.keys(localLlm.profiles) : [],
            models: localLlm.models ? Object.keys(localLlm.models) : [],
            profileDetails: Object.fromEntries(
                Object.entries(localLlm.profiles || {}).map(([k, v]: [string, any]) => [
                    k, { modelConfig: v?.modelConfig ?? null, toolsEnabled: v?.toolsEnabled ?? true }
                ])
            ),
            modelDetails: Object.fromEntries(
                Object.entries(localLlm.models || {}).map(([k, v]: [string, any]) => [
                    k, {
                        ollamaUrl: v?.ollamaUrl ?? 'http://localhost:11434',
                        model: v?.model ?? '',
                        temperature: v?.temperature ?? 0.4,
                        stripThinkingTags: v?.stripThinkingTags ?? true,
                        description: v?.description ?? '',
                        isDefault: v?.isDefault ?? false,
                        keepAlive: v?.keepAlive ?? '5m',
                    }
                ])
            ),
        },
        aiConversation: {
            maxTurns: primarySetup?.maxTurns ?? 0,
            temperature: primaryLlm?.temperature ?? 0,
            historyMode: primarySetup?.historyMode ?? 'trim_and_summary',
            conversationMode: aiConversation.conversationMode ?? 'ollama-copilot',
            trailMaximumTokens: primaryLlm?.trailMaximumTokens ?? 0,
            trailSummarizationTemperature: primaryLlm?.trailSummarizationTemperature ?? 0,
            removePromptTemplateFromTrail: primaryLlm?.removePromptTemplateFromTrail ?? false,
            toolsEnabled: Array.isArray(primaryLlm?.enabledTools) ? primaryLlm.enabledTools.length > 0 : false,
            profiles: aiConversation.profiles ? Object.keys(aiConversation.profiles) : [],
            profileDetails: Object.fromEntries(
                Object.entries(aiConversation.profiles || {}).map(([k, v]: [string, any]) => [
                    k, { modelConfig: v?.modelConfig ?? null }
                ])
            ),
        },
        ...loadLocalLlmToolsConfig(),
        copilotAnswerFolder: loadSendToChatConfig()?.copilot?.answerFolder ?? WsPaths.aiRelative('copilot'),
        templateNames: Object.keys(sendToChatConfig?.copilot?.templates || {}),
        schedule,
        executables: sendToChatConfig?.bridge?.executables || {},
        binaryPath: sendToChatConfig?.bridge?.binaryPath || {},
        commandlines: (config?.commandlines || []) as CommandlineEntry[],
        favorites: (config?.favorites || []) as FavoriteEntry[],
        configurations: configurations.map((v: any) => ({
            id: v?.id || '',
            name: v?.name || v?.id || '',
            ollamaUrl: v?.ollamaUrl || '',
            model: v?.model || '',
            temperature: typeof v?.temperature === 'number' ? v.temperature : 0,
            stripThinkingTags: v?.stripThinkingTags === true,
            trailMaximumTokens: typeof v?.trailMaximumTokens === 'number' ? v.trailMaximumTokens : 0,
            removePromptTemplateFromTrail: v?.removePromptTemplateFromTrail === true,
            trailSummarizationTemperature: typeof v?.trailSummarizationTemperature === 'number' ? v.trailSummarizationTemperature : 0,
            trailSummarizationPrompt: v?.trailSummarizationPrompt || '',
            answerFolder: v?.answerFolder || '',
            logFolder: v?.logFolder || '',
            historyMode: typeof v?.historyMode === 'string' ? v.historyMode : '',
            enabledTools: Array.isArray(v?.enabledTools) ? v.enabledTools : [],
            keepAlive: typeof v?.keepAlive === 'string' ? v.keepAlive : '',
        })),
        setups: setups.map((v: any) => ({
            id: v?.id || '',
            name: v?.name || v?.id || '',
            llmConfigA: v?.llmConfigA || '',
            llmConfigB: typeof v?.llmConfigB === 'string' ? v.llmConfigB : '',
            maxTurns: typeof v?.maxTurns === 'number' ? v.maxTurns : 0,
            pauseBetweenTurns: v?.pauseBetweenTurns === true,
            historyMode: typeof v?.historyMode === 'string' ? v.historyMode : '',
            trailSummarizationLlmConfig: typeof v?.trailSummarizationLlmConfig === 'string' ? v.trailSummarizationLlmConfig : '',
        })),
        configErrors: strictErrors,
        compaction: {
            disabled: sendToChatConfig?.compaction?.disabled === true,
            llmProvider: (sendToChatConfig?.compaction?.llmProvider as 'localLlm' | 'anthropic') || 'localLlm',
            llmConfigId: sendToChatConfig?.compaction?.llmConfigId || '',
            compactionTemplateId: sendToChatConfig?.compaction?.compactionTemplateId || '',
            memoryExtractionTemplateId: sendToChatConfig?.compaction?.memoryExtractionTemplateId || '',
            compactionMaxRounds: sendToChatConfig?.compaction?.compactionMaxRounds ?? 4,
            maxHistoryTokens: sendToChatConfig?.compaction?.maxHistoryTokens ?? 8000,
            historyMaxChars: sendToChatConfig?.compaction?.historyMaxChars ?? 24000,
            memoryMaxChars: sendToChatConfig?.compaction?.memoryMaxChars ?? 8000,
            fullTrailMaxTurns: (sendToChatConfig?.compaction as { fullTrailMaxTurns?: number })?.fullTrailMaxTurns ?? 200,
            runMemoryExtractionOnCompaction: (sendToChatConfig?.compaction as { runMemoryExtractionOnCompaction?: boolean })?.runMemoryExtractionOnCompaction !== false,
            rebuildFromLastNPrompts: sendToChatConfig?.compaction?.rebuildFromLastNPrompts ?? 200,
            archiveHistoryEveryTurn: (sendToChatConfig?.compaction as { archiveHistoryEveryTurn?: boolean })?.archiveHistoryEveryTurn === true,
            toolTrailMaxResultChars: sendToChatConfig?.compaction?.toolTrailMaxResultChars ?? 500,
            backgroundExtractionEnabled: sendToChatConfig?.compaction?.backgroundExtractionEnabled === true,
        },
        anthropicMemory: (() => {
            const anthropic = getAnthropicSection();
            return {
                memoryToolsEnabled: anthropic.memory?.memoryToolsEnabled === true,
                maxInjectedTokens: anthropic.memory?.maxInjectedTokens ?? 3000,
            };
        })(),
        compactionTemplateChoices: (sendToChatConfig?.compaction?.templates || []).map((t) => ({
            id: t.id, name: t.name || t.id,
        })),
        memoryExtractionTemplateChoices: (sendToChatConfig?.compaction?.memoryExtractionTemplates || []).map((t) => ({
            id: t.id, name: t.name || t.id,
        })),
        ...(() => {
            const anthropic = getAnthropicSection();
            const configurations = anthropic.configurations ?? [];
            return {
                anthropicConfigurationChoices: configurations.map((c) => ({
                    id: c.id, name: c.name || c.id,
                })),
                anthropicApiKeyEnvVar: anthropic.apiKeyEnvVar || 'ANTHROPIC_API_KEY',
                anthropicConfigurationsSummary: configurations.map((cc) => {
                    const transport = cc.transport === 'agentSdk'
                        ? 'agentSdk'
                        : cc.transport === 'vscodeLm'
                            ? 'vscodeLm'
                            : 'direct';
                    return {
                        id: cc.id,
                        name: cc.name || cc.id,
                        model: cc.model || '',
                        transport: transport as 'direct' | 'agentSdk' | 'vscodeLm',
                        permissionMode: cc.agentSdk?.permissionMode,
                        promptCachingEnabled: cc.promptCachingEnabled === true,
                        historyMode: cc.historyMode || '',
                        isDefault: cc.isDefault === true,
                        maxTokens: cc.maxTokens,
                        maxRounds: cc.maxRounds,
                        temperature: cc.temperature,
                        maxHistoryTokens: cc.maxHistoryTokens,
                        memoryToolsEnabled: cc.memoryToolsEnabled,
                        settingSources: cc.agentSdk?.settingSources,
                        maxTurns: cc.agentSdk?.maxTurns,
                        vscodeLmVendor: cc.vscodeLm?.vendor,
                        vscodeLmFamily: cc.vscodeLm?.family,
                        vscodeLmModelId: cc.vscodeLm?.modelId,
                    };
                }),
            };
        })(),
    };
}

/** Escape text for safe embedding in HTML element content (e.g. inside &lt;textarea&gt;). */
function escapeHtmlContent(s: string): string {
    return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

/**
 * Generate embedded status panel HTML for use in the @WS sidebar.
 * This is a full version mirroring all sections from the status page.
 */
export function getEmbeddedStatusHtml(status: StatusData): string {
    const cliStatusText = status.cliServer.running 
        ? `Running on port ${status.cliServer.port}` 
        : 'Stopped';
    const bridgeStatusText = status.bridge.connected ? 'Connected' : 'Disconnected';
    const profileOptions = status.bridge.profiles.map(p => 
        `<option value="${p}" ${p === status.bridge.currentProfile ? 'selected' : ''}>${p}</option>`
    ).join('');
    const llmProfileOptions = status.localLlm.profiles.map(p => 
        `<option value="${p}" ${p === status.localLlm.expansionProfile ? 'selected' : ''}>${p}</option>`
    ).join('');
    // Generate model options for profile editor dropdowns
    const modelOptionsHtml = (selectedModel: string | null) => 
        `<option value="">(Default)</option>` + 
        status.localLlm.models.map(m => 
            `<option value="${m}" ${m === selectedModel ? 'selected' : ''}>${m}</option>`
        ).join('');
    // Generate LLM profile rows with model selection
    const llmProfileRowsHtml = status.localLlm.profiles.map(p => {
        const detail = status.localLlm.profileDetails[p] || { modelConfig: null, toolsEnabled: true };
        return `<div class="sp-settings-row" data-llm-profile="${p}">
            <label>${p}:</label>
            <select class="sp-llm-profile-model" data-profile="${p}">${modelOptionsHtml(detail.modelConfig)}</select>
            <select class="sp-llm-profile-tools" data-profile="${p}">
                <option value="true" ${detail.toolsEnabled !== false ? 'selected' : ''}>Tools On</option>
                <option value="false" ${detail.toolsEnabled === false ? 'selected' : ''}>Tools Off</option>
            </select>
        </div>`;
    }).join('');
    // Generate AI Conversation profile rows with model selection
    const convProfileRowsHtml = status.aiConversation.profiles.map(p => {
        const detail = status.aiConversation.profileDetails[p] || { modelConfig: null };
        return `<div class="sp-settings-row" data-conv-profile="${p}">
            <label>${p}:</label>
            <select class="sp-conv-profile-model" data-profile="${p}">${modelOptionsHtml(detail.modelConfig)}</select>
        </div>`;
    }).join('');
    // Generate model configuration rows for the model configs subsection
    const modelConfigsRowsHtml = status.localLlm.models.map(m => {
        const detail = (status.localLlm as any).modelDetails?.[m] || {};
        const isDefault = detail.isDefault ? ' ⭐' : '';
        return `<div class="sp-settings-row sp-model-config-row" data-model-key="${m}">
            <span class="sp-model-name">${m}${isDefault}</span>
            <span class="sp-model-info">${detail.model || '?'} @ ${detail.ollamaUrl || '?'}</span>
            <button class="sp-btn small" data-status-action="editModelConfig" data-model-key="${m}">Edit</button>
            <button class="sp-btn small danger" data-status-action="deleteModelConfig" data-model-key="${m}">Delete</button>
        </div>`;
    }).join('');
    
    // Generate LLM Configuration options for dropdown
    const llmConfigOptions = (selectedId: string) => 
        `<option value="">(None)</option>` + 
        status.configurations.map(c => 
            `<option value="${c.id}" ${c.id === selectedId ? 'selected' : ''}>${c.name}</option>`
        ).join('');
    const llmConfigBOptions = (selectedId: string) =>
        `<option value="copilot" ${selectedId === 'copilot' || !selectedId ? 'selected' : ''}>Copilot</option>` +
        status.configurations.map(c =>
            `<option value="${c.id}" ${c.id === selectedId ? 'selected' : ''}>${c.name}</option>`
        ).join('');
    
    // Generate tool checkboxes HTML for a configuration
    const toolCheckboxesHtml = (enabledTools: string[], configId: string) => 
        AVAILABLE_LLM_TOOLS.map(tool => {
            const isChecked = enabledTools.includes(tool);
            return `<label class="sp-tool-checkbox" title="${tool}">
                <input type="checkbox" data-tool="${tool}" data-config="${configId}" ${isChecked ? 'checked' : ''}>
                ${tool.replace('tom_', '').replace('tomAi_', '')}
            </label>`;
        }).join('');
    
    // Generate LLM Configurations rows
    const llmConfigurationsHtml = status.configurations.map(cfg => {
        return `<div class="sp-llmconfig-card" data-config-id="${cfg.id}">
            <div class="sp-llmconfig-header">
                <input type="text" class="sp-config-name" value="${cfg.name}" data-field="name" placeholder="Name">
                <input type="text" class="sp-config-id" value="${cfg.id}" data-field="id" placeholder="ID" readonly>
                <button class="sp-btn small danger" data-status-action="deleteLlmConfiguration" data-config-id="${cfg.id}">🗑️</button>
            </div>
            <div class="sp-settings-row">
                <label>URL:</label>
                <input type="text" data-field="ollamaUrl" value="${cfg.ollamaUrl}" style="flex:2">
                <label>Model:</label>
                <input type="text" data-field="model" value="${cfg.model}" style="flex:1">
            </div>
            <div class="sp-settings-row">
                <label>Temp:</label>
                <input type="number" data-field="temperature" value="${cfg.temperature}" step="0.1" min="0" max="2">
                <label>Trail Tokens:</label>
                <input type="number" data-field="trailMaximumTokens" value="${cfg.trailMaximumTokens}" step="1000" min="1000">
            </div>
            <div class="sp-settings-row">
                <label>Sum Temp:</label>
                <input type="number" data-field="trailSummarizationTemperature" value="${cfg.trailSummarizationTemperature}" step="0.1" min="0" max="2">
                <label>Keep Alive:</label>
                <input type="text" data-field="keepAlive" value="${cfg.keepAlive || '5m'}" placeholder="5m">
                <label>History:</label>
                <select data-field="historyMode">
                    <option value="full" ${cfg.historyMode === 'full' ? 'selected' : ''}>Full</option>
                    <option value="last" ${cfg.historyMode === 'last' ? 'selected' : ''}>Last</option>
                    <option value="summary" ${cfg.historyMode === 'summary' ? 'selected' : ''}>Summary</option>
                    <option value="trim_and_summary" ${cfg.historyMode === 'trim_and_summary' || !cfg.historyMode ? 'selected' : ''}>Trim+Summary</option>
                </select>
            </div>
            <div class="sp-settings-row">
                <label>Answer Folder:</label>
                <input type="text" data-field="answerFolder" value="${cfg.answerFolder || ''}" style="flex:2">
                <label>Log Folder:</label>
                <input type="text" data-field="logFolder" value="${cfg.logFolder || ''}" style="flex:2">
            </div>
            <div class="sp-settings-row">
                <label>Summary Prompt:</label>
                <textarea data-field="trailSummarizationPrompt" rows="3" style="flex:1">${escapeHtmlContent(cfg.trailSummarizationPrompt || '')}</textarea>
            </div>
            <div class="sp-settings-row">
                <label>Strip Think:</label>
                <select data-field="stripThinkingTags">
                    <option value="true" ${cfg.stripThinkingTags ? 'selected' : ''}>Yes</option>
                    <option value="false" ${!cfg.stripThinkingTags ? 'selected' : ''}>No</option>
                </select>
                <label>Rm Template:</label>
                <select data-field="removePromptTemplateFromTrail">
                    <option value="true" ${cfg.removePromptTemplateFromTrail ? 'selected' : ''}>Yes</option>
                    <option value="false" ${!cfg.removePromptTemplateFromTrail ? 'selected' : ''}>No</option>
                </select>
            </div>
            <div class="sp-tools-section">
                <label style="font-weight:bold;margin-bottom:4px;display:block">Enabled Tools:</label>
                <div class="sp-tools-grid">${toolCheckboxesHtml(cfg.enabledTools, cfg.id)}</div>
            </div>
        </div>`;
    }).join('');
    
    // Generate AI Conversation Setups rows
    const aiConversationSetupsHtml = status.setups.map(setup => {
        return `<div class="sp-aisetup-card" data-setup-id="${setup.id}">
            <div class="sp-aisetup-header">
                <input type="text" class="sp-setup-name" value="${setup.name}" data-field="name" placeholder="Name">
                <input type="text" class="sp-setup-id" value="${setup.id}" data-field="id" placeholder="ID" readonly>
                <button class="sp-btn small danger" data-status-action="deleteAiConversationSetup" data-setup-id="${setup.id}">🗑️</button>
            </div>
            <div class="sp-settings-row">
                <label>LLM Config A:</label>
                <select data-field="llmConfigA">${llmConfigOptions(setup.llmConfigA)}</select>
                <label>LLM Config B:</label>
                <select data-field="llmConfigB">${llmConfigBOptions(setup.llmConfigB || 'copilot')}</select>
            </div>
            <div class="sp-settings-row">
                <label>Max Turns:</label>
                <input type="number" data-field="maxTurns" value="${setup.maxTurns}" min="1" max="50">
                <label>Pause Between:</label>
                <select data-field="pauseBetweenTurns">
                    <option value="true" ${setup.pauseBetweenTurns ? 'selected' : ''}>Yes</option>
                    <option value="false" ${!setup.pauseBetweenTurns ? 'selected' : ''}>No</option>
                </select>
                <label>History:</label>
                <select data-field="historyMode">
                    <option value="full" ${setup.historyMode === 'full' ? 'selected' : ''}>Full</option>
                    <option value="last" ${setup.historyMode === 'last' ? 'selected' : ''}>Last</option>
                    <option value="summary" ${setup.historyMode === 'summary' ? 'selected' : ''}>Summary</option>
                    <option value="trim_and_summary" ${setup.historyMode === 'trim_and_summary' ? 'selected' : ''}>Trim+Summary</option>
                </select>
                <label>Sum LLM:</label>
                <select data-field="trailSummarizationLlmConfig">${llmConfigOptions(setup.trailSummarizationLlmConfig || '')}</select>
            </div>
        </div>`;
    }).join('');
    const strictErrorsHtml = status.configErrors.length > 0
        ? `<div class="sp-section" style="border-color: var(--vscode-inputValidation-errorBorder); background: var(--vscode-inputValidation-errorBackground);">
            <div class="sp-section-header"><span class="sp-section-title">⚠️ Configuration Errors</span></div>
            <div style="font-size:12px;line-height:1.4;white-space:pre-wrap;">${status.configErrors.map(e => `• ${escapeHtmlContent(e)}`).join('<br>')}</div>
        </div>`
        : '';

    return `
<div class="sp-panel">
    ${strictErrorsHtml}
    <!-- Queue & Timer Switches -->
    <div class="sp-section">
        <div class="sp-section-header">
            <span class="sp-section-title">🔄 Queue &amp; Timer</span>
        </div>
        <div class="sp-settings-row">
            <label>Queue Auto-Send:</label>
            <div class="sp-controls sp-toggle">
                <button class="sp-btn ${status.queue.autoSendEnabled ? 'primary' : ''}" data-status-action="setQueueOn">On</button>
                <button class="sp-btn ${!status.queue.autoSendEnabled ? 'primary' : ''}" data-status-action="setQueueOff">Off</button>
            </div>
            <label>Auto-Start:</label>
            <div class="sp-controls sp-toggle">
                <button class="sp-btn ${status.queue.autoStartEnabled ? 'primary' : ''}" data-status-action="setQueueAutoStartOn">On</button>
                <button class="sp-btn ${!status.queue.autoStartEnabled ? 'primary' : ''}" data-status-action="setQueueAutoStartOff">Off</button>
            </div>
            <label>Auto-Pause:</label>
            <div class="sp-controls sp-toggle">
                <button class="sp-btn ${status.queue.autoPauseEnabled ? 'primary' : ''}" data-status-action="setQueueAutoPauseOn">On</button>
                <button class="sp-btn ${!status.queue.autoPauseEnabled ? 'primary' : ''}" data-status-action="setQueueAutoPauseOff">Off</button>
            </div>
            <label>Auto-Continue:</label>
            <div class="sp-controls sp-toggle">
                <button class="sp-btn ${status.queue.autoContinueEnabled ? 'primary' : ''}" data-status-action="setQueueAutoContinueOn">On</button>
                <button class="sp-btn ${!status.queue.autoContinueEnabled ? 'primary' : ''}" data-status-action="setQueueAutoContinueOff">Off</button>
            </div>
        </div>
        <div class="sp-settings-row">
            <label>Timer:</label>
            <div class="sp-controls sp-toggle">
                <button class="sp-btn ${status.timer.timerActivated ? 'primary' : ''}" data-status-action="setTimerOn">On</button>
                <button class="sp-btn ${!status.timer.timerActivated ? 'primary' : ''}" data-status-action="setTimerOff">Off</button>
            </div>
        </div>
        <div class="sp-settings-row" style="align-items:flex-start">
            <label style="padding-top:2px">After Reload:</label>
            <label style="display:inline-flex;align-items:center;gap:4px;color:var(--vscode-foreground)">
                <input type="checkbox" id="sp-reloadPromptEnabled" ${status.queue.reloadPromptAfterReloadEnabled ? 'checked' : ''}>
                Send prompt after reload
            </label>
            <span style="font-size:11px;color:var(--vscode-descriptionForeground)">Scope: ${escapeHtmlContent(status.queue.scopeLabel)}</span>
        </div>
        <div class="sp-settings-row" style="align-items:flex-start">
            <label style="padding-top:4px">Prompt:</label>
            <textarea id="sp-reloadPromptText" rows="3" style="flex:1;min-width:220px;max-width:none" placeholder="Prompt to send 15s after extension activation">${escapeHtmlContent(status.queue.reloadPromptAfterReloadText || '')}</textarea>
            <button class="sp-btn" data-status-action="saveReloadPromptAfterReload">Save</button>
        </div>
    </div>

    <!-- Timer Schedule Section -->
    <div class="sp-section">
        <div class="sp-section-header sp-collapsible" data-collapse="timerSchedule">
            <span class="sp-section-title"><span class="sp-collapse-icon">▶</span> ⏰ Timer Schedule</span>
            <span class="sp-badge">${(status.schedule || []).length} slot${(status.schedule || []).length !== 1 ? 's' : ''}</span>
        </div>
        <div class="sp-collapse-content sp-collapsed" id="sp-timerSchedule-content">
            <p style="font-size:11px;color:var(--vscode-descriptionForeground);margin:0 0 4px">Define when timed requests are allowed to fire. Empty = always allowed.</p>
            <textarea id="sp-schedule-init" style="display:none">${escapeHtmlContent(JSON.stringify(status.schedule || []))}</textarea>
            <div class="sp-settings-row" style="margin-bottom:4px">
                <button class="sp-btn" onclick="addScheduleSlot()">+ Add Time Slot</button>
            </div>
            <div id="sp-schedule-slots"></div>
        </div>
    </div>

    <!-- AI Trail Section -->
    <div class="sp-section">
        <div class="sp-section-header">
            <span class="sp-section-title">📝 AI Trail</span>
            <span class="sp-badge ${status.trail.enabled ? 'sp-running' : 'sp-stopped'}">${status.trail.enabled ? 'On' : 'Off'}</span>
        </div>
        <div class="sp-controls sp-toggle">
            <button class="sp-btn ${status.trail.enabled ? 'primary' : ''}" data-status-action="setTrailOn">On</button>
            <button class="sp-btn ${!status.trail.enabled ? 'primary' : ''}" data-status-action="setTrailOff">Off</button>
        </div>
        <div class="sp-settings-row">
            <label>Cleanup (days):</label>
            <input type="number" id="sp-trailCleanupDays" value="${status.trail.cleanupDays}" min="1" max="365">
            <label>Max (entries per trail file):</label>
            <input type="number" id="sp-trailMaxEntries" value="${status.trail.maxEntries}" min="10" max="100000">
            <button class="sp-btn" data-status-action="updateTrailSettings">Save</button>
        </div>
    </div>

    <!-- CLI Server Section -->
    <div class="sp-section">
        <div class="sp-section-header">
            <span class="sp-section-title">📡 CLI Server</span>
            <span class="sp-badge ${status.cliServer.running ? 'sp-running' : 'sp-stopped'}">${cliStatusText}</span>
        </div>
        <div class="sp-controls">
            <button class="sp-btn ${status.cliServer.running ? '' : 'primary'}" data-status-action="startCliServer">Start</button>
            <button class="sp-btn ${status.cliServer.running ? 'primary' : ''}" data-status-action="stopCliServer">Stop</button>
            <label style="margin-left:8px;font-size:12px;display:inline-flex;align-items:center;gap:3px">
                <input type="checkbox" id="sp-cliAutostart" ${status.cliServer.autostart ? 'checked' : ''} onchange="sendStatusAction('setCliAutostart',{enabled:this.checked})" />
                Autostart
            </label>
        </div>
    </div>

    <!-- Bridge Section -->
    <div class="sp-section">
        <div class="sp-section-header">
            <span class="sp-section-title">🔗 Bridge</span>
            <span class="sp-badge ${status.bridge.connected ? 'sp-running' : 'sp-stopped'}">${bridgeStatusText}</span>
        </div>
        <div class="sp-controls">
            <button class="sp-btn primary" data-status-action="restartBridge">Restart</button>
            <select id="sp-bridgeProfile" data-status-select="switchProfile">${profileOptions}</select>
        </div>
        <div class="sp-mode-buttons">
            <span>Mode:</span>
            <button class="sp-btn ${status.bridge.currentProfile === 'development' ? 'primary' : ''}" data-status-action="switchToDevelopment">Dev</button>
            <button class="sp-btn ${status.bridge.currentProfile === 'production' ? 'primary' : ''}" data-status-action="switchToProduction">Prod</button>
        </div>
    </div>

    <!-- Telegram Settings Section -->
    <div class="sp-section">
        <div class="sp-section-header sp-collapsible" data-collapse="telegram">
            <span class="sp-section-title"><span class="sp-collapse-icon">▶</span> 📱 Telegram</span>
            <span class="sp-badge ${status.telegram.polling ? 'sp-running' : 'sp-stopped'}">${status.telegram.polling ? 'Active' : 'Off'}</span>
        </div>
        <div class="sp-collapse-content sp-collapsed" id="sp-telegram-content">
            <div class="sp-controls">
                <button class="sp-btn ${status.telegram.polling ? '' : 'primary'}" data-status-action="startTelegram">Start</button>
                <button class="sp-btn ${status.telegram.polling ? 'primary' : ''}" data-status-action="stopTelegram">Stop</button>
                <button class="sp-btn" data-status-action="testTelegram">Test</button>
                <label style="margin-left:8px;font-size:12px;display:inline-flex;align-items:center;gap:3px">
                    <input type="checkbox" id="sp-tgAutostart" ${status.telegram.autostart ? 'checked' : ''} onchange="sendStatusAction('setTelegramAutostart',{enabled:this.checked})" />
                    Autostart
                </label>
            </div>
            <div class="sp-settings-row">
                <label>Enabled:</label>
                <select id="sp-tg-enabled">
                    <option value="true" ${status.telegram.enabled ? 'selected' : ''}>Yes</option>
                    <option value="false" ${!status.telegram.enabled ? 'selected' : ''}>No</option>
                </select>
                <label>Chat ID:</label>
                <input type="number" id="sp-tg-defaultChatId" value="${status.telegram.defaultChatId}">
            </div>
            <div class="sp-settings-row">
                <label>Bot Token Env:</label>
                <input type="text" id="sp-tg-botTokenEnv" value="${status.telegram.botTokenEnv}">
            </div>
            <div class="sp-settings-row">
                <label>Poll (ms):</label>
                <input type="number" id="sp-tg-pollIntervalMs" value="${status.telegram.pollIntervalMs}" step="1000" min="1000">
            </div>
            <div class="sp-settings-row">
                <label>Notify Start:</label>
                <select id="sp-tg-notifyOnStart">
                    <option value="true" ${status.telegram.notifyOnStart ? 'selected' : ''}>Yes</option>
                    <option value="false" ${!status.telegram.notifyOnStart ? 'selected' : ''}>No</option>
                </select>
                <label>Turn:</label>
                <select id="sp-tg-notifyOnTurn">
                    <option value="true" ${status.telegram.notifyOnTurn ? 'selected' : ''}>Yes</option>
                    <option value="false" ${!status.telegram.notifyOnTurn ? 'selected' : ''}>No</option>
                </select>
                <label>End:</label>
                <select id="sp-tg-notifyOnEnd">
                    <option value="true" ${status.telegram.notifyOnEnd ? 'selected' : ''}>Yes</option>
                    <option value="false" ${!status.telegram.notifyOnEnd ? 'selected' : ''}>No</option>
                </select>
            </div>
            <div class="sp-settings-row">
                <button class="sp-btn primary" data-status-action="updateTelegram">Save Telegram Settings</button>
            </div>
        </div>
    </div>

    <!-- Editors Section -->
    <div class="sp-section">
        <div class="sp-section-header sp-collapsible" data-collapse="editors">
            <span class="sp-section-title"><span class="sp-collapse-icon">▼</span> 🔗 Editors</span>
        </div>
        <div class="sp-collapse-content" id="sp-editors-content">
            <div class="sp-links">
                <button class="sp-link-btn" data-status-action="openGlobalTemplateEditor">📋 Templates</button>
                <button class="sp-link-btn" data-status-action="openReusablePromptEditor">📝 Reusable</button>
                <button class="sp-link-btn" data-status-action="openContextSettingsEditor">⚙️ Context</button>
                <button class="sp-link-btn" data-status-action="openChatVariablesEditor">🔑 Variables</button>
                <button class="sp-link-btn" data-status-action="openTimedRequestsEditor">⏰ Timed</button>
                <button class="sp-link-btn" data-status-action="openQueueEditor">📤 Queue</button>
                <button class="sp-link-btn" data-status-action="openTrailViewer">📊 Trail Viewer</button>
                <button class="sp-link-btn" data-status-action="openTrailFile">📜 Trail File</button>
            </div>
        </div>
    </div>

    <!-- Executables Section -->
    <div class="sp-section">
        <div class="sp-section-header sp-collapsible" data-collapse="executables">
            <span class="sp-section-title"><span class="sp-collapse-icon">▶</span> 🔧 Executables</span>
        </div>
        <div class="sp-collapse-content sp-collapsed" id="sp-executables-content">
            <!-- Binary Path sub-section -->
            <div style="margin-bottom:10px;padding:8px;border:1px solid var(--vscode-panel-border);border-radius:4px;background:var(--vscode-editor-background)">
                <div style="font-weight:600;font-size:11px;margin-bottom:6px">📂 Binary Path <span style="color:var(--vscode-descriptionForeground);font-weight:normal">(\${binaryPath} — fallback: ~/.tom/bin/&lt;platform&gt;/)</span></div>
                <textarea id="sp-binarypath-init" style="display:none">${escapeHtmlContent(JSON.stringify(status.binaryPath || {}))}</textarea>
                <div id="sp-binarypath-list"></div>
                <div class="sp-settings-row">
                    <select id="sp-binarypath-plat-sel">
                        <option value="darwin-arm64">darwin-arm64</option>
                        <option value="darwin-x64">darwin-x64</option>
                        <option value="linux-x64">linux-x64</option>
                        <option value="linux-arm64">linux-arm64</option>
                        <option value="windows-x64">windows-x64</option>
                        <option value="darwin-*">darwin-*</option>
                        <option value="linux-*">linux-*</option>
                        <option value="windows-*">windows-*</option>
                        <option value="*">* (universal)</option>
                        <option value="__custom__">Custom...</option>
                    </select>
                    <button class="sp-btn" onclick="addBinaryPathPlatform()">+ Platform</button>
                </div>
            </div>
            <!-- Named Executables -->
            <textarea id="sp-executables-init" style="display:none">${escapeHtmlContent(JSON.stringify(status.executables || {}))}</textarea>
            <div id="sp-executables-list"></div>
            <div class="sp-settings-row">
                <input type="text" id="sp-new-exec-name" placeholder="New executable name" style="flex:1;min-width:100px">
                <button class="sp-btn" onclick="createNewExecutable()">+ Add</button>
            </div>
            <div class="sp-settings-row">
                <button class="sp-btn primary" data-status-action="saveExecutables">Save Executables</button>
            </div>
        </div>
    </div>

    <!-- Commandlines Editor Section -->
    <div class="sp-section">
        <div class="sp-section-header sp-collapsible" data-collapse="commandlines">
            <span class="sp-section-title"><span class="sp-collapse-icon">▶</span> ⌨️ Commandlines</span>
            <span class="sp-badge">${(status.commandlines || []).length}</span>
        </div>
        <div class="sp-collapse-content sp-collapsed" id="sp-commandlines-content">
            <p style="font-size:11px;color:var(--vscode-descriptionForeground);margin:0 0 4px">Manage command definitions for Ctrl+Shift+E → Execute. Drag to reorder.</p>
            <textarea id="sp-commandlines-init" style="display:none">${escapeHtmlContent(JSON.stringify(status.commandlines || []))}</textarea>
            <div id="sp-commandlines-list"></div>
            <div class="sp-settings-row">
                <button class="sp-btn" onclick="addCommandlineEntry()">+ Add Commandline</button>
                <button class="sp-btn primary" data-status-action="saveCommandlines">Save Commandlines</button>
            </div>
        </div>
    </div>

    <!-- Favorites Editor Section -->
    <div class="sp-section">
        <div class="sp-section-header sp-collapsible" data-collapse="favorites">
            <span class="sp-section-title"><span class="sp-collapse-icon">▶</span> ⭐ Favorites</span>
            <span class="sp-badge">${(status.favorites || []).length}</span>
        </div>
        <div class="sp-collapse-content sp-collapsed" id="sp-favorites-content">
            <p style="font-size:11px;color:var(--vscode-descriptionForeground);margin:0 0 4px">Manage favorites for Ctrl+Shift+X menu. Drag to reorder; key is the shortcut letter.</p>
            <textarea id="sp-favorites-init" style="display:none">${escapeHtmlContent(JSON.stringify(status.favorites || []))}</textarea>
            <div id="sp-favorites-list"></div>
            <div class="sp-settings-row">
                <button class="sp-btn" onclick="addFavoriteEntry()">+ Add Favorite</button>
                <button class="sp-btn primary" data-status-action="saveFavorites">Save Favorites</button>
            </div>
        </div>
    </div>

    <!-- LLM Configurations Section -->
    <div class="sp-section">
        <div class="sp-section-header sp-collapsible" data-collapse="configurations">
            <span class="sp-section-title"><span class="sp-collapse-icon">▶</span> ⚙️ LLM Configurations</span>
            <span class="sp-badge">${status.configurations.length}</span>
        </div>
        <div class="sp-collapse-content sp-collapsed" id="sp-configurations-content">
            <p style="font-size:11px;color:var(--vscode-descriptionForeground);margin:0 0 8px">
                Complete LLM configurations with all settings and per-config tool selection. 
                Used by Local LLM @CHAT panel dropdown.
            </p>
            <textarea id="sp-llmconfigs-init" style="display:none">${escapeHtmlContent(JSON.stringify(status.configurations || []))}</textarea>
            <div id="sp-llmconfigs-list">
                ${llmConfigurationsHtml || '<div class="sp-info">No LLM configurations defined</div>'}
            </div>
            <div class="sp-settings-row">
                <button class="sp-btn" onclick="addLlmConfiguration()">+ Add LLM Configuration</button>
                <button class="sp-btn primary" onclick="saveLlmConfigurations()">Save All LLM Configs</button>
            </div>
        </div>
    </div>

    <!-- AI Conversation Setups Section -->
    <div class="sp-section">
        <div class="sp-section-header sp-collapsible" data-collapse="setups">
            <span class="sp-section-title"><span class="sp-collapse-icon">▶</span> 🎭 AI Conversation Setups</span>
            <span class="sp-badge">${status.setups.length}</span>
        </div>
        <div class="sp-collapse-content sp-collapsed" id="sp-setups-content">
            <p style="font-size:11px;color:var(--vscode-descriptionForeground);margin:0 0 8px">
                Named conversation setups that reference LLM Configurations.
                Used by AI Conversation @CHAT panel dropdown.
            </p>
            <textarea id="sp-aisetups-init" style="display:none">${escapeHtmlContent(JSON.stringify(status.setups || []))}</textarea>
            <div id="sp-aisetups-list">
                ${aiConversationSetupsHtml || '<div class="sp-info">No AI Conversation setups defined</div>'}
            </div>
            <div class="sp-settings-row">
                <button class="sp-btn" onclick="addAiConversationSetup()">+ Add Setup</button>
                <button class="sp-btn primary" onclick="saveAiConversationSetups()">Save All Setups</button>
            </div>
        </div>
    </div>

    <!-- History Compaction Section -->
    <div class="sp-section">
        <div class="sp-section-header sp-collapsible" data-collapse="historyCompaction">
            <span class="sp-section-title"><span class="sp-collapse-icon">▶</span> 🗜️ History Compaction</span>
        </div>
        <div class="sp-collapse-content sp-collapsed" id="sp-historyCompaction-content">
            <p style="font-size:11px;color:var(--vscode-descriptionForeground);margin:0 0 8px">
                Settings for the LLM that compacts conversation history when it overflows the context window.
                Used by both Local LLM and Anthropic chat panels.
            </p>
            <div class="sp-settings-row">
                <label title="Global kill switch. When checked, the background compaction + memory-extraction pass that normally runs after every Anthropic turn is skipped entirely (both direct and Agent SDK transports). rawTurns and history.json are still written; only the extra API call and memory-file updates are suppressed. Useful for SDK-managed profiles where the SDK owns conversation state on its own.">
                    <input type="checkbox" id="sp-comp-disabled" ${status.compaction.disabled ? 'checked' : ''}>
                    Disable compaction &amp; memory extraction
                </label>
            </div>
            <div class="sp-settings-row">
                <label>Provider:</label>
                <select id="sp-comp-llmProvider">
                    <option value="localLlm" ${status.compaction.llmProvider === 'localLlm' ? 'selected' : ''}>Local LLM</option>
                    <option value="anthropic" ${status.compaction.llmProvider === 'anthropic' ? 'selected' : ''}>Anthropic</option>
                </select>
                <label>Config:</label>
                <select id="sp-comp-llmConfigId">
                    <option value="" data-provider="">(default)</option>
                    ${status.configurations.map(c => `<option value="${c.id}" data-provider="localLlm" ${status.compaction.llmProvider === 'localLlm' && c.id === status.compaction.llmConfigId ? 'selected' : ''}>${escapeHtmlContent(c.name)}</option>`).join('')}
                    ${status.anthropicConfigurationChoices.map(c => `<option value="${c.id}" data-provider="anthropic" ${status.compaction.llmProvider === 'anthropic' && c.id === status.compaction.llmConfigId ? 'selected' : ''}>${escapeHtmlContent(c.name)}</option>`).join('')}
                </select>
            </div>
            <div class="sp-settings-row">
                <label>Compaction template:</label>
                <select id="sp-comp-compactionTemplateId">
                    <option value="">(default)</option>
                    ${status.compactionTemplateChoices.map(t => `<option value="${t.id}" ${t.id === status.compaction.compactionTemplateId ? 'selected' : ''}>${escapeHtmlContent(t.name)}</option>`).join('')}
                </select>
                <button class="sp-btn small" data-status-action="editCompactionTemplate">✏️ Edit</button>
                <button class="sp-btn small" data-status-action="addCompactionTemplate">➕</button>
                <button class="sp-btn small danger" data-status-action="deleteCompactionTemplate">🗑️</button>
            </div>
            <div class="sp-settings-row">
                <label>Memory extraction template:</label>
                <select id="sp-comp-memoryExtractionTemplateId">
                    <option value="">(default)</option>
                    ${status.memoryExtractionTemplateChoices.map(t => `<option value="${t.id}" ${t.id === status.compaction.memoryExtractionTemplateId ? 'selected' : ''}>${escapeHtmlContent(t.name)}</option>`).join('')}
                </select>
                <button class="sp-btn small" data-status-action="editMemoryExtractionTemplate">✏️ Edit</button>
                <button class="sp-btn small" data-status-action="addMemoryExtractionTemplate">➕</button>
                <button class="sp-btn small danger" data-status-action="deleteMemoryExtractionTemplate">🗑️</button>
            </div>
            <!-- Compaction + memory extraction tools are now configured
                 per-template (see the "Tools" row inside each template's
                 editor). The section-level picker has been removed. -->
            <div class="sp-settings-row">
                <label title="Number of raw user+assistant rounds sent verbatim with every request, alongside the compacted summary. Higher = more fidelity on recent turns, more tokens used.">Raw rounds kept:</label>
                <input type="number" id="sp-comp-maxRounds" value="${status.compaction.compactionMaxRounds}" min="1" max="20" style="width:60px">
                <label title="Target size of the compacted-history summary in tokens. Summaries aim for roughly this size; the compaction template should reference \${maxHistoryTokens} / \${maxHistorySize}.">Compacted history max tokens:</label>
                <input type="number" id="sp-comp-maxHistoryTokens" value="${status.compaction.maxHistoryTokens}" min="1000" style="width:90px">
            </div>
            <div class="sp-settings-row">
                <label title="Hard char cap on history content (compacted summary + related context) injected into the compaction and memory-extraction prompts. Also exposed to the compaction template as \${historyMaxChars} so the LLM steers output toward this size. 24000 is a safe default for MoE local models; bump up for high-context cloud configs.">History max chars:</label>
                <input type="number" id="sp-comp-historyMaxChars" value="${status.compaction.historyMaxChars}" min="1000" style="width:90px">
                <label title="Hard char cap on existing memory content injected into the memory-extraction prompt. Older entries beyond this size are dropped from the file tail (entries are prepended newest-first, so truncation removes the oldest).">Memory max chars:</label>
                <input type="number" id="sp-comp-memoryMaxChars" value="${status.compaction.memoryMaxChars}" min="1000" style="width:90px">
            </div>
            <div class="sp-settings-row">
                <label title="Hard cap on the number of turns returned in 'full' history mode, so a runaway session cannot blow the context window when the user has chosen not to compact.">Full trail mode max turns:</label>
                <input type="number" id="sp-comp-fullTrailMaxTurns" value="${status.compaction.fullTrailMaxTurns}" min="2" max="1000" style="width:70px">
                <label title="Run memory extraction on every completed turn. Input is the last turn + the current compacted summary + existing memory. Uncheck to skip extraction entirely.">Run memory extraction:</label>
                <select id="sp-comp-runMemoryExtractionOnCompaction">
                    <option value="true" ${status.compaction.runMemoryExtractionOnCompaction ? 'selected' : ''}>Enabled</option>
                    <option value="false" ${!status.compaction.runMemoryExtractionOnCompaction ? 'selected' : ''}>Disabled</option>
                </select>
            </div>
            <div class="sp-settings-row">
                <label title="Exceptional/error case: when the handler finds no history snapshot on session start, it rebuilds history from the last N prompt/answer pairs in the quest's compact trail files (.prompts.md / .answers.md). While the rebuild runs, sending a new prompt shows 'Rebuild history from last N prompts…'">Rebuild from last N prompts:</label>
                <input type="number" id="sp-comp-rebuildFromLastNPrompts" value="${status.compaction.rebuildFromLastNPrompts}" min="1" max="1000" style="width:70px">
                <label title="Debug only. When on, every compaction pass ALSO writes a timestamped YYYYMMDD_HHMMSS.history.json alongside the rolling history.json — one extra file per turn. Off by default; turn on to compare turn-by-turn state, then back off for normal operation.">Archive every turn:</label>
                <select id="sp-comp-archiveHistoryEveryTurn">
                    <option value="true" ${status.compaction.archiveHistoryEveryTurn ? 'selected' : ''}>Enabled (debug)</option>
                    <option value="false" ${!status.compaction.archiveHistoryEveryTurn ? 'selected' : ''}>Disabled</option>
                </select>
            </div>
            <div class="sp-settings-row">
                <label title="Expose the tomAi_*Memory tools to the main Anthropic agent during its tool-use loop. When off, memory is injected into the system prompt at send time (capped by the next field) and the agent cannot mutate memory on demand.">Memory tools:</label>
                <select id="sp-mem-memoryToolsEnabled">
                    <option value="true" ${status.anthropicMemory.memoryToolsEnabled ? 'selected' : ''}>Enabled</option>
                    <option value="false" ${!status.anthropicMemory.memoryToolsEnabled ? 'selected' : ''}>Disabled</option>
                </select>
                <label title="Upper bound on memory content injected into the Anthropic system prompt at send time. Only applies when the memory tools are disabled (otherwise the agent reads memory on demand via tools, so no injection happens).">Memory max injected tokens:</label>
                <input type="number" id="sp-mem-maxInjectedTokens" value="${status.anthropicMemory.maxInjectedTokens}" min="0" max="32000" style="width:90px">
            </div>
            <div class="sp-settings-row">
                <label>Tool trail max chars:</label>
                <input type="number" id="sp-comp-toolTrailMaxResultChars" value="${status.compaction.toolTrailMaxResultChars}" min="100" style="width:90px">
                <label>Trail cleanup days:</label>
                <input type="number" id="sp-comp-trailCleanupDays" value="${status.trail.cleanupDays}" min="1" max="365" style="width:60px">
            </div>
            <div class="sp-settings-row">
                <label>Background extraction:</label>
                <select id="sp-comp-backgroundExtractionEnabled">
                    <option value="true" ${status.compaction.backgroundExtractionEnabled ? 'selected' : ''}>Enabled</option>
                    <option value="false" ${!status.compaction.backgroundExtractionEnabled ? 'selected' : ''}>Disabled</option>
                </select>
            </div>
            <div class="sp-settings-row">
                <button class="sp-btn primary" data-status-action="updateCompactionSettings">Save Compaction Settings</button>
                <button class="sp-btn" data-status-action="runCompactionDryRun" title="Run one compaction + memory-extraction pass against the current rolling history (or a small synthetic one when empty). Writes raw prompts/answers to the trail and a detailed line to the 'Tom AI Compaction and Memory Extraction' output channel. Does NOT mutate the live history or memory files.">🧪 Dry Run</button>
            </div>
        </div>
    </div>

    <!-- Anthropic — Configurations Editor (anthropic_sdk_integration.md §18.8) -->
    <div class="sp-section">
        <div class="sp-section-header sp-collapsible" data-collapse="anthropicConfigs">
            <span class="sp-section-title"><span class="sp-collapse-icon">▶</span> 🤖 Anthropic — Configurations</span>
        </div>
        <div class="sp-collapse-content sp-collapsed" id="sp-anthropicConfigs-content">
            <p style="font-size:11px;color:var(--vscode-descriptionForeground);margin:0 0 8px">
                Anthropic LLM configurations used by the <strong>ANTHROPIC</strong> bottom panel.
                Each configuration selects a transport: <strong>Direct API</strong> (uses <code>${escapeHtmlContent(status.anthropicApiKeyEnvVar)}</code>) or
                <strong>Agent SDK</strong> (inherits auth from the host Claude Code install — see <code>anthropic_sdk_integration.md</code> §18).
            </p>
            <div class="sp-settings-row" style="display:flex;align-items:center;gap:6px;margin-bottom:4px">
                <label style="flex:0 0 auto;white-space:nowrap"><strong>API key env var:</strong></label>
                <input type="text" id="sp-anthropic-apiKeyEnvVar" value="${escapeHtmlContent(status.anthropicApiKeyEnvVar)}" placeholder="ANTHROPIC_API_KEY" style="flex:1;min-width:200px">
                <button class="sp-btn small" data-status-action="updateAnthropicApiKeyEnvVar" style="flex:0 0 auto">Save</button>
                <button class="sp-btn small" data-status-action="testAnthropicApiKey" style="flex:0 0 auto" title="Send a tiny one-shot request to verify the API key">🧪 Test</button>
            </div>
            <p style="font-size:11px;color:var(--vscode-descriptionForeground);margin:0 0 10px 0">
                Name of the env var that holds the API key (Direct transport only; ignored by Agent SDK).
                Saving also re-fetches models and refreshes the 🔑 dot in the panel.
            </p>
            ${status.anthropicConfigurationsSummary.length === 0
                ? '<div class="sp-info">No Anthropic configurations defined</div>'
                : `<table style="width:100%;border-collapse:collapse;font-size:11px">
                    <thead>
                        <tr style="text-align:left;border-bottom:1px solid var(--vscode-panel-border)">
                            <th style="padding:4px 8px">Name</th>
                            <th style="padding:4px 8px">Model</th>
                            <th style="padding:4px 8px">Transport</th>
                            <th style="padding:4px 8px">Permission</th>
                            <th style="padding:4px 8px">Cache</th>
                            <th style="padding:4px 8px">History</th>
                            <th style="padding:4px 8px;text-align:right">Actions</th>
                        </tr>
                    </thead>
                    <tbody>
                        ${status.anthropicConfigurationsSummary.map(c => {
                            const transportBadge = c.transport === 'agentSdk'
                                ? '<span style="background:#4a9eff;color:white;padding:2px 6px;border-radius:3px;font-size:10px">Agent SDK</span>'
                                : c.transport === 'vscodeLm'
                                    ? '<span style="background:#6b8e23;color:white;padding:2px 6px;border-radius:3px;font-size:10px">VS Code LM</span>'
                                    : '<span style="background:#888;color:white;padding:2px 6px;border-radius:3px;font-size:10px">Direct</span>';
                            const cacheLabel = c.transport === 'agentSdk'
                                ? '<span title="Managed by Agent SDK" style="color:var(--vscode-descriptionForeground)">SDK-managed</span>'
                                : c.transport === 'vscodeLm'
                                    ? '<span title="Not applicable to VS Code LM API" style="color:var(--vscode-descriptionForeground)">—</span>'
                                    : (c.promptCachingEnabled ? 'On' : 'Off');
                            const historyLabel = c.transport === 'agentSdk' && !c.historyMode
                                ? '<span title="Managed by Agent SDK" style="color:var(--vscode-descriptionForeground)">SDK-managed</span>'
                                : escapeHtmlContent(c.historyMode || '—');
                            const defaultMark = c.isDefault ? ' <span title="Default" style="color:var(--vscode-editorWarning-foreground, #cca700)">★</span>' : '';
                            // Build the second-line detail summary. Every
                            // configuration field the wizard can set is
                            // listed here so the user sees the current
                            // values without having to click Edit (which
                            // resets the inputs).
                            const dim = (s: string): string => '<span style="color:var(--vscode-descriptionForeground)">' + s + '</span>';
                            const fmt = (v: number | undefined): string => v === undefined ? '—' : String(v);
                            const detailParts: string[] = [];
                            detailParts.push(`${dim('maxTokens')} ${fmt(c.maxTokens)}`);
                            detailParts.push(`${dim('maxRounds')} ${fmt(c.maxRounds)}`);
                            detailParts.push(`${dim('temp')} ${fmt(c.temperature)}`);
                            detailParts.push(`${dim('memoryTools')} ${c.memoryToolsEnabled === true ? 'on' : c.memoryToolsEnabled === false ? 'off' : '—'}`);
                            if (c.transport === 'direct') {
                                detailParts.push(`${dim('maxHistTokens')} ${fmt(c.maxHistoryTokens)}`);
                                detailParts.push(`${dim('caching')} ${c.promptCachingEnabled ? 'on' : 'off'}`);
                            } else {
                                detailParts.push(`${dim('maxTurns')} ${fmt(c.maxTurns)}`);
                                const sources = (c.settingSources && c.settingSources.length > 0)
                                    ? c.settingSources.join(',')
                                    : '(isolation)';
                                detailParts.push(`${dim('settingSources')} ${sources}`);
                            }
                            const detailLine = detailParts.join(' &nbsp;·&nbsp; ');
                            return `<tr style="border-bottom:1px solid var(--vscode-panel-border)">
                                <td style="padding:4px 8px"><strong>${escapeHtmlContent(c.name)}</strong>${defaultMark}<br><code style="font-size:10px;color:var(--vscode-descriptionForeground)">${escapeHtmlContent(c.id)}</code></td>
                                <td style="padding:4px 8px"><code style="font-size:10px">${escapeHtmlContent(c.model)}</code></td>
                                <td style="padding:4px 8px">${transportBadge}</td>
                                <td style="padding:4px 8px">${c.transport === 'agentSdk' ? escapeHtmlContent(c.permissionMode || 'default') : '—'}</td>
                                <td style="padding:4px 8px">${cacheLabel}</td>
                                <td style="padding:4px 8px">${historyLabel}</td>
                                <td style="padding:4px 8px;text-align:right;white-space:nowrap">
                                    <button class="sp-btn small" data-status-action="editAnthropicConfiguration" data-config-id="${escapeHtmlContent(c.id)}" title="Edit">✏️</button>
                                    <button class="sp-btn small danger" data-status-action="deleteAnthropicConfiguration" data-config-id="${escapeHtmlContent(c.id)}" title="Delete">🗑️</button>
                                </td>
                            </tr>
                            <tr style="border-bottom:1px solid var(--vscode-panel-border)">
                                <td colspan="7" style="padding:2px 8px 6px 8px;font-size:10px;color:var(--vscode-foreground)">${detailLine}</td>
                            </tr>`;
                        }).join('')}
                    </tbody>
                </table>`}
            <div class="sp-settings-row" style="margin-top:10px">
                <button class="sp-btn primary" data-status-action="addAnthropicConfiguration">➕ Add Configuration</button>
            </div>
        </div>
    </div>

    <!-- Anthropic — Memory section removed; the two settings moved to the
         History Compaction section above (memoryToolsEnabled + the
         memory injection cap live with the rest of the compaction +
         memory extraction configuration). -->

    <!-- Ask Copilot Settings Section -->
    <div class="sp-section">
        <div class="sp-section-header sp-collapsible" data-collapse="askCopilot">
            <span class="sp-section-title"><span class="sp-collapse-icon">▶</span> 🤖 Ask Copilot</span>
        </div>
        <div class="sp-collapse-content sp-collapsed" id="sp-askCopilot-content">
            <div class="sp-settings-row">
                <label>Enabled:</label>
                <select id="sp-ac-enabled">
                    <option value="true" ${status.askCopilot.enabled ? 'selected' : ''}>Yes</option>
                    <option value="false" ${!status.askCopilot.enabled ? 'selected' : ''}>No</option>
                </select>
                <label>Timeout:</label>
                <input type="number" id="sp-ac-answerFileTimeout" value="${status.askCopilot.answerFileTimeout}">
            </div>
            <div class="sp-settings-row">
                <label>Poll Interval:</label>
                <input type="number" id="sp-ac-pollInterval" value="${status.askCopilot.pollInterval}">
                <label>Folder:</label>
                <input type="text" id="sp-ac-answerFolder" value="${status.askCopilot.answerFolder}">
            </div>
            <div class="sp-settings-row">
                <label>Copilot Answer Folder:</label>
                <input type="text" id="sp-ac-copilotAnswerFolder" value="${status.copilotAnswerFolder}">
            </div>
            <div class="sp-settings-row">
                <label>Template:</label>
                <select id="sp-ac-promptTemplate">
                    <option value="">(None)</option>
                    ${status.templateNames.map(t => `<option value="${t}" ${t === status.askCopilot.promptTemplate ? 'selected' : ''}>${t}</option>`).join('')}
                </select>
            </div>
            <div class="sp-settings-row">
                <button class="sp-btn primary" data-status-action="updateAskCopilot">Save Ask Copilot Settings</button>
            </div>
        </div>
    </div>

    <!-- Ask Big Brother Settings Section -->
    <div class="sp-section">
        <div class="sp-section-header sp-collapsible" data-collapse="askBigBrother">
            <span class="sp-section-title"><span class="sp-collapse-icon">▶</span> 🧠 Ask Big Brother</span>
        </div>
        <div class="sp-collapse-content sp-collapsed" id="sp-askBigBrother-content">
            <div class="sp-settings-row">
                <label>Enabled:</label>
                <select id="sp-abb-enabled">
                    <option value="true" ${status.askBigBrother.enabled ? 'selected' : ''}>Yes</option>
                    <option value="false" ${!status.askBigBrother.enabled ? 'selected' : ''}>No</option>
                </select>
                <label>Model:</label>
                <input type="text" id="sp-abb-defaultModel" value="${status.askBigBrother.defaultModel}">
            </div>
            <div class="sp-settings-row">
                <label>Temp:</label>
                <input type="number" id="sp-abb-temperature" value="${status.askBigBrother.temperature}" step="0.1" min="0" max="2">
                <label>Iterations:</label>
                <input type="number" id="sp-abb-maxIterations" value="${status.askBigBrother.maxIterations}" min="1" max="20">
            </div>
            <div class="sp-settings-row">
                <label>Tools Default:</label>
                <select id="sp-abb-enableToolsByDefault">
                    <option value="true" ${status.askBigBrother.enableToolsByDefault ? 'selected' : ''}>Yes</option>
                    <option value="false" ${!status.askBigBrother.enableToolsByDefault ? 'selected' : ''}>No</option>
                </select>
                <label>Summarize:</label>
                <select id="sp-abb-summarizationEnabled">
                    <option value="true" ${status.askBigBrother.summarizationEnabled ? 'selected' : ''}>Yes</option>
                    <option value="false" ${!status.askBigBrother.summarizationEnabled ? 'selected' : ''}>No</option>
                </select>
            </div>
            <div class="sp-settings-row">
                <label>Summary Model:</label>
                <input type="text" id="sp-abb-summarizationModel" value="${status.askBigBrother.summarizationModel || ''}">
            </div>
            <div class="sp-settings-row">
                <label>Max Chars:</label>
                <input type="number" id="sp-abb-maxResponseChars" value="${status.askBigBrother.maxResponseChars}">
            </div>
            <div class="sp-settings-row">
                <label>Template:</label>
                <select id="sp-abb-promptTemplate">
                    <option value="">(None)</option>
                    ${status.templateNames.map(t => `<option value="${t}" ${t === status.askBigBrother.promptTemplate ? 'selected' : ''}>${t}</option>`).join('')}
                </select>
            </div>
            <div class="sp-settings-row">
                <button class="sp-btn primary" data-status-action="updateAskBigBrother">Save Big Brother Settings</button>
            </div>
        </div>
    </div>

    <!-- Open Full Status Page -->
    <div class="sp-section sp-fullpage">
        <button class="sp-btn primary sp-expand" data-status-action="openFullStatusPage">
            <span class="codicon codicon-link-external"></span> Open Full Status Page
        </button>
    </div>
</div>`;
}

/**
 * CSS styles for the embedded status panel (to be included in the notepad styles)
 */
export function getEmbeddedStatusStyles(): string {
    return `
/* Status Panel Container */
.sp-panel { display: flex; flex-direction: column; gap: 8px; padding: 8px; overflow-y: auto; max-height: 100%; }

/* Section styling */
.sp-section { 
    border: 1px solid var(--vscode-panel-border); 
    border-radius: 4px; 
    background: var(--vscode-editorWidget-background); 
    padding: 8px;
}
.sp-section-header { 
    display: flex; 
    justify-content: space-between; 
    align-items: center; 
    margin-bottom: 0;
}
.sp-section-header.sp-collapsible { cursor: pointer; user-select: none; }
.sp-section-header.sp-collapsible:hover { opacity: 0.8; }
.sp-section-title { font-weight: 600; font-size: 12px; display: flex; align-items: center; gap: 4px; }
.sp-collapse-icon { font-size: 10px; transition: transform 0.2s; display: inline-block; width: 12px; }

/* Badge styling */
.sp-badge { padding: 2px 8px; border-radius: 8px; font-size: 10px; font-weight: 500; }
.sp-running { background: var(--vscode-testing-iconPassed); color: white; }
.sp-stopped { background: var(--vscode-testing-iconFailed); color: white; }

/* Controls and buttons */
.sp-controls { display: flex; gap: 4px; flex-wrap: wrap; align-items: center; margin-bottom: 4px; }
.sp-btn {
    padding: 3px 8px; border: 1px solid var(--vscode-button-border, transparent);
    border-radius: 3px; cursor: pointer; font-size: 11px;
    background: var(--vscode-button-secondaryBackground); color: var(--vscode-button-secondaryForeground);
}
.sp-btn:hover { background: var(--vscode-button-secondaryHoverBackground); }
.sp-btn.primary { background: var(--vscode-button-background); color: var(--vscode-button-foreground); }
.sp-btn.primary:hover { background: var(--vscode-button-hoverBackground); }
.sp-btn.small { padding: 2px 6px; font-size: 10px; }
.sp-btn.danger { background: var(--vscode-inputValidation-errorBackground); border-color: var(--vscode-inputValidation-errorBorder); }
.sp-btn.danger:hover { filter: brightness(1.1); }

/* Model config row */
.sp-model-config-row { justify-content: flex-start; }
.sp-model-name { font-weight: bold; min-width: 80px; }
.sp-model-info { color: var(--vscode-descriptionForeground); flex: 1; overflow: hidden; text-overflow: ellipsis; }

/* LLM Configuration cards */
.sp-llmconfig-card, .sp-aisetup-card {
    border: 1px solid var(--vscode-panel-border);
    border-radius: 4px;
    padding: 8px;
    margin-bottom: 8px;
    background: var(--vscode-editor-background);
}
.sp-llmconfig-header, .sp-aisetup-header {
    display: flex;
    gap: 6px;
    align-items: center;
    margin-bottom: 8px;
    padding-bottom: 6px;
    border-bottom: 1px solid var(--vscode-panel-border);
}
.sp-config-name, .sp-setup-name { flex: 1; font-weight: bold; }
.sp-config-id, .sp-setup-id { width: 120px; font-size: 10px; color: var(--vscode-descriptionForeground); }
.sp-tools-section { margin-top: 8px; padding-top: 6px; border-top: 1px solid var(--vscode-panel-border); }
.sp-tools-grid { display: flex; flex-wrap: wrap; gap: 4px; margin-top: 4px; }
.sp-tool-checkbox {
    display: inline-flex;
    align-items: center;
    gap: 2px;
    font-size: 10px;
    padding: 2px 4px;
    border: 1px solid var(--vscode-input-border);
    border-radius: 2px;
    background: var(--vscode-input-background);
    cursor: pointer;
}
.sp-tool-checkbox:hover { background: var(--vscode-list-hoverBackground); }
.sp-tool-checkbox input { margin: 0; }

/* Toggle button group */
.sp-toggle .sp-btn { border-radius: 0; }
.sp-toggle .sp-btn:first-child { border-radius: 3px 0 0 3px; }
.sp-toggle .sp-btn:last-child { border-radius: 0 3px 3px 0; }

/* Mode buttons row */
.sp-mode-buttons { display: flex; gap: 4px; align-items: center; font-size: 11px; margin-top: 4px; }
.sp-mode-buttons span { color: var(--vscode-descriptionForeground); }

/* Settings row */
.sp-settings-row { 
    display: flex; 
    align-items: center; 
    gap: 6px; 
    flex-wrap: wrap; 
    margin-top: 4px; 
    font-size: 11px;
}
.sp-settings-row label { color: var(--vscode-descriptionForeground); min-width: auto; }
.sp-settings-row input, .sp-settings-row select { 
    padding: 2px 4px; 
    font-size: 11px; 
    border: 1px solid var(--vscode-input-border);
    background: var(--vscode-input-background);
    color: var(--vscode-input-foreground);
    border-radius: 2px;
}
.sp-settings-row input[type="number"] { width: 50px; }
.sp-settings-row input[type="text"] { flex: 1; min-width: 80px; max-width: 150px; }
.sp-settings-row select { min-width: 60px; max-width: 120px; }
.sp-settings-row textarea {
    padding: 2px 4px; font-size: 11px;
    border: 1px solid var(--vscode-input-border);
    background: var(--vscode-input-background);
    color: var(--vscode-input-foreground);
    border-radius: 2px; resize: vertical; width: 100%;
    font-family: var(--vscode-font-family);
}

/* Collapsible content */
.sp-collapse-content { overflow: hidden; transition: max-height 0.2s ease-out; }
.sp-collapse-content.sp-collapsed { max-height: 0 !important; overflow: hidden; padding: 0; margin: 0; }

/* Subsection (nested within collapsible content) */
.sp-subsection { 
    margin-top: 8px; 
    padding-top: 8px; 
    border-top: 1px solid var(--vscode-panel-border); 
}
.sp-subsection-title { 
    font-size: 11px; 
    font-weight: 600; 
    color: var(--vscode-descriptionForeground); 
    margin-bottom: 6px; 
}

/* Editor links */
.sp-links { display: flex; flex-wrap: wrap; gap: 4px; margin-top: 4px; }
.sp-link-btn { 
    padding: 4px 8px; 
    font-size: 11px; 
    border: 1px solid var(--vscode-button-border, transparent);
    border-radius: 3px; 
    cursor: pointer;
    background: var(--vscode-button-secondaryBackground); 
    color: var(--vscode-button-secondaryForeground);
    text-align: left;
}
.sp-link-btn:hover { background: var(--vscode-button-secondaryHoverBackground); }

/* Schedule editor */
.sp-schedule-slot {
    border: 1px solid var(--vscode-panel-border);
    border-radius: 3px; padding: 6px; margin-bottom: 4px;
    background: var(--vscode-editor-background);
}
.sp-schedule-slot .sp-slot-header { display: flex; justify-content: space-between; align-items: center; cursor: pointer; user-select: none; }
.sp-schedule-slot .sp-slot-body { overflow: hidden; }
.sp-schedule-slot .sp-slot-body.sp-slot-collapsed { max-height: 0 !important; overflow: hidden; padding: 0; margin: 0; }
.sp-sched-cb { display: inline-flex; align-items: center; gap: 2px; margin-right: 3px; font-size: 11px; cursor: pointer; }
.sp-sched-cb input[type="checkbox"] { margin: 0; }
.sp-sched-inline-row { display: flex; flex-wrap: wrap; gap: 4px; align-items: center; margin-top: 4px; font-size: 11px; }

/* Executables editor */
.sp-exec-entry {
    border: 1px solid var(--vscode-panel-border);
    border-radius: 3px; padding: 6px; margin-bottom: 4px;
    background: var(--vscode-editor-background);
}
.sp-exec-entry strong { font-size: 11px; }

/* Full page button */
.sp-fullpage { border: none; background: none; padding: 4px 0; margin-top: 4px; }
.sp-expand { width: 100%; justify-content: center; display: flex; align-items: center; gap: 4px; }

/* Selects in controls */
#sp-bridgeProfile { padding: 3px 6px; font-size: 11px; min-width: 80px; }
`;
}

/**
 * Shared JavaScript for wiring up status panel event listeners.
 * Used by both the embedded sidebar panel and the full status page.
 */
export function getStatusPanelListenersScript(): string {
    return `
function attachStatusPanelListeners(skipEditorInit) {
    var panel = document.getElementById('settings-status-panel') || document.querySelector('.sp-panel');
    if (!panel) return;
    
    panel.querySelectorAll('.sp-collapsible').forEach(function(el) {
        if (el.dataset.spCollapseBound === '1') return;
        el.dataset.spCollapseBound = '1';
        el.addEventListener('click', function() {
            var sectionId = el.getAttribute('data-collapse');
            var content = document.getElementById('sp-' + sectionId + '-content');
            var icon = el.querySelector('.sp-collapse-icon');
            if (content) {
                content.classList.toggle('sp-collapsed');
                if (icon) icon.textContent = content.classList.contains('sp-collapsed') ? '▶' : '▼';
            }
        });
    });
    
    panel.querySelectorAll('[data-status-action]').forEach(function(el) {
        if (el.dataset.spActionBound === '1') return;
        el.dataset.spActionBound = '1';
        el.addEventListener('click', function() {
            var action = el.getAttribute('data-status-action');
            var msgData = { type: 'statusAction', action: action };
            
            if (action === 'updateTrailSettings') {
                msgData.cleanupDays = parseInt((document.getElementById('sp-trailCleanupDays') || {}).value || '2');
                msgData.maxEntries = parseInt((document.getElementById('sp-trailMaxEntries') || {}).value || '1000');
            } else if (action === 'saveReloadPromptAfterReload') {
                msgData.enabled = !!((document.getElementById('sp-reloadPromptEnabled') || {}).checked);
                msgData.prompt = ((document.getElementById('sp-reloadPromptText') || {}).value || '').toString();
            } else if (action === 'updateLocalLlm') {
                msgData.settings = {
                    ollamaUrl: (document.getElementById('sp-llm-ollamaUrl') || {}).value || '',
                    model: (document.getElementById('sp-llm-model') || {}).value || '',
                    temperature: parseFloat((document.getElementById('sp-llm-temperature') || {}).value || '0.4'),
                    stripThinkingTags: (document.getElementById('sp-llm-stripThinkingTags') || {}).value === 'true',
                    expansionProfile: (document.getElementById('sp-llm-expansionProfile') || {}).value || '',
                    toolsEnabled: (document.getElementById('sp-llm-toolsEnabled') || {}).value === 'true',
                    trailMaximumTokens: parseInt((document.getElementById('sp-llm-trailMaximumTokens') || {}).value || '8000'),
                    trailSummarizationTemperature: parseFloat((document.getElementById('sp-llm-trailSummarizationTemperature') || {}).value || '0.3'),
                    removePromptTemplateFromTrail: (document.getElementById('sp-llm-removePromptTemplateFromTrail') || {}).value === 'true'
                };
            } else if (action === 'updateAiConversation') {
                msgData.settings = {
                    maxTurns: parseInt((document.getElementById('sp-conv-maxTurns') || {}).value || '10'),
                    temperature: parseFloat((document.getElementById('sp-conv-temperature') || {}).value || '0.5'),
                    historyMode: (document.getElementById('sp-conv-historyMode') || {}).value || 'trim_and_summary',
                    conversationMode: (document.getElementById('sp-conv-conversationMode') || {}).value || 'ollama-copilot',
                    trailMaximumTokens: parseInt((document.getElementById('sp-conv-trailMaximumTokens') || {}).value || '8000'),
                    trailSummarizationTemperature: parseFloat((document.getElementById('sp-conv-trailSummarizationTemperature') || {}).value || '0.3'),
                    removePromptTemplateFromTrail: (document.getElementById('sp-conv-removePromptTemplateFromTrail') || {}).value === 'true'
                };
            } else if (action === 'updateTelegram') {
                msgData.settings = {
                    enabled: (document.getElementById('sp-tg-enabled') || {}).value === 'true',
                    botTokenEnv: (document.getElementById('sp-tg-botTokenEnv') || {}).value || '',
                    defaultChatId: parseInt((document.getElementById('sp-tg-defaultChatId') || {}).value || '0'),
                    pollIntervalMs: parseInt((document.getElementById('sp-tg-pollIntervalMs') || {}).value || '3000'),
                    notifyOnStart: (document.getElementById('sp-tg-notifyOnStart') || {}).value === 'true',
                    notifyOnTurn: (document.getElementById('sp-tg-notifyOnTurn') || {}).value === 'true',
                    notifyOnEnd: (document.getElementById('sp-tg-notifyOnEnd') || {}).value === 'true'
                };
            } else if (action === 'updateAskCopilot') {
                msgData.settings = {
                    enabled: (document.getElementById('sp-ac-enabled') || {}).value === 'true',
                    answerFileTimeout: parseInt((document.getElementById('sp-ac-answerFileTimeout') || {}).value || '120000'),
                    pollInterval: parseInt((document.getElementById('sp-ac-pollInterval') || {}).value || '2000'),
                    answerFolder: (document.getElementById('sp-ac-answerFolder') || {}).value || '',
                    copilotAnswerFolder: (document.getElementById('sp-ac-copilotAnswerFolder') || {}).value || '',
                    promptTemplate: (document.getElementById('sp-ac-promptTemplate') || {}).value || ''
                };
            } else if (action === 'updateAskBigBrother') {
                msgData.settings = {
                    enabled: (document.getElementById('sp-abb-enabled') || {}).value === 'true',
                    defaultModel: (document.getElementById('sp-abb-defaultModel') || {}).value || 'GPT-5.2',
                    temperature: parseFloat((document.getElementById('sp-abb-temperature') || {}).value || '0.7'),
                    maxIterations: parseInt((document.getElementById('sp-abb-maxIterations') || {}).value || '5'),
                    enableToolsByDefault: (document.getElementById('sp-abb-enableToolsByDefault') || {}).value === 'true',
                    summarizationEnabled: (document.getElementById('sp-abb-summarizationEnabled') || {}).value === 'true',
                    summarizationModel: (document.getElementById('sp-abb-summarizationModel') || {}).value || 'gpt-4o',
                    maxResponseChars: parseInt((document.getElementById('sp-abb-maxResponseChars') || {}).value || '20000'),
                    promptTemplate: (document.getElementById('sp-abb-promptTemplate') || {}).value || ''
                };
            } else if (action === 'saveSchedule') {
                msgData.schedule = collectAllScheduleData();
            } else if (action === 'saveExecutables') {
                msgData.executables = collectExecutablesData();
                msgData.binaryPath = collectBinaryPathData();
            } else if (action === 'saveCommandlines') {
                msgData.commandlines = collectCommandlinesData();
            } else if (action === 'saveFavorites') {
                msgData.favorites = collectFavoritesData();
            } else if (action === 'saveLlmProfiles') {
                msgData.profiles = collectLlmProfilesData();
            } else if (action === 'saveConvProfiles') {
                msgData.profiles = collectConvProfilesData();
            } else if (action === 'editModelConfig' || action === 'deleteModelConfig') {
                msgData.modelKey = el.getAttribute('data-model-key');
            } else if (action === 'deleteLlmConfiguration') {
                msgData.configId = el.getAttribute('data-config-id');
            } else if (action === 'editAnthropicConfiguration' || action === 'deleteAnthropicConfiguration') {
                msgData.configId = el.getAttribute('data-config-id');
            } else if (action === 'updateAnthropicApiKeyEnvVar') {
                msgData.value = (document.getElementById('sp-anthropic-apiKeyEnvVar') || {}).value || 'ANTHROPIC_API_KEY';
            } else if (action === 'deleteAiConversationSetup') {
                msgData.setupId = el.getAttribute('data-setup-id');
            } else if (action === 'updateCompactionSettings' || action === 'runCompactionDryRun') {
                msgData.settings = {
                    disabled: (document.getElementById('sp-comp-disabled') || {}).checked === true,
                    llmProvider: (document.getElementById('sp-comp-llmProvider') || {}).value || 'localLlm',
                    llmConfigId: (document.getElementById('sp-comp-llmConfigId') || {}).value || '',
                    compactionTemplateId: (document.getElementById('sp-comp-compactionTemplateId') || {}).value || '',
                    memoryExtractionTemplateId: (document.getElementById('sp-comp-memoryExtractionTemplateId') || {}).value || '',
                    compactionMaxRounds: parseInt((document.getElementById('sp-comp-maxRounds') || {}).value || '4'),
                    maxHistoryTokens: parseInt((document.getElementById('sp-comp-maxHistoryTokens') || {}).value || '8000'),
                    historyMaxChars: parseInt((document.getElementById('sp-comp-historyMaxChars') || {}).value || '24000'),
                    memoryMaxChars: parseInt((document.getElementById('sp-comp-memoryMaxChars') || {}).value || '8000'),
                    fullTrailMaxTurns: parseInt((document.getElementById('sp-comp-fullTrailMaxTurns') || {}).value || '200'),
                    runMemoryExtractionOnCompaction: (document.getElementById('sp-comp-runMemoryExtractionOnCompaction') || {}).value !== 'false',
                    rebuildFromLastNPrompts: parseInt((document.getElementById('sp-comp-rebuildFromLastNPrompts') || {}).value || '200'),
                    archiveHistoryEveryTurn: (document.getElementById('sp-comp-archiveHistoryEveryTurn') || {}).value === 'true',
                    memoryToolsEnabled: (document.getElementById('sp-mem-memoryToolsEnabled') || {}).value === 'true',
                    memoryMaxInjectedTokens: parseInt((document.getElementById('sp-mem-maxInjectedTokens') || {}).value || '3000'),
                    toolTrailMaxResultChars: parseInt((document.getElementById('sp-comp-toolTrailMaxResultChars') || {}).value || '500'),
                    trailCleanupDays: parseInt((document.getElementById('sp-comp-trailCleanupDays') || {}).value || '2'),
                    backgroundExtractionEnabled: (document.getElementById('sp-comp-backgroundExtractionEnabled') || {}).value === 'true'
                };
            } else if (action === 'editCompactionTemplate') {
                msgData.itemId = (document.getElementById('sp-comp-compactionTemplateId') || {}).value || '';
            } else if (action === 'deleteCompactionTemplate') {
                msgData.itemId = (document.getElementById('sp-comp-compactionTemplateId') || {}).value || '';
            } else if (action === 'editMemoryExtractionTemplate') {
                msgData.itemId = (document.getElementById('sp-comp-memoryExtractionTemplateId') || document.getElementById('sp-mem-memoryExtractionTemplateId') || {}).value || '';
            } else if (action === 'deleteMemoryExtractionTemplate') {
                msgData.itemId = (document.getElementById('sp-comp-memoryExtractionTemplateId') || document.getElementById('sp-mem-memoryExtractionTemplateId') || {}).value || '';
            }
            
            vscode.postMessage(msgData);
        });
    });
    
    panel.querySelectorAll('[data-status-select]').forEach(function(el) {
        if (el.dataset.spSelectBound === '1') return;
        el.dataset.spSelectBound = '1';
        el.addEventListener('change', function() {
            var action = el.getAttribute('data-status-select');
            vscode.postMessage({ type: 'statusAction', action: action, value: el.value });
        });
    });

    var compProviderSel = document.getElementById('sp-comp-llmProvider');
    var compConfigSel = document.getElementById('sp-comp-llmConfigId');
    if (compProviderSel && compConfigSel && !compProviderSel.dataset.spProviderBound) {
        compProviderSel.dataset.spProviderBound = '1';
        var filterCompConfig = function() {
            var p = compProviderSel.value || 'localLlm';
            var firstVisibleValue = '';
            Array.prototype.forEach.call(compConfigSel.options, function(opt) {
                var dp = opt.getAttribute('data-provider') || '';
                var visible = (dp === '' || dp === p);
                opt.hidden = !visible;
                opt.disabled = !visible;
                if (visible && !firstVisibleValue && opt.value) firstVisibleValue = opt.value;
            });
            var current = compConfigSel.selectedOptions[0];
            if (!current || current.disabled) {
                compConfigSel.value = firstVisibleValue;
            }
            var toolSetBtn = document.querySelector('[data-status-action="editCompactionToolSet"]');
            if (toolSetBtn) {
                if (p === 'anthropic') {
                    toolSetBtn.setAttribute('disabled', 'disabled');
                    toolSetBtn.title = "Anthropic uses the active profile's enabledTools";
                } else {
                    toolSetBtn.removeAttribute('disabled');
                    toolSetBtn.title = '';
                }
            }
        };
        compProviderSel.addEventListener('change', filterCompConfig);
        filterCompConfig();
    }

    if (skipEditorInit) {
        return;
    }

    // Initialize schedule and executables editors
    initScheduleEditor();
    initExecutablesEditor();
    initBinaryPathEditor();
    initCommandlinesEditor();
    initFavoritesEditor();
    initLlmConfigsEditor();
    initAiSetupsEditor();
}

// =========== Schedule Editor JS ===========
var __scheduleSlots = [];
var __weekdayNames = ['Su', 'Mo', 'Tu', 'We', 'Th', 'Fr', 'Sa'];
var __monthNames = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
var __newSlotOpen = false;

function initScheduleEditor() {
    var el = document.getElementById('sp-schedule-init');
    if (!el) return;
    try { __scheduleSlots = JSON.parse(el.value || '[]'); } catch(e) { __scheduleSlots = []; }
    renderScheduleSlots();
}

function slotSummary(slot) {
    var parts = [];
    if (slot.dayType === 'weekday') {
        var days = (slot.weekdays||[]).map(function(i){return __weekdayNames[i];}).join(',');
        parts.push(days || 'No days');
    } else if (slot.dayType === 'first-weekday') {
        parts.push('1st ' + __weekdayNames[slot.monthWeekday||0]);
    } else if (slot.dayType === 'last-weekday') {
        parts.push('Last ' + __weekdayNames[slot.monthWeekday||0]);
    } else if (slot.dayType === 'day-of-month') {
        parts.push('Day ' + (slot.dayOfMonth||1));
    }
    if (slot.timeFrom || slot.timeTo) parts.push((slot.timeFrom||'??') + '—' + (slot.timeTo||'??'));
    return parts.join(' ') || '(empty)';
}

function renderScheduleSlots() {
    var c = document.getElementById('sp-schedule-slots');
    if (!c) return;
    c.innerHTML = '';
    __scheduleSlots.forEach(function(slot, idx) {
        var div = document.createElement('div');
        div.className = 'sp-schedule-slot';
        div.setAttribute('data-idx', idx);
        div.innerHTML =
            '<div class="sp-slot-header" onclick="toggleSlotBody(' + idx + ')">' +
            '<span style="font-size:11px;font-weight:600"><span class="sp-slot-icon" id="sp-slot-icon-' + idx + '">▶</span> ' + slotSummary(slot) + '</span>' +
            '<button class="sp-btn" onclick="event.stopPropagation();removeScheduleSlot(' + idx + ')" title="Remove">✕</button></div>' +
            '<div class="sp-slot-body sp-slot-collapsed" id="sp-slot-body-' + idx + '">' + buildSlotHtml(slot, idx) +
            '<div class="sp-settings-row"><button class="sp-btn primary" onclick="saveScheduleSlot(' + idx + ')">Save</button></div>' +
            '</div>';
        c.appendChild(div);
    });
}

function toggleSlotBody(idx) {
    var body = document.getElementById('sp-slot-body-' + idx);
    var icon = document.getElementById('sp-slot-icon-' + idx);
    if (!body) return;
    body.classList.toggle('sp-slot-collapsed');
    if (icon) icon.textContent = body.classList.contains('sp-slot-collapsed') ? '▶' : '▼';
}

function buildSlotHtml(slot, idx) {
    var html = '<div class="sp-settings-row">' +
        '<label>Type:</label><select class="sp-sched-daytype" onchange="onSchedDayTypeChange(' + idx + ',this.value)">' +
        '<option value="weekday"' + (slot.dayType==='weekday'?' selected':'') + '>Weekdays</option>' +
        '<option value="first-weekday"' + (slot.dayType==='first-weekday'?' selected':'') + '>First weekday/month</option>' +
        '<option value="last-weekday"' + (slot.dayType==='last-weekday'?' selected':'') + '>Last weekday/month</option>' +
        '<option value="day-of-month"' + (slot.dayType==='day-of-month'?' selected':'') + '>Day of month</option>' +
        '</select></div>';

    if (slot.dayType === 'weekday') {
        html += '<div class="sp-sched-inline-row sp-sched-weekdays">';
        __weekdayNames.forEach(function(n,i) {
            var ck = (slot.weekdays||[]).indexOf(i) >= 0 ? ' checked' : '';
            html += '<label class="sp-sched-cb"><input type="checkbox" value="' + i + '"' + ck + '>' + n + '</label>';
        });
        html += '</div>';
    } else if (slot.dayType === 'first-weekday' || slot.dayType === 'last-weekday') {
        html += '<div class="sp-settings-row"><label>Weekday:</label><select class="sp-sched-monthwd">';
        __weekdayNames.forEach(function(n,i) {
            html += '<option value="' + i + '"' + (slot.monthWeekday===i?' selected':'') + '>' + n + '</option>';
        });
        html += '</select></div><div class="sp-sched-inline-row"><label style="color:var(--vscode-descriptionForeground)">Months:</label>';
        for (var m=1;m<=12;m++) {
            var ck = (slot.months||[]).indexOf(m) >= 0 ? ' checked' : '';
            html += '<label class="sp-sched-cb"><input type="checkbox" class="sp-sched-month" value="' + m + '"' + ck + '>' + __monthNames[m-1] + '</label>';
        }
        html += '</div>';
    } else if (slot.dayType === 'day-of-month') {
        html += '<div class="sp-settings-row"><label>Day:</label><input type="number" class="sp-sched-dom" min="1" max="31" value="' + (slot.dayOfMonth||1) + '"></div>';
        html += '<div class="sp-sched-inline-row"><label style="color:var(--vscode-descriptionForeground)">Months:</label>';
        for (var m=1;m<=12;m++) {
            var ck = (slot.months||[]).indexOf(m) >= 0 ? ' checked' : '';
            html += '<label class="sp-sched-cb"><input type="checkbox" class="sp-sched-month" value="' + m + '"' + ck + '>' + __monthNames[m-1] + '</label>';
        }
        html += '</div>';
    }

    html += '<div class="sp-settings-row"><label>Time:</label>' +
        '<input type="text" class="sp-sched-from" placeholder="HH:MM" value="' + (slot.timeFrom||'') + '" style="width:55px">' +
        '<span>—</span>' +
        '<input type="text" class="sp-sched-to" placeholder="HH:MM" value="' + (slot.timeTo||'') + '" style="width:55px"></div>';
    return html;
}

function addScheduleSlot() {
    __scheduleSlots.push({ id: Date.now().toString(), dayType: 'weekday', weekdays: [0,1,2,3,4,5,6] });
    renderScheduleSlots();
    // Auto-open the newly added slot
    var lastIdx = __scheduleSlots.length - 1;
    toggleSlotBody(lastIdx);
}

function removeScheduleSlot(idx) {
    collectScheduleSlotData(idx);
    __scheduleSlots.splice(idx, 1);
    // Auto-save after removal
    vscode.postMessage({ type: 'statusAction', action: 'saveSchedule', schedule: __scheduleSlots });
    renderScheduleSlots();
}

function parseTimeStr(t) {
    if (!t || typeof t !== 'string') return null;
    var parts = t.split(':');
    if (parts.length !== 2) return null;
    var h = parseInt(parts[0], 10);
    var m = parseInt(parts[1], 10);
    if (isNaN(h) || isNaN(m)) return null;
    if (h < 0) h = 0; if (h > 24) h = 24;
    if (m < 0) m = 0; if (m > 59) m = 59;
    if (h === 24) m = 0;
    return { h: h, m: m };
}

function formatTime(t) {
    return (t.h < 10 ? '0' : '') + t.h + ':' + (t.m < 10 ? '0' : '') + t.m;
}

function timeToMinutes(t) { return t.h * 60 + t.m; }

function saveScheduleSlot(idx) {
    collectScheduleSlotData(idx);
    // Validate and normalise time fields
    var slot = __scheduleSlots[idx];
    var fromParsed = parseTimeStr(slot.timeFrom);
    var toParsed = parseTimeStr(slot.timeTo);
    if (fromParsed) slot.timeFrom = formatTime(fromParsed);
    if (toParsed) slot.timeTo = formatTime(toParsed);
    // Swap if end < start
    if (fromParsed && toParsed && timeToMinutes(toParsed) < timeToMinutes(fromParsed)) {
        var tmp = slot.timeFrom; slot.timeFrom = slot.timeTo; slot.timeTo = tmp;
    }
    // Save the entire schedule
    vscode.postMessage({ type: 'statusAction', action: 'saveSchedule', schedule: __scheduleSlots });
    // Collapse only this slot (not the whole section), then re-render
    renderScheduleSlots();
    // Ensure the Timer Schedule section stays open after re-render
    var tsContent = document.getElementById('sp-timerSchedule-content');
    var tsIcon = tsContent ? (tsContent.previousElementSibling ? tsContent.previousElementSibling.querySelector('.sp-collapse-icon') : null) : null;
    if (tsContent) { tsContent.classList.remove('sp-collapsed'); if (tsIcon) tsIcon.textContent = '▼'; }
}

function onSchedDayTypeChange(idx, newType) {
    collectScheduleSlotData(idx);
    __scheduleSlots[idx].dayType = newType;
    delete __scheduleSlots[idx].weekdays;
    delete __scheduleSlots[idx].monthWeekday;
    delete __scheduleSlots[idx].months;
    delete __scheduleSlots[idx].dayOfMonth;
    if (newType === 'weekday') __scheduleSlots[idx].weekdays = [0,1,2,3,4,5,6];
    if (newType === 'first-weekday' || newType === 'last-weekday' || newType === 'day-of-month') __scheduleSlots[idx].months = [1,2,3,4,5,6,7,8,9,10,11,12];
    renderScheduleSlots();
    // Keep the changed slot open after re-render
    toggleSlotBody(idx);
}

function collectScheduleSlotData(idx) {
    var c = document.getElementById('sp-schedule-slots');
    if (!c) return;
    var slotDiv = c.querySelectorAll('.sp-schedule-slot')[idx];
    if (!slotDiv) return;
    var slot = __scheduleSlots[idx];
    slot.dayType = slotDiv.querySelector('.sp-sched-daytype').value;
    if (slot.dayType === 'weekday') {
        slot.weekdays = [];
        slotDiv.querySelectorAll('.sp-sched-weekdays input:checked').forEach(function(cb) { slot.weekdays.push(parseInt(cb.value)); });
    } else if (slot.dayType === 'first-weekday' || slot.dayType === 'last-weekday') {
        var sel = slotDiv.querySelector('.sp-sched-monthwd');
        if (sel) slot.monthWeekday = parseInt(sel.value);
        slot.months = [];
        slotDiv.querySelectorAll('.sp-sched-month:checked').forEach(function(cb) { slot.months.push(parseInt(cb.value)); });
    } else if (slot.dayType === 'day-of-month') {
        var dom = slotDiv.querySelector('.sp-sched-dom');
        if (dom) slot.dayOfMonth = parseInt(dom.value);
        slot.months = [];
        slotDiv.querySelectorAll('.sp-sched-month:checked').forEach(function(cb) { slot.months.push(parseInt(cb.value)); });
    }
    slot.timeFrom = (slotDiv.querySelector('.sp-sched-from')||{}).value || '';
    slot.timeTo = (slotDiv.querySelector('.sp-sched-to')||{}).value || '';
}

function collectAllScheduleData() {
    var c = document.getElementById('sp-schedule-slots');
    if (!c) return __scheduleSlots;
    c.querySelectorAll('.sp-schedule-slot').forEach(function(_, idx) { collectScheduleSlotData(idx); });
    return __scheduleSlots;
}

// =========== Executables Editor JS ===========
var __executables = {};
var __defaultPlatforms = ['darwin-arm64','darwin-x64','linux-x64','linux-arm64','windows-x64','darwin-*','linux-*','windows-*','*'];

function initExecutablesEditor() {
    var el = document.getElementById('sp-executables-init');
    if (!el) return;
    try { __executables = JSON.parse(el.value || '{}'); } catch(e) { __executables = {}; }
    renderExecutables();
}

function renderExecutables() {
    var c = document.getElementById('sp-executables-list');
    if (!c) return;
    c.innerHTML = '';
    var names = Object.keys(__executables);
    if (names.length === 0) {
        c.innerHTML = '<div class="sp-settings-row" style="color:var(--vscode-descriptionForeground)"><em>No executables configured</em></div>';
        return;
    }
    names.forEach(function(name) {
        var cfg = __executables[name];
        var div = document.createElement('div');
        div.className = 'sp-exec-entry';
        var html = '<div class="sp-settings-row"><strong>' + name + '</strong>' +
            '<button class="sp-btn" onclick="removeExecutable(\\'' + name + '\\')" title="Remove executable">✕</button></div>';
        Object.keys(cfg).forEach(function(plat) {
            html += '<div class="sp-settings-row"><label style="min-width:90px">' + plat + ':</label>' +
                '<input type="text" class="sp-exec-path" data-name="' + name + '" data-platform="' + plat + '" value="' + (cfg[plat]||'') + '" style="flex:1;min-width:120px;max-width:none">' +
                '<button class="sp-btn" onclick="removeExecPlatform(\\'' + name + '\\',\\'' + plat + '\\')" title="Remove">✕</button></div>';
        });
        html += '<div class="sp-settings-row"><select class="sp-exec-plat-sel" id="sp-plat-' + name + '">';
        __defaultPlatforms.forEach(function(p) {
            if (!cfg[p]) html += '<option value="' + p + '">' + p + '</option>';
        });
        html += '<option value="__custom__">Custom...</option>';
        html += '</select><button class="sp-btn" onclick="addExecPlatform(\\'' + name + '\\')">+ Platform</button></div>';
        div.innerHTML = html;
        c.appendChild(div);
    });
}

function syncExecInputs() {
    // Read current input values back into __executables before any re-render
    document.querySelectorAll('.sp-exec-path').forEach(function(input) {
        var name = input.getAttribute('data-name');
        var plat = input.getAttribute('data-platform');
        if (name && plat && __executables[name]) {
            __executables[name][plat] = input.value;
        }
    });
}

function createNewExecutable() {
    var input = document.getElementById('sp-new-exec-name');
    if (!input) return;
    var name = input.value.trim();
    if (!name) return;
    if (__executables[name]) return;
    syncExecInputs();
    __executables[name] = {};
    input.value = '';
    renderExecutables();
}

function removeExecutable(name) {
    syncExecInputs();
    delete __executables[name];
    renderExecutables();
}

function addExecPlatform(name) {
    var sel = document.getElementById('sp-plat-' + name);
    if (!sel) return;
    var plat = sel.value;
    if (plat === '__custom__') {
        plat = window.prompt ? window.prompt('Platform key (e.g. freebsd-x64):') : '';
        if (!plat || !plat.trim()) return;
        plat = plat.trim();
    }
    if (!__executables[name]) __executables[name] = {};
    syncExecInputs();
    __executables[name][plat] = '';
    renderExecutables();
}

function removeExecPlatform(name, plat) {
    if (__executables[name]) {
        syncExecInputs();
        delete __executables[name][plat];
        renderExecutables();
    }
}

function collectExecutablesData() {
    var result = {};
    Object.keys(__executables).forEach(function(name) { result[name] = {}; });
    document.querySelectorAll('.sp-exec-path').forEach(function(input) {
        var name = input.getAttribute('data-name');
        var plat = input.getAttribute('data-platform');
        if (name && plat) {
            if (!result[name]) result[name] = {};
            result[name][plat] = input.value;
        }
    });
    return result;
}

// =========== Binary Path Editor JS ===========
var __binaryPath = {};

function initBinaryPathEditor() {
    var el = document.getElementById('sp-binarypath-init');
    if (!el) return;
    try { __binaryPath = JSON.parse(el.value || '{}'); } catch(e) { __binaryPath = {}; }
    renderBinaryPath();
}

function renderBinaryPath() {
    var c = document.getElementById('sp-binarypath-list');
    if (!c) return;
    c.innerHTML = '';
    var platforms = Object.keys(__binaryPath);
    if (platforms.length === 0) {
        c.innerHTML = '<div class="sp-settings-row" style="color:var(--vscode-descriptionForeground)"><em>Using fallback: ~/.tom/bin/&lt;platform&gt;/</em></div>';
        return;
    }
    platforms.forEach(function(plat) {
        var html = '<div class="sp-settings-row"><label style="min-width:90px">' + plat + ':</label>' +
            '<input type="text" class="sp-bp-path" data-platform="' + plat + '" value="' + (__binaryPath[plat]||'') + '" style="flex:1;min-width:120px;max-width:none">' +
            '<button class="sp-btn" onclick="removeBinaryPathPlatform(\\'' + plat + '\\')" title="Remove">\u2715</button></div>';
        c.insertAdjacentHTML('beforeend', html);
    });
}

function addBinaryPathPlatform() {
    var sel = document.getElementById('sp-binarypath-plat-sel');
    if (!sel) return;
    var plat = sel.value;
    if (plat === '__custom__') {
        plat = window.prompt ? window.prompt('Platform key (e.g. freebsd-x64):') : '';
        if (!plat || !plat.trim()) return;
        plat = plat.trim();
    }
    if (__binaryPath[plat] !== undefined) return; // already exists
    __binaryPath[plat] = '';
    renderBinaryPath();
}

function removeBinaryPathPlatform(plat) {
    delete __binaryPath[plat];
    renderBinaryPath();
}

function collectBinaryPathData() {
    var result = {};
    document.querySelectorAll('.sp-bp-path').forEach(function(input) {
        var plat = input.getAttribute('data-platform');
        if (plat) result[plat] = input.value;
    });
    return result;
}

// Helper for inline handlers (e.g. checkbox onchange)
function sendStatusAction(action, extra) {
    var msg = { type: 'statusAction', action: action };
    if (extra) { Object.keys(extra).forEach(function(k) { msg[k] = extra[k]; }); }
    vscode.postMessage(msg);
}

// =========== Commandlines Editor JS ===========
var __commandlines = [];
var __cmdDragIdx = -1;
var __cwdModes = [
    { value: 'none',       label: 'No cwd' },
    { value: 'workspace',  label: 'Workspace Root' },
    { value: 'extension',  label: 'Extension Root' },
    { value: 'project',    label: 'Project Root' },
    { value: 'repository', label: 'Repository Root' },
    { value: 'document',   label: 'Document Root' },
    { value: 'custom',     label: 'Custom Path' },
];

function initCommandlinesEditor() {
    var el = document.getElementById('sp-commandlines-init');
    if (!el) return;
    try { __commandlines = JSON.parse(el.value || '[]'); } catch(e) { __commandlines = []; }
    renderCommandlines();
}

function renderCommandlines() {
    var c = document.getElementById('sp-commandlines-list');
    if (!c) return;
    c.innerHTML = '';
    if (__commandlines.length === 0) {
        c.innerHTML = '<div class="sp-settings-row" style="color:var(--vscode-descriptionForeground)"><em>No commandlines defined</em></div>';
        return;
    }
    __commandlines.forEach(function(entry, idx) {
        var div = document.createElement('div');
        div.className = 'sp-exec-entry';
        div.setAttribute('draggable', 'true');
        div.setAttribute('data-cmd-idx', idx);
        div.addEventListener('dragstart', function(e) { __cmdDragIdx = idx; e.dataTransfer.effectAllowed = 'move'; });
        div.addEventListener('dragover', function(e) { e.preventDefault(); e.dataTransfer.dropEffect = 'move'; div.style.borderTop = '2px solid var(--vscode-focusBorder)'; });
        div.addEventListener('dragleave', function() { div.style.borderTop = ''; });
        div.addEventListener('drop', function(e) {
            e.preventDefault(); div.style.borderTop = '';
            if (__cmdDragIdx >= 0 && __cmdDragIdx !== idx) { reorderCommandline(__cmdDragIdx, idx); }
            __cmdDragIdx = -1;
        });

        var cwdSel = __cwdModes.map(function(m) {
            return '<option value="' + m.value + '"' + ((entry.cwdMode||'custom')===m.value?' selected':'') + '>' + m.label + '</option>';
        }).join('');

        var autoKey = idx < 9 ? String(idx+1) : (idx < 35 ? String.fromCharCode(97 + idx - 9) : '');
        var keyLabel = autoKey ? ' [' + autoKey + ']' : '';

        var postActionsStr = (entry.postActions || []).join(', ');
        var closeAfterRunChecked = entry.closeTerminalAfterRun === true ? ' checked' : '';

        div.innerHTML =
            '<div class="sp-settings-row"><strong style="cursor:grab">☰ ' + (entry.description || entry.command || '(unnamed)') + keyLabel + '</strong>' +
            '<span style="font-size:10px;color:var(--vscode-descriptionForeground);margin-left:auto">' + (idx > 0 ? '<button class="sp-btn" onclick="reorderCommandline(' + idx + ',' + (idx-1) + ')" title="Move up" style="padding:1px 4px;font-size:10px">▲</button>' : '') +
            (idx < __commandlines.length - 1 ? '<button class="sp-btn" onclick="reorderCommandline(' + idx + ',' + (idx+1) + ')" title="Move down" style="padding:1px 4px;font-size:10px">▼</button>' : '') + '</span>' +
            '<button class="sp-btn" onclick="removeCommandline(' + idx + ')" title="Remove">✕</button></div>' +
            '<div class="sp-settings-row"><label>Command:</label>' +
            '<input type="text" class="sp-cmd-command" data-idx="' + idx + '" value="' + escapeAttr(entry.command||'') + '" style="flex:1;min-width:150px;max-width:none"></div>' +
            '<div class="sp-settings-row"><label>Description:</label>' +
            '<input type="text" class="sp-cmd-desc" data-idx="' + idx + '" value="' + escapeAttr(entry.description||'') + '" style="flex:1;min-width:150px;max-width:none"></div>' +
            '<div class="sp-settings-row"><label>CWD Mode:</label>' +
            '<select class="sp-cmd-cwdmode" data-idx="' + idx + '">' + cwdSel + '</select>' +
            (entry.cwdMode === 'custom' || (!entry.cwdMode && entry.cwd) ? '<input type="text" class="sp-cmd-cwd" data-idx="' + idx + '" value="' + escapeAttr(entry.cwd||'') + '" placeholder="Custom path" style="flex:1;min-width:80px">' : '') +
            '</div>' +
            '<div class="sp-settings-row"><label>Post-Actions:</label>' +
            '<input type="text" class="sp-cmd-postactions" data-idx="' + idx + '" value="' + escapeAttr(postActionsStr) + '" placeholder="VS Code command IDs, comma-separated" style="flex:1;min-width:150px;max-width:none"></div>' +
            '<div class="sp-settings-row"><label>Close terminal after run:</label>' +
            '<input type="checkbox" class="sp-cmd-close-terminal" data-idx="' + idx + '"' + closeAfterRunChecked + '></div>';
        c.appendChild(div);
    });
}

function escapeAttr(s) { return s.replace(/&/g,'&amp;').replace(/"/g,'&quot;').replace(/</g,'&lt;').replace(/>/g,'&gt;'); }

function addCommandlineEntry() {
    __commandlines.push({ command: '', description: '', cwdMode: 'workspace' });
    renderCommandlines();
}

function removeCommandline(idx) {
    __commandlines.splice(idx, 1);
    renderCommandlines();
}

function reorderCommandline(fromIdx, toIdx) {
    var item = __commandlines.splice(fromIdx, 1)[0];
    __commandlines.splice(toIdx, 0, item);
    renderCommandlines();
}

function collectCommandlinesData() {
    var result = [];
    document.querySelectorAll('.sp-cmd-command').forEach(function(input) {
        var idx = parseInt(input.getAttribute('data-idx'));
        if (isNaN(idx)) return;
        var entry = __commandlines[idx] || {};
        var descEl = document.querySelector('.sp-cmd-desc[data-idx="' + idx + '"]');
        var cwdModeEl = document.querySelector('.sp-cmd-cwdmode[data-idx="' + idx + '"]');
        var cwdEl = document.querySelector('.sp-cmd-cwd[data-idx="' + idx + '"]');
        var postActionsEl = document.querySelector('.sp-cmd-postactions[data-idx="' + idx + '"]');
        var closeTerminalEl = document.querySelector('.sp-cmd-close-terminal[data-idx="' + idx + '"]');
        var postActions = [];
        if (postActionsEl && postActionsEl.value.trim()) {
            postActions = postActionsEl.value.split(',').map(function(s) { return s.trim(); }).filter(function(s) { return s; });
        }
        result.push({
            command: input.value,
            description: descEl ? descEl.value : (entry.description || ''),
            cwdMode: cwdModeEl ? cwdModeEl.value : (entry.cwdMode || 'workspace'),
            cwd: cwdEl ? cwdEl.value : (entry.cwd || ''),
            postActions: postActions,
            closeTerminalAfterRun: closeTerminalEl ? closeTerminalEl.checked : entry.closeTerminalAfterRun === true
        });
    });
    return result;
}

// =========== Favorites Editor JS ===========
var __favorites = [];
var __favDragIdx = -1;

function initFavoritesEditor() {
    var el = document.getElementById('sp-favorites-init');
    if (!el) return;
    try { __favorites = JSON.parse(el.value || '[]'); } catch(e) { __favorites = []; }
    renderFavorites();
}

function renderFavorites() {
    var c = document.getElementById('sp-favorites-list');
    if (!c) return;
    c.innerHTML = '';
    if (__favorites.length === 0) {
        c.innerHTML = '<div class="sp-settings-row" style="color:var(--vscode-descriptionForeground)"><em>No favorites configured</em></div>';
        return;
    }
    __favorites.forEach(function(entry, idx) {
        var div = document.createElement('div');
        div.className = 'sp-exec-entry';
        div.setAttribute('draggable', 'true');
        div.setAttribute('data-fav-idx', idx);
        div.addEventListener('dragstart', function(e) { __favDragIdx = idx; e.dataTransfer.effectAllowed = 'move'; });
        div.addEventListener('dragover', function(e) { e.preventDefault(); e.dataTransfer.dropEffect = 'move'; div.style.borderTop = '2px solid var(--vscode-focusBorder)'; });
        div.addEventListener('dragleave', function() { div.style.borderTop = ''; });
        div.addEventListener('drop', function(e) {
            e.preventDefault(); div.style.borderTop = '';
            if (__favDragIdx >= 0 && __favDragIdx !== idx) { reorderFavorite(__favDragIdx, idx); }
            __favDragIdx = -1;
        });

        // Support commandIds (array), commandId (string), and command (alias)
        var cmdValue = '';
        if (Array.isArray(entry.commandIds) && entry.commandIds.length > 0) {
            cmdValue = entry.commandIds.join(', ');
        } else {
            cmdValue = entry.commandId || entry.command || '';
        }

        div.innerHTML =
            '<div class="sp-settings-row"><strong style="cursor:grab">☰ ' + escapeAttr(entry.label || cmdValue || '(unnamed)') + '</strong>' +
            '<span style="font-size:10px;color:var(--vscode-descriptionForeground);margin-left:auto">' + (idx > 0 ? '<button class="sp-btn" onclick="reorderFavorite(' + idx + ',' + (idx-1) + ')" title="Move up" style="padding:1px 4px;font-size:10px">▲</button>' : '') +
            (idx < __favorites.length - 1 ? '<button class="sp-btn" onclick="reorderFavorite(' + idx + ',' + (idx+1) + ')" title="Move down" style="padding:1px 4px;font-size:10px">▼</button>' : '') + '</span>' +
            '<button class="sp-btn" onclick="removeFavorite(' + idx + ')" title="Remove">✕</button></div>' +
            '<div class="sp-settings-row"><label>Key:</label>' +
            '<input type="text" class="sp-fav-key" data-idx="' + idx + '" value="' + escapeAttr(entry.key||'') + '" maxlength="1" style="width:30px;text-align:center">' +
            '<label>Label:</label>' +
            '<input type="text" class="sp-fav-label" data-idx="' + idx + '" value="' + escapeAttr(entry.label||'') + '" style="flex:1;min-width:100px;max-width:none"></div>' +
            '<div class="sp-settings-row"><label>Command:</label>' +
            '<input type="text" class="sp-fav-command" data-idx="' + idx + '" value="' + escapeAttr(cmdValue) + '" placeholder="command.id or cmd1, cmd2, cmd3" style="flex:1;min-width:150px;max-width:none"></div>' +
            '<div class="sp-settings-row"><label>Description:</label>' +
            '<input type="text" class="sp-fav-desc" data-idx="' + idx + '" value="' + escapeAttr(entry.description||'') + '" style="flex:1;min-width:150px;max-width:none"></div>';
        c.appendChild(div);
    });
}

function addFavoriteEntry() {
    __favorites.push({ key: '', label: '', commandId: '', description: '' });
    renderFavorites();
}

function removeFavorite(idx) {
    __favorites.splice(idx, 1);
    renderFavorites();
}

function reorderFavorite(fromIdx, toIdx) {
    var item = __favorites.splice(fromIdx, 1)[0];
    __favorites.splice(toIdx, 0, item);
    renderFavorites();
}

function collectFavoritesData() {
    var result = [];
    document.querySelectorAll('.sp-fav-key').forEach(function(input) {
        var idx = parseInt(input.getAttribute('data-idx'));
        if (isNaN(idx)) return;
        var labelEl = document.querySelector('.sp-fav-label[data-idx="' + idx + '"]');
        var cmdEl = document.querySelector('.sp-fav-command[data-idx="' + idx + '"]');
        var descEl = document.querySelector('.sp-fav-desc[data-idx="' + idx + '"]');
        var rawCmd = cmdEl ? cmdEl.value.trim() : '';
        var entry = {
            key: input.value,
            label: labelEl ? labelEl.value : '',
            description: descEl ? descEl.value : ''
        };
        // If comma-separated, store as commandIds array; otherwise single commandId
        if (rawCmd.indexOf(',') >= 0) {
            var ids = rawCmd.split(',').map(function(s) { return s.trim(); }).filter(function(s) { return s.length > 0; });
            if (ids.length > 1) {
                entry.commandIds = ids;
                entry.commandId = ids[0];
            } else {
                entry.commandId = ids[0] || '';
            }
        } else {
            entry.commandId = rawCmd;
        }
        result.push(entry);
    });
    return result;
}

function collectLlmProfilesData() {
    var result = {};
    document.querySelectorAll('.sp-llm-profile-model').forEach(function(select) {
        var profile = select.getAttribute('data-profile');
        if (!profile) return;
        var toolsEl = document.querySelector('.sp-llm-profile-tools[data-profile="' + profile + '"]');
        result[profile] = {
            modelConfig: select.value || null,
            toolsEnabled: toolsEl ? toolsEl.value === 'true' : true
        };
    });
    return result;
}

function collectConvProfilesData() {
    var result = {};
    document.querySelectorAll('.sp-conv-profile-model').forEach(function(select) {
        var profile = select.getAttribute('data-profile');
        if (!profile) return;
        result[profile] = {
            modelConfig: select.value || null
        };
    });
    return result;
}

// =========== LLM Configurations Editor JS ===========
var __llmConfigs = [];

var __availableLlmTools = ${JSON.stringify(AVAILABLE_LLM_TOOLS)};

function initLlmConfigsEditor() {
    var el = document.getElementById('sp-llmconfigs-init');
    if (!el) return;
    try { __llmConfigs = JSON.parse(el.value || '[]'); } catch(e) { __llmConfigs = []; }
    renderLlmConfigurations();
}

function renderLlmConfigurations() {
    var list = document.getElementById('sp-llmconfigs-list');
    if (!list) return;
    if (__llmConfigs.length === 0) {
        list.innerHTML = '<div class="sp-info">No LLM configurations defined</div>';
        return;
    }

    list.innerHTML = __llmConfigs.map(function(cfg) {
        var id = String(cfg.id || '').replace(/"/g, '&quot;');
        var name = String(cfg.name || id).replace(/"/g, '&quot;');
        var summaryPrompt = String(cfg.trailSummarizationPrompt || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
        var enabledTools = Array.isArray(cfg.enabledTools) ? cfg.enabledTools : [];
        var toolsHtml = __availableLlmTools.map(function(tool) {
            var checked = enabledTools.indexOf(tool) >= 0 ? 'checked' : '';
            return '<label class="sp-tool-checkbox" title="' + tool + '">' +
                '<input type="checkbox" data-tool="' + tool + '" data-config="' + id + '" ' + checked + '>' +
                tool.replace('tom_', '').replace('tomAi_', '') +
            '</label>';
        }).join('');

        return '<div class="sp-llmconfig-card" data-config-id="' + id + '">' +
            '<div class="sp-llmconfig-header">' +
                '<input type="text" class="sp-config-name" value="' + name + '" data-field="name" placeholder="Name">' +
                '<input type="text" class="sp-config-id" value="' + id + '" data-field="id" placeholder="ID" readonly>' +
                '<button class="sp-btn small danger" data-status-action="deleteLlmConfiguration" data-config-id="' + id + '">🗑️</button>' +
            '</div>' +
            '<div class="sp-settings-row"><label>URL:</label><input type="text" data-field="ollamaUrl" value="' + (cfg.ollamaUrl || 'http://localhost:11434') + '" style="flex:2"><label>Model:</label><input type="text" data-field="model" value="' + (cfg.model || 'qwen3:8b') + '" style="flex:1"></div>' +
            '<div class="sp-settings-row"><label>Temp:</label><input type="number" data-field="temperature" value="' + (cfg.temperature ?? 0.4) + '" step="0.1" min="0" max="2"><label>Trail Tokens:</label><input type="number" data-field="trailMaximumTokens" value="' + (cfg.trailMaximumTokens ?? 8000) + '" step="1000" min="1000"></div>' +
            '<div class="sp-settings-row"><label>Sum Temp:</label><input type="number" data-field="trailSummarizationTemperature" value="' + (cfg.trailSummarizationTemperature ?? 0.3) + '" step="0.1" min="0" max="2"><label>Keep Alive:</label><input type="text" data-field="keepAlive" value="' + (cfg.keepAlive || '5m') + '"><label>History:</label><select data-field="historyMode"><option value="full" ' + (cfg.historyMode === 'full' ? 'selected' : '') + '>Full</option><option value="last" ' + (cfg.historyMode === 'last' ? 'selected' : '') + '>Last</option><option value="summary" ' + (cfg.historyMode === 'summary' ? 'selected' : '') + '>Summary</option><option value="trim_and_summary" ' + ((!cfg.historyMode || cfg.historyMode === 'trim_and_summary') ? 'selected' : '') + '>Trim+Summary</option></select></div>' +
            '<div class="sp-settings-row"><label>Answer Folder:</label><input type="text" data-field="answerFolder" value="' + (cfg.answerFolder || '') + '" style="flex:2"><label>Log Folder:</label><input type="text" data-field="logFolder" value="' + (cfg.logFolder || '') + '" style="flex:2"></div>' +
            '<div class="sp-settings-row"><label>Summary Prompt:</label><textarea data-field="trailSummarizationPrompt" rows="3" style="flex:1">' + summaryPrompt + '</textarea></div>' +
            '<div class="sp-settings-row"><label>Strip Think:</label><select data-field="stripThinkingTags"><option value="true" ' + (cfg.stripThinkingTags ? 'selected' : '') + '>Yes</option><option value="false" ' + (!cfg.stripThinkingTags ? 'selected' : '') + '>No</option></select><label>Rm Template:</label><select data-field="removePromptTemplateFromTrail"><option value="true" ' + (cfg.removePromptTemplateFromTrail ? 'selected' : '') + '>Yes</option><option value="false" ' + (!cfg.removePromptTemplateFromTrail ? 'selected' : '') + '>No</option></select></div>' +
            '<div class="sp-tools-section"><label style="font-weight:bold;margin-bottom:4px;display:block">Enabled Tools:</label><div class="sp-tools-grid">' + toolsHtml + '</div></div>' +
        '</div>';
    }).join('');

    attachStatusPanelListeners(true);
}

function addLlmConfiguration() {
    var id = 'config_' + Date.now();
    var cfg = {
        id: id,
        name: 'New Configuration',
        ollamaUrl: 'http://localhost:11434',
        model: 'qwen3:8b',
        temperature: 0.4,
        stripThinkingTags: true,
        trailMaximumTokens: 8000,
        removePromptTemplateFromTrail: true,
        trailSummarizationTemperature: 0.3,
        trailSummarizationPrompt: '',
        answerFolder: '',
        logFolder: '',
        historyMode: 'trim_and_summary',
        keepAlive: '5m',
        enabledTools: ['tomAi_readFile', 'tomAi_listDirectory', 'tomAi_findFiles', 'tomAi_findTextInFiles', 'tomAi_fetchWebpage', 'tomAi_webSearch', 'tomAi_getErrors', 'tomAi_readGlobalGuideline', 'tomAi_listGlobalGuidelines', 'tomAi_askBigBrother', 'tomAi_askCopilot']
    };
    __llmConfigs.push(cfg);
    renderLlmConfigurations();
}

function saveLlmConfigurations() {
    var configurations = collectLlmConfigurationsData();
    vscode.postMessage({ type: 'statusAction', action: 'saveLlmConfigurations', configurations: configurations });
}

function collectLlmConfigurationsData() {
    var result = [];
    document.querySelectorAll('.sp-llmconfig-card').forEach(function(card) {
        var configId = card.getAttribute('data-config-id');
        if (!configId) return;
        var cfg = {
            id: configId,
            name: card.querySelector('[data-field="name"]')?.value || '',
            ollamaUrl: card.querySelector('[data-field="ollamaUrl"]')?.value || '',
            model: card.querySelector('[data-field="model"]')?.value || '',
            temperature: parseFloat(card.querySelector('[data-field="temperature"]')?.value || 'NaN'),
            stripThinkingTags: card.querySelector('[data-field="stripThinkingTags"]')?.value === 'true',
            trailMaximumTokens: parseInt(card.querySelector('[data-field="trailMaximumTokens"]')?.value || 'NaN'),
            removePromptTemplateFromTrail: card.querySelector('[data-field="removePromptTemplateFromTrail"]')?.value === 'true',
            trailSummarizationTemperature: parseFloat(card.querySelector('[data-field="trailSummarizationTemperature"]')?.value || 'NaN'),
            trailSummarizationPrompt: card.querySelector('[data-field="trailSummarizationPrompt"]')?.value || '',
            answerFolder: card.querySelector('[data-field="answerFolder"]')?.value || '',
            logFolder: card.querySelector('[data-field="logFolder"]')?.value || '',
            historyMode: card.querySelector('[data-field="historyMode"]')?.value || '',
            keepAlive: card.querySelector('[data-field="keepAlive"]')?.value || '',
            enabledTools: []
        };
        // Collect enabled tools
        card.querySelectorAll('.sp-tools-grid input[type="checkbox"]:checked').forEach(function(cb) {
            cfg.enabledTools.push(cb.getAttribute('data-tool'));
        });
        result.push(cfg);
    });
    return result;
}

// =========== AI Conversation Setups Editor JS ===========
var __aiSetups = [];

function initAiSetupsEditor() {
    var el = document.getElementById('sp-aisetups-init');
    if (!el) return;
    try { __aiSetups = JSON.parse(el.value || '[]'); } catch(e) { __aiSetups = []; }
    renderAiSetups();
}

function _getLlmConfigOptions(selected, includeCopilot) {
    var opts = [];
    if (includeCopilot) {
        opts.push('<option value="copilot" ' + (selected === 'copilot' ? 'selected' : '') + '>Copilot</option>');
    } else {
        opts.push('<option value="">(None)</option>');
    }
    __llmConfigs.forEach(function(cfg) {
        var id = cfg.id || '';
        var name = cfg.name || id;
        if (id) {
            opts.push('<option value="' + String(id).replace(/"/g, '&quot;') + '" ' + (id === selected ? 'selected' : '') + '>' + String(name).replace(/</g, '&lt;').replace(/>/g, '&gt;') + '</option>');
        }
    });
    return opts.join('');
}

function renderAiSetups() {
    var list = document.getElementById('sp-aisetups-list');
    if (!list) return;
    if (__aiSetups.length === 0) {
        list.innerHTML = '<div class="sp-info">No AI Conversation setups defined</div>';
        return;
    }
    list.innerHTML = __aiSetups.map(function(setup) {
        var id = String(setup.id || '').replace(/"/g, '&quot;');
        var name = String(setup.name || id).replace(/"/g, '&quot;');
        return '<div class="sp-aisetup-card" data-setup-id="' + id + '">' +
            '<div class="sp-aisetup-header">' +
                '<input type="text" class="sp-setup-name" value="' + name + '" data-field="name" placeholder="Name">' +
                '<input type="text" class="sp-setup-id" value="' + id + '" data-field="id" placeholder="ID" readonly>' +
                '<button class="sp-btn small danger" data-status-action="deleteAiConversationSetup" data-setup-id="' + id + '">🗑️</button>' +
            '</div>' +
            '<div class="sp-settings-row"><label>LLM Config A:</label><select data-field="llmConfigA">' + _getLlmConfigOptions(setup.llmConfigA || '', false) + '</select><label>LLM Config B:</label><select data-field="llmConfigB">' + _getLlmConfigOptions(setup.llmConfigB || '', true) + '</select></div>' +
            '<div class="sp-settings-row"><label>Max Turns:</label><input type="number" data-field="maxTurns" value="' + (setup.maxTurns ?? 10) + '" min="1" max="50"><label>Pause Between:</label><select data-field="pauseBetweenTurns"><option value="true" ' + (setup.pauseBetweenTurns ? 'selected' : '') + '>Yes</option><option value="false" ' + (!setup.pauseBetweenTurns ? 'selected' : '') + '>No</option></select><label>History:</label><select data-field="historyMode"><option value="full" ' + (setup.historyMode === 'full' ? 'selected' : '') + '>Full</option><option value="last" ' + (setup.historyMode === 'last' ? 'selected' : '') + '>Last</option><option value="summary" ' + (setup.historyMode === 'summary' ? 'selected' : '') + '>Summary</option><option value="trim_and_summary" ' + ((!setup.historyMode || setup.historyMode === 'trim_and_summary') ? 'selected' : '') + '>Trim+Summary</option></select><label>Sum LLM:</label><select data-field="trailSummarizationLlmConfig">' + _getLlmConfigOptions(setup.trailSummarizationLlmConfig || '', false) + '</select></div>' +
        '</div>';
    }).join('');
    attachStatusPanelListeners(true);
}

function addAiConversationSetup() {
    var id = 'setup_' + Date.now();
    var setup = {
        id: id,
        name: 'New Setup',
        llmConfigA: '',
        llmConfigB: 'copilot',
        maxTurns: 10,
        pauseBetweenTurns: false,
        historyMode: 'trim_and_summary',
        trailSummarizationLlmConfig: ''
    };
    __aiSetups.push(setup);
    renderAiSetups();
}

function saveAiConversationSetups() {
    var setups = collectAiSetupsData();
    vscode.postMessage({ type: 'statusAction', action: 'saveAiConversationSetups', setups: setups });
}

function collectAiSetupsData() {
    var result = [];
    document.querySelectorAll('.sp-aisetup-card').forEach(function(card) {
        var setupId = card.getAttribute('data-setup-id');
        if (!setupId) return;
        result.push({
            id: setupId,
            name: card.querySelector('[data-field="name"]')?.value || '',
            llmConfigA: card.querySelector('[data-field="llmConfigA"]')?.value || '',
            llmConfigB: card.querySelector('[data-field="llmConfigB"]')?.value || '',
            maxTurns: parseInt(card.querySelector('[data-field="maxTurns"]')?.value || 'NaN'),
            pauseBetweenTurns: card.querySelector('[data-field="pauseBetweenTurns"]')?.value === 'true',
            historyMode: card.querySelector('[data-field="historyMode"]')?.value || '',
            trailSummarizationLlmConfig: card.querySelector('[data-field="trailSummarizationLlmConfig"]')?.value || ''
        });
    });
    return result;
}
`;
}

/**
 * Generate the HTML for the full status page webview.
 * Reuses getEmbeddedStatusHtml() for the body content with full-page CSS overrides.
 */
function getStatusPageHtml(status: StatusData): string {
    const contentHtml = getEmbeddedStatusHtml(status);
    
    return `<!DOCTYPE html>
<html><head><meta charset="UTF-8">
<style>
    * { margin: 0; padding: 0; box-sizing: border-box; }
    body {
        padding: 12px;
        font-family: var(--vscode-font-family);
        background-color: var(--vscode-editor-background);
        color: var(--vscode-foreground);
    }
    h1 { margin-bottom: 12px; font-size: 16px; font-weight: 600; }

    ${getEmbeddedStatusStyles()}

    /* Full-page overrides — keep compact, matching bottom-panel density */
    .sp-panel { max-width: 800px; gap: 8px; padding: 0; max-height: none; }
    .sp-section { padding: 10px; border-radius: 6px; }
    .sp-section-header { margin-bottom: 4px; }
    .sp-section-title { font-size: 12px; }
    .sp-badge { padding: 2px 8px; border-radius: 8px; font-size: 10px; }
    .sp-btn { padding: 4px 10px; font-size: 11px; border-radius: 3px; }
    .sp-settings-row { gap: 6px; margin-top: 4px; font-size: 11px; }
    .sp-settings-row label { min-width: auto; font-size: 11px; }
    .sp-settings-row input, .sp-settings-row select { padding: 2px 6px; font-size: 11px; }
    .sp-settings-row input[type="number"] { width: 60px; }
    .sp-settings-row input[type="text"] { flex: 1; min-width: 100px; max-width: 250px; }
    .sp-settings-row select { min-width: 70px; max-width: 160px; }
    .sp-settings-row textarea { padding: 2px 6px; font-size: 11px; }
    .sp-controls { gap: 6px; margin-bottom: 4px; }
    .sp-links { gap: 4px; }
    .sp-link-btn { padding: 4px 8px; font-size: 11px; }
    .sp-collapse-content { max-height: none !important; }
    .sp-collapse-content.sp-collapsed { max-height: 0 !important; }
    .sp-fullpage { display: none; }
    #sp-bridgeProfile { padding: 2px 6px; font-size: 11px; min-width: 100px; }
</style>
</head>
<body>
    <h1>🔧 Tom Extension Status</h1>
    <div id="settings-status-panel">
        ${contentHtml}
    </div>
    <script>
        var vscode = acquireVsCodeApi();
        ${getStatusPanelListenersScript()}
        attachStatusPanelListeners();
    </script>
</body></html>`;
}

/**
 * Show the status page webview panel
 */
export async function showStatusPageHandler(): Promise<void> {
    if (statusPanel) {
        statusPanel.reveal();
        await refreshStatusPage();
        return;
    }
    
    statusPanel = vscode.window.createWebviewPanel(
        'tomStatusPage',
        'Tom Extension Status',
        vscode.ViewColumn.Active,
        { enableScripts: true }
    );
    
    // Gather initial status and render
    const status = await gatherStatusData();
    statusPanel.webview.html = getStatusPageHtml(status);
    
    // Handle messages from the webview - delegates to the shared handleStatusAction
    statusPanel.webview.onDidReceiveMessage(async (msg) => {
        if (msg.type === 'statusAction') {
            await handleStatusAction(msg.action, msg);
        }
        // Refresh the status page after any action (skip for actions that manage their own UI)
        var skipRefresh = msg.action === 'saveSchedule';
        if (!skipRefresh) { setTimeout(refreshStatusPage, 500); }
    });
    
    statusPanel.onDidDispose(() => {
        statusPanel = undefined;
    });
}

/**
 * Refresh the status page with current data
 */
async function refreshStatusPage(): Promise<void> {
    if (!statusPanel) { return; }
    const status = await gatherStatusData();
    statusPanel.webview.html = getStatusPageHtml(status);
}

/**
 * Toggle trail and show notification
 */
export async function toggleTrailHandler(): Promise<void> {
    await toggleTrail();
}
