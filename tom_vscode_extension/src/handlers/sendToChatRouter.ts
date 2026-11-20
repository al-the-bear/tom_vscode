/**
 * Where an editor or script prompt goes.
 *
 *   - **Copilot** — the "Send to Copilot" commands (`tomAi.sendToCopilot`,
 *     `.standard`, `.template`) always open Copilot Chat with the prompt
 *     ({@link openCopilotChat}); the template commands wrap it first.
 *   - **ANTHROPIC/LLM** — the "Send to LLM" commands ({@link dispatchToLlm})
 *     handle the prompt exactly as if it had been typed into the panel: same
 *     active profile, its configuration, the default user-message template,
 *     the chat session, the full tool loop, the live trail. While a chat send
 *     runs in a session, a second send into that session is **rejected** (the
 *     prompt queue owns queuing); sends in other sessions run beside it.
 *   - **Scripts** — {@link sendToChatForScript}, the scripting API's
 *     `sendToChatVce`, sends to the ANTHROPIC/LLM panel's profile unless the
 *     call names `target: 'copilot'`, and returns the answer for both.
 *
 * Each command does what its name says: there is no configured "Send to Chat
 * target" any more.
 */

import { resolveBusySession } from './busySessionChoice';
import * as vscode from 'vscode';
import { withAspectsForCopilot } from '../services/aspectGuidelinesStore';
import { loadSendToChatConfig } from '../utils/sendToChatConfig';
import { resolveAnthropicTargets } from '../utils/resolveAnthropicTargets';
import { resolveProfileTools } from '../tools/tool-executors';
import { askCopilotForScript } from '../services/copilotRoundTrip';
import type { SharedToolDefinition } from '../tools/shared-tool-registry';
import {
    AnthropicHandler,
    ANTHROPIC_CHAT_SESSION_KEY,
} from './anthropic-handler';
import { ACTIVE_ANTHROPIC_PROFILE_KEY } from '../tools/scripting-tools-bridge';
import { showAnthropicResultInPanel } from './chatPanel-handler';
import {
    tryBeginAnthropicSend,
    setAnthropicSendChatItem,
    endAnthropicSend,
    busySessionWarning,
    chatSendRefusal,
} from './sendToChatState';
import { trackChatSend, isRunningChatItem } from './chatQueueTracking';
import { runInProcessPosition, type ProcessRun } from '../services/processRunContext';
import { needsRunContext } from '../utils/chatPanelRuns';

export type SendToChatTarget = 'anthropic' | 'copilot';

export interface SendToChatOutcome {
    /** Which transport handled the prompt. */
    target: SendToChatTarget;
    /** True when the prompt was dispatched (and, for script calls, answered). */
    ok: boolean;
    /** Rejected because a chat send already runs in its session (`busySession`). */
    rejected?: boolean;
    /** Refused because the window waits for its reload (another window migrated the workspace; `error` says so). */
    refused?: boolean;
    /** With `rejected`: the session a chat send already runs in. */
    busySession?: string;
    /** The transport's answer (Anthropic transport text, or Copilot answer-file). */
    answer?: string;
    /** Failure reason when `ok` is false. */
    error?: string;
    /** The session was busy and the prompt was queued instead (what was done). */
    queued?: string;
    /** The prompt queue entry the Anthropic send is shown as (`chat` / `chat-sent`). */
    chatItemId?: string;
}

/** The target a script names (`sendToChatVce`'s `target`): `copilot` when it says so, else the ANTHROPIC/LLM panel. */
export function scriptSendTarget(target: unknown): SendToChatTarget {
    return target === 'copilot' ? 'copilot' : 'anthropic';
}

