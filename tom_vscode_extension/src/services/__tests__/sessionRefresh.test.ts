/**
 * Live trails per session: the events name their session, and a quest refresh reads and trims every
 * session's trail.
 *
 * Decision (vsc7, a): the refresh — and a new session start — reads the live trails of every session
 * written since the last refresh, newest first. Every Anthropic session keeps its own trail
 * (`history/sessions/<session>/live-trail.md`), so "the live trail" no longer names one file.
 *
 *   SR-1 a writer for a session stamps it on every event; a writer without one (the Local LLM) stamps none
 *   SR-2 sessionLiveTrailsSince: the trails written after `since`, newest first; every trail without `since`;
 *        a session folder without a trail is not listed
 *   SR-3 the list in the prompt: in place of `${refreshSessions}`, else appended; an empty list says so
 *   SR-4 a refresh of the Anthropic panel dispatches the list, trims every session's trail to base,
 *        records when it ran; the next refresh lists only the sessions written since
 *   SR-5 on the other panels the placeholder is removed, nothing listed
 */

import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import { installVscodeStub } from '../../tools/__tests__/_vscode-stub.js';

const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'session-refresh-'));
installVscodeStub({ workspaceFolders: [tmpRoot] });

import { LiveTrailWriter, type LiveTrailEvent } from '../live-trail.js';
import { sessionLiveTrailsSince } from '../sessionStorage.js';
import { QuestRefreshService } from '../quest-refresh-service.js';
import { QuestRefreshStore } from '../../managers/questRefreshStore.js';
import { TwoTierMemoryService } from '../memory-service.js';
import {
    applyRefreshSessionTrails,
    formatRefreshSessionTrails,
} from '../../utils/refreshSessionTrails.js';
import type { SendToChatConfig } from '../../utils/sendToChatConfig.js';

const newQuest = (): string => `q_${Math.random().toString(36).slice(2)}`;

function prompts(w: LiveTrailWriter, n: number): void {
    for (let i = 0; i < n; i++) {
        w.beginPrompt({ transport: 'anthropic', config: 'c', userText: `prompt ${i}` });
        w.appendAssistantText(`answer ${i}`);
        w.endPrompt({ rounds: 1, toolCalls: 0 });
    }
}

