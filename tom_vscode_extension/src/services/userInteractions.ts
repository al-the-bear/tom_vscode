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
}

/** An interaction as the webview gets it (no callback). */
export type InteractionView = Omit<OpenInteraction, 'respond'>;

export class UserInteractions {
    private readonly open = new Map<string, OpenInteraction>();
    private readonly listeners = new Set<(added?: OpenInteraction) => void>();

    /** Open an interaction; answers the function that removes it (idempotent). */
    add(interaction: OpenInteraction): () => void {
        this.open.set(interaction.id, interaction);
        this.changed(interaction);
        return () => this.remove(interaction.id);
    }

    /** Remove interaction `id` (it was settled). */
    remove(id: string): void {
        if (this.open.delete(id)) { this.changed(); }
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

    /** Be told when one opens (`added`) or one is removed; answers the unsubscribe. */
    onChange(listener: (added?: OpenInteraction) => void): () => void {
        this.listeners.add(listener);
        return () => { this.listeners.delete(listener); };
    }

    private changed(added?: OpenInteraction): void {
        for (const l of [...this.listeners]) {
            try { l(added); } catch { /* a listener must not break the interaction */ }
        }
    }
}

/** The window's open interactions. */
export const userInteractions = new UserInteractions();
