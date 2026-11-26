/**
 * The workspace template (scripts/build-workspace-template.cjs): what a new root and its workspace folders are set
 * up from, in two parts (02_wslayout-9, workspace layout BP-22 (a)).
 *
 *   WT-1 a fixture root with one workspace folder: `root/` holds the root's .tom (tom_root.yaml, the generic config,
 *        the workspaces schema), its guidelines with workspace_agents.md, CLAUDE.md, the generated AGENTS.md stub and
 *        the _ai sources; `workspace/` an empty .tom/, AGENTS.md, CLAUDE.md (the root import as the `{{root}}` token)
 *        and the workspace guidelines without the transition copies of root guidelines (links to them pointed to the
 *        root's copy, its index kept, linking the root's index through the token); nothing else; `root/.tom/workspace_template.json` names version 2 and both
 *        parts; no `.github/copilot-instructions.md`; the same bytes twice
 *   WT-2 personal paths: in the introduction quest the files of its use on this machine are left out; anywhere else
 *        they are refused; the quest's own config/extension_config.<quest>.yaml is packed
 *   WT-3 literal secrets are refused in either part; the command line exits 1 and writes nothing
 *   WT-4 a file outside the lists is refused; a missing required source is named with its part and stops the build;
 *        without a root the build is refused
 *   WT-5 built from this tree: the config in the zip passes the extension's config schema
 *   WT-6 it ships: both install scripts build it before packaging and copy it beside the VSIX, the VSIX check
 *        requires it, git ignores both copies, the copy beside the VSIX is not packed again
 *   WT-7 the template's config: the issue / test panels' repositories and the command lines emptied, everything else
 *        as in the root's file, which is not changed
 *   WT-8 `<!-- workspace-specific -->` blocks are left out of the packed Markdown; unbalanced markers refuse the build;
 *        built from this tree, CLAUDE.md and AGENTS.md pack only their generic parts
 *   WT-16 the workspace aspect files and CLAUDE-aspects-template.md in both parts: workspace-specific lines left out,
 *        the workspace part's imports of root files as `{{root}}/…`, an import of a transition copy onto the root's, the
 *        workspace yaml without its schema line
 *   WT-15 the left-out files under _agent_guidelines/ and this root's and workspace's aspects (fleet, d4rt, js_ts) are not packed.
 *   WT-9 the left-out files (EXCLUDED_PATHS, __pycache__, .pyc) are not packed; list items and table rows linking to
 *        them are dropped; a link to a transition copy points to the root's copy
 *   WT-10 quests_and_processes.md is packed as it is (no Active Quests table to cut)
 *   WT-11 built from this tree, no relative link in the packed Markdown points outside its part (the `{{root}}`
 *        links point into the root part)
 *   WT-12 the console Markdown guideline is generic in the template
 *   WT-13 the standalone check (BP-22): the rules a folder gets — CLAUDE.md, AGENTS.md, workspace_agents.md — name
 *        no fleet skill and need no root CLAUDE.md: the workspace CLAUDE.md imports the shared file itself
 *   WT-14 today's Setup unpacks the two parts as one standalone folder: root and workspace together, the workspace's
 *        CLAUDE.md / AGENTS.md winning, no tom_root.yaml, the token written as `.` so the import resolves
 */

import test, { describe } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { spawnSync } from 'child_process';
// eslint-disable-next-line @typescript-eslint/naming-convention
import Ajv from 'ajv';
import { readZip } from '../zipArchive';
import { isTwoPartTemplate, standaloneEntries } from '../workspaceSetup';
import { collectWithImports } from '../../services/claudeMd';

const EXT = path.resolve(__dirname, '..', '..', '..');
const WS = path.resolve(EXT, '..', '..', '..');
const SCRIPT = path.join(EXT, 'scripts', 'build-workspace-template.cjs');
interface Entry { path: string; data: Buffer }
type Build = { ok: true; zip: Buffer; files: string[]; skipped: string[]; leftOut: string[]; info: Record<string, unknown> } | { ok: false; errors: string[] };
// eslint-disable-next-line @typescript-eslint/no-require-imports
const tpl = require(SCRIPT) as {
    findRoot(from: string): string | undefined;
    buildTemplate(root: string | undefined, ws: string): Build;
    checkTemplate(entries: Entry[], sources?: unknown): string[];
    CONFIG_PATH: string; // eslint-disable-line @typescript-eslint/naming-convention -- the script's constant
    TEMPLATE_INFO_PATH: string; // eslint-disable-line @typescript-eslint/naming-convention -- the script's constant
    ROOT_AGENTS_STUB: string; // eslint-disable-line @typescript-eslint/naming-convention -- the script's constant
    genericConfig(data: Buffer): Buffer;
    stripWorkspaceSpecific(text: string, file: string): string;
    templateFileData(file: string, data: Buffer, excluded?: Set<string>, part?: 'root' | 'workspace'): Buffer;
    tokenizeRootImport(text: string): string;
};
// eslint-disable-next-line @typescript-eslint/no-require-imports
const { readCentralDirectory } = require(path.join(EXT, 'scripts', 'check-vsix-contents.cjs')) as { readCentralDirectory(b: Buffer): Array<{ name: string; isSymlink: boolean }> };

