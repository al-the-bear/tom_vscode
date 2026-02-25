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

    private config: TelegramConfig;
    private lastUpdateId: number = 0;
    private pollTimer: ReturnType<typeof setInterval> | null = null;
    private _isListening = false;
    private messageCallbacks: ChannelMessageCallback[] = [];

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
        this._isListening = true;

        bridgeLog(`[Telegram] Channel: starting poll (interval: ${this.config.pollIntervalMs}ms)`);

        // Initial fetch to get current offset
        this.fetchUpdates().catch(() => { /* ignore initial errors */ });

        this.pollTimer = setInterval(async () => {
            try {
                await this.fetchUpdates();
            } catch (err: any) {
                bridgeLog(`[Telegram] Poll error: ${err.message}`);
            }
        }, this.config.pollIntervalMs);
    }

    stopListening(): void {
        if (this.pollTimer) {
            clearInterval(this.pollTimer);
            this.pollTimer = null;
        }
        this._isListening = false;
        bridgeLog('[Telegram] Channel: polling stopped');
    }

    onMessage(callback: ChannelMessageCallback): void {
        this.messageCallbacks.push(callback);
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
                        resolve(parsed.ok ? (parsed.result ?? []) : []);
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
