/**
 * The run picker of the @CHAT chat subpanels (vscimpb48): each subpanel
 * (ANTHROPIC/LLM, Copilot) works on a process run of the quest of its own,
 * kept per window and quest; the PROCESS view's current run may differ.
 *
 * The run decides what the panel shows and what its sends go to: the
 * session — `<session>@<run>` (src/utils/runSessions.ts) — and, while a send
 * runs, the run's chat variables and process position. A run deleted
 * elsewhere falls back to `default`.
 *
 * Pure (no vscode, no fs).
 */

import { DEFAULT_RUN, normalizeRun } from './processRuns';
import { runSessionName } from './runSessions';

/** The subpanels that pick a run. */
export type ChatRunSection = 'anthropic' | 'copilot';

export const CHAT_RUN_SECTIONS: readonly ChatRunSection[] = ['anthropic', 'copilot'];

/** The workspaceState key of a subpanel's run in a quest. */
export function chatRunKey(quest: string, section: ChatRunSection): string {
    return `tomAi.chatPanel.run.${quest || '(none)'}.${section}`;
}

/** The run a subpanel is on: the one it picked while the quest has it, else `default`. */
export function effectiveChatRun(stored: string | undefined, runs: readonly string[]): string {
    const name = normalizeRun(stored);
    return name !== DEFAULT_RUN && runs.includes(name) ? name : DEFAULT_RUN;
}

/** The session a subpanel's send runs in: its picked session in its run. */
export function chatRunSession(session: string, run: string): string {
    return runSessionName(session, run);
}

/**
 * Whether a send of the subpanel must run as its run: when it differs from
 * the window's run (otherwise the window's run is what everything reads).
 */
export function needsRunContext(panelRun: string, windowRun: string): boolean {
    return normalizeRun(panelRun) !== normalizeRun(windowRun);
}

/** The picker's options: `default` first, then the other runs by name; the window's run marked. */
export function chatRunOptions(runs: readonly string[], windowRun: string): Array<{ run: string; label: string }> {
    const names = [...new Set([DEFAULT_RUN, ...runs.map(normalizeRun)])];
    const ordered = [DEFAULT_RUN, ...names.filter((r) => r !== DEFAULT_RUN).sort((a, b) => a.localeCompare(b))];
    return ordered.map((run) => ({ run, label: `${run}${run === normalizeRun(windowRun) ? ' (PROCESS view)' : ''}` }));
}
