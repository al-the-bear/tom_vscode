/**
 * The todo panel's session and run (vscimpb60d): the quest todo views (the
 * @TOM sidebar's QUEST TODOS and @WS › Quest TODO) pick a session and a
 * process run of their own — kept per window and quest, one selection for the
 * top bar and the detail panel and for both views, independent of the @CHAT
 * panel's. Every todo the panel sends or queues uses them: a Send runs in the
 * session, with the run's chat variables and process position; a queued item
 * names the session and belongs to the run. In a run other than `default` the
 * session is the run's own, `<session>@<run>` (utils/runSessions.ts). A run
 * deleted elsewhere falls back to `default`. No run is created here.
 *
 * Pure (no vscode, no fs).
 */

import { DEFAULT_RUN } from './processRuns';
import { chatRunOptions, effectiveChatRun } from './chatPanelRuns';
import { runSessionName } from './runSessions';

/** The session the panel uses until another is picked: the chat panel's own session name. */
export const TODO_PANEL_DEFAULT_SESSION = 'chat';

/** The workspaceState key of the panel's session in a quest. */
export function todoPanelSessionKey(quest: string): string {
    return `tomAi.todoPanel.session.${quest || '(none)'}`;
}

/** The workspaceState key of the panel's run in a quest. */
export function todoPanelRunKey(quest: string): string {
    return `tomAi.todoPanel.run.${quest || '(none)'}`;
}

/** What the panel is on: the session picked (as named), the run, and the session its sends run in. */
export interface TodoPanelSelection {
    /** The session as picked (no run suffix). */
    session: string;
    /** The run: the one picked while the quest has it, else `default`. */
    run: string;
    /** The session the sends use: `<session>@<run>` in a run other than `default`. */
    effectiveSession: string;
    /** Whether a stored run is gone (it is to be forgotten). */
    runFellBack: boolean;
}

/** The selection from what is stored and the quest's runs. */
export function todoPanelSelection(storedSession: string | undefined, storedRun: string | undefined, runs: readonly string[]): TodoPanelSelection {
    const session = (storedSession ?? '').trim() || TODO_PANEL_DEFAULT_SESSION;
    const run = effectiveChatRun(storedRun, runs);
    return {
        session,
        run,
        effectiveSession: runSessionName(session, run),
        runFellBack: !!storedRun && storedRun.trim() !== '' && storedRun.trim() !== run,
    };
}

/** The message the views get: the selection and the run select's options (`default` first, the window's run marked). */
export function todoPanelRunSessionMessage(sel: TodoPanelSelection, runs: readonly string[], windowRun: string): {
    type: 'qtRunSession';
    session: string;
    effectiveSession: string;
    run: string;
    windowRun: string;
    runs: Array<{ run: string; label: string }>;
} {
    return {
        type: 'qtRunSession',
        session: sel.session,
        effectiveSession: sel.effectiveSession,
        run: sel.run,
        windowRun: windowRun || DEFAULT_RUN,
        runs: chatRunOptions(runs, windowRun),
    };
}
