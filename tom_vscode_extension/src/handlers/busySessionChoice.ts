/**
 * Before a chat send starts: is its session busy (src/utils/sessionBusy.ts)?
 *
 * Free: the send goes. Busy — a queue item or another chat send runs in it —
 * the user chooses (VS Code's quick pick): **Send now as an update to the
 * running prompt** when that prompt is an Agent SDK query (another user message
 * into the running conversation, services/agentSdkLiveInputs.ts; shown in the
 * queue as a chat send that ends with the update's own answer), **Run next in session X** (queued
 * directly under the running item, between its iterations when it repeats),
 * **Run after the current item** (queued after it, once all its iterations
 * are done), or **Send now in session Y** for every session that is free.
 * Without a person to ask (Telegram) the send is refused, naming who runs in
 * the session. Both chat send paths ask this: the panel's Send and
 * runAnthropicSend.
 */

import * as vscode from 'vscode';
import { PromptQueueManager } from '../managers/promptQueueManager';
import { busySessionChoices, type BusyChoice, type SessionHolder } from '../utils/sessionBusy';
import { listSessions } from '../services/agentSdkSessionStore';
import { sessionsFolder } from './sessionPicker';
import { WsPaths } from '../utils/workspacePaths';
import { canUpdateRunningPrompt, sendUpdateToRunningPrompt } from '../services/agentSdkLiveInputs';
import { trackChatSend } from './chatQueueTracking';

export type BusySessionOutcome =
    | { kind: 'free' }
    | { kind: 'send'; session: string }
    | { kind: 'update'; session: string }
    | { kind: 'queued'; how: 'next' | 'after'; session: string }
    | { kind: 'cancelled'; message: string };

/** What a queued send carries over from the chat send. */
export interface ChatSendForQueue {
    text: string;
    profileId?: string;
    configId?: string;
    /** The user-message template id. */
    template?: string;
}

/** The sessions a send could go to instead: the queue's and the panel's own, then the quest's named ones. */
export function candidateSessions(questId: string, except: string): string[] {
    let named: string[] = [];
    try { named = listSessions(sessionsFolder(questId)).map((r) => r.name); } catch { /* no sessions folder */ }
    return ['chat', 'default', ...named].filter((s, i, all) => s !== except && all.indexOf(s) === i);
}

function holderText(session: string, holder: SessionHolder): string {
    return `${holder.kind === 'queue' ? 'the queue item' : 'the chat send'} "${holder.label}" runs in session ${session}`;
}

/** The pick: undefined when the user dismissed it. A test may stand in. */
let pick: (choices: BusyChoice[], title: string) => Promise<BusyChoice | undefined> = async (choices, title) => {
    const items = choices.map((c) => ({ label: c.label, description: c.description, choice: c }));
    const picked = await vscode.window.showQuickPick(items, { title, placeHolder: 'Two prompts never share a conversation: queue it, or send it in a free session', ignoreFocusOut: true });
    return picked?.choice;
};

/** Test seam: how the user's choice is taken. */
export function __setBusySessionPickForTests(fn: typeof pick): void { // eslint-disable-line @typescript-eslint/naming-convention -- a test seam
    pick = fn;
}

/**
 * Settle where a chat send into `session` goes. Queued choices are enqueued
 * here (the Anthropic transport, the send's profile, the session); `send`
 * names the free session to send in now.
 */
export async function resolveBusySession(params: {
    session: string;
    send: ChatSendForQueue;
    /** Whether a person can be asked (not on Telegram). */
    interactive: boolean;
    questId?: string;
    /** Whether a send could start now in another session; false while this caller's one send slot is taken. Default true. */
    canSendElsewhere?: boolean;
}): Promise<BusySessionOutcome> {
    let queue: PromptQueueManager;
    try { queue = PromptQueueManager.instance; } catch { return { kind: 'free' }; }
    const holder = queue.sessionHolder(params.session);
    if (!holder) { return { kind: 'free' }; }
    if (!params.interactive) {
        return { kind: 'cancelled', message: `Not sent: ${holderText(params.session, holder)}. Two prompts never share a conversation; send it again when it has ended, or queue it.` };
    }
    const free = params.canSendElsewhere === false ? [] : queue.freeSessions(candidateSessions(params.questId ?? WsPaths.getWorkspaceQuestId(), params.session));
    const choice = await pick(busySessionChoices(params.session, holder, free, canUpdateRunningPrompt(params.session)), `Session ${params.session} is busy: ${holderText(params.session, holder)}`);
    if (!choice) { return { kind: 'cancelled', message: `Not sent: session ${params.session} is busy.` }; }
    if (choice.kind === 'session') { return { kind: 'send', session: choice.session! }; }
    if (choice.kind === 'update') { return sendAsUpdate(params.session, params.send); }
    const opts = {
        originalText: params.send.text,
        transport: 'anthropic' as const,
        session: params.session,
        ...(params.send.profileId ? { anthropicProfileId: params.send.profileId } : {}),
        ...(params.send.configId ? { anthropicConfigId: params.send.configId } : {}),
        ...(params.send.template ? { template: params.send.template } : {}),
    };
    if (choice.kind === 'next') { await queue.enqueueNext(opts); } else { await queue.enqueueAfterCurrent(opts); }
    return { kind: 'queued', how: choice.kind, session: params.session };
}

/**
 * Send `send` into the prompt running in `session` as an update. Shown in the
 * queue as a chat send (source `update`) that ends with the update's own
 * answer, or with why it got none (the running prompt ended first).
 */
function sendAsUpdate(session: string, send: ChatSendForQueue): BusySessionOutcome {
    const pushed = sendUpdateToRunningPrompt(session, send.text);
    if (!pushed) {
        return { kind: 'cancelled', message: `Not sent: the prompt in session ${session} has just ended. Send it again.` };
    }
    void trackChatSend(
        { text: send.text, ...(send.profileId ? { profileId: send.profileId } : {}), session, source: 'update' },
        () => pushed.answer.then((text) => ({ text })),
    ).catch(() => undefined);
    return { kind: 'update', session };
}
