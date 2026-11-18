/**
 * "@T: Setup New Workspace Folder" (`tomAi.setupWorkspaceFolder`): unpack the
 * workspace template the VSIX carries (`resources/workspace_template.zip`,
 * scripts/build-workspace-template.cjs) into a folder the user picks, then say
 * what in the configuration to adapt and offer what to open.
 *
 * The template has two parts, `root/` and `workspace/` (02_wslayout-9); the
 * user chooses one of three setups (02_wslayout-10):
 * - **a new root with a first workspace folder**: `root/` into the picked
 *   folder, `workspace/` into a subfolder named by the user, its `_ai` a link
 *   to the root's; the introduction quest's `.code-workspace` written, opened
 *   through the workspace folder's `_ai`;
 * - **a workspace folder in an existing root**: refused unless a folder above
 *   the picked one has `.tom/tom_root.yaml` (and an `_ai`); `workspace/` into
 *   the picked folder, its `_ai` linked to the root's;
 * - **a standalone workspace folder**: both parts into the picked folder
 *   (utils/workspaceSetup.ts standaloneEntries).
 * The workspace part's root token is written as the path from the workspace
 * folder to its root. A template of one part is unpacked as it is.
 *
 * The flow (`runSetupWorkspaceFolder`) talks to the user only through a
 * {@link SetupUi}; `vscodeSetupUi` is the one with VS Code's dialogs. Opening a
 * window is the flow's own step, so it is the same for every UI.
 *
 * Reached from the command palette, the minimal-mode placeholder panels and
 * the top of the Status Page (@WS too).
 */

import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import { readZip, type ZipEntry } from '../utils/zipArchive';
import {
    findRootAbove, folderEntries, isTwoPartTemplate, linkAi, partEntries, questCodeWorkspaceText, rootTokenFor, standaloneEntries, unpackReport, unpackSummary, unpackTemplate,
    workspaceNameProblem, type AiLinkResult, type ExistingFileChoice, type SetupKind, type UnpackResult,
} from '../utils/workspaceSetup';
import { SETUP_WORKSPACE_COMMAND } from '../utils/setupCommandIds';
import { aiMergeDriverSummary, checkAiMergeDrivers, setUpAiMergeDrivers, type AiMergeDriverReport } from '../utils/aiMergeDriverSetup';

export { SETUP_WORKSPACE_COMMAND };

/** The template inside the installed extension. */
export const TEMPLATE_ZIP = path.join('resources', 'workspace_template.zip');
/** The configuration in the unpacked folder: it carries the build machine's settings. */
export const TEMPLATE_CONFIG = path.join('.tom', 'tom_vscode_extension.json');
/** The introduction quest's workspace in the unpacked folder (when the template has the quest). */
export const INTRO_WORKSPACE = path.join('_ai', 'quests', 'tomai_introduction', 'tomai_introduction.code-workspace');

/** What to open once the folder is set up. */
export type OpenChoice = 'intro' | 'folder' | 'stay';

/** The user-facing steps of the setup. */
export interface SetupUi {
    /**
     * Which of the three setups (a two-part template only); undefined when the
     * user closed the choice. A UI without it makes the standalone setup.
     */
    askSetupKind?(): Promise<SetupKind | undefined>;
    /** The first workspace folder's name below the new root; undefined when the user closed the box. */
    askWorkspaceName?(root: string): Promise<string | undefined>;
    /** The folder to set up; undefined when the user closed the dialog. */
    pickFolder(): Promise<string | undefined>;
    /** The folder is not empty: set up anyway? */
    confirmNonEmpty(folder: string, entries: string[]): Promise<boolean>;
    /** A file of the template exists in the folder. */
    askExisting(entryPath: string): Promise<ExistingFileChoice>;
    /** What was written, overwritten and skipped. */
    showReport(result: UnpackResult, folder: string): Promise<void>;
    /** The configuration carries the build machine's settings and paths. */
    showConfigNote(configFile: string): Promise<void>;
    /**
     * The `_ai` merge drivers are not all this extension's (vscimpb142c): register them for the `_ai`
     * repository (`local`, only offered when `_ai` is in one), for every repository (`global`), or not.
     * Optional: a UI without it skips the offer.
     */
    askMergeDrivers?(report: AiMergeDriverReport): Promise<'local' | 'global' | 'skip'>;
    /** What to open; `introAvailable` false leaves the introduction quest out. */
    askWhatToOpen(introAvailable: boolean): Promise<OpenChoice>;
    showError(message: string): Promise<void>;
}

