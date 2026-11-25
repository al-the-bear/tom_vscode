/**
 * Night mode (src/services/nightMode.ts; the Prompt Queue headline's moon button, the `night_mode` aspect in
 * _ai/aspect_guidelines/night_mode/).
 *
 *   NM-1 the window-wide chat variable `night-mode`: off at first, on after setNightMode, read by placeholders and
 *        conditions (variableLookup) whatever the process run; the change is announced once; the window's state keeps it
 *   NM-2 another window's switch: the window request `setNightMode` is carried out by the handler
 *   NM-3 the real aspect: `night_mode` (Interaction level) loads, its choice `on` is the default and is sent only
 *        while `night-mode` is on, and `prompt.night` follows it; its text forbids the asking tools and names the
 *        decision record (`ND-…`, `Answer (night mode, agent)`)
 */

/* eslint-disable @typescript-eslint/naming-convention */
import test, { after, describe } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

const SANDBOX = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'night-mode-')));
const WS = path.join(SANDBOX, 'ws');
const HOME = path.join(SANDBOX, 'home');
const QUEST = 'q1';
const EXT_ROOT = path.resolve(__dirname, '..', '..', '..');
for (const [rel, text] of [[`_ai/quests/${QUEST}/overview.${QUEST}.md`, '# Q1\n'], ['.tom/tom_vscode_extension.json', '{}\n']]) {
    const abs = path.join(WS, rel);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, text);
}
fs.mkdirSync(HOME, { recursive: true });
process.env.HOME = HOME;
process.env.USERPROFILE = HOME;

import { installVscodeStub } from './_vscode-stub.js';
const vscodeStub = installVscodeStub({ workspaceFolders: [WS] });
(vscodeStub.stub.workspace as Record<string, unknown>).workspaceFile = { fsPath: path.join(WS, `${QUEST}.code-workspace`), scheme: 'file' };

import { ChatVariablesStore } from '../../managers/chatVariablesStore.js';
import { TimerEngine } from '../../managers/timerEngine.js';
import { PromptQueueManager } from '../../managers/promptQueueManager.js';
import { TomAiConfiguration } from '../../utils/tomAiConfiguration.js';
import { setExtensionPath } from '../../handlers/handler_shared.js';
import { initNightMode, isNightMode, onNightModeChange, setNightMode, NIGHT_MODE_VARIABLE } from '../../services/nightMode.js';
import { configureWindowRequests, sendWindowRequest, takeWindowRequests } from '../../services/windowRequests.js';
import { variableLookup } from '../../utils/variableResolver.js';
import { conditionEvaluator, readAspectSections } from '../../services/aspectGuidelinesStore.js';
import { resolveAspects } from '../../utils/aspectGuidelines.js';
import { promptFacts } from '../../services/aspectPromptFacts.js';

const subscriptions: Array<{ dispose(): void }> = [];
(function start(): void {
    const storage = path.join(SANDBOX, 'storage');
    fs.mkdirSync(storage, { recursive: true });
    const memento = (): unknown => {
        const values = new Map<string, unknown>();
        return { get: (k: string, d?: unknown) => values.has(k) ? values.get(k) : d, update: async (k: string, v: unknown) => { values.set(k, v); }, keys: () => [...values.keys()], setKeysForSync: () => undefined };
    };
    const context = {
        subscriptions, extensionPath: EXT_ROOT, extensionUri: { fsPath: EXT_ROOT, scheme: 'file' },
        globalStorageUri: { fsPath: storage, scheme: 'file' }, storageUri: { fsPath: storage, scheme: 'file' },
        logUri: { fsPath: storage, scheme: 'file' }, globalStoragePath: storage, storagePath: storage, logPath: storage,
        globalState: memento(), workspaceState: memento(), asAbsolutePath: (rel: string) => path.join(EXT_ROOT, rel),
    } as never;
    setExtensionPath(EXT_ROOT);
    TomAiConfiguration.init(context);
    ChatVariablesStore.init(context);
    TimerEngine.init(context);
    PromptQueueManager.init(context);
    initNightMode(context);
})();
after(() => {
    for (const stop of [() => PromptQueueManager.instance.dispose(), () => TimerEngine.instance.dispose()]) {
        try { stop(); } catch { /* not started */ }
    }
    for (const s of subscriptions.splice(0)) { try { s.dispose(); } catch { /* already gone */ } }
    vscodeStub.restore();
    fs.rmSync(SANDBOX, { recursive: true, force: true });
});


