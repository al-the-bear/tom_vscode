/**
 * Setup New Workspace Folder (handlers/setupWorkspaceFolder-handler.ts,
 * utils/workspaceSetup.ts, vsc_setup-4): the template zip of a fake extension
 * unpacked into sandbox folders, the dialogs answered by a scripted UI and by the
 * vscode stub.
 *
 *   SW-1 an empty folder: every file written, no question asked, the report, the configuration note, the
 *        introduction quest offered and opened in a new window
 *   SW-2 a non-empty folder: the warning lists what is there and declining writes nothing; per file Overwrite /
 *        Skip; Overwrite All and Skip All settle every later file; Cancel stops and the report lists what was
 *        written
 *   SW-3 the template missing or unreadable: a clear error, no folder asked for
 *   SW-4 what to open: the introduction quest, the folder (both a new window) or stay; without the
 *        introduction quest it is not offered
 *   SW-5 VS Code's dialogs (the vscode stub): the folder dialog, the modal buttons and their answers, the
 *        configuration opened from the note, a dismissed modal is Cancel / Stay here; the command is contributed
 *   SW-6 the buttons: the placeholder page (both buttons, the click posts, the provider runs the command) and the
 *        first section of the Status Page (@WS the same HTML) dispatching to the command, with Create new quest
 *        beside it (tomAi.createQuest)
 *   SW-7 entries that are no file or would land outside the folder are not written
 */

import test, { after, describe } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { JSDOM } from 'jsdom';

import { installVscodeStub } from '../../tools/__tests__/_vscode-stub.js';

const SANDBOX = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'setup-ws-folder-')));
const WS = path.join(SANDBOX, 'ws');
fs.mkdirSync(path.join(WS, '.tom'), { recursive: true });
fs.writeFileSync(path.join(WS, '.tom', 'tom_vscode_extension.json'), '{}');
const EXT = path.resolve(__dirname, '..', '..', '..');

let warningAnswers: Array<string | undefined> = [];
let infoAnswers: Array<string | undefined> = [];
const dialogs: Array<{ kind: string; message: string; options: Record<string, unknown> | undefined; buttons: string[] }> = [];
const record = (kind: string, args: unknown[], answers: Array<string | undefined>): Promise<string | undefined> => {
    const [message, options, ...buttons] = args;
    dialogs.push({ kind, message: String(message), options: options as Record<string, unknown>, buttons: buttons as string[] });
    return Promise.resolve(answers.shift());
};
const stubbed = installVscodeStub({
    workspaceFolders: [WS],
    methodOverrides: {
        showWarningMessage: (...args: unknown[]) => record('warning', args, warningAnswers),
        showInformationMessage: (...args: unknown[]) => record('info', args, infoAnswers),
        showErrorMessage: (...args: unknown[]) => record('error', args, []),
    },
});
let pickedFolder: string | undefined;
const stubWindow = stubbed.stub.window as Record<string, unknown>;
stubWindow.showOpenDialog = async (options: unknown) => { dialogs.push({ kind: 'open', message: '', options: options as Record<string, unknown>, buttons: [] }); return pickedFolder ? [{ fsPath: pickedFolder }] : undefined; };
const providers = new Map<string, { resolveWebviewView(view: unknown): void }>();
stubWindow.registerWebviewViewProvider = (id: string, provider: { resolveWebviewView(view: unknown): void }) => { providers.set(id, provider); return { dispose: () => undefined }; };

// Safe to import after the stub is wired into the resolver.
import { TomAiConfiguration } from '../../utils/tomAiConfiguration.js';
import { TrailService } from '../../services/trailService.js';
import { setExtensionPath } from '../handler_shared.js';
import {
    EXISTING_BUTTONS, INTRO_WORKSPACE, NON_EMPTY_CONTINUE, OPEN_BUTTONS, OPEN_CONFIG, SETUP_WORKSPACE_COMMAND, TEMPLATE_CONFIG, TEMPLATE_ZIP,
    registerSetupWorkspaceFolderCommand, runSetupWorkspaceFolder, type OpenChoice, type SetupUi,
} from '../setupWorkspaceFolder-handler.js';
import { entryTarget, unpackTemplate, type ExistingFileChoice, type UnpackResult } from '../../utils/workspaceSetup.js';
import { registerMinimalModePanels } from '../minimalMode-handler.js';
import { gatherStatusData, getEmbeddedStatusHtml, getStatusPanelListenersScript, handleStatusAction } from '../statusPage-handler.js';