const ROOT = tpl.findRoot(EXT);
const present = !!ROOT && ['_agent_guidelines', '_copilot_guidelines'].some((g) => fs.existsSync(path.join(WS, g))) && fs.existsSync(path.join(WS, 'CLAUDE.md'));
const SCRATCH = path.join(EXT, '..', '..', '..', 'ztmp');

/** A fixture root (its own tom_root.yaml) with one workspace folder: every required source. */
function fixture(): { root: string; ws: string; put(rel: string, text: string): void } {
    const root = fs.realpathSync(fs.mkdtempSync(path.join(SCRATCH, 'vscode_extension_261118_02_wslayout-9_tpl-')));
    const put = (rel: string, text: string): void => { fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true }); fs.writeFileSync(path.join(root, rel), text); };
    put('.tom/tom_root.yaml', 'version: 1\n');
    put('.tom/tom_vscode_extension.json', '{"anthropic": {"apiKeyEnvVar": "ANTHROPIC_API_KEY"}}\n');
    put('.tom/json-schema/workspaces/ai-workspace.schema.json', '{}\n');
    put('.tom/json-schema/roles/role-type.schema.json', '{}\n'); // generated by the extension: not packed
    put('_agent_guidelines/index.md', '# Root index\n\n- [Shared](workspace_agents.md)\n');
    put('_agent_guidelines/workspace_agents.md', '# Shared rules\n');
    put('_agent_guidelines/quest_todos.md', '# Todos\n');
    put('CLAUDE.md', '@AGENTS.md\n@_agent_guidelines/workspace_agents.md\n');
    put('AGENTS.md', '# The fleet\n\nmy hosts\n');
    put('.github/copilot-instructions.md', '# Copilot\n');
    put('_ai/roles/default/role.md', '# Role\n');
    put('_ai/role-types/coder/role-type.yaml', 'tools:\n  mode: profileDefault\n');
    put('_ai/processes/README.md', '# Processes\n');
    put('_ai/schemas/todo.schema.json', '{}\n');
    put('_ai/prompt/p.md', 'prompt\n');
    put('_ai/format-version.yaml', 'version: 7\n');
    put('_ai/quests/tomai_introduction/overview.tomai_introduction.md', '# Introduction\n');
    put('_ai/quests/tomai_introduction/config/extension_config.tomai_introduction.yaml', 'telegram: {}\n');
    put('_ai/quests/other/overview.other.md', '# not in the template\n');
    put('_ai/memory/x.md', 'not in the template\n');
    put('ws/.tom/tom_vscode_extension.json', '{}\n');
    put('ws/AGENTS.md', '# Group rules\n\n<!-- workspace-specific -->\nmine\n<!-- /workspace-specific -->\n');
    put('ws/CLAUDE.md', '# CLAUDE\n\n@../_agent_guidelines/workspace_agents.md\n@AGENTS.md\n');
    put('ws/.github/copilot-instructions.md', '# Copilot\n');
    put('ws/_copilot_guidelines/index.md', '# Workspace index\n\n## Root guidelines\n\n## Own\n\n- [Dart](dart/coding.md)\n- [Todos (copy)](quest_todos.md)\n');
    put('ws/_copilot_guidelines/dart/coding.md', '# Coding\n');
    put('ws/_copilot_guidelines/quest_todos.md', '# Todos (transition copy)\n');
    put('ws/src/main.dart', 'void main() {}\n');
    return { root, ws: path.join(root, 'ws'), put };
}
const names = (r: Build): string[] => readZip((r as { zip: Buffer }).zip).map((e) => e.path);
const text = (r: Build, p: string): string => readZip((r as { zip: Buffer }).zip).find((e) => e.path === p)!.data.toString('utf8');

