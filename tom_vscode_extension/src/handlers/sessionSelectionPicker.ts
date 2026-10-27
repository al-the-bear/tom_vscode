/**
 * The session selection every action on a quest's conversation storage
 * opens: a multi-select of the quest's sessions with "All sessions" on top and
 * the current one preselected; a destructive action then asks to confirm,
 * naming the sessions (src/utils/sessionSelection.ts holds the rules).
 */

import * as vscode from 'vscode';

import { listSessions } from '../services/agentSdkSessionStore';
import { chosenSessions, confirmationText, sessionSelectionItems, type SessionSelectionItem } from '../utils/sessionSelection';
import { sessionRows } from '../utils/sessionsViewRows';
import { sessionsFolder } from './sessionPicker';

export interface PickSessionsOptions {
    /** The quick pick's title, e.g. "Recreate history from the trail". */
    title: string;
    /** Preselected: the panel's (or the caller's) session. */
    current?: string;
    /** Names with storage but no session file, so they can be chosen too. */
    extra?: readonly string[];
    /** Set for a destructive action: its confirmation reads "<destructive> for …?". */
    destructive?: string;
}

/** The chosen session names; undefined when dismissed, nothing chosen, or not confirmed. */
export async function pickSessions(questId: string, opts: PickSessionsOptions): Promise<string[] | undefined> {
    return (await pickSessionsOrAll(questId, opts))?.sessions;
}

/** As {@link pickSessions}, and whether "All sessions" was chosen (for actions that span quests). */
export async function pickSessionsOrAll(questId: string, opts: PickSessionsOptions): Promise<{ sessions: string[]; all: boolean } | undefined> {
    let rows;
    try { rows = sessionRows(listSessions(sessionsFolder(questId))); } catch { rows = sessionRows([]); }
    const items = sessionSelectionItems(rows, opts.current, opts.extra ?? []);
    const chosen = await vscode.window.showQuickPick<SessionSelectionItem & vscode.QuickPickItem>(items, {
        title: opts.title,
        placeHolder: 'Choose one or more sessions, or All sessions',
        canPickMany: true,
        ignoreFocusOut: true,
    });
    if (!chosen || chosen.length === 0) { return undefined; }
    const all = chosen.some((i) => i.all === true);
    const names = chosenSessions(chosen, items);
    if (names.length === 0) { return undefined; }
    if (opts.destructive) {
        const answer = await vscode.window.showWarningMessage(
            confirmationText(opts.destructive, names, items.filter((i) => i.session).length),
            { modal: true },
            opts.destructive,
        );
        if (answer !== opts.destructive) { return undefined; }
    }
    return { sessions: names, all };
}
