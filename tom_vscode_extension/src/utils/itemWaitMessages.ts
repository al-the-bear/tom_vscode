/**
 * The messages the user wrote to a queue item's turn from the item itself:
 * into its tomAi_waitFor wait or its background-work wait (vscimpb173), or —
 * the speech bubble of its header — into its running Agent SDK prompt as
 * another user message of the conversation (`running`). Kept on the item (`wait-messages` in the queue file) so the editor
 * shows each under the wait's panel with what became of it: the agent's
 * answer where the transport knows it, and that the wait went on.
 *
 * Pure: imports neither `vscode` nor the queue.
 */

/** The most messages kept per item (the oldest go first). */
export const MAX_ITEM_WAIT_MESSAGES = 20;
/** An answer is kept up to this many characters. */
export const MAX_WAIT_MESSAGE_ANSWER = 4000;

/** One message written to a waiting turn. */
export interface ItemWaitMessage {
    /** ISO time it was sent. */
    at: string;
    /** Where it went: the tomAi_waitFor wait, the background-work wait, or the running prompt. */
    into: 'waitFor' | 'background' | 'running';
    text: string;
    /** The agent's answer, when known. */
    answer?: string;
    /** The wait went on after it. */
    resumed?: boolean;
}

/** `messages` with `message` added, cut to the last {@link MAX_ITEM_WAIT_MESSAGES}. */
export function withWaitMessage(messages: readonly ItemWaitMessage[] | undefined, message: ItemWaitMessage): ItemWaitMessage[] {
    return [...(messages ?? []), message].slice(-MAX_ITEM_WAIT_MESSAGES);
}

/** An answer as it is kept. */
export function keptAnswer(text: string): string {
    const t = text.trim();
    return t.length > MAX_WAIT_MESSAGE_ANSWER ? `${t.slice(0, MAX_WAIT_MESSAGE_ANSWER)} …` : t;
}

/** The newest message into `into` that has not been marked resumed yet. */
export function lastOpenWaitMessage(messages: readonly ItemWaitMessage[] | undefined, into: ItemWaitMessage['into']): ItemWaitMessage | undefined {
    const last = (messages ?? []).filter((m) => m.into === into).pop();
    return last && !last.resumed ? last : undefined;
}

/** The messages as the queue file keeps them. */
export function waitMessagesToYaml(messages: readonly ItemWaitMessage[]): Array<Record<string, unknown>> {
    return messages.map((m) => ({
        at: m.at,
        into: m.into,
        text: m.text,
        ...(m.answer !== undefined ? { answer: m.answer } : {}),
        ...(m.resumed ? { resumed: true } : {}),
    }));
}

/** The messages read back from the queue file; undefined when there are none. */
export function waitMessagesFromYaml(raw: unknown): ItemWaitMessage[] | undefined {
    if (!Array.isArray(raw)) { return undefined; }
    const out: ItemWaitMessage[] = [];
    for (const r of raw as Array<Record<string, unknown>>) {
        if (typeof r?.at !== 'string' || typeof r.text !== 'string') { continue; }
        out.push({
            at: r.at,
            into: r.into === 'background' ? 'background' : r.into === 'running' ? 'running' : 'waitFor',
            text: r.text,
            ...(typeof r.answer === 'string' ? { answer: r.answer } : {}),
            ...(r.resumed === true ? { resumed: true as const } : {}),
        });
    }
    return out.length ? out : undefined;
}

/** A message as the editor shows it. */
export interface ItemWaitMessageView {
    at: string;
    into: ItemWaitMessage['into'];
    text: string;
    answer?: string;
    /** `the wait goes on` / `the agent is answering` … */
    state: string;
}

/** What the editor shows of an item's messages. */
export function waitMessageViews(messages: readonly ItemWaitMessage[] | undefined): ItemWaitMessageView[] {
    return (messages ?? []).map((m) => ({
        at: m.at,
        into: m.into,
        text: m.text,
        ...(m.answer !== undefined ? { answer: m.answer } : {}),
        state: m.resumed ? 'the wait goes on' : m.answer !== undefined ? 'answered' : 'the agent has it',
    }));
}

/** Why a message cannot go to an item, or undefined when its text can be sent. */
export function waitMessageProblem(text: unknown): string | undefined {
    return typeof text === 'string' && text.trim() !== '' ? undefined : 'The message is empty.';
}
