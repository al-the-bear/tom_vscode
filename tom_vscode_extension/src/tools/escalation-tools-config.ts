/**
 * Configuration manager for escalation tools (Ask Copilot, Ask Big Brother)
 * 
 * These tools allow a local LLM to escalate questions to more powerful models:
 * - Ask Copilot: Uses the Copilot Chat window with answer file communication
 * - Ask Big Brother: Uses the VS Code Language Model API directly
 */

import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import { getConfigPath } from '../handlers/handler_shared.js';
import { WsPaths } from '../utils/workspacePaths';
import { debugLog } from '../utils/debugLogger.js';

// ============================================================================
// Configuration Types
// ============================================================================

export interface AskCopilotConfig {
    enabled: boolean;
    descriptionTemplate: string;
    answerFileTimeout: number;      // ms to wait for answer file
    pollInterval: number;           // ms between answer file checks
    answerFolder: string;           // folder for answer files
    promptPrefix: string;           // prefix added to prompts
    promptSuffix: string;           // suffix added to prompts (with answer file instructions)
    promptTemplate: string;         // template name from global templates (empty = none)
}

export interface AskBigBrotherConfig {
    enabled: boolean;
    descriptionTemplate: string;
    defaultModel: string;           // default model ID/family
    temperature: number;
    maxIterations: number;          // max tool invocation iterations
    enableToolsByDefault: boolean;
    maxToolResultChars: number;     // max chars per tool result
    responseTimeout: number;        // ms timeout for response
    // Summarization settings
    summarizationEnabled: boolean;
    summarizationModel: string;
    summarizationPromptTemplate: string;
    maxResponseChars: number;       // summarize if response exceeds this
    // Model recommendations (included in description)
    modelRecommendations: string;
    promptTemplate: string;         // template name from global templates (empty = none)
}

export interface EscalationToolsConfig {
    askCopilot: AskCopilotConfig;
    askBigBrother: AskBigBrotherConfig;
}

// ============================================================================
// Default Configuration
// ============================================================================

const DEFAULT_ASK_COPILOT_CONFIG: AskCopilotConfig = {
    enabled: true,
    descriptionTemplate: `Send a question to GitHub Copilot via the chat window and wait for a response.

**How it works:**
- Opens Copilot Chat with your prompt
- Watches for an answer file written by Copilot
- Returns the response content

**When to use:**
- Questions that benefit from Copilot's full context (open files, workspace)
- Tasks where Copilot can use its native tools (edit files, run commands)
- Complex coding tasks requiring iterative refinement

**Parameters:**
- prompt: Your question for Copilot
- waitForAnswer: Whether to wait for answer file (default: true)
- timeoutMs: Max time to wait for answer (default: from config)`,
    answerFileTimeout: 120000,
    pollInterval: 2000,
    answerFolder: WsPaths.aiRelative('chatReplies'),
    promptPrefix: '',
    promptSuffix: '',
    promptTemplate: '',
};

const DEFAULT_ASK_BIG_BROTHER_CONFIG: AskBigBrotherConfig = {
    enabled: true,
    descriptionTemplate: `Query VS Code language models (GitHub Copilot, Claude, GPT-4, etc.) directly via the Language Model API. This is your "escalation path" for complex questions.

**Operations:**
- "list": Get available models with recommendations
- "query": Send a prompt to a model (specify modelId or use default)

\${modelList}

**Tool Support:**
Set enableTools=true to let the model use VS Code tools (file reading, web search, etc.) to answer your question. This enables multi-step reasoning where the model can gather information before responding.

**When to use:**
- Complex reasoning, architecture decisions, code analysis
- Questions requiring broader knowledge than your training
- Verification of your answers on critical topics
- Tasks that need file/web access you don't have
- Questions that benefit from a second opinion

\${modelRecommendations}`,
    defaultModel: 'GPT-5.2',
    temperature: 0.7,
    maxIterations: 5,
    enableToolsByDefault: false,
    maxToolResultChars: 10000,
    responseTimeout: 120000,
    summarizationEnabled: true,
    summarizationModel: 'gpt-4o',
    summarizationPromptTemplate: `Summarize the following response concisely while preserving key information, code examples, and actionable details:

\${response}

Provide a clear, structured summary.`,
    maxResponseChars: 20000,
    modelRecommendations: `**Model recommendations:**
- claude-3.5-sonnet / claude-3-opus: Complex reasoning, detailed code review
- gpt-4o: General purpose, good speed/quality balance  
- o1 / o3: Deep reasoning, math, logic problems
- gpt-4o-mini: Quick answers for simple questions`,
    promptTemplate: '',
};

// ============================================================================
// Configuration Manager
// ============================================================================

let cachedConfig: EscalationToolsConfig | null = null;
let configPath: string | null = null;

/**
 * Set the config path (called from extension activation)
 */
export function setConfigPath(path: string): void {
    configPath = path;
    cachedConfig = null;
}

