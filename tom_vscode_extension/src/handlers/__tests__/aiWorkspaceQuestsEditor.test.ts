/**
 * The AI Workspace Quests editor (handlers/aiWorkspaceQuestsEditor-handler.ts, media/aiWorkspaceQuests; vscimpb144).
 *
 *   WQ-1 the state: every quest with its tick (the list's) and short description; no list: nothing ticked; a
 *        listed quest that does not exist is named
 *   WQ-2 Save: the ticked quests become the list (the file created with its schema line), a missing listed quest
 *        kept; All quests removes the list
 *   WQ-3 the page: the rows, the ticks, Save posts the ticked quests, All quests and Open the file, the filter
 *   WQ-4 the command: in package.json, the Extension Tools catalogue, registered at activation
 */

import test, { after, describe } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { JSDOM } from 'jsdom';

import { installVscodeStub } from '../../tools/__tests__/_vscode-stub.js';
const stubbed = installVscodeStub({ workspaceFolders: [os.tmpdir()] });

import { aiWorkspaceQuestsState, saveAiWorkspaceQuests, type AiWorkspaceQuestsDeps } from '../aiWorkspaceQuestsEditor-handler.js';
import { AI_WORKSPACE_SCHEMA_LINE, aiWorkspaceFile, resolveWorkspaceQuests } from '../../utils/aiWorkspace.js';
import { EXTENSION_TOOLS } from '../../utils/extensionToolsCatalog.js';

const EXT = path.resolve(__dirname, '..', '..', '..');
const SANDBOX = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'ai-ws-editor-')));
after(() => { stubbed.restore(); fs.rmSync(SANDBOX, { recursive: true, force: true }); });
const WS = path.join(SANDBOX, 'tom_agent_container');
const AI = path.join(WS, '_ai');
const ALL = ['al_the_bear', 'tom_specs', 'vscode_extension'];
for (const q of ALL) { fs.mkdirSync(path.join(AI, 'quests', q), { recursive: true }); }

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Json = any;
const deps: AiWorkspaceQuestsDeps = {
    aiRoot: () => AI,
    workspace: () => 'tom_agent_container',
    allQuests: () => ALL,
    shortDescription: (q) => (q === 'tom_specs' ? 'The spec stack.\n\n**State:** busy.' : undefined),
    workspaceRoot: () => WS,
};