/** Open Copilot Chat with `prompt` (the Send to Copilot commands). */
export async function openCopilotChat(prompt: string): Promise<void> {
    const refusal = chatSendRefusal();
    if (refusal) { void vscode.window.showWarningMessage(`Not sent: ${refusal}`); return; }
    // The aspect guidelines go before the prompt: Copilot has no system prompt of its own (gsel2).
    await vscode.commands.executeCommand('workbench.action.chat.open', { query: withAspectsForCopilot(prompt) });
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
 * would. Rejects (without starting, naming the session) when a chat send
 * already runs in the session it would send in.
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
/**
 * The process position a send runs as when it names a run other than the
 * window's: that run's state (its chat variables and process variables then
 * read as the run's). None for the window's run or without a process store.
 */
export function processRunFor(run: string | undefined): ProcessRun | undefined {
    if (!run) { return undefined; }
    try {
        // eslint-disable-next-line @typescript-eslint/no-require-imports
        const store = (require('../managers/processStateStore.js') as typeof import('../managers/processStateStore')).ProcessStateStore.instance;
        if (!store || !needsRunContext(run, store.currentRun)) { return undefined; }
        const read = store.withRun(run, () => ({ state: store.state }));
        if (!('state' in read)) { return undefined; }
        return { quest: store.activeQuest, state: read.state, ...(run !== 'default' ? { run } : {}) };
    } catch {
        return undefined;
    }
}

export async function runAnthropicSend(
    context: vscode.ExtensionContext,
    prompt: string,
    opts?: {
        cancellationToken?: vscode.CancellationToken;
        userMessageTemplate?: string;
        source?: string;
        /** The session the turn runs in; default the panel's chat session (a temporary assist session, for one). */
        session?: string;
        /**
         * The process run the turn runs as (the todo panel's run, vscimpb60d): its chat variables and
         * process position; recorded on its queue entry. Default: the window's run.
         */
        run?: string;
        /** Told the prompt queue entry the turn is shown as, as soon as it is made (an assist's overlay follows its waits). */
        onChatItem?: (chatItemId: string) => void;
    },
): Promise<SendToChatOutcome> {
    if (!prompt || !prompt.trim()) {
        return { target: 'anthropic', ok: false, error: 'Empty prompt.' };
    }
    // Another window migrated the workspace: no new chat send until this window reloads (vscimpb142d).
    const refusal = chatSendRefusal();
    if (refusal) { return { target: 'anthropic', ok: false, refused: true, error: refusal }; }
    // When the caller didn't supply a cancellation token (the command / file
    // menus and the Telegram `send_prompt` path), own a CTS here so the send is
    // interruptible — otherwise `/cancel_chat` would have nothing to cancel. A
    // caller-supplied token (the panel) owns its own cancellation.
    // Two prompts never share a conversation: a busy session (a queue item or
    // another chat send runs in it) makes the user choose — queue it next or
    // after the current item, or send it in a free session. Telegram and
    // scripts have nobody to ask: refused, naming who runs in it.
    let targetSession = opts?.session || ANTHROPIC_CHAT_SESSION_KEY;
    const interactive = !['telegram', 'script'].includes(opts?.source ?? '');
    const busy = await resolveBusySession({
        session: targetSession,
        send: { text: prompt, ...(context.workspaceState.get<string>(ACTIVE_ANTHROPIC_PROFILE_KEY, '') ? { profileId: context.workspaceState.get<string>(ACTIVE_ANTHROPIC_PROFILE_KEY, '') } : {}) },
        interactive,
    });
    if (busy.kind === 'cancelled') {
        return { target: 'anthropic', ok: false, error: busy.message };
    }
    if (busy.kind === 'queued' || busy.kind === 'update') {
        const queued = busy.kind === 'update'
            ? `Sent as an update to the running prompt in session ${busy.session}.`
            : busy.how === 'next' ? `Queued to run next in session ${busy.session}.` : `Queued to run after the current item in session ${busy.session}.`;
        void vscode.window.showInformationMessage(queued);
        return { target: 'anthropic', ok: true, queued };
    }
    if (busy.kind === 'send') { targetSession = busy.session; }
    const ownCts = opts?.cancellationToken ? undefined : new vscode.CancellationTokenSource();
    const cancellationToken = opts?.cancellationToken ?? ownCts!.token;
    // Register the cancel hook atomically with the slot claim so `/cancel_chat`
    // can interrupt this turn exactly like the chat panel's Stop button:
    // cancel the token and abort any pending tool-approval gate.
    // One slot per session: a send in another session runs on; a second one in this session is refused.
    let chatItemOfSend: string | undefined;
    if (!tryBeginAnthropicSend(targetSession, () => {
        ownCts?.cancel();
        // This send's approvals only (vscimpb81): a queue item's, or another chat send's, stay open.
        AnthropicHandler.instance.abortPendingApprovals((a) => chatItemOfSend ? a.queueItemId === chatItemOfSend : isRunningChatItem(a.queueItemId));
    })) {
        ownCts?.dispose();
        return {
            target: 'anthropic',
            ok: false,
            rejected: true,
            busySession: targetSession,
            error: `Session ${targetSession} is busy: a chat send runs in it.`,
        };
    }
    const slotSession = targetSession;
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
            true,
        );

        // No session picker on this path (the editor's Send to Anthropic/LLM, Telegram): the chat
        // session, unless the caller names one — an assist prompt's temporary session, the todo
        // panel's own session (and run, vscimpb60d). The send is shown in the prompt queue.
        const sessionKey = targetSession;
        let chatItemId: string | undefined;
        const result = await trackChatSend(
            { text: prompt, profileId: profile.id, session: sessionKey, source: opts?.source ?? 'send to chat', ...(opts?.run ? { run: opts.run } : {}) },
            () => runInProcessPosition(processRunFor(opts?.run), () => AnthropicHandler.instance.sendMessage({
                userText: prompt,
                profile,
                configuration,
                tools,
                sessionKey,
                cancellationToken,
                ...(userMessageTemplate ? { userMessageTemplate } : {}),
            })),
            // Ended by its timeout or by removing its entry: stopped like /cancel_chat.
            {
                cancel: (itemId) => { ownCts?.cancel(); AnthropicHandler.instance.abortPendingApprovals((a) => a.queueItemId === itemId); },
                onChatItem: (itemId) => { chatItemId = itemId; chatItemOfSend = itemId; setAnthropicSendChatItem(slotSession, itemId); opts?.onChatItem?.(itemId); },
            },
        );

        // Mirror into the panel UI when it is open, so a Send-to-Chat / script
        // turn shows up just like a panel send. No-op when the panel is closed.
        showAnthropicResultInPanel(result.text, {
            turnsUsed: result.turnsUsed,
            toolCallCount: result.toolCallCount,
            historyMode: configuration.historyMode || '',
            ...(result.usage ? { usage: result.usage } : {}),
        });

        return { target: 'anthropic', ok: true, answer: result.text, ...(chatItemId ? { chatItemId } : {}) };
    } catch (e) {
        return {
            target: 'anthropic',
            ok: false,
            error: e instanceof Error ? e.message : String(e),
        };
    } finally {
        endAnthropicSend(slotSession);
        ownCts?.dispose();
    }
}

