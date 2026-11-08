/**
 * The "no quest is open" hint (vsc_setup-5): while the window's workspace is
 * set up (`.tom/`, so the extension runs in full mode) but no quest is open
 * (quest `default`), the @CHAT and @WS panels and the @TOM views that need a
 * quest show a banner with "Create new quest" and "Setup new workspace folder".
 *
 * The webview side is one shared helper, media/shared/questHint.js: it posts
 * `questHintReady` when loaded, shows what {@link questHintMessage} answers and
 * posts `questHintAction` for a click. Each of those panels hands its messages
 * to {@link handleQuestHintMessage} first.
 */

import * as vscode from 'vscode';
import { WsPaths } from '../utils/workspacePaths';
import { CREATE_QUEST_COMMAND, SETUP_WORKSPACE_COMMAND } from '../utils/setupCommandIds';

export const QUEST_HINT_TEXT = 'No quest is open. Open a quest workspace (_ai/quests/<id>/<id>.code-workspace) or create one.';

/** The banner's buttons: action → the command it runs. */
export const QUEST_HINT_ACTIONS = {
    createQuest: { label: 'Create new quest', command: CREATE_QUEST_COMMAND },
    setupWorkspaceFolder: { label: 'Setup new workspace folder', command: SETUP_WORKSPACE_COMMAND },
} as const;
export type QuestHintAction = keyof typeof QUEST_HINT_ACTIONS;

export interface QuestHintMessage {
    type: 'questHint';
    show: boolean;
    text: string;
    buttons: Array<{ action: QuestHintAction; label: string }>;
}

/** No quest is open: the window's workspace is not a quest's (`default`). */
export function isNoQuestOpen(): boolean {
    return WsPaths.getWorkspaceQuestId() === 'default';
}

export function questHintMessage(show = isNoQuestOpen()): QuestHintMessage {
    return {
        type: 'questHint',
        show,
        text: QUEST_HINT_TEXT,
        buttons: (Object.keys(QUEST_HINT_ACTIONS) as QuestHintAction[]).map((action) => ({ action, label: QUEST_HINT_ACTIONS[action].label })),
    };
}

/**
 * Take the hint's messages: `questHintReady` is answered with the hint, a
 * `questHintAction` runs its command. True when the message was one of them.
 */
export async function handleQuestHintMessage(message: unknown, webview: Pick<vscode.Webview, 'postMessage'>): Promise<boolean> {
    const msg = message as { type?: unknown; action?: unknown } | undefined;
    if (msg?.type === 'questHintReady') {
        await webview.postMessage(questHintMessage());
        return true;
    }
    if (msg?.type === 'questHintAction') {
        const action = QUEST_HINT_ACTIONS[msg.action as QuestHintAction];
        if (action) { await vscode.commands.executeCommand(action.command); }
        return true;
    }
    return false;
}

/**
 * Wire the hint into a webview as a listener of its own, beside the panel's
 * message handling (as `wireCompletionMessages` does for completion).
 */
export function wireQuestHintMessages(webview: Pick<vscode.Webview, 'postMessage' | 'onDidReceiveMessage'>): vscode.Disposable {
    return webview.onDidReceiveMessage((message: unknown) => { void handleQuestHintMessage(message, webview); });
}
