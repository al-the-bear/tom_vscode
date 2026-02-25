/**
 * Shared functionality for VS Code command handlers.
 * 
 * This module provides common utilities used across multiple command handlers,
 * including logging, error handling, workspace utilities, and bridge management.
 */

import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs';
import * as os from 'os';

import { DartBridgeClient } from '../vscode-bridge';
import {
    expandTemplate,
    PLACEHOLDER_HELP as SHARED_PLACEHOLDER_HELP,
} from './promptTemplate';
import {
    resolveVariables,
    PLACEHOLDER_HELP as VARIABLE_PLACEHOLDER_HELP,
} from '../utils/variableResolver.js';
import { WsPaths } from '../utils/workspacePaths';
import {
    resolveNamedExecutable,
    findExternalApplication,
    resolveApplicationExecutable,
    getCurrentPlatform,
    expandHomePath,
    buildConfigContext,
    type ExecutablesConfig,
    type ExternalApplicationsConfig,
    type ApplicationMapping,
    type ConfigPlaceholderContext,
} from '../utils/executableResolver';
import {
    SendToChatConfig,
    loadSendToChatConfig,
    saveSendToChatConfig,
    getCopilotChatAnswerFolder,
    getCopilotChatAnswerFolderAbsolute,
} from '../utils/sendToChatConfig';
import { debugException, debugLog } from '../utils/debugLogger';

// Re-export config types and functions from sendToChatConfig
export {
    SendToChatConfig,
    loadSendToChatConfig,
    saveSendToChatConfig,
    getCopilotChatAnswerFolder,
    getCopilotChatAnswerFolderAbsolute,
};

// ============================================================================
// Global State
// ============================================================================

/**
 * Global bridge client instance - shared across all handlers
 */
let bridgeClient: DartBridgeClient | null = null;

/**
 * Get the global bridge client instance
 */
export function getBridgeClient(): DartBridgeClient | null {
    return bridgeClient;
}

/**
 * Set the global bridge client instance
 */
export function setBridgeClient(client: DartBridgeClient | null): void {
    bridgeClient = client;
}

// ============================================================================
// Logging
// ============================================================================

/**
 * Log a message to the DartScript output channel
 */
export function bridgeLog(message: string, level: 'INFO' | 'ERROR' = 'INFO'): void {
    debugLog(message, level === 'ERROR' ? 'ERROR' : 'INFO', 'bridgeLog');
    if (!DartBridgeClient.outputChannel) {
        console.log(`[VS Code Extension] ${level} ${message}`);
        return;
    }
    DartBridgeClient.outputChannel.appendLine(`[VS Code Extension] ${level} ${message}`);
}

// ============================================================================
// Error Handling
// ============================================================================

/**
 * Handle errors consistently across all handlers.
 * Extracts error IDs (e.g., [B01], [E01]) from the original error
 * and prepends them to the message for easier debugging.
 */
export function handleError(message: string, error: unknown): void {
    const errorMessage = error instanceof Error ? error.message : String(error);
    const errorStack = error instanceof Error && error.stack ? error.stack : undefined;

    debugException('handleError', error, { message });
    bridgeLog(`${message}: ${errorMessage}`, 'ERROR');
    if (errorStack) {
        bridgeLog(errorStack, 'ERROR');
    }
    
    // Extract error ID from the original error message (e.g., [B01], [E01])
    const errorIdMatch = errorMessage.match(/\[([A-Z]\d+)\]/);
    const errorId = errorIdMatch ? errorIdMatch[0] + ' ' : '';
    
    vscode.window.showErrorMessage(`${errorId}${message}: ${errorMessage}`);
}

/**
 * Report an exception with structured context for instrumentation and diagnostics.
 */
