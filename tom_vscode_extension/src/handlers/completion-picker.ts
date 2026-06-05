/**
 * Completion picker — the live (`vscode` + `fs`) half of the chat-panel
 * `/skill` and `@file` completions.
 *
 * The pure discovery / ranking lives in `../services/completion-service`;
 * this file wires that logic to the real filesystem and editor state and
 * presents a two-line `QuickPick` (name on line 1, path on line 2) with a
 * leading number/letter for quick-select — mirroring the Ctrl+Shift+X
 * favorites picker.
 *
 * Entry point: {@link showCompletionPicker}. The caller supplies a
 * `deliver` callback that splices the chosen insertion back into the
 * originating textarea (the chat-panel handler posts it to the webview),
 * so this module stays decoupled from any particular webview.
 */

import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';

import { WsPaths } from '../utils/workspacePaths';
import {
    discoverSkills,
    rankFiles,
    formatSkillInsertion,
    formatFileInsertion,
    type SkillStore,
    type SkillCompletion,
    type FileCompletion,
    type CompletionKind,
} from '../services/completion-service';

// ===========================================================================
// Live stores / gatherers
// ===========================================================================

/** Live skill store: walks `.claude/skills` dirs on disk via `fs`. */
const liveSkillStore: SkillStore = {
    wsRoot: () => WsPaths.wsRoot ?? null,
    listSkillFolders(claudeSkillsDir: string): string[] {
        let entries: fs.Dirent[];
        try {
            entries = fs.readdirSync(claudeSkillsDir, { withFileTypes: true });
        } catch {
            return [];
        }
        const out: string[] = [];
        for (const e of entries) {
            if (!e.isDirectory()) { continue; }
            // A folder is a skill only if it contains a SKILL.md.
            if (fs.existsSync(path.join(claudeSkillsDir, e.name, 'SKILL.md'))) {
                out.push(e.name);
            }
        }
        return out;
    },
};

/** Absolute paths of every file open in an editor tab (file scheme only). */
function collectOpenEditorPaths(): string[] {
    const out: string[] = [];
    for (const group of vscode.window.tabGroups.all) {
        for (const tab of group.tabs) {
            const input = tab.input as { uri?: vscode.Uri } | undefined;
            if (input?.uri && input.uri.scheme === 'file') {
                out.push(input.uri.fsPath);
            }
        }
    }
    return out;
}

/** Gather + rank current-workspace files for the `@` completion. */
async function gatherFileCompletions(query: string): Promise<FileCompletion[]> {
    const wsRoot = WsPaths.wsRoot;
    if (!wsRoot) { return []; }
    const questId = WsPaths.getWorkspaceQuestId();
    const questFolder = WsPaths.ai('quests', questId) ?? null;
    const openEditors = collectOpenEditorPaths();
    // `undefined` exclude honours the user's files.exclude / search.exclude.
    const uris = await vscode.workspace.findFiles('**/*', undefined, 5000);
    const allFiles = uris.map((u) => u.fsPath);
    return rankFiles({ wsRoot, questFolder, openEditors, allFiles, query });
}

// ===========================================================================
// QuickPick presentation
// ===========================================================================

/** Quick-select keys in order: 1-9, 0, then a-z (36 fast slots). */
const QUICK_KEYS = '1234567890abcdefghijklmnopqrstuvwxyz';

interface PickerItem extends vscode.QuickPickItem {
    /** Text to splice into the textarea when chosen. */
    _insert: string;
    /** Single-char quick-select key, or undefined past the 36th item. */
    _quickKey?: string;
}

function skillToItem(skill: SkillCompletion, index: number): PickerItem {
    const qk = QUICK_KEYS[index];
    const prefix = qk ? `${qk}  ` : '';
    return {
        label: `${prefix}$(zap) /${skill.name}`,
        detail: skill.direct ? '(workspace skill)' : `(in ${skill.noteDir})`,
        _insert: formatSkillInsertion(skill),
        _quickKey: qk,
    };
}

function fileToItem(file: FileCompletion, index: number): PickerItem {
    const qk = QUICK_KEYS[index];
    const prefix = qk ? `${qk}  ` : '';
    return {
        label: `${prefix}$(file) ${file.name}`,
        detail: file.relativePath,
        _insert: formatFileInsertion(file),
        _quickKey: qk,
    };
}

function runPicker(
    title: string,
    items: PickerItem[],
    deliver: (insertText: string) => void,
): Promise<void> {
    return new Promise((resolve) => {
        const qp = vscode.window.createQuickPick<PickerItem>();
        qp.title = title;
        qp.placeholder = 'Type to filter, or press the leading number/letter to pick';
        qp.matchOnDetail = true;
        qp.items = items;

        let picked = false;
        const pick = (item: PickerItem) => {
            if (picked) { return; }
            picked = true;
            qp.hide();
            deliver(item._insert);
        };

        // Quick-select: a single typed char matching a leading key picks it
        // immediately (same behaviour as the favorites chord picker).
        qp.onDidChangeValue((value) => {
            if (picked || value.length !== 1) { return; }
            const match = items.find((it) => it._quickKey === value.toLowerCase());
            if (match) { pick(match); }
        });

        qp.onDidAccept(() => {
            const sel = qp.selectedItems[0];
            if (sel) { pick(sel); }
        });

        qp.onDidHide(() => {
            qp.dispose();
            resolve();
        });

        qp.show();
    });
}

// ===========================================================================
// Entry point
// ===========================================================================

/**
 * Show the completion picker for the given `kind`, pre-filtered by
 * `query` (the text the user typed after `/` or `@`). When the user picks
 * an item, `deliver` is invoked with the inline insertion text.
 */
export async function showCompletionPicker(
    kind: CompletionKind,
    query: string,
    deliver: (insertText: string) => void,
): Promise<void> {
    if (kind === 'skill') {
        const skills = discoverSkills(liveSkillStore, query);
        if (skills.length === 0) {
            vscode.window.showInformationMessage(
                query ? `No skills match "/${query}".` : 'No skills found in this workspace or its parent folders.',
            );
            return;
        }
        const title = query ? `Skills matching "/${query}"` : 'Skills';
        await runPicker(title, skills.map(skillToItem), deliver);
        return;
    }

    const files = await gatherFileCompletions(query);
    if (files.length === 0) {
        vscode.window.showInformationMessage(
            query ? `No files match "@${query}".` : 'No files found in this workspace.',
        );
        return;
    }
    const title = query ? `Files matching "@${query}"` : 'Files';
    await runPicker(title, files.map(fileToItem), deliver);
}
