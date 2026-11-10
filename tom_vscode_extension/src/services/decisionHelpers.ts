/**
 * Grill me / Explain a decision at a process decision: the Decide… dialog of
 * the PROCESS view offers them beside the decision's options. A helper runs
 * its Assist prompt (Grill me at a decision, Explain a decision) in the
 * ANTHROPIC panel, in a temporary session based on the process's session, and
 * writes its advice to a note in the quest's process folder
 * (`_ai/quests/<quest>/process/`), shown with tomAi_askInMdBrowser and the
 * button **Back to the decision** (`reopenDecision`). The decision stays the
 * user's: the button reopens it; when the turn ends without that click (a
 * short answer through the question panel, a failed or cancelled run) it
 * reopens by itself, while the process is still at the decision.
 *
 * vscode-free: the dialog, the store, the sessions and the send come in as
 * {@link DecisionHelperDeps}.
 */

import * as path from 'path';
import { buildAssistPrompt, type AssistPromptsSection } from '../utils/assistPrompts';
import { createTemporarySession } from './temporarySessions';

export type DecisionHelperUse = 'grillMeDecision' | 'explainDecision';

/** The dialog's two extra buttons, after the decision's options. */
export const DECISION_HELPER_LABELS: Record<DecisionHelperUse, string> = {
    grillMeDecision: 'Grill me',
    explainDecision: 'Explain a decision',
};

/** The buttons of the Decide… dialog: the options, then the helpers. */
export function decisionDialogButtons(optionLabels: string[]): string[] {
    return [...optionLabels, DECISION_HELPER_LABELS.grillMeDecision, DECISION_HELPER_LABELS.explainDecision];
}

export type DecisionPick<T> = { kind: 'option'; option: T } | { kind: 'helper'; use: DecisionHelperUse } | { kind: 'none' };

/** What the button picked means: an option (made), a helper (run), or nothing (dismissed). */
export function interpretDecisionPick<T extends { label: string }>(picked: string | undefined, options: T[]): DecisionPick<T> {
    if (picked === undefined) { return { kind: 'none' }; }
    const option = options.find((o) => o.label === picked);
    if (option) { return { kind: 'option', option }; }
    const use = (Object.keys(DECISION_HELPER_LABELS) as DecisionHelperUse[]).find((u) => DECISION_HELPER_LABELS[u] === picked);
    return use ? { kind: 'helper', use } : { kind: 'none' };
}

/** The decision a helper is about. */
export interface DecisionContext {
    quest: string;
    process: string;
    position: string;
    /** The decision's text: what is decided and its choices. */
    decision: string;
}

export interface DecisionHelperDeps {
    workspaceRoot: string;
    /** The decision the process is at; undefined when it is at none. */
    context(): DecisionContext | undefined;
    /** The quest's folder, absolute. */
    questFolder(quest: string): string;
    ensureDir(absPath: string): void;
    assistPrompts(): AssistPromptsSection | undefined;
    baseSession(): string;
    sessionsFolder(): string;
    hasSession(folder: string, name: string): boolean;
    createSession(folder: string, name: string, opts: { basedOn?: string }): { ok: boolean; error?: string };
    deleteSession(folder: string, name: string): void;
    send(prompt: string, session: string, source: string): Promise<{ ok: boolean; error?: string; rejected?: boolean }>;
    /** Open the Decide… dialog again. */
    reopenDecision(): Promise<void>;
    /** Whether the process is still at a decision. */
    isAtDecision(): boolean;
    now?(): Date;
}

export type DecisionHelperOutcome =
    | { ok: true; session: string; noteFile: string; reopened: 'button' | 'turn-end' | 'decided' }
    | { ok: false; error: string; reopened: boolean };

/** `decision-<yymmdd-hhmmss>-<grill-me|explain>.md` in the quest's process folder. */
export function decisionNoteName(use: DecisionHelperUse, now: Date): string {
    const p = (n: number) => String(n).padStart(2, '0');
    const stamp = `${String(now.getFullYear()).slice(2)}${p(now.getMonth() + 1)}${p(now.getDate())}-${p(now.getHours())}${p(now.getMinutes())}${p(now.getSeconds())}`;
    return `decision-${stamp}-${use === 'grillMeDecision' ? 'grill-me' : 'explain'}.md`;
}

/** The helper run in progress: the button that reopens the decision marks it, so the turn's end does not reopen it again. */
let currentRun: { reopened: boolean } | undefined;

/** The decision was reopened from the note's button (tomAi_askInMdBrowser `reopenDecision`). */
export function markDecisionReopened(): void {
    if (currentRun) { currentRun.reopened = true; }
}

/** Whether a helper is running (a second one is refused). */
export function decisionHelperRunning(): boolean {
    return currentRun !== undefined;
}

/**
 * Run a helper: the note's path is chosen in the quest's process folder, the
 * Assist prompt filled, a temporary session made (based on the process's
 * session when it exists) and the turn sent to the panel. Afterwards the
 * session goes, and the decision reopens unless the note's button reopened it
 * already or the process is no longer at the decision.
 */
export async function runDecisionHelper(deps: DecisionHelperDeps, use: DecisionHelperUse): Promise<DecisionHelperOutcome> {
    const ctx = deps.context();
    if (!ctx) { return { ok: false, error: 'the process is not at a decision', reopened: false }; }
    if (currentRun) { return { ok: false, error: 'a decision helper is already running', reopened: false }; }
    const now = deps.now?.() ?? new Date();
    const folder = path.join(deps.questFolder(ctx.quest), 'process');
    const noteAbs = path.join(folder, decisionNoteName(use, now));
    const noteFile = path.relative(deps.workspaceRoot, noteAbs).split(path.sep).join('/');
    const prompt = buildAssistPrompt(deps.assistPrompts(), use, { process: ctx.process, position: ctx.position, decision: ctx.decision, noteFile });

    const sessions = deps.sessionsFolder();
    const token = use === 'grillMeDecision' ? 'grill-me-decision' : 'explain-decision';
    let session = '';
    const run = { reopened: false };
    currentRun = run;
    let result: { ok: boolean; error?: string; rejected?: boolean } = { ok: false, error: 'not sent' };
    try {
        deps.ensureDir(folder);
        const made = createTemporarySession(deps, deps.baseSession(), token, now);
        if (!made.ok) { result = { ok: false, error: made.error }; }
        else {
            session = made.session;
            try {
                result = await deps.send(prompt, session, `${DECISION_HELPER_LABELS[use]} (decision at ${ctx.position})`);
            } finally {
                try { deps.deleteSession(sessions, session); } catch { /* gone already */ }
            }
        }
    } finally {
        currentRun = undefined;
    }
    // The decision is the user's: back to it, unless the note's button did that already.
    let reopened: 'button' | 'turn-end' | 'decided' = 'button';
    if (!run.reopened) {
        if (deps.isAtDecision()) { await deps.reopenDecision(); reopened = 'turn-end'; } else { reopened = 'decided'; }
    }
    if (!result.ok) {
        const error = result.rejected ? 'the ANTHROPIC panel is busy with another request — try again when it is done' : (result.error ?? 'the send failed');
        return { ok: false, error, reopened: reopened === 'turn-end' };
    }
    return { ok: true, session, noteFile, reopened };
}

/** The decision's text for the prompt: the dialog's message and its choices. */
export function decisionText(message: string, options: Array<{ label: string }>): string {
    return `${message}. The choices: ${options.map((o) => `"${o.label}"`).join('; ')}.`;
}
