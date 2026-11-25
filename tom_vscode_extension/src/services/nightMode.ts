/**
 * Night mode: the window-wide chat variable `night-mode` (`on` / `off`) the
 * Prompt Queue's headline button sets, for this window or every open window of
 * this machine (the window request `setNightMode`).
 *
 * It is a derived chat variable (ChatVariablesStore.registerDerivedVariables):
 * every process run of the window reads it, the Chat Variables panel shows it,
 * and placeholders and aspect conditions see it as `night-mode` (and
 * `chat.night-mode`). The aspect `night_mode` (*Interaction level*,
 * `_ai/aspect_guidelines/night_mode/`) sends its text while it holds
 * `night-mode == "on"`: the agent works on without asking and records the
 * decisions it takes for the morning.
 *
 * Kept per window in the workspace state, so a reload keeps it.
 */

import * as vscode from 'vscode';

import { ChatVariablesStore } from '../managers/chatVariablesStore';

/** The variable's name, as placeholders and conditions read it. */
export const NIGHT_MODE_VARIABLE = 'night-mode';
const STATE_KEY = 'tomAi.nightMode';

let context: vscode.ExtensionContext | undefined;
const changed = new vscode.EventEmitter<boolean>();

/** Night mode changed in this window (true: on). */
export const onNightModeChange: vscode.Event<boolean> = changed.event;

/** Whether night mode is on in this window. */
export function isNightMode(): boolean {
    return context?.workspaceState.get<string>(STATE_KEY) === 'on';
}

/** Switch night mode in this window. */
export async function setNightMode(on: boolean): Promise<void> {
    if (!context || isNightMode() === on) { return; }
    await context.workspaceState.update(STATE_KEY, on ? 'on' : 'off');
    try { ChatVariablesStore.instance.notifyDerivedChange(NIGHT_MODE_VARIABLE); } catch { /* no store yet */ }
    changed.fire(on);
}

/** Activation: the derived variable `night-mode`, read from the window's state. */
export function initNightMode(ctx: vscode.ExtensionContext): void {
    context = ctx;
    ctx.subscriptions.push(changed);
    try {
        ctx.subscriptions.push(ChatVariablesStore.instance.registerDerivedVariables({
            values: () => ({ [NIGHT_MODE_VARIABLE]: isNightMode() ? 'on' : 'off' }),
        }));
    } catch { /* no chat variables store: the aspect then never applies */ }
}
