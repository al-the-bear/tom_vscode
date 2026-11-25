/**
 * One choice of the guideline picker (media/shared/aspectPicker.js, gsel5),
 * written to its level: the window, all windows, a run, a queue item, a todo
 * or a @CHAT subpanel's sticky choices (gsel6: its sends' item level). vscode-free: the writers are passed in (services/aspectPickerState.ts
 * liveAspectChoiceWriters is the live set).
 *
 * `''` is *Don't add* (the level's entry goes), `remove` is *Remove*,
 * anything else an option the section has; anything else is refused.
 */

import { withSectionChoice, type AspectChoices } from './aspectChoices';
import { ASPECT_REMOVE, aspectValueText, parseAspectValue, type AspectChoiceValue, type AspectSection } from './aspectGuidelines';

/**
 * The levels a picker sets. `allWindows` is the window level of every open
 * window on this machine; `chat` a @CHAT subpanel's sticky choices.
 */
export type AspectPickerLevel = 'window' | 'allWindows' | 'run' | 'item' | 'todo' | 'chat' | 'questDefault' | 'workspace';
export const ASPECT_PICKER_LEVELS: readonly AspectPickerLevel[] = ['window', 'allWindows', 'run', 'item', 'todo', 'chat', 'questDefault', 'workspace'];

/** The @CHAT subpanels with sticky choices. */
export type AspectPickerChatPanel = 'anthropic';
export const ASPECT_PICKER_CHAT_PANELS: readonly AspectPickerChatPanel[] = ['anthropic'];

/** One choice of the picker. */
export interface AspectChoiceRequest {
    level: AspectPickerLevel;
    section: string;
    /** `''` Don't add, `remove`, a choice, or a list of choices (all with `+`: added to the levels below; gsel20). */
    value: AspectChoiceValue;
    /** run: the run (default: the window's). */
    run?: string;
    /** item: the queue item's id. */
    itemId?: string;
    /** todo: its quest (default: the window's) and id. */
    questId?: string;
    todoId?: string;
    /** chat: the subpanel. */
    panel?: AspectPickerChatPanel;
}

/** Where the non-window levels are written (swapped in tests). */
export interface AspectChoiceWriters {
    sections(): readonly AspectSection[];
    setWindow(section: string, option: AspectChoiceValue | undefined): void;
    /** Answers the other windows it was sent to. */
    setAllWindows(section: string, option: AspectChoiceValue | undefined): string[];
    runChoices(run: string | undefined): AspectChoices | undefined;
    setRun(choices: AspectChoices | undefined, run: string | undefined): void;
    itemChoices(id: string): AspectChoices | undefined | null;
    setItem(id: string, choices: AspectChoices | undefined): boolean;
    todoChoices(questId: string | undefined, todoId: string): AspectChoices | undefined | null;
    setTodo(questId: string | undefined, todoId: string, choices: AspectChoices | undefined): boolean;
    chatChoices(panel: AspectPickerChatPanel): AspectChoices | undefined;
    setChat(panel: AspectPickerChatPanel, choices: AspectChoices | undefined): void;
    /** The quest default (gsel22: its own picker in the Prompt Queue editor). */
    questDefaultChoices?(): AspectChoices | undefined;
    setQuestDefault?(choices: AspectChoices | undefined): void;
    /** The window workspace folder's own entries of the workspace level (gsel22); setting them writes its workspace_aspects.md / .yaml. */
    workspaceChoices?(): AspectChoices | undefined | null;
    setWorkspace?(choices: AspectChoices | undefined): void;
}

/** What a choice did: ok, or why not; `sentTo` for all windows. */
export interface AspectChoiceResult {
    ok: boolean;
    error?: string;
    sentTo?: string[];
}

/** Why `value` is no choice of `section` (undefined: it is). */
export function aspectValueRefusal(sections: readonly AspectSection[], section: string, value: AspectChoiceValue): string | undefined {
    const s = sections.find((x) => x.id === section);
    if (!s) { return `There is no guideline aspect "${section}".`; }
    if (value === '' || value === ASPECT_REMOVE || (Array.isArray(value) && value.length === 0)) { return undefined; }
    const entry = parseAspectValue(value);
    if (!entry || entry.kind === 'remove') { return `The aspect ${s.name}: "${aspectValueText(value)}" is no choice, list of choices or remove.`; }
    const missing = entry.choices.filter((c) => !s.options.some((o) => o.name === c));
    return missing.length ? `The aspect ${s.name} has no choice "${missing.join('", "')}".` : undefined;
}

/** Set one section's choice on one level. */
export function applyAspectChoice(req: AspectChoiceRequest, w: AspectChoiceWriters): AspectChoiceResult {
    if (!ASPECT_PICKER_LEVELS.includes(req.level)) { return { ok: false, error: `Unknown level "${String(req.level)}".` }; }
    const value: AspectChoiceValue = typeof req.value === 'string' || Array.isArray(req.value) ? req.value : '';
    const refusal = aspectValueRefusal(w.sections(), req.section, value);
    if (refusal) { return { ok: false, error: refusal }; }
    // '' and [] are Don't add (no entry on this level).
    const option = value === '' || (Array.isArray(value) && value.length === 0) ? undefined : value;
    switch (req.level) {
        case 'window':
            w.setWindow(req.section, option);
            return { ok: true };
        case 'allWindows':
            return { ok: true, sentTo: w.setAllWindows(req.section, option) };
        case 'run':
            w.setRun(withSectionChoice(w.runChoices(req.run), req.section, option), req.run);
            return { ok: true };
        case 'item': {
            const id = req.itemId ?? '';
            const current = id ? w.itemChoices(id) : null;
            if (current === null) { return { ok: false, error: 'The queue item is gone.' }; }
            return w.setItem(id, withSectionChoice(current, req.section, option))
                ? { ok: true }
                : { ok: false, error: 'Only a staged or pending item can change its guideline choices.' };
        }
        case 'todo': {
            const id = req.todoId ?? '';
            const current = id ? w.todoChoices(req.questId, id) : null;
            if (current === null) { return { ok: false, error: `The todo ${id || '(none)'} was not found.` }; }
            return w.setTodo(req.questId, id, withSectionChoice(current, req.section, option))
                ? { ok: true }
                : { ok: false, error: `The todo ${id} could not be written.` };
        }
        case 'questDefault': {
            if (!w.questDefaultChoices || !w.setQuestDefault) { return { ok: false, error: 'The quest default cannot be set here.' }; }
            w.setQuestDefault(withSectionChoice(w.questDefaultChoices(), req.section, option));
            return { ok: true };
        }
        case 'workspace': {
            if (!w.workspaceChoices || !w.setWorkspace) { return { ok: false, error: 'The workspace level cannot be set here.' }; }
            const current = w.workspaceChoices();
            if (current === null) { return { ok: false, error: 'This window has no Tom workspace folder.' }; }
            w.setWorkspace(withSectionChoice(current, req.section, option));
            return { ok: true };
        }
        case 'chat': {
            const panel = req.panel;
            if (!panel || !ASPECT_PICKER_CHAT_PANELS.includes(panel)) { return { ok: false, error: `Unknown chat panel "${String(panel)}".` }; }
            w.setChat(panel, withSectionChoice(w.chatChoices(panel), req.section, option));
            return { ok: true };
        }
    }
    return { ok: false, error: 'Unknown level.' };
}
