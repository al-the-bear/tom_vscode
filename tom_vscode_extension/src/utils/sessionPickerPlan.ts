/**
 * What the session picker offers and what it creates — pure, so every path
 * can be tested without VS Code (src/handlers/sessionPicker.ts shows these
 * choices in quick picks).
 *
 * - {@link lifetimeChoices}: the three lifetimes, worded for a session with
 *   or without a base.
 * - {@link profileChoices}: the Anthropic profiles as the ANTHROPIC panel lists
 *   them (`(no API key)` marks included), plus "No profile" and, for a based
 *   session, "As the base".
 * - {@link newSessionOptions}: the `createSession` options for the choices
 *   made; the file is written at once, the conversation starts on first use.
 * - {@link sessionLabel}: how a session reads where it is shown (the ANTHROPIC
 *   panel's session button): name, base, lifetime, model.
 */

import type { SessionMode, SessionRecord } from './agentSdkSessions';
import { lookupProfile, type ProfileSection } from './sessionSpecs';

export interface LifetimeChoice {
    label: string;
    description: string;
    mode: SessionMode;
}

/** The lifetimes, in the order the picker shows them. */
export function lifetimeChoices(basedOn: string | undefined): LifetimeChoice[] {
    const from = basedOn ? `from "${basedOn}"` : 'fresh';
    return [
        {
            label: 'One conversation',
            description: basedOn
                ? `its first prompt starts from "${basedOn}"'s conversation; later prompts continue the new session`
                : 'every prompt continues it',
            mode: 'continue',
        },
        {
            label: 'New for every prompt',
            description: `every prompt starts ${from}; prompts never change the context of the ones after them`,
            mode: 'per-prompt',
        },
        {
            label: 'New for every queue iteration',
            description: `each repeat round or prefix todo starts ${from}; its pre-prompts and follow-ups continue it`,
            mode: 'per-iteration',
        },
    ];
}

/** What the profile step chose. */
export type ProfileChoice = { kind: 'none' } | { kind: 'base' } | { kind: 'profile'; id: string };

export interface ProfileChoiceItem {
    label: string;
    description: string;
    choice: ProfileChoice;
}

/** A profile as the panel lists it (src/utils/anthropicApiKeyCheck.ts profileKeyStates). */
export interface ListedProfile {
    id: string;
    name: string;
    noApiKey: boolean;
}

/**
 * The profile step: "No profile", "As the base (<profile>)" when the base has
 * one, then every profile with its model and its `(no API key)` mark.
 */
export function profileChoices(
    profiles: readonly ListedProfile[],
    section: ProfileSection | undefined,
    base: SessionRecord | undefined,
): ProfileChoiceItem[] {
    const items: ProfileChoiceItem[] = [
        { label: 'No profile', description: 'prompts run with the queue item\'s profile, else the queue\'s (the panel: its own)', choice: { kind: 'none' } },
    ];
    if (base?.profileId) {
        items.push({
            label: `As the base (${base.profileId})`,
            description: base.model ?? lookupProfile(section, base.profileId)?.model ?? '',
            choice: { kind: 'base' },
        });
    }
    for (const p of profiles) {
        const model = lookupProfile(section, p.id)?.model;
        items.push({
            label: p.name + (p.noApiKey ? ' (no API key)' : ''),
            description: [p.id, model].filter(Boolean).join(' · '),
            choice: { kind: 'profile', id: p.id },
        });
    }
    return items;
}

/** What `createSession` gets for the choices made. */
export interface NewSessionOptions {
    basedOn?: string;
    mode: SessionMode;
    /** Unset: the base's (createSession inherits it); null: none. */
    profile?: { id: string; model?: string } | null;
}

/**
 * The options for a new session. "As the base" leaves the profile unset, so
 * createSession takes the base's; "No profile" writes none even when the base
 * has one; a chosen profile is stored with its model.
 */
export function newSessionOptions(
    basedOn: string | undefined,
    mode: SessionMode,
    choice: ProfileChoice,
    section: ProfileSection | undefined,
): NewSessionOptions {
    const out: NewSessionOptions = { ...(basedOn ? { basedOn } : {}), mode };
    if (choice.kind === 'profile') {
        const p = lookupProfile(section, choice.id);
        out.profile = { id: choice.id, ...(p?.model ? { model: p.model } : {}) };
    } else if (choice.kind === 'none' && basedOn) {
        out.profile = null;
    }
    return out;
}

/** How a session reads on a button: `name based on X (per iteration) · model`, and a sentence for its tooltip. */
export function sessionLabel(name: string, record: SessionRecord | undefined): { label: string; tooltip: string } {
    const mode = record?.mode ?? 'continue';
    const lifetime = mode === 'per-prompt' ? 'per prompt' : mode === 'per-iteration' ? 'per iteration' : '';
    const model = record?.model ?? record?.profileId;
    const label = name
        + (record?.basedOn ? ` based on ${record.basedOn}` : '')
        + (lifetime ? ` (${lifetime})` : '')
        + (model ? ` · ${model}` : '');
    const tooltip = `Session ${name}`
        + (record?.basedOn ? `, based on ${record.basedOn}` : '')
        + (mode === 'per-prompt' ? ', started again for every prompt' : mode === 'per-iteration' ? ', started again for every queue iteration' : '')
        + (record?.profileId ? `, profile ${record.profileId}${record.model ? ` (${record.model})` : ''}` : '');
    return { label, tooltip };
}
