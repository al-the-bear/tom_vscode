/**
 * Handler for the Bot Conversation feature.
 *
 * Orchestrates a multi-turn conversation between a local Ollama model and
 * Copilot Chat.  The local model receives a goal description, generates
 * prompts for Copilot, evaluates Copilot's responses, and decides whether
 * to send follow-up prompts or declare the goal reached.
 *
 * Flow:
 *  1. User triggers "@T: Start AI Conversation" → enters goal description
 *  2. Local model generates the first Copilot prompt
 *  3. Prompt is sent to Copilot via the VS Code Language Model API
 *  4. Copilot response is written to a JSON answer file (window-unique)
 *  5. Local model evaluates the response + history, and either:
 *     a) Generates a follow-up prompt → goto 3
 *     b) Outputs the goal-reached marker → conversation ends
 *  6. Full conversation log is persisted to a timestamped markdown file
 *
 * Configuration lives in the `aiConversation` section of tom_vscode_extension.json.
 */

import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import { bridgeLog, getCopilotModel, sendCopilotRequest, getWorkspaceRoot, getConfigPath, resolvePathVariables } from './handler_shared';
import { loadSendToChatConfig } from '../utils/sendToChatConfig';
import { validateStrictAiConfiguration } from '../utils/sendToChatConfig';
import { resolveTemplate } from './promptTemplate';
import { getLocalLlmManager } from './localLlm-handler';
import type { OllamaStats } from './localLlm-handler';
import { TelegramNotifier, TelegramConfig, TelegramCommand, parseTelegramConfig, TELEGRAM_DEFAULTS } from './telegram-notifier';
import { TelegramChannel } from './chat';
import {
    logPrompt, logResponse, logCopilotAnswer,
    isTrailEnabled, loadTrailConfig,
} from '../services/trailLogging';
import { WsPaths } from '../utils/workspacePaths';
import { writeWindowConversationState } from './windowStatusPanel-handler.js';

// ============================================================================
// Output Channel
// ============================================================================

const conversationLog = vscode.window.createOutputChannel('Tom Conversation Log');

function logConversation(message: string, level: 'INFO' | 'WARN' | 'ERROR' = 'INFO'): void {
    const timestamp = new Date().toISOString().slice(11, 23);
    conversationLog.appendLine(`[${timestamp}] [${level}] ${message}`);
}

// ============================================================================
// Interfaces
// ============================================================================

/** Copilot response in the structured JSON format (matches dcli convention). */
export interface CopilotResponse {
    /** Unique request ID to correlate prompt/response pairs. */
    requestId: string;
    /** Main response content. */
    generatedMarkdown: string;
    /** Optional comments/notes from Copilot. */
    comments?: string;
    /** Files Copilot referenced while forming the response. */
    references: string[];
    /** Files explicitly requested by the prompt. */
    requestedAttachments: string[];
    /** Key-value pairs for data available in subsequent prompts via ${chat.<key>}. */
    responseValues?: Record<string, string>;
}

/** A single exchange in the bot conversation. */
export interface ConversationExchange {
    /** Turn number (1-based). */
    turn: number;
    /** Timestamp of the exchange. */
    timestamp: Date;
    /** The prompt sent to Copilot. */
    promptToCopilot: string;
    /** The structured response from Copilot. */
    copilotResponse: CopilotResponse;
    /** Token stats from the local model for this turn's prompt generation. */
    localModelStats?: OllamaStats;
}

/** History mode for the local model. */
export type HistoryMode = 'full' | 'last' | 'summary' | 'trim_and_summary';

/** Conversation mode — who talks to whom. */
export type ConversationMode = 'ollama-copilot' | 'ollama-ollama';

/** Actor type — which AI backend to use. */
export type ActorType = 'ollama' | 'copilot';

/** Self-talk persona config for ollama-ollama mode. */
export interface SelfTalkPersona {
    /** Actor type for this persona (ollama or copilot). */
    actor?: ActorType;
    /** System prompt that gives this persona its identity. */
    systemPrompt: string;
    /** Model config key from localLlm.models (null → default). */
    modelConfig?: string | null;
    /** Temperature override for this persona. */
    temperature?: number | null;
}

/** A named bot conversation profile. */
export interface AiConversationProfile {
    /** Human-readable label. */
    label: string;
    /** Override initial prompt template (null → inherit top-level). */
    initialPromptTemplate?: string | null;
    /** Override follow-up template (null → inherit top-level). */
    followUpTemplate?: string | null;
    /** Override copilot suffix (null → inherit top-level). */
    copilotSuffix?: string | null;
    /** Override max turns (null → inherit top-level). */
    maxTurns?: number | null;
    /** Override model config key (null → default). */
    modelConfig?: string | null;
    /** Override temperature (null → inherit top-level). */
    temperature?: number | null;
    /** Override history mode (null → inherit top-level). */
    historyMode?: HistoryMode | null;
    /** Files to include as context for the local model. */
    includeFileContext?: string[];
    /** Override goal-reached marker (null → inherit top-level). */
    goalReachedMarker?: string | null;
    /** Optional profile-scoped self-talk settings. */
    selfTalk?: {
        personA?: SelfTalkPersona;
        personB?: SelfTalkPersona;
    };
}

/** Full aiConversation section from tom_vscode_extension.json. */
export interface AiConversationConfig {
    /** Maximum conversation turns before stopping. */
    maxTurns: number;
    /** Which model config from localLlm.models to use. */
    modelConfig: string | null;
    /** Optional model config used only for history summarization. */
    trailSummarizationModelConfig: string | null;
    /** Temperature for the orchestrator model. */
    temperature: number;
    /** Maximum token count for history passed to local model. */
    maxHistoryTokens: number;
    /** Path for conversation log files. */
    conversationLogPath: string;
    /** Folder for answer JSON files. */
    answerFolder: string;
    /** Template for the local model to generate the first Copilot prompt. */
    initialPromptTemplate: string;
    /** Template for the local model to evaluate response + generate follow-up. */
    followUpTemplate: string;
    /** Suffix appended to every prompt sent to Copilot. */
    copilotSuffix: string;
    /** Summary template used when historyMode includes summarization. */
    summaryTemplate: string;
    /** Marker string the local model outputs when the goal is reached. */
    goalReachedMarker: string;
    /** Whether to pause for user review between turns. */
    pauseBetweenTurns: boolean;
    /** Whether to let the user review/edit the first generated prompt. */
    pauseBeforeFirst: boolean;
    /** Extra file paths to include as context. */
    includeFileContext: string[];
    /** How much history to pass to the local model. */
    historyMode: HistoryMode;
    /** Whether to persist the full conversation log. */
    logConversation: boolean;
    /** Whether to strip thinking tags from local model output. */
    stripThinkingTags: boolean;
    /** Preferred Copilot model family (e.g. 'gpt-4o', 'claude-sonnet-4'). */
    copilotModel: string | null;
    /** Named conversation profiles. */
    profiles: { [key: string]: AiConversationProfile };
    /** Conversation mode: 'ollama-copilot' (default) or 'ollama-ollama' (self-talk). */
    conversationMode: ConversationMode;
    /** Self-talk configuration for ollama-ollama mode. */
    selfTalk: {
        personA: SelfTalkPersona;
        personB: SelfTalkPersona;
    };
    /** Telegram integration config. */
    telegram: TelegramConfig;
    /** Whether tools are enabled for the orchestrator. */
    toolsEnabled: boolean;
    /** Temperature for trail summarization. */
    trailSummarizationTemperature: number;
    /** Remove prompt template from trail log. */
    removePromptTemplateFromTrail: boolean;
}

/** Conversation state for a running bot conversation. */
interface ConversationState {
    /** Unique conversation ID. */
    conversationId: string;
    /** The user's goal description. */
    goal: string;
    /** The user's optional description/context. */
    description: string;
    /** All exchanges so far. */
    exchanges: ConversationExchange[];
    /** Resolved config for this conversation. */
    config: AiConversationConfig;
    /** Profile key being used. */
    profileKey: string;
    /** Whether the conversation is still active. */
    active: boolean;
    /** Whether the conversation is currently halted (paused). */
    halted: boolean;
    /** Resolves the halt promise when continue is called. */
    haltResolver?: () => void;
    /** Queued additional user input (injected into the next prompt). */
    additionalUserInput: string[];
    /** Cancellation token source. */
    cancellationSource: vscode.CancellationTokenSource;
    /** Log file path. */
    logFilePath: string;
}

// ============================================================================
// Default templates
// ============================================================================

const DEFAULT_INITIAL_PROMPT_TEMPLATE = `You are an AI conversation orchestrator. Your job is to generate a detailed, actionable prompt that will be sent to GitHub Copilot (an AI coding assistant) to work toward a specific goal.

Goal: \${goal}
Description: \${description}

Context files:
\${fileContext}

Generate a clear, specific prompt for Copilot that will make progress toward the goal. The prompt should:
- Be detailed enough that Copilot can take concrete action
- Focus on the most important next step
- Reference specific files, patterns, or technologies when relevant
- Include any necessary constraints or requirements

Output ONLY the prompt text. No explanations, no preamble, no markdown fences.`;

const DEFAULT_FOLLOW_UP_TEMPLATE = `You are an AI conversation orchestrator evaluating progress toward a goal.

Goal: \${goal}
Description: \${description}

Turn \${turnNumber} of \${maxTurns}.

Previous prompt sent to Copilot:
---
\${lastPrompt}
---

Copilot's response:
---
\${copilotResponse}
---

\${historySection}

Evaluate whether the goal has been fully achieved based on Copilot's response and the conversation history.

If the goal is FULLY achieved, respond with exactly: \${goalReachedMarker}
If more work is needed, generate the next prompt for Copilot that builds on what was accomplished. Focus on what remains to be done.

Output ONLY either the goal-reached marker OR the next prompt text. No explanations, no preamble.`;

const DEFAULT_COPILOT_SUFFIX = `

---
IMPORTANT: Structure your response as valid JSON and write it to the file:
\${answerFilePath}

The file must be valid JSON with this structure:
{
  "requestId": "\${requestId}",
  "generatedMarkdown": "<your complete response as a JSON-escaped string>",
  "comments": "<optional comments or notes>",
  "references": ["<workspace-relative paths of files you referenced>"],
  "requestedAttachments": ["<workspace-relative paths of files you created or modified>"]
}

Request ID: \${requestId}`;

const DEFAULT_SUMMARY_TEMPLATE = `Summarize the following conversation history concisely, preserving key decisions, code changes, and outcomes. Keep it under \${maxTokens} tokens.

\${history}

Output ONLY the summary. No preamble.`;

const DEFAULT_GOAL_REACHED_MARKER = '__GOAL_REACHED__';

