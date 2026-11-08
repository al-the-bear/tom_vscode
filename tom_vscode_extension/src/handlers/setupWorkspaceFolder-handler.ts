/**
 * "@T: Setup New Workspace Folder" (`tomAi.setupWorkspaceFolder`): unpack the
 * workspace template the VSIX carries (`resources/workspace_template.zip`,
 * scripts/build-workspace-template.cjs) into a folder the user picks, then say
 * what in the configuration to adapt and offer what to open.
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
import { folderEntries, unpackReport, unpackSummary, unpackTemplate, type ExistingFileChoice, type UnpackResult } from '../utils/workspaceSetup';

export const SETUP_WORKSPACE_COMMAND = 'tomAi.setupWorkspaceFolder';
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
    /** What to open; `introAvailable` false leaves the introduction quest out. */
    askWhatToOpen(introAvailable: boolean): Promise<OpenChoice>;
    showError(message: string): Promise<void>;
}

export type SetupOutcome =
    | { status: 'missingTemplate' | 'badTemplate'; error: string }
    | { status: 'noFolder' }
    | { status: 'declined'; folder: string }
    | { status: 'cancelled'; folder: string; result: UnpackResult }
    | { status: 'done'; folder: string; result: UnpackResult; opened: OpenChoice };

/** The setup, start to end. */
export async function runSetupWorkspaceFolder(extensionPath: string, ui: SetupUi = vscodeSetupUi()): Promise<SetupOutcome> {
    const zipFile = path.join(extensionPath, TEMPLATE_ZIP);
    if (!fs.existsSync(zipFile)) {
        const error = `The workspace template is missing: ${zipFile} does not exist. `
            + 'This build of the extension was packaged without it; build the VSIX again (compile_and_install or create_vsix).';
        await ui.showError(error);
        return { status: 'missingTemplate', error };
    }
    let entries: ZipEntry[];
    try {
        entries = readZip(fs.readFileSync(zipFile));
    } catch (e) {
        const error = `The workspace template ${zipFile} cannot be read: ${e instanceof Error ? e.message : String(e)}`;
        await ui.showError(error);
        return { status: 'badTemplate', error };
    }

    const folder = await ui.pickFolder();
    if (!folder) { return { status: 'noFolder' }; }
    const existing = folderEntries(folder);
    if (existing.length > 0 && !await ui.confirmNonEmpty(folder, existing)) {
        return { status: 'declined', folder };
    }

    const result = await unpackTemplate(entries, folder, (p) => ui.askExisting(p));
    await ui.showReport(result, folder);
    if (result.cancelled) { return { status: 'cancelled', folder, result }; }

    const config = path.join(folder, TEMPLATE_CONFIG);
    if (fs.existsSync(config)) { await ui.showConfigNote(config); }

    const intro = path.join(folder, INTRO_WORKSPACE);
    const introAvailable = fs.existsSync(intro);
    let opened = await ui.askWhatToOpen(introAvailable);
    if (opened === 'intro' && !introAvailable) { opened = 'stay'; }
    if (opened !== 'stay') {
        await vscode.commands.executeCommand('vscode.openFolder', vscode.Uri.file(opened === 'intro' ? intro : folder), { forceNewWindow: true });
    }
    return { status: 'done', folder, result, opened };
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
