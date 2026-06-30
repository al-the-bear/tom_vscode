/**
 * Send-to-Chat target router.
 *
 * "Send to Chat" can route to one of two transports, selected by the
 * `sendToChatTarget` config key (default `'anthropic'`):
 *
 *   - **copilot** — unchanged legacy behaviour: open the Copilot chat view
 *     with the prompt. For the scripting API the answer is detected via the
 *     `tomAi_askCopilot` answer-file mechanism.
 *   - **anthropic** — handle the prompt exactly as if it had been typed into
 *     the Anthropic chat panel: same active profile, the profile's
 *     configuration, the default user-message template, the chat-panel Agent
 *     SDK session bucket, and the full tool loop. The turn is written to
 *     `live-trail.md` by {@link AnthropicHandler.sendMessage} and (when the
 *     panel is open) mirrored into the panel UI. While a turn is running a
 *     second interactive send is **rejected** (the prompt queue owns queuing).
 *
 * Three callers funnel through here:
 *   - {@link dispatchSendToChat} — fire-and-forget for the command + context /
 *     file menus (no answer handling, surfaces busy/error as a notification).
 *   - {@link sendToChatForScript} — the scripting-API bridge op; returns the
 *     answer for *both* targets so a script sees identical behaviour.
 *   - The chat panel calls {@link runAnthropicSend} indirectly via the same
 *     busy guard (see `sendToChatState.ts`).
 */

import * as vscode from 'vscode';
import {
    loadSendToChatConfig,
    getSendToChatTarget,
} from '../utils/sendToChatConfig';
import { resolveAnthropicTargets } from '../utils/resolveAnthropicTargets';
import { resolveProfileTools, ALL_SHARED_TOOLS } from '../tools/tool-executors';
import type { SharedToolDefinition } from '../tools/shared-tool-registry';
import {
    AnthropicHandler,
    ANTHROPIC_CHAT_SESSION_KEY,
} from './anthropic-handler';
import {
    ACTIVE_ANTHROPIC_PROFILE_KEY,
    invokeAllowedTool,
} from '../tools/scripting-tools-bridge';
import { showAnthropicResultInPanel } from './chatPanel-handler';
import {
    tryBeginAnthropicSend,
    endAnthropicSend,
} from './sendToChatState';

export type SendToChatTarget = 'anthropic' | 'copilot';

export interface SendToChatOutcome {
    /** Which transport handled the prompt. */
    target: SendToChatTarget;
    /** True when the prompt was dispatched (and, for script calls, answered). */
    ok: boolean;
    /** Rejected because an interactive Anthropic turn was already running. */
    rejected?: boolean;
    /** The transport's answer (Anthropic transport text, or Copilot answer-file). */
    answer?: string;
    /** Failure reason when `ok` is false. */
    error?: string;
}

/** The currently configured Send-to-Chat target (defaults to 'anthropic'). */
export function currentSendToChatTarget(): SendToChatTarget {
    return getSendToChatTarget(loadSendToChatConfig());
}

/**
 * Resolve the default user-message template (the one flagged `isDefault`) from
 * the Anthropic config, mirroring the chat panel's default selection.
 */
function defaultUserMessageTemplate(): string | undefined {
    const config = loadSendToChatConfig();
    const templates = Array.isArray(config?.anthropic?.userMessageTemplates)
        ? (config!.anthropic!.userMessageTemplates! as Array<{ template: string; isDefault?: boolean }>)
        : [];
    return templates.find((t) => t.isDefault)?.template || undefined;
}

/**
 * Run an Anthropic turn using the active profile, exactly as the chat panel
 * would. Rejects (without starting) when an interactive turn is already in
 * flight.
 *
 * @param context  Extension context (for the mirrored active-profile id).
 * @param prompt   The user prompt text.
 * @param opts.cancellationToken  Optional cancellation token.
 * @param opts.userMessageTemplate  Explicit user-message template body to wrap
 *   the prompt with (must contain `${userMessage}`). When omitted, the
 *   Anthropic default template is used — same as a plain panel send. Callers
 *   that let the user pick a specific template (e.g. the Quest TODO panel's
 *   send button) pass the chosen template here.
 */