const DEFAULTS: AiConversationConfig = {
    maxTurns: 0,
    modelConfig: null,
    trailSummarizationModelConfig: null,
    temperature: 0,
    maxHistoryTokens: 0,
    conversationLogPath: WsPaths.aiRelative('trail') + '/ai_conversation',
    answerFolder: WsPaths.aiRelative('trail') + '/ai_conversation',
    initialPromptTemplate: DEFAULT_INITIAL_PROMPT_TEMPLATE,
    followUpTemplate: DEFAULT_FOLLOW_UP_TEMPLATE,
    copilotSuffix: DEFAULT_COPILOT_SUFFIX,
    summaryTemplate: DEFAULT_SUMMARY_TEMPLATE,
    goalReachedMarker: DEFAULT_GOAL_REACHED_MARKER,
    pauseBetweenTurns: false,
    pauseBeforeFirst: false,
    includeFileContext: [],
    historyMode: 'trim_and_summary',
    logConversation: true,
    stripThinkingTags: true,
    copilotModel: null,
    profiles: {},
    conversationMode: 'ollama-copilot',
    selfTalk: {
        personA: {
            systemPrompt: 'You are Person A in a collaborative discussion. Present your perspective clearly and build on the other person\'s ideas.',
        },
        personB: {
            systemPrompt: 'You are Person B in a collaborative discussion. Offer alternative viewpoints, ask probing questions, and synthesize ideas.',
        },
    },
    telegram: { ...TELEGRAM_DEFAULTS },
    toolsEnabled: true,
    trailSummarizationTemperature: 0.3,
    removePromptTemplateFromTrail: true,
};

// ============================================================================
// AiConversationManager
// ============================================================================

export class AiConversationManager {
    private context: vscode.ExtensionContext;
    private activeConversation: ConversationState | null = null;
    private telegramChannel: TelegramChannel | null = null;
    private telegram: TelegramNotifier | null = null;

    constructor(context: vscode.ExtensionContext) {
        this.context = context;
    }

    dispose(): void {
        this.stopConversation('Manager disposed');
        this.telegram?.dispose();
        this.telegramChannel?.dispose();
    }

    // -----------------------------------------------------------------------
    // Halt / Continue / Add Info — public API
    // -----------------------------------------------------------------------

    /** Halt the active conversation (pauses between turns). */
    haltConversation(reason?: string): boolean {
        if (!this.activeConversation?.active) { return false; }
        if (this.activeConversation.halted) { return false; } // Already halted
        this.activeConversation.halted = true;
        bridgeLog(`[Bot Conversation] Halted: ${reason ?? 'user requested'}`);
        this.telegram?.notifyHalted(this.activeConversation.exchanges.length);
        return true;
    }

    /** Continue a halted conversation. */
    continueConversation(): boolean {
        if (!this.activeConversation?.active || !this.activeConversation.halted) { return false; }
        this.activeConversation.halted = false;
        if (this.activeConversation.haltResolver) {
            this.activeConversation.haltResolver();
            this.activeConversation.haltResolver = undefined;
        }
        const hasInput = this.activeConversation.additionalUserInput.length > 0;
        bridgeLog(`[Bot Conversation] Continued${hasInput ? ' (with additional input)' : ''}`);
        this.telegram?.notifyContinued(hasInput ? 'yes' : undefined);
        return true;
    }

    /** Add additional user input to the next prompt. */
    addUserInput(text: string): boolean {
        if (!this.activeConversation?.active) { return false; }
        this.activeConversation.additionalUserInput.push(text);
        bridgeLog(`[Bot Conversation] User input added (${text.length} chars): ${text.substring(0, 60)}...`);
        return true;
    }

    /** Whether the conversation is currently halted. */
    get isHalted(): boolean {
        return this.activeConversation?.halted === true;
    }

    /** Drain additional user input and return combined string (empty string if none). */
    private drainUserInput(state: ConversationState): string {
        if (state.additionalUserInput.length === 0) { return ''; }
        const combined = state.additionalUserInput.join('\n\n');
        state.additionalUserInput = [];
        return combined;
    }

    /** Wait for the conversation to be unhalted. Returns immediately if not halted. */
    private async waitForContinue(state: ConversationState): Promise<void> {
        if (!state.halted) { return; }
        bridgeLog('[Bot Conversation] Waiting for continue signal...');
        return new Promise<void>((resolve) => {
            if (!state.halted) { resolve(); return; }
            state.haltResolver = resolve;
            // Also resolve if cancelled
            state.cancellationSource.token.onCancellationRequested(() => resolve());
        });
    }

    // -----------------------------------------------------------------------
    // Telegram integration
    // -----------------------------------------------------------------------

    /** Set up Telegram notifier from config. */
    private setupTelegram(config: AiConversationConfig): void {
        if (this.telegram) {
            this.telegram.dispose();
            this.telegram = null;
        }
        if (this.telegramChannel) {
            this.telegramChannel.dispose();
            this.telegramChannel = null;
        }
        if (!config.telegram.enabled) { return; }

        this.telegramChannel = new TelegramChannel(config.telegram);
        this.telegram = new TelegramNotifier(this.telegramChannel, config.telegram);
        this.telegram.onCommand((cmd: TelegramCommand) => this.handleTelegramCommand(cmd));
        this.telegram.startPolling();
    }

    /** Handle an incoming Telegram command. */
    private handleTelegramCommand(cmd: TelegramCommand): void {
        switch (cmd.type) {
            case 'stop':
                if (this.activeConversation?.active) {
                    this.stopConversation(`Stopped via Telegram by @${cmd.username}`);
                    this.telegram?.sendMessage('✅ Conversation stopped.');
                } else {
                    this.telegram?.sendMessage('ℹ️ No active conversation.');
                }
                break;
            case 'halt':
                if (this.haltConversation(`Halted via Telegram by @${cmd.username}`)) {
                    // notifyHalted already called in haltConversation
                } else {
                    this.telegram?.sendMessage('ℹ️ No active conversation to halt (or already halted).');
                }
                break;
            case 'continue':
                if (this.continueConversation()) {
                    // notifyContinued already called in continueConversation
                } else {
                    this.telegram?.sendMessage('ℹ️ Conversation is not halted.');
                }
                break;
            case 'info':
                if (this.addUserInput(cmd.text)) {
                    this.telegram?.sendMessage(`📝 Added to next prompt (${cmd.text.length} chars).`);
                } else {
                    this.telegram?.sendMessage('ℹ️ No active conversation to add input to.');
                }
                break;
            case 'status': {
                if (!this.activeConversation) {
                    this.telegram?.sendMessage('ℹ️ No active conversation.');
                } else {
                    const s = this.activeConversation;
                    const status = s.halted ? '⏸ Halted' : s.active ? '▶️ Running' : '⏹ Finished';
                    this.telegram?.sendMessage(
                        `*Status:* ${status}\n` +
                        `*Turns:* ${s.exchanges.length}/${s.config.maxTurns}\n` +
                        `*Goal:* ${s.goal.substring(0, 100)}`,
                    );
                }
                break;
            }
            case 'unknown':
                this.telegram?.sendMessage('❓ Unknown command. Use /stop /halt /continue /status or /info <text>');
                break;
        }
    }

    // -----------------------------------------------------------------------
    // Config loading — always fresh
    // -----------------------------------------------------------------------

    private getConfigPath(): string | undefined {
        return getConfigPath();
    }

    loadConfig(): AiConversationConfig {
        const config: AiConversationConfig = { ...DEFAULTS, profiles: {} };

        const configPath = this.getConfigPath();
        if (!configPath || !fs.existsSync(configPath)) { return config; }

        try {
            const raw = fs.readFileSync(configPath, 'utf-8');
            const parsed = JSON.parse(raw);
            const sec = parsed?.aiConversation;
            if (!sec || typeof sec !== 'object') { return config; }

            // Scalars
            if (typeof sec.initialPromptTemplate === 'string') { config.initialPromptTemplate = sec.initialPromptTemplate; }
            if (typeof sec.followUpTemplate === 'string') { config.followUpTemplate = sec.followUpTemplate; }
            if (typeof sec.copilotSuffix === 'string') { config.copilotSuffix = sec.copilotSuffix; }
            if (typeof sec.summaryTemplate === 'string') { config.summaryTemplate = sec.summaryTemplate; }
            if (typeof sec.goalReachedMarker === 'string') { config.goalReachedMarker = sec.goalReachedMarker; }
            if (typeof sec.pauseBeforeFirst === 'boolean') { config.pauseBeforeFirst = sec.pauseBeforeFirst; }
            if (typeof sec.logConversation === 'boolean') { config.logConversation = sec.logConversation; }
            if (typeof sec.stripThinkingTags === 'boolean') { config.stripThinkingTags = sec.stripThinkingTags; }
            if (typeof sec.copilotModel === 'string') { config.copilotModel = sec.copilotModel; }
            if (Array.isArray(sec.includeFileContext)) {
                config.includeFileContext = sec.includeFileContext.filter((f: any) => typeof f === 'string');
            }

            // Profiles
            if (sec.profiles && typeof sec.profiles === 'object') {
                for (const [key, val] of Object.entries(sec.profiles)) {
                    const p = val as any;
                    if (p && typeof p === 'object') {
                        config.profiles[key] = {
                            label: typeof p.label === 'string' ? p.label : key,
                            initialPromptTemplate: typeof p.initialPromptTemplate === 'string' ? p.initialPromptTemplate : null,
                            followUpTemplate: typeof p.followUpTemplate === 'string' ? p.followUpTemplate : null,
                            copilotSuffix: typeof p.copilotSuffix === 'string' ? p.copilotSuffix : null,
                            maxTurns: typeof p.maxTurns === 'number' ? p.maxTurns : null,
                            modelConfig: typeof p.modelConfig === 'string' ? p.modelConfig : null,
                            temperature: typeof p.temperature === 'number' ? p.temperature : null,
                            historyMode: typeof p.historyMode === 'string' ? p.historyMode as HistoryMode : null,
                            includeFileContext: Array.isArray(p.includeFileContext) ? p.includeFileContext : undefined,
                            goalReachedMarker: typeof p.goalReachedMarker === 'string' ? p.goalReachedMarker : null,
                            selfTalk: p.selfTalk && typeof p.selfTalk === 'object' ? {
                                personA: p.selfTalk.personA && typeof p.selfTalk.personA === 'object' ? {
                                    actor: typeof p.selfTalk.personA.actor === 'string' ? p.selfTalk.personA.actor : undefined,
                                    systemPrompt: typeof p.selfTalk.personA.systemPrompt === 'string' ? p.selfTalk.personA.systemPrompt : '',
                                    modelConfig: typeof p.selfTalk.personA.modelConfig === 'string' ? p.selfTalk.personA.modelConfig : null,
                                    temperature: typeof p.selfTalk.personA.temperature === 'number' ? p.selfTalk.personA.temperature : undefined,
                                } : undefined,
                                personB: p.selfTalk.personB && typeof p.selfTalk.personB === 'object' ? {
                                    actor: typeof p.selfTalk.personB.actor === 'string' ? p.selfTalk.personB.actor : undefined,
                                    systemPrompt: typeof p.selfTalk.personB.systemPrompt === 'string' ? p.selfTalk.personB.systemPrompt : '',
                                    modelConfig: typeof p.selfTalk.personB.modelConfig === 'string' ? p.selfTalk.personB.modelConfig : null,
                                    temperature: typeof p.selfTalk.personB.temperature === 'number' ? p.selfTalk.personB.temperature : undefined,
                                } : undefined,
                            } : undefined,
                        };
                    }
                }
            }

            // Conversation mode
            if (typeof sec.conversationMode === 'string' &&
                ['ollama-copilot', 'ollama-ollama'].includes(sec.conversationMode)) {
                config.conversationMode = sec.conversationMode as ConversationMode;
            }

            // Telegram config
            if (sec.telegram && typeof sec.telegram === 'object') {
                config.telegram = parseTelegramConfig(sec.telegram);
            }
        } catch (err) {
            bridgeLog(`[Bot Conversation] Failed to parse config: ${err}`);
        }

        return config;
    }

