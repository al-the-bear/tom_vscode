/**
 * Telegram Chat Channel — ChatChannel implementation for Telegram Bot API.
 *
 * Uses raw HTTPS calls to the Telegram Bot API (no npm Telegram SDK dependency).
 * Handles:
 *  - MarkdownV2 formatting with automatic plain-text fallback
 *  - Short polling via getUpdates
 *  - User ID whitelisting for security
 *  - Document/file upload via multipart/form-data
 *
 * This is the low-level transport layer. Higher-level concerns like notification
 * formatting and command parsing are handled by TelegramNotifier and the command
 * infrastructure, which compose this channel.
 */

import * as https from 'https';
import * as http from 'http';
import {
    ChatChannel,
    ChannelResult,
    ChannelMessage,
    ChannelMessageCallback,
    SendMessageOptions,
} from './chat-channel';
import { TelegramConfig } from '../telegram-notifier';
import { stripMarkdown } from '../telegram-markdown';
import { bridgeLog } from '../handler_shared';

// ============================================================================
// Telegram Update (internal API type)
// ============================================================================

/** Parsed Telegram update from the Bot API. */
// eslint-disable-next-line @typescript-eslint/naming-convention
interface TelegramUpdate {
    update_id: number; // eslint-disable-line @typescript-eslint/naming-convention
    message?: {
        message_id: number; // eslint-disable-line @typescript-eslint/naming-convention
        from: { id: number; first_name: string; username?: string }; // eslint-disable-line @typescript-eslint/naming-convention
        chat: { id: number; type: string };
        text?: string;
        date: number;
    };
}

// ============================================================================
// TelegramChannel
// ============================================================================

/**
 * Telegram implementation of the ChatChannel interface.
 *
 * Sends messages via the Telegram Bot HTTP API and receives messages
 * via short polling (getUpdates). Only messages from whitelisted user IDs
 * are forwarded to registered callbacks.
 */
export class TelegramChannel implements ChatChannel {
    readonly platform = 'telegram';

    /**
     * Bot tokens with a live getUpdates poll loop *in this extension host*.
     *
     * Telegram allows only one getUpdates consumer per bot token; a second one
     * makes the API return 409 Conflict to whichever call is superseded, so two
     * pollers on the same token produce an alternating success/409 storm and
     * neither receives reliably. Two independent owners exist in a window — the
     * standalone command poller and the AI Conversation panel poller — and they
     * resolve the *same* per-quest token. This process-wide claim guarantees only
     * the first channel to start actually polls; later starters defer (and log)
     * instead of racing. Released in {@link stopListening}.
     */
    private static readonly activePollTokens = new Set<string>();

    private config: TelegramConfig;
    /** True when this channel currently holds the poll claim for its token. */
    private holdsPollClaim = false;
    private lastUpdateId: number = 0;
    private pollTimer: ReturnType<typeof setInterval> | null = null;
    private _isListening = false;
    private messageCallbacks: ChannelMessageCallback[] = [];

    /**
     * Notified when getUpdates returns a Telegram API error (e.g. HTTP 409
     * Conflict when another client is already polling the same bot token).
     * Reported once per distinct error code so a persistent conflict doesn't
     * spam a toast on every poll tick.
     */
    private pollErrorCallback: ((err: { code?: number; description: string }) => void) | null = null;
    /** Last reported poll-error code; reset to null after a successful poll so a recurrence re-warns. */
    private lastPollErrorCode: number | null = null;

    constructor(config: TelegramConfig) {
        this.config = config;
    }

    get isEnabled(): boolean {
        return this.config.enabled && !!this.config.botToken && this.config.allowedUserIds.length > 0;
    }

    get isListening(): boolean {
        return this._isListening;
    }

    /** Access the underlying Telegram-specific config. */
    get telegramConfig(): TelegramConfig {
        return this.config;
    }

    /** Update config (e.g. after hot-reload). Restarts listening if active. */
    updateConfig(config: TelegramConfig): void {
        const wasListening = this._isListening;
        if (wasListening) { this.stopListening(); }
        this.config = config;
        if (wasListening && this.isEnabled) { this.startListening(); }
    }

    // -----------------------------------------------------------------------
    // Sending
    // -----------------------------------------------------------------------

