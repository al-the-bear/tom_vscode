/**
 * What the todo panel keeps between its sends and queue adds (vscimpb139): the
 * last queue target and the last direct-send target of each panel instance —
 * the "Last: …" entry of the queue-target flow (utils/todoQueueTarget.ts) — and
 * the Done notification toggle of each quest. The panel no longer picks a run
 * and a session of its own: every queue button asks quest → run → free session
 * → next / end, a direct send a free session.
 *
 * Pure (no vscode, no fs).
 */

import type { TodoQueuePosition, TodoQueueTarget, TodoSendTarget } from './todoQueueTarget';

/** The workspaceState key of the panel's Done notification toggle in a quest (unset: on). */
export function todoPanelDoneNotificationKey(quest: string): string {
    return `tomAi.todoPanel.doneNotification.${quest || '(none)'}`;
}

/** The toggle as stored: unset reads as on (BP-3). */
export function todoPanelDoneNotificationOn(stored: unknown): boolean {
    return stored !== false;
}

/** The workspaceState key of a panel instance's last queue target. */
export function todoPanelLastQueueTargetKey(instance: string): string {
    return `tomAi.todoPanel.lastQueueTarget.${instance || 'panel'}`;
}

/** The workspaceState key of a panel instance's last direct-send target. */
export function todoPanelLastSendTargetKey(instance: string): string {
    return `tomAi.todoPanel.lastSendTarget.${instance || 'panel'}`;
}

/** A stored last queue target, checked: undefined for anything that is not one. */
export function storedQueueTarget(raw: unknown): TodoQueueTarget | undefined {
    if (!raw || typeof raw !== 'object') { return undefined; }
    const r = raw as Record<string, unknown>;
    if (typeof r.quest !== 'string' || !r.quest || typeof r.run !== 'string' || !r.run) { return undefined; }
    const position: TodoQueuePosition = r.position === 'next' ? 'next' : 'end';
    return {
        quest: r.quest,
        run: r.run,
        ...(typeof r.session === 'string' && r.session ? { session: r.session } : {}),
        ...(r.newSession === true ? { newSession: true } : {}),
        position,
    };
}

/** A stored last direct-send target, checked. */
export function storedSendTarget(raw: unknown): TodoSendTarget | undefined {
    if (!raw || typeof raw !== 'object') { return undefined; }
    const r = raw as Record<string, unknown>;
    return typeof r.run === 'string' && r.run && typeof r.session === 'string' && r.session ? { run: r.run, session: r.session } : undefined;
}
