/**
 * Process actions — what happens when the user confirms a move of the PROCESS
 * view's action bar: the move's template (processActionPrompt.ts) is resolved
 * by the placeholder engine, the quest's state moves (ProcessStateStore), and
 * the prompt — unless it resolved to nothing — is added to the prompt queue,
 * which sends it.
 *
 * The preview on the action page and the queued text come from the same
 * {@link buildProcessActionPrompt}, so what the page shows is what is queued.
 */

import * as vscode from 'vscode';

import { ProcessStateStore } from '../managers/processStateStore';
import { PromptQueueManager } from '../managers/promptQueueManager';
import { loadSendToChatConfig, saveSendToChatConfig } from '../utils/sendToChatConfig';
import { resolveVariables } from '../utils/variableResolver';
import {
    DEFAULT_PROCESS_ACTION_TEMPLATES,
    processActionTemplate,
    processActionValues,
    type ProcessActionTemplates,
} from '../utils/processActionPrompt';
import type { ProcessLevel, ProcessMove, ProcessMoveKind } from '../utils/processDefinition';

const templatesChanged = new vscode.EventEmitter<void>();
/** Fires after the templates were saved, so an open action page refreshes its preview. */
export const onDidChangeProcessActionTemplates: vscode.Event<void> = templatesChanged.event;

/** The configured templates (kinds not set use their defaults). */
export function configuredProcessActionTemplates(): ProcessActionTemplates {
    return (loadSendToChatConfig()?.processActionTemplates ?? {}) as ProcessActionTemplates;
}

/** Store the templates; a kind whose text equals its default is dropped, so it follows later default changes. */
export function saveProcessActionTemplates(templates: ProcessActionTemplates): boolean {
    const config = loadSendToChatConfig();
    if (!config) { return false; }
    const own: ProcessActionTemplates = {};
    for (const [kind, text] of Object.entries(templates) as Array<[ProcessMoveKind, string]>) {
        if (typeof text === 'string' && text !== DEFAULT_PROCESS_ACTION_TEMPLATES[kind]) { own[kind] = text; }
    }
    config.processActionTemplates = own;
    const saved = saveSendToChatConfig(config);
    if (saved) { templatesChanged.fire(); }
    return saved;
}

/** The prompt a move queues with these custom instructions; `''` when its template resolves to nothing. */
export function buildProcessActionPrompt(
    store: ProcessStateStore,
    move: ProcessMove,
    customInstructions: string,
    templateOverride?: string,
): string {
    const def = store.currentDefinition();
    if (!def) { return ''; }
    const template = templateOverride ?? processActionTemplate(move.kind, configuredProcessActionTemplates());
    if (!template.trim()) { return ''; }
    const values = processActionValues(def, store.state, move, customInstructions, store.processDescription());
    return resolveVariables(template, { values }).trim();
}

export type ProcessActionResult =
    | { ok: true; queued: boolean; label: string }
    | { ok: false; error: string };

/**
 * Confirm a move: build its prompt at the current position, move the state,
 * then queue the prompt. Nothing changes when the move is no longer possible.
 */
export async function confirmProcessAction(
    kind: ProcessMoveKind,
    level: ProcessLevel | undefined,
    customInstructions: string,
): Promise<ProcessActionResult> {
    const store = await ProcessStateStore.ready;
    const move = store.findMove(kind, level);
    if (!move) { return { ok: false, error: 'this move is no longer possible at the current position' }; }
    const text = buildProcessActionPrompt(store, move, customInstructions);
    const moved = store.move(kind, level, 'user');
    if (!moved.ok) { return moved; }
    if (!text) { return { ok: true, queued: false, label: move.label }; }
    try {
        await PromptQueueManager.instance.enqueue({ originalText: text });
    } catch (e) {
        return { ok: false, error: `the state moved, but the prompt could not be queued: ${(e as Error).message}` };
    }
    return { ok: true, queued: true, label: move.label };
}