    async sendMessage(
        text: string,
        chatId?: number | string,
        options?: SendMessageOptions,
    ): Promise<ChannelResult> {
        if (!this.isEnabled) {
            return { ok: false, error: 'Telegram channel is not enabled (check botToken and allowedUserIds)' };
        }

        const targetChatId = chatId ?? this.config.defaultChatId;
        if (!targetChatId) {
            return { ok: false, error: 'No target chat ID configured' };
        }

        const truncated = this.truncate(text, 4096);
        const plain = options?.plain === true;
        const disablePreview = options?.disableLinkPreview !== false; // default true

        if (plain) {
            return this.apiCallWithDetails('sendMessage', {
                // eslint-disable-next-line @typescript-eslint/naming-convention
                chat_id: targetChatId,
                text: truncated,
                // eslint-disable-next-line @typescript-eslint/naming-convention
                disable_web_page_preview: disablePreview,
            });
        }

        // Try MarkdownV2 with automatic plain-text fallback
        const result = await this.apiCallWithDetails('sendMessage', {
            // eslint-disable-next-line @typescript-eslint/naming-convention
            chat_id: targetChatId,
            text: truncated,
            // eslint-disable-next-line @typescript-eslint/naming-convention
            parse_mode: 'MarkdownV2',
            // eslint-disable-next-line @typescript-eslint/naming-convention
            disable_web_page_preview: disablePreview,
        });

        if (!result.ok) {
            bridgeLog(`[Telegram] MarkdownV2 send failed: ${result.error}, retrying without parse_mode`);
            return this.apiCallWithDetails('sendMessage', {
                // eslint-disable-next-line @typescript-eslint/naming-convention
                chat_id: targetChatId,
                text: this.truncate(stripMarkdown(text), 4096),
                // eslint-disable-next-line @typescript-eslint/naming-convention
                disable_web_page_preview: disablePreview,
            });
        }
        return result;
    }

    async sendDocument(
        content: Buffer,
        filename: string,
        chatId?: number | string,
    ): Promise<ChannelResult> {
        if (!this.config.botToken) {
            return { ok: false, error: 'No bot token configured' };
        }

        const targetChatId = chatId ?? this.config.defaultChatId;
        if (!targetChatId) {
            return { ok: false, error: 'No target chat ID configured' };
        }

        const boundary = '----TelegramBotBoundary' + Date.now().toString(36);
        const parts: Buffer[] = [];

        // chat_id field
        parts.push(Buffer.from(
            `--${boundary}\r\n` +
            `Content-Disposition: form-data; name="chat_id"\r\n\r\n` +
            `${targetChatId}\r\n`
        ));

        // document field (file upload)
        parts.push(Buffer.from(
            `--${boundary}\r\n` +
            `Content-Disposition: form-data; name="document"; filename="${filename}"\r\n` +
            `Content-Type: application/octet-stream\r\n\r\n`
        ));
        parts.push(content);
        parts.push(Buffer.from('\r\n'));

        // closing boundary
        parts.push(Buffer.from(`--${boundary}--\r\n`));

        const body = Buffer.concat(parts);

        return new Promise((resolve) => {
            const options: https.RequestOptions = {
                hostname: 'api.telegram.org',
                path: `/bot${this.config.botToken}/sendDocument`,
                method: 'POST',
                headers: {
                    'Content-Type': `multipart/form-data; boundary=${boundary}`, // eslint-disable-line @typescript-eslint/naming-convention
                    'Content-Length': body.length, // eslint-disable-line @typescript-eslint/naming-convention
                },
                timeout: 30000,
            };

            const req = https.request(options, (res: http.IncomingMessage) => {
                let responseBody = '';
                res.on('data', (chunk: Buffer) => { responseBody += chunk.toString(); });
                res.on('end', () => {
                    try {
                        const parsed = JSON.parse(responseBody);
                        if (parsed.ok === true) {
                            resolve({ ok: true });
                        } else {
                            const error = parsed.description ?? 'sendDocument failed';
                            bridgeLog(`[Telegram] sendDocument error: ${error}`);
                            resolve({ ok: false, error });
                        }
                    } catch {
                        resolve({ ok: false, error: 'Failed to parse sendDocument response' });
                    }
                });
            });

            req.on('error', (err: Error) => {
                bridgeLog(`[Telegram] sendDocument request error: ${err.message}`);
                resolve({ ok: false, error: `Network error: ${err.message}` });
            });
            req.on('timeout', () => {
                req.destroy();
                resolve({ ok: false, error: 'Request timed out' });
            });

            req.write(body);
            req.end();
        });
    }

    // -----------------------------------------------------------------------
    // Receiving
    // -----------------------------------------------------------------------

