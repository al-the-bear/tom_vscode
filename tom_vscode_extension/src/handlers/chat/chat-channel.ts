/**
 * Chat Channel Abstraction — platform-agnostic messaging interface.
 *
 * Provides a unified transport layer for sending and receiving messages
 * across different messaging platforms (Telegram, Slack, Discord, etc.).
 *
 * Inspired by the Dart ChatApi in tom_chattools.
 *
 * Architecture:
 *   [Notification Logic / Command System]
 *                    |
 *              [ChatChannel]  ← this interface
 *                    |
 *   [TelegramChannel | SlackChannel | ...]
 */

// ============================================================================
// Types
// ============================================================================

/** Result of a channel API call. */
export interface ChannelResult {
    ok: boolean;
    error?: string;
}

/** An incoming message from a chat channel. */
export interface ChannelMessage {
    /** Platform-specific sender ID. */
    senderId: number | string;
    /** Sender display name or username. */
    senderName: string;
    /** Chat/conversation ID for replies. */
    chatId: number | string;
    /** Message text content. */
    text: string;
    /** Unix timestamp of the message (seconds since epoch). */
    timestamp: number;
    /** Platform-specific raw update data (for platform-specific processing). */
    raw?: unknown;
}

/** Callback for incoming messages. */
export type ChannelMessageCallback = (message: ChannelMessage) => void;

/** Options for sending a message. */
export interface SendMessageOptions {
    /**
     * Send as plain text without platform-specific formatting.
     * When false (default), the channel may apply markdown or rich-text
     * formatting supported by the platform.
     */
    plain?: boolean;
    /** Disable link/URL previews. Default: true. */
    disableLinkPreview?: boolean;
}

// ============================================================================
// ChatChannel interface
// ============================================================================

/**
 * Abstract chat channel interface.
 *
 * Each messaging platform implements this interface to provide
 * send/receive capabilities. Higher-level concerns like notification
 * formatting, command parsing, and bot conversation logic sit above
 * this layer.
 *
 * Usage:
 * ```typescript
 * const channel: ChatChannel = new TelegramChannel(config);
 * await channel.sendMessage('Hello!');
 * channel.onMessage((msg) => console.log(msg.text));
 * channel.startListening();
 * ```
 */
export interface ChatChannel {
    /** Platform identifier (e.g. 'telegram', 'slack', 'discord'). */
    readonly platform: string;

    /** Whether this channel is properly configured and enabled. */
    readonly isEnabled: boolean;

    /** Whether the channel is currently listening for incoming messages. */
    readonly isListening: boolean;

    // --- Sending ---

    /**
     * Send a text message.
     *
     * The channel handles platform-specific formatting (e.g. MarkdownV2 for
     * Telegram). If formatting fails, implementations should fall back to
     * plain text automatically.
     *
     * @param text Message content (may include markdown).
     * @param chatId Target chat/conversation ID. Uses platform default if omitted.
     * @param options Send options (plain text mode, link preview, etc.).
     */
    sendMessage(text: string, chatId?: number | string, options?: SendMessageOptions): Promise<ChannelResult>;

    /**
     * Send a file/document attachment.
     *
     * @param content File content as Buffer.
     * @param filename Display filename for the attachment.
     * @param chatId Target chat/conversation ID. Uses platform default if omitted.
     */
    sendDocument(content: Buffer, filename: string, chatId?: number | string): Promise<ChannelResult>;

    // --- Receiving ---

    /** Start listening for incoming messages (e.g. start polling or open websocket). */
    startListening(): void;

    /** Stop listening for incoming messages. */
    stopListening(): void;

    /**
     * Register a callback for received messages.
     * Multiple callbacks can be registered; all will be invoked for each message.
     */
    onMessage(callback: ChannelMessageCallback): void;

    // --- Lifecycle ---

    /** Clean up all resources (timers, connections, callbacks). */
    dispose(): void;
}