export function reportException(context: string, error: unknown, details?: Record<string, unknown>): void {
    const errorMessage = error instanceof Error ? error.message : String(error);
    const errorStack = error instanceof Error && error.stack ? error.stack : undefined;
    const detailsText = details ? ` details=${JSON.stringify(details)}` : '';

    const headline = `[EXCEPTION] ${context}: ${errorMessage}${detailsText}`;
    debugException(context, error, details);
    bridgeLog(headline, 'ERROR');
    if (errorStack) {
        bridgeLog(errorStack, 'ERROR');
    }
}

// ============================================================================
// Workspace Utilities
// ============================================================================

/**
 * Get the workspace root path
 */
export function getWorkspaceRoot(): string | undefined {
    const activeUri = vscode.window.activeTextEditor?.document.uri;
    if (activeUri) {
        const activeWorkspaceFolder = vscode.workspace.getWorkspaceFolder(activeUri);
        if (activeWorkspaceFolder) {
            return activeWorkspaceFolder.uri.fsPath;
        }
    }
    const workspaceFolders = vscode.workspace.workspaceFolders;
    if (!workspaceFolders || workspaceFolders.length === 0) {
        return undefined;
    }
    return workspaceFolders[0].uri.fsPath;
}

/**
 * Get the resolved path to the extension config file.
 *
 * Resolution order:
 *   1. Workspace `.tom/tom_vscode_extension.json` (if it exists)
 *   2. Explicit `dartscript.configPath` setting (with variable resolution)
 *   3. Home fallback `~/.tom/vscode/tom_vscode_extension.json`
 */
export function getConfigPath(): string | undefined {
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
        return resolvePathVariables(configSetting) ?? configSetting;
    }

    // 3. Home fallback
    return WsPaths.home('vscodeConfig');
}

/**
 * Resolve path variable placeholders in a string.
 *
 * This is a **thin wrapper** around the unified variable resolver.
 * It delegates to `resolveVariables()` from `variableResolver.ts`,
 * which supports all standard variables including workspace, environment,
 * file, date/time, git, VS Code, chat, and more.
 *
 * Key path variables:
 *   ${workspaceFolder}   — first workspace folder root
 *   ${home}              — user's home directory (also resolves leading `~/`)
 *   ${username}          — OS username
 *   ${hostname}          — machine hostname
 *   ${os}               — platform (linux, darwin, win32)
 *   ${arch}             — CPU architecture (x64, arm64)
 *   ${tmpdir}           — OS temp directory
 *   ${file}              — full path of the currently active editor file
 *   ${file.name}         — filename without extension
 *   ${file.extension}    — file extension including dot
 *   ${file.content}      — full file content
 *   ${file.selection}    — selection (falls back to full content)
 *   ${configfile}        — extension config file path
 *   ${answer-file}       — answer file path
 *   ${env.VARNAME}       — any environment variable
 *   ${git.branch}        — current git branch
 *   ${{javascript}}      — inline JS expression
 *
 * See doc/file_and_prompt_placeholder.md for the complete reference.
 *
 * @param input          The string containing placeholders.
 * @param options.silent When true, returns the input unchanged instead of
 *                       showing an error when file-based variables are present
 *                       but no editor is open.  Defaults to false.
 * @returns The resolved string, or undefined if file-dependent variables are
 *          present, no editor is open, and `silent` is false.
 */
export function resolvePathVariables(input: string, options?: { silent?: boolean }): string | undefined {
    // Pre-check: if file-based variables are used but no editor is open,
    // show an error (unless silent mode).
    const hasFileVars = /\$\{(file|fileFolder)(\.[a-z]+)?\}/.test(input);
    if (hasFileVars && !vscode.window.activeTextEditor) {
        if (options?.silent) {
            // Resolve everything except file vars (they'll become empty strings)
            return resolveVariables(input, {
                includeEditor: true,
                unresolvedBehavior: 'empty',
                enableJsExpressions: true,
            });
        }
        vscode.window.showErrorMessage(
            'Path uses file placeholders (${file}, ${fileFolder}, etc.) but no editor is open.',
        );
        return undefined;
    }

    return resolveVariables(input, {
        includeEditor: true,
        unresolvedBehavior: 'empty',
        enableJsExpressions: true,
    });
}

