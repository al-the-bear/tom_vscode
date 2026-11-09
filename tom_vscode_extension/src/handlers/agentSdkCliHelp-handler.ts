/**
 * The page about a missing Agent SDK (services/agentSdkCli.ts): the command
 * tomAi.showAgentSdkCliHelp, and the notice the Agent SDK transport gives when
 * the Anthropic provider's SDK or its Claude CLI for this platform is not
 * installed (an error with "Install provider SDKs" and "What does this
 * mean?", at most once per window session — every prompt still fails with
 * the message in its answer).
 */

import * as path from 'path';
import * as vscode from 'vscode';
import { AGENT_SDK_CLI_HELP_COMMAND, AGENT_SDK_CLI_HELP_PAGE, fillAgentSdkCliPage } from '../services/agentSdkCli';
import { HELP_BUTTON_LABEL, previewPage, writeFilledPage } from './helpPages';
import { PROVIDER_SDKS_COMMAND } from '../services/providerRuntime';

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

/** The notice's button that opens the Provider SDKs page. */
export const INSTALL_PROVIDER_BUTTON = 'Install provider SDKs';

/**
 * Tell the user the transport cannot run here (the provider SDK or its CLI is
 * not installed): once per window session, with **Install provider SDKs**
 * (the Provider SDKs page) and "What does this mean?" (the page about it).
 */
export function noteAgentSdkCliMissing(message: string): void {
    if (noticeShown) { return; }
    noticeShown = true;
    void (async () => {
        const picked = await vscode.window.showErrorMessage(message, INSTALL_PROVIDER_BUTTON, HELP_BUTTON_LABEL);
        if (picked === INSTALL_PROVIDER_BUTTON) { await vscode.commands.executeCommand(PROVIDER_SDKS_COMMAND); }
        if (picked === HELP_BUTTON_LABEL) { await showAgentSdkCliHelp(); }
    })();
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
