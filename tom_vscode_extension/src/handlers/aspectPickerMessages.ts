/**
 * The guideline picker's messages (media/shared/aspectPicker.js, gsel5), the
 * same in every page that shows it (the Prompt Queue editor, the todo panel
 * and editor):
 *
 * - `aspectChoose` `{ level, section, value, run?, itemId?, questId?, todoId? }`:
 *   one section's choice on one level (services/aspectPickerState.ts
 *   applyAspectChoice); a refusal is shown as a warning.
 * - `aspectQuestDefault` `{ action: 'set' | 'clear' }`: *Set as quest default*
 *   / *Clear quest default* (handlers/aspectChoiceCommands.ts).
 * - `aspectEditSections`: *Edit sections…* — the section editor when the
 *   extension has it, else the `_ai/aspect_guidelines/` folder in the Explorer.
 *
 * Answers whether the message was the picker's and whether a level changed
 * (the page then sends its state again).
 */

import * as fs from 'fs';
import * as vscode from 'vscode';

import { applyAspectChoice, liveAspectChoiceWriters, type AspectChoiceRequest } from '../services/aspectPickerState';
import { ASPECT_GUIDELINES_FOLDER } from '../services/aspectGuidelinesStore';
import { WsPaths } from '../utils/workspacePaths';
import { clearQuestDefaultGuidelines, setQuestDefaultGuidelines } from './aspectChoiceCommands';

/** The command of the section editor page (P-4). */
export const ASPECT_SECTION_EDITOR_COMMAND = 'tomAi.editor.aspectSections';

/** The message types the picker posts. */
export const ASPECT_PICKER_MESSAGE_TYPES = ['aspectChoose', 'aspectQuestDefault', 'aspectEditSections'] as const;

const str = (v: unknown): string | undefined => (typeof v === 'string' && v.trim() ? v.trim() : undefined);

/** Handle one picker message. */
export async function handleAspectPickerMessage(msg: { type?: unknown; [key: string]: unknown }): Promise<{ handled: boolean; changed: boolean }> {
    switch (msg?.type) {
        case 'aspectChoose': {
            const req: AspectChoiceRequest = {
                level: msg.level as AspectChoiceRequest['level'],
                section: typeof msg.section === 'string' ? msg.section : '',
                value: typeof msg.value === 'string' ? msg.value : '',
                run: str(msg.run),
                itemId: str(msg.itemId),
                questId: str(msg.questId),
                todoId: str(msg.todoId),
            };
            let result;
            try {
                result = applyAspectChoice(req, liveAspectChoiceWriters());
            } catch (err) {
                result = { ok: false, error: (err as Error).message };
            }
            if (!result.ok) {
                void vscode.window.showWarningMessage(`Guideline choice not set: ${result.error ?? 'unknown reason'}`);
                return { handled: true, changed: false };
            }
            if (req.level === 'allWindows') {
                const n = result.sentTo?.length ?? 0;
                vscode.window.setStatusBarMessage(`Guideline choice set in this window and ${n} other window${n === 1 ? '' : 's'}.`, 5000);
            }
            return { handled: true, changed: true };
        }
        case 'aspectQuestDefault': {
            try {
                if (msg.action === 'clear') {
                    clearQuestDefaultGuidelines();
                    vscode.window.setStatusBarMessage('The quest default guideline choices are cleared.', 5000);
                } else {
                    const choices = setQuestDefaultGuidelines();
                    const text = choices ? Object.entries(choices).map(([s, o]) => `${s}: ${o}`).join(', ') : 'none (the window has no choices)';
                    vscode.window.setStatusBarMessage(`Quest default guideline choices: ${text}.`, 5000);
                }
            } catch (err) {
                void vscode.window.showErrorMessage(`The quest default could not be written: ${(err as Error).message}`);
                return { handled: true, changed: false };
            }
            return { handled: true, changed: true };
        }
        case 'aspectEditSections': {
            await openSectionEditor();
            return { handled: true, changed: false };
        }
        default:
            return { handled: false, changed: false };
    }
}

/** *Edit sections…*: the section editor page when there is one, else the sections folder. */
async function openSectionEditor(): Promise<void> {
    const commands = await vscode.commands.getCommands(true);
    if (commands.includes(ASPECT_SECTION_EDITOR_COMMAND)) {
        await vscode.commands.executeCommand(ASPECT_SECTION_EDITOR_COMMAND);
        return;
    }
    const dir = WsPaths.ai(ASPECT_GUIDELINES_FOLDER);
    if (!dir) {
        void vscode.window.showWarningMessage('This workspace has no _ai folder: there are no guideline sections to edit.');
        return;
    }
    if (!fs.existsSync(dir)) { fs.mkdirSync(dir, { recursive: true }); }
    await vscode.commands.executeCommand('revealInExplorer', vscode.Uri.file(dir));
    void vscode.window.showInformationMessage('The guideline sections are the folders under _ai/aspect_guidelines/: a section.yaml and one <option>.md per option.');
}
