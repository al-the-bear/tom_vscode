/**
 * Who is running in a session right now — so that two prompts never share a
 * conversation.
 *
 * A session is busy while a queue item runs in it (status `sending` on the
 * Anthropic transport) or a chat send runs in it (a `chat` item whose send is
 * still alive: this window's own active send, or one of another live window
 * of the quest — the queue folder is shared). Then:
 *
 * - the prompt queue does not start an item in that session while a chat send
 *   runs there; the item waits (*waiting for session X*) and goes once the
 *   chat send ended;
 * - a chat send into that session is not started; the user chooses (see
 *   {@link busySessionChoices}): run it next in the session (queued directly
 *   under the running item, between its iterations when it repeats), run it
 *   after the current item, or send it now in one of the sessions that are
 *   free.
 *
 * Pure: the queue manager and the chat send paths apply it.
 */

/** What the rules need of a queue item. */
export interface SessionBusyItem {
    id: string;
    status: string;
    originalText?: string;
    session?: string;
}

/** Who holds a session: a running queue item or a chat send. */
export interface SessionHolder {
    kind: 'queue' | 'chat';
    id: string;
    /** The prompt's first line, short. */
    label: string;
}

/** A prompt's first line, at most 60 characters. */
export function promptLabel(text: string | undefined): string {
    const line = String(text ?? '').split('\n').map((l) => l.trim()).find((l) => l.length > 0) ?? '';
    return line.length > 60 ? `${line.slice(0, 59)}…` : line;
}

/**
 * The item holding `session`, or undefined when it is free. `queueSession`
 * answers the session a sending queue item runs in (undefined: not on the
 * Anthropic transport); `chatAlive` whether a `chat` item's send still runs.
 */
export function sessionHolderOf(
    items: readonly SessionBusyItem[],
    session: string,
    opts: {
        queueSession(item: SessionBusyItem): string | undefined;
        chatAlive(item: SessionBusyItem): boolean;
        exceptId?: string;
    },
): SessionHolder | undefined {
    for (const item of items) {
        if (item.id === opts.exceptId) { continue; }
        if (item.status === 'sending' && opts.queueSession(item) === session) {
            return { kind: 'queue', id: item.id, label: promptLabel(item.originalText) };
        }
        if (item.status === 'chat' && (item.session ?? 'chat') === session && opts.chatAlive(item)) {
            return { kind: 'chat', id: item.id, label: promptLabel(item.originalText) };
        }
    }
    return undefined;
}

/** What the user can do with a chat send whose session is busy. */
export interface BusyChoice {
    kind: 'next' | 'after' | 'session';
    /** For `session`: the free session to send in now. */
    session?: string;
    label: string;
    description: string;
}

/**
 * The choices for a chat send into the busy `session`: run it next there (the
 * queue's Send between iterations), run it after the current item, or send it
 * now in each session in `free` (in the order given).
 */
export function busySessionChoices(session: string, holder: SessionHolder, free: readonly string[]): BusyChoice[] {
    const running = holder.kind === 'queue' ? `the queue item "${holder.label}"` : `the chat send "${holder.label}"`;
    return [
        {
            kind: 'next',
            label: `Run next in session ${session}`,
            description: `queued directly under ${running}; between its iterations when it repeats`,
        },
        {
            kind: 'after',
            label: `Run after the current item in session ${session}`,
            description: `queued after ${running}, when it has finished all its iterations`,
        },
        ...free.map((s) => ({ kind: 'session' as const, session: s, label: `Send now in session ${s}`, description: 'free now' })),
    ];
}
