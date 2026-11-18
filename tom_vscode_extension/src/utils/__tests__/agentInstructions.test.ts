/**
 * The instruction files: AGENTS.md where the extension read CLAUDE.md or the Copilot file (02_wslayout-12;
 * utils/agentInstructions.ts, the Agent SDK transport, the placeholders, the @WS Guidelines and MD Browser groups,
 * the `.code-workspace` check).
 *
 *   AI-1 an Agent SDK send loading the project settings: CLAUDE.md → the `project` setting source (once); only
 *        AGENTS.md → its text in the system prompt; neither → nothing; the Copilot file is never read
 *   AI-2 the placeholders: `${claude.md}`, `${agents.md}`, `${instructions}` (CLAUDE.md, else AGENTS.md),
 *        `${agent-instructions}` (CLAUDE.md with its imports, else AGENTS.md) and the deprecated
 *        `${copilot-instructions}` (the same; the Copilot file is not read)
 *   AI-3 `${claudeMd}` over the new import chain: root CLAUDE.md → AGENTS.md; workspace CLAUDE.md → the shared
 *        workspace_agents.md + AGENTS.md
 *   AI-4 the AGENTS.md groups: root and workspace folder, one when they are the same folder, none without the
 *        file; the panels list that one file; the Copilot group only while the file is there
 *   AI-5 the `.code-workspace` check: reported when `chat.useAgentsMdFile` is not set to true in the workspace
 *        file, not without a `.code-workspace`; the fix writes it there
 */

import test, { after, describe } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'fs';
import * as path from 'path';

const EXT = path.resolve(__dirname, '..', '..', '..');
const SANDBOX = fs.realpathSync(fs.mkdtempSync(path.join(EXT, '..', '..', '..', 'ztmp', 'vscode_extension_261118_02_wslayout-12_ai-')));
after(() => fs.rmSync(SANDBOX, { recursive: true, force: true }));
const HOME = path.join(SANDBOX, 'home');
fs.mkdirSync(HOME, { recursive: true });
process.env.HOME = HOME;
process.env.USERPROFILE = HOME;

import { installVscodeStub } from '../../tools/__tests__/_vscode-stub.js';
const handle = installVscodeStub({ workspaceFolders: [path.join(SANDBOX, 'none')] });
// Before the modules load: their `import * as vscode` copies the stub's properties.
(handle.stub as Record<string, unknown>).ConfigurationTarget = { Global: 1, Workspace: 2, WorkspaceFolder: 3 };

import { AGENTS_MD_GROUP_PREFIX, agentsMdGroupDir, agentsMdGroups, workspaceInstructions } from '../agentInstructions.js';
import { applyWorkspaceInstructions } from '../../handlers/agent-sdk-transport.js';
import { resolveVariables } from '../variableResolver.js';
import { resetLayoutForTests } from '../workspaceLayout.js';
import { collectClaudeMd } from '../../services/claudeMd.js';
import { addUseAgentsMdFile, useAgentsMdFileProblem } from '../../services/agentsMdSetting.js';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Json = any;
function mk(...p: string[]): string { const d = path.join(...p); fs.mkdirSync(d, { recursive: true }); return d; }
function put(file: string, text: string): string { mk(path.dirname(file)); fs.writeFileSync(file, text); return file; }
function window(folder: string): void { installVscodeStub({ workspaceFolders: [folder] }); resetLayoutForTests(); }

