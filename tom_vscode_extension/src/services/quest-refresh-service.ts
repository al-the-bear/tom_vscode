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

import { TwoTierMemoryService } from './memory-service';
import { sessionLiveTrailsSince, sessionsWithStorage } from './sessionStorage';
import * as path from 'path';
import * as vscode from 'vscode';
import {
    LiveTrailWriter,
    ANTHROPIC_LIVE_TRAIL_FILENAME,
    LOCAL_LLM_LIVE_TRAIL_FILENAME,
} from './live-trail';
import { WsPaths } from '../utils/workspacePaths';
import { QuestRefreshStore } from '../managers/questRefreshStore';
import type { QuestRefreshPanel } from '../utils/sendToChatConfig';
import { toolLog } from '../utils/toolLog';
import {
    REFRESH_SESSIONS_PLACEHOLDER,
    applyRefreshSessionTrails,
    formatRefreshSessionTrails,
} from '../utils/refreshSessionTrails';

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
     * True while a refresh prompt is actively being dispatched. A refresh can
     * run for a long time (it's a full maintenance turn), and it fires from
     * inside the queue dispatch loop or an interactive send — so without a
     * visible signal the user can't tell the pause is intentional. The queue
     * editor subscribes to {@link onDidChangeRefreshing} and paints an orange
     * banner while this is `true`.
     */
    private _refreshing = false;
    private readonly _onDidChangeRefreshing = new vscode.EventEmitter<boolean>();

    /** Fires when a refresh dispatch starts (`true`) or ends (`false`). */
    readonly onDidChangeRefreshing: vscode.Event<boolean> = this._onDidChangeRefreshing.event;

    /** Whether a refresh prompt is currently being dispatched. */
    get isRefreshing(): boolean {
        return this._refreshing;
    }

    private setRefreshing(value: boolean): void {
        if (this._refreshing === value) { return; }
        this._refreshing = value;
        this._onDidChangeRefreshing.fire(value);
    }

    /**
     * Run one refresh cycle for a panel:
     *   1. dispatch the configured refresh prompt (skipped when blank) — for
     *      the Anthropic panel with the list of session live trails written
     *      since the last refresh, newest first (`${refreshSessions}`),
     *   2. force-trim the panel's live-trail(s) back to base — every session's,
     *   3. reset the per-quest prompt counter and record when it ran.
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
        const configured = store.getRefreshPrompt(panel).trim();
        const refreshText = configured ? this.withSessionTrails(panel, quest, configured) : '';
        const startedAt = Date.now();
        toolLog(
            `[quest-refresh] start panel=${panel} quest=${quest} ` +
            `promptChars=${refreshText.length}${refreshText ? '' : ' (blank — trim + reset only)'}`,
        );
        try {
            if (refreshText) {
                // Only signal "running" when there's an actual prompt to
                // dispatch — the blank case (trim + reset only) is instantaneous
                // and would just flicker the banner.
                this.setRefreshing(true);
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
            // Clear the banner first (no-op if it was never set), then always
            // truncate + reset even if the dispatch failed, so a broken refresh
            // prompt can't pin the counter at the trigger threshold and re-fire
            // on every subsequent prompt.
            this.setRefreshing(false);
            this.truncateTrail(panel, quest);
            store.recordRefresh(panel, quest, this.refreshTime(panel, quest));
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

    /**
     * The refresh prompt with the session live trails to read. Only the
     * Anthropic panel has sessions; on the others the placeholder is removed.
     */
    private withSessionTrails(panel: QuestRefreshPanel, quest: string, prompt: string): string {
        if (panel !== 'anthropic') {
            return prompt.split(REFRESH_SESSIONS_PLACEHOLDER).join('').trim();
        }
        try {
            const since = QuestRefreshStore.instance.lastRefreshAt(panel, quest);
            const wsRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? '';
            const trails = sessionLiveTrailsSince(TwoTierMemoryService.instance.historyFolder(quest), since)
                .map((t) => ({ ...t, file: (wsRoot ? path.relative(wsRoot, t.file) : t.file).split(path.sep).join('/') }));
            return applyRefreshSessionTrails(prompt, formatRefreshSessionTrails(trails, since));
        } catch (err) {
            toolLog(`[quest-refresh] session list failed quest=${quest}: ${err instanceof Error ? err.message : String(err)}`);
            return prompt;
        }
    }

    /**
     * The time a finished refresh records: now, or the last write of a session
     * trail if later — the trim just rewrote them, and the file system's clock
     * can run a millisecond ahead of `Date`, so without this the next refresh
     * would list every trail the trim touched as written since.
     */
    private refreshTime(panel: QuestRefreshPanel, quest: string): Date {
        let at = Date.now();
        if (panel === 'anthropic') {
            try {
                for (const t of sessionLiveTrailsSince(TwoTierMemoryService.instance.historyFolder(quest))) {
                    at = Math.max(at, t.modified.getTime());
                }
            } catch { /* no trails to compare with */ }
        }
        return new Date(at);
    }

    /** Force-trim the panel's live-trail to the base block count. */
    private truncateTrail(panel: QuestRefreshPanel, quest: string): void {
        try {
            // Anthropic: every session keeps its own live trail, and the
            // refresh runs in the session of the send that triggered it, so
            // each session's is trimmed.
            if (panel === 'localLlm') {
                new LiveTrailWriter(quest, trailFileName(panel)).truncateToBase();
            } else {
                for (const session of sessionsWithStorage(TwoTierMemoryService.instance.historyFolder(quest))) {
                    new LiveTrailWriter(quest, undefined, session).truncateToBase();
                }
            }
        } catch {
            // Trail truncation is best-effort; never break the cycle on it.
        }
    }
}