    private findLlmConfiguration(configId: string | null | undefined): any | undefined {
        if (!configId) { return undefined; }
        const cfg = loadSendToChatConfig();
        const llmConfigs = Array.isArray(cfg?.localLlm?.configurations) ? cfg!.localLlm!.configurations : [];
        return llmConfigs.find((entry: any) => entry?.id === configId);
    }

    private applyLlmRuntimeDefaults(config: AiConversationConfig, llmConfigId: string | null | undefined): void {
        const llm = this.findLlmConfiguration(llmConfigId);
        if (!llm) { return; }

        if (typeof llm.temperature === 'number') { config.temperature = llm.temperature; }
        if (typeof llm.trailMaximumTokens === 'number') { config.maxHistoryTokens = llm.trailMaximumTokens; }
        if (typeof llm.removePromptTemplateFromTrail === 'boolean') { config.removePromptTemplateFromTrail = llm.removePromptTemplateFromTrail; }
        if (typeof llm.historyMode === 'string' && ['full', 'last', 'summary', 'trim_and_summary'].includes(llm.historyMode)) {
            config.historyMode = llm.historyMode as HistoryMode;
        }
        if (typeof llm.logFolder === 'string' && llm.logFolder.trim().length > 0) {
            config.conversationLogPath = llm.logFolder;
        }
        if (typeof llm.answerFolder === 'string' && llm.answerFolder.trim().length > 0) {
            config.answerFolder = llm.answerFolder;
        }
    }

    private applyLlmSummaryDefaults(config: AiConversationConfig, llmConfigId: string | null | undefined): void {
        const llm = this.findLlmConfiguration(llmConfigId);
        if (!llm) { return; }

        if (typeof llm.trailSummarizationTemperature === 'number') {
            config.trailSummarizationTemperature = llm.trailSummarizationTemperature;
        }
        if (typeof llm.trailSummarizationPrompt === 'string' && llm.trailSummarizationPrompt.trim().length > 0) {
            config.summaryTemplate = llm.trailSummarizationPrompt;
        }
    }

    private resolveSetupOrThrow(setupId?: string): any {
        const sendConfig = loadSendToChatConfig();
        const strictErrors = validateStrictAiConfiguration(sendConfig);
        if (strictErrors.length > 0) {
            const msg = `Invalid AI configuration:\n- ${strictErrors.join('\n- ')}`;
            bridgeLog(`[Bot Conversation] ${msg}`);
            throw new Error('Invalid AI configuration. Open Status Page for details.');
        }

        const setups = Array.isArray(sendConfig?.aiConversation?.setups) ? sendConfig!.aiConversation!.setups : [];
        if (setups.length === 0) {
            throw new Error('No AI conversation setup found. Configure setups first.');
        }

        if (setupId) {
            const selected = setups.find((s: any) => s?.id === setupId);
            if (!selected) {
                throw new Error(`AI conversation setup not found: ${setupId}`);
            }
            return selected;
        }

        if (setups.length === 1) {
            return setups[0];
        }

        throw new Error('Missing required AI setup id. Select an AI conversation setup explicitly.');
    }

    // -----------------------------------------------------------------------
    // Window-unique file naming
    // -----------------------------------------------------------------------

    /** Get a short window identifier: first 8 chars of sessionId + first 8 of machineId. */
    private getWindowId(): string {
        const session = vscode.env.sessionId.substring(0, 8);
        const machine = vscode.env.machineId.substring(0, 8);
        return `${session}_${machine}`;
    }

    /** Generate a conversation ID: timestamp + window ID. */
    private generateConversationId(): string {
        const now = new Date();
        const ts = `${now.getFullYear()}${String(now.getMonth() + 1).padStart(2, '0')}${String(now.getDate()).padStart(2, '0')}_${String(now.getHours()).padStart(2, '0')}${String(now.getMinutes()).padStart(2, '0')}${String(now.getSeconds()).padStart(2, '0')}`;
        return `bot_${ts}_${this.getWindowId()}`;
    }

    // -----------------------------------------------------------------------
    // Answer file (JSON) — consistent with dcli pattern
    // -----------------------------------------------------------------------

    /** Get the answer file path for the current window. */
    private getAnswerFilePath(): string {
        const activeAnswerFolder = this.activeConversation?.config.answerFolder;
        const wsRoot = getWorkspaceRoot();
        const folder = wsRoot
            ? path.join(wsRoot, (activeAnswerFolder && activeAnswerFolder.trim().length > 0)
                ? activeAnswerFolder
                : (WsPaths.ai('trail', 'ai_conversation') || path.join('_ai', 'trail', 'ai_conversation')))
            : WsPaths.home('aiConversationAnswers');
        return path.join(folder, `${this.getWindowId()}_answer.json`);
    }

    /** Delete the answer file (before sending a new prompt). */
    private deleteAnswerFile(): void {
        const filePath = this.getAnswerFilePath();
        const dir = path.dirname(filePath);
        if (!fs.existsSync(dir)) {
            fs.mkdirSync(dir, { recursive: true });
        }
        if (fs.existsSync(filePath)) {
            fs.unlinkSync(filePath);
        }
    }

    /** Read and parse the answer file. Returns undefined if not found/invalid. */
    private readAnswerFile(expectedRequestId: string): CopilotResponse | undefined {
        const filePath = this.getAnswerFilePath();
        if (!fs.existsSync(filePath)) { return undefined; }

        try {
            const raw = fs.readFileSync(filePath, 'utf-8').trim();
            if (!raw) { return undefined; }

            const parsed = JSON.parse(raw);
            if (parsed.requestId !== expectedRequestId) { return undefined; }
            if (!parsed.generatedMarkdown) { return undefined; }

            return {
                requestId: parsed.requestId,
                generatedMarkdown: parsed.generatedMarkdown,
                comments: parsed.comments ?? undefined,
                references: Array.isArray(parsed.references) ? parsed.references : [],
                requestedAttachments: Array.isArray(parsed.requestedAttachments) ? parsed.requestedAttachments : [],
            };
        } catch {
            return undefined;
        }
    }

    /** Watch for the answer file to appear/change. */
    private async waitForAnswerFile(
        requestId: string,
        timeoutMs: number,
        cancellationToken: vscode.CancellationToken,
    ): Promise<CopilotResponse | undefined> {
        const answerPath = this.getAnswerFilePath();
        const dir = path.dirname(answerPath);

        return new Promise<CopilotResponse | undefined>((resolve) => {
            let resolved = false;
            const finish = (result: CopilotResponse | undefined) => {
                if (resolved) { return; }
                resolved = true;
                watcher?.close();
                clearTimeout(timer);
                clearInterval(pollTimer);
                resolve(result);
            };

            // Timeout
            const timer = setTimeout(() => finish(undefined), timeoutMs);

            // Cancellation
            cancellationToken.onCancellationRequested(() => finish(undefined));

            // File watcher
            let watcher: fs.FSWatcher | undefined;
            try {
                if (!fs.existsSync(dir)) {
                    fs.mkdirSync(dir, { recursive: true });
                }
                watcher = fs.watch(dir, (_event, filename) => {
                    if (filename === path.basename(answerPath)) {
                        // Small delay to let the file finish writing
                        setTimeout(() => {
                            const result = this.readAnswerFile(requestId);
                            if (result) { finish(result); }
                        }, 500);
                    }
                });
            } catch {
                // Fallback to polling only
            }

            // Also poll every 5s as backup
            const pollTimer = setInterval(() => {
                const result = this.readAnswerFile(requestId);
                if (result) { finish(result); }
            }, 5000);
        });
    }

    // -----------------------------------------------------------------------
    // History management
    // -----------------------------------------------------------------------

    /** Build the history section for the follow-up template. */
    private async buildHistorySection(
        exchanges: ConversationExchange[],
        config: AiConversationConfig,
    ): Promise<string> {
        if (exchanges.length === 0) { return '(No previous exchanges.)'; }

        const mode = config.historyMode;

        if (mode === 'last') {
            const last = exchanges[exchanges.length - 1];
            return `Previous exchange (turn ${last.turn}):\nPrompt: ${last.promptToCopilot.substring(0, 500)}...\nResponse: ${last.copilotResponse.generatedMarkdown.substring(0, 1000)}...`;
        }

        const fullHistory = this.formatFullHistory(exchanges);

        if (mode === 'full') {
            return `Full conversation history:\n${fullHistory}`;
        }

        // For 'summary' and 'trim_and_summary', estimate tokens
        const estimatedTokens = Math.ceil(fullHistory.length / 4); // rough estimate

        if (mode === 'summary' || (mode === 'trim_and_summary' && estimatedTokens > config.maxHistoryTokens)) {
            // Summarize using the local model
            const summary = await this.summarizeHistory(fullHistory, config);

            if (mode === 'trim_and_summary') {
                // After summary, include the last 1-2 exchanges in full for recency
                const recentCount = Math.min(2, exchanges.length);
                const recentExchanges = exchanges.slice(-recentCount);
                const recentHistory = this.formatFullHistory(recentExchanges);
                return `Conversation summary (turns 1-${exchanges.length - recentCount}):\n${summary}\n\nRecent exchanges:\n${recentHistory}`;
            }

            return `Conversation summary:\n${summary}`;
        }

        // trim_and_summary but within token limits — use full history
        return `Full conversation history:\n${fullHistory}`;
    }

    /** Format all exchanges as markdown. */
    private formatFullHistory(exchanges: ConversationExchange[]): string {
        return exchanges.map((ex) => {
            const refs = ex.copilotResponse.references.length > 0
                ? `\nReferences: ${ex.copilotResponse.references.join(', ')}`
                : '';
            return `### Turn ${ex.turn}\n**Prompt:**\n${ex.promptToCopilot}\n\n**Copilot Response:**\n${ex.copilotResponse.generatedMarkdown}${refs}`;
        }).join('\n\n---\n\n');
    }

