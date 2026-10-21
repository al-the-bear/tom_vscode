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

/** The key variable of the direct transport: `apiKeyEnvVar`, else `ANTHROPIC_API_KEY`. */
export function directApiKeyEnvVar(section: AnthropicKeySection | undefined): string {
    return section?.apiKeyEnvVar || 'ANTHROPIC_API_KEY';
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
