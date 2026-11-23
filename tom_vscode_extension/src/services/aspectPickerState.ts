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
import { readLiveAspectSections } from './aspectGuidelinesStore';
import { liveWorkspaceAspects } from './workspaceAspects';
import { chatPanelChoices, questDefaultChoices, roleLevelChoices, setChatPanelChoices, setWindowSectionChoice, windowChoices } from './aspectChoiceLevels';

/** The picker's shared data. */
export interface AspectPickerState extends AspectCatalogue {
    /** The workspace level (workspace_aspects.md / .yaml, gsel19). */
    workspace?: AspectChoices;
    questDefault?: AspectChoices;
    window?: AspectChoices;
    /** Per role under `_ai/roles` with choices: its role type's and its own. */
    roles: Record<string, { roleType?: AspectChoices; role?: AspectChoices }>;
}

function attempt<T>(read: () => T): T | undefined {
    try { return read(); } catch { return undefined; }
}

/** The aspects as `_ai/aspect_guidelines/` and the window's guideline layers hold them (none without an `_ai` folder). */
export function readPickerSections(): { sections: AspectSection[]; problems: string[] } {
    return attempt(() => readLiveAspectSections()) ?? { sections: [], problems: [] };
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
    const ws = attempt(() => liveWorkspaceAspects());
    const workspace = ws && Object.keys(ws.choices).length ? ws.choices : undefined;
    const catalogue = aspectCatalogueOf(read.sections);
    addConditionHolds(catalogue, read.sections);
    return {
        ...catalogue,
        problems: [...read.problems, ...(ws?.problems ?? [])],
        ...(workspace ? { workspace } : {}),
        ...(questDefault ? { questDefault } : {}),
        ...(window ? { window } : {}),
        roles,
    };
}

/** The prompt kinds the picker's levels stand for: a todo's, a queue item's (and a run's), else a chat send's. */
export const PICKER_CONDITION_KINDS = ['chat', 'queue', 'todo'] as const;

/**
 * Whether each condition of the catalogue holds for a prompt of each kind
 * (gsel20): the live facts of this window with that kind (the transport is
 * not known before a send: `''`), the chat variables and placeholders.
 */
export function addConditionHolds(catalogue: AspectCatalogue, sections: readonly AspectSection[], evaluate?: (expression: string, kind: string) => boolean): void {
    const ev = evaluate ?? liveConditionEvaluate(sections);
    for (const c of catalogue.sections) {
        const exprs: Array<[string, string]> = [...Object.entries(c.when ?? {}), ...(c.removeWhen !== undefined ? [['', c.removeWhen] as [string, string]] : [])];
        if (!exprs.length) { continue; }
        c.holds = Object.fromEntries(exprs.map(([choice, expression]) => [choice, Object.fromEntries(PICKER_CONDITION_KINDS.map((kind) => {
            try { return [kind, ev(expression, kind)]; } catch { return [kind, 'error']; }
        }))]));
    }
}

function liveConditionEvaluate(sections: readonly AspectSection[]): (expression: string, kind: string) => boolean {
    /* eslint-disable @typescript-eslint/no-require-imports */
    const { livePromptFacts } = require('./aspectPromptFacts') as typeof import('./aspectPromptFacts');
    const { variableLookup } = require('../utils/variableResolver') as typeof import('../utils/variableResolver');
    const { conditionEvaluator } = require('./aspectGuidelinesStore') as typeof import('./aspectGuidelinesStore');
    /* eslint-enable @typescript-eslint/no-require-imports */
    const lookup = attempt(() => variableLookup());
    const base = attempt(() => livePromptFacts('')) ?? {};
    const byKind = new Map<string, (e: string) => boolean>();
    return (expression, kind) => {
        if (!byKind.has(kind)) { byKind.set(kind, conditionEvaluator(sections, {}, { facts: { ...base, 'prompt.kind': kind }, lookup })); }
        return byKind.get(kind)!(expression);
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
