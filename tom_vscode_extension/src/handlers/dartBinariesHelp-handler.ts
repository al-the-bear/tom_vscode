/**
 * The page about missing Dart binaries (services/dartBinariesStatus.ts): the
 * command tomAi.showDartBinariesHelp, the status-bar hint, and opening the page
 * once per extension build and platform when a binary is missing.
 *
 * The page is filled for this platform into a copy under the extension's
 * global storage and shown with `markdown.showPreview`, which also renders a
 * file outside the workspace.
 */

import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';
import {
    currentDartBinariesStatus,
    DART_BINARY_FEATURE,
    fillHelpPage,
    HELP_COMMAND,
    HELP_PAGE_TEMPLATE,
    helpPageKey,
    rememberHelpPage,
    setDartBinariesExtensionRoot,
    setFilledHelpPagePath,
    shouldOpenHelpPage,
    type DartBinariesStatus,
} from '../services/dartBinariesStatus';
import { readBuildStamp } from '../utils/buildStamp';
import { reportException } from './handler_shared';

/** globalState key: the (build, platform) keys the page was opened for. */
export const HELP_SHOWN_STATE_KEY = 'tomAi.dartBinariesHelp.shown';
export const HELP_BUTTON_LABEL = 'What does this mean?';

let extensionRoot = '';
let storageDir = '';
let item: vscode.StatusBarItem | undefined;

/** Write the page filled for this window's status; answers its path. */
export function writeFilledHelpPage(status: DartBinariesStatus = currentDartBinariesStatus(extensionRoot || undefined)): string {
    const template = fs.readFileSync(path.join(extensionRoot, HELP_PAGE_TEMPLATE), 'utf8');
    const target = path.join(storageDir, 'dart_binaries', 'missing_dart_binaries.md');
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, fillHelpPage(template, status, extensionRoot), 'utf8');
    setFilledHelpPagePath(target);
    return target;
}

/** Open the page, filled for what is missing now. */
export async function showDartBinariesHelp(): Promise<void> {
    const status = currentDartBinariesStatus(extensionRoot || undefined);
    updateStatusBar(status);
    const file = writeFilledHelpPage(status);
    await vscode.commands.executeCommand('markdown.showPreview', vscode.Uri.file(file));
}

/**
 * The button errors and warnings about a missing binary carry: its label and
 * what it does (showWithDartBinariesHelp puts it on a message).
 */
export function dartBinariesHelpAction(): { label: string; run: () => Promise<void> } {
    return { label: HELP_BUTTON_LABEL, run: showDartBinariesHelp };
}

/** Show `message` (error or warning) with the help button; the click opens the page. */
export async function showWithDartBinariesHelp(kind: 'error' | 'warning', message: string): Promise<void> {
    const action = dartBinariesHelpAction();
    const show = kind === 'error' ? vscode.window.showErrorMessage : vscode.window.showWarningMessage;
    const picked = await show(message, action.label);
    if (picked === action.label) { await action.run(); }
}

function updateStatusBar(status: DartBinariesStatus): void {
    if (!item) { return; }
    if (status.missing.length === 0) { item.hide(); return; }
    item.text = '$(warning) Dart binaries missing';
    item.tooltip = `${status.missing.map((n) => `${n} (${DART_BINARY_FEATURE[n]})`).join(' and ')} not available on ${status.platform}. Click for what this means.`;
    item.show();
}

/**
 * At activation: register the command and the status-bar hint, write the
 * filled page, and open it when a binary is missing and this build has not
 * shown it on this platform before.
 */
export function initDartBinariesHelp(context: vscode.ExtensionContext): void {
    extensionRoot = context.extensionPath;
    setDartBinariesExtensionRoot(extensionRoot);
    storageDir = context.globalStorageUri.fsPath;
    context.subscriptions.push(vscode.commands.registerCommand(HELP_COMMAND, showDartBinariesHelp));
    item = vscode.window.createStatusBarItem('tomAi.dartBinaries', vscode.StatusBarAlignment.Left, 49);
    item.name = 'Tom AI: Dart binaries missing';
    item.command = HELP_COMMAND;
    context.subscriptions.push(item);
    try {
        const status = currentDartBinariesStatus(extensionRoot);
        updateStatusBar(status);
        const page = writeFilledHelpPage(status);
        const key = helpPageKey(readBuildStamp(extensionRoot), status.platform);
        const shown = context.globalState.get<string[]>(HELP_SHOWN_STATE_KEY);
        if (shouldOpenHelpPage(status, shown, key)) {
            void context.globalState.update(HELP_SHOWN_STATE_KEY, rememberHelpPage(shown, key));
            void vscode.commands.executeCommand('markdown.showPreview', vscode.Uri.file(page));
        }
    } catch (error) {
        reportException('dartBinariesHelp.init', error);
    }
}