/**
 * Get VS Code language ID from filename extension
 */
export function getLanguageFromFilename(filename: string): string {
    const ext = path.extname(filename).toLowerCase();
    const languageMap: Record<string, string> = {
        '.dart': 'dart',
        '.json': 'json',
        '.yaml': 'yaml',
        '.yml': 'yaml',
        '.md': 'markdown',
        '.ts': 'typescript',
        '.js': 'javascript',
        '.html': 'html',
        '.css': 'css',
        '.xml': 'xml',
        '.txt': 'plaintext'
    };
    return languageMap[ext] || 'plaintext';
}

/**
 * Get workspace structure as a string for display
 */
export async function getWorkspaceStructure(workspaceRoot: string): Promise<string> {
    const structure: string[] = [];

    function scanDirectory(dir: string, indent: string = '', maxDepth: number = 3, currentDepth: number = 0): void {
        if (currentDepth >= maxDepth) {
            return;
        }

        try {
            const entries = fs.readdirSync(dir, { withFileTypes: true });

            for (const entry of entries) {
                // Skip hidden files and common build directories
                if (entry.name.startsWith('.') ||
                    entry.name === 'node_modules' ||
                    entry.name === 'build' ||
                    entry.name === 'out') {
                    continue;
                }

                const fullPath = path.join(dir, entry.name);

                if (entry.isDirectory()) {
                    structure.push(`${indent}📁 ${entry.name}/`);
                    scanDirectory(fullPath, indent + '  ', maxDepth, currentDepth + 1);
                } else {
                    structure.push(`${indent}📄 ${entry.name}`);
                }
            }
        } catch (error) {
            console.error(`Error scanning directory ${dir}:`, error);
        }
    }

    scanDirectory(workspaceRoot);
    return structure.join('\n');
}

// ============================================================================
// Bridge Utilities
// ============================================================================

/**
 * Ensure the bridge client is available and running.
 * Creates a new client if needed and starts the bridge if not running.
 * 
 * @param context - Extension context for creating new bridge client
 * @param showMessages - Whether to show status messages to the user
 * @returns The bridge client, or null if it couldn't be started
 */
export async function ensureBridgeRunning(
    context: vscode.ExtensionContext,
    showMessages: boolean = false
): Promise<DartBridgeClient | null> {
    const workspaceRoot = getWorkspaceRoot();
    if (!workspaceRoot) {
        if (showMessages) {
            vscode.window.showErrorMessage('No workspace folder open');
        }
        return null;
    }

    const bridgePath = path.join(workspaceRoot, 'xternal', 'tom_module_vscode', 'tom_vscode_bridge');
    if (!fs.existsSync(bridgePath)) {
        if (showMessages) {
            vscode.window.showErrorMessage('tom_vscode_bridge not found in workspace (expected at xternal/tom_module_vscode/tom_vscode_bridge)');
        }
        return null;
    }

    // Create bridge client if needed
    if (!bridgeClient) {
        bridgeClient = new DartBridgeClient(context);
    }

    // Start bridge if not already running
    if (!bridgeClient.isRunning()) {
        if (showMessages) {
            vscode.window.showInformationMessage('Starting Dart bridge...');
        }
        await bridgeClient.startWithAutoRestart(bridgePath);
    }

    return bridgeClient;
}

// ============================================================================
// Copilot Integration
// ============================================================================

/**
 * Get a Copilot chat model
 */
