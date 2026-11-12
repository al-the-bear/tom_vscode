/**
 * Queue settings per process run (vscimpb60a): every run has its own queue
 * settings — auto-send, Auto-Start, Auto-Pause, Auto-Continue, the walk
 * continuations, the defaults new items take (transport, Anthropic profile and
 * configuration, session, prompt template), the Copilot answer timeout and
 * reminder template. The queue always runs one lane per run
 * (utils/queueLanes.ts): a run whose auto-send is off starts nothing.
 *
 * In the settings file (`queue-settings.yaml`) they are kept under
 * `runs: { <run>: { <key>: value } }`, with the keys the file always had.
 * The old top-level keys (one set for the whole queue) are read as the
 * `default` run's settings and as the start values of a run that has none of
 * its own yet; they are never written back.
 *
 * Pure.
 */

import { DEFAULT_RUN, normalizeRun } from './processRuns';
import { DEFAULT_WALK_CONTINUATIONS, validContinuations } from './walkCompletionCheck';

export type RunQueueTransport = 'copilot' | 'anthropic';

export interface RunQueueSettings {
    autoSend: boolean;
    autoStart: boolean;
    autoPause: boolean;
    autoContinue: boolean;
    /** Continuations a walk iteration gets while its todo is not completed. */
    walkContinuations: number;
    /** Copilot: minutes until an answer file is overdue. */
    responseTimeoutMinutes: number;
    /** Copilot: the reminder template new items take. */
    defaultReminderTemplateId?: string;
    defaultTransport: RunQueueTransport;
    defaultAnthropicProfileId?: string;
    defaultAnthropicConfigId?: string;
    /** The session new items run in; unset = the run's own `default` session. */
    defaultAgentSdkSession?: string;
    /** The prompt template new items take. */
    defaultMessageTemplateId?: string;
}

/** The settings of a run when neither the file nor its old top-level keys say otherwise. */
export const BUILTIN_RUN_QUEUE_SETTINGS: Readonly<RunQueueSettings> = Object.freeze({
    autoSend: true,
    autoStart: false,
    autoPause: true,
    autoContinue: false,
    walkContinuations: DEFAULT_WALK_CONTINUATIONS,
    responseTimeoutMinutes: 60,
    defaultTransport: 'copilot',
});

/** The settings-file key of each setting. */
export const RUN_QUEUE_SETTING_KEYS: Readonly<Record<keyof RunQueueSettings, string>> = Object.freeze({
    autoSend: 'auto-send-enabled',
    autoStart: 'auto-start-enabled',
    autoPause: 'auto-pause-enabled',
    autoContinue: 'auto-continue-enabled',
    walkContinuations: 'walk-continuations',
    responseTimeoutMinutes: 'response-timeout-minutes',
    defaultReminderTemplateId: 'default-reminder-template-id',
    defaultTransport: 'default-transport',
    defaultAnthropicProfileId: 'default-anthropic-profile-id',
    defaultAnthropicConfigId: 'default-anthropic-config-id',
    defaultAgentSdkSession: 'default-agent-sdk-session',
    defaultMessageTemplateId: 'default-message-template-id',
});

const OPTIONAL_TEXT: ReadonlyArray<keyof RunQueueSettings> = [
    'defaultReminderTemplateId', 'defaultAnthropicProfileId', 'defaultAnthropicConfigId', 'defaultAgentSdkSession', 'defaultMessageTemplateId',
];

/** `base` with what the file keys in `raw` say (unknown or ill-typed values are ignored). */
export function applyRunQueueKeys(base: Readonly<RunQueueSettings>, raw: unknown): RunQueueSettings {
    const out: RunQueueSettings = { ...base };
    if (typeof raw !== 'object' || raw === null) { return out; }
    const r = raw as Record<string, unknown>;
    const k = RUN_QUEUE_SETTING_KEYS;
    for (const flag of ['autoSend', 'autoStart', 'autoPause', 'autoContinue'] as const) {
        if (typeof r[k[flag]] === 'boolean') { out[flag] = r[k[flag]] as boolean; }
    }
    const continuations = validContinuations(r[k.walkContinuations]);
    if (continuations !== undefined) { out.walkContinuations = continuations; }
    if (typeof r[k.responseTimeoutMinutes] === 'number') { out.responseTimeoutMinutes = Math.max(5, r[k.responseTimeoutMinutes] as number); }
    if (r[k.defaultTransport] === 'copilot' || r[k.defaultTransport] === 'anthropic') { out.defaultTransport = r[k.defaultTransport] as RunQueueTransport; }
    for (const key of OPTIONAL_TEXT) {
        const v = r[k[key]];
        if (typeof v === 'string') { (out as unknown as Record<string, unknown>)[key] = v || undefined; }
    }
    return out;
}

/** A run's settings as the file keys them (unset optional values left out). */
export function runQueueSettingsToKeys(s: Readonly<RunQueueSettings>): Record<string, unknown> {
    const out: Record<string, unknown> = {};
    for (const [field, key] of Object.entries(RUN_QUEUE_SETTING_KEYS) as Array<[keyof RunQueueSettings, string]>) {
        const v = s[field];
        if (v !== undefined) { out[key] = v; }
    }
    return out;
}

/** What a settings file says about runs. */
export interface StoredRunQueueSettings {
    /** The start values of a run without settings of its own: the old top-level keys over the built-in ones. */
    start: RunQueueSettings;
    /** Each run with settings: its `runs.<run>` entry over the start values; `default` always. */
    runs: Map<string, RunQueueSettings>;
}

/** Read the run settings of a settings file (any shape: old top-level keys, `runs:`, both, or nothing). */
export function readRunQueueSettings(file: unknown): StoredRunQueueSettings {
    const start = applyRunQueueKeys(BUILTIN_RUN_QUEUE_SETTINGS, file);
    const runs = new Map<string, RunQueueSettings>();
    const stored = typeof file === 'object' && file !== null ? (file as { runs?: unknown }).runs : undefined;
    if (typeof stored === 'object' && stored !== null && !Array.isArray(stored)) {
        for (const [name, raw] of Object.entries(stored as Record<string, unknown>)) {
            if (!name.trim()) { continue; }
            runs.set(normalizeRun(name), applyRunQueueKeys(start, raw));
        }
    }
    if (!runs.has(DEFAULT_RUN)) { runs.set(DEFAULT_RUN, { ...start }); }
    return { start, runs };
}

/** The `runs:` value of the settings file. */
export function runQueueSettingsToFile(runs: ReadonlyMap<string, RunQueueSettings>): Record<string, Record<string, unknown>> {
    const out: Record<string, Record<string, unknown>> = {};
    const names = [...runs.keys()].sort((a, b) => Number(b === DEFAULT_RUN) - Number(a === DEFAULT_RUN) || a.localeCompare(b));
    for (const name of names) { out[name] = runQueueSettingsToKeys(runs.get(name)!); }
    return out;
}