    startListening(): void {
        if (this._isListening || !this.isEnabled) { return; }

        // One getUpdates consumer per bot token (see activePollTokens). If another
        // channel in this host already polls this token, don't start a second loop
        // — that's the 409-Conflict "two clients" storm. Defer silently; the owner
        // keeps receiving and this channel can still send.
        const token = this.config.botToken;
        if (TelegramChannel.activePollTokens.has(token)) {
            bridgeLog('[Telegram] Channel: not starting a second poll loop — this bot token is already being polled in this window (avoids 409 Conflict).');
            return;
        }
        TelegramChannel.activePollTokens.add(token);
        this.holdsPollClaim = true;
        this._isListening = true;

        bridgeLog(`[Telegram] Channel: starting poll (interval: ${this.config.pollIntervalMs}ms)`);

        // Skip any backlog that piled up while we weren't polling BEFORE starting
        // the processing loop. Otherwise stale commands replay on every startup —
        // most damagingly a leftover `/stop`, which immediately stops the poller
        // again before the offset is ever acknowledged, so the backlog never
        // clears and the same ghost commands fire on the next start, forever.
        this.primePollOffset()
            .catch(() => { /* ignore prime errors; the loop retries from offset 0 */ })
            .finally(() => {
                // A `/stop`/dispose during priming clears the flag — honour it and
                // don't start (or double-start) the loop.
                if (!this._isListening || this.pollTimer) { return; }
                this.pollTimer = setInterval(async () => {
                    try {
                        await this.fetchUpdates();
                    } catch (err: any) {
                        bridgeLog(`[Telegram] Poll error: ${err.message}`);
                    }
                }, this.config.pollIntervalMs);
            });
    }

    stopListening(): void {
        // Release the poll claim regardless, so a deferred channel (or this one
        // restarting) can take over the token later.
        if (this.holdsPollClaim) {
            TelegramChannel.activePollTokens.delete(this.config.botToken);
            this.holdsPollClaim = false;
        }
        // Idempotent: avoid the double "polling stopped" log when both the
        // notifier and the channel are disposed in sequence.
        if (!this._isListening && !this.pollTimer) { return; }
        if (this.pollTimer) {
            clearInterval(this.pollTimer);
            this.pollTimer = null;
        }
        this._isListening = false;
        this.lastPollErrorCode = null;
        bridgeLog('[Telegram] Channel: polling stopped');
    }

    onMessage(callback: ChannelMessageCallback): void {
        this.messageCallbacks.push(callback);
    }

    /**
     * Register a callback for getUpdates errors (e.g. 409 Conflict when another
     * window/client is already polling this bot token). Fired once per distinct
     * error code, not on every poll tick.
     */
    onPollError(callback: (err: { code?: number; description: string }) => void): void {
        this.pollErrorCallback = callback;
    }

    // -----------------------------------------------------------------------
    // Lifecycle
    // -----------------------------------------------------------------------

    dispose(): void {
        this.stopListening();
        this.messageCallbacks = [];
    }

    // -----------------------------------------------------------------------
    // Internal: polling
    // -----------------------------------------------------------------------

    /**
     * Advance the update offset past any messages that arrived before polling
     * started, WITHOUT dispatching them, so stale commands (e.g. a leftover
     * `/stop`) don't replay on every startup. getUpdates(-1) returns only the
     * most recent update and forgets earlier ones; recording its id means the
     * first real poll (offset = lastUpdateId + 1) confirms/discards the backlog.
     */
    private async primePollOffset(): Promise<void> {
        const updates = await this.getUpdates(-1);
        if (!updates) { return; }
        for (const update of updates) {
            this.lastUpdateId = Math.max(this.lastUpdateId, update.update_id);
        }
    }

    /** Fetch and process updates from Telegram. */
    private async fetchUpdates(): Promise<void> {
        const updates = await this.getUpdates(this.lastUpdateId + 1);
        if (!updates || updates.length === 0) { return; }

        for (const update of updates) {
            this.lastUpdateId = Math.max(this.lastUpdateId, update.update_id);
            this.processUpdate(update);
        }
    }

    /** Convert a Telegram update into a ChannelMessage and dispatch. */
    private processUpdate(update: TelegramUpdate): void {
        const msg = update.message;
        if (!msg || !msg.text || !msg.from) { return; }

        // Security: only allow whitelisted users
        if (!this.config.allowedUserIds.includes(msg.from.id)) {
            bridgeLog(`[Telegram] Rejected message from unauthorized user: ${msg.from.id} (${msg.from.username ?? 'unknown'})`);
            this.sendMessage(
                `⛔ Unauthorized. Your user ID (${msg.from.id}) is not whitelisted.`,
                msg.chat.id,
                { plain: true },
            );
            return;
        }

        const channelMessage: ChannelMessage = {
            senderId: msg.from.id,
            senderName: msg.from.username ?? msg.from.first_name,
            chatId: msg.chat.id,
            text: msg.text.trim(),
            timestamp: msg.date,
            raw: update,
        };

        for (const cb of this.messageCallbacks) {
            cb(channelMessage);
        }
    }

