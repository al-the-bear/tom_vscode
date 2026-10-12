/**
 * Why an Agent SDK attempt failed, in words the user can act on.
 *
 * When the Claude Code child process exits non-zero, the SDK throws
 * "Claude Code process exited with code 1" and nothing more. The cause has
 * usually already been said in the stream:
 *
 *  - an **assistant message with `error`** (`authentication_failed`,
 *    `billing_error`, `rate_limit`, …) whose text is the CLI's own sentence,
 *    e.g. "Failed to authenticate: OAuth session expired and could not be
 *    refreshed";
 *  - a **result with `is_error`**, whose `errors` (error subtypes) or `result`
 *    (subtype `success`) carry the text;
 *  - an **`auth_status` message with `error`**;
 *  - or, when nothing structured arrives, a line on the CLI's **stderr**.
 *
 * {@link FailureCauseCollector} records those while the attempt streams, and
 * {@link withFailureCause} turns the bare exit error into one that leads with
 * the cause. {@link isNonRetryableFailure} tells the retry loop which causes
 * cannot succeed until the user acts.
 *
 * Kept free of `vscode` and SDK imports so it runs under `node --test`.
 */

/** A failure cause: the SDK's error kind (or result subtype) and its text. */
export interface AgentSdkFailureCause {
    /**
     * The SDK's `SDKAssistantMessageError` value, a result error subtype
     * (`error_during_execution`, …), `error_result` for an `is_error` result
     * of subtype `success`, or `stderr` for a cause read from stderr alone.
     */
    kind: string;
    /** The human-readable text, scrubbed of credential-shaped strings. */
    detail: string;
}

/** How much of the CLI's stderr is kept: the most recent characters. */
export const STDERR_TAIL_LIMIT = 4096;

/**
 * Causes that cannot succeed until the user does something: sign in again,
 * fix billing, change the request or model. Retrying them immediately only
 * repeats the failure.
 */
const NON_RETRYABLE_KINDS = new Set([
    'authentication_failed',
    'oauth_org_not_allowed',
    'account_on_hold',
    'verification_required',
    'billing_error',
    'invalid_request',
    'model_not_found',
    'cloud_credential_error',
]);

/** Causes that are transient backend pressure: the busy backoff path. */
const BUSY_KINDS = new Set(['rate_limit', 'overloaded', 'server_error']);

const AUTH_ADVICE =
    'Sign in again: run /login in Claude Code, or re-authenticate the extension\'s Claude profile, then resend.';

const ADVICE: Record<string, string> = {
    // eslint-disable-next-line @typescript-eslint/naming-convention -- SDK error kind
    authentication_failed: AUTH_ADVICE,
    // eslint-disable-next-line @typescript-eslint/naming-convention -- SDK error kind
    cloud_credential_error: 'Check the cloud provider credentials the Claude profile uses, then resend.',
    // eslint-disable-next-line @typescript-eslint/naming-convention -- SDK error kind
    oauth_org_not_allowed: 'This organisation does not allow the login in use. Sign in with an allowed account, then resend.',
    // eslint-disable-next-line @typescript-eslint/naming-convention -- SDK error kind
    account_on_hold: 'The Anthropic account is on hold. Resolve it in the Anthropic console, then resend.',
    // eslint-disable-next-line @typescript-eslint/naming-convention -- SDK error kind
    verification_required: 'The account needs verification. Complete it in the Anthropic console, then resend.',
    // eslint-disable-next-line @typescript-eslint/naming-convention -- SDK error kind
    billing_error: 'Check the account\'s billing and credit balance, then resend.',
    // eslint-disable-next-line @typescript-eslint/naming-convention -- SDK error kind
    invalid_request: 'The request was rejected as invalid; resending it unchanged will fail again. Check the prompt, model and profile settings.',
    // eslint-disable-next-line @typescript-eslint/naming-convention -- SDK error kind
    model_not_found: 'The configured model is not available to this account. Choose another model in the Claude profile, then resend.',
};

/** What the user can do about a cause, or `undefined` when waiting is the answer. */
export function failureAdvice(kind: string): string | undefined {
    return ADVICE[kind];
}

