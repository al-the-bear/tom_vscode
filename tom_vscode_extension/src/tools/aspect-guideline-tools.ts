/**
 * Aspect guideline choices for agents (gsel4; design
 * `role_and_guideline_selector.vscode_extension.md`, P-6):
 *
 * - `tomAi_getAspectGuidelines` (read-only) lists the aspects of
 *   `_ai/aspect_guidelines/` with their choices, every level's stored choices
 *   for a context (quest, run, role, todo, queue item) and the effective
 *   selection up to a level, each aspect with the level it comes from. Its
 *   answer says aspect and choice (gsel16); the code below keeps the older
 *   identifiers (sections, options, `sectionDefault`), mapped at the boundary:
 *   the default level is `aspectDefault` in the answer and in `level`.
 * - {@link GUIDELINES_SCHEMA} and {@link guidelinesRefusal}: the `guidelines`
 *   argument of tomAi_createQuestTodo / tomAi_updateQuestTodo (the todo
 *   level), tomAi_addQueueItem / tomAi_updateQueueItem and
 *   tomAi_sendItemToQuest (the item level), checked against the aspects.
 *
 * Agents set the item and todo levels only; the window, run, quest default and
 * all-windows choices are the user's (the guideline selector).
 */

import type { SharedToolDefinition } from './shared-tool-registry';
import { ASPECT_LEVELS, resolveAspects, type AspectLevel, type AspectLevelChoices, type AspectSection } from '../utils/aspectGuidelines';
import { aspectChoicesRefusal, choicesUpTo, normalizeAspectChoices } from '../utils/aspectChoices';

/** The `guidelines` argument: a map of aspect → choice or `remove`. */
export const GUIDELINES_SCHEMA = {
    guidelines: {
        type: ['object', 'null'],
        additionalProperties: { type: 'string' },
        description: 'Guideline choices: an aspect (a folder of `_ai/aspect_guidelines/`) mapped to a choice\'s short name, or to "remove" (nothing is sent for that aspect). An aspect not named inherits from the levels above (quest default, window, run, role type, role; the todo\'s win over the item\'s). Replaces the stored map as a whole; {} or null removes it. Aspects and choices: tomAi_getAspectGuidelines.',
    },
} as const;

/** The aspect default level as the tool names it; the code's name is `sectionDefault`. */
export const ASPECT_DEFAULT_LEVEL = 'aspectDefault';

/** The levels as the tool names them, the highest first. */
export const TOOL_ASPECT_LEVELS: readonly string[] = ASPECT_LEVELS.map((l) => (l === 'sectionDefault' ? ASPECT_DEFAULT_LEVEL : l));

const toolLevel = (l: string | undefined): string | undefined => (l === 'sectionDefault' ? ASPECT_DEFAULT_LEVEL : l);

/** The sections of the store (undefined: none found or no `_ai` folder). */
export type AspectSectionsReader = () => { sections: AspectSection[]; problems: string[] } | undefined;

/**
 * Why `value` cannot be stored as guideline choices: not a map of names, or
 * naming a section or option the store does not have. Undefined when it can;
 * without a store only the form is checked.
 */
export function guidelinesRefusal(value: unknown, readSections: AspectSectionsReader | undefined): string | undefined {
    if (value === undefined || value === null) { return undefined; }
    if (typeof value !== 'object' || Array.isArray(value)) {
        return '`guidelines` must be an object mapping an aspect to a choice name or "remove".';
    }
    const store = readSections?.();
    if (!store) {
        const clean = normalizeAspectChoices(value) ?? {};
        const bad = Object.keys(value as Record<string, unknown>).filter((k) => !(k in clean));
        return bad.length ? `Malformed guideline choices: ${bad.map((k) => `"${k}"`).join(', ')} (aspect and choice names, no "/").` : undefined;
    }
    return aspectChoicesRefusal(value, store.sections);
}

// ---------------------------------------------------------------- tomAi_getAspectGuidelines

export interface GetAspectGuidelinesInput {
    /** The level whose effective selection is answered (default `todo`: everything). */
    level?: string;
    questId?: string;
    run?: string;
    role?: string;
    todoId?: string;
    itemId?: string;
}

/** The context the levels were read for. */
export interface AspectLevelsContext {
    questId?: string;
    run?: string;
    role?: string;
    roleFrom?: string;
    roleType?: string;
    todoId?: string;
    itemId?: string;
}

