/**
 * Every question panel closes when its question is resolved (ccparity_e_process-4, CC-55, C-32), under the
 * vscode stub whose webview panels record dispose.
 *
 *   PC-1 tomAi_askUser answered in the panel: the panel closes, none is left open
 *   PC-2 the prompt that asked ends before the answer (stopped, aborted, failed): the send owns its questions
 *        (services/askOwners.ts runAsAskOwner, around AnthropicHandler.sendMessage), so the question is
 *        cancelled with ASK_OWNER_ENDED_NOTE and its panel closes; a later question can be asked again.
 *        Before, the question stayed pending with its panel open (and every later ask was refused)
 *   PC-3 the Agent SDK's AskUserQuestion with choices (askUserWithChoices): a click on a choice the panel does
 *        not know still answers and closes the panel — before, nothing answered and the panel stayed with its
 *        buttons locked; ended with its prompt like PC-2
 *   PC-4 a panel that posts an answer to a question no longer open closes instead of waiting forever
 *   PC-5 tomAi_askInMdBrowser: ended with its prompt — cancelled, its bar cleared (or the panel closed with an
 *        unkept file); a question asked outside any send is not touched when another send ends
 *   PC-6 the wiring: sendMessage runs as the owner; the registry and the MD Browser slot register and
 *        unregister their cancels
 */

import test, { describe } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';

import { installVscodeStub } from '../../tools/__tests__/_vscode-stub.js';

const stubbed = installVscodeStub({});

// The tool registry first: the handler is one of its members, and loading it alone hits the cycle.
import '../../tools/tool-executors.js';
import { ASK_USER_LIVE_TOOL, askUserWithChoices, openAskPanelIds } from '../askUser-handler.js';
import { setExtensionPath } from '../handler_shared.js';
import { AskUserRegistry, ASK_OWNER_ENDED_NOTE } from '../../services/askUserRegistry.js';
import { runAsAskOwner, hasAskOwner } from '../../services/askOwners.js';
import { MdBrowserAskSlot, askInMdBrowserImpl, type AskInMdBrowserDeps } from '../../tools/ask-in-md-browser-tool.js';

const EXT = path.join(__dirname, '..', '..', '..');
setExtensionPath(EXT);

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Json = any;
const panels = (): Json[] => (stubbed.stub.window as Json).__webviewPanels;
const lastPanel = (): Json => panels()[panels().length - 1];
const requestIdOf = (panel: Json): string => JSON.parse(/window\.__INIT__ = (\{.*?\});/s.exec(panel.webview.html)?.[1] ?? 'null').requestId;
const tick = () => new Promise((r) => setTimeout(r, 5));

