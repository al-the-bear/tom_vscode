/**
 * The @CHAT subpanels' role dropdown and guideline buttons (gsel6; utils/chatPanelRole.ts, chatPanel-handler.ts,
 * media/chatPanel/main.js) through the real chat panel provider, queue and picker writers under the vscode stub.
 * `_ai/roles/` has `reviewer` and `writer`; `_ai/aspect_guidelines/` has `answer` (default `full`, options `brief`,
 * `full`) and `night` (default `off`, options `on`, `off`).
 *
 *   CG-1 the rules: the role key per quest; the panel's role while the role exists, else Default role (''); the
 *        send's role source (item role and the panel's choices) only with a role; what a queued send carries
 *   CG-2 the host: setChatRole keeps the role per window and quest, a deleted role is forgotten; `chatAspects`
 *        carries the roles, the panel's role, the picker state and each subpanel's run and own choices; a picker
 *        choice at level `chat` sets the subpanel's sticky choices (Don't add, Remove) and posts fresh data
 *   CG-3 an ANTHROPIC/LLM send runs as the panel's role (the item role, ahead of the chat variable, which stays)
 *        with the panel's choices at the item level; Default role leaves the role to the chat variable; a Copilot
 *        send carries the Copilot subpanel's choices
 *   CG-4 queued sends carry them: Save to Queue with the panel's target (role and choices; Copilot choices only),
 *        a send into a busy session queued; plain Save to Queue carries neither
 *   CG-5 the webview: the role dropdown (Run default, the roles, the panel's selected; a change posts
 *        setChatRole) in ANTHROPIC/LLM only; a guideline button in both subpanels (dot when the panel chose,
 *        the effective selection on hover, no list); its popup posts aspectChoose at level chat with the
 *        subpanel; the profile, template, session, Run and role dropdowns unlabelled and compact; No template;
 *        the role editor icon posts openRoleEditor; the page loads the picker's script and style
 */

/* eslint-disable @typescript-eslint/naming-convention -- chat-variable names */
import test, { after, describe } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'fs';
import * as path from 'path';
import { JSDOM } from 'jsdom';

const EXT = path.resolve(__dirname, '..', '..', '..');
const SANDBOX = fs.realpathSync(fs.mkdtempSync(path.join(EXT, '..', '..', '..', 'ztmp', 'vscode_extension_261121_gsel6_chatrole-')));
const WS = path.join(SANDBOX, 'ws');
const HOME = path.join(SANDBOX, 'home');
const QUEST = 'q1';
function put(rel: string, text: string): void {
    const abs = path.join(WS, rel);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, text);
}
put('.tom/tom_root.yaml', 'version: 1\n');
put('.tom/tom_vscode_extension.json', '{}\n');
put(`_ai/quests/${QUEST}/overview.${QUEST}.md`, '# Q1\n');
put('_ai/roles/reviewer/role.md', '# Reviewer\n');
put('_ai/roles/writer/role.md', '# Writer\n');
put('_ai/aspect_guidelines/answer/section.yaml', 'name: Answer\ndefault: full\noptions: [brief, full]\n');
put('_ai/aspect_guidelines/answer/brief.md', 'ANSWER-BRIEF\n');
put('_ai/aspect_guidelines/answer/full.md', 'ANSWER-FULL\n');
put('_ai/aspect_guidelines/night/section.yaml', 'name: Night\nplacement: user\ndefault: off\noptions: [on, off]\n');
put('_ai/aspect_guidelines/night/on.md', 'NIGHT-ON\n');
put('_ai/aspect_guidelines/night/off.md', 'NIGHT-OFF\n');
fs.mkdirSync(HOME, { recursive: true });
process.env.HOME = HOME;
process.env.USERPROFILE = HOME;

import { installVscodeStub } from '../../tools/__tests__/_vscode-stub.js';
const vscodeStub = installVscodeStub({ workspaceFolders: [WS] });
(vscodeStub.stub.workspace as Record<string, unknown>).workspaceFile = { fsPath: path.join(WS, `${QUEST}.code-workspace`), scheme: 'file' };
const executed: Array<[string, unknown]> = [];
(vscodeStub.stub.commands as Record<string, unknown>).executeCommand = async (id: string, arg?: unknown) => { executed.push([id, arg]); return undefined; };

