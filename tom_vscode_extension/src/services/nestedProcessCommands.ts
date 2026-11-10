/**
 * Starting and aborting a subprocess or branch (src/utils/processStack.ts).
 *
 * - **@T: Start Subprocess or Branch…** (`tomAi.process.startNested`, the
 *   PROCESS view's title bar): the running step's listed processes, both
 *   lists; then the follow-up the step gets when the level ends (go on past
 *   the step, run the step again, or ask at the end); beyond the maximum
 *   depth (`processNesting.maxDepth`, default 5, Status Page) a confirmation.
 *   The new level starts at its process's first position; the step below
 *   waits, and the new level's first Proceed goes in the queue behind that
 *   step's unfinished items.
 * - **@T: Abort Subprocess or Branch** (`tomAi.process.abortNested`): with a
 *   confirmation, the running level goes (written to the decisions journal)
 *   and the step below goes on with its follow-up.
 */

import * as vscode from 'vscode';

import { ProcessStateStore } from '../managers/processStateStore';
import { PromptQueueManager } from '../managers/promptQueueManager';
import { loadSendToChatConfig } from '../utils/sendToChatConfig';
import {
    DEFAULT_MAX_PROCESS_DEPTH,
    NESTED_FOLLOW_UP_LABELS,
    levelName,
    nestingDepth,
    positionProcessLists,
    startNeedsConfirmation,
    topLevel,
} from '../utils/processStack';
import type { NestedFollowUp, NestedKind } from '../utils/processDefinition';

export const START_NESTED_COMMAND = 'tomAi.process.startNested';
export const ABORT_NESTED_COMMAND = 'tomAi.process.abortNested';

/** The depth above which a start is confirmed (Status Page: Process nesting). */
export function maxProcessDepth(): number {
    const raw = loadSendToChatConfig()?.processNesting?.maxDepth;
    return Number.isInteger(raw) && (raw as number) >= 0 ? raw as number : DEFAULT_MAX_PROCESS_DEPTH;
}

/** What the start dialog needs, injectable for tests. */
export interface NestedStartUi {
    pickProcess(items: Array<{ label: string; description: string; detail?: string; nestedKind: NestedKind; process: string }>): Promise<{ kind: NestedKind; process: string } | undefined>;
    pickFollowUp(items: Array<{ label: string; followUp: NestedFollowUp }>): Promise<NestedFollowUp | undefined>;
    confirm(message: string, detail: string, button: string): Promise<boolean>;
    info(message: string): void;
    error(message: string): void;
}

/**
 * Start a level from the running step: pick, follow-up, depth confirmation,
 * push. `recommended` (the agent's follow-up for its suggestion) is offered
 * first and marked; without it "ask me at the end" comes first.
 */