export type SetupOutcome =
    | { status: 'missingTemplate' | 'badTemplate'; error: string }
    | { status: 'noFolder' }
    | { status: 'noRoot'; folder: string; error: string }
    | { status: 'declined'; folder: string }
    | { status: 'cancelled'; folder: string; result: UnpackResult }
    | { status: 'done'; folder: string; result: UnpackResult; opened: OpenChoice; kind?: SetupKind; workspaceFolder?: string; aiLink?: AiLinkResult };

/** The setup, start to end. */
export async function runSetupWorkspaceFolder(extensionPath: string, ui: SetupUi = vscodeSetupUi()): Promise<SetupOutcome> {
    const zipFile = path.join(extensionPath, TEMPLATE_ZIP);
    if (!fs.existsSync(zipFile)) {
        const error = `The workspace template is missing: ${zipFile} does not exist. `
            + 'This build of the extension was packaged without it; build the VSIX again (compile_and_install or create_vsix).';
        await ui.showError(error);
        return { status: 'missingTemplate', error };
    }
    let all: ZipEntry[];
    try {
        all = readZip(fs.readFileSync(zipFile));
    } catch (e) {
        const error = `The workspace template ${zipFile} cannot be read: ${e instanceof Error ? e.message : String(e)}`;
        await ui.showError(error);
        return { status: 'badTemplate', error };
    }
    const twoParts = isTwoPartTemplate(all);
    let kind: SetupKind | undefined;
    if (twoParts) {
        kind = ui.askSetupKind ? await ui.askSetupKind() : 'standalone';
        if (!kind) { return { status: 'noFolder' }; }
    }

    const folder = await ui.pickFolder();
    if (!folder) { return { status: 'noFolder' }; }
    // A workspace folder in an existing root: refused outside one, before anything is written.
    let root = folder;
    if (kind === 'workspace') {
        const above = findRootAbove(folder);
        if (!above || !fs.existsSync(path.join(above, '_ai'))) {
            const error = above
                ? `${above} is a root (.tom/tom_root.yaml) without an _ai folder to link to: set the root up first (a new root with a first workspace folder).`
                : `${folder} is not inside a root: no folder above it has .tom/tom_root.yaml. Pick a folder inside a root, or set up a new root or a standalone workspace folder.`;
            await ui.showError(error);
            return { status: 'noRoot', folder, error };
        }
        root = above;
    }
    const existing = folderEntries(folder);
    if (existing.length > 0 && !await ui.confirmNonEmpty(folder, existing)) {
        return { status: 'declined', folder };
    }
    // A new root: the first workspace folder's name.
    let wsFolder = folder;
    if (kind === 'root') {
        const name = ui.askWorkspaceName ? await ui.askWorkspaceName(folder) : 'workspace';
        if (name === undefined || workspaceNameProblem(name)) { return { status: 'declined', folder }; }
        wsFolder = path.join(folder, name.trim());
    }

    // What goes where.
    const plan: Array<{ entries: ZipEntry[]; dir: string }> = !twoParts
        ? [{ entries: all, dir: folder }]
        : kind === 'root'
            ? [{ entries: partEntries(all, 'root'), dir: folder }, { entries: partEntries(all, 'workspace', rootTokenFor(wsFolder, folder)), dir: wsFolder }]
            : kind === 'workspace'
                ? [{ entries: partEntries(all, 'workspace', rootTokenFor(folder, root)), dir: folder }]
                : [{ entries: standaloneEntries(all), dir: folder }];
    let result: UnpackResult = { written: [], overwritten: [], skipped: [], cancelled: false };
    let forAll: ExistingFileChoice | undefined;
    for (const step of plan) {
        const prefix = step.dir === folder ? '' : `${path.relative(folder, step.dir).split(path.sep).join('/')}/`;
        const r = await unpackTemplate(step.entries, step.dir, async (p) => {
            if (forAll) { return forAll; }
            const choice = await ui.askExisting(`${prefix}${p}`);
            if (choice === 'overwriteAll' || choice === 'skipAll') { forAll = choice; }
            return choice;
        });
        result = {
            written: [...result.written, ...r.written.map((p) => `${prefix}${p}`)],
            overwritten: [...result.overwritten, ...r.overwritten.map((p) => `${prefix}${p}`)],
            skipped: [...result.skipped, ...r.skipped.map((p) => `${prefix}${p}`)],
            cancelled: r.cancelled,
        };
        if (r.cancelled) { break; }
    }
    await ui.showReport(result, folder);
    if (result.cancelled) { return { status: 'cancelled', folder, result }; }

    // The workspace folder's _ai: a link to the root's.
    let aiLink: AiLinkResult | undefined;
    if (kind === 'root' || kind === 'workspace') {
        try {
            aiLink = linkAi(wsFolder, root);
        } catch (e) {
            await ui.showError(`The workspace folder's _ai could not be linked to ${path.join(root, '_ai')}: ${(e as Error).message}`);
        }
    }
    // A new root: the introduction quest's workspace (the first quest), opened through the workspace folder's _ai.
    if (kind === 'root') {
        const questFolder = path.join(folder, path.dirname(INTRO_WORKSPACE));
        if (fs.existsSync(questFolder) && !fs.existsSync(path.join(folder, INTRO_WORKSPACE))) {
            fs.writeFileSync(path.join(folder, INTRO_WORKSPACE), questCodeWorkspaceText());
        }
    }

    const config = path.join(root, TEMPLATE_CONFIG);
    if (fs.existsSync(config) && kind !== 'workspace') { await ui.showConfigNote(config); }

    // The _ai merge drivers (vscimpb142c): registered in git and bound in _ai/.gitattributes, if wanted.
    const aiRoot = path.join(root, '_ai');
    if (ui.askMergeDrivers && fs.existsSync(aiRoot)) {
        try {
            const report = checkAiMergeDrivers(aiRoot);
            if (!report.ok) {
                const scope = await ui.askMergeDrivers(report);
                if (scope !== 'skip') { setUpAiMergeDrivers(aiRoot, scope); }
            }
        } catch (e) {
            await ui.showError(`The _ai merge drivers were not registered: ${(e as Error).message}`);
        }
    }

    // The introduction quest is opened through the workspace folder (its _ai), so its window's folder is the workspace folder.
    const intro = path.join(wsFolder, INTRO_WORKSPACE);
    const introAvailable = fs.existsSync(intro);
    let opened = await ui.askWhatToOpen(introAvailable);
    if (opened === 'intro' && !introAvailable) { opened = 'stay'; }
    if (opened !== 'stay') {
        await vscode.commands.executeCommand('vscode.openFolder', vscode.Uri.file(opened === 'intro' ? intro : wsFolder), { forceNewWindow: true });
    }
    return { status: 'done', folder, result, opened, ...(kind ? { kind } : {}), ...(wsFolder !== folder ? { workspaceFolder: wsFolder } : {}), ...(aiLink ? { aiLink } : {}) };
}

