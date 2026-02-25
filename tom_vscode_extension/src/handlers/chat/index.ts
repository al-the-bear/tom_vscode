/**
 * Chat Channel module — re-exports.
 *
 * Import from this barrel file for all chat channel types:
 *   import { ChatChannel, TelegramChannel, ... } from './chat';
 */

export type {
    ChatChannel,
    ChannelResult,
    ChannelMessage,
    ChannelMessageCallback,
    SendMessageOptions,
} from './chat-channel';

export { TelegramChannel } from './telegram-channel';
