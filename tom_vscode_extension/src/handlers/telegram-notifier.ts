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
 * Configuration lives in botConversation.telegram section of tom_vscode_extension.json.
 */

import { ChatChannel, ChannelMessage, ChannelResult } from './chat';
import { bridgeLog } from './handler_shared';
import { escapeMarkdownV2 } from './telegram-markdown';

// ============================================================================
// Interfaces
// ============================================================================

/** Telegram configuration from tom_vscode_extension.json → botConversation.telegram */
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
    /** Whether to send a notification for each turn. */
    notifyOnTurn: boolean;
    /** Whether to send a notification when the conversation starts. */
    notifyOnStart: boolean;
    /** Whether to send a notification when the conversation ends. */
    notifyOnEnd: boolean;
    /** Whether to include the full Copilot response text in notifications. */
    includeResponseText: boolean;
    /** Max characters of response text to include in notifications. */
    maxResponseChars: number;
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
    notifyOnTurn: true,
    notifyOnStart: true,
    notifyOnEnd: true,
    includeResponseText: true,
    maxResponseChars: 500,
    pollIntervalMs: 2000,
};

// ============================================================================
// TelegramNotifier
// ============================================================================

export class TelegramNotifier {
    private channel: ChatChannel;
    private config: TelegramConfig;
    private commandCallback: TelegramCommandCallback | null = null;

    constructor(channel: ChatChannel, config: TelegramConfig) {
        this.channel = channel;
        this.config = config;

        // Subscribe to channel messages and parse into TelegramCommands
        this.channel.onMessage((msg: ChannelMessage) => this.handleChannelMessage(msg));
    }

    /** Whether this notifier is properly configured and enabled. */
    get isEnabled(): boolean {
        return this.channel.isEnabled;
    }

    /** Update config (notification settings). */
    updateConfig(config: TelegramConfig): void {
        this.config = config;
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

    /** Send a conversation start notification. */
    async notifyStart(conversationId: string, goal: string, profile: string): Promise<void> {
        if (!this.config.notifyOnStart) { return; }
        const msg = `🤖 *Bot Conversation Started*\n\n` +
            `*ID:* \`${conversationId}\`\n` +
            `*Profile:* ${profile}\n` +
            `*Goal:* ${this.escapeMarkdown(goal)}\n\n` +
            `Commands: stop halt continue status\n` +
            `Send info: info <your message>`;
        await this.sendMessage(msg);
    }

    /** Send a turn completion notification. */
    async notifyTurn(
        turn: number,
        maxTurns: number,
        promptPreview: string,
        responsePreview: string,
        stats?: { promptTokens: number; completionTokens: number; totalDurationMs: number },
    ): Promise<void> {
        if (!this.config.notifyOnTurn) { return; }

        let msg = `📝 *Turn ${turn}/${maxTurns}*\n\n`;
        msg += `*Prompt:* ${this.escapeMarkdown(this.truncate(promptPreview, 200))}\n\n`;

        if (this.config.includeResponseText) {
            msg += `*Response:* ${this.escapeMarkdown(this.truncate(responsePreview, this.config.maxResponseChars))}\n`;
        }

        if (stats) {
            msg += `\n_${stats.promptTokens}+${stats.completionTokens} tokens, ${(stats.totalDurationMs / 1000).toFixed(1)}s_`;
        }

        await this.sendMessage(msg);
    }

    /** Send a conversation end notification. */
    async notifyEnd(conversationId: string, turns: number, goalReached: boolean, reason?: string): Promise<void> {
        if (!this.config.notifyOnEnd) { return; }
        const status = goalReached ? '✅ Goal Reached' : reason ? `⏹ ${reason}` : '⏹ Ended';
        const msg = `🏁 *Bot Conversation Ended*\n\n` +
            `*ID:* \`${conversationId}\`\n` +
            `*Turns:* ${turns}\n` +
            `*Status:* ${status}`;
        await this.sendMessage(msg);
    }

    /** Send a halt notification. */
    async notifyHalted(turn: number): Promise<void> {
        await this.sendMessage(`⏸ *Conversation halted* after turn ${turn}\.
Send continue to resume or info <text> to add context\.`);
    }

    /** Send a continue notification. */
    async notifyContinued(additionalInfo?: string): Promise<void> {
        let msg = `▶️ *Conversation resumed*`;
        if (additionalInfo) {
            msg += `\nAdditional info will be included in next prompt.`;
        }
        await this.sendMessage(msg);
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

    /** Escape MarkdownV2 special characters for Telegram. */
    private escapeMarkdown(text: string): string {
        return escapeMarkdownV2(text);
    }

    /** Truncate text to a maximum length, appending '...' if truncated. */
    private truncate(text: string, maxLen: number): string {
        if (text.length <= maxLen) { return text; }
        return text.substring(0, maxLen - 3) + '...';
    }

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
 * Parse Telegram config from a raw botConversation.telegram object.
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

    return {
        enabled: typeof raw.enabled === 'boolean' ? raw.enabled : TELEGRAM_DEFAULTS.enabled,
        botTokenEnv,
        botToken,
        allowedUserIds: Array.isArray(raw.allowedUserIds)
            ? raw.allowedUserIds.filter((id: any) => typeof id === 'number')
            : TELEGRAM_DEFAULTS.allowedUserIds,
        defaultChatId: typeof raw.defaultChatId === 'number' ? raw.defaultChatId : TELEGRAM_DEFAULTS.defaultChatId,
        notifyOnTurn: typeof raw.notifyOnTurn === 'boolean' ? raw.notifyOnTurn : TELEGRAM_DEFAULTS.notifyOnTurn,
        notifyOnStart: typeof raw.notifyOnStart === 'boolean' ? raw.notifyOnStart : TELEGRAM_DEFAULTS.notifyOnStart,
        notifyOnEnd: typeof raw.notifyOnEnd === 'boolean' ? raw.notifyOnEnd : TELEGRAM_DEFAULTS.notifyOnEnd,
        includeResponseText: typeof raw.includeResponseText === 'boolean' ? raw.includeResponseText : TELEGRAM_DEFAULTS.includeResponseText,
        maxResponseChars: typeof raw.maxResponseChars === 'number' ? raw.maxResponseChars : TELEGRAM_DEFAULTS.maxResponseChars,
        pollIntervalMs: typeof raw.pollIntervalMs === 'number' ? raw.pollIntervalMs : TELEGRAM_DEFAULTS.pollIntervalMs,
    };
}
