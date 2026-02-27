/**
 * Send to Chat Advanced - Configuration and dynamic menu management
 * 
 * Provides configurable prompt templates for sending text to Copilot Chat
 * with customizable prefixes and suffixes.
 */

import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import { getConfigPath, updateChatResponseValues, clearChatResponseValues } from './handler_shared';
import { logCopilotAnswer, isTrailEnabled, loadTrailConfig } from './trailLogger-handler';
import {
    resolveTemplate,
    formatDateTime,
    getChatAnswerFolder,
} from './promptTemplate';

/**
 * Configuration entry for a send-to-chat template.
 *
 * Preferred format: a single `template` string containing `${originalPrompt}`
 * where the user's content will be inserted.
 *
 * Legacy format: separate `prefix` and `suffix` strings that are concatenated
 * around the content (automatically converted to a template internally).
 */
export interface SendToChatTemplate {
    /** Single template with ${originalPrompt} placeholder (preferred). */
    template?: string;
    /** @deprecated Use `template` with ${originalPrompt} instead. */
    prefix?: string;
    /** @deprecated Use `template` with ${originalPrompt} instead. */
    suffix?: string;
    /** If true, this template gets its own static menu entry (requires extension reload) */
    showInMenu?: boolean;
}

/**
 * Full configuration file structure with optional default
 */
export interface SendToChatFullConfig {
    /** Name of the default template to use for Standard Template command */
    default?: string;
    /** Template definitions */
    templates: { [menuLabel: string]: SendToChatTemplate };
}

/**
 * Legacy configuration file structure (templates at root level)
 */
export interface SendToChatLegacyConfig {
    [menuLabel: string]: SendToChatTemplate;
}

/**
 * Parsed content from selected text (JSON, YAML, or colon-delimited)
 */
export interface ParsedContent {
    preamble?: string;
    data: { [key: string]: any };
}

/**
 * Manages send-to-chat configuration and dynamic menu generation
 */
export class SendToChatAdvancedManager {
    private templates: { [menuLabel: string]: SendToChatTemplate } = {};
    private defaultTemplateName: string | undefined;
    private configWatcher: vscode.FileSystemWatcher | undefined;
    private registeredCommands: vscode.Disposable[] = [];
    private context: vscode.ExtensionContext;
    private outputChannel: vscode.OutputChannel | undefined;
    
    /** Static accumulated data from chat answer files */
    private static chatAnswerData: { [key: string]: any } = {};

    constructor(context: vscode.ExtensionContext, outputChannel?: vscode.OutputChannel) {
        this.context = context;
        this.outputChannel = outputChannel;
    }

    /**
     * Initialize the manager - load config and set up file watcher
     */
    async initialize(): Promise<void> {
        await this.loadConfig();
        this.setupFileWatcher();
        this.registerCommands();
    }

    /**
     * Get the configuration file path
     */
    private getConfigPath(): string | undefined {
        return getConfigPath();
    }

