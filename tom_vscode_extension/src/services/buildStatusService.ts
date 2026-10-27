/**
 * Does this window run the installed build of the extension?
 *
 * The running build is read once at activation (src/utils/buildStamp.ts); the
 * installed one on every check — each window heartbeat (30 s) and whenever the
 * window gains focus. When a newer build is installed, a status-bar item says
 * so and reloads the window on click. Nothing reloads by itself: a reload ends
 * a queue send that is running.
 *
 * The status is also in the window's heartbeat (the WINDOW STATUS view,
 * tomAi_getQuestWindowStatus), on the Status Page and in
 * tomAi_getWorkspaceInfo, so an agent can stop a live check with "reload
 * first" instead of testing old code.
 */

import * as path from 'path';
import * as vscode from 'vscode';
import { buildLabel, compareBuilds, findInstalledExtensionRoot, readBuildStamp, type BuildStamp, type BuildStatus } from '../utils/buildStamp';

let runningRoot = '';
let extensionId = '';
let running: BuildStamp | undefined;
let item: vscode.StatusBarItem | undefined;
let last: BuildStatus | undefined;

/** Read the running build and start watching for a newer installed one. */
export function initBuildStatus(context: vscode.ExtensionContext): void {
    runningRoot = context.extensionPath;
    extensionId = context.extension.id;
    running = readBuildStamp(runningRoot);
    item = vscode.window.createStatusBarItem('tomAi.buildStatus', vscode.StatusBarAlignment.Left, 50);
    item.name = 'Tom AI: newer build installed';
    item.command = 'workbench.action.reloadWindow';
    context.subscriptions.push(item);
    context.subscriptions.push(vscode.window.onDidChangeWindowState((state) => {
        if (state.focused) { checkBuildStatus(); }
    }));
    checkBuildStatus();
}

/**
 * Compare the running build with the installed one now, and show the result;
 * undefined outside an activated window (nothing is known there).
 */
export function checkBuildStatus(): BuildStatus | undefined {
    if (!runningRoot) { return undefined; }
    const installedRoot = findInstalledExtensionRoot(path.dirname(runningRoot), extensionId, runningRoot);
    last = compareBuilds(running, readBuildStamp(installedRoot));
    if (item) {
        if (last.reloadNeeded) {
            item.text = '$(debug-restart) Reload: newer Tom AI build';
            item.tooltip = `This window runs ${buildLabel(last.running)}; installed is ${buildLabel(last.installed)}.\n`
                + 'Click to reload the window (a queue send that is running is ended).';
            item.backgroundColor = new vscode.ThemeColor('statusBarItem.warningBackground');
            item.show();
        } else {
            item.hide();
        }
    }
    return last;
}

/** The last result of {@link checkBuildStatus} (undefined before activation). */
export function currentBuildStatus(): BuildStatus | undefined {
    return last;
}
