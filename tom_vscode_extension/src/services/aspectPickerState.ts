/**
 * What the guideline picker (media/shared/aspectPicker.js, gsel5) is drawn
 * from, and the choices it writes (design `role_and_guideline_selector.vscode_extension.md`
 * P-1..P-3, L-2..L-4).
 *
 * - {@link aspectPickerState}: the sections (names, labels, options, default;
 *   not the texts) and the levels every picker shares — the quest default,
 *   the window, and the role / role-type choices of every role under
 *   `_ai/roles`. The page adds the run, item and todo levels it has.
 * - {@link applyAspectChoice}: one section's choice on one level — the
 *   window, all windows, a run, a queue item, a todo or a @CHAT subpanel
 *   (gsel6). `''` is *Don't add*
 *   (the entry goes), `remove` is *Remove*, anything else an option the
 *   section has.
 *
 * A level that cannot be read adds nothing: the picker always opens.
 */

import { aspectCatalogueOf, type AspectCatalogue, type AspectChoices } from '../utils/aspectChoices';
import type { AspectSection } from '../utils/aspectGuidelines';
import type { AspectChoiceWriters } from '../utils/aspectPickerChoice';
export { applyAspectChoice, aspectValueRefusal, ASPECT_PICKER_LEVELS, type AspectChoiceRequest, type AspectChoiceResult, type AspectChoiceWriters, type AspectPickerLevel } from '../utils/aspectPickerChoice';
import { listRoleNames } from '../utils/roleNames';
import { WsPaths } from '../utils/workspacePaths';
import { ASPECT_GUIDELINES_FOLDER, readAspectSections } from './aspectGuidelinesStore';
import { chatPanelChoices, questDefaultChoices, roleLevelChoices, setChatPanelChoices, setWindowSectionChoice, windowChoices } from './aspectChoiceLevels';

/** The picker's shared data. */
export interface AspectPickerState extends AspectCatalogue {
    questDefault?: AspectChoices;
    window?: AspectChoices;
    /** Per role under `_ai/roles` with choices: its role type's and its own. */
    roles: Record<string, { roleType?: AspectChoices; role?: AspectChoices }>;
}

function attempt<T>(read: () => T): T | undefined {
    try { return read(); } catch { return undefined; }
}

/** The sections as `_ai/aspect_guidelines/` holds them (none without an `_ai` folder). */
export function readPickerSections(): { sections: AspectSection[]; problems: string[] } {
    const dir = attempt(() => WsPaths.ai(ASPECT_GUIDELINES_FOLDER));
    return (dir ? attempt(() => readAspectSections(dir)) : undefined) ?? { sections: [], problems: [] };
}

/** The picker's shared data, read now. */
export function aspectPickerState(): AspectPickerState {
    const read = readPickerSections();
    const roles: AspectPickerState['roles'] = {};
    for (const role of attempt(() => listRoleNames(WsPaths.ai('roles'))) ?? []) {
        const levels = attempt(() => roleLevelChoices(role));
        if (levels && (levels.roleType || levels.role)) {
            roles[role] = { ...(levels.roleType ? { roleType: levels.roleType } : {}), ...(levels.role ? { role: levels.role } : {}) };
        }
    }
    const questDefault = attempt(() => questDefaultChoices());
    const window = attempt(() => windowChoices());
    return {
        ...aspectCatalogueOf(read.sections),
        problems: read.problems,
        ...(questDefault ? { questDefault } : {}),
        ...(window ? { window } : {}),
        roles,
    };
}

/* eslint-disable @typescript-eslint/no-require-imports */
/** The live writers: the extension config, the prompt queue and the todo files. */
export function liveAspectChoiceWriters(): AspectChoiceWriters {
    const queue = (require('../managers/promptQueueManager') as typeof import('../managers/promptQueueManager')).PromptQueueManager;
    const todos = require('../managers/questTodoManager') as typeof import('../managers/questTodoManager');
    const { setSectionChoiceForAllWindows } = require('../handlers/aspectChoiceCommands') as typeof import('../handlers/aspectChoiceCommands');
    const quest = (questId: string | undefined): string => questId || WsPaths.getWorkspaceQuestId();
    return {
        sections: () => readPickerSections().sections,
        setWindow: (section, option) => setWindowSectionChoice(section, option),
        setAllWindows: (section, option) => setSectionChoiceForAllWindows(section, option),
        runChoices: (run) => queue.instance.runQueueSettings(run).guidelines,
        setRun: (choices, run) => queue.instance.setRunGuidelines(choices, run),
        itemChoices: (id) => {
            const item = queue.instance.getById(id);
            return item ? item.guidelines : null;
        },
        setItem: (id, choices) => queue.instance.updateItemGuidelines(id, choices),
        todoChoices: (questId, todoId) => {
            const todo = todos.findTodoById(quest(questId), todoId);
            return todo ? todo.guidelines : null;
        },
        setTodo: (questId, todoId, choices) => !!todos.updateTodo(quest(questId), todoId, { guidelines: choices ?? {} }),
        chatChoices: (panel) => chatPanelChoices(panel),
        setChat: (panel, choices) => setChatPanelChoices(panel, choices),
    };
}
/* eslint-enable @typescript-eslint/no-require-imports */