    /** Use the local model to summarize conversation history. */
    private async summarizeHistory(
        fullHistory: string,
        config: AiConversationConfig,
    ): Promise<string> {
        const manager = getLocalLlmManager();
        if (!manager) { return fullHistory; } // fallback to full if no manager

        const prompt = this.resolvePlaceholders(config.summaryTemplate, {
            maxTokens: String(config.maxHistoryTokens),
            history: fullHistory,
        });

        try {
            const summaryModelConfig = config.trailSummarizationModelConfig;
            if (!summaryModelConfig) {
                bridgeLog('[Bot Conversation] Missing trailSummarizationModelConfig; returning full history without summarization.');
                return fullHistory;
            }
            const result = await manager.chatWithOllama({
                systemPrompt: 'You are a conversation summarizer. Be concise and preserve key technical details.',
                userPrompt: prompt,
                modelConfigKey: summaryModelConfig,
                temperature: config.trailSummarizationTemperature,
                stripThinkingTags: config.stripThinkingTags,
                trailType: 'conversation',
            });
            return result.text;
        } catch (err: any) {
            bridgeLog(`[Bot Conversation] Summarization failed: ${err.message}`);
            // Trim to approximate token count by characters
            const maxChars = config.maxHistoryTokens * 4;
            if (fullHistory.length > maxChars) {
                return fullHistory.substring(fullHistory.length - maxChars) + '\n...(earlier history trimmed)';
            }
            return fullHistory;
        }
    }

    // -----------------------------------------------------------------------
    // File context
    // -----------------------------------------------------------------------

    /** Read and concatenate context files. */
    private readFileContext(filePaths: string[]): string {
        if (filePaths.length === 0) { return '(No additional context files.)'; }

        return filePaths.map((fp) => {
            const resolved = resolvePathVariables(fp, { silent: true }) ?? fp;
            try {
                if (fs.existsSync(resolved)) {
                    const content = fs.readFileSync(resolved, 'utf-8');
                    return `--- ${fp} ---\n${content}`;
                }
                return `--- ${fp} --- (file not found)`;
            } catch {
                return `--- ${fp} --- (read error)`;
            }
        }).join('\n\n');
    }

    // -----------------------------------------------------------------------
    // Placeholder resolution
    // -----------------------------------------------------------------------

    private resolvePlaceholders(template: string, values: { [key: string]: string }): string {
        return resolveTemplate(template, values);
    }

    // -----------------------------------------------------------------------
    // Conversation log
    // -----------------------------------------------------------------------

    /** Write or update the conversation log file. */
    private writeConversationLog(state: ConversationState): void {
        if (!state.config.logConversation) { return; }

        const wsRoot = getWorkspaceRoot();
        const logDir = wsRoot
            ? path.join(wsRoot, state.config.conversationLogPath)
            : WsPaths.home('aiConversations');

        if (!fs.existsSync(logDir)) {
            fs.mkdirSync(logDir, { recursive: true });
        }

        const logPath = path.join(logDir, `${state.conversationId}.md`);
        state.logFilePath = logPath;

        const lines: string[] = [];
        lines.push(`# Bot Conversation: ${state.conversationId}`);
        lines.push('');
        lines.push(`**Goal:** ${state.goal}`);
        if (state.description) {
            lines.push(`**Description:** ${state.description}`);
        }
        lines.push(`**Profile:** ${state.profileKey}`);
        lines.push(`**Max turns:** ${state.config.maxTurns}`);
        lines.push(`**Status:** ${state.active ? 'In progress' : 'Completed'}`);
        lines.push(`**Turns completed:** ${state.exchanges.length}`);
        lines.push('');

        for (const ex of state.exchanges) {
            lines.push(`## Turn ${ex.turn}`);
            lines.push(`*${ex.timestamp.toISOString()}*`);
            if (ex.localModelStats) {
                lines.push(`*Local model: ${ex.localModelStats.promptTokens}+${ex.localModelStats.completionTokens} tokens, ${(ex.localModelStats.totalDurationMs / 1000).toFixed(1)}s*`);
            }
            lines.push('');
            lines.push('### Prompt to Copilot');
            lines.push('');
            lines.push(ex.promptToCopilot);
            lines.push('');
            lines.push('### Copilot Response');
            lines.push('');
            lines.push(ex.copilotResponse.generatedMarkdown);
            if (ex.copilotResponse.comments) {
                lines.push('');
                lines.push(`**Comments:** ${ex.copilotResponse.comments}`);
            }
            if (ex.copilotResponse.references.length > 0) {
                lines.push('');
                lines.push(`**References:** ${ex.copilotResponse.references.join(', ')}`);
            }
            if (ex.copilotResponse.requestedAttachments.length > 0) {
                lines.push('');
                lines.push(`**Attachments:** ${ex.copilotResponse.requestedAttachments.join(', ')}`);
            }
            lines.push('');
            lines.push('---');
            lines.push('');
        }

        fs.writeFileSync(logPath, lines.join('\n'), 'utf-8');

        const workspaceName = this.getWorkspaceName();
        const compactPath = path.join(logDir, `${workspaceName}.trail.md`);
        const compactLines: string[] = ['# AI Conversation Trail', '', 'Compact conversation history for AI Conversation panel.', ''];

        // Do not wipe compact history when a run ends before any turn completes.
        if (state.exchanges.length === 0) {
            if (!fs.existsSync(compactPath)) {
                fs.writeFileSync(compactPath, compactLines.join('\n'), 'utf-8');
            }
            return;
        }

        for (const ex of state.exchanges) {
            const ts = ex.timestamp.toISOString();
            const fileTs = this.toTrailTimestamp(ex.timestamp);
            const requestId = ex.copilotResponse.requestId || `${state.conversationId}_${ex.turn}`;

            compactLines.push(`## ${ts}`);
            compactLines.push('');
            compactLines.push('### Prompt');
            compactLines.push('');
            compactLines.push(ex.promptToCopilot);
            compactLines.push('');
            compactLines.push('### Response');
            compactLines.push('');
            compactLines.push(ex.copilotResponse.generatedMarkdown);
            compactLines.push('');
            compactLines.push('---');
            compactLines.push('');

            const promptFile = path.join(logDir, `${fileTs}_prompt_${requestId}.userprompt.md`);
            const answerFile = path.join(logDir, `${fileTs}_answer_${requestId}.answer.json`);
            fs.writeFileSync(promptFile, ex.promptToCopilot, 'utf-8');
            fs.writeFileSync(answerFile, JSON.stringify(ex.copilotResponse, null, 2), 'utf-8');
        }
        fs.writeFileSync(compactPath, compactLines.join('\n'), 'utf-8');
    }

    private getWorkspaceName(): string {
        const workspaceFile = vscode.workspace.workspaceFile;
        if (workspaceFile && workspaceFile.fsPath.endsWith('.code-workspace')) {
            return path.basename(workspaceFile.fsPath).replace('.code-workspace', '');
        }
        return 'default';
    }

    private toTrailTimestamp(d: Date): string {
        const date = `${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, '0')}${String(d.getDate()).padStart(2, '0')}`;
        const time = `${String(d.getHours()).padStart(2, '0')}${String(d.getMinutes()).padStart(2, '0')}${String(d.getSeconds()).padStart(2, '0')}${String(d.getMilliseconds()).padStart(3, '0')}`;
        return `${date}_${time}`;
    }

    private updateWindowConversationState(isActive: boolean): void {
        try {
            writeWindowConversationState(
                this.getWindowId(),
                this.getWorkspaceName(),
                WsPaths.getWorkspaceQuestId(),
                isActive,
            );
        } catch (error) {
            bridgeLog(`[Bot Conversation] Failed to update window conversation state: ${error}`);
        }
    }

    // -----------------------------------------------------------------------
    // Core conversation loop
    // -----------------------------------------------------------------------