// The root (its own tom_root.yaml): AGENTS.md, CLAUDE.md = @AGENTS.md, the shared workspace_agents.md; a workspace
// folder below it with AGENTS.md and a CLAUDE.md importing both; each folder also has a Copilot file that must not
// be read.
const ROOT = mk(SANDBOX, 'root');
put(path.join(ROOT, '.tom', 'tom_root.yaml'), 'version: 1\n');
put(path.join(ROOT, 'AGENTS.md'), '# Root agents\nroot rules\n');
put(path.join(ROOT, 'CLAUDE.md'), '@AGENTS.md\n');
put(path.join(ROOT, '_agent_guidelines', 'workspace_agents.md'), '# Shared\nshared rules\n');
const WS = mk(ROOT, 'inhouse', 'container');
mk(WS, '.tom');
put(path.join(WS, 'AGENTS.md'), '# Container agents\ncontainer rules\n');
put(path.join(WS, 'CLAUDE.md'), '# CLAUDE Instructions\n\n@../../_agent_guidelines/workspace_agents.md\n@AGENTS.md\n');
put(path.join(WS, '.github', 'copilot-instructions.md'), 'COPILOT FILE\n');
// A workspace folder with only AGENTS.md, and one with neither.
const ONLY = mk(ROOT, 'only');
put(path.join(ONLY, 'AGENTS.md'), 'only agents\n');
put(path.join(ONLY, '.github', 'copilot-instructions.md'), 'COPILOT FILE\n');
const NONE = mk(ROOT, 'none');
put(path.join(NONE, '.github', 'copilot-instructions.md'), 'COPILOT FILE\n');

