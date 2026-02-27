/**
 * VS Code Language Model Tool registration.
 *
 * All tool logic lives in tool-executors.ts (SharedToolDefinitions).
 * This file wraps them for VS Code LM registration and re-exports
 * the TodoManager accessors used by tomAiChat-handler.
 */

import * as vscode from 'vscode';
import { toVsCodeTool } from './shared-tool-registry';
import {
    ALL_SHARED_TOOLS,
    setActiveTodoManager,
    getActiveTodoManager,
} from './tool-executors';

// Re-export TodoManager accessors so existing importers still work.
export { setActiveTodoManager, getActiveTodoManager };

// ============================================================================
// Tool Registration
// ============================================================================

/**
 * Register all Tom AI Chat tools with VS Code.
 * Uses SharedToolDefinitions from tool-executors.ts, converting each to
 * a vscode.LanguageModelTool via the shared registry adapter.
 */
export function registerTomAiChatTools(context: vscode.ExtensionContext): void {
    for (const tool of ALL_SHARED_TOOLS) {
        context.subscriptions.push(
            vscode.lm.registerTool(tool.name, toVsCodeTool(tool)),
        );
    }
}
