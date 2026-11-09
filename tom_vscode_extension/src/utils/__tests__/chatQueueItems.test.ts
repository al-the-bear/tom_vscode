/**
 * Chat sends in the prompt queue (src/utils/chatQueueItems.ts and its wiring).
 *
 *   CQ-1 a chat send becomes a `chat` item (anthropic, the profile and session it ran with, its source);
 *        finishing it makes it `chat-sent` with the answer, or with the error
 *   CQ-2 a `chat` item that can no longer report back is settled as `chat-sent` with a note: an older one
 *        of this window, one of a window that is gone, one of no window; a send still running in another
 *        live window, and `chat-sent` items, are left alone
 *   CQ-3 the queue ignores chat items: no path that picks, sends, retries or counts pending items
 *        names the chat statuses, and the queue's storage, crash recovery, Clear sent, trimming and
 *        listQueue's "without sent" treat `chat-sent` like `sent`
 *   CQ-4 both chat send paths (the panel's Send and runAnthropicSend) record the item around the send
 *   CQ-5 runAnthropicSend (no session picker: editor, todo panel, Telegram) uses `chat` unless the caller names
 *        a session — only the assist runs do (Grill me / Explain on questions and decisions, their temporary
 *        session, through services/assistLiveDeps.ts); the panel's Send uses the
 *        session picked in the panel
 */

import test, { describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import {
    CHAT_NOT_FINISHED_ERROR, CHAT_SENT_STATUS, CHAT_STATUS, finishChatItem, isChatStatus, newChatItem, settleRunningChatItems,
} from '../chatQueueItems.js';

const ROOT = join(__dirname, '..', '..', '..');
const src = (...p: string[]): string => readFileSync(join(ROOT, 'src', ...p), 'utf-8');
const NOW = new Date('2026-11-07T12:00:00Z');

describe('chat sends in the prompt queue', () => {
    test('CQ-1: new and finished', () => {
        const item = newChatItem({ id: 'c1', text: 'Hello', profileId: 'opus', session: 'chat', source: 'panel', windowId: 'w1', now: NOW });
        assert.equal(item.status, CHAT_STATUS);
        assert.equal(item.transport, 'anthropic');
        assert.equal(item.anthropicProfileId, 'opus');
        assert.equal(item.session, 'chat');
        assert.equal(item.chatSource, 'panel');
        assert.equal(item.chatWindowId, 'w1');
        assert.equal(item.originalText, 'Hello');
        assert.equal(item.createdAt, NOW.toISOString());
        finishChatItem(item, { answerText: 'Hi there' });
        assert.equal(item.status, CHAT_SENT_STATUS);
        assert.equal(item.answerText, 'Hi there');
        assert.equal(item.error, undefined);
        const failed = newChatItem({ id: 'c2', text: 'x', session: 'chat', source: 'editor', windowId: 'w1', now: NOW });
        finishChatItem(failed, { error: 'overloaded' });
        assert.equal(failed.status, CHAT_SENT_STATUS);
        assert.equal(failed.error, 'overloaded');
        assert.ok(isChatStatus('chat') && isChatStatus('chat-sent') && !isChatStatus('sent') && !isChatStatus(undefined));
    });

    test('CQ-2: running items left over are settled', () => {
        const items = [
            { id: 'own-old', status: 'chat', chatWindowId: 'me' },
            { id: 'sent', status: 'chat-sent', chatWindowId: 'gone', answerText: 'kept' },
            { id: 'queued', status: 'pending' },
            { id: 'own-new', status: 'chat', chatWindowId: 'me' },
            { id: 'other-live', status: 'chat', chatWindowId: 'other' },
            { id: 'other-gone', status: 'chat', chatWindowId: 'gone' },
            { id: 'no-window', status: 'chat' },
        ] as Array<{ id: string; status: string; error?: string; chatWindowId?: string }>;
        const live = new Set(['me', 'other']);
        assert.equal(settleRunningChatItems(items, { ownWindowId: 'me', liveWindowIds: live, keepId: 'own-new' }), 3);
        assert.deepEqual(items.map((i) => i.status), ['chat-sent', 'chat-sent', 'pending', 'chat', 'chat', 'chat-sent', 'chat-sent']);
        assert.equal(items[0].error, CHAT_NOT_FINISHED_ERROR);
        assert.equal(items[1].error, undefined, 'a finished item is left alone');
        assert.equal(settleRunningChatItems(items, { ownWindowId: 'me', liveWindowIds: live }), 1, 'without keepId this window\'s own goes too');
        assert.equal(items[4].status, 'chat', 'another live window\'s send is never touched');
    });

    test('CQ-3: the queue ignores them', () => {
        const qm = src('managers', 'promptQueueManager.ts');
        assert.match(qm, /export type QueuedPromptStatus = [^;]*'chat' \| 'chat-sent'/);
        // The paths that pick work select their own statuses; none of them may name a chat status.
        for (const m of qm.matchAll(/status === '(chat|chat-sent)'/g)) {
            const at = qm.lastIndexOf('\n    ', m.index ?? 0);
            assert.fail(`a queue path names ${m[1]} near: ${qm.slice(at, (m.index ?? 0) + 40)}`);
        }
        assert.match(qm, /addChatItem\(/);
        assert.match(qm, /completeChatItem\(/);
        assert.match(qm, /settleRunningChatItems\(this\._items, \{ ownWindowId/, 'startup and a new chat send settle stale chat items');
        assert.match(qm, /clearByStatus\(status: QueuedPromptStatus\)[\s\S]{0,400}CHAT_SENT_STATUS/, 'Clear sent also clears chat-sent');
        assert.match(src('storage', 'queueFileStorage.ts'), /'chat' \| 'chat-sent'/);
        assert.match(src('storage', 'queueFileStorage.ts'), /status === 'sent' \|\| e\.doc\.meta\.status === 'chat-sent'/);
        assert.match(src('tools', 'prompt-queue-tools.ts'), /includeSent \|\| \(i\.status !== 'sent' && i\.status !== 'chat-sent'\)/);
    });

    test('CQ-4: both send paths record the item', () => {
        assert.match(src('handlers', 'sendToChatRouter.ts'), /trackChatSend\(/);
        assert.match(src('handlers', 'chatPanel-handler.ts'), /trackChatSend\(/);
    });

    test('CQ-5: the session of a send', () => {
        const router = src('handlers', 'sendToChatRouter.ts');
        const send = router.slice(router.indexOf('export async function runAnthropicSend'));
        assert.doesNotMatch(send.slice(0, 4000), /chatSessionFor\(/, 'no session picker: always chat');
        assert.match(send.slice(0, 4000), /let targetSession = opts\?\.session \|\| ANTHROPIC_CHAT_SESSION_KEY;/, 'chat unless the caller names a session');
        assert.match(send, /const sessionKey = targetSession;/, '(or a free session chosen when it was busy)');
        // The one caller that names one: the assist run's temporary session.
        const callers = ['services/assistLiveDeps.ts', 'handlers/markdownBrowser-handler.ts', 'handlers/questTodoPanel-handler.ts', 'handlers/telegram-cmd-handlers.ts', 'handlers/sendToChatRouter.ts']
            .filter((f) => /runAnthropicSend\(\w+, [^)]*\{[^}]*\bsession\b/.test(src(...f.split('/'))));
        assert.deepEqual(callers, ['services/assistLiveDeps.ts'], 'the assist runs (questions, decisions) share the one send');
    });
});
