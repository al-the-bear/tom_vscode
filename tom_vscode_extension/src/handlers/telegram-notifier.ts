/**
 * Telegram Bot integration for Bot Conversation notifications.
 *
 * Higher-level Telegram integration that sits on top of the ChatChannel
 * abstraction. Handles notification formatting, command parsing, and
 * bot conversation interaction.
 *
 * The underlying transport (HTTP calls, polling) is handled by the
 * ChatChannel implementation (e.g. TelegramChannel).
 *
 * Configuration lives in aiConversation.telegram section of tom_vscode_extension.json.
 */

import { ChatChannel, ChannelMessage, ChannelResult } from './chat';
import { bridgeLog } from './handler_shared';

// ============================================================================
// Interfaces
// ============================================================================

/** Telegram configuration from tom_vscode_extension.json → aiConversation.telegram */
export interface TelegramConfig {
    /** Whether Telegram integration is enabled. */
    enabled: boolean;
    /** Name of the environment variable that holds the Bot API token. */
    botTokenEnv: string;
    /** Resolved Bot API token (read from the environment variable at parse time). */
    botToken: string;
    /** Whitelisted Telegram user IDs (numeric). Only these can interact. */
    allowedUserIds: number[];
    /** Default chat ID to send notifications to (usually your personal chat). */
    defaultChatId: number;
    /** Polling interval in milliseconds for incoming messages. */
    pollIntervalMs: number;
}

/** A command received from Telegram. */
export interface TelegramCommand {
    /** Command type. */
    type: 'stop' | 'halt' | 'continue' | 'info' | 'status' | 'unknown';
    /** Additional text (for info command). */
    text: string;
    /** Telegram user ID who sent the command. */
    userId: number;
    /** Chat ID for replies. */
    chatId: number;
    /** Username of sender. */
    username: string;
}

/** Callback type for when a command is received. */
export type TelegramCommandCallback = (command: TelegramCommand) => void;

/** Result of a Telegram API call. Alias for ChannelResult. */
export type TelegramApiResult = ChannelResult;

// ============================================================================
// Default config
// ============================================================================

export const TELEGRAM_DEFAULTS: TelegramConfig = {
    enabled: false,
    botTokenEnv: '',
    botToken: '',
    allowedUserIds: [],
    defaultChatId: 0,
    pollIntervalMs: 2000,
};

// ============================================================================
// TelegramNotifier
// ============================================================================

export class TelegramNotifier {
    private channel: ChatChannel;
    private commandCallback: TelegramCommandCallback | null = null;

    constructor(channel: ChatChannel, _config: TelegramConfig) {
        this.channel = channel;

        // Subscribe to channel messages and parse into TelegramCommands
        this.channel.onMessage((msg: ChannelMessage) => this.handleChannelMessage(msg));
    }

    /** Whether this notifier is properly configured and enabled. */
    get isEnabled(): boolean {
        return this.channel.isEnabled;
    }

    // -----------------------------------------------------------------------
    // Sending messages (delegates to channel)
    // -----------------------------------------------------------------------

    /** Send a text message to the default chat. */
    async sendMessage(text: string, chatId?: number): Promise<boolean> {
        const result = await this.channel.sendMessage(text, chatId);
        return result.ok;
    }

    /** Send a text message and return detailed result (including error message). */
    async sendMessageWithDetails(text: string, chatId?: number): Promise<TelegramApiResult> {
        return this.channel.sendMessage(text, chatId);
    }

    // -----------------------------------------------------------------------
    // Polling for incoming commands (delegates to channel)
    // -----------------------------------------------------------------------

    /** Start polling for incoming Telegram messages. */
    startPolling(): void {
        this.channel.startListening();
    }

    /** Stop polling. */
    stopPolling(): void {
        this.channel.stopListening();
    }

    /** Register a callback for received commands. */
    onCommand(callback: TelegramCommandCallback): void {
        this.commandCallback = callback;
    }

    // -----------------------------------------------------------------------
    // Internal: channel message → TelegramCommand
    // -----------------------------------------------------------------------

    /** Handle an incoming channel message, parse it into a TelegramCommand, and dispatch. */
    private handleChannelMessage(msg: ChannelMessage): void {
        const command = this.parseCommand(
            msg.text,
            msg.senderId as number,
            msg.chatId as number,
            msg.senderName,
        );

        if (command && this.commandCallback) {
            bridgeLog(`[Telegram] Command from ${msg.senderName}: ${command.type}${command.text ? ' — ' + command.text.substring(0, 50) : ''}`);
            this.commandCallback(command);
        }
    }

