/**
 * A send writes its turn to the host's compact trail (src/services/hostTrail.ts), through the real handler's direct
 * loop (only the Anthropic client is a stub that scripts the model's replies).
 *
 *   HS-1 a send in a session appends one turn to `history/trail.<host>.md`: the request's prompt as sent, the final
 *        answer, the session, profile and model; no summary pair is written in the session's storage
 *   HS-2 a session whose `contributesToTrailAndMemory` is off adds no turn
 *   HS-3 a failed send writes its turn once, with the error as its answer
 *   HS-4 an isolated sub-agent run is an inner step: no turn
 */

/* eslint-disable @typescript-eslint/naming-convention -- the API's wire fields */

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import test, { after, describe } from 'node:test';
import assert from 'node:assert/strict';

import { installVscodeStub } from '../../tools/__tests__/_vscode-stub.js';

const base = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'host-trail-send-')));
const ws = path.join(base, 'ws');
// The sandbox is a root of its own: nothing reaches the real one.
fs.mkdirSync(path.join(ws, '.tom'), { recursive: true });
fs.writeFileSync(path.join(ws, '.tom', 'tom_root.yaml'), 'name: sandbox\n');
installVscodeStub({ workspaceFolders: [ws] });

import { AnthropicHandler } from '../anthropic-handler.js';
import { TrailService, questHistoryRoot } from '../../services/trailService.js';
import { TomAiConfiguration } from '../../utils/tomAiConfiguration.js';
import { WsPaths } from '../../utils/workspacePaths.js';
import { createSession } from '../../services/agentSdkSessionStore.js';
import { readHostTrail } from '../../services/hostTrail.js';
import { hostSlugOf } from '../../utils/hostSlug.js';
import { sessionRoot } from '../../services/sessionStorage.js';

TrailService.init({} as never);
TomAiConfiguration.init({} as never);
after(() => { fs.rmSync(base, { recursive: true, force: true }); });

let reply: { text: string } | { error: string } = { text: 'All done.' };
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const handler = AnthropicHandler.instance as any;
handler.awaitApproval = async () => true;
handler.getClient = () => ({
    messages: {
        stream: () => ({
            finalMessage: async () => {
                if ('error' in reply) { throw new Error(reply.error); }
                return { id: 'm1', type: 'message', role: 'assistant', model: 'claude-test', content: [{ type: 'text', text: reply.text }], stop_reason: 'end_turn', usage: { input_tokens: 1, output_tokens: 1 } };
            },
        }),
    },
});

function send(userText: string, extra: Record<string, unknown> = {}) {
    return AnthropicHandler.instance.sendMessage({
        userText,
        profile: { id: 'p-test', name: 'p', systemPrompt: 'Base.', toolApprovalMode: 'never', toolSearch: false },
        configuration: { id: 'd', name: 'd', model: 'claude-test', maxTokens: 100, maxRounds: 2, transport: 'direct' },
        tools: [],
        skipQuestRefresh: true,
        ...extra,
    } as never);
}

const quest = WsPaths.getWorkspaceQuestId();
const historyRoot = questHistoryRoot(quest);
const questFolder = path.dirname(historyRoot);
const turns = () => readHostTrail(questFolder, hostSlugOf());

describe('a send writes the host trail', () => {
    test('HS-1: one turn per send', async () => {
        createSession(historyRoot, 'work', {});
        reply = { text: 'All done.\n\n## Summary\n\n```\ncode\n```' };
        await send('do the work\n\n# with a heading', { sessionKey: 'work' });
        const written = turns();
        assert.equal(written.length, 1);
        const t = written[0];
        assert.deepEqual([t.session, t.profile, t.model, t.host, t.prompt, t.answer],
            ['work', 'p-test', 'claude-test', hostSlugOf(), 'do the work\n\n# with a heading', 'All done.\n\n## Summary\n\n```\ncode\n```']);
        assert.ok(t.id.length > 0 && !Number.isNaN(Date.parse(t.time)));
        const storage = sessionRoot(historyRoot, 'work');
        const pair = fs.existsSync(storage) ? fs.readdirSync(storage).filter((f) => /\.(prompts|answers)\.md$/.test(f)) : [];
        assert.deepEqual(pair, [], 'no summary pair');
    });

    test('HS-2: the setting off writes nothing', async () => {
        createSession(historyRoot, 'quiet', { contributesToTrailAndMemory: false });
        const before = turns().length;
        reply = { text: 'Quiet answer.' };
        await send('a quiet prompt', { sessionKey: 'quiet' });
        assert.equal(turns().length, before);
    });

    test('HS-3: a failed send', async () => {
        const before = turns().length;
        reply = { error: 'invalid request: bad thing' };
        await assert.rejects(send('this will fail', { sessionKey: 'work' }));
        const added = turns().slice(before);
        assert.equal(added.length, 1, 'written once');
        assert.deepEqual([added[0].prompt, added[0].answer], ['this will fail', '(error: invalid request: bad thing)']);
    });

    test('HS-4: an isolated run adds no turn', async () => {
        const before = turns().length;
        reply = { text: 'Sub-agent answer.' };
        await send('a sub-agent task', { isolated: true });
        assert.equal(turns().length, before);
    });
});