// ── The VS Code dialogs ─────────────────────────────────────────────────────────

export const NON_EMPTY_CONTINUE = 'Set up anyway';
export const EXISTING_BUTTONS: Record<Exclude<ExistingFileChoice, 'cancel'>, string> = {
    overwrite: 'Overwrite',
    skip: 'Skip',
    overwriteAll: 'Overwrite All',
    skipAll: 'Skip All',
};
export const SHOW_FILE_LIST = 'Show the file list';
export const OPEN_CONFIG = 'Open the configuration';
export const OPEN_BUTTONS: Record<OpenChoice, string> = {
    intro: 'Open the introduction quest',
    folder: 'Open the folder',
    stay: 'Stay here',
};
export const SETUP_KIND_ITEMS: Array<{ kind: SetupKind; label: string; detail: string }> = [
    { kind: 'root', label: 'A new root with a first workspace folder', detail: 'The root (.tom with tom_root.yaml, the shared guidelines, _ai) in the folder you pick, the workspace folder in a subfolder, its _ai linked to the root\'s' },
    { kind: 'workspace', label: 'A workspace folder in an existing root', detail: 'The folder you pick must lie inside a root (a folder above it with .tom/tom_root.yaml); its _ai is linked to the root\'s' },
    { kind: 'standalone', label: 'A standalone workspace folder', detail: 'Root and workspace folder in one: no tom_root.yaml, its own _ai and guidelines' },
];

/** Most names a dialog lists before "and N more". */
const LIST_LIMIT = 20;

function shortList(names: string[]): string {
    const shown = names.slice(0, LIST_LIMIT).map((n) => `• ${n}`);
    if (names.length > LIST_LIMIT) { shown.push(`… and ${names.length - LIST_LIMIT} more`); }
    return shown.join('\n');
}

