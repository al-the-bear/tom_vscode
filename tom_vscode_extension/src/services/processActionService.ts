/**
 * Process actions — what happens when the user uses the PROCESS view's action
 * bar. Proceed: the Proceed template (processActionPrompt.ts) is resolved for
 * the CURRENT position, the prompt is added to the prompt queue (which sends
 * it) carrying that position, and then the state moves on — or, at a decision
 * point, stays marked as run. Every other move only moves the state, and so
 * does Proceed at a user action (confirmed by the user in the PROCESS view).
 *
 * The preview on the action page and the queued text come from the same
 * {@link buildProcessActionPrompt}, so what the page shows is what is queued.
 */

import * as vscode from 'vscode';

import { ProcessStateStore } from '../managers/processStateStore';
import { PromptQueueManager } from '../managers/promptQueueManager';
import { loadSendToChatConfig, saveSendToChatConfig } from '../utils/sendToChatConfig';
import { resolveVariables } from '../utils/variableResolver';
import { createSession, readSession } from './agentSdkSessionStore';
import { TwoTierMemoryService } from './memory-service';
import {
    actionSession,
    DEFAULT_PROCESS_ACTION_TEMPLATES,
    PROCESS_TEMPLATE_KINDS,
    processActionTemplate,
    processActionValues,
    type ProcessActionTemplates,
} from '../utils/processActionPrompt';
import { decisionAt, userActionAt, type ProcessLevel, type ProcessMove, type ProcessMoveKind } from '../utils/processDefinition';

const templatesChanged = new vscode.EventEmitter<void>();
/** Fires after the templates were saved, so an open action page refreshes its preview. */
export const onDidChangeProcessActionTemplates: vscode.Event<void> = templatesChanged.event;

/** The configured template (left out: the default). */
export function configuredProcessActionTemplates(): ProcessActionTemplates {
    const raw = (loadSendToChatConfig()?.processActionTemplates ?? {}) as Record<string, unknown>;
    return typeof raw.proceed === 'string' ? { proceed: raw.proceed } : {};
}

/** Store the template; one equal to its default is dropped, so it follows later default changes. */
export function saveProcessActionTemplates(templates: ProcessActionTemplates): boolean {
    const config = loadSendToChatConfig();
    if (!config) { return false; }
    const own: ProcessActionTemplates = {};
    for (const kind of PROCESS_TEMPLATE_KINDS) {
        const text = templates[kind];
        if (typeof text === 'string' && text !== DEFAULT_PROCESS_ACTION_TEMPLATES[kind]) { own[kind] = text; }
    }
    config.processActionTemplates = own;
    const saved = saveSendToChatConfig(config);
    if (saved) { templatesChanged.fire(); }
    return saved;
}

/** The prompt Proceed queues with these custom instructions; `''` for another move or a template that resolves to nothing. */
export function buildProcessActionPrompt(
    store: ProcessStateStore,
    move: ProcessMove,
    customInstructions: string,
    templateOverride?: string,
    sessionOverride?: string,
): string {
    const def = store.currentDefinition();
    if (!def || move.kind !== 'proceed') { return ''; }
    const template = templateOverride ?? processActionTemplate('proceed', configuredProcessActionTemplates());
    if (!template.trim()) { return ''; }
    const values = processActionValues(def, store.state, move, customInstructions, store.processDescription());
    // `${session}`: the session the prompt is queued in (picked on the page or named by the process).
    values.session = actionSession(def, store.state, sessionOverride).name;
    return resolveVariables(template, { values }).trim();
}

/**
 * Make sure the session the process names exists: created from the
 * definition's spec when missing (its base first, plainly, when that is
 * missing too). A session picked on the page exists already.
 */
function ensureProcessSession(questId: string, spec: { name: string; basedOn?: string; mode?: 'continue' | 'fork-from-base' }): string | undefined {
    const folder = TwoTierMemoryService.instance.agentSdkSessionsFolder(questId || undefined);
    if (readSession(folder, spec.name)) { return undefined; }
    if (spec.basedOn && !readSession(folder, spec.basedOn)) {
        const base = createSession(folder, spec.basedOn, {});
        if (!base.ok) { return base.error; }
    }
    const made = createSession(folder, spec.name, { basedOn: spec.basedOn, mode: spec.mode });
    return made.ok ? undefined : made.error;
}

export type ProcessActionResult =
    | { ok: true; queued: boolean; label: string }
    | { ok: false; error: string };

/**
 * Confirm a move. Proceed: build the prompt of the current position, queue it
 * (carrying that position, so it runs as that step however far the quest has
 * moved by then), then move the state. Any other move only moves the state.
 * Nothing changes when the move is no longer possible.
 */
export async function confirmProcessAction(
    kind: ProcessMoveKind,
    level: ProcessLevel | undefined,
    customInstructions: string,
    sessionOverride?: string,
): Promise<ProcessActionResult> {
    const store = await ProcessStateStore.ready;
    const move = store.findMove(kind, level);
    const def = store.currentDefinition();
    if (!move || !def) { return { ok: false, error: 'this move is no longer possible at the current position' }; }
    if (move.kind !== 'proceed') {
        const moved = store.move(kind, level, 'user');
        return moved.ok ? { ok: true, queued: false, label: move.label } : moved;
    }
    const here = store.state;
    if (decisionAt(def, here)) {
        return { ok: false, error: 'this is a decision: pick how the process goes on (repeat, go on, gate passed or failed) in the PROCESS view' };
    }
    const session = actionSession(def, here, sessionOverride);
    // A user action is done by the user: confirming it queues nothing.
    const text = userActionAt(def, here) ? '' : buildProcessActionPrompt(store, move, customInstructions, undefined, sessionOverride);
    if (text) {
        if (session.spec) {
            const error = ensureProcessSession(store.activeQuest, session.spec);
            if (error) { return { ok: false, error: `the session "${session.name}" could not be created: ${error}` }; }
        }
        try {
            await PromptQueueManager.instance.enqueue({
                originalText: text,
                ...(session.name ? { agentSdkSession: session.name } : {}),
                processRun: { quest: store.activeQuest, state: here },
            });
        } catch (e) {
            return { ok: false, error: `the prompt could not be queued, the state did not move: ${(e as Error).message}` };
        }
    }
    const moved = store.move(kind, level, 'user');
    if (!moved.ok) {
        return { ok: false, error: text ? `the prompt is in the queue, but the state could not move: ${moved.error}` : moved.error };
    }
    return { ok: true, queued: !!text, label: move.label };
}
