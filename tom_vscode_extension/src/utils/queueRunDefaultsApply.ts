/**
 * Put a run's current defaults onto the items of its queue (the queue editor's
 * *Apply run defaults to all items* button): for each field the user picks —
 * profile (transport, Anthropic profile and configuration), template, session,
 * role — either set the run's default on the item, or remove the item's own
 * setting so it follows the run's default.
 *
 * What "follows the run's default" means per field:
 *
 * - profile, session, role: an item without its own value takes the run's
 *   default when it is sent, so removing the item's value makes it follow the
 *   default from then on.
 * - template: the run's default template is stamped onto an item when it is
 *   queued and built into its text; an item has no template "of its own" to
 *   inherit from later. Removing it means *no template* (`(None)`).
 *
 * Pure: the queue manager decides which items may change and rebuilds their
 * text (src/managers/promptQueueManager.ts `applyRunDefaultsToItems`).
 */
import { runQueueSession } from './runSessions';

export type RunDefaultField = 'profile' | 'template' | 'session' | 'role';

/** The fields in the order the picker lists them. */
export const RUN_DEFAULT_FIELDS: readonly RunDefaultField[] = Object.freeze(['profile', 'template', 'session', 'role']);

/** `set`: the item takes the run's default value; `clear`: the item's own setting is removed. */
export type RunDefaultsMode = 'set' | 'clear';

/** The template value of an item without a template. */
export const NO_TEMPLATE = '(None)';

/** The run defaults read (a subset of utils/runQueueSettings.ts RunQueueSettings). */
export interface RunDefaultsSource {
    defaultTransport?: 'copilot' | 'anthropic';
    defaultAnthropicProfileId?: string;
    defaultAnthropicConfigId?: string;
    defaultAgentSdkSession?: string;
    defaultMessageTemplateId?: string;
    defaultRole?: string;
}

/** The item fields written (a subset of the queue's QueuedPrompt). */
export interface RunDefaultsTarget {
    transport?: 'copilot' | 'anthropic';
    anthropicProfileId?: string;
    anthropicConfigId?: string;
    template?: string;
    session?: string;
    sessionCreate?: unknown;
    role?: string;
}

/** Whether `value` is a field name the picker offers. */
export function isRunDefaultField(value: unknown): value is RunDefaultField {
    return typeof value === 'string' && (RUN_DEFAULT_FIELDS as readonly string[]).includes(value);
}

/** The fields of `values` the picker offers, in the picker's order, each once. */
export function runDefaultFieldsOf(values: unknown): RunDefaultField[] {
    const given = new Set(Array.isArray(values) ? values.filter(isRunDefaultField) : []);
    return RUN_DEFAULT_FIELDS.filter(f => given.has(f));
}

function trimmed(value: string | undefined): string | undefined {
    const t = value?.trim();
    return t ? t : undefined;
}

/** The value the run's default gives a field, as the item would store it. */
export function runDefaultValues(defaults: RunDefaultsSource, run: string | undefined): Required<Pick<RunDefaultsTarget, 'transport' | 'template' | 'session'>> & Pick<RunDefaultsTarget, 'anthropicProfileId' | 'anthropicConfigId' | 'role'> {
    return {
        transport: defaults.defaultTransport === 'anthropic' ? 'anthropic' : 'copilot',
        anthropicProfileId: trimmed(defaults.defaultAnthropicProfileId),
        anthropicConfigId: trimmed(defaults.defaultAnthropicConfigId),
        template: trimmed(defaults.defaultMessageTemplateId) ?? NO_TEMPLATE,
        session: runQueueSession(defaults.defaultAgentSdkSession, run),
        role: trimmed(defaults.defaultRole),
    };
}

function same(a: unknown, b: unknown): boolean {
    return JSON.stringify(a ?? null) === JSON.stringify(b ?? null);
}

function put<K extends keyof RunDefaultsTarget>(item: RunDefaultsTarget, key: K, value: RunDefaultsTarget[K]): boolean {
    if (same(item[key], value)) { return false; }
    if (value === undefined) { delete item[key]; } else { item[key] = value; }
    return true;
}

