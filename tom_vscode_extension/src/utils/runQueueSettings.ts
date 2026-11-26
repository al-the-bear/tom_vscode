/**
 * Queue settings per process run (vscimpb60a): every run has its own queue
 * settings — auto-send, Auto-Start, Auto-Pause, Auto-Continue, the walk
 * continuations, the defaults new items take (Anthropic profile and
 * configuration, session, prompt template; the transport is always `anthropic`).
 * The queue always runs one lane per run
 * (utils/queueLanes.ts): a run whose auto-send is off starts nothing.
 *
 * In the settings file (`queue-settings.yaml`) they are kept under
 * `runs: { <run>: { <key>: value } }`, with the keys the file always had;
 * each entry is complete (an unset optional value is written as `""`), so a
 * run with settings of its own never takes a top-level value. The top-level
 * keys (one set for the whole queue, the file's old shape) are read as the
 * `default` run's settings when it has no entry and as the start values of a
 * run that has none of its own yet. Only "Make default" in the queue editor
 * writes them (vscimpb60g): {@link DEFAULT_SETTING_FIELDS} from one run.
 *
 * Pure.
 */

import { DEFAULT_RUN, normalizeRun } from './processRuns';
import { DEFAULT_WALK_CONTINUATIONS, validContinuations } from './walkCompletionCheck';
import { normalizeAspectChoices } from './aspectChoices';

/** The one transport (not kept in the settings file). */
export type RunQueueTransport = 'anthropic';

export interface RunQueueSettings {
    autoSend: boolean;
    autoStart: boolean;
    autoPause: boolean;
    autoContinue: boolean;
    /**
     * A run paused by a hold of one of its items (a blocked todo, an open decision) goes on by itself once the
     * hold is over (the blocker completed, the decisions answered). Default on.
     */
    autoResumeHeld: boolean;
    /** Continuations a walk iteration gets while its todo is not completed. */
    walkContinuations: number;
    defaultTransport: RunQueueTransport;
    defaultAnthropicProfileId?: string;
    defaultAnthropicConfigId?: string;
    /** The session new items run in; unset = the run's own `default` session. */
    defaultAgentSdkSession?: string;
    /** The prompt template new items take. */
    defaultMessageTemplateId?: string;
    /**
     * The role the run's items run as when neither their todo nor they name
     * one and no process step does (gsel3; utils/promptRole.ts). Every run
     * has one: {@link DEFAULT_RUN_ROLE} unless another is chosen; an empty
     * value in the file means that default.
     */
    defaultRole?: string;
    /**
     * The run's guideline choices (gsel4, L-5): aspect → choice or
     * `remove`; the run level of utils/aspectGuidelines.ts. Unset: none.
     */
    guidelines?: Record<string, string | string[]>;
}

/** The default role of every run (the role `_ai/roles/default/`) unless another is chosen. */
export const DEFAULT_RUN_ROLE = 'default';

/** The settings of a run when neither the file nor its old top-level keys say otherwise. */
export const BUILTIN_RUN_QUEUE_SETTINGS: Readonly<RunQueueSettings> = Object.freeze({
    autoSend: true,
    autoStart: false,
    autoPause: true,
    autoContinue: false,
    autoResumeHeld: true,
    walkContinuations: DEFAULT_WALK_CONTINUATIONS,
    defaultTransport: 'anthropic',
    defaultRole: DEFAULT_RUN_ROLE,
});

/** The settings the file keeps: every one but the transport, which is always `anthropic`. */
export type StoredRunQueueSetting = Exclude<keyof RunQueueSettings, 'defaultTransport'>;

/** The settings-file key of each stored setting. */
export const RUN_QUEUE_SETTING_KEYS: Readonly<Record<StoredRunQueueSetting, string>> = Object.freeze({
    autoSend: 'auto-send-enabled',
    autoStart: 'auto-start-enabled',
    autoPause: 'auto-pause-enabled',
    autoContinue: 'auto-continue-enabled',
    autoResumeHeld: 'auto-resume-held',
    walkContinuations: 'walk-continuations',
    defaultAnthropicProfileId: 'default-anthropic-profile-id',
    defaultAnthropicConfigId: 'default-anthropic-config-id',
    defaultAgentSdkSession: 'default-agent-sdk-session',
    defaultMessageTemplateId: 'default-message-template-id',
    defaultRole: 'default-role',
    guidelines: 'guidelines',
});