    /**
     * Start a bot conversation.
     * This is the main entry point triggered by the command.
     */
    async startConversationCommand(): Promise<void> {
        // Check if a conversation is already active
        if (this.activeConversation?.active) {
            const action = await vscode.window.showWarningMessage(
                'A bot conversation is already in progress. Stop it and start a new one?',
                'Stop & Start New', 'Cancel',
            );
            if (action !== 'Stop & Start New') { return; }
            this.stopConversation('Replaced by new conversation');
        }

        const manager = getLocalLlmManager();
        if (!manager) {
            vscode.window.showErrorMessage('Prompt Expander not initialized. Cannot use local LLM.');
            return;
        }

        const config = this.loadConfig();

        const sendConfig = loadSendToChatConfig();
        const strictErrors = validateStrictAiConfiguration(sendConfig);
        if (strictErrors.length > 0) {
            const msg = `Invalid AI configuration:\n- ${strictErrors.join('\n- ')}`;
            bridgeLog(`[Bot Conversation] ${msg}`);
            vscode.window.showErrorMessage('Invalid AI configuration. Open Status Page for details.');
            return;
        }

        const setupList = Array.isArray(sendConfig?.aiConversation?.setups) ? sendConfig!.aiConversation!.setups : [];
        if (setupList.length === 0) {
            const msg = 'No AI conversation setup found. Configure setups first.';
            bridgeLog(`[Bot Conversation] ${msg}`);
            vscode.window.showErrorMessage(msg);
            return;
        }

        const setupPick = await vscode.window.showQuickPick(
            setupList.map((s: any) => ({
                label: s?.name || s?.id || '(unnamed setup)',
                description: s?.id || '',
                setup: s,
            })),
            { placeHolder: 'Select AI conversation setup' },
        );
        if (!setupPick) { return; }
        const selectedSetup = setupPick.setup;

        config.modelConfig = selectedSetup.llmConfigA;
        config.trailSummarizationModelConfig = selectedSetup.trailSummarizationLlmConfig;
        config.maxTurns = selectedSetup.maxTurns;
        config.historyMode = selectedSetup.historyMode;
        config.pauseBetweenTurns = selectedSetup.pauseBetweenTurns === true;
        config.conversationMode = selectedSetup.llmConfigB && selectedSetup.llmConfigB !== 'copilot'
            ? 'ollama-ollama'
            : 'ollama-copilot';
        if (selectedSetup.llmConfigA) {
            config.selfTalk.personA.modelConfig = selectedSetup.llmConfigA;
        }
        if (selectedSetup.llmConfigB && selectedSetup.llmConfigB !== 'copilot') {
            config.selfTalk.personB.modelConfig = selectedSetup.llmConfigB;
        }

        this.applyLlmRuntimeDefaults(config, config.modelConfig);
        this.applyLlmSummaryDefaults(config, config.trailSummarizationModelConfig);

        // If there are profiles, let the user pick
        let profileKey = '_default';
        const profileKeys = Object.keys(config.profiles);
        if (profileKeys.length > 0) {
            const items = profileKeys.map((key) => ({
                label: config.profiles[key].label,
                description: key,
                key,
            }));
            items.unshift({ label: 'Default (no profile)', description: 'Use top-level config', key: '_default' });
            const picked = await vscode.window.showQuickPick(items, {
                placeHolder: 'Select conversation profile',
            });
            if (!picked) { return; }
            profileKey = picked.key;
        }

        // Apply profile overrides
        const profile = profileKey !== '_default' ? config.profiles[profileKey] : undefined;
        if (profile) {
            if (profile.maxTurns !== null && profile.maxTurns !== undefined) { config.maxTurns = profile.maxTurns; }
            if (profile.modelConfig !== null && profile.modelConfig !== undefined) { config.modelConfig = profile.modelConfig; }
            if (profile.temperature !== null && profile.temperature !== undefined) { config.temperature = profile.temperature; }
            if (profile.historyMode !== null && profile.historyMode !== undefined) { config.historyMode = profile.historyMode; }
            if (profile.initialPromptTemplate) { config.initialPromptTemplate = profile.initialPromptTemplate; }
            if (profile.followUpTemplate) { config.followUpTemplate = profile.followUpTemplate; }
            if (profile.copilotSuffix) { config.copilotSuffix = profile.copilotSuffix; }
            if (profile.goalReachedMarker) { config.goalReachedMarker = profile.goalReachedMarker; }
            if (profile.includeFileContext) { config.includeFileContext = profile.includeFileContext; }
            if (profile.selfTalk?.personA) {
                config.selfTalk.personA = { ...config.selfTalk.personA, ...profile.selfTalk.personA };
            }
            if (profile.selfTalk?.personB) {
                config.selfTalk.personB = { ...config.selfTalk.personB, ...profile.selfTalk.personB };
            }
        }

        // Get goal from user — check if there's selected text in the editor first
        const editor = vscode.window.activeTextEditor;
        const selectedText = editor && !editor.selection.isEmpty
            ? editor.document.getText(editor.selection)
            : undefined;

        const goal = await vscode.window.showInputBox({
            prompt: 'Enter the conversation goal',
            placeHolder: 'What should the bot conversation achieve?',
            value: selectedText ?? '',
        });
        if (!goal?.trim()) { return; }

        const description = await vscode.window.showInputBox({
            prompt: 'Optional: Add context or constraints (press Enter to skip)',
            placeHolder: 'Additional description, constraints, file references...',
        });

        // Create conversation state
        const conversationId = this.generateConversationId();
        const cancellationSource = new vscode.CancellationTokenSource();
        const state: ConversationState = {
            conversationId,
            goal: goal.trim(),
            description: description?.trim() ?? '',
            exchanges: [],
            config,
            profileKey,
            active: true,
            halted: false,
            additionalUserInput: [],
            cancellationSource,
            logFilePath: '',
        };
        this.activeConversation = state;
        this.updateWindowConversationState(true);

        bridgeLog(`[Bot Conversation] Starting: ${conversationId} | Goal: ${goal.trim().substring(0, 80)}...`);

        // Set up Telegram integration (if enabled)
        this.setupTelegram(config);
        this.telegram?.notifyStart(conversationId, goal.trim(), profileKey);

        try {
            await this.runConversationLoop(state, manager);
        } catch (err: any) {
            if (err.message === 'Cancelled') {
                bridgeLog(`[Bot Conversation] Cancelled by user at turn ${state.exchanges.length}`);
                vscode.window.showInformationMessage(
                    `Bot conversation cancelled after ${state.exchanges.length} turns.`,
                );
            } else {
                bridgeLog(`[Bot Conversation] Error: ${err.message}`);
                vscode.window.showErrorMessage(`Bot conversation error: ${err.message}`);
            }
        } finally {
            state.active = false;
            this.writeConversationLog(state);
            this.updateWindowConversationState(false);

            if (state.logFilePath && fs.existsSync(state.logFilePath)) {
                const action = await vscode.window.showInformationMessage(
                    `Bot conversation completed (${state.exchanges.length} turns).`,
                    'Open Log',
                );
                if (action === 'Open Log') {
                    const doc = await vscode.workspace.openTextDocument(state.logFilePath);
                    await vscode.window.showTextDocument(doc);
                }
            }

            if (this.activeConversation === state) {
                this.activeConversation = null;
            }
            // Clean up Telegram polling
            if (this.telegram) {
                this.telegram.stopPolling();
            }
            cancellationSource.dispose();
        }
    }

    /** The main conversation loop. */
    private async runConversationLoop(
        state: ConversationState,
        manager: ReturnType<typeof getLocalLlmManager> & object,
    ): Promise<void> {
        const { config } = state;

        // Load trail config for new conversation session
        loadTrailConfig();

        // Branch: self-talk mode runs an entirely different loop
        if (config.conversationMode === 'ollama-ollama') {
            return this.runSelfTalkLoop(state, manager);
        }

        const token = state.cancellationSource.token;

        // Ensure Copilot model is available
        const copilotModel = await getCopilotModel();
        if (!copilotModel) {
            throw new Error('No Copilot model available');
        }

        // Read file context once
        const fileContext = this.readFileContext(config.includeFileContext);

        for (let turn = 1; turn <= config.maxTurns; turn++) {
            if (token.isCancellationRequested) { throw new Error('Cancelled'); }

            // ------- Halt check -------
            await this.waitForContinue(state);
            if (token.isCancellationRequested) { throw new Error('Cancelled'); }

            // Drain any additional user input
            const additionalUserInfo = this.drainUserInput(state);

            const requestId = `${state.conversationId}_t${turn}`;

            // ------- Step 1: Generate Copilot prompt with local model -------
            let copilotPrompt: string;
            let localStats: OllamaStats | undefined;

            if (turn === 1) {
                // Initial prompt
                const templateValues: Record<string, string> = {
                    goal: state.goal,
                    description: state.description,
                    fileContext,
                    turnNumber: String(turn),
                    maxTurns: String(config.maxTurns),
                    goalReachedMarker: config.goalReachedMarker,
                    additionalUserInfo: additionalUserInfo
                        ? `\nAdditional user input:\n${additionalUserInfo}\n`
                        : '',
                };
                const prompt = this.resolvePlaceholders(config.initialPromptTemplate, templateValues);

                const genResult = await vscode.window.withProgress(
                    {
                        location: vscode.ProgressLocation.Notification,
                        title: `[Bot ${turn}/${config.maxTurns}] Generating initial prompt with ${manager.getResolvedModelName(config.modelConfig ?? undefined)}...`,
                        cancellable: true,
                    },
                    async (_progress, cancelToken) => {
                        state.cancellationSource.token.onCancellationRequested(() => { /* propagate */ });
                        return manager.chatWithOllama({
                            systemPrompt: 'You are a conversation orchestrator generating prompts for an AI assistant.',
                            userPrompt: prompt,
                            modelConfigKey: config.modelConfig ?? undefined,
                            temperature: config.temperature,
                            stripThinkingTags: config.stripThinkingTags,
                            cancellationToken: cancelToken,
                            trailType: 'conversation',
                        });
                    },
                );

                copilotPrompt = genResult.text.trim();
                localStats = genResult.stats;
            } else {
                // Follow-up prompt
                const lastExchange = state.exchanges[state.exchanges.length - 1];
                const historySection = await this.buildHistorySection(
                    state.exchanges.slice(0, -1), // everything except the last (which is in lastPrompt/copilotResponse)
                    config,
                );

                const templateValues: Record<string, string> = {
                    goal: state.goal,
                    description: state.description,
                    turnNumber: String(turn),
                    maxTurns: String(config.maxTurns),
                    lastPrompt: lastExchange.promptToCopilot,
                    copilotResponse: lastExchange.copilotResponse.generatedMarkdown,
                    historySection: historySection !== '(No previous exchanges.)' ? `Conversation history:\n${historySection}` : '',
                    fileContext,
                    goalReachedMarker: config.goalReachedMarker,
                    additionalUserInfo: additionalUserInfo
                        ? `\nAdditional user input:\n${additionalUserInfo}\n`
                        : '',
                };
                const prompt = this.resolvePlaceholders(config.followUpTemplate, templateValues);

                const genResult = await vscode.window.withProgress(
                    {
                        location: vscode.ProgressLocation.Notification,
                        title: `[Bot ${turn}/${config.maxTurns}] Evaluating progress with ${manager.getResolvedModelName(config.modelConfig ?? undefined)}...`,
                        cancellable: true,
                    },
                    async (_progress, cancelToken) => {
                        return manager.chatWithOllama({
                            systemPrompt: 'You are a conversation orchestrator evaluating AI assistant responses.',
                            userPrompt: prompt,
                            modelConfigKey: config.modelConfig ?? undefined,
                            temperature: config.temperature,
                            stripThinkingTags: config.stripThinkingTags,
                            cancellationToken: cancelToken,
                            trailType: 'conversation',
                        });
                    },
                );

                copilotPrompt = genResult.text.trim();
                localStats = genResult.stats;

                // Check if goal is reached
                if (copilotPrompt.includes(config.goalReachedMarker)) {
                    bridgeLog(`[Bot Conversation] Goal reached at turn ${turn}`);
                    vscode.window.showInformationMessage(
                        `Bot conversation: goal reached after ${state.exchanges.length} turns!`,
                    );
                    this.telegram?.notifyEnd(state.conversationId, state.exchanges.length, true);
                    return;
                }
            }

            // ------- Step 1b: Optional pause for user review -------
            if ((turn === 1 && config.pauseBeforeFirst) || (turn > 1 && config.pauseBetweenTurns)) {
                const action = await vscode.window.showInformationMessage(
                    `[Bot Turn ${turn}] Review prompt before sending to Copilot?`,
                    { modal: false },
                    'Send', 'Edit', 'Stop',
                );
                if (action === 'Stop') {
                    this.stopConversation('Stopped by user during review');
                    return;
                }
                if (action === 'Edit') {
                    const edited = await vscode.window.showInputBox({
                        prompt: `Edit prompt for turn ${turn}`,
                        value: copilotPrompt,
                    });
                    if (!edited) {
                        this.stopConversation('Cancelled during edit');
                        return;
                    }
                    copilotPrompt = edited;
                }
                // 'Send' or dialog dismissed → proceed
            }

            // ------- Step 2: Append suffix and send to Copilot -------
            const answerFilePath = this.getAnswerFilePath();
            const suffixValues = {
                answerFilePath,
                requestId,
            };
            const fullCopilotPrompt = copilotPrompt + this.resolvePlaceholders(config.copilotSuffix, suffixValues);

            // Delete old answer file
            this.deleteAnswerFile();

            // Trail: Log prompt being sent to Copilot
            logPrompt('conversation', 'copilot', fullCopilotPrompt, undefined, {
                turn,
                maxTurns: config.maxTurns,
                requestId,
                conversationId: state.conversationId,
                goal: state.goal,
            });

            // Send to Copilot via LM API
            const copilotResponseText = await vscode.window.withProgress(
                {
                    location: vscode.ProgressLocation.Notification,
                    title: `[Bot ${turn}/${config.maxTurns}] Waiting for Copilot response...`,
                    cancellable: true,
                },
                async (_progress, cancelToken) => {
                    return sendCopilotRequest(copilotModel, fullCopilotPrompt, cancelToken);
                },
            );

            // ------- Step 3: Parse response -------
            // First check if there's a JSON answer file (preferred)
            let copilotResponse: CopilotResponse;

            // Give the file watcher a moment
            await new Promise((r) => setTimeout(r, 1000));
            const fileResponse = this.readAnswerFile(requestId);

            if (fileResponse) {
                copilotResponse = fileResponse;
                // Trail: Log Copilot answer file response
                logCopilotAnswer(answerFilePath, fileResponse);
            } else {
                // Fallback: try to parse the streamed response as JSON
                copilotResponse = this.parseInlineResponse(copilotResponseText, requestId);
                // Trail: Log Copilot streamed response
                logResponse('conversation', 'copilot', copilotResponseText, true, {
                    source: 'streamed',
                    requestId,
                    turn,
                });
            }

            // ------- Step 4: Record exchange -------
            const exchange: ConversationExchange = {
                turn,
                timestamp: new Date(),
                promptToCopilot: copilotPrompt,
                copilotResponse,
                localModelStats: localStats,
            };
            state.exchanges.push(exchange);

            // Update log after each turn
            this.writeConversationLog(state);

            const statsStr = localStats
                ? ` | Local: ${localStats.promptTokens}+${localStats.completionTokens}t`
                : '';
            bridgeLog(`[Bot Conversation] Turn ${turn} complete | Response: ${copilotResponse.generatedMarkdown.length} chars${statsStr}`);

            // Telegram turn notification
            this.telegram?.notifyTurn(turn, config.maxTurns, copilotPrompt, copilotResponse.generatedMarkdown, localStats);
        }

        // Max turns reached
        bridgeLog(`[Bot Conversation] Max turns (${config.maxTurns}) reached`);
        vscode.window.showWarningMessage(
            `Bot conversation reached max turns (${config.maxTurns}) without achieving the goal.`,
        );
        this.telegram?.notifyEnd(state.conversationId, config.maxTurns, false, 'Max turns reached');
    }

