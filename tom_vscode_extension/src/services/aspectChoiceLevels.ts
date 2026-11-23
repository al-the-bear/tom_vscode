/**
 * Where each level's guideline choices are kept, and the choices a send runs
 * with (gsel4; design `role_and_guideline_selector.vscode_extension.md`,
 * L-1..L-8, P-6). The levels, lowest winning (utils/aspectGuidelines.ts):
 *
 * - **workspace** — `workspace_aspects.md` / `.yaml` of the Tom root and of
 *   each workspace folder down to the window's, the nearer winning per aspect
 *   (services/workspaceAspects.ts; gsel19).
 * - **quest default** — `aspectGuidelines:` in the quest's shared
 *   `extension_config.<quest>.yaml` (a flat map), the same on every host;
 *   *Set as quest default* copies the window's choices there, *Clear quest
 *   default* empties it.
 * - **window** — `aspectGuidelines.window` in the per-host
 *   `extension_config.<host>.<quest>.yaml` (machine-local per quest; survives
 *   a reload). The @CHAT panels' sticky choices are kept beside it
 *   (`aspectGuidelines.chat.anthropic` / `.copilot`); a chat send carries them
 *   as its item level.
 * - **run** — the run's queue settings (`queue-settings.yaml` `runs.<run>.guidelines`).
 * - **role type / role** — `guidelines:` in `role-type.yaml` / `role-config.yaml`
 *   (utils/roleTypes.ts resolveRoleGuidelines).
 * - **item / todo** — the queue item's and the todo's `guidelines`, handed to
 *   the send through the queue stage's role source (utils/promptRole.ts).
 *
 * {@link liveAspectChoices} gathers them for a send; a level that cannot be
 * read adds nothing (a send never fails over a choice).
 */

import type { AspectLevelChoices } from '../utils/aspectGuidelines';
import { normalizeAspectChoices, overrideLevels, withSectionChoice, type AspectChoiceLevel, type AspectChoices } from '../utils/aspectChoices';
import type { QueueRoleSource } from '../utils/promptRole';
import { resolveRoleGuidelines } from '../utils/roleTypes';
import { readMachineSection, readQuestSection, writeMachineSection, writeQuestSection } from '../managers/extensionConfigStore';
import { currentQueueRole, livePromptRole } from './queueRoleContext';

/** The extension-config section both files keep the choices under. */
export const ASPECT_CONFIG_SECTION = 'aspectGuidelines';

/** The @CHAT subpanels with sticky choices. */
export type AspectChatPanel = 'anthropic' | 'copilot';
export const ASPECT_CHAT_PANELS: readonly AspectChatPanel[] = ['anthropic', 'copilot'];

interface MachineSection {
    window?: AspectChoices;
    chat?: Partial<Record<AspectChatPanel, AspectChoices>>;
}

/** What the live gathering reads besides the extension config (swapped in tests). */
export interface AspectChoiceDeps {
    /** The `_ai` folder (role and role-type files). */
    aiRoot(): string | undefined;
    /** The guideline choices of `run` (default: the window's run). */
    runChoices(run?: string): AspectChoices | undefined;
    /** The workspace level's entries (aspect → choice or `remove`). */
    workspaceChoices(): AspectChoices | undefined;
}

const liveDeps: AspectChoiceDeps = {
    aiRoot: () => {
        /* eslint-disable-next-line @typescript-eslint/no-require-imports */
        const { WsPaths } = require('../utils/workspacePaths') as typeof import('../utils/workspacePaths');
        return WsPaths.aiRoot ?? undefined;
    },
    runChoices: (run) => {
        /* eslint-disable-next-line @typescript-eslint/no-require-imports */
        const { PromptQueueManager } = require('../managers/promptQueueManager') as typeof import('../managers/promptQueueManager');
        return PromptQueueManager.instance.runQueueSettings(run).guidelines;
    },
    workspaceChoices: () => {
        /* eslint-disable-next-line @typescript-eslint/no-require-imports */
        const { liveWorkspaceAspects } = require('./workspaceAspects') as typeof import('./workspaceAspects');
        return liveWorkspaceAspects().choices;
    },
};
let deps: AspectChoiceDeps = liveDeps;