/** Every stored setting, in the file's key order. */
const ALL_FIELDS = Object.keys(RUN_QUEUE_SETTING_KEYS) as StoredRunQueueSetting[];

const OPTIONAL_TEXT: ReadonlyArray<StoredRunQueueSetting> = [
    'defaultAnthropicProfileId', 'defaultAnthropicConfigId', 'defaultAgentSdkSession', 'defaultMessageTemplateId',
    'defaultRole',
];

/** `base` with what the file keys in `raw` say (unknown or ill-typed values are ignored). */
export function applyRunQueueKeys(base: Readonly<RunQueueSettings>, raw: unknown): RunQueueSettings {
    const out: RunQueueSettings = { ...base };
    if (typeof raw !== 'object' || raw === null) { return out; }
    const r = raw as Record<string, unknown>;
    const k = RUN_QUEUE_SETTING_KEYS;
    for (const flag of ['autoSend', 'autoStart', 'autoPause', 'autoContinue', 'autoResumeHeld'] as const) {
        if (typeof r[k[flag]] === 'boolean') { out[flag] = r[k[flag]] as boolean; }
    }
    const continuations = validContinuations(r[k.walkContinuations]);
    if (continuations !== undefined) { out.walkContinuations = continuations; }
    for (const key of OPTIONAL_TEXT) {
        const v = r[k[key]];
        if (typeof v === 'string') {
            if (v) { (out as unknown as Record<string, unknown>)[key] = v; } else if (key === 'defaultRole') { out.defaultRole = DEFAULT_RUN_ROLE; } else { delete out[key]; }
        }
    }
    // The guideline choices: a map; '' or an empty map clears them.
    if (r[k.guidelines] !== undefined) {
        const choices = normalizeAspectChoices(r[k.guidelines]);
        if (choices) { out.guidelines = choices; } else { delete out.guidelines; }
    }
    return out;
}

/** A run's settings as the file keys them, complete: an unset optional value is `""` (read back as unset). */
export function runQueueSettingsToKeys(s: Readonly<RunQueueSettings>, fields: ReadonlyArray<StoredRunQueueSetting> = ALL_FIELDS): Record<string, unknown> {
    const out: Record<string, unknown> = {};
    for (const field of fields) {
        const v = s[field];
        // The guideline choices are a map: unset is written as an empty one.
        if (field === 'guidelines') { out[RUN_QUEUE_SETTING_KEYS[field]] = { ...(s.guidelines ?? {}) }; continue; }
        out[RUN_QUEUE_SETTING_KEYS[field]] = v === undefined ? '' : v;
    }
    return out;
}

/**
 * The settings "Make default" copies from a run into the top-level keys: every
 * per-run setting the queue editor's tab shows — auto-send, Auto-Start / -Pause
 * / -Continue, the default profile, configuration, session, role and
 * prompt template. The walk
 * continuations and the auto-resume after a hold (not shown in a tab) keep their top-level value; the run's
 * guideline choices stay the run's own (the quest default is their shared
 * level, gsel4).
 */
export const DEFAULT_SETTING_FIELDS: ReadonlyArray<StoredRunQueueSetting> = Object.freeze(
    ALL_FIELDS.filter((f) => f !== 'walkContinuations' && f !== 'guidelines' && f !== 'autoResumeHeld'),
);

/** The start values once "Make default" took `from`'s shown settings: `start` with {@link DEFAULT_SETTING_FIELDS} of `from`. */
export function startWithDefaultsFrom(start: Readonly<RunQueueSettings>, from: Readonly<RunQueueSettings>): RunQueueSettings {
    const out: RunQueueSettings = { ...start };
    for (const f of DEFAULT_SETTING_FIELDS) {
        if (from[f] === undefined) { delete out[f]; } else { (out as unknown as Record<string, unknown>)[f] = from[f]; }
    }
    return out;
}

