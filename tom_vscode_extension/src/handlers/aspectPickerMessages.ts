/**
 * The guideline picker's messages (media/shared/aspectPicker.js, gsel5), the
 * same in every page that shows it (the Prompt Queue editor, the todo panel
 * and editor, the @CHAT subpanels):
 *
 * - `aspectChoose` `{ level, section, value, run?, itemId?, questId?, todoId?, panel? }`:
 *   one section's choice on one level (services/aspectPickerState.ts
 *   applyAspectChoice); a refusal is shown as a warning.
 * - `aspectQuestDefault` `{ action: 'set' | 'clear' }`: *Set as quest default*
 *   / *Clear quest default* (handlers/aspectChoiceCommands.ts).
 * - `aspectEditSections`: *Edit aspects…* — the Aspect Guidelines editor page
 *   (aspectSectionEditor-handler.ts, `tomAi.editor.aspectSections`).
 *
 * Answers whether the message was the picker's and whether a level changed.
 * After a change every view showing the picker is redrawn — the page it came
 * from and the others (aspectViewsRefresh.ts) — so the page itself sends
 * nothing again.
 */

import * as vscode from 'vscode';

import { applyAspectChoice, liveAspectChoiceWriters, type AspectChoiceRequest } from '../services/aspectPickerState';
import { clearQuestDefaultGuidelines, setQuestDefaultGuidelines } from './aspectChoiceCommands';
import { ASPECT_SECTION_EDITOR_COMMAND } from './aspectSectionEditor-handler';
import { refreshAspectViews } from './aspectViewsRefresh';

export { ASPECT_SECTION_EDITOR_COMMAND };

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
                panel: str(msg.panel) as AspectChoiceRequest['panel'],
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
            refreshAspectViews();
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
            refreshAspectViews();
            return { handled: true, changed: true };
        }
        case 'aspectEditSections': {
            await vscode.commands.executeCommand(ASPECT_SECTION_EDITOR_COMMAND);
            return { handled: true, changed: false };
        }
        default:
            return { handled: false, changed: false };
    }
}