    /**
     * Load configuration from JSON file
     * Supports both legacy format (templates at root) and new format (with default and templates)
     */
    async loadConfig(): Promise<void> {
        const configPath = this.getConfigPath();
        if (!configPath) {
            this.log('No workspace folder found, skipping config load');
            return;
        }

        try {
            if (!fs.existsSync(configPath)) {
                this.log(`Config file not found: ${configPath}`);
                this.templates = {};
                this.defaultTemplateName = undefined;
                return;
            }

            const content = fs.readFileSync(configPath, 'utf-8');
            const parsed = JSON.parse(content);
            
            // Store old values to check if anything changed
            const oldTemplates = JSON.stringify(this.templates);
            const oldDefault = this.defaultTemplateName;
            
            // Check for new format (has 'templates' key) vs legacy format
            if (parsed.templates && typeof parsed.templates === 'object') {
                // New format with default and templates
                if (!this.validateTemplates(parsed.templates)) {
                    vscode.window.showErrorMessage('Invalid tom_vscode_extension.json format. Each template must have "prefix" and "suffix" strings.');
                    this.templates = {};
                    return;
                }
                this.templates = parsed.templates;
                this.defaultTemplateName = typeof parsed.default === 'string' ? parsed.default : undefined;
            } else {
                // Legacy format - templates at root level
                if (!this.validateTemplates(parsed)) {
                    vscode.window.showErrorMessage('Invalid tom_vscode_extension.json format. Each entry must have "prefix" and "suffix" strings.');
                    this.templates = {};
                    return;
                }
                this.templates = parsed;
                this.defaultTemplateName = undefined;
            }

            // Only log and re-register if something actually changed
            const newTemplates = JSON.stringify(this.templates);
            if (oldTemplates !== newTemplates || oldDefault !== this.defaultTemplateName) {
                this.log(`Loaded ${Object.keys(this.templates).length} templates from ${configPath}${this.defaultTemplateName ? `, default: ${this.defaultTemplateName}` : ''}`);
                
                // Re-register commands with new config
                this.registerCommands();
            }

        } catch (error: any) {
            this.log(`Error loading config: ${error.message}`, 'ERROR');
            vscode.window.showErrorMessage(`Error loading tom_vscode_extension.json: ${error.message}`);
            this.templates = {};
        }
    }

    /**
     * Validate templates structure.
     * Accepts both new format (template) and legacy format (prefix/suffix).
     */
    private validateTemplates(templates: any): templates is { [key: string]: SendToChatTemplate } {
        if (typeof templates !== 'object' || templates === null) {
            return false;
        }

        for (const key of Object.keys(templates)) {
            // Skip non-template keys
            if (key === 'default') {
                continue;
            }
            
            const entry = templates[key];
            if (typeof entry !== 'object' || entry === null) {
                return false;
            }
            // Must have either 'template' or both 'prefix' and 'suffix'
            const hasTemplate = typeof entry.template === 'string';
            const hasLegacy = typeof entry.prefix === 'string' && typeof entry.suffix === 'string';
            if (!hasTemplate && !hasLegacy) {
                return false;
            }
            // showInMenu is optional boolean
            if (entry.showInMenu !== undefined && typeof entry.showInMenu !== 'boolean') {
                return false;
            }
        }

        return true;
    }

    /**
     * Set up file watcher for config changes
     */
    private setupFileWatcher(): void {
        const configPath = this.getConfigPath();
        if (!configPath) {
            return;
        }

        // Watch the specific file
        const configDir = path.dirname(configPath);
        const configFile = path.basename(configPath);
        
        this.configWatcher = vscode.workspace.createFileSystemWatcher(
            new vscode.RelativePattern(configDir, configFile)
        );

        let debounceTimer: NodeJS.Timeout | undefined;
        const debounceReload = () => {
            if (debounceTimer) {
                clearTimeout(debounceTimer);
            }
            debounceTimer = setTimeout(() => {
                this.loadConfig();
            }, 500);
        };

        this.configWatcher.onDidChange(debounceReload);
        this.configWatcher.onDidCreate(debounceReload);
        this.configWatcher.onDidDelete(() => {
            this.templates = {};
            this.defaultTemplateName = undefined;
            this.registerCommands();
        });

        this.context.subscriptions.push(this.configWatcher);
    }

    /**
     * Register dynamic commands for each template
     */
    private registerCommands(): void {
        // Dispose old commands
        for (const cmd of this.registeredCommands) {
            cmd.dispose();
        }
        this.registeredCommands = [];

        // Register main command that shows QuickPick with templates
        const mainCmd = vscode.commands.registerCommand('tomAi.sendToCopilot.template', async () => {
            await this.showTemplateQuickPick();
        });
        this.registeredCommands.push(mainCmd);
        this.context.subscriptions.push(mainCmd);

        // Register static commands for templates with showInMenu: true
        // These correspond to commands defined in package.json
        this.registerStaticMenuCommands();

        // Update menu contributions dynamically
        this.updateMenuContributions();
    }

