/**
 * "@T: Create New Quest" (`tomAi.createQuest`): asks the quest id and name,
 * creates `_ai/quests/<id>/` with the quest's files (utils/questScaffold.ts),
 * registers it in the Active Quests table and offers to open the quest's
 * workspace. The quest's one todo defines the quest with the user.
 *
 * An agent runs it with arguments (`tomAi_runVscodeCommandTyped`,
 * `tomAi.createQuest`, `[{ id, name, offerOpen: false }]`): then no input box
 * opens, and nothing is offered when `offerOpen` is false. The pattern prompt
 * `!create quest` does so.
 */

import * as vscode from 'vscode';
import * as path from 'path';
import { getWorkspaceRoot } from './handler_shared';
import { WsPaths } from '../utils/workspacePaths';
import { createQuestScaffold, defaultQuestName, questIdProblem, type QuestScaffoldResult } from '../utils/questScaffold';
import { CREATE_QUEST_COMMAND } from '../utils/setupCommandIds';

export { CREATE_QUEST_COMMAND };
export const OPEN_QUEST_WORKSPACE = 'Open the quest workspace';

export interface CreateQuestArgs {
    id?: string;
    name?: string;
    /** Offer to open the quest's workspace afterwards. Default true. */
    offerOpen?: boolean;
}

export type CreateQuestOutcome =
    | { ok: true; quest: string; result: QuestScaffoldResult; opened: boolean }
    | { ok: false; error: string; cancelled?: boolean };

/** The folder quests live in. */
function questsDir(): string | undefined {
    const root = getWorkspaceRoot();
    if (!root) { return undefined; }
    return WsPaths.ai('quests') ?? path.join(root, '_ai', 'quests');
}

export async function createQuest(args: CreateQuestArgs = {}): Promise<CreateQuestOutcome> {
    const root = getWorkspaceRoot();
    const dir = questsDir();
    if (!root || !dir) {
        const error = 'Open a workspace folder first: a quest lives in its _ai/quests/ folder.';
        void vscode.window.showErrorMessage(error);
        return { ok: false, error };
    }
    const id = args.id ?? await vscode.window.showInputBox({
        title: 'Create New Quest (1/2)',
        prompt: `The quest id: letters, digits and _ (its folder is ${path.join(dir, '<id>')})`,
        placeHolder: 'my_quest',
        validateInput: (value) => questIdProblem(value.trim(), dir) ?? null,
    });
    if (id === undefined) { return { ok: false, error: 'cancelled', cancelled: true }; }
    const questId = id.trim();
    const problem = questIdProblem(questId, dir);
    if (problem) {
        void vscode.window.showErrorMessage(problem);
        return { ok: false, error: problem };
    }
    const name = args.name ?? await vscode.window.showInputBox({
        title: 'Create New Quest (2/2)',
        prompt: 'The quest name',
        value: defaultQuestName(questId),
    });
    if (name === undefined) { return { ok: false, error: 'cancelled', cancelled: true }; }

    const result = createQuestScaffold(root, dir, questId, name.trim() || defaultQuestName(questId));
    const registered = result.registration === 'added' ? ' and registered it in the Active Quests table' : '';
    const message = `Created the quest ${questId} (${result.files.length} files in ${result.folder})${registered}. `
        + `Its todo ${result.todoId} defines the quest with you: run it in the queue or the chat from the quest's workspace.`;
    let opened = false;
    if (args.offerOpen === false) {
        void vscode.window.showInformationMessage(message);
    } else {
        const answer = await vscode.window.showInformationMessage(message, OPEN_QUEST_WORKSPACE);
        if (answer === OPEN_QUEST_WORKSPACE) {
            await vscode.commands.executeCommand('vscode.openFolder', vscode.Uri.file(result.workspaceFile), { forceNewWindow: true });
            opened = true;
        }
    }
    return { ok: true, quest: questId, result, opened };
}

export function registerCreateQuestCommand(context: vscode.ExtensionContext): void {
    context.subscriptions.push(vscode.commands.registerCommand(CREATE_QUEST_COMMAND, (args?: CreateQuestArgs) => createQuest(args ?? {})));
}
