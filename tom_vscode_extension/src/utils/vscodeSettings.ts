/**
 * The extension's VS Code settings (`tomAi.*`, package.json
 * `contributes.configuration`) that tune running parts, read through one
 * place so each has its default and its bounds: the Dart bridge's request
 * timeout, restart delay and restart limit, the timed-request engine's tick,
 * the Guidelines panel's project exclusions. Every contributed setting has a
 * reader (the test SR-1 checks it).
 *
 * vscode-free: the caller passes the lookup, e.g.
 * `(key) => vscode.workspace.getConfiguration('tomAi').get(key)`.
 */

import { BRIDGE_MAX_RESTARTS, BRIDGE_REQUEST_TIMEOUT, BRIDGE_RESTART_DELAY } from './constants';

/** Reads one `tomAi.<key>` setting; undefined when unset. */
export type SettingLookup = (key: string) => unknown;

/** A whole number of at least `min`, else `fallback`. */
function wholeNumber(value: unknown, fallback: number, min: number): number {
    return typeof value === 'number' && Number.isFinite(value) && value >= min ? Math.floor(value) : fallback;
}

export interface BridgeSettings {
    /** `tomAi.bridge.requestTimeout`: how long a bridge request may take, ms. */
    requestTimeoutMs: number;
    /** `tomAi.bridge.restartDelay`: the wait before an automatic restart, ms. */
    restartDelayMs: number;
    /** `tomAi.bridge.maxRestarts`: automatic restarts in a row before giving up; 0: none. */
    maxRestarts: number;
}

export function bridgeSettings(get: SettingLookup): BridgeSettings {
    return {
        requestTimeoutMs: wholeNumber(get('bridge.requestTimeout'), BRIDGE_REQUEST_TIMEOUT, 1000),
        restartDelayMs: wholeNumber(get('bridge.restartDelay'), BRIDGE_RESTART_DELAY, 0),
        maxRestarts: wholeNumber(get('bridge.maxRestarts'), BRIDGE_MAX_RESTARTS, 0),
    };
}

/** The timed-request engine's tick when `tomAi.timedRequests.tickInterval` is unset. */
export const TIMER_TICK_DEFAULT_MS = 30_000;

/** `tomAi.timedRequests.tickInterval`: how often the engine looks for due entries, ms (at least one second). */
export function timerTickIntervalMs(get: SettingLookup): number {
    return wholeNumber(get('timedRequests.tickInterval'), TIMER_TICK_DEFAULT_MS, 1000);
}

/** The Guidelines panel's exclusions when `tomAi.guidelines.excludeGlobs` is unset. */
export const GUIDELINES_EXCLUDE_DEFAULT = ['tom/zom_*/**'];

/** `tomAi.guidelines.excludeGlobs`: projects left out of the Guidelines panel's Project list. */
export function guidelinesExcludeGlobs(get: SettingLookup): string[] {
    const value = get('guidelines.excludeGlobs');
    if (!Array.isArray(value)) { return [...GUIDELINES_EXCLUDE_DEFAULT]; }
    return value.map((v) => (typeof v === 'string' ? v.trim() : '')).filter((v) => v.length > 0);
}

/**
 * The next automatic restart of the bridge: its delay, or null when
 * `maxRestarts` restarts in a row have been tried (the count is reset when
 * the bridge answers a request, and by an explicit start).
 */
export function nextBridgeRestart(settings: BridgeSettings, restartsInARow: number): { delayMs: number } | null {
    return restartsInARow < settings.maxRestarts ? { delayMs: settings.restartDelayMs } : null;
}
