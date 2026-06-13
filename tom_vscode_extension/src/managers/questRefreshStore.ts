/**
 * QuestRefreshStore — per-quest state for the Quest Refresh feature.
 *
 * Quest Refresh fires an automatic "refresh prompt" every *N* prompts to run
 * maintenance work off the recent trail (update the overview, prune todos,
 * refresh quest-notes). The configurable half — the interval and the prompt
 * text — is GLOBAL (shared across quests) and lives in `SendToChatConfig`
 * (`questRefresh`). This store owns only the **per-quest** half:
 *
 *   - `active`: the per-quest activation checkbox.
 *   - `count` : prompts sent since the last refresh, per (quest, panel).
 *
 * Storage: the `questRefresh` section of the machine-specific consolidated
 * config file `_ai/quests/{questId}/extension_config.{hostname}.{questId}.yaml`
 * (host-specific: the `_ai` clone is shared/symlinked across the fleet, so the
 * hostname segment keeps each machine's counter + activation flag separate).
 * This store owns only that one section; {@link extensionConfigStore} owns the
 * file and preserves the other subsystems' sections.
 *
 *     questRefresh:
 *       panels:
 *         anthropic: { active: true,  count: 3 }
 *         localLlm:  { active: false, count: 0 }
 *         copilot:   { active: false, count: 0 }
 *
 * Design: quest_refresh_implementation_plan.md §2.
 */

import {
    SECTION_QUEST_REFRESH,
    readMachineSection,
    writeMachineSection,
} from './extensionConfigStore';
import {
    getQuestRefreshSettings,
    loadSendToChatConfig,
    type QuestRefreshPanel,
    type SendToChatConfig,
} from '../utils/sendToChatConfig';

// ============================================================================
// Types
// ============================================================================

/** Per-(quest, panel) Quest Refresh state. */
export interface QuestRefreshPanelState {
    /** Per-quest activation checkbox. */
    active: boolean;
    /** Prompts sent since the last refresh. */
    count: number;
}

interface QuestRefreshFile {
    panels: Record<QuestRefreshPanel, QuestRefreshPanelState>;
}

const PANELS: readonly QuestRefreshPanel[] = ['anthropic', 'localLlm', 'copilot'];

function emptyState(): QuestRefreshPanelState {
    return { active: false, count: 0 };
}

// ============================================================================
// Store
// ============================================================================

/**
 * Reads/writes the per-quest Quest Refresh YAML. Disk is the source of truth —
 * each call reads and writes the file directly, so concurrent windows on the
 * same quest see each other's updates (last-writer-wins on the same key).
 *
 * The global interval / prompt text are read fresh from `SendToChatConfig` via
 * an injectable loader (defaults to {@link loadSendToChatConfig}) so unit tests
 * can supply a config without a real config file.
 */
export class QuestRefreshStore {
    private static _instance: QuestRefreshStore | undefined;

    static get instance(): QuestRefreshStore {
        if (!QuestRefreshStore._instance) {
            QuestRefreshStore._instance = new QuestRefreshStore();
        }
        return QuestRefreshStore._instance;
    }

    /** Test seam: replace the singleton (e.g. with an injected config loader). */
    static setInstanceForTest(instance: QuestRefreshStore | undefined): void {
        QuestRefreshStore._instance = instance;
    }

    private readonly loadConfig: () => SendToChatConfig | null;

    constructor(loadConfig: () => SendToChatConfig | null = loadSendToChatConfig) {
        this.loadConfig = loadConfig;
    }

    // ---- per-quest state (this store owns this) ----

    /** Resolve the (quest, panel) state, defaulting to inactive / count 0. */
    getPanelState(panel: QuestRefreshPanel, questId?: string): QuestRefreshPanelState {
        return this.read(this.resolveQuest(questId)).panels[panel];
    }

    /** Set the per-quest activation flag for a panel. */
    setActive(panel: QuestRefreshPanel, active: boolean, questId?: string): void {
        const quest = this.resolveQuest(questId);
        const file = this.read(quest);
        file.panels[panel].active = active;
        this.write(quest, file);
    }

    /** Increment the prompt counter for a panel; returns the new count. */
    incrementCount(panel: QuestRefreshPanel, questId?: string): number {
        const quest = this.resolveQuest(questId);
        const file = this.read(quest);
        file.panels[panel].count += 1;
        this.write(quest, file);
        return file.panels[panel].count;
    }

    /** Reset the prompt counter for a panel to 0 (after a refresh fires). */
    resetCount(panel: QuestRefreshPanel, questId?: string): void {
        const quest = this.resolveQuest(questId);
        const file = this.read(quest);
        file.panels[panel].count = 0;
        this.write(quest, file);
    }

    // ---- global config (read-through, not owned here) ----

    /** Configured interval for a panel (`0` ⇒ never). */
    getInterval(panel: QuestRefreshPanel): number {
        return getQuestRefreshSettings(this.loadConfig(), panel).promptInterval;
    }

    /** Configured refresh prompt text for a panel. */
    getRefreshPrompt(panel: QuestRefreshPanel): string {
        return getQuestRefreshSettings(this.loadConfig(), panel).refreshPrompt;
    }

    // ---- derived ----

    /**
     * Whether a refresh should fire now: the panel is active for this quest,
     * the interval is configured (> 0), and the counter has reached it.
     */
    shouldRefresh(panel: QuestRefreshPanel, questId?: string): boolean {
        const interval = this.getInterval(panel);
        if (interval <= 0) { return false; }
        const state = this.getPanelState(panel, questId);
        return state.active && state.count >= interval;
    }

    /**
     * Extra live-trail blocks to retain while a refresh interval is active, so
     * every prompt since the last refresh stays readable for the refresh
     * prompt. `0` when inactive / unconfigured ⇒ default last-5-blocks trail.
     */
    extraTrailAllowance(panel: QuestRefreshPanel, questId?: string): number {
        const interval = this.getInterval(panel);
        if (interval <= 0) { return 0; }
        return this.getPanelState(panel, questId).active ? interval : 0;
    }

    // ---- persistence ----

    /**
     * `undefined` is forwarded to {@link extensionConfigStore} so it applies the
     * canonical quest resolution (open `.code-workspace` → quest id, else
     * `default`) and host-slug sanitisation in one place.
     */
    private resolveQuest(questId?: string): string | undefined {
        const q = (questId ?? '').trim();
        return q || undefined;
    }

    private read(questId: string | undefined): QuestRefreshFile {
        const raw = readMachineSection<Partial<QuestRefreshFile>>(SECTION_QUEST_REFRESH, questId);
        return QuestRefreshStore.normalize(raw);
    }

    private write(questId: string | undefined, file: QuestRefreshFile): void {
        writeMachineSection(SECTION_QUEST_REFRESH, file, questId);
    }

    /** Coerce a possibly-partial on-disk shape into a complete, valid file. */
    private static normalize(raw: Partial<QuestRefreshFile> | undefined): QuestRefreshFile {
        const panels = {} as Record<QuestRefreshPanel, QuestRefreshPanelState>;
        for (const panel of PANELS) {
            const entry = raw?.panels?.[panel];
            panels[panel] = {
                active: entry?.active === true,
                count: typeof entry?.count === 'number' && entry.count > 0 ? Math.floor(entry.count) : 0,
            };
        }
        return { panels };
    }
}
