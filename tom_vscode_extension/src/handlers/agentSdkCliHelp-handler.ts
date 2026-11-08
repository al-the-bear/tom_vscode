/**
 * The page about a missing Agent SDK CLI (services/agentSdkCli.ts): the
 * command tomAi.showAgentSdkCliHelp, and the notice the Agent SDK transport
 * gives when it cannot run on this platform (an error with "What does this
 * mean?", at most once per window session — every prompt still fails with the
 * message in its answer).
 */

import * as path from 'path';
import * as vscode from 'vscode';
import { AGENT_SDK_CLI_HELP_COMMAND, AGENT_SDK_CLI_HELP_PAGE, fillAgentSdkCliPage } from '../services/agentSdkCli';
import { previewPage, showWithHelpButton, writeFilledPage } from './helpPages';

/** The extension root (this file is out/handlers/) until activation names it. */
let extensionRoot = path.resolve(__dirname, '..', '..');
let storageDir = '';
let noticeShown = false;

/** The page filled for this platform (the extension's own page before activation). */
export function agentSdkCliHelpPage(root: string = extensionRoot): string {
    return writeFilledPage(root, storageDir, AGENT_SDK_CLI_HELP_PAGE, (template) => fillAgentSdkCliPage(template));
}

export async function showAgentSdkCliHelp(): Promise<void> {
    await previewPage(agentSdkCliHelpPage());
}

/** Tell the user the transport cannot run here: once per window session. */
export function noteAgentSdkCliMissing(message: string): void {
    if (noticeShown) { return; }
    noticeShown = true;
    void showWithHelpButton('error', message, showAgentSdkCliHelp);
}

/** A test's fresh window session. */
export function resetAgentSdkCliNotice(): void {
    noticeShown = false;
}

export function initAgentSdkCliHelp(context: vscode.ExtensionContext): void {
    extensionRoot = context.extensionPath;
    storageDir = context.globalStorageUri.fsPath;
    context.subscriptions.push(vscode.commands.registerCommand(AGENT_SDK_CLI_HELP_COMMAND, showAgentSdkCliHelp));
}