describe('question panels close when their question is resolved', () => {
    test('PC-1: answered in the panel', async () => {
        const call = ASK_USER_LIVE_TOOL.execute({ questions: ['Which?'] });
        await tick();
        const panel = lastPanel();
        assert.equal(panel.visible, true);
        panel.webview.__receive({ type: 'submit', requestId: requestIdOf(panel), text: 'this one' });
        assert.equal(await call, 'this one');
        assert.equal(panel.visible, false, 'closed');
        assert.deepEqual(openAskPanelIds(), []);
    });

    test('PC-2: the prompt that asked ends first', async () => {
        let answer: string | undefined;
        const send = runAsAskOwner(async () => {
            assert.equal(hasAskOwner(), true);
            void ASK_USER_LIVE_TOOL.execute({ questions: ['Still there?'] }).then((a) => { answer = a; });
            await tick();
            throw new Error('the prompt was stopped');
        });
        await assert.rejects(send, /stopped/);
        await tick();
        assert.equal(answer, ASK_OWNER_ENDED_NOTE, 'the question ended with its prompt');
        assert.equal(lastPanel().visible, false, 'its panel closed');
        assert.equal(AskUserRegistry.instance.hasPending(), false);
        assert.deepEqual(openAskPanelIds(), []);
        // The next question is not refused as "already pending".
        const next = ASK_USER_LIVE_TOOL.execute({ questions: ['Again?'] });
        await tick();
        lastPanel().webview.__receive({ type: 'submit', requestId: requestIdOf(lastPanel()), text: 'yes' });
        assert.equal(await next, 'yes');
        // A send that ends normally after its question was answered cancels nothing.
        await runAsAskOwner(async () => {
            const asked = ASK_USER_LIVE_TOOL.execute({ questions: ['Ok?'] });
            await tick();
            lastPanel().webview.__receive({ type: 'submit', requestId: requestIdOf(lastPanel()), text: 'ok' });
            assert.equal(await asked, 'ok');
        });
        assert.equal(AskUserRegistry.instance.hasPending(), false);
    });

    test('PC-3: the Agent SDK route with choices', async () => {
        const call = askUserWithChoices({ questions: ['[Flow] Next?'], choices: [{ id: 'ok', label: 'OK', kind: 'answer' }] });
        await tick();
        const panel = lastPanel();
        panel.webview.__receive({ type: 'choice', requestId: requestIdOf(panel), choiceId: 'gone' });
        assert.equal(await call, 'Unknown choice "gone".');
        assert.equal(panel.visible, false, 'the panel closes');

        let answer: string | undefined;
        await runAsAskOwner(async () => {
            void askUserWithChoices({ questions: ['[Flow] Next?'], choices: [{ id: 'ok', label: 'OK', kind: 'answer' }] }).then((a) => { answer = a; });
            await tick();
        });
        await tick();
        assert.equal(answer, ASK_OWNER_ENDED_NOTE);
        assert.equal(lastPanel().visible, false);
    });

    test('PC-4: a stale panel posting its answer closes', async () => {
        const call = ASK_USER_LIVE_TOOL.execute({ questions: ['Which?'] });
        await tick();
        const panel = lastPanel();
        const id = requestIdOf(panel);
        AskUserRegistry.instance.cancel('gone');
        assert.equal(await call, 'gone');
        assert.equal(panel.visible, false, 'closed when cancelled');
        stubbed.spies.clear();
        panel.webview.__receive({ type: 'submit', requestId: id, text: 'late' });
        assert.deepEqual(openAskPanelIds(), []);
        assert.ok(stubbed.spies.byMethod('window.showInformationMessage').some((c) => /already closed/.test(String(c.args[0]))));
    });

    test('PC-5: the MD Browser ask', async () => {
        const cleared: string[] = [];
        const closed: string[] = [];
        const deps: AskInMdBrowserDeps = {
            workspaceRoot: '/ws',
            exists: () => true,
            openWithBar: () => 'p1',
            clearBar: (panelId, _r, note) => { cleared.push(`${panelId}:${note}`); },
            closePanel: (panelId) => { closed.push(panelId); },
            deleteFile: () => undefined,
            now: () => 1000,
        };
        const slot = new MdBrowserAskSlot();
        let answer: Json;
        await runAsAskOwner(async () => {
            void askInMdBrowserImpl(deps, { filePath: 'a.md', buttons: [{ id: 'go', label: 'Go' }] }, slot).then((a) => { answer = JSON.parse(a); });
            await tick();
        });
        await tick();
        assert.equal(answer.cancelled, true);
        assert.equal(slot.hasOpen(), false);
        assert.deepEqual(cleared.map((c) => c.split(':')[0]), ['p1'], 'its bar cleared (the file is kept)');

        const slot2 = new MdBrowserAskSlot();
        await runAsAskOwner(async () => {
            void askInMdBrowserImpl(deps, { filePath: 'a.md', buttons: [{ id: 'go', label: 'Go' }], keepFile: false }, slot2);
            await tick();
        });
        assert.deepEqual(closed, ['p1'], 'an unkept file: its panel closed');

        const slot3 = new MdBrowserAskSlot();
        const outside = askInMdBrowserImpl(deps, { filePath: 'a.md', buttons: [{ id: 'go', label: 'Go' }] }, slot3);
        await runAsAskOwner(async () => { await tick(); });
        assert.equal(slot3.hasOpen(), true, 'asked outside any send: not ended by another send');
        slot3.cancel();
        await outside;
    });

    test('PC-6: the wiring', () => {
        const src = (...p: string[]): string => fs.readFileSync(path.join(EXT, 'src', ...p), 'utf8');
        assert.match(src('handlers', 'anthropic-handler.ts'), /async sendMessage\(options: AnthropicSendOptions\): Promise<AnthropicSendResult> \{\s*return runAsAskOwner\(\(\) => this\.sendMessageOwned\(options\)\);/);
        const registry = src('services', 'askUserRegistry.ts');
        assert.match(registry, /unregisterOwner: registerAskCancel\(\(\) => this\.cancelRequest\(pending\.requestId, ASK_OWNER_ENDED_NOTE\)\)/);
        assert.match(registry, /this\.active = undefined;\s+\/\/ clear first → guards re-entrancy\s+active\.unregisterOwner\(\);/);
        const md = src('tools', 'ask-in-md-browser-tool.ts');
        assert.match(md, /ask\.unregisterOwner = registerAskCancel\(\(\) => \{ if \(this\.open === ask\) \{ this\.finish\('cancel'\); \} \}\);/);
    });
});