export async function getCopilotModel(): Promise<vscode.LanguageModelChat | undefined> {
    try {
        // Get configuration
        const config = vscode.workspace.getConfiguration('dartscript');
        const preferredModel = config.get<string>('copilotModel', 'gpt-4o');

        // Try to get the preferred model
        let models = await vscode.lm.selectChatModels({
            vendor: 'copilot',
            family: preferredModel
        });

        // Fallback to any Copilot model
        if (models.length === 0) {
            models = await vscode.lm.selectChatModels({
                vendor: 'copilot'
            });
        }

        if (models.length === 0) {
            vscode.window.showErrorMessage(
                'No Copilot models available. Please ensure GitHub Copilot is installed and activated.'
            );
            return undefined;
        }

        console.log(`Using Copilot model: ${models[0].name} (${models[0].vendor})`);
        return models[0];

    } catch (error) {
        console.error('Error getting Copilot model:', error);
        return undefined;
    }
}

/**
 * Send a request to Copilot and get the response
 */
export async function sendCopilotRequest(
    model: vscode.LanguageModelChat,
    prompt: string,
    token: vscode.CancellationToken
): Promise<string> {
    try {
        // Create chat messages
        const messages = [
            vscode.LanguageModelChatMessage.User(prompt)
        ];

        // Send request
        const response = await model.sendRequest(messages, {}, token);

        // Collect response text
        let fullResponse = '';
        for await (const chunk of response.text) {
            if (token.isCancellationRequested) {
                throw new Error('Request cancelled');
            }
            fullResponse += chunk;
        }

        return fullResponse;

    } catch (error) {
        if (error instanceof vscode.LanguageModelError) {
            console.error('Copilot error:', error.message, error.code);

            // Handle specific error cases
            if (error.cause instanceof Error) {
                if (error.cause.message.includes('off_topic')) {
                    throw new Error('The request was rejected as off-topic');
                }
                if (error.cause.message.includes('consent')) {
                    throw new Error('User consent required for Copilot');
                }
                if (error.cause.message.includes('quota')) {
                    throw new Error('Copilot quota limit exceeded');
                }
            }

            throw new Error(`Copilot error: ${error.message}`);
        }
        throw error;
    }
}

// ============================================================================
// File Utilities
// ============================================================================

/**
 * Validate that a file path is a Dart file and exists
 */
export function validateDartFile(filePath: string): { valid: boolean; error?: string } {
    if (!filePath.endsWith('.dart')) {
        return { valid: false, error: 'Selected file is not a Dart file' };
    }

    if (!fs.existsSync(filePath)) {
        return { valid: false, error: 'File does not exist' };
    }

    return { valid: true };
}

/**
 * Get the file path from a URI or active editor
 */
export function getFilePath(uri?: vscode.Uri): string | undefined {
    if (uri) {
        return uri.fsPath;
    }
    
    const editor = vscode.window.activeTextEditor;
    if (!editor) {
        return undefined;
    }
    
    return editor.document.uri.fsPath;
}

/**
 * Show analysis result in a new document
 */
export async function showAnalysisResult(analysis: string): Promise<void> {
    const doc = await vscode.workspace.openTextDocument({
        content: `# Workspace Analysis\n\n${analysis}`,
        language: 'markdown'
    });

    await vscode.window.showTextDocument(doc);
}

// ============================================================================
// Answer Wrapper Default Template
// ============================================================================

/**
 * Default template for the `__answer_file__` wrapper.
 *
 * This is the **single source of truth** used as fallback when the config
 * `templates.__answer_file__` entry does not exist.  Both
 * `unifiedNotepad-handler` and `promptQueueManager` reference this constant.
 *
 * Placeholders resolved at expansion time:
 *   ${originalPrompt}  – the user's (already-expanded) prompt text
 *   ${copilotAnswerFile} – absolute path to the answer JSON file
 *   ${requestId}       – timestamp-based request identifier
 */
