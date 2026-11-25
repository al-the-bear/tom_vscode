/**
 * What the ask paths hand the Q&A journal (utils/qaJournal.ts,
 * services/qaJournal.ts): a question when it is asked
 * ({@link QuestionAskedEntry}) and the exchange when it resolves
 * ({@link QuestionLogEntry}), and the reader of the old questions journal.
 *
 * Old place: `questions.<quest>.md`, the single questions journal every host
 * appended to before the per-host Q&A journal. It is no longer written; the
 * Q&A page still reads an existing one ({@link parseLegacyQuestionsJournal}),
 * its entries of unknown host. The format migration removes it.
 *
 * vscode-free and pure.
 */

import type { QaItem } from './qaJournal';

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

const ENTRY = /^## (\S+) — (.*)$/;

/**
 * The entries of an old `questions.<quest>.md` (old place, read-only), as
 * questions with their answers, of unknown host. An entry is a `## <ISO> —
 * <title>` heading, the `Tool` / `Run` / `Answered` bullets, a numbered
 * `### Questions` list and the quoted `### Answer`.
 */
export function parseLegacyQuestionsJournal(text: string): QaItem[] {
    const items: QaItem[] = [];
    let current: QaItem | undefined;
    let part: 'head' | 'questions' | 'answer' = 'head';
    let answer: string[] = [];
    const finish = (): void => {
        if (current?.reply) { current.reply.text = answer.join('\n').replace(/\n+$/, ''); }
        answer = [];
    };
    text.replace(/\r\n/g, '\n').split('\n').forEach((line, index) => {
        const head = ENTRY.exec(line);
        if (head && Number.isFinite(Date.parse(head[1]))) {
            finish();
            current = {
                id: `legacy-${index + 1}`,
                kind: 'question',
                time: new Date(Date.parse(head[1])).toISOString(),
                host: '',
                legacy: true,
                title: head[2].trim(),
                questions: [],
            };
            items.push(current);
            part = 'head';
            return;
        }
        if (!current) { return; }
        if (line === '### Questions') { part = 'questions'; return; }
        if (line === '### Answer') {
            part = 'answer';
            current.reply = current.reply ?? { id: `${current.id}-a`, time: current.time, host: '', text: '' };
            return;
        }
        if (part === 'head') {
            const tool = /^- \*\*Tool:\*\* `([^`]*)`/.exec(line);
            if (tool) { current.tool = tool[1]; return; }
            const run = /^- \*\*Run:\*\* (.+)$/.exec(line);
            if (run) { current.run = run[1].trim(); return; }
            const answered = /^- \*\*Answered:\*\* (\S+) via ([^,]+)/.exec(line);
            if (answered) {
                const t = Date.parse(answered[1]);
                current.reply = { id: `${current.id}-a`, time: Number.isFinite(t) ? new Date(t).toISOString() : current.time, host: '', text: '', source: answered[2].trim() };
            }
            return;
        }
        if (part === 'questions') {
            const q = /^\d+\. (.*)$/.exec(line);
            if (q) { current.questions!.push(q[1]); }
            else if (line.trim() && current.questions!.length) { current.questions![current.questions!.length - 1] += `\n${line}`; }
            return;
        }
        if (line.startsWith('>')) { answer.push(line === '>' ? '' : line.replace(/^> ?/, '')); }
    });
    finish();
    for (const item of items) {
        if (item.reply && item.reply.text === '_(no answer text)_') { item.reply.text = ''; }
    }
    return items;
}