const AI = path.resolve(EXT_ROOT, '..', '..', '..', '_ai');

describe('night mode', () => {
    test('NM-1: the window-wide chat variable', async () => {
        assert.equal(isNightMode(), false);
        assert.equal(variableLookup()(NIGHT_MODE_VARIABLE), 'off');
        const seen: boolean[] = [];
        const sub = onNightModeChange((on) => seen.push(on));
        await setNightMode(true);
        await setNightMode(true);
        assert.equal(isNightMode(), true);
        assert.equal(variableLookup()(NIGHT_MODE_VARIABLE), 'on', 'placeholders and conditions read it');
        assert.equal(ChatVariablesStore.instance.getRaw(NIGHT_MODE_VARIABLE), 'on', 'the Chat Variables panel shows it');
        ChatVariablesStore.instance.setWindowRun('another-run');
        assert.equal(variableLookup()(NIGHT_MODE_VARIABLE), 'on', 'whatever the run');
        ChatVariablesStore.instance.setWindowRun('default');
        await setNightMode(false);
        assert.deepEqual(seen, [true, false], 'announced once per change');
        sub.dispose();
    });

    test('NM-2: another window switches it', async () => {
        configureWindowRequests(path.join(SANDBOX, 'windows'), 'win-a');
        try {
            assert.ok(sendWindowRequest('win-a', { type: 'setNightMode', on: true }));
            const turned: boolean[] = [];
            const done = takeWindowRequests({ answerAsk: () => false, resumeRun: () => false, setNightMode: (on) => { turned.push(on); void setNightMode(on); return true; } });
            assert.equal(done, 1);
            assert.deepEqual(turned, [true]);
            await new Promise((r) => setTimeout(r, 10));
            assert.equal(isNightMode(), true);
            await setNightMode(false);
        } finally { configureWindowRequests(undefined, undefined); }
    });

    test('NM-3: the aspect', () => {
        const { sections } = readAspectSections(path.join(AI, 'aspect_guidelines'));
        const night = sections.find((s) => s.id === 'night_mode');
        assert.ok(night, 'the night_mode aspect loads');
        assert.equal(night.defaultOption, 'on');
        assert.equal(night.options.find((o) => o.name === 'on')?.when, 'night-mode == "on"');
        const text = night.options.find((o) => o.name === 'on')?.text ?? '';
        assert.match(text, /Do not call `tomAi_askUser`, `tomAi_askUserPicker` or `tomAi_askInMdBrowser`/);
        assert.match(text, /Do not file `decision-needed` todos/);
        assert.match(text, /\*\*Answer \(night mode, agent\):\*\*/);
        assert.match(text, /Stop only for what cannot be undone/);
        const probe = { id: 'probe', name: 'probe', label: 'probe', placement: 'system' as const, options: [{ name: 'x', text: 'X', when: 'prompt.night == "on"' }] };
        const all = [night, probe];
        const sendFor = (value: string) => {
            const lookup = (n: string) => (n === NIGHT_MODE_VARIABLE ? value : undefined);
            return resolveAspects(all, { window: { probe: 'x' } }, { evaluate: conditionEvaluator(all, { window: { probe: 'x' } }, { facts: promptFacts(), lookup }) }).sections;
        };
        assert.deepEqual(sendFor('on').map((s) => s.options), [['on'], ['x']], 'on: the night text, and prompt.night is on');
        assert.deepEqual(sendFor('off').map((s) => s.options), [[], []], 'off: nothing');
    });
});
