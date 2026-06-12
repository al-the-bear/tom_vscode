/**
 * Unit tests for {@link TelegramTrailCoalescer}.
 *
 * The coalescer turns the fine-grained live-trail event stream into a small set
 * of Telegram-friendly messages. These tests pin the policy: drop noise
 * (thinking / tool results), coalesce assistant text, preserve ordering around
 * structural events, and split oversize output to respect the message cap.
 */

import test, { describe } from 'node:test';
import assert from 'node:assert/strict';

import {
    TelegramTrailCoalescer,
    formatTrailTerminalLine,
    splitTelegramMessage,
} from '../telegramTrailCoalescer.js';
import type { LiveTrailEvent } from '../live-trail.js';

const Q = 'demo';

describe('TelegramTrailCoalescer', () => {
    test('prompt event restates the prompt text under the transport/config header', () => {
        const c = new TelegramTrailCoalescer();
        const out = c.push({ kind: 'prompt', questId: Q, transport: 'anthropic', config: 'default', userText: 'summarize the bug' });
        assert.deepEqual(out, ['🚀 prompt [anthropic/default]\n\nsummarize the bug']);
    });

    test('prompt event with empty text falls back to the header only', () => {
        const c = new TelegramTrailCoalescer();
        const out = c.push({ kind: 'prompt', questId: Q, transport: 'anthropic', config: 'default', userText: '   ' });
        assert.deepEqual(out, ['🚀 prompt [anthropic/default]']);
    });

    test('an oversize prompt restatement is split to the message cap', () => {
        const c = new TelegramTrailCoalescer({ maxMessageChars: 20 });
        // Header "🚀 prompt [a/b]\n\n" is 17 chars; with a 30-char body the
        // combined message exceeds the 20-char cap and is hard-sliced.
        const out = c.push({ kind: 'prompt', questId: Q, transport: 'a', config: 'b', userText: 'X'.repeat(30) });
        assert.ok(out.length > 1, 'expected the restatement to span multiple messages');
        assert.ok(out[0].startsWith('🚀 prompt [a/b]'), 'first chunk keeps the header');
        assert.equal(out.join('').replace('🚀 prompt [a/b]\n\n', ''), 'X'.repeat(30));
    });

    test('prompt event flushes stale buffered text before restating', () => {
        const c = new TelegramTrailCoalescer();
        c.push({ kind: 'assistant', questId: Q, text: 'leftover' });
        const out = c.push({ kind: 'prompt', questId: Q, transport: 'anthropic', config: 'default', userText: 'next' });
        assert.deepEqual(out, ['leftover', '🚀 prompt [anthropic/default]\n\nnext']);
    });

    test('thinking and tool-result events are dropped as noise', () => {
        const c = new TelegramTrailCoalescer();
        assert.deepEqual(c.push({ kind: 'thinking', questId: Q, text: 'pondering' }), []);
        assert.deepEqual(c.push({ kind: 'toolResult', questId: Q, fullLength: 1234 }), []);
    });

    test('assistant text is buffered, not emitted per chunk', () => {
        const c = new TelegramTrailCoalescer();
        assert.deepEqual(c.push({ kind: 'assistant', questId: Q, text: 'Hello ' }), []);
        assert.deepEqual(c.push({ kind: 'assistant', questId: Q, text: 'world' }), []);
        // Only flush surfaces the concatenated buffer.
        assert.deepEqual(c.flush(), ['Hello world']);
    });

    test('a structural event flushes pending assistant text before its own line', () => {
        const c = new TelegramTrailCoalescer();
        c.push({ kind: 'assistant', questId: Q, text: 'Looking into it. ' });
        const out = c.push({ kind: 'toolCall', questId: Q, toolName: 'Read', replayKey: 'r1' });
        assert.deepEqual(out, ['Looking into it.', '🔧 Read']);
    });

    test('done event flushes text then emits a summary footer', () => {
        const c = new TelegramTrailCoalescer();
        c.push({ kind: 'assistant', questId: Q, text: 'All set.' });
        const out = c.push({ kind: 'done', questId: Q, rounds: 2, toolCalls: 3, durationMs: 4500 });
        assert.deepEqual(out, ['All set.', '✅ done (rounds=2, tools=3, 4500ms)']);
    });

    test('error event flushes text then emits an error line', () => {
        const c = new TelegramTrailCoalescer();
        c.push({ kind: 'assistant', questId: Q, text: 'partial' });
        const out = c.push({ kind: 'error', questId: Q, message: 'boom' });
        assert.deepEqual(out, ['partial', '⚠️ error: boom']);
    });

    test('interruption event emits a labelled line', () => {
        const c = new TelegramTrailCoalescer();
        const out = c.push({ kind: 'interruption', questId: Q, label: 'RATE LIMIT', message: 'slow down' });
        assert.deepEqual(out, ['🟡 RATE LIMIT: slow down']);
    });

    test('flush returns nothing when the buffer is empty', () => {
        const c = new TelegramTrailCoalescer();
        assert.deepEqual(c.flush(), []);
    });

    test('a single oversize assistant burst is split to the message cap', () => {
        const c = new TelegramTrailCoalescer({ maxMessageChars: 10 });
        // 25 chars => emits two full 10-char chunks immediately, retains 5.
        const out = c.push({ kind: 'assistant', questId: Q, text: 'A'.repeat(25) });
        assert.deepEqual(out, ['AAAAAAAAAA', 'AAAAAAAAAA']);
        // The retained tail comes out on flush.
        assert.deepEqual(c.flush(), ['AAAAA']);
    });

    test('streamed chunks that cross the threshold emit on push, leaving a sub-cap tail', () => {
        const c = new TelegramTrailCoalescer({ maxMessageChars: 10 });
        // Three 4-char chunks: buffer reaches 12 on the third push, which emits
        // one 10-char message immediately and retains the 2-char remainder.
        assert.deepEqual(c.push({ kind: 'assistant', questId: Q, text: 'aaaa' }), []);
        assert.deepEqual(c.push({ kind: 'assistant', questId: Q, text: 'bbbb' }), []);
        assert.deepEqual(c.push({ kind: 'assistant', questId: Q, text: 'cccc' }), ['aaaabbbbcc']);
        // The retained tail (< cap) comes out as a single flush message.
        assert.deepEqual(c.flush(), ['cc']);
    });

    test('ordering across multiple structural events is preserved', () => {
        const c = new TelegramTrailCoalescer();
        const collected: string[] = [];
        const feed = (e: LiveTrailEvent): void => { collected.push(...c.push(e)); };
        feed({ kind: 'prompt', questId: Q, transport: 'anthropic', config: 'default', userText: 'x' });
        feed({ kind: 'assistant', questId: Q, text: 'thinking aloud ' });
        feed({ kind: 'toolCall', questId: Q, toolName: 'Grep', replayKey: 'r1' });
        feed({ kind: 'toolResult', questId: Q, fullLength: 99 });
        feed({ kind: 'assistant', questId: Q, text: 'found it' });
        feed({ kind: 'done', questId: Q, rounds: 1, toolCalls: 1, durationMs: 100 });
        assert.deepEqual(collected, [
            '🚀 prompt [anthropic/default]\n\nx',
            'thinking aloud',
            '🔧 Grep',
            'found it',
            '✅ done (rounds=1, tools=1, 100ms)',
        ]);
    });
});

