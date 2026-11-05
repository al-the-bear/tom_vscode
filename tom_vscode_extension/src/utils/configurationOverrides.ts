/**
 * The compaction and tool-trail retention values an Anthropic configuration
 * sets itself instead of inheriting them from the `compaction` section — what
 * the Status Page's configuration list marks with ⚙ and names.
 *
 * vscode-free.
 */

import { RETENTION_KEYS } from '../services/toolTrailRetention';

/** The keys a configuration may override, in the order the list names them. */
export const CONFIGURATION_OVERRIDE_KEYS: readonly string[] = ['historyMaxChars', 'memoryMaxChars', 'rawTurnsKept', ...RETENTION_KEYS];

/** The overrides `cfg` sets, by key; [] when it inherits everything. */
export function configurationOverrides(cfg: Record<string, unknown>): Array<{ key: string; value: number }> {
    return CONFIGURATION_OVERRIDE_KEYS
        .filter((key) => typeof cfg[key] === 'number' && Number.isFinite(cfg[key] as number))
        .map((key) => ({ key, value: cfg[key] as number }));
}
