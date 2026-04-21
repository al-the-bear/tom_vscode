/**
 * Copilot answer-file service.
 *
 * Wave 3.2 extraction — the Copilot subpanel's answer-file mechanism
 * (per-window JSON + per-window prompts / answers markdown logs) used
 * to live as ~130 lines of free functions at the top of
 * `chatPanel-handler.ts`. Moving it into a service lets the handler
 * stay an adapter layer while the answer-file contract becomes
 * reusable from anywhere (bridge tools, telegram callbacks, tests).
 *
 * The functions are window-scoped: `getWindowId()` composes 8 chars of
 * `vscode.env.sessionId` + 8 chars of `vscode.env.machineId` so each
 * VS Code window owns its own answer-file pair without per-workspace
 * configuration.
 */

import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';
import { getCopilotChatAnswerFolderAbsolute, getWorkspaceRoot, loadSendToChatConfig } from '../handlers/handler_shared';
import { WsPaths } from '../utils/workspacePaths';

/**
 * Shape of the JSON payload the Copilot subpanel writes as an "answer"
 * when the user copies a response from Copilot Chat. Exposed so
 * downstream readers (chat-panel handler, trail summariser) can share
 * one type and trail the shape change if this evolves.
 */
export interface CopilotAnswerPayload {
    requestId: string;
    generatedMarkdown: string;
    comments?: string;
    references?: string[];
    requestedAttachments?: string[];
    responseValues?: Record<string, string>;
}

/** Short window identifier: first 8 of sessionId + first 8 of machineId. */
export function getWindowId(): string {
    const session = vscode.env.sessionId.substring(0, 8);
    const machine = vscode.env.machineId.substring(0, 8);
    return `${session}_${machine}`;
}

/** Absolute path to the answer JSON file for this window. */
export function getAnswerFilePath(): string {
    const folder = getCopilotChatAnswerFolderAbsolute();
    return path.join(folder, `${getWindowId()}_answer.json`);
}

/** True for any `*_answer.json` filename; used by watchers to filter noise. */
export function isAnswerJsonFilename(filename: string | null | undefined): boolean {
    if (!filename) { return false; }
    return filename.endsWith('_answer.json');
}

/** Generate a short request id (two 8-char hex blocks joined by `_`). */
export function generateRequestId(): string {
    const hex = () => Math.random().toString(16).substring(2, 10);
    return `${hex()}_${hex()}`;
}

/** True iff the answer file for this window currently exists on disk. */
export function answerFileExists(): boolean {
    return fs.existsSync(getAnswerFilePath());
}

/**
 * Remove the answer file for this window. Creates the parent directory
 * on the way (so subsequent writes succeed) — the answer file is
 * always expected to live in the configured answer folder.
 */
export function deleteAnswerFile(): void {
    const filePath = getAnswerFilePath();
    const dir = path.dirname(filePath);
    if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
    }
    if (fs.existsSync(filePath)) {
        fs.unlinkSync(filePath);
    }
}

/**
 * Read and parse the answer file for this window. Returns `undefined`
 * when the file is missing or the contents don't parse as JSON.
 */
export function readAnswerFile(): CopilotAnswerPayload | undefined {
    const filePath = getAnswerFilePath();
    if (!fs.existsSync(filePath)) { return undefined; }
    try {
        const content = fs.readFileSync(filePath, 'utf-8');
        return JSON.parse(content) as CopilotAnswerPayload;
    } catch {
        return undefined;
    }
}

/** Resolve the configured per-window markdown log folder root. */
function getCopilotLogsRoot(): string {
    const config = loadSendToChatConfig();
    const wsRoot = getWorkspaceRoot();
    const basePath = config?.copilot?.answerFolder || WsPaths.aiRelative('copilot');
    const fullBase = wsRoot ? path.join(wsRoot, basePath) : WsPaths.home('copilotAnswers');
    return path.join(fullBase, getWindowId());
}

/** Single answer (latest) markdown log path. */
export function getCopilotAnswersMdPath(): string {
    return path.join(getCopilotLogsRoot(), 'copilot-answer.md');
}

/** Rolling prompts log path — newest first. */
export function getCopilotPromptsPath(): string {
    return path.join(getCopilotLogsRoot(), 'copilot-prompts.md');
}

/** Rolling answers log path — newest first. */
export function getCopilotAnswersPath(): string {
    return path.join(getCopilotLogsRoot(), 'copilot-answers.md');
}

/**
 * Append a prompt entry to the rolling `copilot-prompts.md` log. Newer
 * entries go on top (after the file's `# Copilot Prompts` header if
 * one exists) so the user can skim recent prompts without scrolling.
 */
export function logCopilotPrompt(prompt: string, template: string): void {
    const promptsPath = getCopilotPromptsPath();
    const dir = path.dirname(promptsPath);

    if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
    }

    const timestamp = new Date().toISOString();
    const templateLabel = template || '(none)';
    const entry = `## ${timestamp}\n\n**Template:** ${templateLabel}\n\n${prompt}\n\n`;

    let existingContent = '';
    if (fs.existsSync(promptsPath)) {
        existingContent = fs.readFileSync(promptsPath, 'utf-8');
    }

    let newContent: string;
    if (existingContent.startsWith('# ')) {
        const headerEnd = existingContent.indexOf('\n');
        if (headerEnd > 0) {
            newContent = existingContent.substring(0, headerEnd + 1) + '\n' + entry + existingContent.substring(headerEnd + 1);
        } else {
            newContent = existingContent + '\n\n' + entry;
        }
    } else if (existingContent.trim()) {
        newContent = entry + existingContent;
    } else {
        newContent = '# Copilot Prompts\n\n' + entry;
    }

    fs.writeFileSync(promptsPath, newContent, 'utf-8');
}