import { ChatVariablesStore } from '../../managers/chatVariablesStore.js';
import { ProcessStateStore } from '../../managers/processStateStore.js';
import { ReminderSystem } from '../../managers/reminderSystem.js';
import { TimerEngine } from '../../managers/timerEngine.js';
import { PromptQueueManager } from '../../managers/promptQueueManager.js';
import { TomAiConfiguration } from '../../utils/tomAiConfiguration.js';
import { TrailService } from '../../services/trailService.js';
import { setExtensionPath } from '../handler_shared.js';
import { registerChatPanel } from '../chatPanel-handler.js';
import { AnthropicHandler } from '../anthropic-handler.js';
import { __setBusySessionPickForTests } from '../busySessionChoice.js';
import { handleAspectPickerMessage } from '../aspectPickerMessages.js';
import { livePromptRole } from '../../services/queueRoleContext.js';
import { chatPanelChoices, setChatPanelChoices } from '../../services/aspectChoiceLevels.js';
import { chatQueueItemFields, chatRoleKey, chatRoleSource, effectiveChatRole } from '../../utils/chatPanelRole.js';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Json = any;
const memento = (): unknown => {
    const values = new Map<string, unknown>();
    return { get: (k: string, d?: unknown) => values.has(k) ? values.get(k) : d, update: async (k: string, v: unknown) => { if (v === undefined) { values.delete(k); } else { values.set(k, v); } }, keys: () => [...values.keys()], setKeysForSync: () => undefined };
};
const subscriptions: Array<{ dispose?: () => unknown }> = [];
const storage = path.join(SANDBOX, 'storage');
fs.mkdirSync(storage, { recursive: true });
const context = {
    subscriptions, extensionPath: EXT, extensionUri: { fsPath: EXT, scheme: 'file' },
    globalStorageUri: { fsPath: storage, scheme: 'file' }, storageUri: { fsPath: storage, scheme: 'file' }, logUri: { fsPath: storage, scheme: 'file' },
    globalStoragePath: storage, storagePath: storage, logPath: storage, globalState: memento(), workspaceState: memento(),
    asAbsolutePath: (rel: string) => path.join(EXT, rel),
} as never;
setExtensionPath(EXT);
TomAiConfiguration.init(context);
TrailService.init(context);
ChatVariablesStore.init(context);
ProcessStateStore.init(context);
ReminderSystem.init(context);
TimerEngine.init(context);
PromptQueueManager.init(context);
registerChatPanel(context);
after(() => {
    for (const stop of [() => PromptQueueManager.instance.dispose(), () => TimerEngine.instance.dispose(), () => ReminderSystem.instance.dispose()]) {
        try { stop(); } catch { /* not started */ }
    }
    for (const s of subscriptions.splice(0)) { try { s.dispose?.(); } catch { /* already gone */ } }
    vscodeStub.restore();
    fs.rmSync(SANDBOX, { recursive: true, force: true });
});

const provider = (): Json => subscriptions.find((d) => d && (d as { constructor?: { name?: string } }).constructor?.name === 'ChatPanelViewProvider');
const posted: Json[] = [];
function attachView(): void {
    const view = { webview: { postMessage: async (m: Json) => { posted.push(JSON.parse(JSON.stringify(m))); return true; } }, onDidDispose: () => ({ dispose: () => undefined }) };
    provider()._view = view;
}
const lastPosted = (type: string): Json => posted.filter((m) => m.type === type).at(-1);
const queue = (): PromptQueueManager => PromptQueueManager.instance;
const roleKey = chatRoleKey(QUEST);
const setRole = (role: string | undefined): Promise<void> => (context as Json).workspaceState.update(roleKey, role);

