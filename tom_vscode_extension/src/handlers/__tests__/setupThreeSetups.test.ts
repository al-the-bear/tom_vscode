/**
 * Setup New Workspace Folder with the three setups (02_wslayout-10; handlers/setupWorkspaceFolder-handler.ts,
 * utils/workspaceSetup.ts): a two-part template (root/, workspace/) of a fake extension unpacked into sandbox
 * folders, the dialogs answered by a scripted UI.
 *
 *   S3-1 a new root with a first workspace folder: root/ into the picked folder, workspace/ into the named
 *        subfolder (its empty .tom/ made), its _ai a relative link resolving to the root's, the root token written
 *        as `..` so CLAUDE.md's import resolves, the introduction quest's .code-workspace written
 *        (chat.useAgentsMdFile) and opened through the workspace folder's _ai
 *   S3-2 a workspace folder in an existing root: workspace/ into the picked folder deeper in the root, the token
 *        its path to the root, _ai linked; refused outside a root and in a root without _ai, nothing written
 *   S3-3 a standalone workspace folder: both parts in one folder, no tom_root.yaml, the token `.`, no _ai link
 *   S3-4 existing files are asked about with their path from the picked folder; an "all" answer settles both parts;
 *        a closed setup choice or name box stops before anything is written; a bad name is refused
 *   S3-5 the _ai link: a relative symbolic link; on Windows a junction when the symbolic link fails (a mocked
 *        fs.symlinkSync failure); elsewhere the failure stands; an existing _ai is left as it is
 *   S3-6 every new quest's .code-workspace sets chat.useAgentsMdFile (the quest scaffold); the VS Code UI asks the
 *        setup with a quick pick and the name with an input box that refuses a bad one
 */

import test, { after, describe } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import { installVscodeStub } from '../../tools/__tests__/_vscode-stub.js';

const EXT = path.resolve(__dirname, '..', '..', '..');
const SANDBOX = fs.realpathSync(fs.mkdtempSync(path.join(EXT, '..', '..', '..', 'ztmp', 'vscode_extension_261118_02_wslayout-10_s3-')));
after(() => fs.rmSync(SANDBOX, { recursive: true, force: true }));

const quickPicks: unknown[][] = [];
const inputBoxes: Array<Record<string, unknown>> = [];
let quickPickAnswer: unknown;
let inputAnswer: string | undefined;
const stubbed = installVscodeStub({ workspaceFolders: [path.join(SANDBOX, 'none')] });
const win = stubbed.stub.window as Record<string, unknown>;
win.showQuickPick = async (...args: unknown[]) => { quickPicks.push(args); return quickPickAnswer; };
win.showInputBox = async (opts: Record<string, unknown>) => { inputBoxes.push(opts); return inputAnswer; };

import { INTRO_WORKSPACE, SETUP_KIND_ITEMS, TEMPLATE_ZIP, runSetupWorkspaceFolder, vscodeSetupUi, type OpenChoice, type SetupUi } from '../setupWorkspaceFolder-handler.js';
import { linkAi, questCodeWorkspaceText, workspaceNameProblem, type ExistingFileChoice, type SetupKind, type UnpackResult } from '../../utils/workspaceSetup.js';
import { questScaffoldFiles } from '../../utils/questScaffold.js';
import { collectWithImports } from '../../services/claudeMd.js';

// eslint-disable-next-line @typescript-eslint/no-require-imports
const { writeZip } = require(path.join(EXT, 'scripts', 'build-workspace-template.cjs')) as { writeZip(e: Array<{ path: string; data: Buffer }>): Buffer };