/** The fields of {@link DEFAULT_SETTING_FIELDS} in which `a` and `b` differ (an unset optional value equals `""`). */
export function defaultSettingsDiff(a: Readonly<RunQueueSettings>, b: Readonly<RunQueueSettings>): Array<keyof RunQueueSettings> {
    return DEFAULT_SETTING_FIELDS.filter((f) => (a[f] ?? '') !== (b[f] ?? ''));
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

/**
 * The run settings are kept per quest (vscimpb168): `runs-by-quest.<quest>.<run>`
 * of the settings file. The file is shared by every window of every quest, and
 * run names repeat across quests (`default` always), so one quest's runs never
 * change another's. A quest without an entry yet reads the old shared `runs:`
 * (they become its own at its first write).
 */
export const RUNS_BY_QUEST_KEY = 'runs-by-quest';

function questRunsRaw(file: unknown, quest: string): Record<string, unknown> | undefined {
    if (typeof file !== 'object' || file === null) { return undefined; }
    const byQuest = (file as Record<string, unknown>)[RUNS_BY_QUEST_KEY];
    if (typeof byQuest !== 'object' || byQuest === null || Array.isArray(byQuest)) { return undefined; }
    const own = (byQuest as Record<string, unknown>)[quest];
    return typeof own === 'object' && own !== null && !Array.isArray(own) ? own as Record<string, unknown> : undefined;
}

/** The run settings of `quest` in a settings file: its own entry, else the old shared `runs:`. */
export function readQuestRunQueueSettings(file: unknown, quest: string): StoredRunQueueSettings {
    const shared = readRunQueueSettings(file);
    const own = questRunsRaw(file, quest);
    if (!own) { return shared; }
    const runs = new Map<string, RunQueueSettings>();
    for (const [name, raw] of Object.entries(own)) {
        if (!name.trim()) { continue; }
        runs.set(normalizeRun(name), applyRunQueueKeys(shared.start, raw));
    }
    if (!runs.has(DEFAULT_RUN)) { runs.set(DEFAULT_RUN, { ...shared.start }); }
    return { start: shared.start, runs };
}

/**
 * The new `runs-by-quest` value: the file's, with `quest`'s entry changed only
 * in the runs given (`changed` written, `removed` dropped). The other quests,
 * and the runs of `quest` this window did not change, stay as the file has
 * them. A quest without an entry starts from the old shared `runs:`.
 */
export function questRunsInFile(
    file: unknown,
    quest: string,
    changed: ReadonlyMap<string, RunQueueSettings>,
    removed: Iterable<string> = [],
): Record<string, Record<string, unknown>> {
    const f = (typeof file === 'object' && file !== null ? file : {}) as Record<string, unknown>;
    const byQuest = typeof f[RUNS_BY_QUEST_KEY] === 'object' && f[RUNS_BY_QUEST_KEY] !== null && !Array.isArray(f[RUNS_BY_QUEST_KEY])
        ? { ...(f[RUNS_BY_QUEST_KEY] as Record<string, Record<string, unknown>>) }
        : {};
    // A quest's first entry starts from the old shared runs, each written out in full over the start values as
    // the file has them now: a later Make default (new start values) does not change them.
    const legacy = typeof f.runs === 'object' && f.runs !== null && !Array.isArray(f.runs) ? f.runs as Record<string, unknown> : {};
    const start = applyRunQueueKeys(BUILTIN_RUN_QUEUE_SETTINGS, file);
    const seed = questRunsRaw(file, quest)
        ?? Object.fromEntries(Object.entries(legacy).filter(([name]) => name.trim()).map(([name, raw]) => [name, runQueueSettingsToKeys(applyRunQueueKeys(start, raw))]));
    const own: Record<string, unknown> = { ...seed };
    for (const name of removed) { delete own[name]; }
    for (const [name, s] of changed) { own[name] = runQueueSettingsToKeys(s); }
    byQuest[quest] = own;
    return byQuest;
}
