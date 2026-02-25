/**
 * Telegram Command Response Formatter.
 *
 * Handles:
 *  - Truncation to Telegram's 4096 char limit (default 4000 usable)
 *  - Sending long responses as file attachments
 *  - --attach flag for forced attachment mode
 *  - Markdown conversion via telegramify-markdown (MarkdownV2)
 *
 * Uses a ChatChannel for all sending operations, eliminating duplicate
 * HTTP code. Uses telegramify-markdown for Markdown→MarkdownV2 conversion.
 */

import { ChatChannel } from './chat';
import { bridgeLog } from './handler_shared';
import { TelegramCommandResult, ParsedTelegramCommand } from './telegram-cmd-parser';
import { toTelegramMarkdownV2, escapeMarkdownV2, stripMarkdown } from './telegram-markdown';

// ============================================================================
// Constants
// ============================================================================

/** Max chars for a Telegram text message. */
const TELEGRAM_MAX_MESSAGE = 4096;

/** Default usable limit (leaves room for wrapper text). */
const DEFAULT_TRUNCATE_LIMIT = 4000;

/** Truncation marker. */
const TRUNCATION_MARKER = '\n\n_... output truncated. Use --attach for full output._';

// ============================================================================
// Response Formatter
// ============================================================================

export class TelegramResponseFormatter {
    private channel: ChatChannel;

    constructor(channel: ChatChannel) {
        this.channel = channel;
    }

    /** Update the channel reference. */
    updateChannel(channel: ChatChannel): void {
        this.channel = channel;
    }

    /**
     * Format and send the result of a command execution.
     * Handles truncation, attachment mode, and markdown conversion.
     */
    async sendResult(
        result: TelegramCommandResult,
        cmd: ParsedTelegramCommand,
    ): Promise<void> {
        if (result.silent) { return; }

        const forceAttach = result.forceAttachment || cmd.flags['attach'] === true;
        let text = result.text;

        // --- Convert markdown for Telegram MarkdownV2 ---
        if (!result.rawText) {
            text = this.convertToTelegramMarkdown(text);
        }

        // --- Decide: inline message vs attachment ---
        if (forceAttach || text.length > DEFAULT_TRUNCATE_LIMIT) {
            // Send as attachment
            const filename = result.attachmentFilename ?? 'response.txt';
            const shortSummary = `${cmd.command}${cmd.subcommand ? ' ' + cmd.subcommand : ''} executed.\nSee attachment _${filename}_`;

            // Send the brief confirmation first
            await this.sendMessage(shortSummary, cmd.chatId);

            // Send the document
            await this.sendDocument(
                Buffer.from(this.stripMarkdown(result.text), 'utf-8'),
                filename,
                cmd.chatId,
            );
        } else {
            // Send inline (escaping is done in convertMarkdown)
            await this.sendMessage(text, cmd.chatId);
        }
    }

    /**
     * Send a text message to a chat.
     * The channel handles MarkdownV2 formatting with fallback to plain text.
     */
    async sendMessage(text: string, chatId: number): Promise<boolean> {
        const truncated = text.length > TELEGRAM_MAX_MESSAGE
            ? text.substring(0, TELEGRAM_MAX_MESSAGE - TRUNCATION_MARKER.length) + TRUNCATION_MARKER
            : text;

        const result = await this.channel.sendMessage(truncated, chatId);
        return result.ok;
    }

    /**
     * Send a plain text message without any Markdown parsing.
     * Use this for acknowledgment messages that contain user input.
     */
    async sendPlainMessage(text: string, chatId: number): Promise<boolean> {
        const truncated = text.length > TELEGRAM_MAX_MESSAGE
            ? text.substring(0, TELEGRAM_MAX_MESSAGE - TRUNCATION_MARKER.length) + TRUNCATION_MARKER
            : text;

        const result = await this.channel.sendMessage(truncated, chatId, { plain: true });
        return result.ok;
    }

    /**
     * Send a file attachment (document) to a Telegram chat.
     * Delegates to the channel's sendDocument method.
     */
    async sendDocument(content: Buffer, filename: string, chatId: number): Promise<boolean> {
        const result = await this.channel.sendDocument(content, filename, chatId);
        return result.ok;
    }

    // -----------------------------------------------------------------------
    // Markdown conversion
    // -----------------------------------------------------------------------

    /**
     * Convert standard Markdown to Telegram MarkdownV2 format.
     *
     * Uses telegramify-markdown (Remark-based) to properly convert
     * standard Markdown syntax to Telegram MarkdownV2, handling:
     *  - Escaping of special characters
     *  - Bold, italic, code, links, lists, blockquotes
     *  - Stripping unsupported tags
     */
    convertToTelegramMarkdown(text: string): string {
        try {
            return toTelegramMarkdownV2(text);
        } catch (err: any) {
            bridgeLog(`[Telegram] Markdown conversion error: ${err.message}`);
            // Fallback: escape all special chars for MarkdownV2 plain text
            return escapeMarkdownV2(text);
        }
    }

    /**
     * Strip all Markdown formatting for plain-text output (attachments/fallback).
     */
    stripMarkdown(text: string): string {
        return stripMarkdown(text);
    }
}