    /**
     * Register static commands for templates with showInMenu: true
     * These are registered at extension activation and correspond to static menu entries in package.json
     */
    private registerStaticMenuCommands(): void {
        // Register the Trail Reminder command (static, defined in package.json)
        const trailReminderCmd = vscode.commands.registerCommand('tomAi.sendToCopilot.trailReminder', async () => {
            const template = this.templates['Trail Reminder'];
            if (template) {
                await this.sendToChat('Trail Reminder', template);
            } else {
                vscode.window.showWarningMessage('Trail Reminder template not found in configuration');
            }
        });
        this.registeredCommands.push(trailReminderCmd);
        this.context.subscriptions.push(trailReminderCmd);

        // Register the TODO Execution command (static, defined in package.json)
        const todoExecutionCmd = vscode.commands.registerCommand('tomAi.sendToCopilot.todoExecution', async () => {
            const template = this.templates['TODO Execution'];
            if (template) {
                await this.sendToChat('TODO Execution', template);
            } else {
                vscode.window.showWarningMessage('TODO Execution template not found in configuration');
            }
        });
        this.registeredCommands.push(todoExecutionCmd);
        this.context.subscriptions.push(todoExecutionCmd);

        // Register the Standard Template command (uses default from config, loaded dynamically)
        const standardTemplateCmd = vscode.commands.registerCommand('tomAi.sendToCopilot.standard', async () => {
            await this.sendWithDefaultTemplate();
        });
        this.registeredCommands.push(standardTemplateCmd);
        this.context.subscriptions.push(standardTemplateCmd);

        // Register submenu commands for Code Review, Explain, Add to Todo
        const codeReviewCmd = vscode.commands.registerCommand('tomAi.sendToCopilot.codeReview', async () => {
            const template = this.templates['Code Review'];
            if (template) {
                await this.sendToChat('Code Review', template);
            } else {
                vscode.window.showWarningMessage('Code Review template not found in configuration');
            }
        });
        this.registeredCommands.push(codeReviewCmd);
        this.context.subscriptions.push(codeReviewCmd);

        const explainCmd = vscode.commands.registerCommand('tomAi.sendToCopilot.explain', async () => {
            const template = this.templates['Explain Code'];
            if (template) {
                await this.sendToChat('Explain Code', template);
            } else {
                vscode.window.showWarningMessage('Explain Code template not found in configuration');
            }
        });
        this.registeredCommands.push(explainCmd);
        this.context.subscriptions.push(explainCmd);

        const addToTodoCmd = vscode.commands.registerCommand('tomAi.sendToCopilot.addToTodo', async () => {
            const template = this.templates['Add to Todo'];
            if (template) {
                await this.sendToChat('Add to Todo', template);
            } else {
                vscode.window.showWarningMessage('Add to Todo template not found in configuration');
            }
        });
        this.registeredCommands.push(addToTodoCmd);
        this.context.subscriptions.push(addToTodoCmd);

        // Register Fix Markdown here command
        const fixMarkdownCmd = vscode.commands.registerCommand('tomAi.sendToCopilot.fixMarkdown', async () => {
            const template = this.templates['Fix Markdown here'];
            if (template) {
                await this.sendToChat('Fix Markdown here', template);
            } else {
                vscode.window.showWarningMessage('Fix Markdown here template not found in configuration');
            }
        });
        this.registeredCommands.push(fixMarkdownCmd);
        this.context.subscriptions.push(fixMarkdownCmd);

        // Register Show Chat Answer Values command (command palette only)
        const showChatAnswerCmd = vscode.commands.registerCommand('tomAi.showAnswerValues', () => {
            if (this.outputChannel) {
                this.outputChannel.show();
                this.outputChannel.appendLine('=== Chat Answer Values ===');
                
                const data = SendToChatAdvancedManager.chatAnswerData;
                if (Object.keys(data).length === 0) {
                    this.outputChannel.appendLine('(No chat answer values stored)');
                } else {
                    this.outputChannel.appendLine(JSON.stringify(data, null, 2));
                }
                
                this.outputChannel.appendLine('=========================');
            }
        });
        this.registeredCommands.push(showChatAnswerCmd);
        this.context.subscriptions.push(showChatAnswerCmd);

        // Register Clear Chat Answer Values command (command palette only)
        const clearChatAnswerCmd = vscode.commands.registerCommand('tomAi.clearAnswerValues', () => {
            const keyCount = Object.keys(SendToChatAdvancedManager.chatAnswerData).length;
            SendToChatAdvancedManager.chatAnswerData = {};
            clearChatResponseValues();
            
            if (this.outputChannel) {
                this.outputChannel.appendLine(`Cleared ${keyCount} chat answer value(s)`);
            }
            vscode.window.showInformationMessage(`Cleared ${keyCount} chat answer value(s)`);
        });
        this.registeredCommands.push(clearChatAnswerCmd);
        this.context.subscriptions.push(clearChatAnswerCmd);
    }

