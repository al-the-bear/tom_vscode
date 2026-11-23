/**
 * The guideline selector's quest-default and all-windows actions (gsel4,
 * design L-3 / L-4), as commands and as functions the selector's buttons
 * (gsel5) call:
 *
 * - `@T: Set Guideline Choices as Quest Default` (`tomAi.setQuestDefaultGuidelines`):
 *   the window's choices become the quest default (the quest's shared
 *   `extension_config.<quest>.yaml`).
 * - `@T: Clear Quest Default Guideline Choices` (`tomAi.clearQuestDefaultGuidelines`):
 *   the quest default has no choices.
 * - `@T: Set Guideline Choices as Workspace Default` (`tomAi.setWorkspaceDefaultGuidelines`):
 *   the window's choices written into the window workspace folder's
 *   `workspace_aspects.md` / `.yaml` (the workspace level, gsel19).
 * - `@T: Clear Workspace Default Guideline Choices` (`tomAi.clearWorkspaceDefaultGuidelines`):
 *   those files keep only their free text.
 * - {@link setSectionChoiceForAllWindows}: one section's choice in this window
 *   and every other open window on this machine (services/windowRequests.ts
 *   `setAspectChoice`); only that section changes.
 * - {@link carryAspectChoicesOver}: a section or option renamed in the section
 *   editor (gsel7b) — the stored choices naming the old id carried over on every
 *   level this machine can reach: this window's memory, the files
 *   (services/aspectChoiceRename.ts), and every other open window on this
 *   machine (`renameAspectChoices`), which carries its own memory over.
 */

import * as vscode from 'vscode';

import { PromptQueueManager } from '../managers/promptQueueManager';
import { aspectRenameSummary, rewriteStoredAspectChoices } from '../services/aspectChoiceRename';
import { clearQuestDefault, openWindowsOnThisMachine, setQuestDefaultFromWindow, setSectionChoiceInAllWindows, setWindowSectionChoice } from '../services/aspectChoiceLevels';
import { sendWindowRequest, windowRequestsOwnWindow } from '../services/windowRequests';
import { clearLiveWorkspaceAspects, setWorkspaceFromWindow } from '../services/workspaceAspects';
import { getQueueFolder } from '../storage/queueFileStorage';
import { aspectRenameText, type AspectRename } from '../utils/aspectRename';
import { WsPaths } from '../utils/workspacePaths';
import { isWindowAlive } from '../utils/windowHeartbeat';
import { refreshAspectViews } from './aspectViewsRefresh';
import { loadAllWindowStates } from './windowStatusPanel-handler';

export const SET_QUEST_DEFAULT_GUIDELINES_COMMAND = 'tomAi.setQuestDefaultGuidelines';
export const CLEAR_QUEST_DEFAULT_GUIDELINES_COMMAND = 'tomAi.clearQuestDefaultGuidelines';

/** *Set as quest default*: answers the choices written (undefined: none, the quest default is cleared). */
export function setQuestDefaultGuidelines(): Record<string, string> | undefined {
    return setQuestDefaultFromWindow();
}

/** *Clear quest default*. */
export function clearQuestDefaultGuidelines(): void {
    clearQuestDefault();
}

export const SET_WORKSPACE_DEFAULT_GUIDELINES_COMMAND = 'tomAi.setWorkspaceDefaultGuidelines';
export const CLEAR_WORKSPACE_DEFAULT_GUIDELINES_COMMAND = 'tomAi.clearWorkspaceDefaultGuidelines';

/** *Set as workspace default*: the window's choices into the window workspace folder's files; answers a message. Throws without a workspace folder. */
export function setWorkspaceDefaultGuidelines(): string {
    const done = setWorkspaceFromWindow();
    if (!done) { throw new Error('this window has no Tom workspace folder'); }
    const skipped = done.skipped.length ? ` Not written (no such choice): ${done.skipped.join(', ')}.` : '';
    return `Workspace guideline choices written to ${done.written.map((f) => f.split(/[\\/]/).pop()).join(' and ')} in ${done.folder}.${skipped}`;
}

/** *Clear workspace default*: answers a message. */
export function clearWorkspaceDefaultGuidelines(): string {
    const folder = clearLiveWorkspaceAspects();
    if (!folder) { throw new Error('this window has no Tom workspace folder'); }
    return `The workspace guideline choices of ${folder} are cleared.`;
}

