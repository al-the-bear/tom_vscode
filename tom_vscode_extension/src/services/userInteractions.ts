/**
 * Every interaction that waits for the user, in one place (vscimpb81): a
 * question (tomAi_askUser, the Agent SDK's AskUserQuestion with choices), a
 * tool approval, a plan proposal (tomAi_exitPlanMode), a picker that could not
 * be a QuickPick because another run's picker was showing, and an ask in the
 * MD Browser (tomAi_askInMdBrowser, shown in its own panel; listed here so the
 * user finds it).
 *
 * Each interaction names the process run its turn works in
 * (`currentInteractionRun`): the user-input panel shows one tab per run with
 * open interactions, and the user answers them in any order. The source that
 * opened an interaction answers it through `respond` and removes it when it is
 * settled, by whichever channel.
 *
 * vscode-free.
 */

/** What kind of interaction waits. */
export type InteractionKind = 'question' | 'approval' | 'plan' | 'picker' | 'mdBrowser';

/** One interaction waiting for the user. */
export interface OpenInteraction {
    /** Unique while open (the question's request id, the approval's tool-use id, …). */
    id: string;
    kind: InteractionKind;
    /** The process run its turn works in (`default` outside any run). */
    run: string;
    /** The queue item (or chat item) whose turn waits, when one does. */
    queueItemId?: string;
    /** The session the turn runs in, when known. */
    session?: string;
    /** Epoch ms it opened. */
    createdAt: number;
    /** One line naming it in the panel. */
    title: string;
    /** What the panel renders (kind-specific, JSON-serialisable). */
    data: Record<string, unknown>;
    /** Answer it from the panel (kind-specific response); not posted to the webview. */
    respond?: (response: Record<string, unknown>) => void;
    /**
     * A stand-in for an ask of another window (USER NOTIFICATIONS › Answer): the window and the ask's id
     * there. Its answer is sent to that window (services/windowRequests.ts); it is not this window's ask.
     */
    proxyOf?: { windowId: string; id: string };
}

/** An interaction that was settled, and how (the answer, the choice, or why it closed), when its source said. */
export interface ClosedInteraction {
    interaction: OpenInteraction;
    outcome?: string;
}

/** An interaction as the webview gets it (no callback). */
export type InteractionView = Omit<OpenInteraction, 'respond'>;

/** The window's own interactions (not stand-ins for another window's asks). */
export function ownInteractions(list: readonly OpenInteraction[]): OpenInteraction[] {
    return list.filter((i) => !i.proxyOf);
}

export class UserInteractions {
    private readonly open = new Map<string, OpenInteraction>();
    private readonly listeners = new Set<(added?: OpenInteraction, closed?: ClosedInteraction) => void>();

    /** Open an interaction; answers the function that removes it, with how it was settled (idempotent). */
    add(interaction: OpenInteraction): (outcome?: string) => void {
        this.open.set(interaction.id, interaction);
        this.changed(interaction);
        return (outcome?: string) => this.remove(interaction.id, outcome);
    }

    /** Remove interaction `id` (it was settled; `outcome`: the answer, the choice, or why it closed). */
    remove(id: string, outcome?: string): void {
        const interaction = this.open.get(id);
        if (interaction && this.open.delete(id)) { this.changed(undefined, { interaction, ...(outcome ? { outcome } : {}) }); }
    }

    /** Interaction `id`, while open. */
    get(id: string): OpenInteraction | undefined {
        return this.open.get(id);
    }

    /** Every open interaction, oldest first. */
    list(): OpenInteraction[] {
        return [...this.open.values()].sort((a, b) => a.createdAt - b.createdAt);
    }

    /** The open interactions of queue item `queueItemId`. */
    forQueueItem(queueItemId: string): OpenInteraction[] {
        return this.list().filter((i) => i.queueItemId === queueItemId);
    }

    /** The runs with open interactions, `default` first, then by name, each with its count. */
    runs(): Array<{ run: string; count: number }> {
        const counts = new Map<string, number>();
        for (const i of this.open.values()) { counts.set(i.run, (counts.get(i.run) ?? 0) + 1); }
        return [...counts.entries()]
            .sort(([a], [b]) => (a === 'default' ? -1 : b === 'default' ? 1 : a < b ? -1 : a > b ? 1 : 0))
            .map(([run, count]) => ({ run, count }));
    }

    /** What the webview renders. */
    views(): InteractionView[] {
        return this.list().map(({ respond: _respond, ...view }) => view);
    }

    /** Be told when one opens (`added`) or one is removed (`closed`); answers the unsubscribe. */
    onChange(listener: (added?: OpenInteraction, closed?: ClosedInteraction) => void): () => void {
        this.listeners.add(listener);
        return () => { this.listeners.delete(listener); };
    }

    private changed(added?: OpenInteraction, closed?: ClosedInteraction): void {
        for (const l of [...this.listeners]) {
            try { l(added, closed); } catch { /* a listener must not break the interaction */ }
        }
    }
}

/** The window's open interactions. */
export const userInteractions = new UserInteractions();
