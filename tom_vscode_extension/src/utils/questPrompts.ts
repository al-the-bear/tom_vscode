/**
 * The saved ("reusable") prompts: the `*.prompt.md` files of the active
 * quest's `_ai/quests/<quest>/prompt/` folder, and nothing else. The
 * Reusable Prompt Editor, the @CHAT action bar, the scripting bridge's
 * prompt documents and `tomAi_listDocuments` (`prompts`) all read this one
 * folder.
 */

import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';
import { FILE_EXT_PROMPT } from './constants';
import { WsPaths } from './workspacePaths';

export interface QuestPromptFile {
    /** The file name, e.g. `review.prompt.md`. */
    id: string;
    label: string;
}

export interface QuestPromptFolder {
    questId: string;
    /** `_ai/quests/<quest>/prompt`; created when the first prompt is written. */
    dir: string;
}

/** What the pages are told while the window has no quest. */
export const NO_QUEST_PROMPTS_MESSAGE = 'This window has no quest: saved prompts are a quest\'s (_ai/quests/<quest>/prompt/).';

/**
 * The active quest's prompt folder, or null while the window is not a
 * quest's (no `.code-workspace`, or its quest folder is missing).
 */
export function activeQuestPromptFolder(): QuestPromptFolder | null {
    if (!vscode.workspace.workspaceFile) { return null; }
    const questId = WsPaths.getWorkspaceQuestId();
    if (!questId || questId === 'default') { return null; }
    const questDir = WsPaths.ai('quests', questId);
    if (!questDir) { return null; }
    try {
        if (!fs.statSync(questDir).isDirectory()) { return null; }
    } catch {
        return null;
    }
    return { questId, dir: path.join(questDir, 'prompt') };
}

/** The list key of a quest's stored prompt order (services/editorListOrder.ts). */
export function questPromptsListKey(questId: string): string {
    return `reusablePrompts:quest:${questId}`;
}

/** Whether `name` is a prompt file's own name: `<something>.prompt.md`, no folder part. */
export function isQuestPromptFileName(name: unknown): name is string {
    return typeof name === 'string'
        && name.endsWith(FILE_EXT_PROMPT)
        && name.length > FILE_EXT_PROMPT.length
        && !/[\\/]/.test(name);
}

/** A typed name as a prompt file name (`.prompt.md` added when missing), or null when it cannot be one. */
export function questPromptFileName(input: string): string | null {
    const base = String(input ?? '').trim().replace(/\.prompt\.md$/i, '').replace(/\.md$/i, '').trim();
    if (!base) { return null; }
    const name = base + FILE_EXT_PROMPT;
    return isQuestPromptFileName(name) ? name : null;
}

/** The path of prompt `fileName` in `dir`, or null when it is no prompt file name. */
export function questPromptFilePath(dir: string, fileName: unknown): string | null {
    return isQuestPromptFileName(fileName) ? path.join(dir, fileName) : null;
}

/** The `*.prompt.md` files of `dir`, by name; none while the folder is missing. */
export function listQuestPromptFiles(dir: string): QuestPromptFile[] {
    let names: string[];
    try {
        names = fs.readdirSync(dir);
    } catch {
        return [];
    }
    return names.filter(isQuestPromptFileName).sort().map((name) => ({ id: name, label: name }));
}

export type QuestPromptResult = { ok: true; fileName: string; filePath: string } | { ok: false; error: string };

/** Write prompt `fileName` into `dir` (created on demand); an existing file is kept unless `overwrite`. */
export function writeQuestPrompt(dir: string, fileName: string, content: string, overwrite = false): QuestPromptResult {
    const filePath = questPromptFilePath(dir, fileName);
    if (!filePath) { return { ok: false, error: `"${fileName}" is no prompt file name (<name>${FILE_EXT_PROMPT}).` }; }
    if (!overwrite && fs.existsSync(filePath)) { return { ok: false, error: `File "${fileName}" already exists.` }; }
    try {
        fs.mkdirSync(dir, { recursive: true });
        fs.writeFileSync(filePath, content, 'utf-8');
    } catch (e) {
        return { ok: false, error: `Could not write "${fileName}": ${(e as Error).message}` };
    }
    return { ok: true, fileName, filePath };
}

/** Rename prompt `from` to `to` in `dir`; refused for a missing source and an existing target. */
export function renameQuestPrompt(dir: string, from: string, to: string): QuestPromptResult {
    const fromPath = questPromptFilePath(dir, from);
    const toPath = questPromptFilePath(dir, to);
    if (!fromPath) { return { ok: false, error: `"${from}" is no prompt file name.` }; }
    if (!toPath) { return { ok: false, error: `"${to}" is no prompt file name (<name>${FILE_EXT_PROMPT}).` }; }
    if (!fs.existsSync(fromPath)) { return { ok: false, error: `File "${from}" not found.` }; }
    if (from === to) { return { ok: true, fileName: to, filePath: toPath }; }
    if (fs.existsSync(toPath)) { return { ok: false, error: `File "${to}" already exists.` }; }
    try {
        fs.renameSync(fromPath, toPath);
    } catch (e) {
        return { ok: false, error: `Could not rename "${from}": ${(e as Error).message}` };
    }
    return { ok: true, fileName: to, filePath: toPath };
}

/** Delete prompt `fileName` of `dir`; answers whether a file was removed. */
export function deleteQuestPrompt(dir: string, fileName: string): boolean {
    const filePath = questPromptFilePath(dir, fileName);
    if (!filePath) { return false; }
    try {
        fs.unlinkSync(filePath);
        return true;
    } catch {
        return false;
    }
}

// ── Change notice: whoever shows the list follows the editor's changes ──────

const changeListeners = new Set<() => void>();

/** Be told when the active quest's prompt list changed (a file added, renamed, deleted, or the order). */
export function onQuestPromptsChanged(listener: () => void): { dispose(): void } {
    changeListeners.add(listener);
    return { dispose: () => { changeListeners.delete(listener); } };
}

/** Tell the listeners that the prompt list changed. */
export function notifyQuestPromptsChanged(): void {
    for (const listener of [...changeListeners]) {
        try { listener(); } catch { /* a listener's failure is its own */ }
    }
}
