/**
 * Another window's ask, answered in this one (USER NOTIFICATIONS › Answer):
 * a stand-in interaction (`proxyOf`) in this window's user-input panel, made
 * from the ask that window publishes (services/windowRequests.ts). The panel
 * renders it as any ask; its answer goes to the owning window as an
 * `answerAsk` request, which answers the real ask there (and reports it to
 * the notification log as answered). The stand-in leaves when it is answered
 * here or the ask is no longer open there.
 *
 * vscode-free.
 */

import { readWindowInteractions, sendWindowRequest } from './windowRequests';
import type { OpenInteraction, UserInteractions } from './userInteractions';

/** The stand-in's id here. */
export function remoteAskId(windowId: string, id: string): string {
    return `remote:${windowId}:${id}`;
}

/** Why an ask of another window cannot be answered here, or undefined when it can. */
export type RemoteAskResult = { ok: true; id: string; run: string } | { ok: false; reason: string };

/**
 * Show ask `id` of window `windowId` in this window's panel: a stand-in on a
 * tab named after that window (`label`, e.g. its quest) and the ask's run.
 * An MD Browser ask is answered in its own window's panel (its document is
 * open there).
 */
export function openRemoteAsk(interactions: UserInteractions, windowId: string, id: string, label: string, now = Date.now()): RemoteAskResult {
    const localId = remoteAskId(windowId, id);
    const existing = interactions.get(localId);
    if (existing) { return { ok: true, id: localId, run: existing.run }; }
    const view = readWindowInteractions(windowId).find((v) => v.id === id);
    if (!view) { return { ok: false, reason: `the ask is no longer open in ${label}` }; }
    if (view.kind === 'mdBrowser') { return { ok: false, reason: `it is an MD Browser ask: its document is open in ${label}, answer it there` }; }
    const run = `${label} · ${view.run}`;
    let remove: (outcome?: string) => void = () => undefined;
    const proxy: OpenInteraction = {
        id: localId,
        kind: view.kind,
        run,
        createdAt: now,
        title: `${view.title} (${label})`,
        data: view.data ?? {},
        ...(view.queueItemId ? { queueItemId: view.queueItemId } : {}),
        ...(view.session ? { session: view.session } : {}),
        proxyOf: { windowId, id },
        respond: (response) => {
            // The real ask's id: the panel posts the stand-in's.
            const sent = sendWindowRequest(windowId, { type: 'answerAsk', id, response: { ...response, requestId: id, id } });
            remove(sent ? 'answered here, sent to its window' : 'could not be sent to its window');
        },
    };
    remove = interactions.add(proxy);
    return { ok: true, id: localId, run };
}

/** Remove the stand-ins whose ask is no longer open in its window. Answers how many left. */
export function syncRemoteAsks(interactions: UserInteractions): number {
    let removed = 0;
    const byWindow = new Map<string, Set<string>>();
    for (const i of interactions.list()) {
        if (!i.proxyOf) { continue; }
        let open = byWindow.get(i.proxyOf.windowId);
        if (!open) { open = new Set(readWindowInteractions(i.proxyOf.windowId).map((v) => v.id)); byWindow.set(i.proxyOf.windowId, open); }
        if (!open.has(i.proxyOf.id)) { interactions.remove(i.id, 'settled in its window'); removed++; }
    }
    return removed;
}
