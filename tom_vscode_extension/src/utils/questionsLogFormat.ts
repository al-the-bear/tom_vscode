/**
 * What the ask paths hand the Q&A journal (utils/qaJournal.ts,
 * services/qaJournal.ts): a question when it is asked
 * ({@link QuestionAskedEntry}) and the exchange when it resolves
 * ({@link QuestionLogEntry}).
 *
 * vscode-free and pure.
 */

/** A question as it is put to the user (written when it is asked). */
export interface QuestionAskedEntry {
    /** Tool that asks — `tomAi_askUser`, `tomAi_askUserPicker`, `tomAi_askInMdBrowser`, … */
    readonly tool: string;
    /** The ask's own id; the answer names the same id. */
    readonly requestId: string;
    readonly title?: string;
    /** The questions put to the user, in order. May be empty for the picker. */
    readonly questions: readonly string[];
    /** The choices offered (button / item labels). */
    readonly choices?: readonly string[];
    /** Epoch ms the ask opened. */
    readonly askedAt: number;
    readonly run?: string;
    readonly session?: string;
    readonly queueItemId?: string;
}

/** One resolved ask, as the Q&A journal records it. */
export interface QuestionLogEntry {
    /** Tool that asked — `tomAi_askUser`, `tomAi_askUserPicker`, or the intercepted Agent SDK `AskUserQuestion`. */
    readonly tool: string;
    /** Context line shown above the questions. */
    readonly title?: string;
    /** The questions put to the user, in order. May be empty for the picker. */
    readonly questions: readonly string[];
    /** The choices offered (button / item labels). */
    readonly choices?: readonly string[];
    /** What came back, verbatim — including a timeout's fallback prompt. */
    readonly answer: string;
    /** What resolved the ask: `vscode`, `telegram`, `timeout`, `cancel`, … */
    readonly source: string;
    /** Epoch ms the ask opened. */
    readonly askedAt: number;
    /** Epoch ms it resolved. */
    readonly answeredAt: number;
    /** The process run the asking turn worked in (vscimpb81); `default` when absent. */
    readonly run?: string;
    /** The id of the {@link QuestionAskedEntry} written when it was asked, when one was. */
    readonly requestId?: string;
    readonly session?: string;
    readonly queueItemId?: string;
}