/* eslint-disable @typescript-eslint/naming-convention -- template paths as keys */
const TEMPLATE: Record<string, string> = {
    'root/.tom/tom_root.yaml': 'version: 1\n',
    'root/.tom/tom_vscode_extension.json': '{"bridge":{}}',
    'root/.tom/workspace_template.json': '{"version":2}\n',
    'root/CLAUDE.md': '@AGENTS.md\n@_agent_guidelines/workspace_agents.md\n',
    'root/AGENTS.md': '# Root\n',
    'root/_agent_guidelines/workspace_agents.md': '# Shared\n',
    'root/_agent_guidelines/index.md': '# Root index\n',
    'root/_ai/roles/default/role.md': 'role\n',
    'root/_ai/quests/tomai_introduction/overview.tomai_introduction.md': '# Intro\n',
    'workspace/.tom/': '',
    'workspace/CLAUDE.md': '# CLAUDE\n\n@{{root}}/_agent_guidelines/workspace_agents.md\n@AGENTS.md\n',
    'workspace/AGENTS.md': '# Group\n',
    'workspace/_copilot_guidelines/index.md': '# Index\n\nSee [the root index](../{{root}}/_agent_guidelines/index.md).\n',
};
/* eslint-enable @typescript-eslint/naming-convention */

let counter = 0;
const dir = (name: string, base = SANDBOX): string => { const d = path.join(base, `${name}-${++counter}`); fs.mkdirSync(d, { recursive: true }); return d; };
function fakeExtension(): string {
    const ext = dir('ext');
    fs.mkdirSync(path.join(ext, 'resources'), { recursive: true });
    fs.writeFileSync(path.join(ext, TEMPLATE_ZIP), writeZip(Object.entries(TEMPLATE).map(([p, d]) => ({ path: p, data: Buffer.from(d) }))));
    return ext;
}
const openFolderCalls = (): unknown[][] => stubbed.spies.byMethod('commands.executeCommand').map((c) => c.args).filter((a) => a[0] === 'vscode.openFolder');

function scriptedUi(folder: string | undefined, o: { kind?: SetupKind; name?: string; existing?: ExistingFileChoice[]; open?: OpenChoice } = {}): SetupUi & { log: string[]; asked: string[]; reports: UnpackResult[] } {
    const existing = [...(o.existing ?? [])];
    const ui = {
        log: [] as string[], asked: [] as string[], reports: [] as UnpackResult[],
        async askSetupKind() { ui.log.push('kind?'); return o.kind; },
        async askWorkspaceName(root: string) { ui.log.push(`name? ${path.basename(root)}`); return o.name; },
        async pickFolder() { ui.log.push('pick'); return folder; },
        async confirmNonEmpty() { ui.log.push('nonEmpty'); return true; },
        async askExisting(p: string) { ui.asked.push(p); return existing.shift() ?? 'cancel'; },
        async showReport(r: UnpackResult) { ui.log.push('report'); ui.reports.push(r); },
        async showConfigNote(c: string) { ui.log.push(`config ${c}`); },
        async askWhatToOpen(intro: boolean) { ui.log.push(`open? ${intro}`); return o.open ?? 'stay'; },
        async showError(m: string) { ui.log.push(`error ${m}`); },
    };
    return ui;
}
const read = (...p: string[]): string => fs.readFileSync(path.join(...p), 'utf8');
/** The files CLAUDE.md of `folder` loads, relative to `folder`. */
const loads = (folder: string): string[] => collectWithImports(path.join(folder, 'CLAUDE.md'), os.homedir()).map((s) => path.relative(folder, s.path));