/**
 * Fire-and-forget send to the @CHAT Anthropic panel's current profile and
 * session (the "Send to LLM" commands). `userMessageTemplate` is the template body to wrap the prompt with;
 * without it the default one. Busy / failure surfaces as a notification.
 */
export async function dispatchToLlm(
    context: vscode.ExtensionContext,
    prompt: string,
    userMessageTemplate?: string,
): Promise<void> {
    const outcome = await runAnthropicSend(context, prompt, { source: 'editor', ...(userMessageTemplate ? { userMessageTemplate } : {}) });
    if (outcome.refused) {
        vscode.window.showWarningMessage(`Not sent: ${outcome.error}`);
    } else if (outcome.rejected) {
        vscode.window.showWarningMessage(busySessionWarning(outcome.busySession));
    } else if (!outcome.ok && outcome.error) {
        vscode.window.showErrorMessage(`Send to Anthropic/LLM failed: ${outcome.error}`);
    }
}

/**
 * Scripting-API entry (`sendToChatVce`). Sends to the ANTHROPIC/LLM panel's
 * profile, or with `target: 'copilot'` to Copilot, and returns the answer for
 * both, so a script sees the same shape either way:
 *   - copilot   → the Copilot answer-file round trip (services/copilotRoundTrip.ts).
 *   - anthropic → the Anthropic transport's answer text.
 */
export async function sendToChatForScript(
    context: vscode.ExtensionContext,
    prompt: string,
    target: SendToChatTarget = 'anthropic',
): Promise<SendToChatOutcome> {
    const refusal = chatSendRefusal();
    if (refusal) { return { target, ok: false, refused: true, error: refusal }; }
    if (target === 'copilot') {
        // The Copilot answer-file round trip (services/copilotRoundTrip.ts):
        // the prompt in the Copilot Queue Wrapper, then its answer file.
        const answer = await askCopilotForScript({ prompt });
        return { target: 'copilot', ok: true, answer };
    }
    return runAnthropicSend(context, prompt, { source: 'script' });
}