    /**
     * Send to chat using the default template from config
     */
    private async sendWithDefaultTemplate(): Promise<void> {
        // Reload config to get latest default
        await this.loadConfig();

        if (!this.defaultTemplateName) {
            vscode.window.showWarningMessage('No default template configured. Add "default": "Template Name" to your tom_vscode_extension.json');
            return;
        }

        const template = this.templates[this.defaultTemplateName];
        if (!template) {
            vscode.window.showWarningMessage(`Default template "${this.defaultTemplateName}" not found in configuration`);
            return;
        }

        await this.sendToChat(this.defaultTemplateName, template);
    }

    /**
     * Show QuickPick with available templates
     */
    async showTemplateQuickPick(): Promise<void> {
        const templateEntries = Object.entries(this.templates);
        
        if (templateEntries.length === 0) {
            const action = await vscode.window.showWarningMessage(
                'No send-to-chat templates configured. Would you like to create a default configuration?',
                'Create Config',
                'Cancel'
            );
            if (action === 'Create Config') {
                await this.createDefaultConfig();
            }
            return;
        }

        const items: vscode.QuickPickItem[] = templateEntries.map(([label, template]) => {
            const tmpl = template as SendToChatTemplate;
            const preview = (tmpl.template || tmpl.prefix || '').substring(0, 50).replace(/\n/g, ' ') + '...';
            return { label, description: preview };
        });

        const selected = await vscode.window.showQuickPick(items, {
            placeHolder: 'Select a template to send to Copilot Chat',
            title: 'Send to Copilot Chat'
        });

        if (selected) {
            const template = this.templates[selected.label];
            if (template) {
                await this.sendToChat(selected.label, template);
            }
        }
    }

    /**
     * Update menu contributions for the submenu
     * Note: This requires package.json to have an empty submenu array that we populate via setContext
     */
    private updateMenuContributions(): void {
        // Set context with available templates for menu visibility
        const templateLabels = Object.keys(this.templates);
        vscode.commands.executeCommand('setContext', 'tomAi.sendToCopilotTemplates', templateLabels);
        vscode.commands.executeCommand('setContext', 'tomAi.hasSendToCopilotTemplates', templateLabels.length > 0);
    }

    /**
     * Send text to Copilot Chat with template
     */
    private async sendToChat(label: string, template: SendToChatTemplate): Promise<void> {
        const editor = vscode.window.activeTextEditor;
        if (!editor) {
            vscode.window.showErrorMessage('No active editor');
            return;
        }

        // Get content - selected text or full file
        let content: string;
        const selection = editor.selection;
        if (selection.isEmpty) {
            content = editor.document.getText();
        } else {
            content = editor.document.getText(selection);
        }

        // Build the full prompt using the unified template system
        const fullPrompt = this.buildPrompt(template, content);

        try {
            // Send to Copilot Chat
            await vscode.commands.executeCommand('workbench.action.chat.open', {
                query: fullPrompt
            });

            // Log to output panel
            this.log(`Sent to Copilot Chat: ${label}`);

        } catch (error: any) {
            this.log(`Error sending to chat: ${error.message}`, 'ERROR');
            vscode.window.showErrorMessage(`Failed to send to Copilot Chat: ${error.message}`);
        }
    }

