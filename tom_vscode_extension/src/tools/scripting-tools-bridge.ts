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
    SendToChatConfig,
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
 * Pure selection of the active Anthropic profile from a loaded config.
 *
 * Preference order:
 *  1. The profile whose id matches `activeProfileId` (the webview-mirrored
 *     active selection).
 *  2. The profile flagged `isDefault`.
 *  3. The first configured profile.
 * Returns `undefined` when no profiles are configured (→ all tools).
 *
 * Kept config-in / no-vscode so the resolution is unit-testable without a
 * live config file (mirrors the apiKeyAuthHeader test seam).
 */
function pickActiveProfile(
    config: SendToChatConfig | null,
    activeProfileId: string,
): AnthropicProfileLike | undefined {
    const profiles = (config?.anthropic?.profiles ?? []) as AnthropicProfileLike[];
    if (profiles.length === 0) {
        return undefined;
    }
    if (activeProfileId) {
        const match = profiles.find((p) => p.id === activeProfileId);
        if (match) {
            return match;
        }
    }
    return profiles.find((p) => p.isDefault) ?? profiles[0];
}

/**
 * Pure resolution of the tool-name set allowed for the active profile.
 *
 * The single source of truth shared by tool listing
 * ({@link getActiveProfileToolsJson}) and tool-invocation gating:
 *  - Send-to-Chat target 'copilot' ⇒ empty set (no tools).
 *  - Otherwise the active profile (see {@link pickActiveProfile}) drives the
 *    set via `resolveProfileTools`.
 *
 * Config-in / activeId-in so it is unit-testable without a live config file.
 */
export function activeProfileToolNames(
    config: SendToChatConfig | null,
    activeProfileId: string,
): Set<string> {
    if (getSendToChatTarget(config) === 'copilot') {
        return new Set();
    }
    const profile = pickActiveProfile(config, activeProfileId);
    return new Set(resolveProfileTools(profile).map((t) => t.name));
}

/**
 * Resolve the allowed tool-name set for the currently active profile,
 * reading the live config + webview-mirrored profile selection from
 * extension state. Thin wrapper over {@link activeProfileToolNames}.
 */
export function resolveActiveProfileToolNames(context: vscode.ExtensionContext): Set<string> {
    const config = loadSendToChatConfig();
    const activeId = context.workspaceState.get<string>(ACTIVE_ANTHROPIC_PROFILE_KEY, '');
    return activeProfileToolNames(config, activeId);
}

/**
 * Generate the Anthropic-shaped tools JSON for the currently active profile.
 *
 * Empty when the Send-to-Chat target is 'copilot'. Otherwise the set is
 * filtered by the active profile's `toolsEnabled` / `enabledTools`. Built from
 * {@link resolveActiveProfileToolNames} so listing and invocation gating read
 * from one helper; filtering `ALL_SHARED_TOOLS` by the resolved name set
 * preserves the original entries and ordering.
 */
export function getActiveProfileToolsJson(context: vscode.ExtensionContext): AnthropicTool[] {
    const allowed = resolveActiveProfileToolNames(context);
    return toAnthropicTools(ALL_SHARED_TOOLS.filter((t) => allowed.has(t.name)));
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
