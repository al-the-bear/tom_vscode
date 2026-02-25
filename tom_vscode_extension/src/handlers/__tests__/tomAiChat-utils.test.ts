import test from 'node:test';
import assert from 'node:assert/strict';
import { buildMetadataBlock, parseChatText, TOOL_SEPARATOR } from '../tomAiChat-utils';

const sampleChat = (chatId: string) => [
    'toolInvocationToken: ',
    `modelId: gpt-4o`,
    '',
    `${'_'.repeat(9)} CHAT ${chatId} ${'_'.repeat(12)}`,
    '',
    'Hello there',
    TOOL_SEPARATOR,
    'Old prompt'
].join('\n');

test('parseChatText extracts prompt block', () => {
    const chatId = 'example';
    const parsed = parseChatText(sampleChat(chatId), `/tmp/${chatId}.chat.md`);
    assert.equal(parsed.chatId, chatId);
    assert.equal(parsed.promptText, 'Hello there');
});

test('buildMetadataBlock includes chat header', () => {
    const block = buildMetadataBlock('demo', 'gpt-5.2', 'gpt-4o', 50000, 8000);
    assert.ok(block.includes('CHAT demo'));
});
