/**
 * The session switch of the @WS Logs tabs — pure, so the plan the webview
 * draws is tested here (src/handlers/questLogs-handler.ts computes it,
 * media/questLogs/main.js only renders it).
 *
 * One button per session, the most recently used first, for at most
 * {@link MAX_SESSION_BUTTONS} sessions. With more sessions a dropdown holding
 * every session comes first, and the buttons are the four most recently used
 * (decision: the dropdown holds the rest). The chosen session is always
 * visible: in the dropdown when it has no button.
 */

export const MAX_SESSION_BUTTONS = 4;

/** A session as the switch sees it. */
export interface SwitchSession {
    name: string;
    /** Last use, ms since the epoch; unknown sorts after every known one. */
    lastUse?: number;
}

/** What the webview draws. */
export interface SessionSwitchPlan {
    /** Every session, most recently used first. */
    sessions: string[];
    /** The sessions that get a button, in that order. */
    buttons: string[];
    /** Whether the dropdown shows (more sessions than buttons). */
    showDropdown: boolean;
    /** The session the tab shows. */
    selected: string;
}

/** Most recently used first; sessions never used by name. */
export function orderSessionsByUse(sessions: ReadonlyArray<SwitchSession>): string[] {
    const seen = new Set<string>();
    return [...sessions]
        .filter((s) => (seen.has(s.name) ? false : (seen.add(s.name), true)))
        .sort((a, b) => {
            const ua = a.lastUse ?? -Infinity;
            const ub = b.lastUse ?? -Infinity;
            return ub - ua || a.name.localeCompare(b.name);
        })
        .map((s) => s.name);
}

/**
 * The plan for `sessions` with `selected` chosen: an unknown or missing choice
 * falls back to `fallback` when that session exists, else to the most
 * recently used one.
 */
export function planSessionSwitch(
    sessions: ReadonlyArray<SwitchSession>,
    selected: string | undefined,
    fallback: string,
    maxButtons: number = MAX_SESSION_BUTTONS,
): SessionSwitchPlan {
    const ordered = orderSessionsByUse(sessions);
    const chosen = selected && ordered.includes(selected)
        ? selected
        : ordered.includes(fallback) ? fallback : (ordered[0] ?? fallback);
    return {
        sessions: ordered,
        buttons: ordered.slice(0, maxButtons),
        showDropdown: ordered.length > maxButtons,
        selected: chosen,
    };
}