    // -----------------------------------------------------------------------
    // Self-talk loop (ollama-ollama mode)
    // -----------------------------------------------------------------------

    /**
     * Run a self-talk conversation between two local model personas.
     *
     * Person A generates a message, then Person B responds, back and forth.
     * Both sides use the local Ollama model (potentially with different
     * system prompts, model configs, and temperatures).
     *
     * Exchanges are logged as if Person A's output is the "prompt to Copilot"
     * and Person B's output is the "Copilot response" — this lets us reuse
     * the existing log format.
     */
    private async runSelfTalkLoop(
        state: ConversationState,
        manager: ReturnType<typeof getLocalLlmManager> & object,
    ): Promise<void> {
        const { config } = state;
        const token = state.cancellationSource.token;
        const personA = config.selfTalk.personA;
        const personB = config.selfTalk.personB;

        // Read file context once
        const fileContext = this.readFileContext(config.includeFileContext);

        // Build initial context for Person A
        let lastMessage = '';

        for (let turn = 1; turn <= config.maxTurns; turn++) {
            if (token.isCancellationRequested) { throw new Error('Cancelled'); }

            // ------- Halt check -------
            await this.waitForContinue(state);
            if (token.isCancellationRequested) { throw new Error('Cancelled'); }

            // Drain any additional user input
            const additionalUserInfo = this.drainUserInput(state);

            // ------- Person A generates -------
            let personAPrompt: string;
            if (turn === 1) {
                personAPrompt = `Goal: ${state.goal}\n`;
                if (state.description) { personAPrompt += `Context: ${state.description}\n`; }
                if (fileContext) { personAPrompt += `\nFiles:\n${fileContext}\n`; }
                personAPrompt += '\nStart the discussion. Present your initial analysis or approach.';
            } else {
                personAPrompt = `Goal: ${state.goal}\n\n` +
                    `Person B said (turn ${turn - 1}):\n---\n${lastMessage}\n---\n\n`;
                if (additionalUserInfo) {
                    personAPrompt += `Additional input from the user:\n${additionalUserInfo}\n\n`;
                }
                personAPrompt += `Turn ${turn} of ${config.maxTurns}. Respond to Person B's points and advance the discussion.\n` +
                    `If the goal is fully achieved, include: ${config.goalReachedMarker}`;
            }

            const personAResult = await vscode.window.withProgress(
                {
                    location: vscode.ProgressLocation.Notification,
                    title: `[Self-Talk ${turn}/${config.maxTurns}] Person A thinking...`,
                    cancellable: true,
                },
                async (_progress, cancelToken) => {
                    return manager.chatWithOllama({
                        systemPrompt: personA.systemPrompt,
                        userPrompt: personAPrompt,
                        modelConfigKey: personA.modelConfig ?? config.modelConfig ?? undefined,
                        temperature: personA.temperature ?? config.temperature,
                        stripThinkingTags: config.stripThinkingTags,
                        cancellationToken: cancelToken,
                        trailType: 'conversation',
                    });
                },
            );

            const personAOutput = personAResult.text.trim();
            const personAStats = personAResult.stats;

            // Check goal reached in Person A's output
            if (personAOutput.includes(config.goalReachedMarker)) {
                bridgeLog(`[Bot Conversation] Self-talk goal reached by Person A at turn ${turn}`);
                // Still record this exchange with A's output
                state.exchanges.push({
                    turn,
                    timestamp: new Date(),
                    promptToCopilot: personAOutput,
                    copilotResponse: { requestId: `${state.conversationId}_t${turn}`, generatedMarkdown: '(Goal reached by Person A)', references: [], requestedAttachments: [] },
                    localModelStats: personAStats,
                });
                this.writeConversationLog(state);
                vscode.window.showInformationMessage(
                    `Self-talk: goal reached by Person A after ${turn} turns!`,
                );
                this.telegram?.notifyEnd(state.conversationId, turn, true);
                return;
            }

            // ------- Person B responds -------
            const personBPrompt = `Goal: ${state.goal}\n\n` +
                `Person A said (turn ${turn}):\n---\n${personAOutput}\n---\n\n` +
                (additionalUserInfo && turn === 1
                    ? `Additional input from the user:\n${additionalUserInfo}\n\n`
                    : '') +
                `Turn ${turn} of ${config.maxTurns}. Provide your perspective, challenge assumptions, or build on Person A's ideas.\n` +
                `If the goal is fully achieved, include: ${config.goalReachedMarker}`;

            const personBResult = await vscode.window.withProgress(
                {
                    location: vscode.ProgressLocation.Notification,
                    title: `[Self-Talk ${turn}/${config.maxTurns}] Person B responding...`,
                    cancellable: true,
                },
                async (_progress, cancelToken) => {
                    return manager.chatWithOllama({
                        systemPrompt: personB.systemPrompt,
                        userPrompt: personBPrompt,
                        modelConfigKey: personB.modelConfig ?? config.modelConfig ?? undefined,
                        temperature: personB.temperature ?? config.temperature,
                        stripThinkingTags: config.stripThinkingTags,
                        cancellationToken: cancelToken,
                        trailType: 'conversation',
                    });
                },
            );

            const personBOutput = personBResult.text.trim();
            lastMessage = personBOutput;

            // Record as exchange (A's output → "prompt", B's output → "response")
            const combinedStats: OllamaStats = {
                promptTokens: (personAStats?.promptTokens ?? 0) + (personBResult.stats?.promptTokens ?? 0),
                completionTokens: (personAStats?.completionTokens ?? 0) + (personBResult.stats?.completionTokens ?? 0),
                totalDurationMs: (personAStats?.totalDurationMs ?? 0) + (personBResult.stats?.totalDurationMs ?? 0),
                loadDurationMs: (personAStats?.loadDurationMs ?? 0) + (personBResult.stats?.loadDurationMs ?? 0),
            };

            const exchange: ConversationExchange = {
                turn,
                timestamp: new Date(),
                promptToCopilot: personAOutput, // Reuse field: Person A's message
                copilotResponse: {
                    requestId: `${state.conversationId}_t${turn}`,
                    generatedMarkdown: personBOutput,
                    references: [],
                    requestedAttachments: [],
                },
                localModelStats: combinedStats,
            };
            state.exchanges.push(exchange);
            this.writeConversationLog(state);

            const statsStr = ` | A: ${personAStats?.promptTokens ?? 0}+${personAStats?.completionTokens ?? 0}t | B: ${personBResult.stats?.promptTokens ?? 0}+${personBResult.stats?.completionTokens ?? 0}t`;
            bridgeLog(`[Bot Conversation] Self-talk turn ${turn} complete${statsStr}`);

            // Telegram turn notification (Person A's output as "prompt", B's as "response")
            this.telegram?.notifyTurn(turn, config.maxTurns, personAOutput, personBOutput, combinedStats);

            // Check goal reached in Person B's output
            if (personBOutput.includes(config.goalReachedMarker)) {
                bridgeLog(`[Bot Conversation] Self-talk goal reached by Person B at turn ${turn}`);
                vscode.window.showInformationMessage(
                    `Self-talk: goal reached by Person B after ${turn} turns!`,
                );
                this.telegram?.notifyEnd(state.conversationId, turn, true);
                return;
            }
        }

        // Max turns reached
        bridgeLog(`[Bot Conversation] Self-talk max turns (${config.maxTurns}) reached`);
        vscode.window.showWarningMessage(
            `Self-talk reached max turns (${config.maxTurns}) without achieving the goal.`,
        );
        this.telegram?.notifyEnd(state.conversationId, config.maxTurns, false, 'Max turns reached');
    }

    /** Try to parse a Copilot response that may contain inline JSON. */
    private parseInlineResponse(text: string, requestId: string): CopilotResponse {
        // Try to find JSON in the response (Copilot sometimes wraps it in markdown code blocks)
        const jsonMatch = text.match(/```(?:json)?\s*\n?([\s\S]*?)\n?```/) ?? text.match(/(\{[\s\S]*"generatedMarkdown"[\s\S]*\})/);
        if (jsonMatch) {
            try {
                const parsed = JSON.parse(jsonMatch[1]);
                if (parsed.generatedMarkdown) {
                    return {
                        requestId: parsed.requestId ?? requestId,
                        generatedMarkdown: parsed.generatedMarkdown,
                        comments: parsed.comments ?? undefined,
                        references: Array.isArray(parsed.references) ? parsed.references : [],
                        requestedAttachments: Array.isArray(parsed.requestedAttachments) ? parsed.requestedAttachments : [],
                    };
                }
            } catch { /* not valid JSON */ }
        }

        // Fallback: use the raw text as the response
        return {
            requestId,
            generatedMarkdown: text,
            references: [],
            requestedAttachments: [],
        };
    }