export function isNonRetryableFailure(cause: AgentSdkFailureCause | undefined): boolean {
    return !!cause && NON_RETRYABLE_KINDS.has(cause.kind);
}

export function isBusyFailure(cause: AgentSdkFailureCause | undefined): boolean {
    return !!cause && BUSY_KINDS.has(cause.kind);
}

// ---------------------------------------------------------------------------
// Scrubbing
// ---------------------------------------------------------------------------

/**
 * Token-shaped strings. The SDK's own error text is safe; stderr is not, so
 * everything that leaves this module goes through {@link scrubSecrets}.
 */
const SECRET_PATTERNS: RegExp[] = [
    /\bsk-ant-[A-Za-z0-9_-]{8,}/g,                 // Anthropic API keys / OAuth tokens
    /\bgithub_pat_[A-Za-z0-9_]{20,}/g,             // GitHub fine-grained PATs
    /\bgh[pousr]_[A-Za-z0-9]{20,}/g,               // GitHub classic tokens
    /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/g, // JWTs
    /\b(Bearer)\s+[A-Za-z0-9._~+/=-]{16,}/gi,      // Authorization headers
    /\b([A-Za-z_]*(?:token|secret|key|password)[A-Za-z_]*)(\s*[=:]\s*)["']?[A-Za-z0-9._~+/=-]{16,}["']?/gi,
    /\b[A-Fa-f0-9]{32,}\b/g,                       // long hex strings
    // Long base64url-ish runs that contain a digit. `/` is left out so a file
    // path in a stack trace is not mistaken for a token.
    /\b(?=[A-Za-z0-9+_-]*\d)[A-Za-z0-9+_-]{40,}={0,2}/g,
];

export function scrubSecrets(text: string): string {
    let out = text;
    for (const pattern of SECRET_PATTERNS) {
        out = out.replace(pattern, (match, label?: unknown, sep?: unknown) => {
            if (typeof label === 'string' && /^bearer$/i.test(label)) { return `${label} [redacted]`; }
            if (typeof label === 'string' && typeof sep === 'string') { return `${label}${sep}[redacted]`; }
            return '[redacted]';
        });
    }
    return out;
}

// ---------------------------------------------------------------------------
// Collection
// ---------------------------------------------------------------------------

function textOfAssistant(msg: { message?: unknown }): string {
    const body = msg.message as { content?: unknown } | undefined;
    if (!body || !Array.isArray(body.content)) { return ''; }
    return (body.content as unknown[])
        .map((b) => (b && typeof b === 'object' && (b as { type?: unknown }).type === 'text'
            && typeof (b as { text?: unknown }).text === 'string' ? (b as { text: string }).text : ''))
        .join('')
        .trim();
}

/**
 * Records what an attempt's stream said about a failure. One per attempt;
 * feed it every SDK message ({@link observe}) and every stderr chunk
 * ({@link addStderr}).
 *
 * Precedence: the first structured cause wins over a later one of lower
 * specificity — an assistant `error` (which names the kind) is kept when the
 * CLI then also emits a generic `is_error` result for the same failure.
 */
export class FailureCauseCollector {
    private _cause: AgentSdkFailureCause | undefined;
    private _causeIsSpecific = false;
    private _stderr = '';

    get cause(): AgentSdkFailureCause | undefined { return this._cause; }

    /** The last {@link STDERR_TAIL_LIMIT} characters of stderr, scrubbed. */
    get stderrTail(): string { return scrubSecrets(this._stderr).slice(-STDERR_TAIL_LIMIT); }

    observe(msg: unknown): void {
        if (!msg || typeof msg !== 'object') { return; }
        const m = msg as { type?: unknown };
        switch (m.type) {
            case 'assistant': {
                const a = msg as { error?: unknown; message?: unknown };
                if (typeof a.error === 'string' && a.error) {
                    this.set({ kind: a.error, detail: textOfAssistant(a) || a.error }, true);
                }
                return;
            }
            case 'auth_status': {
                const s = msg as { error?: unknown };
                if (typeof s.error === 'string' && s.error) {
                    this.set({ kind: 'authentication_failed', detail: s.error }, true);
                }
                return;
            }
            case 'result': {
                // eslint-disable-next-line @typescript-eslint/naming-convention -- SDK wire field
                const r = msg as { is_error?: unknown; subtype?: unknown; errors?: unknown; result?: unknown };
                if (r.is_error !== true) { return; }
                const subtype = typeof r.subtype === 'string' ? r.subtype : '';
                const errors = Array.isArray(r.errors)
                    ? (r.errors as unknown[]).filter((e): e is string => typeof e === 'string' && e.length > 0)
                    : [];
                const resultText = typeof r.result === 'string' ? r.result.trim() : '';
                const kind = subtype && subtype !== 'success' ? subtype : 'error_result';
                const detail = errors.length > 0 ? errors.join('; ') : (resultText || kind);
                this.set({ kind, detail }, false);
                return;
            }
            default:
                return;
        }
    }

    addStderr(chunk: string): void {
        // Keep twice the limit raw so scrubbing a token cut at the boundary
        // still sees all of it; the exposed tail is trimmed after scrubbing.
        this._stderr = (this._stderr + chunk).slice(-STDERR_TAIL_LIMIT * 2);
    }

    private set(cause: AgentSdkFailureCause, specific: boolean): void {
        if (this._cause && this._causeIsSpecific) { return; }
        this._cause = { kind: cause.kind, detail: scrubSecrets(cause.detail) };
        this._causeIsSpecific = specific;
    }
}

// ---------------------------------------------------------------------------
// Wrapping
// ---------------------------------------------------------------------------

/** The exit error, rewritten to lead with what the stream said. */
export class AgentSdkFailureError extends Error {
    readonly failure: AgentSdkFailureCause;
    readonly nonRetryable: boolean;
    readonly originalError: unknown;

    constructor(failure: AgentSdkFailureCause, original: unknown) {
        const originalMessage = scrubSecrets(original instanceof Error ? original.message : String(original));
        const head = failure.kind === 'stderr'
            ? `Agent SDK failed: ${failure.detail}`
            : `Agent SDK failed: ${failure.kind} — ${failure.detail}`;
        const advice = failureAdvice(failure.kind);
        super(`${head} (${originalMessage})${advice ? ` ${advice}` : ''}`);
        this.name = 'AgentSdkFailureError';
        this.failure = failure;
        this.nonRetryable = NON_RETRYABLE_KINDS.has(failure.kind);
        this.originalError = original;
        // The live trail's ERROR block shows the stack: lead with the cause,
        // keep the SDK's stack as secondary detail.
        const originalStack = original instanceof Error && original.stack ? scrubSecrets(original.stack) : originalMessage;
        this.stack = `${this.name}: ${this.message}\n  caused by: ${originalStack}`;
    }
}

function lastLine(text: string): string | undefined {
    const lines = text.split(/\r?\n/).map((l) => l.trim()).filter((l) => l.length > 0);
    return lines.length > 0 ? lines[lines.length - 1] : undefined;
}

/**
 * Return `err` rewritten to lead with the collected cause. Without a
 * structured cause, the last non-empty stderr line stands in; with neither,
 * `err` is returned unchanged. A cancelled attempt is never rewritten: the
 * cancellation is the cause.
 */
export function withFailureCause(
    err: unknown,
    collector: FailureCauseCollector,
    opts: { cancelled?: boolean } = {},
): unknown {
    if (opts.cancelled === true || err instanceof AgentSdkFailureError) { return err; }
    const cause = collector.cause;
    if (cause) { return new AgentSdkFailureError(cause, err); }
    const stderrLine = lastLine(collector.stderrTail);
    if (stderrLine) { return new AgentSdkFailureError({ kind: 'stderr', detail: stderrLine }, err); }
    return err;
}

/** The cause carried by a thrown error, if it is one of ours. */
export function failureOf(err: unknown): AgentSdkFailureCause | undefined {
    return err instanceof AgentSdkFailureError ? err.failure : undefined;
}
