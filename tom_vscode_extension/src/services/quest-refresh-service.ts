/**
 * QuestRefreshService — orchestrates a single Quest Refresh cycle.
 *
 * A refresh "cycle" is: dispatch the panel's configured refresh prompt through
 * that panel's transport, await its completion, force-trim the panel's
 * live-trail back to the base size (dropping the extra blocks accumulated under
 * the active refresh allowance), and reset the per-quest prompt counter.
 *
 * The service is intentionally **transport-agnostic**: the caller supplies a
 * `dispatch(refreshText)` closure that already knows how to send a prompt
 * through the right panel (with quest-refresh skipping, to avoid recursion).
 * That keeps this service free of any handler import — both the auto-trigger
 * (inside the send paths) and the manual button reuse the same `runRefresh`.
 *
 * Design: quest_refresh_implementation_plan.md §4, §6.
 */

import {
    LiveTrailWriter,
    ANTHROPIC_LIVE_TRAIL_FILENAME,
    LOCAL_LLM_LIVE_TRAIL_FILENAME,
} from './live-trail';
import { WsPaths } from '../utils/workspacePaths';
import { QuestRefreshStore } from '../managers/questRefreshStore';
import type { QuestRefreshPanel } from '../utils/sendToChatConfig';
import { toolLog } from '../utils/toolLog';

/** Live-trail filename for each refreshable panel. */
function trailFileName(panel: QuestRefreshPanel): string {
    return panel === 'localLlm' ? LOCAL_LLM_LIVE_TRAIL_FILENAME : ANTHROPIC_LIVE_TRAIL_FILENAME;
}

export class QuestRefreshService {
    private static _instance: QuestRefreshService | undefined;

    static get instance(): QuestRefreshService {
        if (!QuestRefreshService._instance) {
            QuestRefreshService._instance = new QuestRefreshService();
        }
        return QuestRefreshService._instance;
    }

    /**
     * Run one refresh cycle for a panel:
     *   1. dispatch the configured refresh prompt (skipped when blank),
     *   2. force-trim the panel's live-trail back to base,
     *   3. reset the per-quest prompt counter.
     *
     * The caller owns the actual send via `dispatch` — it must route through the
     * panel's transport with quest-refresh skipping so the refresh prompt itself
     * neither counts nor re-triggers.
     *
     * @param panel    Which transport panel to refresh.
     * @param dispatch Sends the refresh prompt through that panel; awaited.
     * @param questId  Quest to target; defaults to the active workspace quest.
     */
    async runRefresh(
        panel: QuestRefreshPanel,
        dispatch: (refreshText: string) => Promise<void>,
        questId?: string,
    ): Promise<void> {
        const store = QuestRefreshStore.instance;
        const quest = (questId ?? WsPaths.getWorkspaceQuestId() ?? 'default').trim() || 'default';
        const refreshText = store.getRefreshPrompt(panel).trim();
        const startedAt = Date.now();
        toolLog(
            `[quest-refresh] start panel=${panel} quest=${quest} ` +
            `promptChars=${refreshText.length}${refreshText ? '' : ' (blank — trim + reset only)'}`,
        );
        try {
            if (refreshText) {
                await dispatch(refreshText);
                toolLog(`[quest-refresh] dispatched panel=${panel} quest=${quest} in ${Date.now() - startedAt}ms`);
            }
        } catch (err) {
            toolLog(
                `[quest-refresh] dispatch FAILED panel=${panel} quest=${quest}: ` +
                `${err instanceof Error ? err.message : String(err)}`,
            );
            throw err;
        } finally {
            // Always truncate + reset even if the dispatch failed, so a broken
            // refresh prompt can't pin the counter at the trigger threshold and
            // re-fire on every subsequent prompt.
            this.truncateTrail(panel, quest);
            store.resetCount(panel, quest);
            toolLog(`[quest-refresh] done panel=${panel} quest=${quest} — trail trimmed to base, counter reset`);
        }
    }

    /**
     * Should an auto-refresh fire before the next prompt on this panel? Thin
     * wrapper over the store so the send-path hooks read intent, not mechanics.
     */
    shouldAutoRefresh(panel: QuestRefreshPanel, questId?: string): boolean {
        return QuestRefreshStore.instance.shouldRefresh(panel, questId);
    }

    /** Force-trim the panel's live-trail to the base block count. */
    private truncateTrail(panel: QuestRefreshPanel, quest: string): void {
        try {
            new LiveTrailWriter(quest, trailFileName(panel)).truncateToBase();
        } catch {
            // Trail truncation is best-effort; never break the cycle on it.
        }
    }
}
