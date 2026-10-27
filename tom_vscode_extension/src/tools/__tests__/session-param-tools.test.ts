/**
 * The `sessions` parameter of the tools that read or write a quest's per-session storage
 * (src/tools/session-param.ts, src/utils/sessionSelection.ts).
 *
 *   SP-1 prompt history: without `sessions` the session the call runs in (every session when it runs in none);
 *        one session, several, "all"; other subsystems always kept; an unknown session refused
 *   SP-2 past tool calls: without `sessions` the caller's ring buffer; with them every stored result of each chosen
 *        session, tagged with its session; read by key in another session; an unknown session refused
 *   SP-3 quest memory: writes go to each chosen session; reads and lists show each under its own heading; without
 *        `sessions` the call runs once as before; the shared scope ignores `sessions`; an unknown session refused
 */

import test, { after, before, describe } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import { installVscodeStub } from './_vscode-stub.js';
import { withTiming } from './_timing.js';

installVscodeStub({
    moduleOverrides: {
        '../managers/chatVariablesStore': { ChatVariablesStore: { instance: { quest: 'demo_quest' } } },
    },
});

import { getPromptPairImpl, listPromptPairsImpl } from '../prompt-history-tools.js';
import { listPastToolCallsImpl, readPastToolResultImpl, searchPastToolResultsImpl, type PastToolEntry, type ToolHistoryAccess } from '../past-tool-access-tools.js';
import { listMemoryImpl, readMemoryImpl, saveMemoryImpl, type MemoryScope, type MemoryStore } from '../memory-tools.js';
import { ToolTrail, setActiveToolTrail } from '../../services/tool-trail.js';

const QUEST = 'demo_quest';
let tmp: string;

function summary(file: string, kind: 'PROMPT' | 'ANSWER', id: string, ts: string, body: string): void {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, `=== ${kind} ${id} ${ts} 1 ===\n\n${body}\n\n`, 'utf-8');
}

before(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'session-param-tools-'));
    const history = path.join(tmp, '_ai', 'quests', QUEST, 'history');
    for (const [session, id, ts] of [['chat', 'req-C', '2026-10-27T10:00:00.000Z'], ['walk', 'req-W', '2026-10-27T11:00:00.000Z']]) {
        const root = path.join(history, 'sessions', session);
        summary(path.join(root, `${QUEST}.anthropic.prompts.md`), 'PROMPT', id, ts, `prompt of ${session}`);
        summary(path.join(root, `${QUEST}.anthropic.answers.md`), 'ANSWER', id, ts, `answer of ${session}`);
    }
    fs.writeFileSync(path.join(history, 'walk.session.json'), JSON.stringify({ mode: 'per-prompt' }));
    summary(path.join(history, `${QUEST}.copilot.prompts.md`), 'PROMPT', 'req-K', '2026-10-27T09:00:00.000Z', 'copilot prompt');
    summary(path.join(history, `${QUEST}.copilot.answers.md`), 'ANSWER', 'req-K', '2026-10-27T09:00:00.000Z', 'copilot answer');
});

after(() => {
    try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* best-effort */ }
    setActiveToolTrail(new ToolTrail());
});

const ids = (r: { pairs: Array<{ requestId: string }> }): string[] => r.pairs.map((p) => p.requestId).sort();

describe('sessions — prompt history', () => {
    test('SP-1: one, several, all, the caller, unknown', async () => {
        setActiveToolTrail(new ToolTrail());
        const none = JSON.parse(await listPromptPairsImpl(tmp, { questId: QUEST }));
        assert.deepEqual(ids(none), ['req-C', 'req-K', 'req-W'], 'a call in no session: every session');
        assert.deepEqual(none.sessions, ['default', 'chat', 'walk']);
        const walk = JSON.parse(await withTiming('tomAi_listPromptPairs:sessions', () => listPromptPairsImpl(tmp, { questId: QUEST, sessions: 'walk' })));
        assert.deepEqual(ids(walk), ['req-K', 'req-W'], 'walk, and the copilot pair (no sessions there)');
        assert.deepEqual(ids(JSON.parse(await listPromptPairsImpl(tmp, { questId: QUEST, sessions: ['walk', 'chat'] }))), ['req-C', 'req-K', 'req-W']);
        assert.deepEqual(ids(JSON.parse(await listPromptPairsImpl(tmp, { questId: QUEST, sessions: 'all' }))), ['req-C', 'req-K', 'req-W']);
        setActiveToolTrail(new ToolTrail({ session: 'chat' }));
        assert.deepEqual(ids(JSON.parse(await listPromptPairsImpl(tmp, { questId: QUEST }))), ['req-C', 'req-K'], "the caller's own session");
        const unknown = JSON.parse(await listPromptPairsImpl(tmp, { questId: QUEST, sessions: ['walk', 'nope'] }));
        assert.deepEqual([unknown.ok, unknown.code, unknown.sessions], [false, 'unknownSession', ['default', 'chat', 'walk']]);
        const got = JSON.parse(await getPromptPairImpl(tmp, { questId: QUEST, sessions: 'walk', requestId: 'req-W' }));
        assert.deepEqual(got.pairs.map((p: { requestId: string }) => p.requestId), ['req-W']);
        const notThere = JSON.parse(await getPromptPairImpl(tmp, { questId: QUEST, sessions: 'chat', requestId: 'req-W' }));
        assert.deepEqual([notThere.pairs.length, notThere.notFoundRequestIds], [0, ['req-W']], "walk's pair is not in chat");
        setActiveToolTrail(new ToolTrail());
    });
});

