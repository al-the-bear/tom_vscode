/**
 * Does an Anthropic target need an API key this VS Code does not have?
 *
 * The direct transport (`@anthropic-ai/sdk`) reads its key from ONE place:
 * `process.env[anthropic.apiKeyEnvVar]` of the extension host. When that
 * variable is unset every send fails with "Anthropic client not available"
 * — and a queued item then fails and is retried for hours. That is knowable
 * before anything is queued, so the queue tools, the queue editor and the
 * profile pickers ask here first.
 *
 * Pure: the configuration and the environment are passed in. The profile and
 * configuration are picked by the rules the queue's dispatcher uses
 * (`resolveAnthropicTargets`, which shares {@link pickAnthropicProfile} and
 * {@link effectiveConfigurationId}).
 */

/** The fields of `config.anthropic` this check reads. */
export interface AnthropicKeySection {
    apiKeyEnvVar?: string;
    profiles?: Array<{ id?: string; name?: string; isDefault?: boolean; configurationId?: string } | null | undefined>;
    configurations?: Array<{ id?: string; transport?: string } | null | undefined>;
}

export interface MissingApiKey {
    /** The environment variable the direct transport reads. */
    envVar: string;
    profileId: string;
    configurationId: string;
}

/** The variable the direct API key is read from when `anthropic.apiKeyEnvVar` names none. */
export const DEFAULT_API_KEY_ENV_VAR = 'ANTHROPIC_API_KEY';

/**
 * The key variable of the direct transport: `apiKeyEnvVar`, else
 * {@link DEFAULT_API_KEY_ENV_VAR}. The one rule; nothing else spells it out.
 */
export function directApiKeyEnvVar(section: AnthropicKeySection | undefined): string {
    return section?.apiKeyEnvVar || DEFAULT_API_KEY_ENV_VAR;
}

/** The profile a request runs with: by id, else the default one, else the first. */
export function pickAnthropicProfile<P extends { id?: string; isDefault?: boolean }>(
    profiles: ReadonlyArray<P | null | undefined>,
    profileId: string | undefined,
): P | undefined {
    const list = profiles.filter((p): p is P => !!p);
    return list.find((p) => p.id === profileId) ?? list.find((p) => p.isDefault === true) ?? list[0];
}

/** An explicit, non-blank configuration id wins over the profile's own. */
export function effectiveConfigurationId(
    profile: { configurationId?: string } | undefined,
    configId: string | undefined,
): string | undefined {
    const explicit = typeof configId === 'string' && configId.trim().length > 0 ? configId : undefined;
    return explicit ?? profile?.configurationId;
}

/**
 * The missing key of the target `{profileId, configId}` resolves to, or
 * undefined when nothing is missing: the configuration is not a direct one
 * (Agent SDK, VS Code LM, a Local LLM configuration), it does not resolve, or
 * the variable is set.
 */
export function missingDirectApiKey(
    section: AnthropicKeySection | undefined,
    target: { profileId?: string; configId?: string },
    env: Record<string, string | undefined>,
): MissingApiKey | undefined {
    const profile = pickAnthropicProfile(section?.profiles ?? [], target.profileId);
    const configurationId = effectiveConfigurationId(profile, target.configId);
    if (!profile?.id || !configurationId) { return undefined; }
    const configuration = (section?.configurations ?? []).find((c) => c?.id === configurationId);
    if (!configuration) { return undefined; } // a Local LLM configuration, or none: not the direct transport
    if ((configuration.transport ?? 'direct') !== 'direct') { return undefined; }
    const envVar = directApiKeyEnvVar(section);
    if (env[envVar]) { return undefined; }
    return { envVar, profileId: profile.id, configurationId };
}

/** Why a send would fail, and the one thing that fixes it. */
export function missingApiKeyMessage(missing: MissingApiKey): string {
    return `Anthropic profile "${missing.profileId}" (configuration "${missing.configurationId}") uses the direct API, `
        + `and its key variable ${missing.envVar} is not set in this VS Code's environment: every send will fail. `
        + 'The key must be in the environment VS Code was launched with (on macOS e.g. `launchctl setenv` or a shell '
        + `that exports ${missing.envVar}), and VS Code must then be quit and started again — `
        + '"Developer: Reload Window" does not refresh the environment. Or use a profile on the Agent SDK transport.';
}

/** The label suffix the profile pickers show for such a profile. */
export const NO_API_KEY_LABEL = ' (no API key)';

export interface ProfileKeyState {
    id: string;
    name: string;
    isDefault: boolean;
    configurationId: string;
    /** The profile runs on the direct API and its key variable is unset: every send would fail. */
    noApiKey: boolean;
}

/** Every profile with an id, in order, each with whether it lacks its key — what the profile pickers list. */
export function profileKeyStates(
    section: AnthropicKeySection | undefined,
    env: Record<string, string | undefined>,
): ProfileKeyState[] {
    return (section?.profiles ?? [])
        .filter((p): p is NonNullable<typeof p> & { id: string } => !!p && typeof p.id === 'string' && p.id.length > 0)
        .map((p) => ({
            id: p.id,
            name: p.name || p.id,
            isDefault: p.isDefault === true,
            configurationId: p.configurationId || '',
            noApiKey: !!missingDirectApiKey(section, { profileId: p.id }, env),
        }));
}

/** What the direct transport throws when it has no key — the queue recognises it by this text. */
export const ANTHROPIC_CLIENT_UNAVAILABLE = 'Anthropic client not available — set the configured API key env var';

/** The failure text (an error's message, or a stage's error) is the direct transport finding no key. */
export function isMissingApiKeyFailure(text: string | undefined): boolean {
    return !!text && text.includes(ANTHROPIC_CLIENT_UNAVAILABLE);
}

/**
 * Why a stage on `target` must not be sent: its direct-API key is missing.
 * The text is the transport's own no-key failure plus the cause, so the queue
 * fails the stage the way it fails a send that found no key — at once, without
 * retry. Undefined when the stage may go (key set, or not the direct transport).
 */
export function stageKeyRefusal(
    section: AnthropicKeySection | undefined,
    target: { profileId?: string; configId?: string },
    env: Record<string, string | undefined>,
): string | undefined {
    const missing = missingDirectApiKey(section, target, env);
    return missing ? `${ANTHROPIC_CLIENT_UNAVAILABLE}: ${missingApiKeyMessage(missing)}` : undefined;
}

/**
 * What a queue item records when a send failed for a missing key: the causes
 * the queue found for its stages (one line each, from missingApiKeyMessage),
 * else the variable alone, and that the item is to be resent once the key is
 * there. A configuration error: retrying it cannot succeed.
 */
export function missingApiKeyFailureText(causes: readonly string[], envVar: string): string {
    const why = causes.length > 0
        ? causes.join('\n')
        : `The direct API key variable ${envVar} is not set in this VS Code's environment.`;
    return `Not sent: no API key. ${why}\nNot retried — it cannot succeed until the key is there. Set ${envVar} where VS Code is launched, `
        + 'quit and restart VS Code (a window reload keeps the old environment), then resend the item — or move it to an Agent SDK profile.';
}