export async function startNestedProcess(store: ProcessStateStore, ui: NestedStartUi, maxDepth: number = maxProcessDepth(), recommended?: NestedFollowUp): Promise<boolean> {
    const top = store.state;
    const def = store.currentDefinition();
    if (!def || !top.process) { ui.error('The quest has no process: set one in the PROCESS view first.'); return false; }
    const lists = positionProcessLists(def, top);
    const items = [
        ...lists.subprocesses.map((e) => ({ kind: 'subprocess' as const, process: e.process, description: e.description })),
        ...lists.branches.map((e) => ({ kind: 'branch' as const, process: e.process, description: e.description })),
    ].map((e) => {
        const target = store.entry(e.process);
        return {
            label: `${e.kind === 'subprocess' ? '$(debug-step-into) Subprocess' : '$(git-branch) Branch'}: ${target?.definition?.name || e.process}`,
            description: e.kind === 'subprocess' ? 'hands a result back to this step' : 'hands nothing back',
            detail: e.description || target?.definition?.summary || (target?.definition ? undefined : 'not defined (or its definition is invalid)'),
            nestedKind: e.kind,
            process: e.process,
        };
    });
    if (!items.length) { ui.info(`The step ${top.step} lists no subprocesses or branches (\`subprocesses:\` / \`branches:\` in its definition).`); return false; }
    const picked = await ui.pickProcess(items);
    if (!picked) { return false; }
    const order = (['ask', 'go-on', 'run-again'] as NestedFollowUp[]).sort((a, b) => Number(b === recommended) - Number(a === recommended));
    const followUp = await ui.pickFollowUp(order.map((f) => ({ label: `${NESTED_FOLLOW_UP_LABELS[f]}${f === recommended ? ' (recommended)' : ''}`, followUp: f })));
    if (!followUp) { return false; }
    const levels = store.levels;
    if (startNeedsConfirmation(levels, maxDepth)) {
        const ok = await ui.confirm(
            `Start ${picked.process} at nesting depth ${nestingDepth(levels) + 1}?`,
            `The quest's process stack is ${nestingDepth(levels)} level(s) deep above its own process, beyond the maximum of ${maxDepth} (Status Page, Process nesting). A process may start itself again; this asks so a runaway chain stops.`,
            'Start',
        );
        if (!ok) { return false; }
    }
    const result = store.startNested(picked.kind, picked.process, followUp, 'user');
    if (!result.ok) { ui.error(`Could not start ${picked.process}: ${result.error}`); return false; }
    const waiting = queueItemsLeft(store);
    ui.info(`Started ${levelName(topLevel(store.levels))}${waiting ? ` — its first Proceed goes in behind the ${waiting} item(s) of the step below still in the queue` : ''}.`);
    return true;
}

/** The step below's items still in the queue (its open run), 0 when none. */
function queueItemsLeft(store: ProcessStateStore): number {
    try {
        return PromptQueueManager.instance.stepRunProgress(store.activeQuest, store.levelIndex - 1)?.left ?? 0;
    } catch {
        return 0;
    }
}

/** Abort the running level after a confirmation. */
export async function abortNestedProcess(store: ProcessStateStore, ui: Pick<NestedStartUi, 'confirm' | 'info' | 'error'>): Promise<boolean> {
    const levels = store.levels;
    if (levels.length < 2) { ui.info('No subprocess or branch is running.'); return false; }
    const top = topLevel(levels);
    const ok = await ui.confirm(
        `Abort ${levelName(top)}?`,
        `It stands at ${top.phase} › ${top.step}. The level is removed (its position is written to the decisions journal) and the step below goes on: ${NESTED_FOLLOW_UP_LABELS[top.nested?.followUp ?? 'ask']}.`,
        'Abort',
    );
    if (!ok) { return false; }
    const result = store.abortNested('user');
    if (!result.ok) { ui.error(`Could not abort: ${result.error}`); return false; }
    return true;
}

const liveUi: NestedStartUi = {
    pickProcess: async (items) => {
        const pick = await vscode.window.showQuickPick(items, { title: 'Start from this step', placeHolder: 'The processes the step lists' });
        return pick ? { kind: pick.nestedKind, process: pick.process } : undefined;
    },
    pickFollowUp: async (items) => (await vscode.window.showQuickPick(items, { title: 'When it ends, the step…', placeHolder: 'What the step does when the level ends' }))?.followUp,
    confirm: async (message, detail, button) => (await vscode.window.showWarningMessage(message, { modal: true, detail }, button)) === button,
    info: (message) => { void vscode.window.showInformationMessage(message); },
    error: (message) => { void vscode.window.showErrorMessage(message); },
};

/** Register both commands (once, at activation). */
export function registerNestedProcessCommands(context: vscode.ExtensionContext): void {
    context.subscriptions.push(
        vscode.commands.registerCommand(START_NESTED_COMMAND, async () => startNestedProcess(await ProcessStateStore.ready, liveUi)),
        vscode.commands.registerCommand(ABORT_NESTED_COMMAND, async () => abortNestedProcess(await ProcessStateStore.ready, liveUi)),
    );
}