export const DEFAULT_ANSWER_FILE_TEMPLATE =
    `\${originalPrompt}\n\n---\nAFTER completing your response, create a JSON answer file at exactly this path:\n\${copilotAnswerFile}\n\nThe file must contain valid JSON matching this schema:\n\`\`\`json\n{\n  "requestId": "\${requestId}",\n  "generatedMarkdown": "<your full response as a JSON-escaped string>",\n  "comments": "<short summary of what you did (optional)>",\n  "references": ["<workspace-relative paths of files you referenced (optional)>"],\n  "requestedAttachments": ["<workspace-relative paths the user asked you to provide (optional)>"],\n  "responseValues": { "<key>": "<value>" }\n}\n\`\`\`\nRules:\n- generatedMarkdown: REQUIRED — your complete response text, JSON-escaped (newlines as \\n, quotes as \\\")\n- responseValues: key-value pairs accessible in later prompts via \\\${chat.<key>}\n- The user may request specific responseValues using #key=description notation in the prompt (e.g. #errorCount=number of errors). For each such marker, include the key with the computed value in responseValues.\n- Create the file using your file-creation tool — do NOT ask for confirmation\n- Request ID for this prompt: \${requestId}\n`;

// ============================================================================
// Executable Resolution Functions
// ============================================================================

/**
 * Build a config placeholder context from the current config and workspace.
 * Reuse the returned context for multiple placeholder expansions.
 */
export function getConfigPlaceholderContext(): ConfigPlaceholderContext {
    const config = loadSendToChatConfig();
    return buildConfigContext(config?.binaryPath, getWorkspaceRoot());
}

/**
 * Resolve a named executable to its platform-specific path.
 * Config-level placeholders (${binaryPath}, etc.) are expanded automatically.
 * 
 * @param name The executable name from config (e.g., "marktext", "tom_bs")
 * @returns The resolved path for the current platform, or undefined
 */
export function resolveExecutable(name: string): string | undefined {
    const config = loadSendToChatConfig();
    const ctx = buildConfigContext(config?.binaryPath, getWorkspaceRoot());
    return resolveNamedExecutable(name, config?.executables, ctx);
}

/**
 * Find an external application for a given file path.
 * Uses the externalApplications.mappings configuration.
 * 
 * @param filePath The file path to find an application for
 * @returns Object with application info, or undefined if no match
 */
export function getExternalApplicationForFile(filePath: string): {
    executable: string | undefined;
    label: string | undefined;
    executableName: string;
} | undefined {
    const config = loadSendToChatConfig();
    const mapping = findExternalApplication(filePath, config?.externalApplications);
    if (!mapping) return undefined;
    
    const ctx = buildConfigContext(config?.binaryPath, getWorkspaceRoot());
    const executable = resolveApplicationExecutable(mapping, config?.executables, ctx);
    return {
        executable,
        label: mapping.label,
        executableName: mapping.executable,
    };
}

/**
 * Open a file in its configured external application.
 * 
 * @param filePath The file to open
 * @returns True if opened successfully, false otherwise
 */