    // -----------------------------------------------------------------------
    // Bridge API — scriptable access via vscode-bridge JSON-RPC
    // -----------------------------------------------------------------------

    /**
     * Handle a bridge request for the bot conversation subsystem.
     *
     * Methods:
     *   aiConversation.getConfigVce      → return current config (profiles, defaults)
     *   aiConversation.getProfilesVce    → list available profiles
     *   aiConversation.startVce          → start a conversation (non-interactive)
     *   aiConversation.stopVce           → stop the active conversation
     *   aiConversation.haltVce           → halt (pause) the active conversation
     *   aiConversation.continueVce       → continue a halted conversation
     *   aiConversation.addInfoVce        → add additional user input to next prompt
     *   aiConversation.statusVce         → get conversation status + exchange count
     *   aiConversation.getLogVce         → return the conversation log for a given ID
     *   aiConversation.singleTurnVce     → run one Ollama→Copilot round-trip and return result
     */
    async handleBridgeRequest(method: string, params: any): Promise<any> {
        switch (method) {
            case 'aiConversation.getConfigVce':
                return this.bridgeGetConfig();
            case 'aiConversation.getProfilesVce':
                return this.bridgeGetProfiles();
            case 'aiConversation.startVce':
                return this.bridgeStart(params);
            case 'aiConversation.stopVce':
                return this.bridgeStop(params);
            case 'aiConversation.haltVce':
                return this.bridgeHalt(params);
            case 'aiConversation.continueVce':
                return this.bridgeContinue();
            case 'aiConversation.addInfoVce':
                return this.bridgeAddInfo(params);
            case 'aiConversation.statusVce':
                return this.bridgeStatus();
            case 'aiConversation.getLogVce':
                return this.bridgeGetLog(params);
            case 'aiConversation.singleTurnVce':
                return this.bridgeSingleTurn(params);
            default:
                throw new Error(`Unknown aiConversation method: ${method}`);
        }
    }

    /** Return the full resolved config including profile keys. */
    private bridgeGetConfig(): any {
        const config = this.loadConfig();
        return {
            maxTurns: config.maxTurns,
            temperature: config.temperature,
            historyMode: config.historyMode,
            maxHistoryTokens: config.maxHistoryTokens,
            modelConfig: config.modelConfig,
            pauseBetweenTurns: config.pauseBetweenTurns,
            pauseBeforeFirst: config.pauseBeforeFirst,
            logConversation: config.logConversation,
            stripThinkingTags: config.stripThinkingTags,
            copilotModel: config.copilotModel,
            conversationLogPath: config.conversationLogPath,
            goalReachedMarker: config.goalReachedMarker,
            profileKeys: Object.keys(config.profiles),
        };
    }

    /** Return list of profiles with their metadata. */
    private bridgeGetProfiles(): any {
        const config = this.loadConfig();
        return {
            profiles: Object.entries(config.profiles).map(([key, p]) => ({
                key,
                label: p.label,
                maxTurns: p.maxTurns ?? null,
                temperature: p.temperature ?? null,
                modelConfig: p.modelConfig ?? null,
                historyMode: p.historyMode ?? null,
                goalReachedMarker: p.goalReachedMarker ?? null,
            })),
        };
    }

    /**
     * Start a conversation programmatically (no UI prompts).
     *
     * Params:
     *   goal: string           — required, the conversation goal
     *   description?: string   — optional context
     *   profile?: string       — profile key (or omit for defaults)
     *   maxTurns?: number      — override max turns
     *   temperature?: number   — override temperature
     *   modelConfig?: string   — override model config key
    *   trailSummarizationLlmConfig?: string  — summarization model config key
     *   historyMode?: string   — override history mode
     *   includeFileContext?: string[]  — file paths for context
     *   pauseBetweenTurns?: boolean   — override pause setting
     *
     * Returns a promise that resolves when the conversation finishes:
     *   {
     *     conversationId: string,
     *     turns: number,
     *     goalReached: boolean,
     *     exchanges: ConversationExchange[],
     *     logFilePath: string
     *   }
     */
    private async bridgeStart(params: any): Promise<any> {
        if (!params?.goal || typeof params.goal !== 'string') {
            throw new Error('Missing required parameter: goal');
        }

        if (this.activeConversation?.active) {
            throw new Error('A conversation is already active. Stop it first with aiConversation.stopVce.');
        }

        const manager = getLocalLlmManager();
        if (!manager) {
            throw new Error('Prompt Expander not initialized');
        }

        const config = this.loadConfig();

        // Apply profile if specified
        const profileKey = typeof params.profile === 'string' ? params.profile : '_default';
        const profile = profileKey !== '_default' ? config.profiles[profileKey] : undefined;
        if (profileKey !== '_default' && !profile) {
            throw new Error(`Unknown profile: ${profileKey}. Available: ${Object.keys(config.profiles).join(', ')}`);
        }

        if (profile) {
            if (profile.maxTurns !== null && profile.maxTurns !== undefined) { config.maxTurns = profile.maxTurns; }
            if (profile.modelConfig !== null && profile.modelConfig !== undefined) { config.modelConfig = profile.modelConfig; }
            if (profile.temperature !== null && profile.temperature !== undefined) { config.temperature = profile.temperature; }
            if (profile.historyMode !== null && profile.historyMode !== undefined) { config.historyMode = profile.historyMode; }
            if (profile.initialPromptTemplate) { config.initialPromptTemplate = profile.initialPromptTemplate; }
            if (profile.followUpTemplate) { config.followUpTemplate = profile.followUpTemplate; }
            if (profile.copilotSuffix) { config.copilotSuffix = profile.copilotSuffix; }
            if (profile.goalReachedMarker) { config.goalReachedMarker = profile.goalReachedMarker; }
            if (profile.includeFileContext) { config.includeFileContext = profile.includeFileContext; }
        }

        if (typeof params.aiSetupId === 'string' && params.aiSetupId.trim().length > 0) {
            const setup = this.resolveSetupOrThrow(params.aiSetupId);
            config.modelConfig = setup.llmConfigA;
            config.trailSummarizationModelConfig = setup.trailSummarizationLlmConfig;
            config.maxTurns = setup.maxTurns;
            config.historyMode = setup.historyMode;
            config.pauseBetweenTurns = setup.pauseBetweenTurns === true;
            config.conversationMode = setup.llmConfigB && setup.llmConfigB !== 'copilot'
                ? 'ollama-ollama'
                : 'ollama-copilot';
            if (setup.llmConfigA) {
                config.selfTalk.personA.modelConfig = setup.llmConfigA;
            }
            if (setup.llmConfigB && setup.llmConfigB !== 'copilot') {
                config.selfTalk.personB.modelConfig = setup.llmConfigB;
            }
        }

        // Apply per-call overrides (take precedence over setup/profile)
        if (typeof params.maxTurns === 'number') { config.maxTurns = params.maxTurns; }
        if (typeof params.temperature === 'number') { config.temperature = params.temperature; }
        if (typeof params.modelConfig === 'string') { config.modelConfig = params.modelConfig; }
        if (typeof params.trailSummarizationLlmConfig === 'string') {
            config.trailSummarizationModelConfig = params.trailSummarizationLlmConfig;
        }
        if (typeof params.historyMode === 'string' &&
            ['full', 'last', 'summary', 'trim_and_summary'].includes(params.historyMode)) {
            config.historyMode = params.historyMode as HistoryMode;
        }
        if (Array.isArray(params.includeFileContext)) { config.includeFileContext = params.includeFileContext; }
        if (typeof params.pauseBetweenTurns === 'boolean') { config.pauseBetweenTurns = params.pauseBetweenTurns; }
        if (typeof params.conversationMode === 'string' &&
            ['ollama-copilot', 'ollama-ollama'].includes(params.conversationMode)) {
            config.conversationMode = params.conversationMode as ConversationMode;
        }
        // Apply selfTalk persona overrides (for Ollama-Ollama mode)
        if (params.selfTalkOverrides && typeof params.selfTalkOverrides === 'object') {
            if (params.selfTalkOverrides.personA?.modelConfig) {
                config.selfTalk.personA.modelConfig = params.selfTalkOverrides.personA.modelConfig;
            }
            if (params.selfTalkOverrides.personB?.modelConfig) {
                config.selfTalk.personB.modelConfig = params.selfTalkOverrides.personB.modelConfig;
            }
        }

        if (!config.modelConfig || !config.trailSummarizationModelConfig) {
            throw new Error('Missing required model configuration. Provide aiSetupId or both modelConfig and trailSummarizationLlmConfig.');
        }
        if (typeof config.maxTurns !== 'number' || config.maxTurns <= 0) {
            throw new Error('Missing required maxTurns. Provide aiSetupId or maxTurns.');
        }

        const runtimeLlmConfig = config.modelConfig;
        this.applyLlmRuntimeDefaults(config, runtimeLlmConfig);
        const summaryLlmConfig = config.trailSummarizationModelConfig;
        this.applyLlmSummaryDefaults(config, summaryLlmConfig);

        const goal = params.goal.trim();
        const description = typeof params.description === 'string' ? params.description.trim() : '';

        // Create conversation state
        const conversationId = this.generateConversationId();
        const cancellationSource = new vscode.CancellationTokenSource();
        const state: ConversationState = {
            conversationId,
            goal,
            description,
            exchanges: [],
            config,
            profileKey,
            active: true,
            halted: false,
            additionalUserInput: [],
            cancellationSource,
            logFilePath: '',
        };
        this.activeConversation = state;
        this.updateWindowConversationState(true);

        bridgeLog(`[Bot Conversation] Bridge start: ${conversationId} | Goal: ${goal.substring(0, 80)}...`);

        // Set up Telegram integration (if enabled)
        this.setupTelegram(config);
        this.telegram?.notifyStart(conversationId, goal, profileKey);

        let goalReached = false;
        try {
            await this.runConversationLoop(state, manager);
            // If we get here without an error, check if goal was reached
            // (the loop itself logs "[Bot Conversation] Goal reached at turn X")
            const lastExchange = state.exchanges[state.exchanges.length - 1];
            if (lastExchange) {
                const lastLocalOutput = lastExchange.promptToCopilot;
                goalReached = lastLocalOutput.includes(config.goalReachedMarker);
            }
        } catch (err: any) {
            if (err.message !== 'Cancelled') {
                throw err;
            }
        } finally {
            state.active = false;
            this.writeConversationLog(state);
            this.updateWindowConversationState(false);
            if (this.activeConversation === state) {
                this.activeConversation = null;
            }
            // Clean up Telegram polling
            if (this.telegram) {
                this.telegram.stopPolling();
            }
            cancellationSource.dispose();
        }

        return {
            conversationId: state.conversationId,
            turns: state.exchanges.length,
            goalReached,
            logFilePath: state.logFilePath,
            exchanges: state.exchanges.map((ex) => ({
                turn: ex.turn,
                timestamp: ex.timestamp.toISOString(),
                promptToCopilot: ex.promptToCopilot,
                copilotResponse: ex.copilotResponse,
                localModelStats: ex.localModelStats ?? null,
            })),
        };
    }