/** The setup's steps as VS Code dialogs. A modal's own Cancel (or Escape) is the "Cancel" answer. */
export function vscodeSetupUi(): SetupUi {
    return {
        async askSetupKind() {
            const picked = await vscode.window.showQuickPick(
                SETUP_KIND_ITEMS.map((i) => ({ label: i.label, detail: i.detail, setup: i.kind })),
                { title: 'Setup New Workspace Folder: what to set up', placeHolder: 'Choose the setup', ignoreFocusOut: true },
            );
            return picked?.setup;
        },
        async askWorkspaceName(root) {
            return vscode.window.showInputBox({
                title: 'Setup New Workspace Folder: the first workspace folder',
                prompt: `The workspace folder's name: a subfolder of ${root}`,
                value: 'workspace',
                validateInput: (v) => workspaceNameProblem(v) ?? null,
                ignoreFocusOut: true,
            });
        },
        async pickFolder() {
            const picked = await vscode.window.showOpenDialog({
                canSelectFolders: true,
                canSelectFiles: false,
                canSelectMany: false,
                openLabel: 'Set up here',
                title: 'Setup New Workspace Folder: choose or create the folder',
            });
            return picked?.[0]?.fsPath;
        },
        async confirmNonEmpty(folder, entries) {
            const answer = await vscode.window.showWarningMessage(
                `${folder} is not empty.`,
                { modal: true, detail: `It holds:\n${shortList(entries)}\n\nFor every template file that already exists you are asked whether to overwrite it.` },
                NON_EMPTY_CONTINUE,
            );
            return answer === NON_EMPTY_CONTINUE;
        },
        async askExisting(entryPath) {
            const answer = await vscode.window.showWarningMessage(
                `${entryPath} already exists.`,
                { modal: true, detail: 'Overwrite it with the template\'s file, or keep it? "All" applies to every later file that exists; Cancel stops (the files written so far stay).' },
                ...Object.values(EXISTING_BUTTONS),
            );
            const choice = (Object.keys(EXISTING_BUTTONS) as Array<keyof typeof EXISTING_BUTTONS>).find((k) => EXISTING_BUTTONS[k] === answer);
            return choice ?? 'cancel';
        },
        async showReport(result, folder) {
            const detail = [
                result.overwritten.length > 0 ? `Overwritten:\n${shortList(result.overwritten)}` : '',
                result.skipped.length > 0 ? `Skipped:\n${shortList(result.skipped)}` : '',
            ].filter(Boolean).join('\n\n');
            const answer = await vscode.window.showInformationMessage(unpackSummary(result), { modal: true, detail: detail || undefined }, SHOW_FILE_LIST);
            if (answer === SHOW_FILE_LIST) {
                const doc = await vscode.workspace.openTextDocument({ language: 'markdown', content: unpackReport(result, folder) });
                await vscode.window.showTextDocument(doc, { preview: false });
            }
        },
        async showConfigNote(configFile) {
            const answer = await vscode.window.showWarningMessage(
                'The configuration comes from the machine the extension was built on.',
                {
                    modal: true,
                    detail: `${configFile} carries that machine's settings and paths. Adapt them to this one:\n`
                        + '• the bridge profiles\' paths (bridge.profiles)\n'
                        + '• the Dart binaries (bridge.executables)\n'
                        + '• the Local LLM endpoint\n'
                        + '• the environment variable holding your Anthropic API key',
                },
                OPEN_CONFIG,
            );
            if (answer === OPEN_CONFIG) {
                await vscode.window.showTextDocument(vscode.Uri.file(configFile), { preview: false });
            }
        },
        async askMergeDrivers(report) {
            const local = 'For this _ai repository';
            const global = 'For all repositories (global)';
            const buttons = report.repoRoot ? [local, global] : [global];
            const answer = await vscode.window.showInformationMessage(
                'Register Tom AI\'s _ai merge drivers in git?',
                {
                    modal: true,
                    detail: 'Git merges the _ai files (todos, trails, histories) with them when a pull brings two copies together; '
                        + 'without them it merges line by line and can lose entries. The rules go into _ai/.gitattributes.\n\n'
                        + aiMergeDriverSummary(report).join('\n'),
                },
                ...buttons,
            );
            return answer === local ? 'local' : answer === global ? 'global' : 'skip';
        },
        async askWhatToOpen(introAvailable) {
            const choices: OpenChoice[] = introAvailable ? ['intro', 'folder', 'stay'] : ['folder', 'stay'];
            const answer = await vscode.window.showInformationMessage(
                'The workspace folder is set up. What do you want to open?',
                {
                    modal: true,
                    detail: introAvailable
                        ? 'The introduction quest walks you through the extension. Both open in a new window.'
                        : 'The folder opens in a new window.',
                },
                ...choices.map((c) => OPEN_BUTTONS[c]),
            );
            return choices.find((c) => OPEN_BUTTONS[c] === answer) ?? 'stay';
        },
        async showError(message) {
            await vscode.window.showErrorMessage(message);
        },
    };
}

/** Register the command; called in full and in minimal mode (a folder without `.tom/` needs it most). */
export function registerSetupWorkspaceFolderCommand(context: vscode.ExtensionContext): void {
    context.subscriptions.push(vscode.commands.registerCommand(SETUP_WORKSPACE_COMMAND, async () => {
        await runSetupWorkspaceFolder(context.extensionPath);
    }));
}
