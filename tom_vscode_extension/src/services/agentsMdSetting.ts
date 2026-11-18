/**
 * `chat.useAgentsMdFile: true` in the open `.code-workspace` (workspace layout
 * DP-part-claude-4 (b)): Copilot then reads the workspace folder's AGENTS.md.
 * The extension writes it into every `.code-workspace` it creates; for one
 * that lacks it the status page's Configuration Errors say so and offer to add
 * it (written into the `.code-workspace` through VS Code's settings API).
 */

import * as vscode from 'vscode';

export const USE_AGENTS_MD_SETTING = 'useAgentsMdFile';

/** The open `.code-workspace` file's path, when the window has one. */
function openCodeWorkspace(): string | undefined {
    const file = vscode.workspace.workspaceFile;
    return file && file.scheme === 'file' && file.fsPath.endsWith('.code-workspace') ? file.fsPath : undefined;
}

/** The Configuration Errors line when the open `.code-workspace` lacks `chat.useAgentsMdFile: true`; undefined otherwise. */
export function useAgentsMdFileProblem(): string | undefined {
    const file = openCodeWorkspace();
    if (!file) { return undefined; }
    const value = vscode.workspace.getConfiguration('chat').inspect<boolean>(USE_AGENTS_MD_SETTING)?.workspaceValue;
    if (value === true) { return undefined; }
    return `${file} does not set "chat.useAgentsMdFile": true, so Copilot does not read the workspace folder's AGENTS.md. Use "Add chat.useAgentsMdFile" to add it.`;
}

/** Add `chat.useAgentsMdFile: true` to the open `.code-workspace`. Answers whether it was written. */
export async function addUseAgentsMdFile(): Promise<boolean> {
    if (!openCodeWorkspace()) { return false; }
    await vscode.workspace.getConfiguration('chat').update(USE_AGENTS_MD_SETTING, true, vscode.ConfigurationTarget.Workspace);
    return true;
}
