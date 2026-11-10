/**
 * "Send to Copilot" goes to Copilot (vscimpb19): there is no `sendToChatTarget` any more; Send to LLM
 * (`tomAi.sendToLlm*`) is the command for the ANTHROPIC/LLM panel.
 *
 *   SC-1 `tomAi.sendToCopilot` (sendToChatHandler) opens Copilot Chat with the selection — also when a stale
 *        `sendToChatTarget: anthropic` is still in the config
 *   SC-2 `tomAi.sendToCopilot.standard` applies the default template and opens Copilot Chat with the result
 *   SC-3 the scripting API's send (`sendToChatVce`): Anthropic by default, Copilot when `target: 'copilot'`
 */

import test, { describe, after } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import { installVscodeStub } from '../../tools/__tests__/_vscode-stub.js';

const WS = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'send-to-copilot-')));
fs.mkdirSync(path.join(WS, '.tom'), { recursive: true });
fs.writeFileSync(path.join(WS, '.tom', 'tom_vscode_extension.json'), JSON.stringify({
    sendToChatTarget: 'anthropic',
    anthropic: { userMessageTemplates: [{ id: 'wrap', name: 'Wrap', template: 'Please look at: ${userMessage}', isDefault: true }] },
}, null, 2));
const stubbed = installVscodeStub({ workspaceFolders: [WS] });
const stubWindow = stubbed.stub.window as Record<string, unknown>;
const stubCommands = stubbed.stub.commands as Record<string, unknown>;
const handlers = new Map<string, (...args: unknown[]) => unknown>();
stubCommands.registerCommand = (id: string, fn: (...args: unknown[]) => unknown) => { handlers.set(id, fn); return { dispose: () => undefined }; };

import { sendToChatHandler } from '../sendToChat-handler.js';
import { SendToChatAdvancedManager } from '../copilotTemplates-handler.js';
import { scriptSendTarget } from '../sendToChatRouter.js';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Json = any;
const context = { subscriptions: [] as Array<{ dispose(): void }>, workspaceState: { get: () => undefined, update: async () => undefined } } as never;
const editorWith = (text: string, selected: string): Json => ({
    document: { getText: (range?: unknown) => (range ? selected : text) },
    selection: { isEmpty: selected === '' },
});
const chatOpens = (): Json[] => stubbed.spies.calls
    .filter((c) => c.method === 'commands.executeCommand' && c.args[0] === 'workbench.action.chat.open')
    .map((c) => c.args[1]);

after(() => { stubbed.restore(); fs.rmSync(WS, { recursive: true, force: true }); });

describe('Send to Copilot goes to Copilot', () => {
    test('SC-1: the plain command', async () => {
        stubWindow.activeTextEditor = editorWith('the whole file', 'the selection');
        const before = chatOpens().length;
        await sendToChatHandler(context);
        assert.deepEqual(chatOpens().slice(before), [{ query: 'the selection' }]);
    });

    test('SC-2: the default template', async () => {
        const manager = new SendToChatAdvancedManager(context);
        await manager.initialize();
        const standard = handlers.get('tomAi.sendToCopilot.standard');
        assert.ok(standard, 'registered');
        stubWindow.activeTextEditor = editorWith('the whole file', 'two lines');
        const before = chatOpens().length;
        await standard!();
        const opened = chatOpens().slice(before);
        assert.equal(opened.length, 1, 'Copilot Chat opened once');
        assert.match(String(opened[0].query), /^Please look at: two lines/, 'the template applied');
    });

    test('SC-3: the scripting API\'s target', () => {
        assert.equal(scriptSendTarget(undefined), 'anthropic');
        assert.equal(scriptSendTarget(''), 'anthropic');
        assert.equal(scriptSendTarget('anthropic'), 'anthropic');
        assert.equal(scriptSendTarget('copilot'), 'copilot');
        assert.equal(scriptSendTarget('bogus'), 'anthropic');
    });
});