/** Swap the dependencies (tests); undefined restores the live ones. */
export function __setAspectChoiceDepsForTests(next: Partial<AspectChoiceDeps> | undefined): void {
    deps = next ? { ...liveDeps, ...next } : liveDeps;
}

function machineSection(questId?: string): MachineSection {
    const raw = readMachineSection<unknown>(ASPECT_CONFIG_SECTION, questId);
    return typeof raw === 'object' && raw !== null && !Array.isArray(raw) ? raw as MachineSection : {};
}

function writeMachine(next: MachineSection, questId?: string): void {
    const chat = Object.fromEntries(Object.entries(next.chat ?? {}).filter(([, v]) => v && Object.keys(v).length));
    const clean: MachineSection = {
        ...(next.window && Object.keys(next.window).length ? { window: next.window } : {}),
        ...(Object.keys(chat).length ? { chat } : {}),
    };
    writeMachineSection(ASPECT_CONFIG_SECTION, Object.keys(clean).length ? clean : undefined, questId);
}

// ---------------------------------------------------------------- quest default

/** The quest default's choices (shared file). */
export function questDefaultChoices(questId?: string): AspectChoices | undefined {
    return normalizeAspectChoices(readQuestSection<unknown>(ASPECT_CONFIG_SECTION, questId));
}

/** Replace the quest default's choices; undefined or `{}` removes the section. */
export function setQuestDefaultChoices(choices: AspectChoices | undefined, questId?: string): void {
    writeQuestSection(ASPECT_CONFIG_SECTION, normalizeAspectChoices(choices), questId);
}

/** *Set as quest default*: the window's choices become the quest default. Answers what was written. */
export function setQuestDefaultFromWindow(questId?: string): AspectChoices | undefined {
    const choices = windowChoices(questId);
    setQuestDefaultChoices(choices, questId);
    return choices;
}

/** *Clear quest default*: the quest default has no choices. */
export function clearQuestDefault(questId?: string): void {
    setQuestDefaultChoices(undefined, questId);
}

// ---------------------------------------------------------------- window and chat panels

/** The window level's choices (this host, this quest). */
export function windowChoices(questId?: string): AspectChoices | undefined {
    return normalizeAspectChoices(machineSection(questId).window);
}

/** Replace the window level's choices. */
export function setWindowChoices(choices: AspectChoices | undefined, questId?: string): void {
    writeMachine({ ...machineSection(questId), window: normalizeAspectChoices(choices) }, questId);
}

/** Set one section of the window level (`option` undefined or `''`: *Don't add*). */
export function setWindowSectionChoice(section: string, option: string | string[] | undefined, questId?: string): void {
    setWindowChoices(withSectionChoice(windowChoices(questId), section, option), questId);
}

/** A @CHAT subpanel's sticky choices (its sends' item level). */
export function chatPanelChoices(panel: AspectChatPanel, questId?: string): AspectChoices | undefined {
    return normalizeAspectChoices(machineSection(questId).chat?.[panel]);
}

/** Replace a @CHAT subpanel's sticky choices. */
export function setChatPanelChoices(panel: AspectChatPanel, choices: AspectChoices | undefined, questId?: string): void {
    const section = machineSection(questId);
    writeMachine({ ...section, chat: { ...(section.chat ?? {}), [panel]: normalizeAspectChoices(choices) } }, questId);
}

// ---------------------------------------------------------------- a send's levels

/** The role and role-type levels of `role` (none without a role or an `_ai` folder). */
export function roleLevelChoices(role: string | undefined): { roleType?: AspectChoices; role?: AspectChoices; roleTypeName?: string; notes: string[] } {
    const aiRoot = deps.aiRoot();
    if (!aiRoot || !role) { return { notes: [] }; }
    const resolved = resolveRoleGuidelines(aiRoot, role);
    return {
        ...(resolved.roleTypeChoices ? { roleType: normalizeAspectChoices(resolved.roleTypeChoices) } : {}),
        ...(resolved.roleChoices ? { role: normalizeAspectChoices(resolved.roleChoices) } : {}),
        ...(resolved.roleType ? { roleTypeName: resolved.roleType } : {}),
        notes: resolved.notes,
    };
}

function attempt<T>(read: () => T): T | undefined {
    try { return read(); } catch { return undefined; }
}