describe('Setup New Workspace Folder: the three setups', () => {
    test('S3-1: a new root with a first workspace folder', async () => {
        const ext = fakeExtension();
        const root = dir('newroot');
        const before = openFolderCalls().length;
        const ui = scriptedUi(root, { kind: 'root', name: 'container', open: 'intro' });
        const out = await runSetupWorkspaceFolder(ext, ui);
        assert.equal(out.status, 'done');
        const ws = path.join(root, 'container');
        assert.deepEqual(ui.log, ['kind?', 'pick', 'name? ' + path.basename(root), 'report', `config ${path.join(root, '.tom', 'tom_vscode_extension.json')}`, 'open? true']);
        for (const f of ['.tom/tom_root.yaml', '.tom/workspace_template.json', 'CLAUDE.md', 'AGENTS.md', '_agent_guidelines/workspace_agents.md', '_ai/roles/default/role.md']) {
            assert.ok(fs.existsSync(path.join(root, f)), `root: ${f}`);
        }
        assert.ok(fs.statSync(path.join(ws, '.tom')).isDirectory(), 'the workspace folder\'s empty .tom');
        assert.equal(fs.readdirSync(path.join(ws, '.tom')).length, 0);
        assert.equal(read(ws, 'CLAUDE.md'), '# CLAUDE\n\n@../_agent_guidelines/workspace_agents.md\n@AGENTS.md\n', 'the token: the path to the root');
        assert.deepEqual(loads(ws), ['CLAUDE.md', path.join('..', '_agent_guidelines', 'workspace_agents.md'), 'AGENTS.md'], 'the import resolves');
        assert.match(read(ws, '_copilot_guidelines', 'index.md'), /\]\(\.\.\/\.\.\/_agent_guidelines\/index\.md\)/);
        assert.ok(fs.existsSync(path.join(path.join(ws, '_copilot_guidelines'), '..', '..', '_agent_guidelines', 'index.md')), 'the index link resolves');
        const link = path.join(ws, '_ai');
        assert.equal(fs.lstatSync(link).isSymbolicLink(), true);
        assert.equal(fs.readlinkSync(link), path.join('..', '_ai'), 'relative');
        assert.equal(fs.realpathSync(link), fs.realpathSync(path.join(root, '_ai')), 'resolves to the root\'s _ai');
        assert.equal(out.status === 'done' && out.aiLink?.kind, 'symlink');
        assert.ok(!fs.existsSync(path.join(ws, '.tom', 'tom_root.yaml')) && !fs.existsSync(path.join(ws, '_agent_guidelines')), 'nothing of the root in the workspace folder');
        const codeWs = path.join(root, INTRO_WORKSPACE);
        assert.equal(read(codeWs), questCodeWorkspaceText());
        assert.deepEqual(JSON.parse(read(codeWs)), { folders: [{ path: '../../..' }], settings: { 'chat.useAgentsMdFile': true } });
        const opened = openFolderCalls().slice(before);
        assert.equal(opened.length, 1);
        assert.equal((opened[0][1] as { fsPath: string }).fsPath, path.join(ws, INTRO_WORKSPACE), 'opened through the workspace folder\'s _ai');
        assert.equal(path.resolve(path.dirname(path.join(ws, INTRO_WORKSPACE)), '../../..'), ws, 'its folder is the workspace folder');
    });

    test('S3-2: a workspace folder in an existing root', async () => {
        const ext = fakeExtension();
        const root = dir('root2');
        await runSetupWorkspaceFolder(ext, scriptedUi(root, { kind: 'root', name: 'first' }));
        const web = path.join(root, 'apps', 'web');
        fs.mkdirSync(web, { recursive: true });
        const ui = scriptedUi(web, { kind: 'workspace', open: 'folder' });
        const before = openFolderCalls().length;
        const out = await runSetupWorkspaceFolder(ext, ui);
        assert.equal(out.status, 'done');
        assert.deepEqual(ui.log, ['kind?', 'pick', 'report', 'open? true'], 'no name, no configuration note (the root\'s exists)');
        assert.equal(read(web, 'CLAUDE.md'), '# CLAUDE\n\n@../../_agent_guidelines/workspace_agents.md\n@AGENTS.md\n');
        assert.deepEqual(loads(web).slice(0, 2), ['CLAUDE.md', path.join('..', '..', '_agent_guidelines', 'workspace_agents.md')]);
        assert.equal(fs.readlinkSync(path.join(web, '_ai')), path.join('..', '..', '_ai'));
        assert.equal(fs.realpathSync(path.join(web, '_ai')), fs.realpathSync(path.join(root, '_ai')));
        assert.ok(fs.existsSync(path.join(web, 'AGENTS.md')) && !fs.existsSync(path.join(web, '_agent_guidelines')) && !fs.existsSync(path.join(web, '.tom', 'tom_root.yaml')), 'only the workspace part');
        assert.equal((openFolderCalls().slice(before)[0][1] as { fsPath: string }).fsPath, web);
        // Refused in a root without _ai.
        const bare = dir('bareroot');
        fs.mkdirSync(path.join(bare, '.tom'));
        fs.writeFileSync(path.join(bare, '.tom', 'tom_root.yaml'), 'version: 1\n');
        const inBare = path.join(bare, 'ws');
        fs.mkdirSync(inBare);
        const refused = scriptedUi(inBare, { kind: 'workspace' });
        const r1 = await runSetupWorkspaceFolder(ext, refused);
        assert.equal(r1.status, 'noRoot');
        assert.match(refused.log.at(-1)!, /^error .*is a root \(\.tom\/tom_root\.yaml\) without an _ai folder/);
        assert.deepEqual(fs.readdirSync(inBare), [], 'nothing written');
        // Refused outside any root (a temporary folder outside this tree).
        const outside = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'tomai-noroot-')));
        try {
            const ui2 = scriptedUi(outside, { kind: 'workspace' });
            const r2 = await runSetupWorkspaceFolder(ext, ui2);
            assert.equal(r2.status, 'noRoot');
            assert.match(ui2.log.at(-1)!, /^error .* is not inside a root: no folder above it has \.tom\/tom_root\.yaml/);
            assert.deepEqual(fs.readdirSync(outside), [], 'nothing written');
        } finally { fs.rmSync(outside, { recursive: true, force: true }); }
    });

    test('S3-3: a standalone workspace folder', async () => {
        const ext = fakeExtension();
        const alone = dir('alone');
        const out = await runSetupWorkspaceFolder(ext, scriptedUi(alone, { kind: 'standalone' }));
        assert.equal(out.status, 'done');
        assert.equal(fs.existsSync(path.join(alone, '.tom', 'tom_root.yaml')), false, 'no root marker');
        assert.equal(read(alone, 'CLAUDE.md'), '# CLAUDE\n\n@./_agent_guidelines/workspace_agents.md\n@AGENTS.md\n');
        assert.equal(read(alone, 'AGENTS.md'), '# Group\n', 'the workspace part\'s');
        assert.deepEqual(loads(alone), ['CLAUDE.md', path.join('_agent_guidelines', 'workspace_agents.md'), 'AGENTS.md']);
        assert.ok(fs.statSync(path.join(alone, '_ai')).isDirectory() && !fs.lstatSync(path.join(alone, '_ai')).isSymbolicLink(), 'its own _ai');
        assert.equal(out.status === 'done' && out.aiLink, undefined);
    });

    test('S3-4: existing files, stops, names', async () => {
        const ext = fakeExtension();
        const root = dir('existing');
        fs.mkdirSync(path.join(root, 'ws'), { recursive: true });
        fs.writeFileSync(path.join(root, 'CLAUDE.md'), 'mine');
        fs.writeFileSync(path.join(root, 'ws', 'AGENTS.md'), 'mine too');
        const ui = scriptedUi(root, { kind: 'root', name: 'ws', existing: ['skip', 'skipAll'] });
        const out = await runSetupWorkspaceFolder(ext, ui);
        assert.equal(out.status, 'done');
        assert.deepEqual(ui.asked, ['CLAUDE.md', 'ws/AGENTS.md'], 'asked with the path from the picked folder');
        assert.equal(read(root, 'CLAUDE.md'), 'mine');
        assert.equal(read(root, 'ws', 'AGENTS.md'), 'mine too');
        const all = dir('all');
        fs.mkdirSync(path.join(all, 'ws'));
        fs.writeFileSync(path.join(all, 'CLAUDE.md'), 'mine');
        fs.writeFileSync(path.join(all, 'ws', 'AGENTS.md'), 'mine too');
        const ui2 = scriptedUi(all, { kind: 'root', name: 'ws', existing: ['overwriteAll'] });
        await runSetupWorkspaceFolder(ext, ui2);
        assert.deepEqual(ui2.asked, ['CLAUDE.md'], 'Overwrite All settles the workspace part too');
        assert.equal(read(all, 'ws', 'AGENTS.md'), '# Group\n');
        // Stops before anything is written.
        const closed = dir('closed');
        assert.equal((await runSetupWorkspaceFolder(ext, scriptedUi(closed, {}))).status, 'noFolder', 'the setup choice closed');
        assert.equal((await runSetupWorkspaceFolder(ext, scriptedUi(closed, { kind: 'root' }))).status, 'declined', 'the name box closed');
        assert.equal((await runSetupWorkspaceFolder(ext, scriptedUi(closed, { kind: 'root', name: '../x' }))).status, 'declined', 'a bad name');
        assert.deepEqual(fs.readdirSync(closed), []);
        for (const bad of ['', '..', 'a/b', '_ai', '.hidden']) { assert.ok(workspaceNameProblem(bad), bad); }
        assert.equal(workspaceNameProblem('tom_agent_container'), undefined);
    });

    test('S3-5: the _ai link and the Windows fallback', () => {
        const root = dir('linkroot');
        fs.mkdirSync(path.join(root, '_ai'));
        const ws = path.join(root, 'w');
        fs.mkdirSync(ws);
        const calls: unknown[][] = [];
        const failingSymlink = (target: string, link: string, type?: string): void => {
            calls.push([target, link, type]);
            if (type === 'dir') { const e = new Error('EPERM: operation not permitted, symlink') as NodeJS.ErrnoException; e.code = 'EPERM'; throw e; }
            fs.symlinkSync(target, link);
        };
        const r = linkAi(ws, root, { symlink: failingSymlink, platform: 'win32' });
        assert.equal(r.kind, 'junction');
        assert.deepEqual(calls, [[path.join('..', '_ai'), path.join(ws, '_ai'), 'dir'], [path.join(root, '_ai'), path.join(ws, '_ai'), 'junction']], 'relative symlink first, then an absolute junction');
        assert.equal(fs.realpathSync(path.join(ws, '_ai')), fs.realpathSync(path.join(root, '_ai')));
        assert.equal(linkAi(ws, root).kind, 'exists', 'an existing _ai is left as it is');
        const ws2 = path.join(root, 'w2');
        fs.mkdirSync(ws2);
        assert.throws(() => linkAi(ws2, root, { symlink: failingSymlink, platform: 'darwin' }), /EPERM/, 'elsewhere the failure stands');
    });

    test('S3-6: new quests set chat.useAgentsMdFile; the VS Code UI', async () => {
        const files = questScaffoldFiles('q', 'Q', new Date(2026, 10, 18));
        assert.equal(files.find((f) => f.name === 'q.code-workspace')!.content, questCodeWorkspaceText());
        assert.deepEqual(SETUP_KIND_ITEMS.map((i) => i.kind), ['root', 'workspace', 'standalone']);
        const ui = vscodeSetupUi();
        quickPickAnswer = { label: SETUP_KIND_ITEMS[1].label, setup: 'workspace' };
        assert.equal(await ui.askSetupKind!(), 'workspace');
        assert.deepEqual((quickPicks.at(-1)![0] as Array<{ label: string }>).map((i) => i.label), SETUP_KIND_ITEMS.map((i) => i.label));
        quickPickAnswer = undefined;
        assert.equal(await ui.askSetupKind!(), undefined, 'closed');
        inputAnswer = 'apps';
        assert.equal(await ui.askWorkspaceName!('/r'), 'apps');
        const box = inputBoxes.at(-1)!;
        assert.equal(box.value, 'workspace');
        const validate = box.validateInput as (v: string) => string | null;
        assert.equal(validate('ok'), null);
        assert.match(String(validate('a/b')), /One folder name/);
    });
});
