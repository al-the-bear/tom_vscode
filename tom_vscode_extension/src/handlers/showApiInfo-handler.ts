/**
 * Handler for showing VS Code API information.
 * 
 * Provides a command to display comprehensive information about available
 * Language Models, Tools, Chat Participants, and Extensions to the output channel.
 */

import * as vscode from 'vscode';
import { bridgeLog } from './handler_shared';

/**
 * Show comprehensive information about VS Code's AI and Chat APIs.
 * 
 * This command gathers and displays:
 * - Available Language Models (via lm.selectChatModels)
 * - Registered Tools (via lm.tools)
 * - Installed Extensions (with relevance to AI/Chat)
 * - Chat-related capabilities
 */
export async function showApiInfoHandler(): Promise<void> {
    const output = vscode.window.createOutputChannel('VS Code API Info', { log: true });
    output.show();
    
    output.appendLine('═══════════════════════════════════════════════════════════════════════════════');
    output.appendLine('                        VS Code API Information');
    output.appendLine('═══════════════════════════════════════════════════════════════════════════════');
    output.appendLine(`Timestamp: ${new Date().toISOString()}`);
    output.appendLine('');

    // ═══════════════════════════════════════════════════════════════════════════
    // Language Models
    // ═══════════════════════════════════════════════════════════════════════════
    output.appendLine('┌─────────────────────────────────────────────────────────────────────────────┐');
    output.appendLine('│                           LANGUAGE MODELS                                   │');
    output.appendLine('└─────────────────────────────────────────────────────────────────────────────┘');
    
    try {
        // Get all available models (no filter)
        const models = await vscode.lm.selectChatModels();
        
        if (models.length === 0) {
            output.appendLine('  No language models available.');
            output.appendLine('  (You may need to sign in to GitHub Copilot or install a language model provider)');
        } else {
            output.appendLine(`  Found ${models.length} language model(s):`);
            output.appendLine('');
            
            for (const model of models) {
                output.appendLine(`  ┌── Model: ${model.name}`);
                output.appendLine(`  │   ID:              ${model.id}`);
                output.appendLine(`  │   Vendor:          ${model.vendor}`);
                output.appendLine(`  │   Family:          ${model.family}`);
                output.appendLine(`  │   Version:         ${model.version}`);
                output.appendLine(`  │   Max Input Tokens: ${model.maxInputTokens.toLocaleString()}`);
                output.appendLine(`  └──`);
                output.appendLine('');
            }
        }
    } catch (error) {
        output.appendLine(`  Error fetching models: ${error}`);
    }
    output.appendLine('');

    // ═══════════════════════════════════════════════════════════════════════════
    // Registered Tools
    // ═══════════════════════════════════════════════════════════════════════════
    output.appendLine('┌─────────────────────────────────────────────────────────────────────────────┐');
    output.appendLine('│                           REGISTERED TOOLS                                  │');
    output.appendLine('└─────────────────────────────────────────────────────────────────────────────┘');
    
    try {
        const tools = vscode.lm.tools;
        
        if (tools.length === 0) {
            output.appendLine('  No tools registered.');
        } else {
            output.appendLine(`  Found ${tools.length} registered tool(s):`);
            output.appendLine('');
            
            // Group tools by prefix (extension)
            const toolsByPrefix: Map<string, vscode.LanguageModelToolInformation[]> = new Map();
            for (const tool of tools) {
                const prefix = tool.name.includes('_') 
                    ? tool.name.split('_')[0] 
                    : 'core';
                if (!toolsByPrefix.has(prefix)) {
                    toolsByPrefix.set(prefix, []);
                }
                toolsByPrefix.get(prefix)!.push(tool);
            }
            
            // Sort prefixes
            const sortedPrefixes = [...toolsByPrefix.keys()].sort();
            
            for (const prefix of sortedPrefixes) {
                const prefixTools = toolsByPrefix.get(prefix)!;
                output.appendLine(`  ═══ ${prefix} (${prefixTools.length} tools) ═══`);
                
                for (const tool of prefixTools) {
                    output.appendLine(`  ┌── Tool: ${tool.name}`);
                    output.appendLine(`  │   Description: ${tool.description}`);
                    
                    if (tool.tags && tool.tags.length > 0) {
                        output.appendLine(`  │   Tags: ${tool.tags.join(', ')}`);
                    }
                    
                    if (tool.inputSchema) {
                        const schemaStr = JSON.stringify(tool.inputSchema, null, 2)
                            .split('\n')
                            .map((line, i) => i === 0 ? line : `  │   ${line}`)
                            .join('\n');
                        output.appendLine(`  │   Input Schema:`);
                        output.appendLine(`  │   ${schemaStr}`);
                    }
                    
                    output.appendLine(`  └──`);
                    output.appendLine('');
                }
            }
        }
    } catch (error) {
        output.appendLine(`  Error fetching tools: ${error}`);
    }
    output.appendLine('');

    // ═══════════════════════════════════════════════════════════════════════════
    // AI/Chat Related Extensions
    // ═══════════════════════════════════════════════════════════════════════════
    output.appendLine('┌─────────────────────────────────────────────────────────────────────────────┐');
    output.appendLine('│                     AI/CHAT RELATED EXTENSIONS                              │');
    output.appendLine('└─────────────────────────────────────────────────────────────────────────────┘');
    
    try {
        const allExtensions = vscode.extensions.all;
        
        // Filter for AI/Chat related extensions
        const aiKeywords = ['copilot', 'chat', 'ai', 'gpt', 'llm', 'language-model', 'openai', 'anthropic', 'claude', 'gemini', 'codeium', 'tabnine', 'mcp'];
        const aiExtensions = allExtensions.filter(ext => {
            const id = ext.id.toLowerCase();
            const name = (ext.packageJSON.displayName || '').toLowerCase();
            return aiKeywords.some(kw => id.includes(kw) || name.includes(kw));
        });
        
        if (aiExtensions.length === 0) {
            output.appendLine('  No AI/Chat related extensions found.');
        } else {
            output.appendLine(`  Found ${aiExtensions.length} AI/Chat related extension(s):`);
            output.appendLine('');
            
            for (const ext of aiExtensions) {
                const pkg = ext.packageJSON;
                output.appendLine(`  ┌── ${pkg.displayName || ext.id}`);
                output.appendLine(`  │   ID:        ${ext.id}`);
                output.appendLine(`  │   Version:   ${pkg.version}`);
                output.appendLine(`  │   Active:    ${ext.isActive ? 'Yes' : 'No'}`);
                
                // Check for chat participants
                if (pkg.contributes?.chatParticipants) {
                    const participants = pkg.contributes.chatParticipants;
                    output.appendLine(`  │   Chat Participants: ${participants.map((p: any) => '@' + p.id).join(', ')}`);
                }
                
                // Check for language model tools
                if (pkg.contributes?.languageModelTools) {
                    const tools = pkg.contributes.languageModelTools;
                    output.appendLine(`  │   LM Tools: ${tools.map((t: any) => t.name).join(', ')}`);
                }
                
                // Check for commands (just count)
                if (pkg.contributes?.commands) {
                    output.appendLine(`  │   Commands: ${pkg.contributes.commands.length} registered`);
                }
                
                output.appendLine(`  └──`);
                output.appendLine('');
            }
        }
    } catch (error) {
        output.appendLine(`  Error fetching extensions: ${error}`);
    }
    output.appendLine('');

    // ═══════════════════════════════════════════════════════════════════════════
    // MCP Servers (if configured)
    // ═══════════════════════════════════════════════════════════════════════════
    output.appendLine('┌─────────────────────────────────────────────────────────────────────────────┐');
    output.appendLine('│                           MCP SERVERS                                       │');
    output.appendLine('└─────────────────────────────────────────────────────────────────────────────┘');
    
    try {
        // Check workspace settings for MCP configuration
        const mcpConfig = vscode.workspace.getConfiguration('mcp');
        const servers = mcpConfig.get<Record<string, any>>('servers');
        
        if (servers && Object.keys(servers).length > 0) {
            output.appendLine(`  Found ${Object.keys(servers).length} MCP server(s) configured:`);
            output.appendLine('');
            
            for (const [name, config] of Object.entries(servers)) {
                output.appendLine(`  ┌── Server: ${name}`);
                if (config.command) {
                    output.appendLine(`  │   Command: ${config.command} ${(config.args || []).join(' ')}`);
                }
                if (config.url) {
                    output.appendLine(`  │   URL: ${config.url}`);
                }
                output.appendLine(`  └──`);
            }
        } else {
            output.appendLine('  No MCP servers configured in settings.');
            output.appendLine('  (Configure via settings.json: "mcp.servers": { ... })');
        }
    } catch (error) {
        output.appendLine(`  Error checking MCP config: ${error}`);
    }
    output.appendLine('');

    // ═══════════════════════════════════════════════════════════════════════════
    // VS Code Version & Environment
    // ═══════════════════════════════════════════════════════════════════════════
    output.appendLine('┌─────────────────────────────────────────────────────────────────────────────┐');
    output.appendLine('│                           ENVIRONMENT                                       │');
    output.appendLine('└─────────────────────────────────────────────────────────────────────────────┘');
    
    output.appendLine(`  VS Code Version:    ${vscode.version}`);
    output.appendLine(`  UI Kind:            ${vscode.env.uiKind === vscode.UIKind.Desktop ? 'Desktop' : 'Web'}`);
    output.appendLine(`  App Name:           ${vscode.env.appName}`);
    output.appendLine(`  App Host:           ${vscode.env.appHost}`);
    output.appendLine(`  Language:           ${vscode.env.language}`);
    output.appendLine(`  Machine ID:         ${vscode.env.machineId.substring(0, 8)}...`);
    output.appendLine(`  Session ID:         ${vscode.env.sessionId.substring(0, 8)}...`);
    output.appendLine(`  Remote Name:        ${vscode.env.remoteName || 'None (local)'}`);
    output.appendLine(`  Shell:              ${vscode.env.shell}`);
    output.appendLine('');

    // ═══════════════════════════════════════════════════════════════════════════
    // Workspace Information
    // ═══════════════════════════════════════════════════════════════════════════
    output.appendLine('┌─────────────────────────────────────────────────────────────────────────────┐');
    output.appendLine('│                           WORKSPACE                                         │');
    output.appendLine('└─────────────────────────────────────────────────────────────────────────────┘');
    
    const workspaceFolders = vscode.workspace.workspaceFolders;
    if (workspaceFolders) {
        output.appendLine(`  Workspace Folders: ${workspaceFolders.length}`);
        for (const folder of workspaceFolders) {
            output.appendLine(`    - ${folder.name}: ${folder.uri.fsPath}`);
        }
    } else {
        output.appendLine('  No workspace folders open.');
    }
    
    output.appendLine(`  Is Trusted:         ${vscode.workspace.isTrusted}`);
    output.appendLine(`  Workspace File:     ${vscode.workspace.workspaceFile?.fsPath || 'None'}`);
    output.appendLine('');

    // ═══════════════════════════════════════════════════════════════════════════
    // Summary
    // ═══════════════════════════════════════════════════════════════════════════
    output.appendLine('═══════════════════════════════════════════════════════════════════════════════');
    output.appendLine('                              SUMMARY                                          ');
    output.appendLine('═══════════════════════════════════════════════════════════════════════════════');
    
    try {
        const models = await vscode.lm.selectChatModels();
        const tools = vscode.lm.tools;
        const aiExtensions = vscode.extensions.all.filter(ext => {
            const id = ext.id.toLowerCase();
            return ['copilot', 'chat', 'ai', 'gpt', 'llm'].some(kw => id.includes(kw));
        });
        
        output.appendLine(`  Language Models:     ${models.length}`);
        output.appendLine(`  Registered Tools:    ${tools.length}`);
        output.appendLine(`  AI Extensions:       ${aiExtensions.length}`);
        output.appendLine(`  Total Extensions:    ${vscode.extensions.all.length}`);
    } catch (error) {
        output.appendLine(`  Error generating summary: ${error}`);
    }
    
    output.appendLine('');
    output.appendLine('═══════════════════════════════════════════════════════════════════════════════');
    
    bridgeLog('API information displayed in "VS Code API Info" output channel');
    vscode.window.showInformationMessage('API information displayed in "VS Code API Info" output channel');
}