    /**
     * Normalise a SendToChatTemplate to its effective template string.
     * If the template has a `template` field, use it directly.
     * Otherwise, convert legacy prefix/suffix to a template with ${originalPrompt}.
     */
    private getEffectiveTemplate(template: SendToChatTemplate): string {
        if (template.template) {
            return template.template;
        }
        // Legacy prefix/suffix → single template
        const prefix = template.prefix || '';
        const suffix = template.suffix || '';
        let result = '';
        if (prefix) {
            result += prefix;
            if (!prefix.endsWith('\n')) { result += '\n'; }
        }
        result += '${originalPrompt}';
        if (suffix) {
            result += '\n' + suffix;
        }
        return result;
    }

    /**
     * Build the full prompt by merging the template with content and resolving
     * all placeholders (content-derived values + built-in values).
     */
    private buildPrompt(template: SendToChatTemplate, content: string): string {
        // Parse content for structured data placeholders
        const parsed = this.parseContent(content);

        // Build values map: content-parsed data (flattened) + built-in values
        const values: Record<string, string> = {};

        // Flatten parsed data into values map
        this.flattenData(parsed.data, values, '');

        // Add preamble if present
        if (parsed.preamble) {
            values['preamble'] = parsed.preamble;
        }

        // Add the original prompt content
        values['originalPrompt'] = content;

        // Add built-in system values (datetime, windowId, machineId, etc.)
        const now = new Date();
        values['datetime'] = formatDateTime(now);
        values['requestId'] = values['datetime'];
        values['windowId'] = vscode.env.sessionId;
        values['machineId'] = vscode.env.machineId;
        values['chatAnswerFolder'] = getChatAnswerFolder();

        // Load chat answer file data
        this.loadChatAnswerFile();
        for (const [k, v] of Object.entries(SendToChatAdvancedManager.chatAnswerData)) {
            const str = typeof v === 'string' ? v : (v !== null && v !== undefined ? JSON.stringify(v) : '');
            values[`chat.${k}`] = str;
        }

        // Get the effective template string
        const tmpl = this.getEffectiveTemplate(template);

        // Resolve placeholders recursively (up to 10 levels)
        return resolveTemplate(tmpl, values, 10);
    }

    /**
     * Flatten a nested data object into dot-path keys in a flat record.
     */
    private flattenData(data: Record<string, any>, target: Record<string, string>, prefix: string): void {
        for (const [key, value] of Object.entries(data)) {
            const fullKey = prefix ? `${prefix}.${key}` : key;
            if (typeof value === 'object' && value !== null && !Array.isArray(value)) {
                this.flattenData(value, target, fullKey);
            } else if (typeof value === 'string') {
                target[fullKey] = value;
            } else if (value !== null && value !== undefined) {
                target[fullKey] = JSON.stringify(value);
            }
        }
    }

    /**
     * Parse content as JSON, YAML, or colon-delimited format
     */
    private parseContent(content: string): ParsedContent {
        let parsed: ParsedContent;

        // Try JSON first
        try {
            const data = JSON.parse(content);
            if (typeof data === 'object' && data !== null) {
                parsed = { data };
            } else {
                parsed = { data: {} };
            }
        } catch {
            // Try YAML-like parsing (simple key: value format)
            try {
                const yamlData = this.parseYamlLike(content);
                if (Object.keys(yamlData.data).length > 0) {
                    parsed = yamlData;
                } else {
                    // Try colon-delimited format
                    parsed = this.parseColonDelimited(content);
                }
            } catch {
                // Try colon-delimited format
                parsed = this.parseColonDelimited(content);
            }
        }

        return parsed;
    }

