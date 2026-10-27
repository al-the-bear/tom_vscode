/**
 * The direct-API client, kept per key.
 *
 * The client used to be created once and kept until a Status Page edit reset
 * it, so a hand edit of `anthropic.apiKeyEnvVar` — or a key that went away —
 * was ignored until a reload, while the "(no API key)" marks and the queue's
 * missing-key warning read the variable afresh. Here the variable name and its
 * value are read on every call (both cheap), and the client is made again when
 * either changed; a missing key answers undefined, so the caller fails at once
 * the way the key check said it would.
 *
 * vscode-free; the client factory is passed in.
 */

export class KeyedClientCache<C> {
    private client: C | undefined;
    private envVar = '';
    private apiKey = '';

    constructor(private readonly create: (apiKey: string) => C) {}

    /** The client for the key in `env[envVar]`, made again when the name or the value changed; undefined without a key. */
    get(envVar: string, env: Readonly<Record<string, string | undefined>>): C | undefined {
        const apiKey = env[envVar];
        if (!apiKey) {
            this.reset();
            return undefined;
        }
        if (!this.client || envVar !== this.envVar || apiKey !== this.apiKey) {
            this.client = this.create(apiKey);
            this.envVar = envVar;
            this.apiKey = apiKey;
        }
        return this.client;
    }

    /** Forget the client; the next {@link get} makes a new one. */
    reset(): void {
        this.client = undefined;
        this.envVar = '';
        this.apiKey = '';
    }
}