/**
 * Set (`set`) or remove (`clear`) `fields` on `item` from the defaults of run
 * `run`. Returns the fields whose stored value changed.
 */
export function applyRunDefaultsToItem(
    item: RunDefaultsTarget,
    defaults: RunDefaultsSource,
    run: string | undefined,
    fields: readonly RunDefaultField[],
    mode: RunDefaultsMode,
): RunDefaultField[] {
    const values = runDefaultValues(defaults, run);
    const changed: RunDefaultField[] = [];
    for (const field of runDefaultFieldsOf(fields)) {
        let did = false;
        switch (field) {
            case 'profile': {
                const set = mode === 'set';
                const a = put(item, 'transport', set ? values.transport : undefined);
                const b = put(item, 'anthropicProfileId', set ? values.anthropicProfileId : undefined);
                const c = put(item, 'anthropicConfigId', set ? values.anthropicConfigId : undefined);
                did = a || b || c;
                break;
            }
            case 'template':
                did = put(item, 'template', mode === 'set' ? values.template : NO_TEMPLATE);
                break;
            case 'session': {
                const a = put(item, 'session', mode === 'set' ? values.session : undefined);
                const b = put(item, 'sessionCreate', undefined);
                did = a || b;
                break;
            }
            case 'role':
                did = put(item, 'role', mode === 'set' ? values.role : undefined);
                break;
        }
        if (did) { changed.push(field); }
    }
    return changed;
}

/** The picker's line for one field: what it is and the run's default it would set. */
export interface RunDefaultPickerEntry {
    field: RunDefaultField;
    label: string;
    description: string;
}

/** The picker's lines for the four fields, each naming the run's current default. */
export function runDefaultPickerEntries(defaults: RunDefaultsSource, run: string | undefined): RunDefaultPickerEntry[] {
    const v = runDefaultValues(defaults, run);
    const profile = v.transport === 'anthropic'
        ? `Anthropic · ${v.anthropicProfileId ?? 'default profile'}${v.anthropicConfigId ? ` · ${v.anthropicConfigId}` : ''}`
        : 'Copilot';
    return [
        { field: 'profile', label: '$(server-process) Profile', description: profile },
        { field: 'template', label: '$(file-code) Template', description: v.template === NO_TEMPLATE ? 'no template' : v.template },
        { field: 'session', label: '$(comment-discussion) Session', description: v.session },
        { field: 'role', label: '$(person) Role', description: v.role ?? 'no default role' },
    ];
}

/** What applying the defaults to a run's queue did. */
export interface RunDefaultsApplyResult {
    run: string;
    mode: RunDefaultsMode;
    fields: RunDefaultField[];
    /** Items whose stored settings changed. */
    changed: number;
    /** Items that could change but already had these values. */
    unchanged: number;
    /** Items left as they are because they already started (every status past pending). */
    notEditable: number;
    /** Items left as they were because their profile could not continue the new session, with the reason. */
    refused: Array<{ id: string; reason: string }>;
}

const FIELD_LABELS: Readonly<Record<RunDefaultField, string>> = Object.freeze({
    profile: 'profile', template: 'template', session: 'session', role: 'role',
});

/** One sentence saying what was done, for the info message. */
export function runDefaultsApplySummary(result: RunDefaultsApplyResult): string {
    const what = result.fields.map(f => FIELD_LABELS[f]).join(', ');
    const verb = result.mode === 'set' ? `Run ${result.run}'s defaults (${what}) set` : `Per-item settings (${what}) removed`;
    const items = (n: number): string => `${n} item${n === 1 ? '' : 's'}`;
    const parts = [`${verb} on ${items(result.changed)}`];
    if (result.unchanged) { parts.push(`${items(result.unchanged)} already matched`); }
    if (result.notEditable) { parts.push(`${items(result.notEditable)} that already started left as they are`); }
    if (result.refused.length) { parts.push(`${items(result.refused.length)} left as they were: ${[...new Set(result.refused.map(r => r.reason))].join(' ')}`); }
    return `${parts.join('; ').replace(/\.+$/, '')}.`;
}