    /** Parse a text message into a TelegramCommand. Accepts with or without / prefix. */
    private parseCommand(text: string, userId: number, chatId: number, username: string): TelegramCommand | null {
        // Strip optional leading / for command matching
        const stripped = text.startsWith('/') ? text.substring(1) : text;
        const lower = stripped.toLowerCase();

        if (lower === 'stop' || lower === 'stop@' || lower.startsWith('stop ')) {
            return { type: 'stop', text: '', userId, chatId, username };
        }
        if (lower === 'halt' || lower === 'halt@' || lower === 'pause' || lower.startsWith('halt ')) {
            return { type: 'halt', text: '', userId, chatId, username };
        }
        if (lower === 'continue' || lower === 'continue@' || lower === 'resume' || lower.startsWith('continue ')) {
            return { type: 'continue', text: '', userId, chatId, username };
        }
        if (lower === 'status') {
            return { type: 'status', text: '', userId, chatId, username };
        }
        if (lower.startsWith('info ') || lower.startsWith('add ')) {
            const infoText = stripped.substring(stripped.indexOf(' ') + 1).trim();
            if (infoText) {
                return { type: 'info', text: infoText, userId, chatId, username };
            }
        }

        // Check if this looks like a command (first word matches a known pattern)
        // If it doesn't match any known command, treat as info text
        const firstWord = lower.split(/\s/)[0];
        const knownCommands = ['stop', 'halt', 'pause', 'continue', 'resume', 'status', 'info', 'add',
            'help', 'ls', 'cd', 'cwd', 'project', 'dart', 'problems', 'todos',
            'bk', 'buildkit', 'tk', 'testkit', 'bridge', 'cli-integration'];
        if (!knownCommands.includes(firstWord)) {
            // Not a recognized command — treat as info message
            return { type: 'info', text, userId, chatId, username };
        }

        return { type: 'unknown', text, userId, chatId, username };
    }

    // -----------------------------------------------------------------------
    // Utilities
    // -----------------------------------------------------------------------

    /** Dispose/cleanup. Does NOT dispose the channel (managed by creator). */
    dispose(): void {
        this.stopPolling();
        this.commandCallback = null;
    }
}

// ============================================================================
// Config parser
// ============================================================================

/**
 * Parse Telegram config from a raw aiConversation.telegram object.
 */
export function parseTelegramConfig(raw: any): TelegramConfig {
    if (!raw || typeof raw !== 'object') { return { ...TELEGRAM_DEFAULTS }; }

    // Resolve bot token from environment variable
    const botTokenEnv = typeof raw.botTokenEnv === 'string' ? raw.botTokenEnv : TELEGRAM_DEFAULTS.botTokenEnv;
    let botToken = '';
    if (botTokenEnv) {
        botToken = process.env[botTokenEnv] ?? '';
        if (!botToken) {
            bridgeLog(`[Telegram] Environment variable '${botTokenEnv}' is not set or empty`);
        }
    }

    const defaultChatId = typeof raw.defaultChatId === 'number' ? raw.defaultChatId : TELEGRAM_DEFAULTS.defaultChatId;
    const explicitAllowed = Array.isArray(raw.allowedUserIds)
        ? raw.allowedUserIds.filter((id: any) => typeof id === 'number')
        : [...TELEGRAM_DEFAULTS.allowedUserIds];
    // The personal chat id and the user id coincide in Telegram, so the
    // defaultChatId is always implicitly an authorized user — fold it into the
    // allow-list so every consumer (isEnabled, the inbound whitelist check, the
    // empty-list warning) treats it as allowed even when not listed explicitly.
    const allowedUserIds = defaultChatId && !explicitAllowed.includes(defaultChatId)
        ? [...explicitAllowed, defaultChatId]
        : explicitAllowed;

    return {
        enabled: typeof raw.enabled === 'boolean' ? raw.enabled : TELEGRAM_DEFAULTS.enabled,
        botTokenEnv,
        botToken,
        allowedUserIds,
        defaultChatId,
        pollIntervalMs: typeof raw.pollIntervalMs === 'number' ? raw.pollIntervalMs : TELEGRAM_DEFAULTS.pollIntervalMs,
    };
}
