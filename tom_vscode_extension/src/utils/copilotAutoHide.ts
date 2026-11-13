/**
 * Auto-hide after a Copilot send (vscimpb74): the delay after which the
 * auxiliary bar (where Copilot Chat runs) is closed. Chosen in the Copilot
 * subpanel's action bar (`copilot-autohide`), kept per window in the
 * workspace state `tomAi.copilot.autoHideDelay` (milliseconds; 0 = off).
 *
 * vscode-free.
 */

/** The workspace-state key. */
export const AUTO_HIDE_STATE_KEY = 'tomAi.copilot.autoHideDelay';

/** The delays the dropdown offers, in ms: Off, 3 s, 5 s, 10 s, 20 s. */
export const AUTO_HIDE_DELAYS: readonly number[] = [0, 3000, 5000, 10000, 20000];

/**
 * A stored or sent delay as one the dropdown offers: not a positive number is
 * Off; another value becomes the next offered delay up (an older 1 s becomes
 * 3 s), at most 20 s.
 */
export function normalizeAutoHideDelay(value: unknown): number {
    const n = typeof value === 'string' ? Number(value) : value;
    if (typeof n !== 'number' || !Number.isFinite(n) || n <= 0) { return 0; }
    return AUTO_HIDE_DELAYS.find((d) => d >= n) ?? AUTO_HIDE_DELAYS[AUTO_HIDE_DELAYS.length - 1];
}
