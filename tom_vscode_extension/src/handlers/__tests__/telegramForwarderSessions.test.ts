/**
 * The Telegram forwarder follows every session of the quest (decision vsc7, a).
 *
 *   TF-1 the filter: events of this quest are forwarded, from any session; another quest's are not
 *   TF-2 the prefix: while one session is forwarded its messages carry none; from the second session on,
 *        every message names its session (`[chat] …`, `[default] …`, `[Local LLM] …` for a sessionless writer)
 *   TF-3 two sessions at once keep their own final answer: in silent mode each gets exactly its own text
 *   TF-4 /chat_status names each running prompt's session
 */

import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import { installVscodeStub } from '../../tools/__tests__/_vscode-stub.js';

const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'tg-forwarder-'));
installVscodeStub({ workspaceFolders: [tmpRoot] });

import { LiveTrailWriter } from '../../services/live-trail.js';
import { TelegramLiveConversationForwarder } from '../telegramTrailForwarder.js';

const newQuest = (): string => `q_${Math.random().toString(36).slice(2)}`;

function setup(quest: string): { sent: string[]; forwarder: TelegramLiveConversationForwarder } {
    const sent: string[] = [];
    const channel = { sendMessage: async (text: string) => { sent.push(text); } };
    const forwarder = new TelegramLiveConversationForwarder(channel, 1, quest);
    forwarder.start();
    return { sent, forwarder };
}

function turn(w: LiveTrailWriter, prompt: string, answer: string): void {
    w.beginPrompt({ transport: 'anthropic', config: 'c', userText: prompt });
    w.appendAssistantText(answer);
    w.endPrompt({ rounds: 1, toolCalls: 0 });
}

describe('Telegram forwarder: every session', () => {
    test('TF-1: this quest, any session', async () => {
        const quest = newQuest();
        const { sent, forwarder } = setup(quest);
        try {
            turn(new LiveTrailWriter(quest, undefined, 'review'), 'from review', 'ok');
            turn(new LiveTrailWriter(newQuest(), undefined, 'review'), 'other quest', 'no');
            await forwarder.drain();
            assert.ok(sent.some((m) => m.includes('from review')));
            assert.ok(!sent.some((m) => m.includes('other quest')));
        } finally { forwarder.stop(); }
    });

    test('TF-2: the prefix from the second session on', async () => {
        const quest = newQuest();
        const { sent, forwarder } = setup(quest);
        try {
            turn(new LiveTrailWriter(quest, undefined, 'default'), 'first', 'a1');
            await forwarder.drain();
            const single = sent.length;
            assert.ok(single > 0 && sent.every((m) => !m.startsWith('[')), 'one session: no prefix');
            turn(new LiveTrailWriter(quest, undefined, 'chat'), 'second', 'a2');
            turn(new LiveTrailWriter(quest, undefined, 'default'), 'third', 'a3');
            turn(new LiveTrailWriter(quest, 'live-trail-localLLM.md'), 'fourth', 'a4');
            await forwarder.drain();
            const later = sent.slice(single);
            assert.ok(later.filter((m) => m.includes('second')).every((m) => m.startsWith('[chat] ')), later.join('\n'));
            assert.ok(later.filter((m) => m.includes('third')).every((m) => m.startsWith('[default] ')));
            assert.ok(later.filter((m) => m.includes('fourth')).every((m) => m.startsWith('[Local LLM] ')));
            assert.ok(later.every((m) => /^\[(chat|default|Local LLM)\] /.test(m)), 'every later message is prefixed');
        } finally { forwarder.stop(); }
    });

    test('TF-3: interleaved sessions keep their own final answer', async () => {
        const quest = newQuest();
        const { sent, forwarder } = setup(quest);
        forwarder.setListening(false);
        try {
            const a = new LiveTrailWriter(quest, undefined, 'default');
            const b = new LiveTrailWriter(quest, undefined, 'chat');
            a.beginPrompt({ transport: 'anthropic', config: 'c', userText: 'pa' });
            b.beginPrompt({ transport: 'anthropic', config: 'c', userText: 'pb' });
            a.appendAssistantText('ANSWER-A');
            b.appendAssistantText('ANSWER-B');
            a.endPrompt({ rounds: 1, toolCalls: 0 });
            b.endPrompt({ rounds: 1, toolCalls: 0 });
            await forwarder.drain();
            const answers = sent.filter((m) => m.includes('ANSWER-'));
            assert.deepEqual(answers, ['[default] ANSWER-A', '[chat] ANSWER-B']);
        } finally { forwarder.stop(); }
    });

    test('TF-4: the status names the session', () => {
        const quest = newQuest();
        const { forwarder } = setup(quest);
        try {
            new LiveTrailWriter(quest, undefined, 'review').beginPrompt({ transport: 'anthropic', config: 'c', userText: 'x' });
            const running = forwarder.getStatus().running;
            assert.equal(running.length, 1);
            assert.equal(running[0].session, 'review');
        } finally { forwarder.stop(); }
    });
});