/**
 * Get configuration file path.
 * Delegates to the shared getConfigPath() from handler_shared.
 */
function getConfigFilePath(): string | null {
    if (configPath) {
        return configPath;
    }
    
    // Return the resolved path even if the file does not exist yet
    // (the caller will create it on save).
    return getConfigPath() || null;
}

/**
 * Load full configuration from file
 */
function loadFullConfig(): any {
    const filePath = getConfigFilePath();
    if (!filePath || !fs.existsSync(filePath)) {
        return null;
    }
    
    try {
        const content = fs.readFileSync(filePath, 'utf-8');
        return JSON.parse(content);
    } catch {
        return null;
    }
}

/**
 * Load escalation tools configuration
 */
export function loadEscalationToolsConfig(): EscalationToolsConfig {
    if (cachedConfig) {
        return cachedConfig;
    }
    
    const fullConfig = loadFullConfig();
    const toolsConfig = fullConfig?.localLlmTools || {};
    
    cachedConfig = {
        askCopilot: {
            ...DEFAULT_ASK_COPILOT_CONFIG,
            ...(toolsConfig.askCopilot || {}),
        },
        askBigBrother: {
            ...DEFAULT_ASK_BIG_BROTHER_CONFIG,
            ...(toolsConfig.askBigBrother || {}),
        },
    };
    
    return cachedConfig;
}

/**
 * Save escalation tools configuration
 */
export function saveEscalationToolsConfig(config: EscalationToolsConfig): boolean {
    const filePath = getConfigFilePath();
    if (!filePath) {
        return false;
    }
    
    try {
        let fullConfig = loadFullConfig() || {};
        fullConfig.localLlmTools = {
            askCopilot: config.askCopilot,
            askBigBrother: config.askBigBrother,
        };
        
        // Ensure directory exists before writing
        const dir = path.dirname(filePath);
        if (!fs.existsSync(dir)) {
            fs.mkdirSync(dir, { recursive: true });
        }
        
        fs.writeFileSync(filePath, JSON.stringify(fullConfig, null, 2), 'utf-8');
        cachedConfig = config;
        return true;
    } catch {
        return false;
    }
}

/**
 * Clear cached config (call when config file changes)
 */
export function clearConfigCache(): void {
    cachedConfig = null;
}

// ============================================================================
// Model List Generation
// ============================================================================

/**
 * Generate a formatted model list from available VS Code LM models
 */
export async function generateModelList(): Promise<string> {
    try {
        const startMs = performance.now();
        debugLog('generateModelList: calling vscode.lm.selectChatModels()...', 'INFO', 'extension.activate');
        const models = await vscode.lm.selectChatModels();
        const elapsed = Math.round((performance.now() - startMs) * 100) / 100;
        debugLog(`generateModelList: selectChatModels returned ${models.length} model(s) in ${elapsed}ms`, 'INFO', 'extension.activate');
        if (models.length === 0) {
            return '**Available Models:** None (ensure GitHub Copilot or another provider is installed)';
        }
        
        const lines: string[] = ['**Available Models:**'];
        for (const m of models) {
            lines.push(`- \`${m.id}\` (${m.name}) - ${m.vendor}/${m.family}, max ${m.maxInputTokens.toLocaleString()} tokens`);
        }
        
        return lines.join('\n');
    } catch {
        return '**Available Models:** Unable to fetch (ensure language model provider is active)';
    }
}

/**
 * Build the Ask Big Brother tool description with dynamic model list
 */
export async function buildAskBigBrotherDescription(): Promise<string> {
    let sub = performance.now();
    const config = loadEscalationToolsConfig();
    debugLog(`buildAskBigBrotherDescription.loadConfig: ${Math.round((performance.now() - sub) * 100) / 100}ms`, 'INFO', 'extension.activate');

    sub = performance.now();
    const modelList = await generateModelList();
    debugLog(`buildAskBigBrotherDescription.generateModelList: ${Math.round((performance.now() - sub) * 100) / 100}ms`, 'INFO', 'extension.activate');
    
    sub = performance.now();
    let description = config.askBigBrother.descriptionTemplate;
    description = description.replace('${modelList}', modelList);
    description = description.replace('${modelRecommendations}', config.askBigBrother.modelRecommendations);
    debugLog(`buildAskBigBrotherDescription.templateReplace: ${Math.round((performance.now() - sub) * 100) / 100}ms`, 'INFO', 'extension.activate');
    
    return description;
}

/**
 * Build the Ask Copilot tool description
 */
export function buildAskCopilotDescription(): string {
    const config = loadEscalationToolsConfig();
    return config.askCopilot.descriptionTemplate;
}

// ============================================================================
// Exports for status page
// ============================================================================

export function getDefaultAskCopilotConfig(): AskCopilotConfig {
    return { ...DEFAULT_ASK_COPILOT_CONFIG };
}

export function getDefaultAskBigBrotherConfig(): AskBigBrotherConfig {
    return { ...DEFAULT_ASK_BIG_BROTHER_CONFIG };
}
