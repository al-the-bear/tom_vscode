/**
 * The closing step of a todo's **Guide me** (the todo detail's speech-bubble
 * button): once the guiding turn ends and the todo is not completed, the
 * question panel offers what to do with it — mark it completed, mark it in
 * progress, queue it for the agent, or leave it — selected and sent with Send
 * answers. The user's own words are a note added to the todo, with a choice or
 * alone. Pure: the panel, the todo writes and the queue are the host's.
 */

import { readSingleAnswer, type AskChoice } from './askChoices';

/** What to do with the todo; `note` the user's own words beside a choice (added to its notes too). */
export type GuideMeClosing =
    | { kind: 'complete'; note?: string }
    | { kind: 'inProgress'; note?: string }
    | { kind: 'queue'; note?: string }
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
    // A choice selected (with or without the user's words), a click, or text typed alone.
    const { choiceId, text: own } = readSingleAnswer(text);
    const note = own ? { note: own } : {};
    if (choiceId === undefined) { return own ? { kind: 'note', text: own } : undefined; }
    if (choiceId === IDS.complete) { return { kind: 'complete', ...note }; }
    if (choiceId === IDS.inProgress) { return { kind: 'inProgress', ...note }; }
    if (choiceId === IDS.queue) { return { kind: 'queue', ...note }; }
    // Leave it as it is: with words, they still go into the notes.
    return own ? { kind: 'note', text: own } : undefined;
}

/** A typed note appended to the todo's notes, dated. */
export function appendTodoNote(notes: string | undefined, text: string, date: string): string {
    const entry = `${date} (Guide me): ${text.trim()}`;
    return notes && notes.trim() ? `${notes.trimEnd()}\n${entry}` : entry;
}