setExtensionPath(EXT);
TomAiConfiguration.init({} as never);
TrailService.init({} as never);
after(() => { fs.rmSync(SANDBOX, { recursive: true, force: true }); });

// eslint-disable-next-line @typescript-eslint/no-require-imports
const { writeZip } = require(path.join(EXT, 'scripts', 'build-workspace-template.cjs')) as { writeZip(e: Array<{ path: string; data: Buffer }>): Buffer };

const CONFIG_TEXT = '{"bridge":{}}';
// eslint-disable-next-line @typescript-eslint/naming-convention -- template paths as keys
const TEMPLATE: Record<string, string> = {
    /* eslint-disable @typescript-eslint/naming-convention */
    [TEMPLATE_CONFIG.split(path.sep).join('/')]: CONFIG_TEXT,
    'CLAUDE.md': '# rules',
    '_copilot_guidelines/index.md': '# index',
    '_ai/roles/default/role.md': 'role',
    'z_last.md': 'last',
    /* eslint-enable @typescript-eslint/naming-convention */
};
const INTRO = INTRO_WORKSPACE.split(path.sep).join('/');

let counter = 0;
const dir = (name: string): string => { const d = path.join(SANDBOX, `${name}-${++counter}`); fs.mkdirSync(d, { recursive: true }); return d; };
function fakeExtension(files: Record<string, string> | Buffer | undefined): string {
    const root = dir('ext');
    if (files === undefined) { return root; }
    fs.mkdirSync(path.join(root, 'resources'), { recursive: true });
    const zip = Buffer.isBuffer(files) ? files : writeZip(Object.entries(files).map(([p, d]) => ({ path: p, data: Buffer.from(d) })));
    fs.writeFileSync(path.join(root, TEMPLATE_ZIP), zip);
    return root;
}
const read = (root: string, rel: string): string => fs.readFileSync(path.join(root, ...rel.split('/')), 'utf8');
const openFolderCalls = (): unknown[][] => stubbed.spies.byMethod('commands.executeCommand').map((c) => c.args).filter((a) => a[0] === 'vscode.openFolder');

/** A scripted UI: records every step, answers from the lists given. */
function scriptedUi(folder: string | undefined, o: { proceed?: boolean; existing?: ExistingFileChoice[]; open?: OpenChoice } = {}): SetupUi & { log: string[]; reports: UnpackResult[]; asked: string[]; introOffered: boolean[] } {
    const existing = [...(o.existing ?? [])];
    const ui = {
        log: [] as string[], reports: [] as UnpackResult[], asked: [] as string[], introOffered: [] as boolean[],
        async pickFolder() { ui.log.push('pick'); return folder; },
        async confirmNonEmpty(f: string, entries: string[]) { ui.log.push(`nonEmpty ${entries.join(',')}`); return o.proceed ?? true; },
        async askExisting(p: string) { ui.asked.push(p); return existing.shift() ?? 'cancel'; },
        async showReport(r: UnpackResult) { ui.log.push('report'); ui.reports.push(r); },
        async showConfigNote(c: string) { ui.log.push(`config ${c}`); },
        async askWhatToOpen(intro: boolean) { ui.log.push('open?'); ui.introOffered.push(intro); return o.open ?? 'stay'; },
        async showError(m: string) { ui.log.push(`error ${m}`); },
    };
    return ui;
}