describe('the instruction files', () => {
    test('AI-1: what an Agent SDK send loading the project settings gets', () => {
        assert.deepEqual(applyWorkspaceInstructions(WS, ['user'], 'base'), { settingSources: ['user', 'project'], systemPrompt: 'base' }, 'CLAUDE.md: project');
        assert.deepEqual(applyWorkspaceInstructions(WS, ['user', 'project'], 'base').settingSources, ['user', 'project'], 'once');
        const only = applyWorkspaceInstructions(ONLY, ['user'], 'base');
        assert.deepEqual(only.settingSources, ['user']);
        assert.equal(only.systemPrompt, 'base\n\n## Workspace instructions (from AGENTS.md)\n\nonly agents\n');
        assert.equal(applyWorkspaceInstructions(ONLY, [], undefined).systemPrompt, '## Workspace instructions (from AGENTS.md)\n\nonly agents\n');
        assert.deepEqual(applyWorkspaceInstructions(NONE, ['user'], 'base'), { settingSources: ['user'], systemPrompt: 'base' }, 'neither: nothing (the Copilot file not read)');
        assert.deepEqual(workspaceInstructions(''), { kind: 'none' });
        const src = fs.readFileSync(path.join(EXT, 'src', 'handlers', 'agent-sdk-transport.ts'), 'utf8');
        assert.doesNotMatch(src, /copilot-instructions/);
        assert.match(src, /applyWorkspaceInstructions\(layoutWorkspaceFolder\(\) \?\? '', settingSources, effectiveSystemPrompt\)/);
    });

    test('AI-2: the placeholders', () => {
        const r = (p: string): string => resolveVariables(p, { includeEditor: false });
        window(WS);
        assert.equal(r('${claude.md}'), fs.readFileSync(path.join(WS, 'CLAUDE.md'), 'utf8'));
        assert.equal(r('${agents.md}'), '# Container agents\ncontainer rules\n');
        assert.equal(r('${instructions}'), fs.readFileSync(path.join(WS, 'CLAUDE.md'), 'utf8'), 'CLAUDE.md first');
        const expanded = r('${agent-instructions}');
        assert.ok(expanded.indexOf('# CLAUDE Instructions') < expanded.indexOf('shared rules'), expanded);
        assert.ok(expanded.indexOf('shared rules') < expanded.indexOf('container rules'), 'the shared file, then AGENTS.md');
        assert.doesNotMatch(expanded, /root rules|COPILOT FILE/);
        assert.equal(r('${copilot-instructions}'), expanded, 'the deprecated alias');
        window(ONLY);
        assert.equal(r('${instructions}'), 'only agents\n', 'no CLAUDE.md: AGENTS.md');
        assert.equal(r('${agent-instructions}'), 'only agents\n');
        assert.equal(r('${copilot-instructions}'), 'only agents\n');
        window(NONE);
        assert.equal(r('${instructions}|${agent-instructions}|${copilot-instructions}|${agents.md}'), '|||', 'never the Copilot file');
        const resolver = fs.readFileSync(path.join(EXT, 'src', 'utils', 'variableResolver.ts'), 'utf8');
        assert.doesNotMatch(resolver, /'\.github', 'copilot-instructions\.md'/);
        assert.match(resolver, /<code>\\\$\{agent-instructions\}<\/code>/);
    });

    test('AI-3: ${claudeMd} over the new import chain', () => {
        const sources = collectClaudeMd({ wsRoot: WS, homeDir: HOME }).filter((s) => s.path.startsWith(ROOT));
        assert.deepEqual(sources.map((s) => [path.relative(ROOT, s.path), s.kind]), [
            ['CLAUDE.md', 'project'], ['AGENTS.md', 'import'],
            [path.join('inhouse', 'container', 'CLAUDE.md'), 'project'],
            [path.join('_agent_guidelines', 'workspace_agents.md'), 'import'],
            [path.join('inhouse', 'container', 'AGENTS.md'), 'import'],
        ]);
    });

    test('AI-4: the AGENTS.md groups', () => {
        assert.deepEqual(agentsMdGroups(ROOT, WS).map((g) => [g.id, g.dir]), [[`${AGENTS_MD_GROUP_PREFIX}root`, ROOT], [`${AGENTS_MD_GROUP_PREFIX}workspace`, WS]]);
        assert.deepEqual(agentsMdGroups(ROOT, ROOT).map((g) => g.id), [`${AGENTS_MD_GROUP_PREFIX}workspace`], 'the same folder: one group');
        assert.deepEqual(agentsMdGroups(ROOT, NONE).map((g) => g.id), [`${AGENTS_MD_GROUP_PREFIX}root`], 'no file: no group');
        assert.equal(agentsMdGroupDir('agents-md:root', ROOT, WS), ROOT);
        assert.equal(agentsMdGroupDir('agents-md:workspace', ROOT, WS), WS);
        assert.equal(agentsMdGroupDir('roles', ROOT, WS), undefined);
        const src = (rel: string) => fs.readFileSync(path.join(EXT, 'src', 'handlers', rel), 'utf8');
        for (const file of ['wsPanel-handler.ts', 'markdownBrowser-handler.ts']) {
            assert.match(src(file), /agentsMdGroups\(WsPaths\.tomRoot, wsRoot\)/, file);
            assert.match(src(file), /\[AGENTS_MD\]\.filter\(\(f\) => fs\.existsSync\(path\.join\(dir, f\)\)\)/, `${file}: only AGENTS.md listed`);
        }
        assert.match(src('wsPanel-handler.ts'), /if \(fs\.existsSync\(githubDir\) && fs\.existsSync\(path\.join\(githubDir, 'copilot-instructions\.md'\)\)\) \{/, 'the Copilot group only while the file is there');
    });

    test('AI-5: the .code-workspace check', async () => {
        const stub = handle.stub as Json;
        const ws = stub.workspace;
        const original = ws.getConfiguration;
        let value: unknown;
        const updates: unknown[] = [];
        ws.getConfiguration = (section: string) => ({
            get: () => undefined, has: () => false,
            inspect: (key: string) => section === 'chat' && key === 'useAgentsMdFile' ? { workspaceValue: value } : undefined,
            update: async (key: string, v: unknown, target: unknown) => { updates.push([section, key, v, target]); value = v; },
        });
        try {
            ws.workspaceFile = undefined;
            assert.equal(useAgentsMdFileProblem(), undefined, 'no .code-workspace: nothing to check');
            assert.equal(await addUseAgentsMdFile(), false);
            ws.workspaceFile = { fsPath: path.join(ROOT, 'q.code-workspace'), scheme: 'file' };
            assert.match(useAgentsMdFileProblem() ?? '', /q\.code-workspace does not set "chat\.useAgentsMdFile": true/);
            value = false;
            assert.ok(useAgentsMdFileProblem(), 'false is reported too');
            assert.equal(await addUseAgentsMdFile(), true);
            assert.deepEqual(updates, [['chat', 'useAgentsMdFile', true, 2]], 'written into the workspace file');
            assert.equal(useAgentsMdFileProblem(), undefined, 'fixed');
        } finally {
            ws.getConfiguration = original;
            ws.workspaceFile = undefined;
        }
        const status = fs.readFileSync(path.join(EXT, 'src', 'handlers', 'statusPage-handler.ts'), 'utf8');
        assert.match(status, /data-status-action="addUseAgentsMdFile"/);
        assert.match(status, /case 'addUseAgentsMdFile':\s*await addUseAgentsMdFile\(\);/);
    });
});
