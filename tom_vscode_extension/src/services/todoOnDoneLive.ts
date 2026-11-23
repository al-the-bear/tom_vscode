/**
 * The live wiring of the `on_done` runner (services/todoOnDoneRunner.ts),
 * installed at activation: the todo files through questTodoManager, this
 * window's prompt queue for its own quest, the quest inbox for another, and
 * the completion hook of the todo writer — which leaves a completion to the
 * queue while a walk holds the todo's claim.
 */

/* eslint-disable @typescript-eslint/naming-convention -- the todo schema's YAML keys */
import * as os from 'os';

import * as questTodo from '../managers/questTodoManager';
import { PromptQueueManager } from '../managers/promptQueueManager';
import { ProcessStateStore } from '../managers/processStateStore';
import { liveQuestSendAccess } from '../tools/chat-enhancement-tools';
import { postInboxItem } from '../tools/send-to-quest-tools';
import { logQueue } from '../utils/queueLogger';
import { todayLocalDate } from '../utils/todoDates';
import { loadSendToChatConfig } from '../utils/sendToChatConfig';
import { WsPaths } from '../utils/workspacePaths';
import { currentProcessRun } from './processRunContext';
import { currentQueueItemId } from './userWaits';
import { deferTodoOnDone, runTodoOnDone, setTodoOnDonePorts } from './todoOnDoneRunner';
import type { OnDoneTarget } from '../utils/todoOnDoneRun';

function where(sourceFile: string | undefined): OnDoneTarget['where'] {
    const first = (sourceFile ?? '').split('.')[0];
    return first.endsWith('-deleted') ? 'deleted' : first.endsWith('-archived') ? 'archived' : 'live';
}

/** Install the runner's ports and the todo writer's completion hook. */
export function installTodoOnDone(): void {
    setTodoOnDonePorts({
        windowQuest: () => {
            const q = WsPaths.getWorkspaceQuestId();
            return q && q !== 'default' ? q : undefined;
        },
        findTodo: (quest, id) => {
            if (!questTodo.questExists(quest)) { return undefined; }
            // A live todo wins over a stub of the same id in a sibling.
            const all = questTodo.readAllTodos(quest, questTodo.ALL_TODO_FILES).filter((t) => t.id === id);
            const t = all.find((x) => where(x._sourceFile) === 'live') ?? all[0];
            if (!t) { return undefined; }
            return {
                status: t.status, decisions: t.decisions, title: t.title, where: where(t._sourceFile),
                group: t.status === 'group' || (t.comprised_of ?? []).length > 0,
            };
        },
        notifyTemplate: () => loadSendToChatConfig()?.todoPanel?.doneNotificationTemplate?.trim() || undefined,
        writeTarget: (quest, id, status) => {
            questTodo.updateTodo(quest, id, { status: status as questTodo.QuestTodoStatus });
        },
        appendNotes: (quest, id, lines) => {
            const t = questTodo.findTodoById(quest, id);
            const old = (t?.notes ?? '').replace(/\s+$/, '');
            questTodo.updateTodo(quest, id, { notes: old ? `${old}\n${lines.join('\n')}` : lines.join('\n') });
        },
        enqueueLocal: async (send) => {
            // Next in its run, between the iterations of a loop that is sending.
            await PromptQueueManager.instance.enqueueNext({
                originalText: send.text,
                run: send.run,
                runIsExplicit: true,
                ...(send.session ? { session: send.session } : {}),
            });
        },
        postToQuest: (send, from) => {
            const me = liveQuestSendAccess.sender();
            postInboxItem(liveQuestSendAccess, send.quest, {
                text: send.text,
                ...(send.run && send.run !== 'default' ? { run: send.run } : {}),
                ...(send.session ? { session: send.session } : {}),
                position: 'next',
                from: { quest: from.quest, run: from.run, windowId: me.windowId, host: me.host || os.hostname(), sentAt: new Date().toISOString() },
            });
        },
        log: (line) => logQueue(line),
        today: () => todayLocalDate(),
    });
    questTodo.setTodoCompletionHook((questId, todo) => {
        let queue: PromptQueueManager | undefined;
        try { queue = PromptQueueManager.instance; } catch { queue = undefined; }
        if (queue?.holdsTodoClaim(questId, todo.id)) {
            // A walk runs it: carried out where the queue settles the claim, after its answer is on the todo.
            deferTodoOnDone(questId, todo.id);
            return;
        }
        const run = currentProcessRun()?.run ?? ProcessStateStore.instance?.currentRun ?? 'default';
        // The queue item or chat send whose turn completed it: who queued it gets the done notification (vscimpb146).
        const itemId = currentQueueItemId();
        const queuedBy = itemId ? queue?.queuedByOf(itemId) : undefined;
        void runTodoOnDone(questId, { ...todo, sourceFile: todo._sourceFile }, run, queuedBy ? { queuedBy } : {});
    });
}