describe('@CHAT: role dropdown and guideline buttons', () => {
    test('CG-1: the rules', () => {
        assert.equal(chatRoleKey('q9'), 'tomAi.chatPanel.role.q9');
        assert.equal(effectiveChatRole('reviewer', ['reviewer', 'writer']), 'reviewer');
        assert.equal(effectiveChatRole('gone', ['reviewer']), '', 'a deleted role: Default role');
        assert.equal(effectiveChatRole(undefined, ['reviewer']), '');
        assert.equal(effectiveChatRole('default', ['default']), '', 'default is Default role');
        assert.equal(chatRoleSource(''), undefined, 'Default role: no source');
        assert.deepEqual(chatRoleSource('reviewer'), { itemRole: 'reviewer' });
        assert.deepEqual(chatRoleSource('reviewer', { night: 'on' }), { itemRole: 'reviewer', itemGuidelines: { night: 'on' } });
        assert.deepEqual(chatQueueItemFields('', undefined), {});
        assert.deepEqual(chatQueueItemFields('writer', {}), { role: 'writer' });
        assert.deepEqual(chatQueueItemFields('', { answer: 'brief' }), { guidelines: { answer: 'brief' } });
    });

    test('CG-2: the host', async () => {
        await ProcessStateStore.ready;
        queue().autoSendEnabled = false;
        attachView();
        await setRole('reviewer');
        assert.equal(provider()._chatRole(), 'reviewer');
        await setRole('gone');
        assert.equal(provider()._chatRole(), '', 'a deleted role is Default role');
        await new Promise((r) => setTimeout(r, 5));
        assert.equal((context as Json).workspaceState.get(roleKey), undefined, 'and forgotten');
        await setRole('reviewer');
        setChatPanelChoices('anthropic', undefined);
        setChatPanelChoices('copilot', undefined);
        provider().postChatAspects();
        const msg = lastPosted('chatAspects');
        assert.deepEqual(msg.roles, ['reviewer', 'writer']);
        assert.equal(msg.role, 'reviewer');
        assert.deepEqual(msg.aspects.sections.map((s: Json) => s.id), ['answer', 'night']);
        assert.deepEqual(msg.panels, { anthropic: { run: {}, item: {} }, copilot: { run: {}, item: {} } });

        // A picker choice at level chat: the subpanel's sticky choices, then fresh data.
        const before = posted.length;
        assert.deepEqual(await handleAspectPickerMessage({ type: 'aspectChoose', level: 'chat', panel: 'anthropic', section: 'night', value: 'on' }), { handled: true, changed: true });
        assert.deepEqual(await handleAspectPickerMessage({ type: 'aspectChoose', level: 'chat', panel: 'logs', section: 'night', value: 'on' }), { handled: true, changed: false }, 'an unknown panel is refused');
        await handleAspectPickerMessage({ type: 'aspectChoose', level: 'chat', panel: 'anthropic', section: 'answer', value: 'remove' });
        await handleAspectPickerMessage({ type: 'aspectChoose', level: 'chat', panel: 'copilot', section: 'answer', value: 'brief' });
        assert.deepEqual(chatPanelChoices('anthropic'), { night: 'on', answer: 'remove' });
        assert.deepEqual(chatPanelChoices('copilot'), { answer: 'brief' });
        await handleAspectPickerMessage({ type: 'aspectChoose', level: 'chat', panel: 'anthropic', section: 'answer', value: '' });
        assert.deepEqual(chatPanelChoices('anthropic'), { night: 'on' }, 'Don\'t add drops the panel\'s choice');
        assert.ok(posted.slice(before).some((m) => m.type === 'chatAspects'), 'the panel is redrawn');
        assert.deepEqual(lastPosted('chatAspects').panels.anthropic.item, { night: 'on' });
        assert.deepEqual(lastPosted('chatAspects').panels.copilot.item, { answer: 'brief' });

        // The handler's messages.
        const src = fs.readFileSync(path.join(EXT, 'src', 'handlers', 'chatPanel-handler.ts'), 'utf8');
        assert.match(src, /case 'setChatRole':\n\s+await this\._context\.workspaceState\.update\(chatRoleKey\(WsPaths\.getWorkspaceQuestId\(\)\)/);
        assert.match(src, /case 'aspectChoose':\n\s+case 'aspectEditSections':\n[^\n]*\n\s+await handleAspectPickerMessage\(message\);/);
        assert.match(src, /case 'openRoleEditor': \{[\s\S]{0,200}executeCommand\('tomAi\.editor\.roles'/);
    });

    test('CG-3: a send carries the panel\'s role and choices', async () => {
        const chat = ChatVariablesStore.instance;
        chat.set('role', 'writer', 'user');
        const seen: Json[] = [];
        const handler = AnthropicHandler.instance as Json;
        const original = handler.sendMessage;
        handler.sendMessage = async (opts: Json) => {
            seen.push({ role: livePromptRole(), item: opts.aspectGuidelineChoices?.item });
            return { text: 'done', turnsUsed: 1, toolCallCount: 0 };
        };
        try {
            await setRole('reviewer');
            await provider()._handleSendAnthropic('hello', '', 'claude-test-model', '', undefined, true);
            await setRole(undefined);
            await provider()._handleSendAnthropic('hello again', '', 'claude-test-model', '', undefined, true);
        } finally { handler.sendMessage = original; }
        assert.equal(seen.length, 2, 'both sends ran');
        assert.deepEqual(seen[0], { role: { role: 'reviewer', from: 'item' }, item: { night: 'on' } }, 'the panel\'s role, its choices');
        assert.equal(seen[1].role.role, 'writer', 'Default role: the chat variable');
        assert.notEqual(seen[1].role.from, 'item');
        assert.equal(chat.getRaw('role'), 'writer', 'the run\'s chat variable is untouched');
        // Copilot: its own subpanel's choices (no role).
        const src = fs.readFileSync(path.join(EXT, 'src', 'handlers', 'chatPanel-handler.ts'), 'utf8');
        assert.match(src, /chatSendAspectChoices\('copilot', this\._chatRun\('copilot'\)\)/);
        assert.match(src, /runWithQueueRole\(chatRoleSource\(this\._chatRole\(\), chatPanelChoices\('anthropic'\)\), \(\) => AnthropicHandler\.instance\.sendMessage\(/);
    });

    test('CG-4: queued sends carry them', async () => {
        for (const i of [...queue().items]) { queue().remove(i.id); }
        await setRole('reviewer');
        await provider()._handleAddToQueue('anthropic with the panel', '', '1', 0, { transport: 'anthropic', usePanelTarget: true, anthropicProfileId: 'p' }, { section: 'anthropic' });
        const a = queue().items.find((i) => i.originalText === 'anthropic with the panel')!;
        assert.deepEqual([a.role, a.guidelines], ['reviewer', { night: 'on' }]);
        await provider()._handleAddToQueue('copilot with the panel', '', '1', 0, { usePanelTarget: true }, { section: 'copilot' });
        const c = queue().items.find((i) => i.originalText === 'copilot with the panel')!;
        assert.deepEqual([c.role, c.guidelines], [undefined, { answer: 'brief' }], 'Copilot: no role');
        await provider()._handleAddToQueue('plain', '', '1', 0, { transport: 'anthropic' }, { section: 'anthropic' });
        const p = queue().items.find((i) => i.originalText === 'plain')!;
        assert.deepEqual([p.role, p.guidelines], [undefined, undefined], 'plain Save to Queue: the queue\'s own settings');

        // A send into a busy session, queued next.
        const q = queue() as Json;
        const holderOf = q.sessionHolder.bind(q);
        const busy = provider()._panelSession();
        q.sessionHolder = (s: string) => (s === busy ? { kind: 'queue', label: 'other' } : holderOf(s));
        __setBusySessionPickForTests(async (choices) => choices.find((x) => x.kind === 'next') ?? choices.find((x) => x.kind !== 'session' && x.kind !== 'update'));
        try {
            await provider()._handleSendAnthropic('busy send', '', 'claude-test-model', '', undefined, true);
        } finally { q.sessionHolder = holderOf; }
        const b = queue().items.find((i) => i.originalText === 'busy send');
        assert.ok(b, 'queued');
        assert.deepEqual([b!.role, b!.guidelines], ['reviewer', { night: 'on' }]);
        for (const i of [...queue().items]) { queue().remove(i.id); }
    });

    test('CG-5: the webview', async () => {
        const html = fs.readFileSync(path.join(EXT, 'media', 'chatPanel', 'index.html'), 'utf8');
        assert.match(html, /\{\{sharedUri\}\}\/aspectPicker\.css/);
        assert.ok(html.indexOf('{{sharedUri}}/aspectPicker.js') >= 0 && html.indexOf('{{sharedUri}}/aspectPicker.js') < html.indexOf('{{baseUri}}/main.js'), 'the picker before main.js');
        const w = new JSDOM(html.replace(/<script[\s\S]*?<\/script>/g, ''), { runScripts: 'outside-only' }).window as Json;
        try {
            const sent: Json[] = [];
            w.acquireVsCodeApi = () => ({ postMessage: (m: Json) => sent.push(JSON.parse(JSON.stringify(m))), setState: () => undefined, getState: () => ({ expanded: ['anthropic', 'copilot'], pinned: [] }) });
            w.__INIT__ = {};
            w.eval(fs.readFileSync(path.join(EXT, 'media', 'shared', 'aspectPicker.js'), 'utf8'));
            w.eval(fs.readFileSync(path.join(EXT, 'media', 'chatPanel', 'main.js'), 'utf8'));
            const $ = (id: string): Json => w.document.getElementById(id);
            assert.ok(sent.some((m) => m.type === 'getChatAspects'), 'it asks for the data');
            // The dropdowns: unlabelled and compact; No template.
            for (const id of ['anthropic-profile', 'anthropic-userMessage', 'anthropic-role']) {
                assert.ok($(id).classList.contains('chat-compact-select'), `${id} compact`);
                assert.notEqual($(id).previousElementSibling?.tagName, 'LABEL', `${id} unlabelled`);
                assert.ok($(id).title, `${id} named by its tooltip`);
            }
            assert.ok($('anthropic-run').classList.contains('chat-link'), 'the run: a link');
            assert.ok($('anthropic-session-name').closest('.chat-link'), 'the session: a link');
            // Run default first (the panel's run's template), then No template.
            assert.deepEqual([...$('anthropic-userMessage').options].slice(0, 2).map((o: Json) => [o.value, o.textContent]), [['__run_default__', 'Run default (no template)'], ['', 'No template']]);
            assert.deepEqual([...$('copilot-template').options].slice(0, 2).map((o: Json) => [o.value, o.textContent]), [['__run_default__', 'Run default (no template)'], ['', 'No template']]);
            const toolbar = $('anthropic-role').parentElement;
            assert.equal([...toolbar.querySelectorAll('label')].filter((l: Json) => /Profile|User Prompt/.test(l.textContent)).length, 0, 'no Profile / User Prompt labels');
            const css = fs.readFileSync(path.join(EXT, 'media', 'chatPanel', 'style.css'), 'utf8');
            assert.match(css, /\.toolbar select\.chat-compact-select \{ min-width: 36px; max-width: 72px; \}/, '60% of 60–120px');
            assert.match(css, /\.session-run-lines \{ display: inline-flex; flex-direction: column;/, 'session above run');
            // The role dropdown: ANTHROPIC/LLM only.
            assert.equal($('copilot-role'), null);
            w.dispatchEvent(new w.MessageEvent('message', { data: {
                type: 'chatAspects', roles: ['reviewer', 'writer'], role: 'reviewer',
                aspects: {
                    sections: [
                        { id: 'answer', label: 'Answer', name: 'Answer', placement: 'system', defaultOption: 'full', options: ['brief', 'full'] },
                        { id: 'night', label: 'Night', name: 'Night', placement: 'user', defaultOption: 'off', options: ['on', 'off'] },
                    ],
                    problems: [], roles: {},
                },
                panels: { anthropic: { run: {}, item: { night: 'on' } }, copilot: { run: {}, item: {} } },
            } }));
            assert.deepEqual([...$('anthropic-role').options].map((o: Json) => o.textContent), ['Run default', 'reviewer', 'writer']);
            assert.equal($('anthropic-role').value, 'reviewer');
            $('anthropic-role').value = 'writer';
            $('anthropic-role').dispatchEvent(new w.Event('change'));
            assert.deepEqual(sent.filter((m) => m.type === 'setChatRole').at(-1), { type: 'setChatRole', role: 'writer' });
            // The guideline buttons: both subpanels, a dot when the panel chose, hover help only.
            const aBtn = $('anthropic-aspects-btn');
            const cBtn = $('copilot-aspects-btn');
            assert.ok(aBtn && cBtn, 'a guideline button in each subpanel');
            assert.ok(aBtn.querySelector('.tom-aspect-dot'), 'a dot: the panel chose');
            assert.equal(cBtn.querySelector('.tom-aspect-dot'), null);
            assert.match(aBtn.title, /^Guidelines of this panel's sends: Answer: full · Night: on\nChosen here: Night: on/);
            assert.equal($('anthropic-aspects-slot').textContent.trim(), '', 'no list beside it');
            // Its popup posts the choice at level chat with its subpanel.
            aBtn.click();
            const popup = $('tomAspectPopup');
            assert.ok(popup, 'the popup opens');
            popup.querySelector('.tom-aspect-option[data-section="answer"][data-value="brief"]').click();
            assert.deepEqual(sent.filter((m) => m.type === 'aspectChoose').at(-1), { type: 'aspectChoose', level: 'chat', panel: 'anthropic', section: 'answer', value: 'brief' });
            $('copilot-aspects-btn').click();
            $('tomAspectPopup').querySelector('.tom-aspect-option[data-section="night"][data-value="remove"]').click();
            assert.deepEqual(sent.filter((m) => m.type === 'aspectChoose').at(-1), { type: 'aspectChoose', level: 'chat', panel: 'copilot', section: 'night', value: 'remove' });
            // The role editor icon.
            $('anthropic-role-editor-btn').click();
            assert.ok(sent.some((m) => m.type === 'openRoleEditor'));
        } finally { w.close(); }
        // The host opens the role editor on the panel's role.
        executed.length = 0;
        await setRole('reviewer');
        const src = fs.readFileSync(path.join(EXT, 'src', 'handlers', 'chatPanel-handler.ts'), 'utf8');
        assert.match(src, /executeCommand\('tomAi\.editor\.roles', role \? \{ role \} : undefined\)/);
    });
});