describe('the AI Workspace Quests editor', () => {
    test('WQ-1: the state', () => {
        let s = aiWorkspaceQuestsState(deps)!;
        assert.deepEqual([s.workspace, s.file, s.fileExists, s.listed], ['tom_agent_container', '_ai/workspaces/tom_agent_container.yaml', false, false]);
        assert.deepEqual(s.quests, [
            { id: 'al_the_bear', checked: false },
            { id: 'tom_specs', checked: false, shortDescription: 'The spec stack.\n\n**State:** busy.' },
            { id: 'vscode_extension', checked: false },
        ]);
        fs.mkdirSync(path.join(AI, 'workspaces'));
        fs.writeFileSync(aiWorkspaceFile(AI, 'tom_agent_container'), 'quests: [vscode_extension, gone]\n');
        s = aiWorkspaceQuestsState(deps)!;
        assert.equal(s.listed, true);
        assert.deepEqual(s.quests.filter((q) => q.checked).map((q) => q.id), ['vscode_extension']);
        assert.deepEqual(s.unknown, ['gone']);
        assert.equal(aiWorkspaceQuestsState({ ...deps, aiRoot: () => undefined }), undefined);
    });

    test('WQ-2: Save and All quests', () => {
        assert.equal(saveAiWorkspaceQuests(deps, ['tom_specs', 'vscode_extension']), 'Saved: tom_agent_container has 2 quest(s).');
        const text = fs.readFileSync(aiWorkspaceFile(AI, 'tom_agent_container'), 'utf8');
        assert.ok(text.startsWith(AI_WORKSPACE_SCHEMA_LINE), 'the schema line');
        assert.deepEqual(resolveWorkspaceQuests(AI, 'tom_agent_container', ALL).quests, ['tom_specs', 'vscode_extension']);
        assert.deepEqual(resolveWorkspaceQuests(AI, 'tom_agent_container', ALL).unknown, ['gone'], 'a missing listed quest is kept');
        fs.rmSync(aiWorkspaceFile(AI, 'tom_agent_container'));
        saveAiWorkspaceQuests(deps, ['al_the_bear']);
        assert.equal(fs.existsSync(aiWorkspaceFile(AI, 'tom_agent_container')), true, 'created');
        assert.equal(saveAiWorkspaceQuests(deps, undefined), 'Saved: tom_agent_container has every quest (no list).');
        assert.equal(resolveWorkspaceQuests(AI, 'tom_agent_container', ALL).source, 'all');
        assert.equal(saveAiWorkspaceQuests({ ...deps, workspace: () => undefined }, []), 'No _ai folder or no workspace folder: nothing saved.');
    });

    test('WQ-3: the page', () => {
        saveAiWorkspaceQuests(deps, ['vscode_extension']);
        const read = (f: string): string => fs.readFileSync(path.join(EXT, 'media', 'aiWorkspaceQuests', f), 'utf8');
        const html = read('index.html').replace(/<script[\s\S]*?<\/script>/g, '').replace(/\{\{[a-zA-Z]+\}\}/g, '');
        const w = new JSDOM(html, { runScripts: 'outside-only' }).window as Json;
        const posted: Json[] = [];
        w.acquireVsCodeApi = () => ({ postMessage: (m: Json) => posted.push(m) });
        w.__INIT__ = aiWorkspaceQuestsState(deps);
        w.eval(read('main.js'));
        const $ = (id: string): Json => w.document.getElementById(id);
        assert.equal($('wqTitle').textContent, 'AI Workspace Quests — tom_agent_container');
        assert.match($('wqIntro').textContent, /1 of 3 ticked/);
        const rows = (): Json[] => [...w.document.querySelectorAll('#wqRows tr')];
        assert.equal(rows().length, 3);
        assert.equal(rows()[1].querySelector('.wq-desc').textContent, 'The spec stack.');
        const tick = rows()[1].querySelector('.wq-tick');
        tick.checked = true;
        tick.dispatchEvent(new w.Event('change', { bubbles: true }));
        $('wqSave').click();
        assert.equal(JSON.stringify(posted.at(-1)), '{"type":"save","quests":["tom_specs","vscode_extension"]}');
        $('wqAll').click();
        $('wqOpen').click();
        assert.deepEqual(posted.slice(-2).map((m) => m.type), ['allQuests', 'openFile']);
        $('wqFilter').value = 'spec';
        $('wqFilter').dispatchEvent(new w.Event('input'));
        assert.equal(rows().length, 1, 'filtered by id and description');
        w.dispatchEvent(new w.MessageEvent('message', { data: { type: 'state', state: { ...aiWorkspaceQuestsState(deps, 'Saved.'), listed: false } } }));
        assert.match($('wqIntro').textContent, /has no quest list/);
        assert.equal($('wqMessage').textContent, 'Saved.');
        w.close();
    });

    test('WQ-4: the command', () => {
        const pkg = JSON.parse(fs.readFileSync(path.join(EXT, 'package.json'), 'utf8'));
        assert.ok(pkg.contributes.commands.some((c: Json) => c.command === 'tomAi.editor.aiWorkspaceQuests' && c.title === '@T: Open AI Workspace Quests'));
        assert.equal(EXTENSION_TOOLS.find((t) => t.id === 'aiWorkspaceQuests')?.command, 'tomAi.editor.aiWorkspaceQuests');
        assert.match(fs.readFileSync(path.join(EXT, 'src', 'extension.ts'), 'utf8'), /registerAiWorkspaceQuestsEditor\(context\);/);
    });
});