export async function runAnthropicSend(
    context: vscode.ExtensionContext,
    prompt: string,
    opts?: { cancellationToken?: vscode.CancellationToken; userMessageTemplate?: string },
): Promise<SendToChatOutcome> {
    if (!prompt || !prompt.trim()) {
        return { target: 'anthropic', ok: false, error: 'Empty prompt.' };
    }
    // When the caller didn't supply a cancellation token (the command / file
    // menus and the Telegram `send_prompt` path), own a CTS here so the send is
    // interruptible — otherwise `/cancel_chat` would have nothing to cancel. A
    // caller-supplied token (the panel) owns its own cancellation.
    const ownCts = opts?.cancellationToken ? undefined : new vscode.CancellationTokenSource();
    const cancellationToken = opts?.cancellationToken ?? ownCts!.token;
    // Register the cancel hook atomically with the slot claim so `/cancel_chat`
    // can interrupt this turn exactly like the chat panel's Stop button:
    // cancel the token and abort any pending tool-approval gate.
    if (!tryBeginAnthropicSend(() => {
        ownCts?.cancel();
        AnthropicHandler.instance.abortPendingApprovals();
    })) {
        ownCts?.dispose();
        return {
            target: 'anthropic',
            ok: false,
            rejected: true,
            error: 'An Anthropic chat request is already running.',
        };
    }
    try {
        // "Same profile as currently selected in the panel": the panel mirrors
        // its active selection into workspaceState; fall back to the default /
        // first profile when nothing has been selected yet (the panel always
        // opens with something selected — that selection drives this path).
        const activeProfileId = context.workspaceState.get<string>(ACTIVE_ANTHROPIC_PROFILE_KEY, '');
        const resolved = resolveAnthropicTargets({ profileId: activeProfileId || undefined });
        if ('error' in resolved) {
            return { target: 'anthropic', ok: false, error: resolved.error };
        }
        const { profile, configuration } = resolved;
        const userMessageTemplate = opts?.userMessageTemplate ?? defaultUserMessageTemplate();
        const tools: SharedToolDefinition[] = resolveProfileTools(
            profile as unknown as { enabledTools?: string[]; toolsEnabled?: boolean },
        );

        const result = await AnthropicHandler.instance.sendMessage({
            userText: prompt,
            profile,
            configuration,
            tools,
            sessionKey: ANTHROPIC_CHAT_SESSION_KEY,
            cancellationToken,
            ...(userMessageTemplate ? { userMessageTemplate } : {}),
        });

        // Mirror into the panel UI when it is open, so a Send-to-Chat / script
        // turn shows up just like a panel send. No-op when the panel is closed.
        showAnthropicResultInPanel(result.text, {
            turnsUsed: result.turnsUsed,
            toolCallCount: result.toolCallCount,
            historyMode: configuration.historyMode || '',
        });

        return { target: 'anthropic', ok: true, answer: result.text };
    } catch (e) {
        return {
            target: 'anthropic',
            ok: false,
            error: e instanceof Error ? e.message : String(e),
        };
    } finally {
        endAnthropicSend();
        ownCts?.dispose();
    }
}

/**
 * Fire-and-forget dispatch for the command + context / file menus. No answer
 * handling per spec; busy / failure surfaces as a notification.
 */
export async function dispatchSendToChat(
    context: vscode.ExtensionContext,
    prompt: string,
): Promise<void> {
    if (currentSendToChatTarget() === 'copilot') {
        await vscode.commands.executeCommand('workbench.action.chat.open', { query: prompt });
        return;
    }
    const outcome = await runAnthropicSend(context, prompt);
    if (outcome.rejected) {
        vscode.window.showWarningMessage(
            'Anthropic chat is busy — try again once the current request finishes.',
        );
    } else if (!outcome.ok && outcome.error) {
        vscode.window.showErrorMessage(`Send to Anthropic failed: ${outcome.error}`);
    }
}

/**
 * Scripting-API entry. Returns the answer for both targets so the caller's
 * behaviour is identical regardless of the configured target:
 *   - copilot   → the `tomAi_askCopilot` answer-file round-trip.
 *   - anthropic → the Anthropic transport's answer text.
 */
export async function sendToChatForScript(
    context: vscode.ExtensionContext,
    prompt: string,
): Promise<SendToChatOutcome> {
    if (currentSendToChatTarget() === 'copilot') {
        // Trusted internal routing: deliberately invoke the Copilot bridge tool
        // even though the profile gate exposes no tools for the 'copilot'
        // target. The permitted tool is named explicitly here, so this call
        // site stays narrow rather than reopening an ungated invoke path.
        const answer = await invokeAllowedTool(
            new Set(['tomAi_askCopilot']),
            ALL_SHARED_TOOLS,
            'tomAi_askCopilot',
            { prompt },
        );
        return { target: 'copilot', ok: true, answer };
    }
    return runAnthropicSend(context, prompt);
}
