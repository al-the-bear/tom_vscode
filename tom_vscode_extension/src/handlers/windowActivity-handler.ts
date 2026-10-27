/**
 * What this window writes about itself into its state file, with every
 * heartbeat and when it changes (tomAi_getQuestWindowStatus reads it): the
 * host, the role, the quest's process position, the ANTHROPIC panel's profile
 * and session, and the queue summary (src/utils/windowActivity.ts).
 *
 * Every part is read best-effort: a store that is not initialised (yet) is
 * left out rather than failing the heartbeat.
 */

import * as os from 'os';
import * as vscode from 'vscode';

import { ACTIVE_ANTHROPIC_PROFILE_KEY } from '../tools/scripting-tools-bridge';
import { WsPaths } from '../utils/workspacePaths';
import type { WindowActivity } from '../utils/questWindowStatus';
import { summarizeQueue } from '../utils/windowActivity';
import { chatSessionFor } from './sessionPicker';

/** The panel's session key when none is chosen (anthropic-handler.ts ANTHROPIC_CHAT_SESSION_KEY). */
const PANEL_DEFAULT_SESSION = 'chat';

export function collectWindowActivity(context: vscode.ExtensionContext): WindowActivity {
    const activity: WindowActivity = { host: os.hostname() };
    const quest = WsPaths.getWorkspaceQuestId() || '';
    try {
        // eslint-disable-next-line @typescript-eslint/no-require-imports
        const { ChatVariablesStore } = require('../managers/chatVariablesStore') as typeof import('../managers/chatVariablesStore');
        const role = ChatVariablesStore.instance.role;
        if (role) { activity.role = role; }
    } catch { /* not initialised */ }
    try {
        // eslint-disable-next-line @typescript-eslint/no-require-imports
        const { ProcessStateStore } = require('../managers/processStateStore') as typeof import('../managers/processStateStore');
        const state = ProcessStateStore.instance?.state;
        activity.process = state?.process ? {
            process: state.process,
            ...(state.phase ? { phase: state.phase, phaseIteration: state.phaseIteration } : {}),
            ...(state.step ? { step: state.step, stepIteration: state.stepIteration } : {}),
            ...(state.substep ? { substep: state.substep, substepIteration: state.substepIteration } : {}),
            ...(state.decision ? { decision: true } : {}),
            ...(state.completed ? { completed: true } : {}),
        } : null;
    } catch { /* not initialised */ }
    try {
        const profileId = context.workspaceState.get<string>(ACTIVE_ANTHROPIC_PROFILE_KEY, '');
        activity.panel = {
            ...(profileId ? { profileId } : {}),
            session: chatSessionFor(context.workspaceState, quest, PANEL_DEFAULT_SESSION),
        };
    } catch { /* no workspace state */ }
    try {
        // eslint-disable-next-line @typescript-eslint/no-require-imports
        const { PromptQueueManager } = require('../managers/promptQueueManager') as typeof import('../managers/promptQueueManager');
        const qm = PromptQueueManager.instance;
        activity.queue = summarizeQueue({
            items: qm.items,
            autoSend: qm.autoSendEnabled,
            defaultTransport: qm.defaultTransport,
            defaultProfileId: qm.defaultAnthropicProfileId,
            defaultSession: qm.defaultAgentSdkSession,
        });
    } catch { /* the queue is not initialised */ }
    return activity;
}

// ---------------------------------------------------------------------------
// Written on change, not only with the 30 s heartbeat
// ---------------------------------------------------------------------------

/** How soon after a change the state file is rewritten (a burst of queue changes writes once). */
const CHANGE_DEBOUNCE_MS = 1_000;

let writeNow: (() => void) | undefined;

/** The heartbeat's write (extension.ts), run again when something it reports changes. */
export function setWindowActivityBeat(beat: () => void): void {
    writeNow = beat;
}

/**
 * Rewrite the window state soon after the role or another chat variable, the
 * process position, the queue or the ANTHROPIC panel's profile changes.
 * Called once the stores are initialised.
 */
export function watchWindowActivity(context: vscode.ExtensionContext): void {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const soon = (): void => {
        if (timer) { clearTimeout(timer); }
        timer = setTimeout(() => { timer = undefined; writeNow?.(); }, CHANGE_DEBOUNCE_MS);
    };
    context.subscriptions.push({ dispose: () => { if (timer) { clearTimeout(timer); } } });
    const subscribe = (event: vscode.Event<unknown> | undefined): void => {
        if (event) { context.subscriptions.push(event(() => soon())); }
    };
    try {
        // eslint-disable-next-line @typescript-eslint/no-require-imports
        const { ChatVariablesStore } = require('../managers/chatVariablesStore') as typeof import('../managers/chatVariablesStore');
        subscribe(ChatVariablesStore.instance.onDidChange as vscode.Event<unknown>);
    } catch { /* not initialised */ }
    try {
        // eslint-disable-next-line @typescript-eslint/no-require-imports
        const { ProcessStateStore } = require('../managers/processStateStore') as typeof import('../managers/processStateStore');
        subscribe(ProcessStateStore.instance?.onDidChange as vscode.Event<unknown> | undefined);
    } catch { /* not initialised */ }
    try {
        // eslint-disable-next-line @typescript-eslint/no-require-imports
        const { PromptQueueManager } = require('../managers/promptQueueManager') as typeof import('../managers/promptQueueManager');
        subscribe(PromptQueueManager.instance.onDidChange as vscode.Event<unknown>);
    } catch { /* not initialised */ }
}