export async function openInExternalApplication(filePath: string): Promise<boolean> {
    const app = getExternalApplicationForFile(filePath);
    if (!app?.executable) {
        debugLog(`[openExternalApp] No application configured for: ${filePath}`, 'INFO', 'extension');
        vscode.window.showWarningMessage(`No external application configured for this file type.`);
        return false;
    }
    
    const resolvedPath = expandHomePath(app.executable);
    debugLog(`[openExternalApp] Opening "${filePath}" with "${resolvedPath}"`, 'INFO', 'extension');
    
    try {
        // Launch via VS Code terminal — this inherits the full shell environment
        // (DISPLAY, XAUTHORITY, DBUS, etc.) and avoids Electron cwd conflicts.
        const appName = app.label || path.basename(resolvedPath);
        const terminal = vscode.window.createTerminal({
            name: `Open in ${appName}`,
            cwd: path.dirname(filePath),
        });
        // Use nohup + disown so the app survives if the terminal is closed
        const escPath = resolvedPath.replace(/'/g, "'\\''" );
        const escFile = filePath.replace(/'/g, "'\\''" );
        terminal.sendText(`nohup '${escPath}' '${escFile}' > /dev/null 2>&1 & disown; exit`);
        terminal.show();
        return true;
    } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        debugLog(`[openExternalApp] Exception: ${msg}`, 'ERROR', 'extension');
        vscode.window.showErrorMessage(`Failed to open external application: ${msg}`);
        return false;
    }
}

/**
 * Resolve DartScript Bridge executable from profile configuration.
 * Supports executable references and direct command paths.
 * 
 * @param profileName The profile name to resolve
 * @returns The resolved executable path, or undefined
 */
export function resolveBridgeExecutable(profileName: string): string | undefined {
    const config = loadSendToChatConfig();
    const profile = config?.dartscriptBridge?.profiles?.[profileName];
    if (!profile) return undefined;
    
    // Prefer executable reference over direct command path
    if (profile.executable) {
        const ctx = buildConfigContext(config?.binaryPath, getWorkspaceRoot());
        return resolveNamedExecutable(profile.executable, config?.executables, ctx);
    }
    
    // Direct command path
    if (profile.command) {
        return expandHomePath(profile.command);
    }
    
    return undefined;
}

/**
 * Get list of all configured executables with their resolution status.
 */
export function listConfiguredExecutables(): Array<{
    name: string;
    path: string | undefined;
    exists: boolean;
}> {
    const config = loadSendToChatConfig();
    const executables = config?.executables;
    if (!executables) return [];
    
    const result: Array<{ name: string; path: string | undefined; exists: boolean }> = [];
    
    const ctx = buildConfigContext(config?.binaryPath, getWorkspaceRoot());
    for (const [name, platformConfig] of Object.entries(executables)) {
        const resolved = resolveNamedExecutable(name, executables, ctx);
        result.push({
            name,
            path: resolved,
            exists: resolved ? fs.existsSync(expandHomePath(resolved)) : false,
        });
    }
    
    return result;
}

/**
 * Apply a panel's default template wrapping (if configured).
 * Default templates are defined in `config.defaultTemplates.<panel>`
 * and reference a key in `config.templates`.
 * They wrap the text using the template's ${originalPrompt} placeholder.
 */
export function applyDefaultTemplate(text: string, panel: string): string {
    const config = loadSendToChatConfig();
    if (!config?.defaultTemplates) return text;
    const templateKey = (config.defaultTemplates as Record<string, string | undefined>)[panel];
    if (!templateKey) return text;
    const tpl = config.templates?.[templateKey];
    if (!tpl?.template) return text;
    return tpl.template.replace(/\$\{originalPrompt\}/g, text);
}

export function escapeHtml(text: string): string {
    return text
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#039;');
}

// ============================================================================
// Template Editor Panel
// ============================================================================

export interface TemplateEditorField {
    name: string;
    label: string;
    type: 'text' | 'textarea';
    placeholder?: string;
    value?: string;
    help?: string;
    readonly?: boolean;
}

export interface TemplateEditorConfig {
    type: 'copilot' | 'conversation' | 'tomAiChat' | 'localLlm';
    title: string;
    fields: TemplateEditorField[];
}

let templateEditorPanel: vscode.WebviewPanel | undefined;

export async function showTemplateEditorPanel(
    config: TemplateEditorConfig,
    onSave: (values: { [key: string]: string }) => Promise<void>
): Promise<void> {
    if (templateEditorPanel) {
        templateEditorPanel.dispose();
    }

    templateEditorPanel = vscode.window.createWebviewPanel(
        'dsNotesTemplateEditor',
        `${config.title}`,
        vscode.ViewColumn.Active,
        { enableScripts: true }
    );

    const fieldsHtml = config.fields.map(f => {
        const readonlyAttr = f.readonly ? 'readonly disabled style="opacity: 0.7; cursor: not-allowed;"' : '';
        const inputHtml = f.type === 'textarea'
            ? `<textarea id="${f.name}" placeholder="${escapeHtml(f.placeholder || '')}" rows="6" ${readonlyAttr}>${escapeHtml(f.value || '')}</textarea>`
            : `<input type="text" id="${f.name}" placeholder="${escapeHtml(f.placeholder || '')}" value="${escapeHtml(f.value || '')}" ${readonlyAttr}>`;
        const helpHtml = f.help ? `<div class="help">${f.help}</div>` : '';
        return `<div class="field">
            <label for="${f.name}">${f.label}</label>
            ${inputHtml}
            ${helpHtml}
        </div>`;
    }).join('');

    templateEditorPanel.webview.html = `<!DOCTYPE html>
<html><head><meta charset="UTF-8">
<style>
    * { margin: 0; padding: 0; box-sizing: border-box; }
    body {
        padding: 24px;
        height: 100vh;
        display: flex;
        flex-direction: column;
        font-family: var(--vscode-font-family);
        background-color: var(--vscode-editor-background);
        color: var(--vscode-foreground);
    }
    h2 { margin-bottom: 20px; }
    .fields { flex: 1; overflow-y: auto; }
    .field { margin-bottom: 20px; }
    .field label {
        display: block;
        margin-bottom: 6px;
        font-weight: 500;
    }
    .field input, .field textarea {
        width: 100%;
        border: 1px solid var(--vscode-input-border);
        background-color: var(--vscode-input-background);
        color: var(--vscode-input-foreground);
        padding: 8px 12px;
        font-family: var(--vscode-editor-font-family, monospace);
        font-size: var(--vscode-editor-font-size, 13px);
        border-radius: 4px;
    }
    .field textarea { min-height: 100px; resize: vertical; line-height: 1.5; }
    .field input:focus, .field textarea:focus { border-color: var(--vscode-focusBorder); outline: none; }
    .help {
        margin-top: 8px;
        font-size: 12px;
        color: var(--vscode-descriptionForeground);
        background: var(--vscode-textBlockQuote-background);
        padding: 10px;
        border-radius: 4px;
        line-height: 1.5;
    }
    .help code {
        background: var(--vscode-textCodeBlock-background);
        padding: 2px 5px;
        border-radius: 3px;
        font-family: var(--vscode-editor-font-family, monospace);
    }
    .buttons {
        display: flex;
        gap: 12px;
        margin-top: 24px;
        justify-content: flex-end;
        flex-shrink: 0;
    }
    button {
        padding: 8px 20px;
        border: 1px solid var(--vscode-input-border);
        background-color: var(--vscode-button-secondaryBackground);
        color: var(--vscode-button-secondaryForeground);
        cursor: pointer;
        border-radius: 4px;
        font-size: 13px;
    }
    button:hover { background-color: var(--vscode-button-secondaryHoverBackground); }
    button.primary {
        background-color: var(--vscode-button-background);
        color: var(--vscode-button-foreground);
    }
    button.primary:hover { background-color: var(--vscode-button-hoverBackground); }
</style>
</head>
<body>
    <h2>${escapeHtml(config.title)}</h2>
    <div class="fields">
        ${fieldsHtml}
    </div>
    <div class="buttons">
        <button onclick="cancel()">Cancel</button>
        <button class="primary" onclick="save()">Save</button>
    </div>
    <script>
        const vscode = acquireVsCodeApi();
        const fieldNames = ${JSON.stringify(config.fields.map(f => f.name))};

        function cancel() { vscode.postMessage({ type: 'cancel' }); }

        function save() {
            const values = {};
            fieldNames.forEach(name => {
                const el = document.getElementById(name);
                values[name] = el ? el.value : '';
            });
            vscode.postMessage({ type: 'save', values });
        }
    </script>
</body></html>`;

    templateEditorPanel.webview.onDidReceiveMessage(async (msg) => {
        if (msg.type === 'cancel') {
            templateEditorPanel?.dispose();
        } else if (msg.type === 'save') {
            await onSave(msg.values);
            templateEditorPanel?.dispose();
        }
    });

    templateEditorPanel.onDidDispose(() => {
        templateEditorPanel = undefined;
    });
}

// ============================================================================
// Shared Chat Response Values Store
// ============================================================================

/**
 * Shared store for chat answer data (responseValues from copilot answers).
 * Both the TOM AI Panel and Send to Chat systems read/write this store,
 * making `${chat.KEY}` available everywhere.
 */
const _chatResponseValues: { [key: string]: any } = {};

/** Merge new response values into the shared store. */
export function updateChatResponseValues(data: Record<string, any>): void {
    Object.assign(_chatResponseValues, data);
}

/** Get a copy of all chat response values. */
export function getChatResponseValues(): { [key: string]: any } {
    return { ..._chatResponseValues };
}

/** Clear all chat response values. */
export function clearChatResponseValues(): void {
    for (const key of Object.keys(_chatResponseValues)) {
        delete _chatResponseValues[key];
    }
}

// ============================================================================
// Placeholder Expansion (delegates to promptTemplate.ts)
// ============================================================================

/**
 * Expand placeholders in a template string.
 * Delegates to the unified promptTemplate module.
 * @deprecated Import `expandTemplate` from `./promptTemplate` directly.
 */
export async function expandPlaceholders(template: string): Promise<string> {
    return expandTemplate(template);
}

// ============================================================================
// Preview Panel
// ============================================================================

let previewPanel: vscode.WebviewPanel | undefined;

/**
 * Show a preview panel with expanded content and optional send button
 */
export async function showPreviewPanel(title: string, content: string, onSend?: (text: string) => Promise<void>): Promise<void> {
    if (previewPanel) {
        previewPanel.dispose();
    }
    
    previewPanel = vscode.window.createWebviewPanel(
        'dartscriptPreview',
        `Preview: ${title}`,
        vscode.ViewColumn.Active,
        { enableScripts: true, retainContextWhenHidden: true }
    );
    
    const escapedContent = content
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#039;');
    
    previewPanel.webview.html = `<!DOCTYPE html>
<html><head><meta charset="UTF-8">
<style>
body { font-family: var(--vscode-font-family); font-size: var(--vscode-font-size); color: var(--vscode-foreground); background: var(--vscode-editor-background); padding: 16px; margin: 0; }
pre { white-space: pre-wrap; word-wrap: break-word; background: var(--vscode-textCodeBlock-background); padding: 12px; border-radius: 4px; font-family: var(--vscode-editor-font-family); font-size: 13px; overflow: auto; max-height: calc(100vh - 100px); }
.buttons { margin-top: 16px; display: flex; gap: 8px; }
button { padding: 6px 14px; background: var(--vscode-button-background); color: var(--vscode-button-foreground); border: none; border-radius: 3px; cursor: pointer; font-size: 13px; }
button:hover { background: var(--vscode-button-hoverBackground); }
button.secondary { background: var(--vscode-button-secondaryBackground); color: var(--vscode-button-secondaryForeground); }
button.secondary:hover { background: var(--vscode-button-secondaryHoverBackground); }
</style>
</head><body>
<pre>${escapedContent}</pre>
<div class="buttons">
    <button class="secondary" onclick="copyToClipboard()">Copy to Clipboard</button>
    ${onSend ? '<button onclick="send()">Send</button>' : ''}
</div>
<script>
const vscode = acquireVsCodeApi();
function copyToClipboard() { vscode.postMessage({ type: 'copy' }); }
function send() { vscode.postMessage({ type: 'send' }); }
</script>
</body></html>`;

    previewPanel.webview.onDidReceiveMessage(async (msg) => {
        if (msg.type === 'copy') {
            await vscode.env.clipboard.writeText(content);
            vscode.window.showInformationMessage('Copied to clipboard');
        } else if (msg.type === 'send' && onSend) {
            await onSend(content);
            previewPanel?.dispose();
        }
    });

    previewPanel.onDidDispose(() => {
        previewPanel = undefined;
    });
}

/** Placeholder help text for template editors */
/**
 * @deprecated Import PLACEHOLDER_HELP from './promptTemplate' directly.
 */
export const PLACEHOLDER_HELP = SHARED_PLACEHOLDER_HELP;