    /** Stop the active conversation via bridge. */
    private bridgeStop(params: any): any {
        if (!this.activeConversation?.active) {
            return { success: false, message: 'No active conversation' };
        }
        const reason = typeof params?.reason === 'string' ? params.reason : 'Stopped via bridge';
        this.stopConversation(reason);
        return { success: true, message: reason };
    }

    /** Halt the active conversation via bridge. */
    private bridgeHalt(params: any): any {
        const reason = typeof params?.reason === 'string' ? params.reason : 'Halted via bridge';
        const success = this.haltConversation(reason);
        return {
            success,
            message: success ? reason : 'No active conversation to halt (or already halted)',
            halted: this.isHalted,
        };
    }

    /** Continue a halted conversation via bridge. */
    private bridgeContinue(): any {
        const success = this.continueConversation();
        return {
            success,
            message: success ? 'Conversation continued' : 'Conversation is not halted',
            halted: this.isHalted,
        };
    }

    /** Add additional user input via bridge. */
    private bridgeAddInfo(params: any): any {
        if (!params?.text || typeof params.text !== 'string') {
            throw new Error('Missing required parameter: text');
        }
        const success = this.addUserInput(params.text);
        return {
            success,
            message: success ? `Added ${params.text.length} chars to next prompt` : 'No active conversation',
        };
    }

    /** Return status of the active conversation. */
    private bridgeStatus(): any {
        if (!this.activeConversation) {
            return { active: false };
        }
        const state = this.activeConversation;
        return {
            active: state.active,
            halted: state.halted,
            conversationId: state.conversationId,
            goal: state.goal,
            profileKey: state.profileKey,
            conversationMode: state.config.conversationMode,
            turnsCompleted: state.exchanges.length,
            maxTurns: state.config.maxTurns,
            pendingUserInput: state.additionalUserInput.length,
        };
    }

    /** Return a conversation log by ID (reads from disk). */
    private bridgeGetLog(params: any): any {
        const conversationId = params?.conversationId;
        if (!conversationId || typeof conversationId !== 'string') {
            throw new Error('Missing required parameter: conversationId');
        }

        const wsRoot = getWorkspaceRoot();
        const config = this.loadConfig();
        const logDir = wsRoot
            ? path.join(wsRoot, config.conversationLogPath)
            : WsPaths.home('aiConversations');
        const logPath = path.join(logDir, `${conversationId}.md`);

        if (!fs.existsSync(logPath)) {
            return { found: false, conversationId };
        }

        return {
            found: true,
            conversationId,
            logFilePath: logPath,
            content: fs.readFileSync(logPath, 'utf-8'),
        };
    }

    /**
     * Run a single Ollama→Copilot round-trip without managing conversation state.
     *
     * Params:
     *   prompt: string             — the prompt for the local model
     *   systemPrompt?: string      — system prompt for local model (default: orchestrator)
     *   modelConfig?: string       — model config key
     *   temperature?: number       — generation temperature
     *   sendToCopilot?: boolean    — whether to actually send to Copilot (default: true)
     *   copilotSuffix?: string     — suffix appended to Copilot prompt
     *
     * Returns:
     *   {
     *     localModelOutput: string,
     *     localModelStats: OllamaStats | null,
     *     copilotResponse: CopilotResponse | null  (null if sendToCopilot=false)
     *   }
     */
    private async bridgeSingleTurn(params: any): Promise<any> {
        if (!params?.prompt || typeof params.prompt !== 'string') {
            throw new Error('Missing required parameter: prompt');
        }

        const manager = getLocalLlmManager();
        if (!manager) {
            throw new Error('Prompt Expander not initialized');
        }

        const config = this.loadConfig();

        // Step 1: Generate with local model
        const genResult = await manager.chatWithOllama({
            systemPrompt: typeof params.systemPrompt === 'string'
                ? params.systemPrompt
                : 'You are a conversation orchestrator generating prompts for an AI assistant.',
            userPrompt: params.prompt,
            modelConfigKey: typeof params.modelConfig === 'string' ? params.modelConfig : config.modelConfig ?? undefined,
            temperature: typeof params.temperature === 'number' ? params.temperature : config.temperature,
            stripThinkingTags: config.stripThinkingTags,
            trailType: 'conversation',
        });

        const localOutput = genResult.text.trim();

        // Step 2: Optionally send to Copilot
        const sendToCopilot = params.sendToCopilot !== false;

        if (!sendToCopilot) {
            return {
                localModelOutput: localOutput,
                localModelStats: genResult.stats ?? null,
                copilotResponse: null,
            };
        }

        const copilotModel = await getCopilotModel();
        if (!copilotModel) {
            throw new Error('No Copilot model available');
        }

        const suffix = typeof params.copilotSuffix === 'string' ? params.copilotSuffix : '';
        const fullPrompt = localOutput + suffix;

        const copilotResponseText = await sendCopilotRequest(
            copilotModel,
            fullPrompt,
            new vscode.CancellationTokenSource().token,
        );

        const requestId = `single_${Date.now()}`;
        const copilotResponse = this.parseInlineResponse(copilotResponseText, requestId);

        return {
            localModelOutput: localOutput,
            localModelStats: genResult.stats ?? null,
            copilotResponse,
        };
    }

    // -----------------------------------------------------------------------
    // Stop
    // -----------------------------------------------------------------------

    /** Stop the active conversation. */
    stopConversation(reason?: string): void {
        if (this.activeConversation?.active) {
            this.activeConversation.active = false;
            this.activeConversation.cancellationSource.cancel();
            this.updateWindowConversationState(false);
            bridgeLog(`[Bot Conversation] Stopped: ${reason ?? 'user requested'}`);
        }
    }

    /** Whether a conversation is currently active. */
    get isActive(): boolean {
        return this.activeConversation?.active === true;
    }
}

// ============================================================================
// Exported handlers
// ============================================================================

let _botManager: AiConversationManager | undefined;

export function setAiConversationManager(mgr: AiConversationManager): void {
    _botManager = mgr;
}

export function getAiConversationManager(): AiConversationManager | undefined {
    return _botManager;
}

export async function startAiConversationHandler(): Promise<void> {
    logConversation('startAiConversation command invoked');
    try {
        if (!_botManager) {
            logConversation('Bot Conversation not initialized', 'ERROR');
            vscode.window.showErrorMessage('Bot Conversation not initialized');
            return;
        }
        await _botManager.startConversationCommand();
        logConversation('startAiConversation completed');
    } catch (error) {
        logConversation(`startAiConversation FAILED: ${error}`, 'ERROR');
        vscode.window.showErrorMessage(`Start Bot Conversation failed: ${error}`);
    }
}

export async function stopAiConversationHandler(): Promise<void> {
    logConversation('stopAiConversation command invoked');
    try {
        if (!_botManager) {
            logConversation('Bot Conversation not initialized', 'ERROR');
            vscode.window.showErrorMessage('Bot Conversation not initialized');
            return;
        }
        if (!_botManager.isActive) {
            logConversation('No active conversation to stop', 'WARN');
            vscode.window.showInformationMessage('No active bot conversation to stop.');
            return;
        }
        _botManager.stopConversation('Stopped by user command');
        logConversation('Bot conversation stopped');
        vscode.window.showInformationMessage('Bot conversation stopped.');
    } catch (error) {
        logConversation(`stopAiConversation FAILED: ${error}`, 'ERROR');
        vscode.window.showErrorMessage(`Stop Bot Conversation failed: ${error}`);
    }
}

export async function haltAiConversationHandler(): Promise<void> {
    logConversation('haltAiConversation command invoked');
    try {
        if (!_botManager) {
            logConversation('Bot Conversation not initialized', 'ERROR');
            vscode.window.showErrorMessage('Bot Conversation not initialized');
            return;
        }
        if (!_botManager.isActive) {
            logConversation('No active conversation to halt', 'WARN');
            vscode.window.showInformationMessage('No active bot conversation to halt.');
            return;
        }
        if (_botManager.isHalted) {
            logConversation('Conversation already halted', 'WARN');
            vscode.window.showInformationMessage('Bot conversation is already halted.');
            return;
        }
        _botManager.haltConversation('Halted by user command');
        logConversation('Bot conversation halted');
        vscode.window.showInformationMessage('Bot conversation halted. Use "Continue" to resume.');
    } catch (error) {
        logConversation(`haltAiConversation FAILED: ${error}`, 'ERROR');
        vscode.window.showErrorMessage(`Halt Bot Conversation failed: ${error}`);
    }
}

export async function continueAiConversationHandler(): Promise<void> {
    logConversation('continueAiConversation command invoked');
    try {
        if (!_botManager) {
            logConversation('Bot Conversation not initialized', 'ERROR');
            vscode.window.showErrorMessage('Bot Conversation not initialized');
            return;
        }
        if (!_botManager.isHalted) {
            logConversation('Conversation is not halted', 'WARN');
            vscode.window.showInformationMessage('Bot conversation is not halted.');
            return;
        }
        _botManager.continueConversation();
        logConversation('Bot conversation continued');
        vscode.window.showInformationMessage('Bot conversation continued.');
    } catch (error) {
        logConversation(`continueAiConversation FAILED: ${error}`, 'ERROR');
        vscode.window.showErrorMessage(`Continue Bot Conversation failed: ${error}`);
    }
}

export async function addToAiConversationHandler(): Promise<void> {
    logConversation('addToAiConversation command invoked');
    try {
        if (!_botManager) {
            logConversation('Bot Conversation not initialized', 'ERROR');
            vscode.window.showErrorMessage('Bot Conversation not initialized');
            return;
        }
        if (!_botManager.isActive) {
            logConversation('No active conversation', 'WARN');
            vscode.window.showInformationMessage('No active bot conversation.');
            return;
        }

        // Check if there's selected text in the editor
        const editor = vscode.window.activeTextEditor;
        const selectedText = editor && !editor.selection.isEmpty
            ? editor.document.getText(editor.selection)
            : undefined;

        const text = await vscode.window.showInputBox({
            prompt: 'Enter additional context for the bot conversation',
            placeHolder: 'Extra instructions, corrections, file references...',
            value: selectedText ?? '',
        });
        if (!text?.trim()) { return; }

        _botManager.addUserInput(text.trim());
        logConversation(`Added ${text.trim().length} chars to bot conversation`);
        vscode.window.showInformationMessage(`Added ${text.trim().length} chars to bot conversation.`);
    } catch (error) {
        logConversation(`addToAiConversation FAILED: ${error}`, 'ERROR');
        vscode.window.showErrorMessage(`Add to Bot Conversation failed: ${error}`);
    }
}
