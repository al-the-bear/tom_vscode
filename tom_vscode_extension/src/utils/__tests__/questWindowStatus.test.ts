/**
 * tomAi_getQuestWindowStatus (src/utils/questWindowStatus.ts, src/tools/quest-window-status-tools.ts).
 *
 *   QS-1 windows: this host's files only (by `host`, else by the machine half of the window id); alive by the
 *        heartbeat, with its age; a stale window left out unless includeGone; this window marked
 *   QS-2 what a window writes about itself is read: role, process position, the panel's profile and session, the
 *        queue summary with its default profile and the item being sent with its profile
 *   QS-3 profiles are {id, name, model, transport}; an id the config no longer holds is unknownProfile
 *   QS-4 a quest's sessions: the implicit default and chat, the files with base, lifetime, profile and model,
 *        a temporary one flagged, the profile an item would run with (session, else the queue default)
 *   QS-5 the profiles list: the default marked, noApiKey; a quest asked for with no window still gets its sessions
 *   (the tool itself, QS-6: src/tools/__tests__/quest-window-status-tools.test.ts)
 */

import test, { describe } from 'node:test';
import assert from 'node:assert/strict';

import { buildQuestWindowStatus, resolveProfile, type ProfileConfig, type QuestWindowStatusInput, type WindowStateInput } from '../questWindowStatus.js';
import type { SessionRecord } from '../agentSdkSessions.js';

const NOW = Date.parse('2026-10-27T12:00:00.000Z');
const ago = (s: number): string => new Date(NOW - s * 1000).toISOString();

const CONFIG: ProfileConfig = {
    profiles: [
        { id: 'opus-direct', name: 'Opus 5.5 direct', configurationId: 'c-opus-direct' },
        { id: 'opus-sdk', name: 'Opus 5.5 Agent SDK', configurationId: 'c-opus-sdk', isDefault: true },
        { id: 'haiku-direct', name: 'Haiku direct', configurationId: 'c-haiku' },
    ],
    configurations: [
        { id: 'c-opus-direct', model: 'claude-opus-5-5', transport: 'direct' },
        { id: 'c-opus-sdk', model: 'claude-opus-5-5', transport: 'agentSdk' },
        { id: 'c-haiku', model: 'claude-haiku-5-5', transport: 'direct' },
    ],
};

const STATES: WindowStateInput[] = [
    {
        windowId: 'aaaa1111_mach0001', workspace: 'vscode_extension', activeQuest: 'vscode_extension', host: 'mbp',
        heartbeat: ago(10), pid: 101, cliServer: { running: true, port: 19901 }, mcpServer: { running: false },
        status: [{ subsystem: 'queue', status: 'prompt-sent' }, { subsystem: 'copilot', status: 'answer-received' }],
        role: 'software_engineer',
        process: { process: 'tom_specs', phase: 'p2', phaseIteration: 1, step: 's3', stepIteration: 2 },
        panel: { profileId: 'opus-direct', session: 'chat' },
        queue: {
            autoSend: true, paused: false, counts: { pending: 2, sending: 1, sent: 7 },
            defaultTransport: 'anthropic', defaultProfileId: 'opus-sdk', defaultSession: 'default',
            sending: { id: 'it-1', preview: 'Do X', stage: 'main', transport: 'anthropic', profileId: 'gone-profile', session: 'walk', since: ago(30) },
        },
    },
    // This window: a heartbeat, no host field (machine half of the id).
    { windowId: 'bbbb2222_mach0001', workspace: 'tom_uam', activeQuest: 'tom_uam', heartbeat: ago(5), aiConversationActive: true },
    // Stale.
    { windowId: 'cccc3333_mach0001', workspace: 'd4rt', activeQuest: 'd4rt', host: 'mbp', heartbeat: ago(600) },
    // Another host's file (by host, and by machine id).
    { windowId: 'dddd4444_mach0001', workspace: 'webwork', activeQuest: 'webwork', host: 'bomber', heartbeat: ago(1) },
    { windowId: 'eeee5555_otherhst', workspace: 'webwork', activeQuest: 'webwork', heartbeat: ago(1) },
];

const SESSIONS: Record<string, SessionRecord[]> = {
    vscode_extension: [
        { name: 'prep', mode: 'continue', profileId: 'haiku-direct', model: 'claude-haiku-5-5', sessionId: 'S1', createdAt: ago(900), updatedAt: ago(60) },
        { name: 'walk', mode: 'per-prompt', basedOn: 'prep' },
        { name: 'tmp-261027-120000-ab12', mode: 'continue', basedOn: 'prep', profileId: 'renamed-away' },
        { name: 'default', mode: 'continue', sessionId: 'S0' },
    ],
};

function input(extra: Partial<QuestWindowStatusInput> = {}): QuestWindowStatusInput {
    return {
        states: STATES,
        sessionsOf: (q) => SESSIONS[q] ?? [],
        config: CONFIG,
        noApiKey: new Set(['haiku-direct']),
        thisHost: 'mbp',
        thisMachine: 'mach0001',
        thisWindowId: 'bbbb2222_mach0001',
        nowMs: NOW,
        ...extra,
    };
}

