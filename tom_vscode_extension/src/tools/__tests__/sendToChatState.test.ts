/**
 * The busy slots of interactive Anthropic chat sends (`src/handlers/sendToChatState.ts`): one per session.
 *
 *   SS-1 nothing in flight at start; a claim takes its session's slot, a release frees it; a release twice or of a
 *        session not held is harmless
 *   SS-2 two sessions at once: each claims its own slot; the same session is refused while its send runs
 *   SS-3 cancel one session: only its hook runs; cancel without a session: every running send's hook, answering
 *        their sessions; nothing in flight or no hook: nothing cancelled; a throwing hook still counts
 *   SS-4 a hook registered after the claim (setAnthropicSendCancel) arms; for a session not held it is ignored; a
 *        released slot's hook never fires
 *   SS-5 cancel by chat item: the send shown as that prompt queue entry, no other
 *   SS-6 the free sessions: none with a chat send in flight, none the queue runs in, each once, in order
 *   SS-7 the busy warning names the session
 *
 * Lives under tools/__tests__ (the directory `npm test` globs); the module is dependency-free.
 */

import test, { describe, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

import {
    isAnthropicSendInFlight,
    anthropicSendSessions,
    tryBeginAnthropicSend,
    setAnthropicSendCancel,
    setAnthropicSendChatItem,
    cancelAnthropicSend,
    cancelAnthropicSendOfChatItem,
    endAnthropicSend,
    freeChatSessions,
    busySessionWarning,
    __resetAnthropicSendsForTests,
} from '../../handlers/sendToChatState.js';

describe('sendToChatState — one chat send slot per session', () => {
    beforeEach(() => __resetAnthropicSendsForTests());

    test('SS-1: claim and release', () => {
        assert.equal(isAnthropicSendInFlight(), false);
        assert.equal(isAnthropicSendInFlight('chat'), false);
        assert.equal(tryBeginAnthropicSend('chat'), true);
        assert.equal(isAnthropicSendInFlight(), true, 'any send');
        assert.equal(isAnthropicSendInFlight('chat'), true);
        assert.equal(isAnthropicSendInFlight('work@r2'), false);
        endAnthropicSend('chat');
        assert.equal(isAnthropicSendInFlight(), false);
        endAnthropicSend('chat');
        endAnthropicSend('never');
        assert.equal(tryBeginAnthropicSend('chat'), true, 'free again');
    });

    test('SS-2: two sessions at once, the same session refused', () => {
        assert.equal(tryBeginAnthropicSend('chat'), true);
        assert.equal(tryBeginAnthropicSend('work@r2'), true, 'another session runs beside it');
        assert.equal(tryBeginAnthropicSend('chat'), false, 'two prompts never share a conversation');
        assert.equal(tryBeginAnthropicSend('work@r2'), false);
        assert.deepEqual(anthropicSendSessions(), ['chat', 'work@r2']);
        endAnthropicSend('chat');
        assert.equal(isAnthropicSendInFlight('work@r2'), true, 'the other one runs on');
        assert.deepEqual(anthropicSendSessions(), ['work@r2']);
    });

    test('SS-3: cancel one session, or all', () => {
        assert.deepEqual(cancelAnthropicSend(), [], 'nothing in flight');
        const cancelled: string[] = [];
        tryBeginAnthropicSend('chat', () => cancelled.push('chat'));
        tryBeginAnthropicSend('work@r2', () => cancelled.push('work@r2'));
        tryBeginAnthropicSend('nohook');
        assert.deepEqual(cancelAnthropicSend('work@r2'), ['work@r2']);
        assert.deepEqual(cancelled, ['work@r2'], 'only its hook');
        assert.deepEqual(cancelAnthropicSend('nohook'), [], 'no hook: nothing cancelled');
        assert.deepEqual(cancelAnthropicSend('absent'), []);
        cancelled.length = 0;
        assert.deepEqual(cancelAnthropicSend(), ['chat', 'work@r2'], 'every running send with a hook');
        assert.deepEqual(cancelled, ['chat', 'work@r2']);
        tryBeginAnthropicSend('boom', () => { throw new Error('boom'); });
        assert.deepEqual(cancelAnthropicSend('boom'), ['boom'], 'a throwing hook still counts');
    });

    test('SS-4: a hook registered after the claim', () => {
        let cancelled = 0;
        assert.equal(tryBeginAnthropicSend('chat'), true);
        setAnthropicSendCancel('chat', () => { cancelled++; });
        assert.deepEqual(cancelAnthropicSend('chat'), ['chat']);
        assert.equal(cancelled, 1);
        setAnthropicSendCancel('other', () => { cancelled++; });
        assert.deepEqual(cancelAnthropicSend('other'), [], 'not held: ignored');
        endAnthropicSend('chat');
        assert.deepEqual(cancelAnthropicSend(), [], 'a released slot\'s hook never fires');
        assert.equal(cancelled, 1);
    });

    test('SS-5: cancel by chat item', () => {
        const cancelled: string[] = [];
        tryBeginAnthropicSend('chat', () => cancelled.push('chat'));
        tryBeginAnthropicSend('assist-1', () => cancelled.push('assist-1'));
        setAnthropicSendChatItem('assist-1', 'item-7');
        setAnthropicSendChatItem('absent', 'item-8');
        assert.equal(cancelAnthropicSendOfChatItem('item-8'), undefined);
        assert.equal(cancelAnthropicSendOfChatItem('item-7'), 'assist-1');
        assert.deepEqual(cancelled, ['assist-1']);
    });

    test('SS-6: the free sessions', () => {
        tryBeginAnthropicSend('chat');
        const queueBusy = (s: string): boolean => s === 'default';
        assert.deepEqual(freeChatSessions(['chat', 'default', 'work', 'work@r2', 'work'], queueBusy), ['work', 'work@r2']);
        assert.deepEqual(freeChatSessions(['chat', 'default']), ['default'], 'without a queue check: the chat sends only');
        endAnthropicSend('chat');
        assert.deepEqual(freeChatSessions(['chat', 'default'], queueBusy), ['chat']);
    });

    test('SS-7: the busy warning names the session', () => {
        assert.match(busySessionWarning('work@r2'), /^Session work@r2 is busy/);
        assert.doesNotMatch(busySessionWarning('work@r2'), /Anthropic chat/);
    });
});
