/**
 * Scripting-API surface for the LLM tool registry.
 *
 * Exposes two operations to the Dart scripting API (via the bridge ops
 * `tools.invokeVce` and `tools.getJsonVce`):
 *
 *  - {@link invokeToolByName} — universally invoke any registered tool by
 *    name with a JSON argument object, returning the tool's string result.
 *    The call runs inside a tool-execution context so change-log entries are
 *    attributed correctly.
 *  - {@link getActiveProfileToolsJson} — generate the Anthropic-shaped tools
 *    JSON that a caller injects into a prompt. The set reflects the currently
 *    active Anthropic profile's tool settings (toolsEnabled / enabledTools).
 *    When the configured Send-to-Chat target is 'copilot', the JSON is empty.
 *
 * Both compose existing primitives (executeToolCall, toAnthropicTools,
 * resolveProfileTools) so the scripting API stays in lockstep with the chat
 * panel.
 */

import * as vscode from 'vscode';
import {
    AnthropicTool,
    toAnthropicTools,
    executeToolCall,
} from './shared-tool-registry';
import { ALL_SHARED_TOOLS, resolveProfileTools } from './tool-executors';
import { runWithToolContext } from '../services/tool-execution-context';
import {
    loadSendToChatConfig,
    getSendToChatTarget,
} from '../utils/sendToChatConfig';

/**
 * workspaceState key holding the id of the Anthropic profile currently
 * selected in the chat panel. Written by the chat panel's
 * `anthropicProfileSelected` message handler; read here to resolve the
 * active profile's tool set from outside the webview.
 */
export const ACTIVE_ANTHROPIC_PROFILE_KEY = 'tomAi.anthropic.activeProfileId';

/** Minimal profile shape needed for tool resolution. */
interface AnthropicProfileLike {
    id?: string;
    toolsEnabled?: boolean;
    enabledTools?: string[];
    isDefault?: boolean;
}

/**
 * Resolve the active Anthropic profile from config.
 *
 * Preference order:
 *  1. The profile whose id matches the webview-mirrored active selection.
 *  2. The profile flagged `isDefault`.
 *  3. The first configured profile.
 * Returns `undefined` when no profiles are configured (→ all tools).
 */
function resolveActiveProfile(context: vscode.ExtensionContext): AnthropicProfileLike | undefined {
    const config = loadSendToChatConfig();
    const profiles = (config?.anthropic?.profiles ?? []) as AnthropicProfileLike[];
    if (profiles.length === 0) {
        return undefined;
    }
    const activeId = context.workspaceState.get<string>(ACTIVE_ANTHROPIC_PROFILE_KEY, '');
    if (activeId) {
        const match = profiles.find((p) => p.id === activeId);
        if (match) {
            return match;
        }
    }
    return profiles.find((p) => p.isDefault) ?? profiles[0];
}

/**
 * Generate the Anthropic-shaped tools JSON for the currently active profile.
 *
 * Empty when the Send-to-Chat target is 'copilot'. Otherwise the set is
 * filtered by the active profile's `toolsEnabled` / `enabledTools`.
 */
export function getActiveProfileToolsJson(context: vscode.ExtensionContext): AnthropicTool[] {
    const config = loadSendToChatConfig();
    if (getSendToChatTarget(config) === 'copilot') {
        return [];
    }
    const profile = resolveActiveProfile(context);
    const tools = resolveProfileTools(profile);
    return toAnthropicTools(tools);
}

/**
 * Universally invoke a registered tool by name.
 *
 * @param name  The tool name (e.g. 'tomAi_readFile').
 * @param args  The tool's argument object (already parsed JSON).
 * @returns The tool's string result, or an error string for unknown tools /
 *          execution failures (mirrors executeToolCall's contract).
 */
export async function invokeToolByName(
    name: string,
    args: Record<string, unknown>,
): Promise<string> {
    return runWithToolContext({ source: 'anthropic', requestId: `script-${Date.now()}` }, () =>
        executeToolCall(ALL_SHARED_TOOLS, {
            function: { name, arguments: args ?? {} },
        }),
    );
}