    /** Get updates from Telegram via short polling. */
    private getUpdates(offset: number): Promise<TelegramUpdate[]> {
        return new Promise((resolve) => {
            const body = JSON.stringify({
                offset,
                timeout: 0, // Short poll, don't long-poll in VS Code
                // eslint-disable-next-line @typescript-eslint/naming-convention
                allowed_updates: ['message'],
            });

            const options: https.RequestOptions = {
                hostname: 'api.telegram.org',
                path: `/bot${this.config.botToken}/getUpdates`,
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json', // eslint-disable-line @typescript-eslint/naming-convention
                    'Content-Length': Buffer.byteLength(body), // eslint-disable-line @typescript-eslint/naming-convention
                },
                timeout: 10000,
            };

            const req = https.request(options, (res) => {
                let responseBody = '';
                res.on('data', (chunk: Buffer) => { responseBody += chunk.toString(); });
                res.on('end', () => {
                    try {
                        const parsed = JSON.parse(responseBody);
                        if (parsed.ok) {
                            // Successful poll — clear any prior error so a later
                            // recurrence is reported again.
                            this.lastPollErrorCode = null;
                            resolve(parsed.result ?? []);
                        } else {
                            // Surface the API error (notably 409 Conflict — another
                            // client is already polling this bot token) instead of
                            // silently returning no updates.
                            this.reportPollError(parsed.error_code, parsed.description ?? 'getUpdates failed');
                            resolve([]);
                        }
                    } catch {
                        resolve([]);
                    }
                });
            });

            req.on('error', () => resolve([]));
            req.on('timeout', () => { req.destroy(); resolve([]); });

            req.write(body);
            req.end();
        });
    }

    /**
     * Report a getUpdates error to the registered callback, de-duplicated by
     * error code so a persistent conflict (e.g. 409) doesn't fire on every poll
     * tick. Always logged; the callback (if any) drives the user-facing toast.
     */
    private reportPollError(code: number | undefined, description: string): void {
        const normalized = code ?? -1;
        if (this.lastPollErrorCode === normalized) { return; }
        this.lastPollErrorCode = normalized;
        bridgeLog(`[Telegram] getUpdates error${code ? ` (${code})` : ''}: ${description}`);
        this.pollErrorCallback?.({ code, description });
    }

    // -----------------------------------------------------------------------
    // Internal: API helpers
    // -----------------------------------------------------------------------

    /** Call a Telegram Bot API method and return detailed result. */
    private apiCallWithDetails(method: string, body: any): Promise<ChannelResult> {
        return new Promise((resolve) => {
            const data = JSON.stringify(body);
            const options: https.RequestOptions = {
                hostname: 'api.telegram.org',
                path: `/bot${this.config.botToken}/${method}`,
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json', // eslint-disable-line @typescript-eslint/naming-convention
                    'Content-Length': Buffer.byteLength(data), // eslint-disable-line @typescript-eslint/naming-convention
                },
                timeout: 10000,
            };

            const req = https.request(options, (res) => {
                let responseBody = '';
                res.on('data', (chunk: Buffer) => { responseBody += chunk.toString(); });
                res.on('end', () => {
                    try {
                        const parsed = JSON.parse(responseBody);
                        if (parsed.ok === true) {
                            resolve({ ok: true });
                        } else {
                            const error = parsed.description ?? 'Unknown Telegram API error';
                            bridgeLog(`[Telegram] API error (${method}): ${error}`);
                            resolve({ ok: false, error });
                        }
                    } catch {
                        resolve({ ok: false, error: 'Failed to parse Telegram API response' });
                    }
                });
            });

            req.on('error', (err) => {
                bridgeLog(`[Telegram] Request error (${method}): ${err.message}`);
                resolve({ ok: false, error: `Network error: ${err.message}` });
            });
            req.on('timeout', () => {
                req.destroy();
                resolve({ ok: false, error: 'Request timed out' });
            });

            req.write(data);
            req.end();
        });
    }

    /** Truncate text to a maximum length, appending '...' if truncated. */
    private truncate(text: string, maxLen: number): string {
        if (text.length <= maxLen) { return text; }
        return text.substring(0, maxLen - 3) + '...';
    }
}