/** What {@link gatherAspectChoices} gathers for: everything optional. */
export interface AspectChoiceContext {
    questId?: string;
    /** The run (outside a queue stage; default: the window's run). */
    run?: string;
    /** The role the send runs as (default: the live role). */
    role?: string;
    /** The queue stage's role source (todo, item and run choices). */
    queued?: QueueRoleSource;
}

/**
 * The levels of a send: workspace, quest default, window, run, role type, role, item and
 * todo. Inside a queue stage the run, item and todo come from its role source;
 * outside, the run is the window's.
 */
export function gatherAspectChoices(ctx: AspectChoiceContext = {}): AspectLevelChoices {
    const levels: AspectLevelChoices = {};
    const put = (level: AspectChoiceLevel, choices: AspectChoices | undefined): void => {
        const clean = normalizeAspectChoices(choices);
        if (clean) { levels[level] = clean; }
    };
    put('workspace', attempt(() => deps.workspaceChoices()));
    put('questDefault', attempt(() => questDefaultChoices(ctx.questId)));
    put('window', attempt(() => windowChoices(ctx.questId)));
    put('run', ctx.queued ? ctx.queued.runGuidelines : attempt(() => deps.runChoices(ctx.run)));
    const role = ctx.role ?? attempt(() => livePromptRole(ctx.queued).role);
    const roles = attempt(() => roleLevelChoices(role));
    put('roleType', roles?.roleType);
    put('role', roles?.role);
    put('item', ctx.queued?.itemGuidelines);
    put('todo', ctx.queued?.todoGuidelines);
    return levels;
}

/**
 * The choices a send runs with now: the live levels (the queue stage the code
 * runs in, if any), with `explicit`'s levels replacing them (a chat send's
 * item level).
 */
export function liveAspectChoices(explicit?: AspectLevelChoices, queued: QueueRoleSource | undefined = currentQueueRole()): AspectLevelChoices {
    return overrideLevels(gatherAspectChoices({ queued }), explicit);
}

/**
 * The levels a @CHAT subpanel's send replaces in the live ones: its run's
 * (the panel's Run select) and its sticky choices as the item level. Pass to
 * {@link liveAspectChoices} (or AnthropicSendOptions.aspectGuidelineChoices).
 */
export function chatSendAspectChoices(panel: AspectChatPanel, run: string | undefined): AspectLevelChoices {
    return {
        run: attempt(() => normalizeAspectChoices(deps.runChoices(run))) ?? {},
        item: attempt(() => chatPanelChoices(panel)) ?? {},
    };
}

// ---------------------------------------------------------------- all windows

/** How an all-windows change reaches the other windows (services/windowRequests.ts in the extension). */
export interface AspectBroadcastDeps {
    /** This window's id. */
    ownWindowId: string | undefined;
    /** The open windows on this machine (this one may be among them). */
    windowIds(): string[];
    /** Send the change to one window; answers whether it was written. */
    send(windowId: string, section: string, option: string | string[] | undefined): boolean;
}

/**
 * The all-windows change (L-4): one section set to `option` (or *Don't add*
 * with undefined) in this window's level now, and sent to every other open
 * window on this machine, which sets it in its own window level. Only that
 * section changes anywhere. Answers the windows it was sent to.
 */
export function setSectionChoiceInAllWindows(section: string, option: string | string[] | undefined, broadcast: AspectBroadcastDeps, questId?: string): string[] {
    setWindowSectionChoice(section, option, questId);
    const sent: string[] = [];
    for (const id of new Set(broadcast.windowIds())) {
        if (id === broadcast.ownWindowId) { continue; }
        if (broadcast.send(id, section, option)) { sent.push(id); }
    }
    return sent;
}

/** The open windows on this machine: alive window-state files whose id ends in this machine's part. */
export function openWindowsOnThisMachine(states: ReadonlyArray<{ windowId?: string; alive: boolean }>, ownWindowId: string | undefined): string[] {
    const machine = ownWindowId?.split('_').pop();
    if (!machine) { return []; }
    return states.filter((s) => s.alive && typeof s.windowId === 'string' && s.windowId.endsWith(`_${machine}`)).map((s) => s.windowId as string);
}