describe('formatTrailTerminalLine', () => {
    test('formats a done event', () => {
        assert.equal(
            formatTrailTerminalLine({ kind: 'done', questId: Q, rounds: 2, toolCalls: 3, durationMs: 4500 }),
            '✅ done (rounds=2, tools=3, 4500ms)',
        );
    });
    test('formats an error event', () => {
        assert.equal(
            formatTrailTerminalLine({ kind: 'error', questId: Q, message: 'boom' }),
            '⚠️ error: boom',
        );
    });
    test('formats an interruption event', () => {
        assert.equal(
            formatTrailTerminalLine({ kind: 'interruption', questId: Q, label: 'RATE LIMIT', message: 'slow down' }),
            '🟡 RATE LIMIT: slow down',
        );
    });
    test('matches the coalescer footer for the same event', () => {
        const c = new TelegramTrailCoalescer();
        const event: LiveTrailEvent = { kind: 'done', questId: Q, rounds: 1, toolCalls: 0, durationMs: 10 };
        assert.deepEqual(c.push(event), [formatTrailTerminalLine(event)]);
    });
});

describe('splitTelegramMessage', () => {
    test('returns [] for empty input', () => {
        assert.deepEqual(splitTelegramMessage(''), []);
    });
    test('returns the whole string when under the cap', () => {
        assert.deepEqual(splitTelegramMessage('short', 10), ['short']);
    });
    test('hard-slices oversize text into cap-sized chunks', () => {
        assert.deepEqual(splitTelegramMessage('A'.repeat(25), 10), [
            'AAAAAAAAAA',
            'AAAAAAAAAA',
            'AAAAA',
        ]);
    });
});