export interface AspectGuidelineToolsDeps {
    readSections: AspectSectionsReader;
    /** The aspect store's folder (shown). */
    folder(): string | undefined;
    /** Every level's choices for the context, and what the context resolved to. */
    levels(input: GetAspectGuidelinesInput): { levels: AspectLevelChoices; context: AspectLevelsContext; notes: string[] } | { error: string };
}

export function getAspectGuidelinesImpl(deps: AspectGuidelineToolsDeps, input: GetAspectGuidelinesInput): string {
    try {
        const asked = input.level === ASPECT_DEFAULT_LEVEL ? 'sectionDefault' : (input.level ?? 'todo');
        const level = asked as AspectLevel;
        if (!ASPECT_LEVELS.includes(level)) {
            return JSON.stringify({ ok: false, error: `Unknown level "${input.level}" (levels: ${TOOL_ASPECT_LEVELS.join(', ')}).` });
        }
        const store = deps.readSections() ?? { sections: [], problems: [] };
        const read = deps.levels(input);
        if ('error' in read) { return JSON.stringify({ ok: false, error: read.error }); }
        const resolved = resolveAspects(store.sections, choicesUpTo(read.levels, level));
        return JSON.stringify({
            ok: true,
            folder: deps.folder(),
            aspects: store.sections.map((s) => ({
                id: s.id,
                label: s.label,
                placement: s.placement,
                ...(s.defaultOption ? { default: s.defaultOption } : {}),
                choices: s.options.map((o) => o.name),
            })),
            ...(store.problems.length ? { problems: store.problems } : {}),
            context: read.context,
            levels: read.levels,
            level: toolLevel(level),
            selection: resolved.sections.map((r) => {
                const source = !r.removed && r.option ? store.sections.find((s) => s.id === r.section)?.options.find((o) => o.name === r.option)?.source : undefined;
                return {
                    aspect: r.section,
                    choice: r.removed ? 'remove' : (r.option ?? null),
                    from: toolLevel(r.from) ?? null,
                    ...(source ? { file: source.display, ...(source.kind === 'file' ? { guidelineFile: true } : {}) } : {}),
                };
            }),
            ...(resolved.ignored.length ? { ignored: resolved.ignored.map((i) => ({ level: toolLevel(i.level), aspect: i.section, choice: i.option })) } : {}),
            ...(read.notes.length ? { notes: read.notes } : {}),
        });
    } catch (err) {
        return JSON.stringify({ ok: false, error: (err as Error).message });
    }
}

export const GET_ASPECT_GUIDELINES_DESCRIPTION =
    'The guideline aspects (`_ai/aspect_guidelines/<aspect>/`, e.g. language or night mode) with their choices, ' +
    'every level\'s stored choices and the effective selection. Levels, lowest winning: aspectDefault, questDefault (the quest\'s shared ' +
    '`extension_config`), window (this host), run (its queue settings), roleType, role, item (a queue item), todo. ' +
    'Context: `questId` (default this window\'s), `run` (default the window\'s), `role` (default the live role), `todoId` (its role and ' +
    'choices), `itemId` (a queue item: its run, role, todo and choices). `level` cuts the selection at that level (default `todo`: all). ' +
    'Response: `{ok, folder, aspects: [{id, label, placement, default?, choices}], context, levels, level, selection: [{aspect, choice ' +
    '(a name, "remove" or null), from (the deciding level), file (where its text is: own text or a guideline file, guidelineFile)}], ignored?, problems?, notes?}`. Agents set the item and todo levels with the ' +
    '`guidelines` argument of tomAi_addQueueItem / tomAi_updateQueueItem / tomAi_sendItemToQuest / tomAi_createQuestTodo / tomAi_updateQuestTodo.';

export function makeGetAspectGuidelinesTool(deps: () => AspectGuidelineToolsDeps): SharedToolDefinition<GetAspectGuidelinesInput> {
    return {
        name: 'tomAi_getAspectGuidelines',
        displayName: 'Get Aspect Guidelines',
        description: GET_ASPECT_GUIDELINES_DESCRIPTION,
        tags: ['guidelines', 'roles', 'quest', 'tom-ai-chat'],
        readOnly: true,
        inputSchema: {
            type: 'object',
            properties: {
                level: { type: 'string', enum: [...TOOL_ASPECT_LEVELS], description: 'The level whose effective selection is answered. Default `todo` (every level).' },
                questId: { type: 'string', description: 'The quest. Default: this window\'s.' },
                run: { type: 'string', description: 'The run whose choices are read. Default: the window\'s (an item\'s own run with `itemId`).' },
                role: { type: 'string', description: 'The role (a folder of `_ai/roles/`) whose and whose type\'s choices are read. Default: the todo\'s / item\'s, else the live role.' },
                todoId: { type: 'string', description: 'A todo of the quest: its choices and role.' },
                itemId: { type: 'string', description: 'A queue item: its choices, run, role and todo.' },
            },
        },
        execute: async (input) => getAspectGuidelinesImpl(deps(), input ?? {}),
    };
}

