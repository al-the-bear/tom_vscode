/**
 * AI Workspace Quests (vscimpb144): which quests this workspace works on —
 * `_ai/workspaces/<workspace>.yaml` (utils/aiWorkspace.ts). Every quest of
 * `_ai/quests/` with a checkbox and its short description
 * (`short_description.<quest>.md`); **Save** writes the list (creating the
 * file), **All quests** removes it (the workspace then has every quest),
 * **Open the file** shows it in a text editor. Listed quests that no longer
 * exist are named.
 *
 * Command: `tomAi.editor.aiWorkspaceQuests`. Assets: `media/aiWorkspaceQuests/`.
 */

import * as path from 'path';
import * as vscode from 'vscode';

import { listQuestIds } from '../managers/questTodoManager';
import { questShortDescription, windowAiWorkspaceName } from '../services/aiWorkspaceLive';
import { aiWorkspaceFile, resolveWorkspaceQuests, writeAiWorkspaceQuests } from '../utils/aiWorkspace';
import { loadWebviewHtml } from '../utils/webviewLoader';
import { WsPaths } from '../utils/workspacePaths';

export const AI_WORKSPACE_QUESTS_COMMAND = 'tomAi.editor.aiWorkspaceQuests';

/** What the page shows. */
export interface AiWorkspaceQuestsState {
    workspace: string;
    /** Workspace-relative path of the file. */
    file: string;
    fileExists: boolean;
    /** The file lists quests (else the workspace has every quest). */
    listed: boolean;
    quests: Array<{ id: string; checked: boolean; shortDescription?: string }>;
    unknown: string[];
    error?: string;
    message?: string;
}

/** What the editor reads and writes (a test may stand in). */
export interface AiWorkspaceQuestsDeps {
    aiRoot(): string | undefined;
    workspace(): string | undefined;
    allQuests(): string[];
    shortDescription(quest: string): string | undefined;
    /** For the workspace-relative file name. */
    workspaceRoot(): string | undefined;
}

export const liveAiWorkspaceQuestsDeps: AiWorkspaceQuestsDeps = {
    aiRoot: () => WsPaths.aiRoot,
    workspace: () => windowAiWorkspaceName(),
    allQuests: () => listQuestIds(),
    shortDescription: (q) => questShortDescription(q),
    workspaceRoot: () => vscode.workspace.workspaceFolders?.[0]?.uri.fsPath,
};

/** The page's state; undefined without `_ai` or a workspace folder. */
export function aiWorkspaceQuestsState(d: AiWorkspaceQuestsDeps, message?: string): AiWorkspaceQuestsState | undefined {
    const aiRoot = d.aiRoot();
    const workspace = d.workspace();
    if (!aiRoot || !workspace) { return undefined; }
    const all = d.allQuests();
    const ws = resolveWorkspaceQuests(aiRoot, workspace, all);
    const listed = ws.source === 'list';
    const checked = new Set(listed ? ws.quests : []);
    const root = d.workspaceRoot();
    const file = root ? path.relative(root, ws.file).split(path.sep).join('/') : ws.file;
    return {
        workspace, file, fileExists: ws.fileExists, listed,
        quests: [...all].sort().map((id) => {
            const shortDescription = d.shortDescription(id);
            return { id, checked: checked.has(id), ...(shortDescription ? { shortDescription } : {}) };
        }),
        unknown: ws.unknown,
        ...(ws.error ? { error: ws.error } : {}),
        ...(message ? { message } : {}),
    };
}

/**
 * Save: the ticked quests become the list (a listed quest that does not exist stays when `keepUnknown`);
 * `quests: undefined` (All quests) removes the list. Answers the message to show.
 */
export function saveAiWorkspaceQuests(d: AiWorkspaceQuestsDeps, quests: string[] | undefined, keepUnknown = true): string {
    const aiRoot = d.aiRoot();
    const workspace = d.workspace();
    if (!aiRoot || !workspace) { return 'No _ai folder or no workspace folder: nothing saved.'; }
    if (quests === undefined) {
        writeAiWorkspaceQuests(aiRoot, workspace, undefined);
        return `Saved: ${workspace} has every quest (no list).`;
    }
    const all = new Set(d.allQuests());
    const unknown = keepUnknown ? resolveWorkspaceQuests(aiRoot, workspace, [...all]).unknown : [];
    const list = [...quests.filter((q) => all.has(q)), ...unknown];
    writeAiWorkspaceQuests(aiRoot, workspace, list);
    return `Saved: ${workspace} has ${quests.filter((q) => all.has(q)).length} quest(s).`;
}

let panel: vscode.WebviewPanel | undefined;

/** Open (or bring up) the editor. */
export function openAiWorkspaceQuestsEditor(context: vscode.ExtensionContext, deps: AiWorkspaceQuestsDeps = liveAiWorkspaceQuestsDeps): void {
    const state = aiWorkspaceQuestsState(deps);
    if (!state) {
        void vscode.window.showWarningMessage('AI Workspace Quests: this window has no _ai folder or no workspace folder.');
        return;
    }
    if (panel) {
        panel.reveal();
        void panel.webview.postMessage({ type: 'state', state });
        return;
    }
    panel = vscode.window.createWebviewPanel('tomAi.aiWorkspaceQuests', 'AI Workspace Quests', vscode.ViewColumn.Active, {
        enableScripts: true,
        retainContextWhenHidden: true,
        localResourceRoots: [vscode.Uri.joinPath(context.extensionUri, 'media')],
    });
    panel.webview.html = loadWebviewHtml(panel.webview, 'aiWorkspaceQuests', { init: state as unknown as Record<string, unknown> });
    panel.onDidDispose(() => { panel = undefined; });
    panel.webview.onDidReceiveMessage(async (msg: { type?: string; quests?: unknown }) => {
        const view = panel?.webview;
        if (!view) { return; }
        switch (msg.type) {
            case 'save': {
                const quests = Array.isArray(msg.quests) ? msg.quests.filter((q): q is string => typeof q === 'string') : [];
                await view.postMessage({ type: 'state', state: aiWorkspaceQuestsState(deps, saveAiWorkspaceQuests(deps, quests)) });
                return;
            }
            case 'allQuests':
                await view.postMessage({ type: 'state', state: aiWorkspaceQuestsState(deps, saveAiWorkspaceQuests(deps, undefined)) });
                return;
            case 'refresh':
                await view.postMessage({ type: 'state', state: aiWorkspaceQuestsState(deps) });
                return;
            case 'openFile': {
                const aiRoot = deps.aiRoot();
                const workspace = deps.workspace();
                if (!aiRoot || !workspace) { return; }
                const file = aiWorkspaceFile(aiRoot, workspace);
                const fs = await import('fs');
                if (!fs.existsSync(file)) {
                    void vscode.window.showInformationMessage(`${path.basename(file)} does not exist yet: Save writes it.`);
                    return;
                }
                await vscode.window.showTextDocument(vscode.Uri.file(file), { preview: false });
                return;
            }
        }
    }, undefined, context.subscriptions);
}

export function registerAiWorkspaceQuestsEditor(context: vscode.ExtensionContext): void {
    context.subscriptions.push(vscode.commands.registerCommand(AI_WORKSPACE_QUESTS_COMMAND, () => openAiWorkspaceQuestsEditor(context)));
}
