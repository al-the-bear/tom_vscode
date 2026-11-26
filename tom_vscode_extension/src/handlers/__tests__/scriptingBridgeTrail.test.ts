/**
 * The scripting bridge's trail operations and removed document folders (tomScriptingBridge-handler.ts, read by
 * tom_vscode_scripting_api's TomDocumentApi), through the vscode stub in a sandbox root: the window's quest `q1` with
 * this host's trail and another host's, a quest `q2` with a turn of its own.
 *
 *   BT-1 `doc.listTrailVce`: this host's turns of the window's quest, newest first, each with id, questId, file,
 *        time, host, session, profile, model, prompt and answer; `limit` (default 20) and `since` (an ISO time;
 *        another text is refused); `totalCount` counts every turn after `since`; `questId` names another quest;
 *        without a quest the call is refused
 *   BT-2 `doc.getTrailEntryVce` / `doc.findTrailByRequestIdVce`: the turn with that request id from any host's trail
 *        of the quest, or null
 *   BT-3 `doc.listVce` refuses the removed folders `bot_conversations` and `send_to_chat` with where their content
 *        went; the bridge maps neither any more
 */

import { describe, test, after } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'fs';
import * as path from 'path';

const EXT = path.resolve(__dirname, '..', '..', '..');
const SANDBOX = fs.realpathSync(fs.mkdtempSync(path.join(EXT, '..', '..', '..', 'ztmp', 'vscode_extension_261126_01_aifmt-10_trail-')));
const WS = path.join(SANDBOX, 'ws');
fs.mkdirSync(path.join(SANDBOX, '.tom'), { recursive: true });
fs.writeFileSync(path.join(SANDBOX, '.tom', 'tom_root.yaml'), 'root: true\n');
for (const q of ['q1', 'q2']) {
    fs.mkdirSync(path.join(WS, '_ai', 'quests', q), { recursive: true });
    fs.writeFileSync(path.join(WS, '_ai', 'quests', q, `overview.${q}.md`), `# ${q}\n`);
}
process.env.HOME = path.join(SANDBOX, 'home');
process.env.USERPROFILE = process.env.HOME;
fs.mkdirSync(process.env.HOME, { recursive: true });

import { installVscodeStub } from '../../tools/__tests__/_vscode-stub.js';

const vs = installVscodeStub({ workspaceFolders: [WS] });
const workspace = vs.stub.workspace as Record<string, unknown>;
workspace.workspaceFile = { fsPath: path.join(WS, 'q1.code-workspace'), scheme: 'file' };
after(() => { vs.restore(); fs.rmSync(SANDBOX, { recursive: true, force: true }); });

import { TomScriptingBridgeHandler } from '../tomScriptingBridge-handler.js';
import { appendHostTrailTurn, hostTrailFile, type HostTrailTurn } from '../../services/hostTrail.js';
import { hostSlugOf } from '../../utils/hostSlug.js';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Json = any;
const HOST = hostSlugOf();
const OTHER = `${HOST}-other`;
const q1 = path.join(WS, '_ai', 'quests', 'q1');
const q2 = path.join(WS, '_ai', 'quests', 'q2');
const time = (n: number): string => new Date(Date.UTC(2026, 10, 26, 9, 0, n)).toISOString();
const turn = (id: string, n: number, host = HOST): HostTrailTurn => ({ id, time: time(n), host, session: 'idea@collab', profile: 'opus', model: 'claude-opus-5-5', prompt: `prompt ${id}`, answer: `answer ${id}` });
for (let n = 1; n <= 25; n++) { appendHostTrailTurn(q1, turn(`r${n}`, n), 2000); }
appendHostTrailTurn(q1, turn('elsewhere', 30, OTHER), 2000);
appendHostTrailTurn(q2, turn('q2-only', 1), 2000);

const bridge = new TomScriptingBridgeHandler() as unknown as { handleDocRequest(method: string, params: Json): Promise<Json> };

describe('the scripting bridge\'s trail', () => {
    test('BT-1: the list', async () => {
        const all = await bridge.handleDocRequest('doc.listTrailVce', {});
        assert.equal(all.questId, 'q1');
        assert.equal(all.host, HOST);
        assert.equal(all.totalCount, 25, 'this host\'s turns only');
        assert.equal(all.entries.length, 20, 'default limit 20');
        assert.deepEqual(all.entries[0], {
            id: 'r25', questId: 'q1', file: hostTrailFile(q1, HOST), time: time(25), host: HOST,
            session: 'idea@collab', profile: 'opus', model: 'claude-opus-5-5', prompt: 'prompt r25', answer: 'answer r25',
        }, 'newest first, every field of the turn');
        const since = await bridge.handleDocRequest('doc.listTrailVce', { since: time(22), limit: 2 });
        assert.deepEqual([since.entries.map((e: Json) => e.id), since.totalCount], [['r25', 'r24'], 3]);
        await assert.rejects(bridge.handleDocRequest('doc.listTrailVce', { since: 'yesterday' }), /since must be an ISO date-time/);
        const other = await bridge.handleDocRequest('doc.listTrailVce', { questId: 'q2' });
        assert.deepEqual([other.questId, other.entries.map((e: Json) => e.id)], ['q2', ['q2-only']]);
        workspace.workspaceFile = undefined;
        try {
            await assert.rejects(bridge.handleDocRequest('doc.listTrailVce', {}), /No quest: pass questId/);
            assert.equal((await bridge.handleDocRequest('doc.listTrailVce', { questId: 'q1', limit: 1 })).entries[0].id, 'r25');
        } finally {
            workspace.workspaceFile = { fsPath: path.join(WS, 'q1.code-workspace'), scheme: 'file' };
        }
    });

    test('BT-2: a turn by its request id', async () => {
        const own = await bridge.handleDocRequest('doc.getTrailEntryVce', { entryId: 'r3' });
        assert.deepEqual([own.id, own.prompt, own.answer, own.host], ['r3', 'prompt r3', 'answer r3', HOST]);
        const other = await bridge.handleDocRequest('doc.findTrailByRequestIdVce', { requestId: 'elsewhere' });
        assert.deepEqual([other.host, other.file], [OTHER, hostTrailFile(q1, OTHER)], 'any host\'s trail of the quest');
        assert.equal(await bridge.handleDocRequest('doc.findTrailByRequestIdVce', { requestId: 'missing' }), null);
        assert.equal(await bridge.handleDocRequest('doc.getTrailEntryVce', { entryId: 'q2-only' }), null, 'the window\'s quest only');
        assert.equal((await bridge.handleDocRequest('doc.getTrailEntryVce', { entryId: 'q2-only', questId: 'q2' })).id, 'q2-only');
    });

    test('BT-3: the removed folders', async () => {
        await assert.rejects(bridge.handleDocRequest('doc.listVce', { folder: 'bot_conversations' }), /_ai\/bot_conversations is no longer part of the workspace/);
        await assert.rejects(bridge.handleDocRequest('doc.listVce', { folder: 'send_to_chat' }), /_ai\/send_to_chat is no longer part of the workspace: nothing writes it; send a prompt with TomChatApi\.sendToChat/);
        const src = fs.readFileSync(path.join(EXT, 'src', 'handlers', 'tomScriptingBridge-handler.ts'), 'utf8');
        assert.doesNotMatch(src, /case 'bot_conversations'|case 'send_to_chat'|WsPaths\.ai\('bot_conversations'\)|WsPaths\.ai\('send_to_chat'\)/);
    });
});