    /**
     * Load and parse the chat answer file, accumulating data into static map
     */
    private loadChatAnswerFile(): void {
        const workspaceFolders = vscode.workspace.workspaceFolders;
        if (!workspaceFolders || workspaceFolders.length === 0) {
            return;
        }

        const chatAnswerFolder = getChatAnswerFolder();
        const answerFilePath = path.join(
            workspaceFolders[0].uri.fsPath,
            chatAnswerFolder,
            `${vscode.env.sessionId}_${vscode.env.machineId}_answer.json`
        );

        try {
            if (!fs.existsSync(answerFilePath)) {
                return;
            }

            const content = fs.readFileSync(answerFilePath, 'utf-8');
            if (!content.trim()) {
                return;
            }

            // Try to parse as JSON first
            try {
                const jsonData = JSON.parse(content);
                if (typeof jsonData === 'object' && jsonData !== null) {
                    // Copy all top-level fields first
                    Object.assign(SendToChatAdvancedManager.chatAnswerData, jsonData);
                    
                    // If responseValues exists, also spread those keys to top-level for ${chat.KEY} access
                    if (jsonData.responseValues && typeof jsonData.responseValues === 'object') {
                        Object.assign(SendToChatAdvancedManager.chatAnswerData, jsonData.responseValues);
                    }
                    
                    // Sync to shared store so all handlers can access via ${chat.KEY}
                    updateChatResponseValues(SendToChatAdvancedManager.chatAnswerData);
                    
                    this.log(`Loaded chat answer data from ${answerFilePath}`);
                    
                    // Trail: Log Copilot answer file
                    loadTrailConfig();
                    logCopilotAnswer(answerFilePath, jsonData);
                    
                    return;
                }
            } catch {
                // Not JSON, try YAML-like
            }

            // Parse as YAML-like
            const parsed = this.parseYamlLike(content);
            if (Object.keys(parsed.data).length > 0) {
                Object.assign(SendToChatAdvancedManager.chatAnswerData, parsed.data);
                
                // Sync to shared store
                updateChatResponseValues(SendToChatAdvancedManager.chatAnswerData);
                
                this.log(`Loaded chat answer data from ${answerFilePath}`);
                
                // Trail: Log Copilot answer file (YAML format)
                loadTrailConfig();
                logCopilotAnswer(answerFilePath, parsed.data);
            }

        } catch (error: any) {
            this.log(`Error loading chat answer file: ${error.message}`, 'ERROR');
        }
    }

    /**
     * Parse simple YAML-like format (key: value pairs)
     */
    private parseYamlLike(content: string): ParsedContent {
        const lines = content.split('\n');
        const data: { [key: string]: any } = {};
        let preamble = '';
        let currentKey: string | null = null;
        let currentValue = '';
        let foundFirstKey = false;

        for (const line of lines) {
            const colonIndex = line.indexOf(':');
            const trimmedLine = line.trim();
            
            // Check if this line starts a new key (has colon and key part has no spaces or is indented)
            if (colonIndex > 0 && !line.substring(0, colonIndex).includes(' ') && trimmedLine.length > 0) {
                // Save previous key-value if exists
                if (currentKey !== null) {
                    data[currentKey] = currentValue.trim();
                }
                
                foundFirstKey = true;
                currentKey = line.substring(0, colonIndex).trim();
                currentValue = line.substring(colonIndex + 1);
            } else if (foundFirstKey && currentKey !== null) {
                // Continue current value
                currentValue += '\n' + line;
            } else {
                // Preamble (before first key)
                preamble += (preamble ? '\n' : '') + line;
            }
        }

        // Save last key-value
        if (currentKey !== null) {
            data[currentKey] = currentValue.trim();
        }

        return { preamble: preamble || undefined, data };
    }