/** The other open windows on this machine. */
function otherOpenWindows(own: string | undefined): string[] {
    const now = Date.now();
    const states = loadAllWindowStates().map((s) => {
        const state = s as unknown as { windowId?: string; heartbeat?: string };
        return { windowId: state.windowId, alive: isWindowAlive(state, now) };
    });
    return openWindowsOnThisMachine(states, own);
}

/** The all-windows change: answers the other windows it was sent to. */
export function setSectionChoiceForAllWindows(section: string, option: string | undefined): string[] {
    const own = windowRequestsOwnWindow();
    return setSectionChoiceInAllWindows(section, option, {
        ownWindowId: own,
        windowIds: () => otherOpenWindows(own),
        send: (windowId, s, o) => sendWindowRequest(windowId, { type: 'setAspectChoice', section: s, ...(o ? { option: o } : {}) }),
    });
}

/** The window-request handler: another window's all-windows change, set in this window's level and shown in its views. */
export function applyAspectChoiceRequest(section: string, option: string | undefined): boolean {
    setWindowSectionChoice(section, option);
    refreshAspectViews();
    return true;
}

/**
 * A section or option renamed (gsel7b): carry the stored choices naming the
 * old id over — this window's queue items and runs first (in memory, written
 * at once), then every level's files under `_ai` and the queue folder, then
 * every other open window on this machine is told to carry its memory over.
 * Answers what was rewritten, in one sentence. The caller redraws the views.
 */
export function carryAspectChoicesOver(rename: AspectRename): string {
    let memory = { items: 0, runs: 0 };
    try { memory = PromptQueueManager.instance?.applyAspectRename(rename) ?? memory; } catch { /* no queue in this window */ }
    const aiRoot = WsPaths.aiRoot;
    const result = aiRoot
        ? rewriteStoredAspectChoices({ aiRoot, queueFolder: getQueueFolder() }, rename)
        : { changes: [], failed: [] };
    const own = windowRequestsOwnWindow();
    const told = otherOpenWindows(own).filter((id) => sendWindowRequest(id, { type: 'renameAspectChoices', rename })).length;
    const windows = told ? ` ${told} other open window${told === 1 ? ' was' : 's were'} told.` : '';
    return `Renamed ${aspectRenameText(rename)}. ${aspectRenameSummary(result, { item: memory.items, run: memory.runs })}${windows}`;
}

/** The window-request handler: another window's rename, carried over in this window's memory and shown in its views. */
export function applyAspectRenameRequest(rename: AspectRename): boolean {
    try { PromptQueueManager.instance?.applyAspectRename(rename); } catch { /* no queue in this window */ }
    refreshAspectViews();
    return true;
}

/** Register the commands (quest default, workspace default). */
export function registerAspectChoiceCommands(context: vscode.ExtensionContext): void {
    context.subscriptions.push(
        vscode.commands.registerCommand(SET_QUEST_DEFAULT_GUIDELINES_COMMAND, () => {
            try {
                const choices = setQuestDefaultGuidelines();
                const text = choices ? Object.entries(choices).map(([s, o]) => `${s}: ${o}`).join(', ') : 'none (the window has no choices; the quest default is cleared)';
                refreshAspectViews();
                void vscode.window.showInformationMessage(`Quest default guideline choices: ${text}.`);
            } catch (err) {
                void vscode.window.showErrorMessage(`Setting the quest default failed: ${(err as Error).message}`);
            }
        }),
        vscode.commands.registerCommand(CLEAR_QUEST_DEFAULT_GUIDELINES_COMMAND, () => {
            try {
                clearQuestDefaultGuidelines();
                refreshAspectViews();
                void vscode.window.showInformationMessage('The quest default guideline choices are cleared.');
            } catch (err) {
                void vscode.window.showErrorMessage(`Clearing the quest default failed: ${(err as Error).message}`);
            }
        }),
        vscode.commands.registerCommand(SET_WORKSPACE_DEFAULT_GUIDELINES_COMMAND, () => {
            try {
                const text = setWorkspaceDefaultGuidelines();
                refreshAspectViews();
                void vscode.window.showInformationMessage(text);
            } catch (err) {
                void vscode.window.showErrorMessage(`Setting the workspace default failed: ${(err as Error).message}`);
            }
        }),
        vscode.commands.registerCommand(CLEAR_WORKSPACE_DEFAULT_GUIDELINES_COMMAND, () => {
            try {
                const text = clearWorkspaceDefaultGuidelines();
                refreshAspectViews();
                void vscode.window.showInformationMessage(text);
            } catch (err) {
                void vscode.window.showErrorMessage(`Clearing the workspace default failed: ${(err as Error).message}`);
            }
        }),
    );
}
