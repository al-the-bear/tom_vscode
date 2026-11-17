/**
 * AI workspaces (utils/aiWorkspace.ts, vscimpb144): `_ai/workspaces/<workspace>.yaml` lists a workspace's quests.
 *
 *   AW-1 the name: the window's root folder name (not a symlink target's, not the quest)
 *   AW-2 the quests: no file / no list = every quest; a list = its quests that exist, in its order, the missing
 *        ones reported; two workspaces may share a quest; recorded quests when there is no list; an unreadable
 *        file is reported and counts as no list
 *   AW-3 writing: a new file with the schema line; other keys and comments kept; no list = every quest
 *   AW-4 the short description: the file's text after its title
 */

import test, { after, describe } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import {
    AI_WORKSPACE_SCHEMA_LINE, aiWorkspaceFile, aiWorkspaceName, readQuestShortDescription, resolveWorkspaceQuests, writeAiWorkspaceQuests,
} from '../aiWorkspace';

const SANDBOX = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'ai-workspace-')));
after(() => fs.rmSync(SANDBOX, { recursive: true, force: true }));
const AI = path.join(SANDBOX, '_ai');
const ALL = ['al_the_bear', 'tom_specs', 'vscode_extension', 'webwork'];
for (const q of ALL) { fs.mkdirSync(path.join(AI, 'quests', q), { recursive: true }); }

describe('AI workspaces', () => {
    test('AW-1: the name', () => {
        assert.equal(aiWorkspaceName('/Users/x/al_the_bear/inhouse/tom_agent_container'), 'tom_agent_container');
        assert.equal(aiWorkspaceName('/Users/x/al_the_bear/inhouse/tom_agent_container/'), 'tom_agent_container');
        assert.equal(aiWorkspaceFile(AI, 'tom_agent_container'), path.join(AI, 'workspaces', 'tom_agent_container.yaml'));
        // A symlinked _ai: the window's folder names the workspace, wherever the _ai link points.
        const ws = path.join(SANDBOX, 'tom_agent_container');
        fs.mkdirSync(ws);
        fs.symlinkSync(AI, path.join(ws, '_ai'));
        assert.equal(aiWorkspaceName(ws), 'tom_agent_container');
    });

    test('AW-2: the quests', () => {
        let r = resolveWorkspaceQuests(AI, 'nobody', ALL);
        assert.deepEqual([r.source, r.fileExists, r.quests, r.unknown], ['all', false, ALL, []], 'no file: every quest');
        fs.mkdirSync(path.join(AI, 'workspaces'), { recursive: true });
        fs.writeFileSync(aiWorkspaceFile(AI, 'tac'), `${AI_WORKSPACE_SCHEMA_LINE}\nquests:\n  - vscode_extension\n  - gone_quest\n  - al_the_bear\n  - vscode_extension\n`);
        r = resolveWorkspaceQuests(AI, 'tac', ALL);
        assert.deepEqual([r.source, r.quests, r.unknown], ['list', ['vscode_extension', 'al_the_bear'], ['gone_quest']], 'the list\'s order, the missing reported, no duplicates');
        fs.writeFileSync(aiWorkspaceFile(AI, 'atb'), 'quests: [al_the_bear, webwork]\n');
        assert.deepEqual(resolveWorkspaceQuests(AI, 'atb', ALL).quests, ['al_the_bear', 'webwork'], 'al_the_bear in two workspaces');
        fs.writeFileSync(aiWorkspaceFile(AI, 'nolist'), 'other: 1\n');
        assert.equal(resolveWorkspaceQuests(AI, 'nolist', ALL).source, 'all', 'a file without a list: every quest');
        assert.deepEqual(resolveWorkspaceQuests(AI, 'nolist', ALL, ['webwork', 'gone']).quests, ['webwork'], 'the recorded quests when there is no list');
        assert.equal(resolveWorkspaceQuests(AI, 'nolist', ALL, ['webwork']).source, 'recorded');
        assert.equal(resolveWorkspaceQuests(AI, 'tac', ALL, ['webwork']).source, 'list', 'the list wins over the record');
        fs.writeFileSync(aiWorkspaceFile(AI, 'broken'), 'quests: [a\n');
        r = resolveWorkspaceQuests(AI, 'broken', ALL);
        assert.equal(r.source, 'all');
        assert.ok(r.error);
        fs.writeFileSync(aiWorkspaceFile(AI, 'wrong'), 'quests: vscode_extension\n');
        assert.equal(resolveWorkspaceQuests(AI, 'wrong', ALL).error, '`quests` is not a list');
    });

    test('AW-3: writing', () => {
        const file = writeAiWorkspaceQuests(AI, 'fresh', ['tom_specs', 'vscode_extension']);
        assert.equal(fs.readFileSync(file, 'utf8'), `${AI_WORKSPACE_SCHEMA_LINE}\nquests:\n  - tom_specs\n  - vscode_extension\n`);
        fs.writeFileSync(file, `${AI_WORKSPACE_SCHEMA_LINE}\n# my note\nquests:\n  - tom_specs\nlater: keep me\n`);
        writeAiWorkspaceQuests(AI, 'fresh', ['webwork']);
        const text = fs.readFileSync(file, 'utf8');
        assert.match(text, /# my note/);
        assert.match(text, /later: keep me/);
        assert.deepEqual(resolveWorkspaceQuests(AI, 'fresh', ALL).quests, ['webwork']);
        writeAiWorkspaceQuests(AI, 'fresh', undefined);
        assert.equal(resolveWorkspaceQuests(AI, 'fresh', ALL).source, 'all', 'All quests: no list');
        assert.match(fs.readFileSync(file, 'utf8'), /later: keep me/);
        const noSchema = aiWorkspaceFile(AI, 'plain');
        fs.writeFileSync(noSchema, 'quests: []\n');
        writeAiWorkspaceQuests(AI, 'plain', ['webwork']);
        assert.ok(fs.readFileSync(noSchema, 'utf8').startsWith(AI_WORKSPACE_SCHEMA_LINE), 'the schema line added');
    });

    test('AW-4: the short description', () => {
        const root = path.join(AI, 'quests');
        fs.writeFileSync(path.join(root, 'webwork', 'short_description.webwork.md'), '# Webwork (`webwork`)\n\nThe web runtime.\n\n**State:** going.\n');
        assert.equal(readQuestShortDescription(root, 'webwork'), 'The web runtime.\n\n**State:** going.');
        assert.equal(readQuestShortDescription(root, 'tom_specs'), undefined);
    });
});