describe('the workspace template in two parts', () => {
    test('WT-1: a fixture root with one workspace folder', () => {
        const { root, ws } = fixture();
        const r = tpl.buildTemplate(root, ws);
        assert.ok(r.ok, r.ok ? '' : r.errors.join('\n'));
        assert.deepEqual(names(r), [
            'root/.tom/json-schema/workspaces/ai-workspace.schema.json', 'root/.tom/tom_root.yaml', 'root/.tom/tom_vscode_extension.json',
            'root/.tom/workspace_template.json', 'root/AGENTS.md', 'root/CLAUDE.md',
            'root/_agent_guidelines/index.md', 'root/_agent_guidelines/quest_todos.md', 'root/_agent_guidelines/workspace_agents.md',
            'root/_ai/format-version.yaml', 'root/_ai/processes/README.md',
            'root/_ai/quests/tomai_introduction/config/extension_config.tomai_introduction.yaml', 'root/_ai/quests/tomai_introduction/overview.tomai_introduction.md',
            'root/_ai/role-types/coder/role-type.yaml', 'root/_ai/roles/default/role.md', 'root/_ai/schemas/todo.schema.json',
            'workspace/.tom/', 'workspace/AGENTS.md', 'workspace/CLAUDE.md', 'workspace/_copilot_guidelines/dart/coding.md', 'workspace/_copilot_guidelines/index.md',
        ]);
        assert.deepEqual(names(r).filter((n) => n.startsWith('root/_ai/prompt')), [], 'no _ai/prompt: saved prompts are a quest\'s');
        assert.equal(text(r, 'root/AGENTS.md'), tpl.ROOT_AGENTS_STUB, 'the root\'s own AGENTS.md is replaced by the stub');
        assert.equal(text(r, 'workspace/CLAUDE.md'), '# CLAUDE\n\n@{{root}}/_agent_guidelines/workspace_agents.md\n@AGENTS.md\n');
        assert.equal(text(r, 'workspace/AGENTS.md'), '# Group rules\n\n');
        const index = text(r, 'workspace/_copilot_guidelines/index.md');
        assert.match(index, /## Root guidelines\n\nThe guidelines every workspace folder shares are indexed in the root's \[_agent_guidelines\/index\.md\]\(\.\.\/\{\{root\}\}\/_agent_guidelines\/index\.md\)\./);
        assert.match(index, /- \[Todos \(copy\)\]\(\.\.\/\{\{root\}\}\/_agent_guidelines\/quest_todos\.md\)/, 'a link to a transition copy points to the root\'s');
        const info = JSON.parse(text(r, tpl.TEMPLATE_INFO_PATH));
        assert.equal(info.version, 2);
        assert.equal(info.type, 'dart');
        assert.deepEqual(info.parts.workspace, ['.tom/', 'AGENTS.md', 'CLAUDE.md', '_copilot_guidelines/dart/coding.md', '_copilot_guidelines/index.md']);
        assert.ok(info.parts.root.includes('_agent_guidelines/workspace_agents.md'));
        assert.ok(Object.keys(info.tokens).includes('{{root}}'));
        assert.ok(!names(r).some((n) => n.includes('copilot-instructions')), 'no Copilot file');
        assert.deepEqual(readCentralDirectory((r as { zip: Buffer }).zip).map((e) => e.name), names(r), 'readable by the VSIX check\'s reader');
        assert.ok((tpl.buildTemplate(root, ws) as { zip: Buffer }).zip.equals((r as { zip: Buffer }).zip), 'deterministic');
        fs.rmSync(root, { recursive: true, force: true });
    });

    test('WT-2: personal paths', () => {
        const { root, ws, put } = fixture();
        const usedFiles = [
            '_ai/quests/tomai_introduction/config/extension_config.my-host.tomai_introduction.yaml',
            '_ai/quests/tomai_introduction/session-todo.my-host.tomai_introduction.todo.yaml',
            '_ai/quests/tomai_introduction/history/sessions/default/live-trail.md',
            '_ai/quests/tomai_introduction/config/process-state.tomai_introduction.yaml',
        ];
        for (const f of usedFiles) { put(f, 'x\n'); }
        const r = tpl.buildTemplate(root, ws);
        assert.ok(r.ok, r.ok ? '' : r.errors.join('\n'));
        assert.deepEqual((r as { leftOut: string[] }).leftOut, [...usedFiles].sort());
        assert.ok(usedFiles.every((f) => !names(r).includes(`root/${f}`)), 'not in the zip');
        assert.ok(names(r).includes('root/_ai/quests/tomai_introduction/config/extension_config.tomai_introduction.yaml'), 'the quest\'s own config is fine');
        for (const [planted, why] of [
            ['_ai/processes/extension_config.my-host.tomai_introduction.yaml', /host-specific quest config/],
            ['_ai/roles/session-todo.my-host.x.todo.yaml', /session todo file/],
            ['ws/_copilot_guidelines/history/live-trail.md', /history folder/],
        ] as const) {
            const f = fixture();
            f.put(planted, 'x\n');
            const refused = tpl.buildTemplate(f.root, f.ws);
            assert.equal(refused.ok, false, planted);
            assert.match((refused as { errors: string[] }).errors.join('\n'), why);
            fs.rmSync(f.root, { recursive: true, force: true });
        }
        fs.rmSync(root, { recursive: true, force: true });
    });

    test('WT-3: literal secrets', () => {
        for (const [file, body, why] of [
            ['.tom/tom_vscode_extension.json', '{"anthropic": {"apiKey": "sk-ant-api03-abcdefghijklmnopqrstuvwxyz0123"}}', /root\/\.tom\/tom_vscode_extension\.json: contains an Anthropic API key/],
            ['ws/_copilot_guidelines/index.md', 'token ghp_abcdefghijklmnopqrstuvwxyz0123456789', /workspace\/_copilot_guidelines\/index\.md: contains a GitHub token \(ghp_/],
            ['ws/CLAUDE.md', 'github_pat_11ABCDEFG0123456789_abcdefghij', /GitHub token \(github_pat_/],
            ['_ai/roles/default/role.md', 'bot 123456789:AAHdqTcvCH1vGWJxfSeofSAs0K5PALDsawq', /Telegram bot token/],
        ] as const) {
            const f = fixture();
            f.put(file, body);
            const r = tpl.buildTemplate(f.root, f.ws);
            assert.equal(r.ok, false, file);
            assert.match((r as { errors: string[] }).errors.join('\n'), why);
            fs.rmSync(f.root, { recursive: true, force: true });
        }
        const f = fixture();
        f.put('ws/CLAUDE.md', 'key sk-ant-api03-abcdefghijklmnopqrstuvwxyz0123');
        const out = path.join(f.root, 'out', 'workspace_template.zip');
        const run = spawnSync(process.execPath, [SCRIPT, '--root', f.root, '--workspace', f.ws, '--out', out], { encoding: 'utf8' });
        assert.equal(run.status, 1);
        assert.match(run.stderr, /workspace\/CLAUDE\.md: contains an Anthropic API key/);
        assert.ok(!fs.existsSync(out), 'nothing written');
        f.put('ws/CLAUDE.md', 'Keys look like `sk-ant-…`; name the variable, e.g. ANTHROPIC_API_KEY.');
        assert.equal(tpl.buildTemplate(f.root, f.ws).ok, true, 'a mention is not a key');
        fs.rmSync(f.root, { recursive: true, force: true });
    });

    test('WT-4: outside the lists, missing sources, no root', () => {
        assert.deepEqual(tpl.checkTemplate([{ path: 'root/_ai/memory/x.md', data: Buffer.from('x') }]), ['root/_ai/memory/x.md: outside the template\'s list']);
        assert.deepEqual(tpl.checkTemplate([{ path: 'root/_ai/roles/default/role.md', data: Buffer.from('x') }]), []);
        assert.deepEqual(tpl.checkTemplate([{ path: '_ai/roles/default/role.md', data: Buffer.from('x') }]), ['_ai/roles/default/role.md: outside the template\'s list'], 'no part');
        assert.deepEqual(tpl.checkTemplate([{ path: 'workspace/.github/copilot-instructions.md', data: Buffer.from('x') }]), ['workspace/.github/copilot-instructions.md: outside the template\'s list']);
        const { root, ws } = fixture();
        fs.rmSync(path.join(ws, 'CLAUDE.md'));
        fs.rmSync(path.join(root, '_ai', 'processes'), { recursive: true });
        fs.rmSync(path.join(root, '_ai', 'quests', 'tomai_introduction'), { recursive: true });
        const r = tpl.buildTemplate(root, ws);
        assert.equal(r.ok, false);
        assert.deepEqual((r as { errors: string[] }).errors, [`root/_ai/processes: missing in ${root}`, `workspace/CLAUDE.md: missing in ${ws}`], 'each named with its part; optional ones do not stop it');
        fs.writeFileSync(path.join(ws, 'CLAUDE.md'), '# Rules\n');
        fs.mkdirSync(path.join(root, '_ai', 'processes'));
        fs.writeFileSync(path.join(root, '_ai', 'processes', 'x.md'), 'x\n');
        assert.deepEqual((tpl.buildTemplate(root, ws) as { skipped: string[] }).skipped, ['root/_agent_guidelines/aspects', 'root/workspace_aspects.md', 'root/workspace_aspects.yaml', 'root/CLAUDE-aspects-template.md', 'root/_ai/aspect_guidelines', 'root/_ai/quests/tomai_introduction',
            'workspace/workspace_aspects.md', 'workspace/workspace_aspects.yaml', 'workspace/CLAUDE-aspects-template.md']);
        assert.match((tpl.buildTemplate(undefined, ws) as { errors: string[] }).errors[0], /no root: no folder with \.tom\/tom_root\.yaml above the extension \(pass --root\)/);
        fs.rmSync(root, { recursive: true, force: true });
    });

    test('WT-5: the config passes the schema', { skip: present ? false : 'no root and workspace around this checkout' }, () => {
        const r = tpl.buildTemplate(ROOT, WS);
        assert.ok(r.ok, r.ok ? '' : r.errors.join('\n'));
        const config = JSON.parse(text(r, `root/${tpl.CONFIG_PATH}`));
        const schema = JSON.parse(fs.readFileSync(path.join(EXT, 'src', 'config', 'tom_vscode_extension.schema.json'), 'utf8'));
        const validate = new Ajv({ strict: false, allErrors: true }).compile(schema);
        assert.ok(validate(config), JSON.stringify(validate.errors));
    });

    test('WT-6: it ships', () => {
        const read = (f: string): string => fs.readFileSync(path.join(EXT, f), 'utf8');
        const sh = read('install_extension.sh');
        assert.ok(sh.indexOf('node scripts/build-workspace-template.cjs --copy-to "$SCRIPT_DIR"') > 0);
        assert.ok(sh.indexOf('node scripts/build-workspace-template.cjs') < sh.indexOf('$VSCE_CMD package'), '.sh: before packaging');
        const ps1 = read('install_extension.ps1');
        assert.ok(ps1.indexOf('Invoke-Native { node scripts/build-workspace-template.cjs --copy-to $ExtensionDir }') > 0);
        assert.ok(ps1.indexOf('build-workspace-template.cjs') < ps1.indexOf('cmd /c vsce package'), '.ps1: before packaging');
        // eslint-disable-next-line @typescript-eslint/no-require-imports, @typescript-eslint/naming-convention
        const { REQUIRED } = require(path.join(EXT, 'scripts', 'check-vsix-contents.cjs')) as { REQUIRED: string[] };
        assert.ok(REQUIRED.includes('extension/resources/workspace_template.zip'));
        const gitignore = read('.gitignore').split('\n');
        assert.ok(gitignore.includes('resources/workspace_template.zip') && gitignore.includes('/workspace_template.zip'));
        const vscodeignore = read('.vscodeignore').split('\n');
        assert.ok(vscodeignore.includes('workspace_template.zip'), 'the copy beside the VSIX is not packed');
        assert.ok(!vscodeignore.some((l) => l.startsWith('resources/')), 'the one in resources/ is');
        assert.match(read('package.json'), /"template:build": "node scripts\/build-workspace-template\.cjs"/);
    });

    test('WT-7: the template config leaves out the repositories and command lines', () => {
        const live = {
            anthropic: { profiles: [{ id: 'p' }] },
            issuePanels: { common: { growthPriority: ['title'] }, issueKit: { additionalRepos: ['Mine:me/repo'], excludeRepos: ['x/y'], provider: 'github' }, testkit: { additionalRepos: ['me/tests'], excludeRepos: [] } },
            commandlines: [{ command: 'git status', cwd: '${workspaceFolder}/mine' }],
            commandlinePostActions: [{ commandId: 'workbench.action.reloadWindow' }],
        };
        const body = JSON.stringify(live, null, 2);
        const generic = JSON.parse(tpl.genericConfig(Buffer.from(body)).toString('utf8'));
        assert.deepEqual(generic.issuePanels.issueKit, { additionalRepos: [], excludeRepos: [], provider: 'github' });
        assert.deepEqual(generic.issuePanels.testkit, { additionalRepos: [], excludeRepos: [] });
        assert.deepEqual(generic.issuePanels.common, live.issuePanels.common, 'everything else stays');
        assert.deepEqual(generic.commandlines, []);
        assert.deepEqual(generic.commandlinePostActions, live.commandlinePostActions);
        assert.equal(tpl.genericConfig(Buffer.from(body)).toString('utf8').endsWith('\n'), false, 'the source\'s final newline is kept as it is');
        assert.equal(tpl.genericConfig(Buffer.from(body + '\n')).toString('utf8').endsWith('}\n'), true);
        const { root, ws, put } = fixture();
        put('.tom/tom_vscode_extension.json', body);
        const r = tpl.buildTemplate(root, ws);
        assert.deepEqual(JSON.parse(text(r, `root/${tpl.CONFIG_PATH}`)).commandlines, []);
        assert.equal(fs.readFileSync(path.join(root, '.tom', 'tom_vscode_extension.json'), 'utf8'), body, 'the root\'s file untouched');
        fs.rmSync(root, { recursive: true, force: true });
    });

    test('WT-8: workspace-specific blocks are left out', () => {
        const body = '# Rules\n\nGeneric.\n\n<!-- workspace-specific -->\n## This workspace\n\nMine.\n<!-- /workspace-specific -->\n\nAfter.\n';
        assert.equal(tpl.stripWorkspaceSpecific(body, 'CLAUDE.md'), '# Rules\n\nGeneric.\n\nAfter.\n');
        assert.throws(() => tpl.stripWorkspaceSpecific('<!-- workspace-specific -->\nx\n', 'a.md'), /never closed/);
        assert.throws(() => tpl.stripWorkspaceSpecific('x\n<!-- /workspace-specific -->\n', 'a.md'), /without an opening marker/);
        const { root, ws, put } = fixture();
        put('ws/_copilot_guidelines/broken.md', '<!-- workspace-specific -->\nopen\n');
        const refused = tpl.buildTemplate(root, ws);
        assert.equal(refused.ok, false);
        assert.match((refused as { errors: string[] }).errors.join('\n'), /workspace\/_copilot_guidelines\/broken\.md:1: .*never closed/);
        fs.rmSync(root, { recursive: true, force: true });
        if (present) {
            const live = tpl.templateFileData('CLAUDE.md', fs.readFileSync(path.join(WS, 'CLAUDE.md')), undefined, 'workspace').toString('utf8');
            assert.doesNotMatch(live, /workspace-specific|tom_build_base|al_the_bear|_doc\/tom/, 'the live CLAUDE.md packs only its generic part');
            assert.match(live, /^@\{\{root\}\}\/_agent_guidelines\/workspace_agents\.md$/m);
            assert.match(live, /^@AGENTS\.md$/m);
            const agents = tpl.templateFileData('AGENTS.md', fs.readFileSync(path.join(WS, 'AGENTS.md'))).toString('utf8');
            assert.doesNotMatch(agents, /workspace-specific|tom_build_base|al_the_bear|Run Dart tests with `testkit`/, 'the live AGENTS.md packs only its generic header');
        }
        assert.equal(tpl.tokenizeRootImport('@../../../../_agent_guidelines/workspace_agents.md\n@AGENTS.md\n'), '@{{root}}/_agent_guidelines/workspace_agents.md\n@AGENTS.md\n');
        assert.equal(tpl.tokenizeRootImport('@_copilot_guidelines/workspace_agents.md'), '@{{root}}/_copilot_guidelines/workspace_agents.md');
    });

    test('WT-9: left-out files and the links to them', () => {
        const { root, ws, put } = fixture();
        put('ws/_copilot_guidelines/projects_and_repos.md', '# Projects\n');
        put('ws/_copilot_guidelines/workspace_checks.md', '# Checks\n');
        put('_ai/schemas/__pycache__/x.cpython-312.pyc', 'bytes');
        put('_ai/schemas/stray.pyc', 'bytes');
        put('_ai/prompt/bot.chat-history.prompt.md', 'a chat log\n');
        put('ws/_copilot_guidelines/dart/setup.md', '# Setup\n\n- [Projects](../projects_and_repos.md) - ids\n- [Kept](../index.md)\n- [Todos](../quest_todos.md)\n\n| [workspace_checks.md](../workspace_checks.md) | x |\n\nSee [projects](../projects_and_repos.md) in a paragraph.\n');
        const r = tpl.buildTemplate(root, ws);
        assert.ok(r.ok, r.ok ? '' : r.errors.join('\n'));
        for (const gone of ['workspace/_copilot_guidelines/projects_and_repos.md', 'workspace/_copilot_guidelines/workspace_checks.md', 'workspace/_copilot_guidelines/quest_todos.md',
            'root/_ai/schemas/__pycache__/x.cpython-312.pyc', 'root/_ai/schemas/stray.pyc', 'root/_ai/prompt/bot.chat-history.prompt.md']) {
            assert.ok(!names(r).includes(gone), gone);
        }
        assert.equal(text(r, 'workspace/_copilot_guidelines/dart/setup.md'), '# Setup\n\n- [Kept](../index.md)\n- [Todos](../../{{root}}/_agent_guidelines/quest_todos.md)\n\n\nSee [projects](../projects_and_repos.md) in a paragraph.\n',
            'list items and table rows linking a left-out file dropped (a paragraph is marked by hand); a transition copy\'s link points to the root\'s');
        fs.rmSync(root, { recursive: true, force: true });
    });

    test('WT-15: left-out files under _agent_guidelines/, and the aspects of this root and workspace', () => {
        const { root, ws, put } = fixture();
        put('ws/_agent_guidelines/index.md', '# Workspace index\n');
        put('ws/_agent_guidelines/workspace_checks.md', '# Checks\n');
        put('ws/_agent_guidelines/aspects/d4rt/rules.md', '# D4rt\n');
        put('ws/_agent_guidelines/aspects/documentation/rules.md', '## Schema\n');
        put('_agent_guidelines/aspects/fleet/rules.md', '## Fleet\n');
        put('_agent_guidelines/aspects/documentation/rules.md', '## Docs\n');
        put('_ai/aspect_guidelines/fleet/aspect.yaml', 'name: fleet\n');
        put('_ai/aspect_guidelines/d4rt/aspect.yaml', 'name: d4rt\n');
        put('_ai/aspect_guidelines/documentation/aspect.yaml', 'name: documentation\ndefault: rules\n');
        put('ws/_agent_guidelines/aspects/js_ts/vscode_extension.md', '## Extension\n');
        put('_ai/aspect_guidelines/js_ts/aspect.yaml', 'name: js_ts\n');
        fs.rmSync(path.join(ws, '_copilot_guidelines'), { recursive: true, force: true });
        const r = tpl.buildTemplate(root, ws);
        assert.ok(r.ok, r.ok ? '' : r.errors.join('\n'));
        for (const gone of ['workspace/_agent_guidelines/workspace_checks.md', 'workspace/_agent_guidelines/aspects/d4rt/rules.md',
            'root/_agent_guidelines/aspects/fleet/rules.md', 'root/_ai/aspect_guidelines/fleet/aspect.yaml', 'root/_ai/aspect_guidelines/d4rt/aspect.yaml',
            'workspace/_agent_guidelines/aspects/documentation/rules.md', 'workspace/_agent_guidelines/aspects/js_ts/vscode_extension.md', 'root/_ai/aspect_guidelines/js_ts/aspect.yaml']) {
            assert.ok(!names(r).includes(gone), gone);
        }
        for (const kept of ['root/_agent_guidelines/aspects/documentation/rules.md', 'root/_ai/aspect_guidelines/documentation/aspect.yaml']) {
            assert.ok(names(r).includes(kept), kept);
        }
        fs.rmSync(root, { recursive: true, force: true });
    });

    test('WT-16: the workspace aspect files and the CLAUDE aspects template', () => {
        const { root, ws, put } = fixture();
        put('workspace_aspects.md', '# Workspace aspects\n\n@_agent_guidelines/aspects/authoring/rules.md\n<!-- workspace-specific -->\n@_agent_guidelines/aspects/fleet/rules.md\n<!-- /workspace-specific -->\n');
        put('CLAUDE-aspects-template.md', '@AGENTS.md\n@_agent_guidelines/workspace_agents.md\n@workspace_aspects.md\n');
        put('_agent_guidelines/aspects/docs/rules.md', '## Docs\n');
        put('ws/_copilot_guidelines/aspects/docs/rules.md', '@../../../../_agent_guidelines/aspects/docs/rules.md\n');
        put('ws/workspace_aspects.md', '# Workspace aspects\n');
        put('ws/workspace_aspects.yaml', '# yaml-language-server: $schema=../.tom/json-schema/aspect-guidelines/workspace-aspects.schema.json\nremove:\n  - skills\n');
        put('ws/CLAUDE-aspects-template.md', '# CLAUDE\n\n@../_agent_guidelines/workspace_agents.md\n@AGENTS.md\n@_copilot_guidelines/aspects/docs/rules.md\n@../workspace_aspects.md\n@workspace_aspects.md\n');
        const r = tpl.buildTemplate(root, ws);
        assert.ok(r.ok, r.ok ? '' : r.errors.join('\n'));
        for (const f of ['root/workspace_aspects.md', 'root/CLAUDE-aspects-template.md', 'workspace/workspace_aspects.md', 'workspace/workspace_aspects.yaml', 'workspace/CLAUDE-aspects-template.md']) {
            assert.ok(names(r).includes(f), f);
        }
        assert.doesNotMatch(text(r, 'root/workspace_aspects.md'), /fleet/, 'the workspace-specific lines are left out');
        assert.match(text(r, 'root/workspace_aspects.md'), /^@_agent_guidelines\/aspects\/authoring\/rules\.md$/m);
        assert.equal(text(r, 'workspace/workspace_aspects.yaml'), 'remove:\n  - skills\n', 'no schema line naming this depth');
        assert.equal(text(r, 'workspace/CLAUDE-aspects-template.md'),
            '# CLAUDE\n\n@{{root}}/_agent_guidelines/workspace_agents.md\n@AGENTS.md\n@{{root}}/_agent_guidelines/aspects/docs/rules.md\n@{{root}}/workspace_aspects.md\n@workspace_aspects.md\n',
            'root imports become the root token; an import of a transition copy points to the root\'s');
        fs.rmSync(root, { recursive: true, force: true });
    });

    test('WT-10: quests_and_processes.md packed as it is', () => {
        const body = '# Quests\n\n## Active Quests\n\n| ID | Name |\n|----|------|\n| mine | Mine |\n';
        assert.equal(tpl.templateFileData('_agent_guidelines/quests_and_processes.md', Buffer.from(body)).toString('utf8'), body);
    });

    test('WT-11: no relative link in the packed Markdown leaves its part', { skip: present ? false : 'no root and workspace around this checkout' }, () => {
        const entries = readZip((tpl.buildTemplate(ROOT, WS) as { zip: Buffer }).zip);
        const all = new Set(entries.map((e) => e.path));
        const dirs = new Set<string>();
        for (const n of all) { for (let d = path.posix.dirname(n); d && d !== '.'; d = path.posix.dirname(d)) { dirs.add(d); } }
        const dead: string[] = [];
        for (const e of entries.filter((x) => x.path.endsWith('.md'))) {
            const part = e.path.split('/')[0];
            let fence = false;
            e.data.toString('utf8').split('\n').forEach((line, i) => {
                if (/^\s*```/.test(line)) { fence = !fence; return; }
                if (fence) { return; }
                for (const m of line.replace(/`[^`]*`/g, '').matchAll(/\]\(([^)#\s]+)(?:#[^)]*)?\)/g)) {
                    if (/^[a-z]+:/i.test(m[1])) { continue; }
                    let target: string;
                    if (m[1].includes('{{root}}')) {
                        // A link to the root: from the workspace folder `{{root}}` is the root, i.e. the root part.
                        const fromWs = path.posix.normalize(path.posix.join(path.posix.dirname(e.path.slice(part.length + 1)), decodeURI(m[1])));
                        target = `root/${fromWs.replace(/^\{\{root\}\}\//, '')}`;
                    } else {
                        target = path.posix.normalize(path.posix.join(path.posix.dirname(e.path), decodeURI(m[1])));
                    }
                    if (!target.startsWith(`${part}/`) && !m[1].includes('{{root}}')) { dead.push(`${e.path}:${i + 1}: ${m[1]} (leaves its part)`); continue; }
                    if (!all.has(target) && !dirs.has(target.replace(/\/$/, ''))) { dead.push(`${e.path}:${i + 1}: ${m[1]}`); }
                }
            });
        }
        assert.deepEqual(dead, [], 'mark the passage <!-- workspace-specific --> or leave the file out (EXCLUDED_PATHS)');
    });

    test('WT-12: the console Markdown guideline is generic in the template', { skip: present ? false : 'no root and workspace around this checkout' }, () => {
        const r = tpl.buildTemplate(ROOT, WS);
        const guideline = text(r, names(r).find((n) => /^workspace\/_(agent|copilot)_guidelines\/console_markdown\.md$/.test(n)) ?? 'workspace/_agent_guidelines/console_markdown.md');
        assert.match(guideline, /\[pub\.dev\]\(https:\/\/pub\.dev\/packages\/console_markdown\)/);
        assert.doesNotMatch(guideline, /tom_basics_console|tom_ai\//, 'no package of this workspace');
    });

    test('WT-13: the standalone check: the packed rules need no skills and no root CLAUDE.md', { skip: present ? false : 'no root and workspace around this checkout' }, () => {
        const r = tpl.buildTemplate(ROOT, WS);
        const skillsDir = path.join(ROOT!, '.claude', 'skills');
        const skills = fs.existsSync(skillsDir) ? fs.readdirSync(skillsDir).filter((n) => /^tom_/.test(n)) : [];
        assert.ok(skills.length > 0 || !fs.existsSync(skillsDir), 'the fleet skills listed');
        for (const rule of ['root/CLAUDE.md', 'root/AGENTS.md', 'root/_agent_guidelines/workspace_agents.md', 'workspace/CLAUDE.md', 'workspace/AGENTS.md']) {
            const body = text(r, rule);
            for (const s of skills) { assert.doesNotMatch(body, new RegExp(`(^|[^A-Za-z0-9_])/?${s}\\b`), `${rule} names the skill ${s}`); }
        }
        const ws = text(r, 'workspace/CLAUDE.md');
        assert.match(ws, /^@\{\{root\}\}\/_agent_guidelines\/workspace_agents\.md$/m, 'the workspace CLAUDE.md imports the shared rules itself');
        assert.doesNotMatch(ws, /@\{\{root\}\}\/CLAUDE\.md/, 'not through the root CLAUDE.md');
    });

    test('WT-14: today\'s Setup unpacks both parts as one standalone folder', () => {
        const { root, ws } = fixture();
        const entries = readZip((tpl.buildTemplate(root, ws) as { zip: Buffer }).zip);
        assert.equal(isTwoPartTemplate(entries), true);
        const flat = standaloneEntries(entries);
        const paths = flat.map((e) => e.path).sort();
        assert.ok(!paths.includes('.tom/tom_root.yaml'), 'a standalone folder is no root');
        assert.ok(paths.includes('.tom/workspace_template.json') && paths.includes('_agent_guidelines/workspace_agents.md') && paths.includes('_copilot_guidelines/index.md'));
        assert.ok(!paths.some((p) => p.endsWith('/') || p.startsWith('root/') || p.startsWith('workspace/')));
        const claude = flat.find((e) => e.path === 'CLAUDE.md')!.data.toString('utf8');
        assert.equal(claude, '# CLAUDE\n\n@./_agent_guidelines/workspace_agents.md\n@AGENTS.md\n', 'the workspace part\'s, the token written as .');
        assert.equal(flat.find((e) => e.path === 'AGENTS.md')!.data.toString('utf8'), '# Group rules\n\n', 'the workspace part\'s AGENTS.md wins');
        assert.match(flat.find((e) => e.path === '_copilot_guidelines/index.md')!.data.toString('utf8'), /\]\(\.\.\/\.\/_agent_guidelines\/index\.md\)/);
        // Unpacked: the import resolves.
        const target = path.join(root, 'standalone');
        for (const e of flat) { fs.mkdirSync(path.dirname(path.join(target, e.path)), { recursive: true }); fs.writeFileSync(path.join(target, e.path), e.data); }
        const loaded = collectWithImports(path.join(target, 'CLAUDE.md'), os.homedir()).map((s) => path.relative(target, s.path));
        assert.deepEqual(loaded, ['CLAUDE.md', path.join('_agent_guidelines', 'workspace_agents.md'), 'AGENTS.md']);
        assert.deepEqual(standaloneEntries([{ path: 'a.md', data: Buffer.from('x') }]).map((e) => e.path), ['a.md'], 'a one-part template as it is');
        fs.rmSync(root, { recursive: true, force: true });
    });
});
