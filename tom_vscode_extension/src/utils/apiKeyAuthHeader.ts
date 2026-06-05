/**
 * Pure helper for building the optional `Authorization` header used by the
 * Local LLM transports (both Ollama and OpenAI-compatible).
 *
 * `apiKeyEnv` names an environment variable — never the key itself. When it is
 * set and that variable holds a non-empty value, the request gets an
 * `Authorization: Bearer <value>` header. When `apiKeyEnv` is unset the call is
 * unauthenticated (the original behaviour). A configured-but-empty variable is
 * reported through the optional `onMissing` callback and treated as unset, so a
 * typo'd env name fails loud-ish rather than silently sending `Bearer undefined`.
 *
 * Kept free of `vscode`/`process`-channel dependencies so it can be unit
 * tested directly; the caller injects the environment and the log sink.
 */
export function apiKeyAuthHeader(
    apiKeyEnv: string | undefined,
    env: NodeJS.ProcessEnv = process.env,
    onMissing?: (name: string) => void,
): Record<string, string> {
    const name = apiKeyEnv?.trim();
    if (!name) {
        return {};
    }
    const value = env[name];
    if (!value) {
        onMissing?.(name);
        return {};
    }
    // eslint-disable-next-line @typescript-eslint/naming-convention
    return { Authorization: `Bearer ${value}` };
}
