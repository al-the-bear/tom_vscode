/**
 * tomAi_notifyUser sends with the quest's Telegram settings (vscimpb25): the registered tool, its live channels
 * and telegram-config.ts, over a quest's two `extension_config` files, with `fetch` stubbed.
 *
 *   NQ-1 `auto` with the quest set up (enabled and botTokenEnv in the host file, defaultChatId in the quest file, the
 *        token in the variable): sent to Telegram — the token's sendMessage URL, the default chat — and no VS Code
 *        notification
 *   NQ-2 `auto` without Telegram settings, with Telegram disabled, without the token variable, without a default
 *        chat: a VS Code notification and no request; `telegram` then answers an error naming what is needed
 *   NQ-3 a failed send (HTTP 403): `auto` falls back to VS Code
 *   NQ-4 telegramNotifyTarget: the target of a parsed config, null for each missing piece
 */

/* eslint-disable @typescript-eslint/naming-convention -- Telegram's field names */
import test, { after, beforeEach, describe } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

const WS = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'notify-quest-telegram-')));
const QUEST = 'nq1';
fs.mkdirSync(path.join(WS, '_ai', 'quests', QUEST), { recursive: true });
fs.mkdirSync(path.join(WS, '.tom'), { recursive: true });
fs.writeFileSync(path.join(WS, '.tom', 'tom_vscode_extension.json'), '{}\n');

import { installVscodeStub } from './_vscode-stub.js';
const stubbed = installVscodeStub({ workspaceFolders: [WS] });
(stubbed.stub.workspace as Record<string, unknown>).workspaceFile = { fsPath: path.join(WS, `${QUEST}.code-workspace`), scheme: 'file' };

// Through the registry, as the extension loads it (chat-enhancement-tools alone first runs into the tools' import cycle).
import '../tool-executors.js';
import { NOTIFY_USER_TOOL } from '../chat-enhancement-tools.js';
import { telegramNotifyTarget } from '../../handlers/telegram-config.js';
import { parseTelegramConfig } from '../../handlers/telegram-notifier.js';
import { WsPaths } from '../../utils/workspacePaths.js';

const TOKEN_ENV = 'TOM_TEST_NQ_BOT_TOKEN';
const questFile = path.join(WS, '_ai', 'quests', QUEST, `extension_config.${QUEST}.yaml`);
const hostFile = path.join(WS, '_ai', 'quests', QUEST, `extension_config.${WsPaths.hostSlug()}.${QUEST}.yaml`);

/** The quest's Telegram settings: the host part (enabled, botTokenEnv) and the shared part (defaultChatId). */
function setUp(opts: { enabled?: boolean; chatId?: number | null; token?: string | null } = {}): void {
    fs.writeFileSync(hostFile, `telegram:\n  enabled: ${opts.enabled ?? true}\n  botTokenEnv: ${TOKEN_ENV}\n`);
    fs.writeFileSync(questFile, opts.chatId === null ? 'telegram: {}\n' : `telegram:\n  defaultChatId: ${opts.chatId ?? 4711}\n`);
    if (opts.token === null) { delete process.env[TOKEN_ENV]; } else { process.env[TOKEN_ENV] = opts.token ?? 'tok-123'; }
}
function noSettings(): void {
    for (const f of [questFile, hostFile]) { fs.rmSync(f, { force: true }); }
    delete process.env[TOKEN_ENV];
}

const requests: Array<{ url: string; body: Record<string, unknown> }> = [];
let status = 200;
const realFetch = globalThis.fetch;
globalThis.fetch = (async (url: string, init?: { body?: string }) => {
    requests.push({ url: String(url), body: JSON.parse(init?.body ?? '{}') });
    return { ok: status >= 200 && status < 300, status } as Response;
}) as typeof fetch;

const toasts = (): number => stubbed.spies.calls.filter((c) => /^window\.show(Information|Warning|Error)Message$/.test(c.method)).length;
const notify = async (input: Record<string, unknown>): Promise<Record<string, unknown>> =>
    JSON.parse(await NOTIFY_USER_TOOL.execute({ message: 'build done', ...input } as never));

beforeEach(() => { requests.length = 0; status = 200; });
after(() => {
    globalThis.fetch = realFetch;
    delete process.env[TOKEN_ENV];
    stubbed.restore();
    fs.rmSync(WS, { recursive: true, force: true });
});

describe('tomAi_notifyUser and the quest\'s Telegram settings', () => {
    test('NQ-1: auto goes to the quest\'s Telegram', async () => {
        setUp();
        const before = toasts();
        const r = await notify({});
        assert.equal(r.channel, 'telegram', JSON.stringify(r));
        assert.equal(requests.length, 1);
        assert.equal(requests[0].url, 'https://api.telegram.org/bottok-123/sendMessage');
        assert.equal(requests[0].body.chat_id, 4711);
        assert.match(String(requests[0].body.text), /build done/);
        assert.equal(toasts(), before, 'no VS Code notification');
    });

    test('NQ-2: not set up — VS Code, and an error for channel telegram', async () => {
        const cases: Array<[string, () => void]> = [
            ['no settings', noSettings],
            ['disabled', () => setUp({ enabled: false })],
            ['no token variable', () => setUp({ token: null })],
            ['no default chat', () => setUp({ chatId: null })],
        ];
        for (const [name, arrange] of cases) {
            arrange();
            requests.length = 0;
            const before = toasts();
            const r = await notify({});
            assert.equal(r.channel, 'vscode', `${name}: ${JSON.stringify(r)}`);
            assert.equal(toasts(), before + 1, `${name}: a VS Code notification`);
            assert.equal(requests.length, 0, `${name}: no request`);
            const forced = await notify({ channel: 'telegram' });
            assert.equal(forced.ok, false, name);
            assert.match(String(forced.error), /not set up for this quest on this machine.*botTokenEnv.*defaultChatId/, name);
        }
    });

    test('NQ-3: a failed send falls back to VS Code', async () => {
        setUp();
        status = 403;
        const before = toasts();
        const r = await notify({});
        assert.equal(requests.length, 1, 'tried Telegram');
        assert.equal(r.channel, 'vscode', JSON.stringify(r));
        assert.equal(toasts(), before + 1);
    });

    test('NQ-4: telegramNotifyTarget', () => {
        process.env[TOKEN_ENV] = 'tok-9';
        const base = { enabled: true, botTokenEnv: TOKEN_ENV, defaultChatId: 42 };
        assert.deepEqual(telegramNotifyTarget(parseTelegramConfig(base)), { token: 'tok-9', chatId: 42 });
        assert.equal(telegramNotifyTarget(parseTelegramConfig({ ...base, enabled: false })), null);
        assert.equal(telegramNotifyTarget(parseTelegramConfig({ ...base, defaultChatId: undefined })), null);
        delete process.env[TOKEN_ENV];
        assert.equal(telegramNotifyTarget(parseTelegramConfig(base)), null);
    });
});
