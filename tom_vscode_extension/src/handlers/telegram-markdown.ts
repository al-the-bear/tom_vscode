/**
 * Telegram Markdown utilities.
 *
 * Provides MarkdownV2 text escaping for messages built with inline formatting
 * (e.g., *bold*, `code`), and re-exports telegramify-markdown for converting
 * standard Markdown to Telegram MarkdownV2.
 *
 * MarkdownV2 special characters that must be escaped outside of formatting:
 *   _ * [ ] ( ) ~ ` > # + - = | { } . !
 *
 * @see https://core.telegram.org/bots/api#markdownv2-style
 */

import telegramifyMarkdown = require('telegramify-markdown');

/**
 * Escape plain text for use inside a Telegram MarkdownV2 message.
 *
 * Use this when inserting user-supplied text (file paths, project names, etc.)
 * into a message that uses MarkdownV2 formatting like `*bold*` or `` `code` ``.
 * Do NOT use this on text that already contains intentional MarkdownV2 formatting.
 */
export function escapeMarkdownV2(text: string): string {
    return text.replace(/([_*\[\]()~`>#+\-=|{}.!\\])/g, '\\$1');
}

/**
 * Convert standard Markdown to Telegram MarkdownV2 format.
 *
 * Uses telegramify-markdown (Remark-based) to properly convert
 * standard Markdown syntax to Telegram MarkdownV2 format.
 *
 * @param text Standard Markdown text
 * @param unsupportedTagsStrategy How to handle unsupported tags: 'escape' | 'remove' | 'keep'
 */
export function toTelegramMarkdownV2(text: string, unsupportedTagsStrategy: 'escape' | 'remove' | 'keep' = 'remove'): string {
    return telegramifyMarkdown(text, unsupportedTagsStrategy);
}

/**
 * Strip all Markdown formatting for plain-text output.
 * Used as fallback when MarkdownV2 send fails.
 */
export function stripMarkdown(text: string): string {
    let result = text;
    result = result.replace(/^#{1,6}\s+/gm, '');
    result = result.replace(/\*\*(.+?)\*\*/g, '$1');
    result = result.replace(/\*(.+?)\*/g, '$1');
    result = result.replace(/_(.+?)_/g, '$1');
    result = result.replace(/`{1,3}([^`]+)`{1,3}/g, '$1');
    result = result.replace(/~~(.+?)~~/g, '$1');
    result = result.replace(/<[^>]+>/g, '');
    result = result.replace(/\[([^\]]+)\]\([^)]+\)/g, '$1');
    // Remove MarkdownV2 escape backslashes
    result = result.replace(/\\([_*\[\]()~`>#+\-=|{}.!])/g, '$1');
    return result;
}
