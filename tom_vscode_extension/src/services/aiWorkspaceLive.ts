/**
 * The window's AI workspace (vscimpb144; utils/aiWorkspace.ts): its name — the
 * window's root folder as VS Code reports it (`workspaceFolders[0]`) — and its
 * quests from `_ai/workspaces/<workspace>.yaml`, for every place that lists
 * quests for a choice.
 */

import { layoutWorkspaceFolder } from '../utils/workspaceLayout';
import * as path from 'path';

import { listQuestIds } from '../managers/questTodoManager';
import { aiWorkspaceName, readQuestShortDescription, resolveWorkspaceQuests, type WorkspaceQuests } from '../utils/aiWorkspace';
import { WsPaths } from '../utils/workspacePaths';

/** The window's workspace name: its root folder's name; undefined without a folder. */
export function windowAiWorkspaceName(): string | undefined {
    const root = layoutWorkspaceFolder();
    return root ? aiWorkspaceName(root) : undefined;
}

/** The window's workspace quests (the list, the recorded ones, else every quest); undefined without `_ai` or a folder. */
export function windowWorkspaceQuests(): WorkspaceQuests | undefined {
    const aiRoot = WsPaths.aiRoot;
    const name = windowAiWorkspaceName();
    if (!aiRoot || !name) { return undefined; }
    return resolveWorkspaceQuests(aiRoot, name, listQuestIds());
}

/** The quests a choice offers first: the workspace's (always with `alsoQuest`, e.g. the window's own), else every quest. */
export function workspaceQuestChoices(alsoQuest?: string): { quests: string[]; all: string[]; limited: boolean } {
    const all = listQuestIds();
    const ws = windowWorkspaceQuests();
    if (!ws || ws.source === 'all') { return { quests: all, all, limited: false }; }
    const quests = alsoQuest && all.includes(alsoQuest) && !ws.quests.includes(alsoQuest) ? [alsoQuest, ...ws.quests] : ws.quests;
    return { quests, all, limited: quests.length < all.length };
}

/** A quest's short description (vscimpb145), for tooltips and lists. */
export function questShortDescription(quest: string): string | undefined {
    const root = WsPaths.ai('quests');
    return root ? readQuestShortDescription(root, quest) : undefined;
}

/** `_ai/quests` (absolute), or undefined. */
export function questsRoot(): string | undefined {
    const ai = WsPaths.aiRoot;
    return ai ? path.join(ai, 'quests') : undefined;
}
