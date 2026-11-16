/**
 * The status label of a queue item in the queue editor (vscimpb128): its
 * status and its kind (vscimpb127, utils/queueItemKind.ts) in one label —
 * PENDING TODO, SENDING GROUP, STAGED PROMPT, SENT CHAT, ERROR PREFIX, … A
 * chat send reads SENDING CHAT while it runs and SENT CHAT once it ended.
 *
 * The queue editor's webview cannot import this module: its twin is
 * `queueStatusKindLabel` in media/shared/queueEntryUtils.js, held equal case
 * by case by QL-2 (queueStatusLabel.test.ts). The renderer adds the extra
 * states after the label (SENDING TODO (PAUSED), RETRYING TODO 2/7 — NEXT …,
 * SENDING TODO — ANSWER NEEDED); the status bar keeps its colour by status.
 *
 * vscode-free and pure.
 */

import type { QueueItemKind } from './queueItemKind';

/** The status word a status shows as (a chat send's own statuses read as sending / sent). */
function stateWord(status: string): string {
    if (status === 'chat') { return 'SENDING'; }
    if (status === 'chat-sent') { return 'SENT'; }
    return (status || 'pending').toUpperCase();
}

/** The label text (`PENDING TODO`) and its class (`status-kind kind-todo`) of an item with `status` and `kind`. */
export function queueStatusKindLabel(status: string, kind: QueueItemKind | string | undefined): { text: string; cls: string } {
    const k = kind || 'prompt';
    return { text: `${stateWord(status)} ${k.toUpperCase()}`, cls: `status-kind kind-${k}` };
}
