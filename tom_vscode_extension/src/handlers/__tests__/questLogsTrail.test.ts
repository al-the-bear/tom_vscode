/**
 * The @CHAT Logs Trail tab on the host (questLogs-handler.ts) in a sandbox workspace whose quest has two hosts'
 * trail files: this host's and another's.
 *
 *   LT-1 the Trail tab answers the chosen session's turns of THIS host's trail only, newest first, as pairs; the
 *        other host's turns (same session) are not there; its file is this host's trail
 *   LT-2 a summary pair left in the session's old folder is not read
 *   LT-3 an unchanged trail answers `qlogUnchanged`; a new turn re-renders
 *   LT-4 the pair actions: copy the prompt / the answer, the Markdown overlay (qlogMarkdown with the rendered pair),
 *        open the turn in this host's trail at its block
 */

import test, { after, describe } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'fs';
import * as path from 'path';

const EXT = path.resolve(__dirname, '..', '..', '..');
const SANDBOX = fs.realpathSync(fs.mkdtempSync(path.join(EXT, '..', '..', '..', 'ztmp', 'questLogsTrail-')));
const WS = path.join(SANDBOX, 'ws');
const QUEST = 'q1';
function put(rel: string, text: string): void {
    const abs = path.join(WS, rel);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, text);
}
put('.tom/tom_root.yaml', 'version: 1\n');
put('.tom/tom_vscode_extension.json', '{}\n');
put(`_ai/quests/${QUEST}/overview.${QUEST}.md`, '# Q1\n');

import { installVscodeStub } from '../../tools/__tests__/_vscode-stub.js';
const stubbed = installVscodeStub({ workspaceFolders: [WS] });
const stub = stubbed.stub as Record<string, Record<string, unknown>>;
stub.workspace.workspaceFile = { fsPath: path.join(WS, `${QUEST}.code-workspace`), scheme: 'file' };
const clipboard: string[] = [];
stub.env.clipboard = { writeText: async (t: string) => { clipboard.push(t); }, readText: async () => clipboard.at(-1) ?? '' };
const shown: Array<{ file: string; line: number | undefined }> = [];
stub.window.showTextDocument = async (doc: { uri: { fsPath: string } }, opts?: { selection?: { start: { line: number } } }) => {
    shown.push({ file: doc.uri.fsPath, line: opts?.selection?.start.line });
    return {};
};

import { TomAiConfiguration } from '../../utils/tomAiConfiguration.js';
import { setExtensionPath } from '../handler_shared.js';
import { handleQuestLogsMessage } from '../questLogs-handler.js';
import { appendHostTrailTurn, hostTrailFile, type HostTrailTurn } from '../../services/hostTrail.js';
import { hostSlugOf } from '../../utils/hostSlug.js';

setExtensionPath(EXT);
TomAiConfiguration.init({} as never);
after(() => { fs.rmSync(SANDBOX, { recursive: true, force: true }); });

const QUEST_FOLDER = path.join(WS, '_ai', 'quests', QUEST);
const HOST = hostSlugOf();
const OTHER = `${HOST}-other`;
const turn = (id: string, time: string, host: string, session: string): HostTrailTurn => ({
    id, time, host, session, profile: 'prof', model: 'mod', prompt: `prompt ${id}`, answer: `answer ${id}`,
});
for (const t of [
    turn('h1', '2026-11-25T10:00:00.000Z', HOST, 'chat'),
    turn('h2', '2026-11-25T11:00:00.000Z', HOST, 'walk'),
    turn('h3', '2026-11-25T12:00:00.000Z', HOST, 'chat'),
    turn('o1', '2026-11-25T13:00:00.000Z', OTHER, 'chat'),
]) { appendHostTrailTurn(QUEST_FOLDER, t, 2000); }
// A summary pair left at the old place: not read.
put(`_ai/quests/${QUEST}/history/sessions/chat/${QUEST}.anthropic.prompts.md`,
    '=== PROMPT late 2026-11-25T10:30:00.000Z 2 ===\nlate prompt\n\n=== PROMPT early 2026-11-24T09:00:00.000Z 1 ===\nearly prompt\n');