describe('quest window status', () => {
    test('QS-1: windows of this host', () => {
        const s = buildQuestWindowStatus(input());
        assert.deepEqual(s.windows.map((w) => [w.windowId, w.alive, w.isThisWindow]), [
            ['aaaa1111_mach0001', true, false],
            ['bbbb2222_mach0001', true, true],
        ], 'the stale window and the other hosts are left out');
        assert.equal(s.windows[0].heartbeatAgeSeconds, 10);
        const gone = buildQuestWindowStatus(input({ includeGone: true })).windows.find((w) => w.windowId === 'cccc3333_mach0001');
        assert.deepEqual([gone?.alive, gone?.heartbeatAgeSeconds], [false, 600]);
        assert.equal(buildQuestWindowStatus(input({ includeGone: true })).windows.some((w) => w.quest === 'webwork'), false);
    });

    test('QS-2: what a window says about itself', () => {
        const w = buildQuestWindowStatus(input()).windows[0];
        assert.deepEqual(w.activeSubsystems, ['queue']);
        assert.deepEqual([w.pid, w.cliServer, w.mcpServer], [101, { running: true, port: 19901 }, { running: false }]);
        assert.equal(w.role, 'software_engineer');
        assert.deepEqual(w.process, { process: 'tom_specs', phase: 'p2', phaseIteration: 1, step: 's3', stepIteration: 2 });
        assert.deepEqual(w.panel, {
            profile: { id: 'opus-direct', name: 'Opus 5.5 direct', model: 'claude-opus-5-5', transport: 'direct' },
            session: 'chat',
        });
        assert.deepEqual(w.queue, {
            autoSend: true, paused: false, counts: { pending: 2, sending: 1, sent: 7 },
            defaultTransport: 'anthropic',
            defaultProfile: { id: 'opus-sdk', name: 'Opus 5.5 Agent SDK', model: 'claude-opus-5-5', transport: 'agentSdk' },
            defaultSession: 'default',
            sending: {
                id: 'it-1', preview: 'Do X', stage: 'main', transport: 'anthropic', session: 'walk', since: ago(30),
                profile: { id: 'gone-profile', unknownProfile: true },
            },
        });
        const me = buildQuestWindowStatus(input()).windows[1];
        assert.deepEqual([me.aiConversationActive, me.role, me.panel, me.queue], [true, undefined, undefined, undefined], 'an older build writes none of it');
    });

    test('QS-3: profiles', () => {
        assert.deepEqual(resolveProfile(CONFIG, 'haiku-direct'), { id: 'haiku-direct', name: 'Haiku direct', model: 'claude-haiku-5-5', transport: 'direct' });
        assert.deepEqual(resolveProfile(CONFIG, 'nope'), { id: 'nope', unknownProfile: true });
        assert.equal(resolveProfile(CONFIG, undefined), undefined);
        assert.deepEqual(resolveProfile({ profiles: [{ id: 'x' }] }, 'x'), { id: 'x', name: 'x', transport: 'direct' }, 'no configuration: the direct default');
    });

    test('QS-4: a quest\'s sessions', () => {
        const q = buildQuestWindowStatus(input()).quests.find((x) => x.quest === 'vscode_extension')!;
        assert.deepEqual(q.windows, ['aaaa1111_mach0001']);
        assert.equal(q.queueDefaultSession, 'default');
        const by = Object.fromEntries(q.sessions.map((s) => [s.name, s]));
        assert.deepEqual(q.sessions.map((s) => s.name), ['default', 'chat', 'prep', 'walk', 'tmp-261027-120000-ab12'], 'implicit first, temporary last, as the SESSIONS view');
        assert.deepEqual([by.default.implicit, by.default.usedBy, by.default.hasConversation], [true, 'the prompt queue', true]);
        assert.deepEqual([by.chat.implicit, by.chat.hasConversation], [true, false], 'chat without a file');
        assert.deepEqual(by.prep, {
            name: 'prep', lifetime: 'continue',
            profile: { id: 'haiku-direct', name: 'Haiku direct', model: 'claude-haiku-5-5', transport: 'direct' },
            model: 'claude-haiku-5-5', hasConversation: true, createdAt: ago(900), updatedAt: ago(60),
            effectiveProfile: { id: 'haiku-direct', name: 'Haiku direct', model: 'claude-haiku-5-5', transport: 'direct' },
        });
        assert.deepEqual([by.walk.basedOn, by.walk.lifetime, by.walk.effectiveProfile?.id], ['prep', 'per-prompt', 'opus-sdk'],
            'no profile of its own: the queue default');
        const tmp = by['tmp-261027-120000-ab12'];
        assert.deepEqual([tmp.temporary, tmp.profile], [true, { id: 'renamed-away', unknownProfile: true }]);
    });

    test('QS-5: profiles list, and a quest without a window', () => {
        const s = buildQuestWindowStatus(input({ quest: 'cli_tools' }));
        assert.deepEqual(s.profiles.map((p) => [p.id, p.isDefault, p.noApiKey]), [
            ['opus-direct', false, false], ['opus-sdk', true, false], ['haiku-direct', false, true],
        ]);
        assert.deepEqual(s.windows, [], 'no window of cli_tools');
        assert.deepEqual(s.quests.map((q) => [q.quest, q.windows, q.sessions.map((x) => x.name)]), [['cli_tools', [], ['default', 'chat']]]);
        assert.equal(s.quests[0].sessions[0].effectiveProfile?.id, 'opus-sdk', 'without a live queue: the configured default profile');
    });
});
