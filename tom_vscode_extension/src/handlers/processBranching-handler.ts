/**
 * The process branching editor: an editor tab listing the processes the
 * running step may start — its `subprocesses:` (hand a result back) and
 * `branches:` (hand nothing back), nothing else (processBranchingPlan.ts) —
 * one card each with its summary, the step it starts at, the inputs the step
 * fills, the agent's reason when it suggested it, and the follow-up the step
 * gets when the level ends (the recommendation preselected). **Start** starts
 * it (startListedProcess: the depth confirmation, the inputs, the level);
 * **Dismiss** closes the page. The page closes by itself once a level started
 * or the running position moved on.
 *
 * Opened from the PROCESS view's *Your turn* box at a user-action step.
 */

import * as vscode from 'vscode';
import * as path from 'path';

import { ProcessStateStore } from '../managers/processStateStore';
import { getExtensionPath } from './handler_shared';
import { loadWebviewHtml } from '../utils/webviewLoader';
import { branchingCards, type ProcessSuggestion } from '../utils/processBranchingPlan';
import { positionText } from '../utils/processActionPrompt';
import { samePosition, type NestedFollowUp, type NestedKind, type ProcessState } from '../utils/processDefinition';
import { NESTED_FOLLOW_UP_LABELS } from '../utils/processStack';
import { liveNestedUi, startListedProcess } from '../services/nestedProcessCommands';

export const PROCESS_BRANCHING_VIEW_TYPE = 'tomAi.processBranching';

let panel: vscode.WebviewPanel | undefined;
let openedAt: { quest: string; level: number; state: ProcessState } | undefined;

/** The page's first paint: the step, the cards, the follow-up labels. */
export function branchingInit(store: ProcessStateStore, suggestions: readonly ProcessSuggestion[] = []): Record<string, unknown> {
    const def = store.currentDefinition();
    const state = store.state;
    return {
        step: def ? positionText(def, state) : state.step,
        process: def?.name || state.process,
        cards: branchingCards(def, state, store.definitions(), positionText, suggestions),
        followUps: (['ask', 'go-on', 'run-again'] as NestedFollowUp[]).map((f) => ({ value: f, label: NESTED_FOLLOW_UP_LABELS[f] })),
    };
}

/** Close the page (a level started, the position moved, Dismiss). */
export function closeProcessBranchingEditor(): void {
    const p = panel;
    panel = undefined;
    openedAt = undefined;
    try { p?.dispose(); } catch { /* already gone */ }
}

/** Open (or bring back) the page for the running step; `suggestions` are the agent's (e-8). */
export async function openProcessBranchingEditor(context: vscode.ExtensionContext, suggestions: readonly ProcessSuggestion[] = []): Promise<void> {
    const store = await ProcessStateStore.ready;
    closeProcessBranchingEditor();
    const extPath = getExtensionPath() ?? context.extensionPath;
    const def = store.currentDefinition();
    const created = vscode.window.createWebviewPanel(
        PROCESS_BRANCHING_VIEW_TYPE,
        `Start from: ${def ? positionText(def, store.state) : store.state.step}`,
        { viewColumn: vscode.ViewColumn.Active, preserveFocus: false },
        { enableScripts: true, localResourceRoots: extPath ? [vscode.Uri.file(path.join(extPath, 'media'))] : undefined },
    );
    panel = created;
    openedAt = { quest: store.activeQuest, level: store.levelIndex, state: store.state };
    created.webview.html = loadWebviewHtml(created.webview, 'processBranching', { init: branchingInit(store, suggestions) });
    // The page belongs to the running position: when it moves (or a level starts), it closes.
    const watch = store.onDidChange(() => {
        if (panel !== created || !openedAt) { return; }
        if (store.activeQuest !== openedAt.quest || store.levelIndex !== openedAt.level || !samePosition(store.state, openedAt.state)) {
            closeProcessBranchingEditor();
        }
    });
    created.onDidDispose(() => {
        watch.dispose();
        if (panel === created) { panel = undefined; openedAt = undefined; }
    });
    created.webview.onDidReceiveMessage(async (msg: { type?: string; kind?: NestedKind; process?: string; followUp?: NestedFollowUp }) => {
        if (msg?.type === 'dismiss') { closeProcessBranchingEditor(); return; }
        if (msg?.type !== 'start' || !msg.kind || !msg.process) { return; }
        const started = await startListedProcess(store, liveNestedUi, msg.kind, msg.process, msg.followUp ?? 'ask');
        if (started) { closeProcessBranchingEditor(); }
    });
}