put(`_ai/quests/${QUEST}/history/sessions/chat/${QUEST}.anthropic.answers.md`,
    '=== ANSWER early 2026-11-24T09:00:05.000Z 1 ===\nearly answer\n');

interface Posted { type: string; tab?: string; session?: string; html?: string; filePath?: string; turns?: number; title?: string }
function webview(): { posted: Posted[]; postMessage(m: Posted): Promise<boolean> } {
    const posted: Posted[] = [];
    return { posted, postMessage: async (m: Posted) => { posted.push(JSON.parse(JSON.stringify(m))); return true; } };
}
const ids = (html: string): string[] => [...html.matchAll(/<div class="qlog-turn" data-qlog-turn="([^"]+)"/g)].map((m) => m[1]);

describe('the @CHAT Logs Trail tab', () => {
    test('LT-1 / LT-2: this host\'s turns of the session, newest first', async () => {
        const wv = webview();
        await handleQuestLogsMessage({ type: 'qlogRequest', viewer: 'logs', tab: 'turns', session: 'chat', force: true }, wv as never);
        const content = wv.posted.find((m) => m.type === 'qlogContent');
        assert.ok(content, `content posted: ${JSON.stringify(wv.posted.map((m) => m.type))}`);
        assert.equal(content!.session, 'chat');
        assert.deepEqual(ids(content!.html!), ['h3', 'h1'], 'no other host\'s turn, no other session\'s, no old pair\'s');
        assert.equal(content!.turns, 2);
        assert.equal(content!.filePath, hostTrailFile(QUEST_FOLDER, HOST), 'its file is this host\'s trail');
        assert.ok(fs.existsSync(hostTrailFile(QUEST_FOLDER, OTHER)), 'the other host\'s trail is there, unread');
        assert.match(content!.html!, /prompt h3[\s\S]*answer h3/, 'a pair: the prompt, then its answer');
        assert.ok(wv.posted.some((m) => m.type === 'qlogSessions'), 'the session switch');
    });

    test('LT-3: unchanged until a turn comes', async () => {
        const wv = webview();
        await handleQuestLogsMessage({ type: 'qlogRequest', viewer: 'logs', tab: 'turns', session: 'chat', force: true }, wv as never);
        await handleQuestLogsMessage({ type: 'qlogRequest', viewer: 'logs', tab: 'turns', session: 'chat' }, wv as never);
        assert.equal(wv.posted.at(-1)?.type, 'qlogUnchanged');
        appendHostTrailTurn(QUEST_FOLDER, turn('h4', '2026-11-25T14:00:00.000Z', HOST, 'chat'), 2000);
        await handleQuestLogsMessage({ type: 'qlogRequest', viewer: 'logs', tab: 'turns', session: 'chat' }, wv as never);
        const last = wv.posted.at(-1)!;
        assert.equal(last.type, 'qlogContent');
        assert.deepEqual(ids(last.html!), ['h4', 'h3', 'h1']);
    });

    test('LT-4: the pair actions', async () => {
        const wv = webview();
        const act = (action: string, turnId: string) => handleQuestLogsMessage({ type: 'qlogTurnAction', viewer: 'logs', tab: 'turns', session: 'chat', action, turn: turnId }, wv as never);
        await act('copyPrompt', 'h3');
        await act('copyAnswer', 'h1');
        assert.deepEqual(clipboard, ['prompt h3', 'answer h1']);
        await act('markdown', 'h1');
        const md = wv.posted.find((m) => m.type === 'qlogMarkdown');
        assert.ok(md, 'the overlay content');
        assert.equal(md!.title, '2026-11-25T10:00:00.000Z · prof · mod');
        assert.match(md!.html!, /<h2>Prompt<\/h2>[\s\S]*prompt h1[\s\S]*<h2>Answer<\/h2>[\s\S]*answer h1/);
        await act('open', 'h3');
        const file = hostTrailFile(QUEST_FOLDER, HOST);
        const lines = fs.readFileSync(file, 'utf-8').split('\n');
        assert.deepEqual(shown.at(-1), { file, line: lines.findIndex((l) => l.includes('"id":"h3"')) });
        await act('copyPrompt', 'o1');
        assert.equal(clipboard.length, 2, 'another host\'s turn is not this session\'s turn here');
    });
});
