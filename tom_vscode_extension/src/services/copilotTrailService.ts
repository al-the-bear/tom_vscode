/**
 * Copilot trail service.
 *
 * Wave 3.2 continuation — the Copilot subpanel's trail-file
 * machinery (summary + raw trail writers, quest folder resolution,
 * old-file cleanup, sequence trimming) used to live as ~250 lines
 * of free functions at the top of `chatPanel-handler.ts`. Moving
 * it into a service lets the handler stay an adapter layer while
 * downstream readers (todo-log panel, window-status panel) can
 * import the trail utilities directly instead of reaching into
 * chatPanel-handler for module-level exports.
 */

import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';
import { getWorkspaceRoot, loadSendToChatConfig } from '../handlers/handler_shared';
import { WsPaths } from '../utils/workspacePaths';
import { debugLog } from '../utils/debugLogger';
import { TrailService } from './trailService';
import { writeWindowState } from '../handlers/windowStatusPanel-handler.js';
import {
    CopilotAnswerPayload,
    generateRequestId,
    getWindowId,
} from './copilotAnswerService';

/** Max entries before the summary file trims oldest; config-driven. */
export function getMaxTrailEntries(): number {
    const config = loadSendToChatConfig();
    return config?.trail?.maxEntries ?? 1000;
}

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
    const wsRoot = getWorkspaceRoot();
    if (!wsRoot) { return null; }
    const questFolder = WsPaths.ai('quests', wsName) || path.join(wsRoot, '_ai', 'quests', wsName);
    if (fs.existsSync(questFolder)) { return wsName; }
    return null;
}

/**
 * Resolve the consolidated trail folder. When a quest .code-workspace is
 * open the trail sits inside the quest directory (so it moves with the
 * quest via git); otherwise falls back to `_ai/trail`.
 */
export function getTrailFolder(): string {
    const wsRoot = getWorkspaceRoot();
    if (!wsRoot) { return ''; }
    const questId = detectQuestFromWorkspace();
    if (questId) {
        return WsPaths.ai('quests', questId) || path.join(wsRoot, '_ai', 'quests', questId);
    }
    return WsPaths.ai('trail') || path.join(wsRoot, '_ai', 'trail');
}

/** Folder for per-request individual raw trail files (always `_ai/trail`). */
export function getIndividualTrailFolder(): string {
    const wsRoot = getWorkspaceRoot();
    if (!wsRoot) { return ''; }
    return WsPaths.ai('trail') || path.join(wsRoot, '_ai', 'trail');
}

/** Prefix used in Copilot summary trail file names — the quest id. */
export function getTrailFilePrefix(): string {
    return WsPaths.getWorkspaceQuestId();
}

/** Locations of the Copilot summary trail files (prompts.md / answers.md). */
export function getCopilotSummaryTrailPaths():
    | { questId: string; folder: string; promptsPath: string; answersPath: string }
    | null {
    const wsRoot = getWorkspaceRoot();
    if (!wsRoot) { return null; }
    const questId = WsPaths.getWorkspaceQuestId();
    const folder = WsPaths.ai('quests', questId) || path.join(wsRoot, '_ai', 'quests', questId);
    return {
        questId,
        folder,
        promptsPath: path.join(folder, `${questId}.copilot.prompts.md`),
        answersPath: path.join(folder, `${questId}.copilot.answers.md`),
    };
}

/**
 * Parse the sequence number stamped into the first line of a summary
 * trail file (format: `=== PROMPT|ANSWER <id> <timestamp> <seq> ===`).
 * Returns 0 when the file is missing, empty, or lacks the header.
 */
export function parseSequenceFromFile(filePath: string): number {
    if (!fs.existsSync(filePath)) { return 0; }
    try {
        const content = fs.readFileSync(filePath, 'utf-8');
        if (!content.trim()) { return 0; }
        const firstLine = content.split('\n')[0];
        const match = firstLine.match(/===\s+(?:PROMPT|ANSWER)\s+\S+\s+\S+\s+(\d+)\s+===/);
        return match ? parseInt(match[1], 10) : 0;
    } catch { return 0; }
}

/**
 * Drop the oldest entry from a summary trail file once the running
 * sequence count crosses `maxEntries`. Entries are delimited by
 * `=== PROMPT|ANSWER …` header lines and ordered newest-first, so
 * trimming means slicing off the bottom block.
 */
export function trimTrailFile(filePath: string, maxEntries: number): void {
    if (!fs.existsSync(filePath)) { return; }
    try {
        const content = fs.readFileSync(filePath, 'utf-8');
        const firstLine = content.split('\n')[0];
        const match = firstLine.match(/===\s+(?:PROMPT|ANSWER)\s+\S+\s+\S+\s+(\d+)\s+===/);
        const currentSeq = match ? parseInt(match[1], 10) : 0;
        if (currentSeq <= maxEntries) { return; }

        const lines = content.split('\n');
        let lastEntryStart = -1;
        for (let i = lines.length - 1; i >= 0; i--) {
            if (lines[i].match(/^===\s+(?:PROMPT|ANSWER)/)) {
                lastEntryStart = i;
                break;
            }
        }
        if (lastEntryStart > 0) {
            const trimmed = lines.slice(0, lastEntryStart).join('\n').trimEnd() + '\n';
            fs.writeFileSync(filePath, trimmed, 'utf-8');
        }
    } catch (e) {
        console.error('[CopilotTrail] Failed to trim trail file:', e);
    }
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
