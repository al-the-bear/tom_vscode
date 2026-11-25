/**
 * The profile a queue item runs with, as its header shows it: the item's own
 * (a clickable name) or none of its own (an icon button; it runs with what
 * the session or the queue default names), and the entries of the picker a
 * click opens — every profile, whatever its transport.
 *
 * Pure: no `vscode`, no `fs`.
 */

export interface ProfileLike { id: string; name?: string; configurationId?: string; isDefault?: boolean }
export interface ConfigurationLike { id: string; name?: string; model?: string; transport?: string }

/** What the header shows for the item's profile. */
export interface ItemProfileView {
    /** The item names its own profile (the clickable name); else it runs with the default (the icon button). */
    own: boolean;
    /** The transport its prompt is sent on. */
    transport: 'anthropic';
    /** The profile it runs with (its own, else the session's or the queue default's). */
    id?: string;
    name?: string;
    /** That profile's model and how it is reached, e.g. `claude-opus-4 · Agent SDK`. */
    detail?: string;
    /** A click may change it (the item has not finished). */
    canPick: boolean;
}

/** `agentSdk` → `Agent SDK`, `direct` → `direct API`, ... */
export function transportKindLabel(transport: string | undefined): string {
    switch (transport) {
        case 'agentSdk': return 'Agent SDK';
        case 'vscodeLm': return 'VS Code LM';
        case 'localLlm': return 'Local LLM';
        default: return 'direct API';
    }
}

/** A profile's model and how it is reached: `<model> · <kind>`; '' when its configuration is not known. */
export function profileDetail(profile: ProfileLike | undefined, configurations: readonly ConfigurationLike[]): string {
    const configuration = profile?.configurationId ? configurations.find((c) => c.id === profile.configurationId) : undefined;
    if (!configuration) { return ''; }
    return [configuration.model || configuration.name || configuration.id, transportKindLabel(configuration.transport)].filter(Boolean).join(' · ');
}

/** Statuses in which the item's profile can no longer change anything. */
const FINISHED = new Set(['sent', 'chat', 'chat-sent']);

/**
 * The header's profile display. `ownProfileId`: the item's own
 * `anthropicProfileId`; `resolved`: the transport and profile its main prompt
 * would be sent with now (item, session, queue default).
 */
export function itemProfileView(input: {
    status: string;
    ownTransport?: string;
    ownProfileId?: string;
    resolved: { transport: string; anthropicProfileId?: string };
    profiles: readonly ProfileLike[];
    configurations: readonly ConfigurationLike[];
}): ItemProfileView {
    const canPick = !FINISHED.has(input.status);
    const own = input.ownTransport === 'anthropic' && !!input.ownProfileId;
    const wanted = own ? input.ownProfileId : input.resolved.anthropicProfileId;
    const profile = input.profiles.find((p) => p.id === wanted)
        ?? (own ? undefined : input.profiles.find((p) => p.isDefault === true) ?? input.profiles[0]);
    const id = profile?.id ?? wanted;
    const detail = profileDetail(profile, input.configurations);
    return { own, transport: 'anthropic', ...(id ? { id, name: profile?.name || id } : {}), ...(detail ? { detail } : {}), canPick };
}

/** The picker's value for "no profile of its own". */
export const QUEUE_DEFAULT_PICK = '';

export interface ProfilePickEntry { label: string; description: string; detail?: string; value: string }

/**
 * The picker a click on the header opens: every profile (name, id, model and
 * kind; the item's own marked), then "the queue default" while the item
 * names one of its own.
 */
export function profilePickEntries(profiles: readonly ProfileLike[], configurations: readonly ConfigurationLike[], view: ItemProfileView): ProfilePickEntry[] {
    const entries: ProfilePickEntry[] = profiles.map((p) => ({
        label: p.name || p.id,
        description: [p.name && p.name !== p.id ? p.id : '', view.own && p.id === view.id ? '(current)' : '', p.isDefault ? '(default profile)' : ''].filter(Boolean).join(' '),
        ...(profileDetail(p, configurations) ? { detail: profileDetail(p, configurations) } : {}),
        value: p.id,
    }));
    if (view.own) {
        entries.push({ label: 'No profile of its own', description: 'the session\'s profile, else the queue default', value: QUEUE_DEFAULT_PICK });
    }
    return entries;
}