describe('Setup New Workspace Folder', () => {
    test('SW-1: an empty folder', async () => {
        const ext = fakeExtension({ ...TEMPLATE, [INTRO]: '{}' });
        const target = dir('empty');
        const ui = scriptedUi(target, { open: 'intro' });
        const before = openFolderCalls().length;
        const out = await runSetupWorkspaceFolder(ext, ui);
        assert.equal(out.status, 'done');
        assert.deepEqual(ui.asked, [], 'no file existed');
        assert.deepEqual(ui.reports[0], { written: [...Object.keys(TEMPLATE), INTRO], overwritten: [], skipped: [], cancelled: false });
        for (const [p, text] of Object.entries(TEMPLATE)) { assert.equal(read(target, p), text, p); }
        assert.deepEqual(ui.log, ['pick', 'report', `config ${path.join(target, TEMPLATE_CONFIG)}`, 'open?']);
        assert.deepEqual(ui.introOffered, [true]);
        const opened = openFolderCalls().slice(before);
        assert.equal(opened.length, 1);
        assert.equal((opened[0][1] as { fsPath: string }).fsPath, path.join(target, INTRO_WORKSPACE));
        assert.deepEqual(opened[0][2], { forceNewWindow: true });
    });

    test('SW-2: a non-empty folder', async () => {
        const ext = fakeExtension(TEMPLATE);
        const seed = (): string => {
            const t = dir('full');
            fs.mkdirSync(path.join(t, '_copilot_guidelines'), { recursive: true });
            for (const p of ['CLAUDE.md', '_copilot_guidelines/index.md', 'z_last.md']) { fs.writeFileSync(path.join(t, ...p.split('/')), 'mine'); }
            fs.writeFileSync(path.join(t, 'notes.txt'), 'mine');
            return t;
        };
        // Declined: nothing written.
        let t = seed();
        let ui = scriptedUi(t, { proceed: false });
        assert.equal((await runSetupWorkspaceFolder(ext, ui)).status, 'declined');
        assert.deepEqual(ui.log, ['pick', 'nonEmpty CLAUDE.md,_copilot_guidelines,notes.txt,z_last.md']);
        assert.equal(fs.existsSync(path.join(t, '.tom')), false);
        // Per file: Overwrite, then Skip, then Overwrite.
        t = seed();
        ui = scriptedUi(t, { existing: ['overwrite', 'skip', 'overwrite'] });
        assert.equal((await runSetupWorkspaceFolder(ext, ui)).status, 'done');
        assert.deepEqual(ui.asked, ['CLAUDE.md', '_copilot_guidelines/index.md', 'z_last.md']);
        assert.deepEqual(ui.reports[0], { written: ['.tom/tom_vscode_extension.json', '_ai/roles/default/role.md'], overwritten: ['CLAUDE.md', 'z_last.md'], skipped: ['_copilot_guidelines/index.md'], cancelled: false });
        assert.equal(read(t, 'CLAUDE.md'), '# rules');
        assert.equal(read(t, '_copilot_guidelines/index.md'), 'mine');
        assert.equal(read(t, 'notes.txt'), 'mine', 'a file the template does not have is left alone');
        // Overwrite All after the first Skip: asked twice, the rest overwritten.
        t = seed();
        ui = scriptedUi(t, { existing: ['skip', 'overwriteAll'] });
        await runSetupWorkspaceFolder(ext, ui);
        assert.deepEqual(ui.asked, ['CLAUDE.md', '_copilot_guidelines/index.md']);
        assert.deepEqual(ui.reports[0].overwritten, ['_copilot_guidelines/index.md', 'z_last.md']);
        assert.deepEqual(ui.reports[0].skipped, ['CLAUDE.md']);
        // Skip All on the first: asked once, every existing file kept.
        t = seed();
        ui = scriptedUi(t, { existing: ['skipAll'] });
        await runSetupWorkspaceFolder(ext, ui);
        assert.deepEqual(ui.asked, ['CLAUDE.md']);
        assert.deepEqual(ui.reports[0].skipped, ['CLAUDE.md', '_copilot_guidelines/index.md', 'z_last.md']);
        assert.equal(read(t, 'z_last.md'), 'mine');
        // Cancel on the second: stops, the files before stay and are reported; no note, no question.
        t = seed();
        ui = scriptedUi(t, { existing: ['overwrite', 'cancel'] });
        const out = await runSetupWorkspaceFolder(ext, ui);
        assert.equal(out.status, 'cancelled');
        assert.deepEqual(ui.reports[0], { written: ['.tom/tom_vscode_extension.json'], overwritten: ['CLAUDE.md'], skipped: [], cancelled: true });
        assert.equal(fs.existsSync(path.join(t, '_ai')), false, 'nothing after the cancel');
        assert.deepEqual(ui.log.slice(-1), ['report']);
    });

    test('SW-3: the template missing or unreadable', async () => {
        let ui = scriptedUi(dir('x'));
        const missing = await runSetupWorkspaceFolder(fakeExtension(undefined), ui);
        assert.equal(missing.status, 'missingTemplate');
        assert.match(ui.log[0], /^error The workspace template is missing: .*workspace_template\.zip does not exist\. .*build the VSIX again/);
        assert.equal(ui.log.length, 1, 'no folder asked for');
        ui = scriptedUi(dir('x'));
        assert.equal((await runSetupWorkspaceFolder(fakeExtension(Buffer.from('no zip')), ui)).status, 'badTemplate');
        assert.match(ui.log[0], /cannot be read: not a zip/);
        assert.equal(ui.log.length, 1);
    });

    test('SW-4: what to open', async () => {
        const withIntro = fakeExtension({ ...TEMPLATE, [INTRO]: '{}' });
        let before = openFolderCalls().length;
        const folderTarget = dir('open');
        assert.equal((await runSetupWorkspaceFolder(withIntro, scriptedUi(folderTarget, { open: 'folder' }))).status, 'done');
        const opened = openFolderCalls().slice(before);
        assert.equal((opened[0][1] as { fsPath: string }).fsPath, folderTarget);
        assert.deepEqual(opened[0][2], { forceNewWindow: true });
        before = openFolderCalls().length;
        const stay = await runSetupWorkspaceFolder(withIntro, scriptedUi(dir('open'), { open: 'stay' }));
        assert.equal(stay.status === 'done' && stay.opened, 'stay');
        assert.equal(openFolderCalls().length, before, 'nothing opened');
        const ui = scriptedUi(dir('open'), { open: 'intro' });
        const noIntro = await runSetupWorkspaceFolder(fakeExtension(TEMPLATE), ui);
        assert.deepEqual(ui.introOffered, [false], 'the introduction quest is not offered');
        assert.equal(noIntro.status === 'done' && noIntro.opened, 'stay');
        assert.equal(openFolderCalls().length, before);
    });

    test('SW-5: VS Code\'s dialogs', async () => {
        const ext = fakeExtension({ ...TEMPLATE, [INTRO]: '{}' });
        const target = dir('vscode');
        fs.writeFileSync(path.join(target, 'CLAUDE.md'), 'mine');
        fs.writeFileSync(path.join(target, 'z_last.md'), 'mine');
        pickedFolder = target;
        dialogs.length = 0;
        warningAnswers = [NON_EMPTY_CONTINUE, EXISTING_BUTTONS.skip, EXISTING_BUTTONS.overwriteAll, OPEN_CONFIG];
        infoAnswers = [undefined, OPEN_BUTTONS.folder];
        const shownBefore = stubbed.spies.byMethod('window.showTextDocument').length;
        const before = openFolderCalls().length;
        const out = await runSetupWorkspaceFolder(ext);
        assert.equal(out.status, 'done');
        assert.equal(dialogs[0].kind, 'open');
        assert.equal(dialogs[0].options?.canSelectFolders, true);
        assert.equal(dialogs[0].options?.canSelectFiles, false);
        const [nonEmpty, first, second, report, config, open] = dialogs.slice(1);
        assert.equal(nonEmpty.message, `${target} is not empty.`);
        assert.equal(nonEmpty.options?.modal, true);
        assert.match(String(nonEmpty.options?.detail), /• CLAUDE\.md\n• z_last\.md/);
        assert.deepEqual(nonEmpty.buttons, ['Set up anyway']);
        assert.equal(first.message, 'CLAUDE.md already exists.');
        assert.deepEqual(first.buttons, ['Overwrite', 'Skip', 'Overwrite All', 'Skip All']);
        assert.equal(first.options?.modal, true, 'the modal\'s own Cancel is the fifth answer');
        assert.equal(second.message, 'z_last.md already exists.');
        assert.equal(report.kind, 'info');
        assert.equal(report.message, 'Workspace template unpacked: 4 written, 1 overwritten, 1 skipped.');
        assert.match(String(report.options?.detail), /Overwritten:\n• z_last\.md\n\nSkipped:\n• CLAUDE\.md/);
        assert.match(String(config.options?.detail), /bridge\.profiles[\s\S]*bridge\.executables[\s\S]*Local LLM endpoint[\s\S]*Anthropic API key/);
        assert.deepEqual(config.buttons, ['Open the configuration']);
        const shown = stubbed.spies.byMethod('window.showTextDocument').slice(shownBefore);
        assert.equal((shown[0].args[0] as { fsPath: string }).fsPath, path.join(target, TEMPLATE_CONFIG));
        assert.deepEqual(open.buttons, ['Open the introduction quest', 'Open the folder', 'Stay here']);
        assert.equal((openFolderCalls().slice(before)[0][1] as { fsPath: string }).fsPath, target);
        assert.equal(read(target, 'CLAUDE.md'), 'mine');
        assert.equal(read(target, 'z_last.md'), 'last');
        // Dismissed modals: an existing file → Cancel, the open question → Stay here.
        const again = dir('vscode');
        fs.writeFileSync(path.join(again, 'CLAUDE.md'), 'mine');
        pickedFolder = again;
        warningAnswers = [NON_EMPTY_CONTINUE, undefined];
        infoAnswers = [undefined];
        assert.equal((await runSetupWorkspaceFolder(ext)).status, 'cancelled');
        const empty = dir('vscode');
        pickedFolder = empty;
        warningAnswers = [undefined];
        infoAnswers = [undefined, undefined];
        const stayed = await runSetupWorkspaceFolder(ext);
        assert.equal(stayed.status === 'done' && stayed.opened, 'stay');
        // No folder picked: nothing happens.
        pickedFolder = undefined;
        assert.equal((await runSetupWorkspaceFolder(ext)).status, 'noFolder');
        // The command.
        const pkg = JSON.parse(fs.readFileSync(path.join(EXT, 'package.json'), 'utf8'));
        assert.ok(pkg.contributes.commands.some((c: { command: string; title: string }) => c.command === SETUP_WORKSPACE_COMMAND && c.title === '@T: Setup New Workspace Folder'));
        const registered = new Map<string, () => Promise<unknown>>();
        const cmds = stubbed.stub.commands as Record<string, unknown>;
        const original = cmds.registerCommand;
        cmds.registerCommand = (id: string, fn: () => Promise<unknown>) => { registered.set(id, fn); return { dispose: () => undefined }; };
        try {
            const ctx = { extensionPath: ext, subscriptions: [] as unknown[] };
            registerSetupWorkspaceFolderCommand(ctx as never);
            assert.equal(ctx.subscriptions.length, 1);
        } finally { cmds.registerCommand = original; }
        dialogs.length = 0;
        await registered.get(SETUP_WORKSPACE_COMMAND)!();
        assert.equal(dialogs[0]?.kind, 'open', 'the command runs the setup');
    });

    test('SW-6: the buttons', async (t) => {
        // The placeholder page.
        const html = fs.readFileSync(path.join(EXT, 'media', 'minimalMode', 'index.html'), 'utf8');
        const dom = new JSDOM(html.replace(/<script[^>]*><\/script>/g, ''), { runScripts: 'outside-only' });
        t.after(() => dom.window.close());
        const doc = dom.window.document;
        assert.equal(doc.getElementById('setupWorkspaceBtn')?.textContent, 'Setup new workspace folder');
        assert.equal(doc.getElementById('setupBtn')?.textContent, 'Open Setup Guide');
        assert.equal(doc.getElementById('setupWorkspaceBtn')?.nextElementSibling?.id, 'setupBtn', 'beside the guide button');
        assert.match(doc.querySelector('.steps')?.textContent ?? '', /Setup new workspace folder/);
        const posted: unknown[] = [];
        (dom.window as unknown as Record<string, unknown>).acquireVsCodeApi = () => ({ postMessage: (m: unknown) => posted.push(JSON.parse(JSON.stringify(m))) });
        dom.window.eval(fs.readFileSync(path.join(EXT, 'media', 'minimalMode', 'main.js'), 'utf8'));
        (doc.getElementById('setupWorkspaceBtn') as unknown as { click(): void }).click();
        assert.deepEqual(posted, [{ type: 'setupWorkspaceFolder' }]);
        registerMinimalModePanels({ extensionUri: { fsPath: EXT, scheme: 'file' }, subscriptions: [] } as never);
        const handlers: Array<(m: unknown) => unknown> = [];
        providers.get('tomAi.wsPanel')!.resolveWebviewView({
            webview: { options: {}, html: '', cspSource: 'vscode-resource:', asWebviewUri: (u: unknown) => u, onDidReceiveMessage: (fn: (m: unknown) => unknown) => { handlers.push(fn); return { dispose: () => undefined }; } },
        });
        const commands = (): unknown[] => stubbed.spies.byMethod('commands.executeCommand').map((c) => c.args[0]).filter((c) => c === SETUP_WORKSPACE_COMMAND);
        const before = commands().length;
        await handlers[0]({ type: 'setupWorkspaceFolder' });
        assert.equal(commands().length, before + 1, 'the placeholder runs the command');

        // The Status Page: its first section; @WS embeds the same HTML.
        const page = new JSDOM(`<body>${getEmbeddedStatusHtml(await gatherStatusData())}</body>`, { runScripts: 'outside-only' });
        t.after(() => page.window.close());
        const w = page.window as unknown as Record<string, unknown> & { eval(s: string): unknown };
        const statusPosted: Array<Record<string, unknown>> = [];
        w.vscode = { postMessage: (m: Record<string, unknown>) => statusPosted.push(m) };
        w.eval(getStatusPanelListenersScript());
        w.eval('attachStatusPanelListeners(true)');
        const panel = page.window.document.querySelector('.sp-panel')!;
        const first = panel.firstElementChild!;
        assert.equal(first.getAttribute('data-section'), 'setupWorkspace');
        const button = first.querySelector('[data-status-action="setupWorkspaceFolder"]') as unknown as { textContent: string; click(): void };
        assert.equal(button.textContent, 'Setup new workspace folder');
        button.click();
        assert.equal(statusPosted[0]?.action, 'setupWorkspaceFolder');
        await handleStatusAction('setupWorkspaceFolder', statusPosted[0]);
        assert.equal(commands().length, before + 2, 'the Status Page runs the command');
        // Beside it: Create new quest, which runs tomAi.createQuest.
        const create = first.querySelector('[data-status-action="createQuest"]') as unknown as { textContent: string; click(): void };
        assert.equal(create.textContent, 'Create new quest');
        create.click();
        assert.equal(statusPosted[1]?.action, 'createQuest');
        const createRuns = (): number => stubbed.spies.byMethod('commands.executeCommand').filter((c) => c.args[0] === 'tomAi.createQuest').length;
        const createBefore = createRuns();
        await handleStatusAction('createQuest', statusPosted[1]);
        assert.equal(createRuns(), createBefore + 1, 'the Status Page runs Create New Quest');
    });

    test('SW-7: entries that are no file or would land outside', async () => {
        const target = dir('safe');
        assert.equal(entryTarget(target, 'a/'), undefined);
        assert.equal(entryTarget(target, '../evil.md'), undefined);
        assert.equal(entryTarget(target, 'a/../../evil.md'), undefined);
        assert.equal(entryTarget(target, '/etc/evil'), undefined);
        assert.equal(entryTarget(target, 'C:/evil'), undefined);
        assert.equal(entryTarget(target, 'a\\b'), undefined);
        assert.equal(entryTarget(target, 'a/b.md'), path.join(target, 'a', 'b.md'));
        const r = await unpackTemplate([
            { path: 'dir/', data: Buffer.alloc(0) },
            { path: '../evil.md', data: Buffer.from('x') },
            { path: 'ok.md', data: Buffer.from('ok') },
        ], target, async () => 'cancel');
        assert.deepEqual(r.written, ['ok.md']);
        assert.equal(fs.existsSync(path.join(path.dirname(target), 'evil.md')), false);
    });
});