    /**
     * Parse colon-delimited format with preamble support
     */
    private parseColonDelimited(content: string): ParsedContent {
        const lines = content.split('\n');
        const data: { [key: string]: any } = {};
        let preamble = '';
        let currentKey: string | null = null;
        let currentValue = '';
        let foundFirstKey = false;

        for (let i = 0; i < lines.length; i++) {
            const line = lines[i];
            const colonIndex = line.indexOf(':');
            
            if (colonIndex > 0) {
                // This line has a colon - could be a key
                const potentialKey = line.substring(0, colonIndex).trim();
                
                // Check if next line also has a colon (indicating this is a key line)
                const isKeyLine = potentialKey.length > 0 && !potentialKey.includes('\n');
                
                if (isKeyLine) {
                    // Save previous key-value if exists
                    if (currentKey !== null) {
                        data[currentKey] = currentValue.trim();
                    }
                    
                    foundFirstKey = true;
                    currentKey = potentialKey;
                    currentValue = line.substring(colonIndex + 1);
                    continue;
                }
            }
            
            if (foundFirstKey && currentKey !== null) {
                // Continue current value
                currentValue += '\n' + line;
            } else {
                // Preamble (before first key)
                preamble += (preamble ? '\n' : '') + line;
            }
        }

        // Save last key-value
        if (currentKey !== null) {
            data[currentKey] = currentValue.trim();
        }

        return { preamble: preamble || undefined, data };
    }

    /**
     * Get available templates for menu generation
     */
    getTemplates(): Map<string, SendToChatTemplate> {
        return new Map(Object.entries(this.templates));
    }

    /**
     * Create default configuration file
     */
    async createDefaultConfig(): Promise<void> {
        const configPath = this.getConfigPath();
        if (!configPath) {
            vscode.window.showErrorMessage('No workspace folder found');
            return;
        }

        const defaultConfig: { [key: string]: SendToChatTemplate } = {};
        
        // Use bracket notation to avoid lint errors for property names with spaces
        defaultConfig["Explain Code"] = {
            template: "Please explain the following code in detail:\n\n${originalPrompt}\n\nInclude:\n- What it does\n- Key algorithms or patterns\n- Potential issues or improvements"
        };
        defaultConfig["Review for Bugs"] = {
            template: "Review this code for bugs and security issues:\n\n${originalPrompt}\n\nFocus on:\n- Security vulnerabilities\n- Edge cases\n- Error handling\n- Performance issues"
        };
        defaultConfig["Add Unit Tests"] = {
            template: "Generate comprehensive unit tests for:\n\n${originalPrompt}\n\nRequirements:\n- High coverage\n- Test edge cases\n- Test error conditions\n- Use appropriate testing framework"
        };
        defaultConfig["Add Documentation"] = {
            template: "Add complete documentation for:\n\n${originalPrompt}\n\nInclude:\n- API documentation\n- Usage examples\n- Parameter descriptions\n- Return value descriptions"
        };
        defaultConfig["Refactor"] = {
            template: "Refactor this code for better quality:\n\n${originalPrompt}\n\nFocus on:\n- Readability\n- Maintainability\n- Performance\n- Best practices"
        };

        try {
            // Ensure directory exists
            const configDir = path.dirname(configPath);
            if (!fs.existsSync(configDir)) {
                fs.mkdirSync(configDir, { recursive: true });
            }

            fs.writeFileSync(configPath, JSON.stringify(defaultConfig, null, 2), 'utf-8');
            vscode.window.showInformationMessage(`Created default config: ${configPath}`);
            
            // Open the file for editing
            const doc = await vscode.workspace.openTextDocument(configPath);
            await vscode.window.showTextDocument(doc);

        } catch (error: any) {
            vscode.window.showErrorMessage(`Failed to create config: ${error.message}`);
        }
    }

    /**
     * Log message to output channel if available
     */
    private log(message: string, level: 'INFO' | 'ERROR' = 'INFO'): void {
        if (this.outputChannel) {
            this.outputChannel.appendLine(`[SendToChatAdvanced] [${level}] ${message}`);
        }
    }

    /**
     * Dispose resources
     */
    dispose(): void {
        for (const cmd of this.registeredCommands) {
            cmd.dispose();
        }
        this.registeredCommands = [];
        
        if (this.configWatcher) {
            this.configWatcher.dispose();
        }
    }
}