const blocks = (file: string): number => (fs.readFileSync(file, 'utf-8').match(/^## 🚀 PROMPT /gm) ?? []).length;

function setMtime(file: string, at: Date): void {
    fs.utimesSync(file, at, at);
}

describe('session live trails', () => {
    test('SR-1: events carry the session', () => {
        const events: LiveTrailEvent[] = [];
        const sub = LiveTrailWriter.addObserver((e) => events.push(e));
        try {
            const quest = newQuest();
            prompts(new LiveTrailWriter(quest, undefined, 'review'), 1);
            prompts(new LiveTrailWriter(quest, 'live-trail-localLLM.md'), 1);
        } finally { sub.dispose(); }
        const kinds = new Set(events.map((e) => e.kind));
        assert.deepEqual([...kinds].sort(), ['assistant', 'done', 'prompt']);
        const half = events.length / 2;
        assert.ok(events.slice(0, half).every((e) => e.session === 'review'), 'every event of the session writer');
        assert.ok(events.slice(half).every((e) => e.session === undefined), 'none for the Local LLM writer');
    });

    test('SR-2: the trails written since, newest first', () => {
        const quest = newQuest();
        for (const s of ['alpha', 'beta', 'gamma']) { prompts(new LiveTrailWriter(quest, undefined, s), 1); }
        const history = TwoTierMemoryService.instance.historyFolder(quest);
        fs.mkdirSync(path.join(history, 'sessions', 'empty'), { recursive: true });
        const file = (s: string): string => path.join(history, 'sessions', s, 'live-trail.md');
        setMtime(file('alpha'), new Date('2026-10-01T10:00:00Z'));
        setMtime(file('beta'), new Date('2026-10-03T10:00:00Z'));
        setMtime(file('gamma'), new Date('2026-10-02T10:00:00Z'));

        assert.deepEqual(sessionLiveTrailsSince(history).map((t) => t.session), ['beta', 'gamma', 'alpha']);
        assert.deepEqual(sessionLiveTrailsSince(history, new Date('2026-10-01T12:00:00Z')).map((t) => t.session), ['beta', 'gamma']);
        assert.deepEqual(sessionLiveTrailsSince(history, new Date('2026-10-03T10:00:00Z')), [], 'written at `since` is not after it');
    });

    test('SR-3: the list in the prompt', () => {
        const since = new Date('2026-10-27T08:00:00Z');
        const list = formatRefreshSessionTrails([
            { session: 'default', file: '_ai/quests/q/history/sessions/default/live-trail.md', modified: new Date('2026-10-27T09:30:00Z') },
            { session: 'chat', file: '_ai/quests/q/history/sessions/chat/live-trail.md', modified: new Date('2026-10-27T09:00:00Z') },
        ], since);
        assert.match(list, /since the last refresh \(2026-10-27T08:00:00\.000Z\), newest first/);
        assert.ok(list.indexOf('`default`') < list.indexOf('`chat`'));
        assert.match(list, /`_ai\/quests\/q\/history\/sessions\/default\/live-trail\.md` \(last written 2026-10-27T09:30:00\.000Z\)/);
        assert.equal(applyRefreshSessionTrails('Read:\n${refreshSessions}\nThen act.', 'LIST'), 'Read:\nLIST\nThen act.');
        assert.equal(applyRefreshSessionTrails('Refresh the quest.', 'LIST'), 'Refresh the quest.\n\nLIST');
        assert.match(formatRefreshSessionTrails([], undefined), /no earlier refresh recorded.*\n\n- none/s);
    });

    test('SR-4: a refresh reads and trims every session', async () => {
        const quest = newQuest();
        const config = {
            questRefresh: { anthropic: { promptInterval: 3, refreshPrompt: 'Refresh.\n\n${refreshSessions}' } },
        } as unknown as SendToChatConfig;
        QuestRefreshStore.setInstanceForTest(new QuestRefreshStore(() => config));
        try {
            const history = TwoTierMemoryService.instance.historyFolder(quest);
            const file = (s: string): string => path.join(history, 'sessions', s, 'live-trail.md');
            for (const s of ['default', 'chat', 'review']) {
                const w = new LiveTrailWriter(quest, undefined, s);
                w.setExtraBlockAllowance(10);
                prompts(w, 9);
                assert.equal(blocks(file(s)), 9);
            }
            const old = Date.now() - 60_000;
            setMtime(file('chat'), new Date(old));
            setMtime(file('review'), new Date(old + 1000));

            const sent: string[] = [];
            await QuestRefreshService.instance.runRefresh('anthropic', async (t) => { sent.push(t); }, quest);
            assert.equal(sent.length, 1);
            const order = ['default', 'review', 'chat'].map((s) => sent[0].indexOf(`\`${s}\``));
            assert.ok(order.every((i) => i > 0) && order[0] < order[1] && order[1] < order[2], sent[0]);
            assert.doesNotMatch(sent[0], /\$\{refreshSessions\}/);
            for (const s of ['default', 'chat', 'review']) { assert.ok(blocks(file(s)) <= 5, `${s} trimmed to base`); }
            const last = QuestRefreshStore.instance.lastRefreshAt('anthropic', quest);
            assert.ok(last && Date.now() - last.getTime() < 10_000, 'the refresh time is recorded');
            assert.equal(QuestRefreshStore.instance.getPanelState('anthropic', quest).count, 0);

            // Only `chat` is written after that refresh.
            await new Promise((r) => setTimeout(r, 20));
            prompts(new LiveTrailWriter(quest, undefined, 'chat'), 1);
            sent.length = 0;
            await QuestRefreshService.instance.runRefresh('anthropic', async (t) => { sent.push(t); }, quest);
            assert.match(sent[0], /`chat`/);
            assert.doesNotMatch(sent[0], /`default`|`review`/);
        } finally {
            QuestRefreshStore.setInstanceForTest(undefined);
        }
    });

    test('SR-5: other panels get no list', async () => {
        const quest = newQuest();
        const config = {
            questRefresh: { localLlm: { promptInterval: 3, refreshPrompt: 'Refresh.\n\n${refreshSessions}' } },
        } as unknown as SendToChatConfig;
        QuestRefreshStore.setInstanceForTest(new QuestRefreshStore(() => config));
        try {
            const sent: string[] = [];
            await QuestRefreshService.instance.runRefresh('localLlm', async (t) => { sent.push(t); }, quest);
            assert.deepEqual(sent, ['Refresh.']);
        } finally {
            QuestRefreshStore.setInstanceForTest(undefined);
        }
    });
});