function entry(key: string, toolName: string, result: string): PastToolEntry {
    return { key, timestamp: '2026-10-27T10:00:00.000Z', round: 1, toolName, inputSummary: '', result, durationMs: 1 };
}

describe('sessions — past tool calls', () => {
    const stored: Record<string, PastToolEntry[]> = {
        chat: [entry('t1', 'tomAi_readFile', 'chat body alpha'), entry('t2', 'tomAi_listQueue', 'chat queue')],
        walk: [entry('t1', 'tomAi_readFile', 'walk body alpha')],
    };
    const access: ToolHistoryAccess = {
        listRingBuffer: () => [entry('t9', 'tomAi_getErrors', 'ring only')],
        ringBufferCapacity: () => 40,
        readFromDisk: () => undefined,
        knownSessions: () => ['default', 'chat', 'walk'],
        callerSession: () => 'chat',
        listStoredResults: (s) => stored[s] ?? [],
    };

    test('SP-2: ring, stored per session, unknown', async () => {
        const ring = JSON.parse(await listPastToolCallsImpl(access, {}));
        assert.deepEqual(ring.entries.map((e: { key: string }) => e.key), ['t9'], 'without sessions: the ring buffer');
        const both = JSON.parse(await listPastToolCallsImpl(access, { sessions: ['chat', 'walk'] }));
        assert.deepEqual(both.entries.map((e: { session: string; key: string }) => `${e.session}/${e.key}`), ['chat/t1', 'chat/t2', 'walk/t1']);
        assert.deepEqual(both.sessions, ['chat', 'walk']);
        const all = JSON.parse(await listPastToolCallsImpl(access, { sessions: 'all' }));
        assert.equal(all.entries.length, 3, 'default has none');
        const hits = JSON.parse(await searchPastToolResultsImpl(access, { pattern: 'alpha', sessions: 'all' }));
        assert.deepEqual(hits.hits.map((h: { session: string }) => h.session), ['chat', 'walk']);
        const read = JSON.parse(await readPastToolResultImpl(access, { key: '1', sessions: 'walk' }));
        assert.deepEqual([read.ok, read.session, read.result, read.source], [true, 'walk', 'walk body alpha', 'disk']);
        const twice = JSON.parse(await readPastToolResultImpl(access, { key: 't1', sessions: ['chat', 'walk'] }));
        assert.deepEqual([twice.session, twice.alsoIn], ['chat', ['walk']]);
        const missing = JSON.parse(await readPastToolResultImpl(access, { key: 't2', sessions: 'walk' }));
        assert.equal(missing.ok, false);
        const unknown = JSON.parse(await listPastToolCallsImpl(access, { sessions: 'nope' }));
        assert.deepEqual([unknown.ok, unknown.code], [false, 'unknownSession']);
    });
});

describe('sessions — quest memory', () => {
    test('SP-3: per session', async () => {
        // A memory store whose quest scope is per session, like TwoTierMemoryService.
        const files: Record<string, Record<string, string>> = {};
        let active = 'chat';
        const key = (scope: MemoryScope): string => (scope === 'shared' ? 'shared' : `quest:${active}`);
        const store: MemoryStore = {
            list: (scope) => Object.keys(files[key(scope)] ?? {}),
            read: (scope, file) => files[key(scope)]?.[file] ?? '',
            append: (scope, file, content) => { (files[key(scope)] ??= {})[file] = (files[key(scope)][file] ?? '') + content; },
            replaceSection: () => undefined,
            delete: (scope, file) => { delete files[key(scope)]?.[file]; },
            knownSessions: () => ['default', 'chat', 'walk'],
            callerSession: () => 'chat',
            inSession: (s, fn) => { const was = active; active = s; try { return fn(); } finally { active = was; } },
        };
        await saveMemoryImpl(store, { content: 'own fact' });
        assert.deepEqual(files['quest:chat'], { 'facts.md': 'own fact' }, "without sessions: the caller's session, as before");
        const both = JSON.parse(await saveMemoryImpl(store, { content: 'both', sessions: ['walk', 'default'] }));
        assert.deepEqual([both.ok, both.sessions.map((s: { session: string }) => s.session)], [true, ['walk', 'default']]);
        assert.deepEqual([files['quest:walk']['facts.md'], files['quest:default']['facts.md']], ['both', 'both']);
        assert.equal(active, 'chat', 'the active session is restored');
        const read = await readMemoryImpl(store, { sessions: 'all' });
        assert.match(read, /## session default\n\n### quest\/facts\.md\nboth/);
        assert.match(read, /## session chat\n\n### quest\/facts\.md\nown fact/);
        assert.match(read, /## session walk/);
        assert.match(await listMemoryImpl(store, { sessions: ['walk'] }), /## session walk\n\nquest\/facts\.md/);
        await saveMemoryImpl(store, { scope: 'shared', content: 'shared fact', sessions: ['walk', 'chat'] });
        assert.deepEqual(files.shared, { 'facts.md': 'shared fact' }, 'shared memory is one set: written once');
        assert.deepEqual(JSON.parse(await saveMemoryImpl(store, { content: 'x', sessions: 'nope' })).code, 'unknownSession');
    });
});
