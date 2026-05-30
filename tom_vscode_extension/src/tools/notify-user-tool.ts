/**
 * `tomAi_notifyUser` — send a notification to the user.
 *
 * Carved out of `chat-enhancement-tools.ts` for coverage entry #22.
 *
 * ## Priority levels (urgency)
 *
 *   - `info`    (default) — neutral informational message
 *   - `warning` — yellow/highlighted, draws attention
 *   - `error`   — red, signals a failure or blocker
 *
 * Maps to `vscode.window.show{Information,Warning,Error}Message` on
 * the VS Code path; Telegram messages get a prefix emoji (ℹ️ / 🟡 /
 * 🔴) reflecting the urgency.
 *
 * ## Channels
 *
 *   - `vscode`     — toast notification in the VS Code window. The
 *                    user dismisses by clicking the X or waits for
 *                    auto-dismiss. With `modal: true` the toast
 *                    becomes a centred modal that blocks the editor
 *                    until clicked.
 *   - `statusbar`  — short text appended to the VS Code status bar.
 *                    Optional `statusBarTimeoutMs` (default 5 000 ms)
 *                    auto-clears the message. No interactive
 *                    dismissal possible.
 *   - `telegram`   — sent to the configured Telegram bot
 *                    (`config.aiConversation.telegram.{enabled,
 *                    botTokenEnv, defaultChatId}`). When Telegram
 *                    isn't configured, this channel surfaces a clear
 *                    error so the model can pick again.
 *   - `auto` (default) — try Telegram first when configured; fall
 *                    back to vscode toast when not configured or
 *                    when Telegram returns non-200.
 *
 * ## Modal / dismissal semantics
 *
 *   - Default (non-modal): toast appears at the bottom-right, auto-
 *     dismisses after ~5 s (vscode default), user can also click X.
 *     The tool does NOT await user interaction.
 *   - `modal: true`: VS Code shows a centred modal that blocks the
 *     editor; the tool awaits the user's click and reports it in
 *     `dismissedBy` (button label or `"close"` when the X is clicked).
 *   - Telegram/statusbar channels ignore `modal` (no equivalent).
 */

import { SharedToolDefinition } from './shared-tool-registry';

// ===========================================================================
// Narrow dep
// ===========================================================================

export type NotifyUrgency = 'info' | 'warning' | 'error';
export type NotifyChannel = 'auto' | 'vscode' | 'statusbar' | 'telegram';

export interface NotificationChannels {
    showInformation(text: string, opts: { modal: boolean }): Promise<string | undefined>;
    showWarning(text: string, opts: { modal: boolean }): Promise<string | undefined>;
    showError(text: string, opts: { modal: boolean }): Promise<string | undefined>;
    setStatusBarMessage(text: string, timeoutMs: number): void;
    /**
     * Production wires this to a `fetch('https://api.telegram.org/...')`.
     * Tests pass a fake. `null` when Telegram isn't configured.
     */
    sendTelegram(text: string): Promise<{ ok: true } | { ok: false; reason: string }> | null;
}

// ===========================================================================
// Impl
// ===========================================================================

export interface NotifyUserInput {
    message: string;
    urgency?: NotifyUrgency;
    title?: string;
    /** Default `auto`. */
    channel?: NotifyChannel;
    /** Only effective for `vscode` channel. Default false. */
    modal?: boolean;
    /** Only effective for `statusbar` channel. Default 5000 (5 s). */
    statusBarTimeoutMs?: number;
}

const STATUSBAR_DEFAULT_TIMEOUT = 5_000;

function urgencyPrefix(u: NotifyUrgency): string {
    return u === 'error' ? '🔴' : u === 'warning' ? '🟡' : 'ℹ️';
}

function ok<T extends object>(extra: T): string { return JSON.stringify({ ok: true, ...extra }); }
function err(message: string, extra: Record<string, unknown> = {}): string {
    return JSON.stringify({ ok: false, error: message, ...extra });
}

