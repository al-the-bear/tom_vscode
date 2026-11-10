/**
 * The closing step of a todo's **Guide me** (the todo detail's speech-bubble
 * button): once the guiding turn ends and the todo is not completed, the
 * question panel offers what to do with it — mark it completed, mark it in
 * progress, queue it for the agent, or leave it. A typed reply is a note added
 * to the todo. Pure: the panel, the todo writes and the queue are the host's.
 */

import { clickedChoiceId, type AskChoice } from './askChoices';

export type GuideMeClosing =
    | { kind: 'complete' }
    | { kind: 'inProgress' }
    | { kind: 'queue' }
    | { kind: 'note'; text: string };

const IDS = { complete: 'complete', inProgress: 'in-progress', queue: 'queue', leave: 'leave' } as const;

/** The panel: the todo, then its choices; `queueTemplate` names the template Queue it uses. */
export function guideMeClosingAsk(todo: { id: string; title?: string; status?: string }, queueTemplate: string): { questions: string[]; title: string; choices: AskChoice[] } {
    const what = todo.title ? `${todo.id} — ${todo.title}` : todo.id;
    const choices: AskChoice[] = [{ id: IDS.complete, label: 'Mark it completed', kind: 'answer' }];
    if (todo.status !== 'in-progress') { choices.push({ id: IDS.inProgress, label: 'Mark it in progress', kind: 'answer' }); }
    choices.push(
        { id: IDS.queue, label: `Queue it (${queueTemplate})`, kind: 'answer' },
        { id: IDS.leave, label: 'Leave it as it is', kind: 'answer' },
    );
    return {
        title: `Guide me: ${todo.id}`,
        questions: [`What now with todo ${what}?\n\nPick one, or type a note to add to the todo.`],
        choices,
    };
}

/** The reply read back: a choice, a typed note, or nothing (left as it is, timed out, refused). */
export function interpretGuideMeReply(reply: string, fallbackPrompt?: string): GuideMeClosing | undefined {
    const text = reply.trim();
    if (!text || text.startsWith('askUser error') || (fallbackPrompt && text === fallbackPrompt.trim())) { return undefined; }
    const id = clickedChoiceId(text);
    if (id === undefined) { return { kind: 'note', text }; }
    if (id === IDS.complete) { return { kind: 'complete' }; }
    if (id === IDS.inProgress) { return { kind: 'inProgress' }; }
    if (id === IDS.queue) { return { kind: 'queue' }; }
    return undefined;
}

/** A typed note appended to the todo's notes, dated. */
export function appendTodoNote(notes: string | undefined, text: string, date: string): string {
    const entry = `${date} (Guide me): ${text.trim()}`;
    return notes && notes.trim() ? `${notes.trimEnd()}\n${entry}` : entry;
}
