/**
 * Copilot trail service.
 *
 * Wave 3.2 continuation — the Copilot subpanel's trail-file
 * machinery (summary + raw trail writers through TrailService, quest folder resolution,
 * old-file cleanup) used to live as ~250 lines
 * of free functions at the top of `chatPanel-handler.ts`. Moving
 * it into a service lets the handler stay an adapter layer while
 * downstream readers (todo-log panel, window-status panel) can
 * import the trail utilities directly instead of reaching into
 * chatPanel-handler for module-level exports.
 */

import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';
import { WsPaths } from '../utils/workspacePaths';
import { questTrailFolder } from '../utils/questPaths.js';
import { debugLog } from '../utils/debugLogger';
import { TrailService } from './trailService';
import { writeWindowState } from '../handlers/windowStatusPanel-handler.js';
import {
    CopilotAnswerPayload,
    generateRequestId,
    getWindowId,
} from './copilotAnswerService';

/** `YYYYMMDD_HHMMSSmmm` used in raw trail file names. */
export function getTrailFileTimestamp(): string {
    const now = new Date();
    const date = `${now.getFullYear()}${String(now.getMonth() + 1).padStart(2, '0')}${String(now.getDate()).padStart(2, '0')}`;
    const time = `${String(now.getHours()).padStart(2, '0')}${String(now.getMinutes()).padStart(2, '0')}${String(now.getSeconds()).padStart(2, '0')}${String(now.getMilliseconds()).padStart(3, '0')}`;
    return `${date}_${time}`;
}

/** ISO timestamp inside trail entries (readable when diffed). */
export function getReadableTimestamp(): string {
    return new Date().toISOString();
}

/** Workspace file name without `.code-workspace`, or `'default'` if none. */
export function getWorkspaceName(): string {
    const workspaceFile = vscode.workspace.workspaceFile;
    if (workspaceFile && workspaceFile.fsPath.endsWith('.code-workspace')) {
        const basename = path.basename(workspaceFile.fsPath);
        return basename.replace('.code-workspace', '');
    }
    return 'default';
}

/**
 * Quest id matching the `.code-workspace` filename when the matching
 * `_ai/quests/<id>/` folder actually exists. Returns `null` for
 * generic (non-quest) workspaces so callers can fall through to the
 * trail-root layout.
 */
function detectQuestFromWorkspace(): string | null {
    const wsName = getWorkspaceName();
    if (wsName === 'default') { return null; }
    const aiRoot = WsPaths.aiRoot;
    if (!aiRoot) { return null; }
    const questFolder = WsPaths.ai('quests', wsName) || path.join(aiRoot, 'quests', wsName);
    if (fs.existsSync(questFolder)) { return wsName; }
    return null;
}

/**
 * Resolve the consolidated trail folder. When a quest .code-workspace is
 * open the trail sits in the quest's `history/` subfolder, beside the other
 * generated, gitignored trail files; otherwise falls back to `_ai/trail`.
 */
export function getTrailFolder(): string {
    const aiRoot = WsPaths.aiRoot;
    if (!aiRoot) { return ''; }
    const questId = detectQuestFromWorkspace();
    if (questId) {
        return questTrailFolder(WsPaths.ai('quests', questId) || path.join(aiRoot, 'quests', questId));
    }
    return WsPaths.ai('trail') || path.join(aiRoot, 'trail');
}

/** Folder for per-request individual raw trail files (always `_ai/trail`). */
export function getIndividualTrailFolder(): string {
    const aiRoot = WsPaths.aiRoot;
    if (!aiRoot) { return ''; }
    return WsPaths.ai('trail') || path.join(aiRoot, 'trail');
}

/** Prefix used in Copilot summary trail file names — the quest id. */
export function getTrailFilePrefix(): string {
    return WsPaths.getWorkspaceQuestId();
}

/** Locations of the Copilot summary trail files (prompts.md / answers.md). */
export function getCopilotSummaryTrailPaths():
    | { questId: string; folder: string; promptsPath: string; answersPath: string }
    | null {
    const aiRoot = WsPaths.aiRoot;
    if (!aiRoot) { return null; }
    const questId = WsPaths.getWorkspaceQuestId();
    const questFolder = WsPaths.ai('quests', questId) || path.join(aiRoot, 'quests', questId);
    const folder = questTrailFolder(questFolder);
    return {
        questId,
        folder,
        promptsPath: path.join(folder, `${questId}.copilot.prompts.md`),
        answersPath: path.join(folder, `${questId}.copilot.answers.md`),
    };
}

/**
 * Write a prompt to the Copilot summary trail + raw trail, and
 * notify the window-status panel that a prompt was sent. The
 * `overrideRequestId` path exists so the queue can pre-generate an
 * id, stamp it into the expanded prompt, and pass the same id here
 * (otherwise the trail pair would use different ids).
 */
export function writePromptTrail(
    originalPrompt: string,
    templateName: string,
    isAnswerWrapper: boolean,
    expandedPrompt: string,
    overrideRequestId?: string,
): void {
    const trailService = TrailService.instance;
    const requestId = overrideRequestId || generateRequestId();

    const summaryPrompt =
        `${originalPrompt}\n\n` +
        `TEMPLATE: ${templateName || '(none)'}\n` +
        `ANSWER-WRAPPER: ${isAnswerWrapper ? 'yes' : 'no'}\n` +
        `REQUEST-ID: ${requestId}`;
    trailService.writeSummaryPrompt({ type: 'copilot' }, summaryPrompt, getCopilotSummaryTrailPaths()?.questId);

    const questId = WsPaths.getWorkspaceQuestId();
    void trailService.writeRawPrompt({ type: 'copilot' }, expandedPrompt, getWindowId(), requestId, questId);

    try {
        const quest = WsPaths.getWorkspaceQuestId();
        writeWindowState(getWindowId(), getWorkspaceName(), quest, 'copilot', 'prompt-sent');
    } catch (e) {
        debugLog(`[CopilotTrail] Failed to update window state on prompt: ${e}`, 'WARN', 'windowStatus');
    }
}

/**
 * Mirror of {@link writePromptTrail} for answer payloads. Writes the
 * summary + raw files and updates the window-status panel to
 * `answer-received`.
 */
export function writeAnswerTrail(answer: CopilotAnswerPayload): void {
    const trailService = TrailService.instance;
    trailService.writeSummaryAnswer(
        { type: 'copilot' },
        answer.generatedMarkdown,
        {
            requestId: answer.requestId,
            comments: answer.comments,
            references: answer.references,
            requestedAttachments: answer.requestedAttachments,
            responseValues: answer.responseValues,
        },
        getCopilotSummaryTrailPaths()?.questId,
    );

    void trailService.writeRawAnswer({ type: 'copilot' }, answer.generatedMarkdown, getWindowId(), answer.requestId, getCopilotSummaryTrailPaths()?.questId);

    try {
        const quest = WsPaths.getWorkspaceQuestId();
        writeWindowState(getWindowId(), getWorkspaceName(), quest, 'copilot', 'answer-received');
    } catch (e) {
        debugLog(`[CopilotTrail] Failed to update window state on answer: ${e}`, 'WARN', 'windowStatus');
    }
}