export async function notifyUserImpl(channels: NotificationChannels, input: NotifyUserInput): Promise<string> {
    try {
        if (!input.message || !input.message.trim()) {
            return err('`message` is required.');
        }
        const urgency: NotifyUrgency = input.urgency ?? 'info';
        const requestedChannel: NotifyChannel = input.channel ?? 'auto';
        const prefix = urgencyPrefix(urgency);
        const titleLine = input.title ? `**${input.title}**\n` : '';
        const text = `${prefix} ${titleLine}${input.message}`;
        const modal = input.modal === true;

        // -- statusbar
        if (requestedChannel === 'statusbar') {
            const timeoutMs = Math.max(500, input.statusBarTimeoutMs ?? STATUSBAR_DEFAULT_TIMEOUT);
            channels.setStatusBarMessage(text, timeoutMs);
            return ok({
                channel: 'statusbar',
                urgency,
                statusBarTimeoutMs: timeoutMs,
                timestamp: new Date().toISOString(),
            });
        }

        // -- telegram (explicit)
        if (requestedChannel === 'telegram') {
            const tgPromise = channels.sendTelegram(text);
            if (!tgPromise) {
                return err('Telegram channel requested but not configured. Set `config.aiConversation.telegram.{enabled, botTokenEnv, defaultChatId}` first, or use `channel: "vscode"`.');
            }
            const result = await tgPromise;
            if (!result.ok) {
                return err(`Telegram send failed: ${result.reason}`, { channel: 'telegram', urgency });
            }
            return ok({ channel: 'telegram', urgency, timestamp: new Date().toISOString() });
        }

        // -- vscode (explicit)
        if (requestedChannel === 'vscode') {
            const dismissedBy = await showByUrgency(channels, urgency, text, modal);
            return ok({
                channel: 'vscode',
                urgency,
                modal,
                dismissedBy: dismissedBy ?? null,
                timestamp: new Date().toISOString(),
            });
        }

        // -- auto: try Telegram first when configured, fall back to vscode toast
        const tgPromise = channels.sendTelegram(text);
        if (tgPromise) {
            const result = await tgPromise;
            if (result.ok) {
                return ok({ channel: 'telegram', urgency, autoFallback: false, timestamp: new Date().toISOString() });
            }
            // Telegram tried + failed → fall through to vscode
            const dismissedBy = await showByUrgency(channels, urgency, text, modal);
            return ok({
                channel: 'vscode',
                urgency,
                modal,
                dismissedBy: dismissedBy ?? null,
                autoFallback: true,
                fallbackReason: `Telegram tried + failed: ${result.reason}`,
                timestamp: new Date().toISOString(),
            });
        }
        // No Telegram configured: vscode straight away
        const dismissedBy = await showByUrgency(channels, urgency, text, modal);
        return ok({
            channel: 'vscode',
            urgency,
            modal,
            dismissedBy: dismissedBy ?? null,
            autoFallback: false,
            timestamp: new Date().toISOString(),
        });
    } catch (e) {
        return err((e as Error).message);
    }
}

async function showByUrgency(channels: NotificationChannels, urgency: NotifyUrgency, text: string, modal: boolean): Promise<string | undefined> {
    switch (urgency) {
        case 'error': return channels.showError(text, { modal });
        case 'warning': return channels.showWarning(text, { modal });
        default: return channels.showInformation(text, { modal });
    }
}

// ===========================================================================
// Tool def
// ===========================================================================

export const NOTIFY_USER_DESCRIPTION =
    'Send a notification to the user. **Priority levels** (`urgency`): ' +
    '`info` (default), `warning`, `error` — maps to ' +
    '`showInformation`/`showWarning`/`showError` on the VS Code path and a ' +
    '`ℹ️`/`🟡`/`🔴` prefix on Telegram. **Channels**: `auto` (default — try ' +
    'Telegram if configured, fall back to vscode toast); `vscode` (force ' +
    'toast, opt into `modal: true` for a centred blocking dialog); ' +
    '`statusbar` (short text in the status bar; auto-clears after ' +
    '`statusBarTimeoutMs`, default 5 s); `telegram` (force Telegram; errors ' +
    'when not configured). **Modal/dismissal**: non-modal toasts auto-' +
    'dismiss after ~5 s and the tool returns immediately. With `modal: ' +
    'true` on the vscode channel the call awaits the user click and ' +
    'reports the button label in `dismissedBy`. Response always includes ' +
    'the resolved `channel`, `urgency`, `timestamp`, and (when auto-' +
    'fallback fired) `autoFallback: true` + `fallbackReason`.';

export const NOTIFY_USER_TOOL: SharedToolDefinition<NotifyUserInput> = {
    name: 'tomAi_notifyUser',
    displayName: 'Notify User',
    description: NOTIFY_USER_DESCRIPTION,
    tags: ['notification', 'telegram', 'tom-ai-chat'],
    readOnly: false,
    inputSchema: {
        type: 'object',
        required: ['message'],
        properties: {
            message: { type: 'string' },
            urgency: { type: 'string', enum: ['info', 'warning', 'error'], description: 'Default `info`.' },
            title: { type: 'string', description: 'Optional bold subject line prepended above the message.' },
            channel: { type: 'string', enum: ['auto', 'vscode', 'statusbar', 'telegram'], description: 'Default `auto`.' },
            modal: { type: 'boolean', description: 'vscode channel only. Default false. When true, blocks until the user clicks.' },
            statusBarTimeoutMs: { type: 'number', description: 'statusbar channel only. Default 5000.' },
        },
    },
    execute: async () => '{"ok":false,"error":"execute() must be installed by tool-executors.ts"}',
};