// ---------------------------------------------------------------- live dependencies

/* eslint-disable @typescript-eslint/no-require-imports */
function liveDeps(): AspectGuidelineToolsDeps {
    const { WsPaths } = require('../utils/workspacePaths') as typeof import('../utils/workspacePaths');
    const { liveAspectStore, readAspectSections } = require('../services/aspectGuidelinesStore') as typeof import('../services/aspectGuidelinesStore');
    return {
        folder: () => liveAspectStore().dir,
        readSections: () => {
            const { dir, layers } = liveAspectStore();
            return dir ? readAspectSections(dir, layers) : undefined;
        },
        levels: (input) => {
            const levelsMod = require('../services/aspectChoiceLevels') as typeof import('../services/aspectChoiceLevels');
            const { PromptQueueManager } = require('../managers/promptQueueManager') as typeof import('../managers/promptQueueManager');
            const { findTodoById } = require('../managers/questTodoManager') as typeof import('../managers/questTodoManager');
            const { livePromptRole } = require('../services/queueRoleContext') as typeof import('../services/queueRoleContext');
            const quest = input.questId || WsPaths.getWorkspaceQuestId();
            const notes: string[] = [];
            const manager = PromptQueueManager.instance;
            let queued: import('../utils/promptRole').QueueRoleSource | undefined;
            let run = input.run;
            if (input.itemId) {
                const item = manager.getById(input.itemId);
                if (!item) { return { error: `No queue item "${input.itemId}" in this window's queue (tomAi_listQueue).` }; }
                queued = manager.stageRoleSource(item, 'main');
                run = run ?? item.run;
                if (input.run && input.run !== item.run) { queued = { ...queued, runGuidelines: normalizeAspectChoices(manager.runQueueSettings(input.run).guidelines) }; }
            } else if (input.todoId) {
                const todo = quest ? findTodoById(quest, input.todoId) : undefined;
                if (!todo) { return { error: `No todo "${input.todoId}" in quest "${quest}" (tomAi_listQuestTodos).` }; }
                queued = {
                    ...(todo.role ? { todoRole: todo.role } : {}),
                    ...(todo.guidelines ? { todoGuidelines: todo.guidelines } : {}),
                    ...(normalizeAspectChoices(manager.runQueueSettings(run).guidelines) ? { runGuidelines: normalizeAspectChoices(manager.runQueueSettings(run).guidelines) } : {}),
                };
            }
            const role = input.role
                ? { role: input.role, from: 'argument' }
                : queued ? livePromptRole(queued) : livePromptRole();
            const levels = levelsMod.gatherAspectChoices({ questId: quest, run, role: role.role, queued });
            const roles = levelsMod.roleLevelChoices(role.role);
            notes.push(...roles.notes);
            return {
                levels,
                context: {
                    ...(quest ? { questId: quest } : {}),
                    ...(run ? { run } : {}),
                    ...(role.role ? { role: role.role, roleFrom: role.from } : {}),
                    ...(roles.roleTypeName ? { roleType: roles.roleTypeName } : {}),
                    ...(input.todoId ? { todoId: input.todoId } : {}),
                    ...(input.itemId ? { itemId: input.itemId } : {}),
                },
                notes,
            };
        },
    };
}
/* eslint-enable @typescript-eslint/no-require-imports */

/** The live `guidelines` check: against `_ai/aspect_guidelines/`. */
export function liveGuidelinesRefusal(value: unknown): string | undefined {
    return guidelinesRefusal(value, liveSectionsReader);
}

/** The live sections reader (`_ai/aspect_guidelines/`). */
export const liveSectionsReader: AspectSectionsReader = () => {
    try { return liveDeps().readSections(); } catch { return undefined; }
};

export const GET_ASPECT_GUIDELINES_TOOL = makeGetAspectGuidelinesTool(liveDeps);

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export const ASPECT_GUIDELINE_TOOLS: SharedToolDefinition<any>[] = [
    GET_ASPECT_GUIDELINES_TOOL,
];
