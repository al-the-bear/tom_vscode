/**
 * Pure process-wide arbiter for the Telegram getUpdates poller — the
 * single-poller model (qr5).
 *
 * Telegram allows exactly **one `getUpdates` consumer per bot token**. A second
 * consumer makes the API return 409 Conflict to whichever call is superseded,
 * so two pollers on the same token produce an alternating success/409 storm and
 * neither receives reliably. Within one extension host several collaborators can
 * resolve the *same* per-quest bot token and each try to start polling — most
 * commonly the standalone command poller and the send-only AI Conversation
 * channel. This registry makes "who owns the poll for this token" an explicit,
 * testable decision instead of an inline `Set` buried in the channel:
 *
 *   - {@link PollClaimRegistry.tryClaim} returns `true` for the first caller on
 *     a token (it now owns the single poll loop) and `false` for every later
 *     caller while the claim is held (they must defer — send-only, no polling).
 *   - {@link PollClaimRegistry.release} frees the token so a deferred caller (or
 *     the same one restarting) can take it over later.
 *
 * Kept free of `vscode` / I/O so it is unit-testable. `TelegramChannel` holds
 * one shared static instance across the host; tests can construct their own.
 */

/** A process-wide "one poll loop per bot token" claim arbiter. */
export class PollClaimRegistry {
    private readonly claimed = new Set<string>();

    /**
     * Attempt to claim the single poll loop for `token`.
     *
     * @returns `true` if the caller now owns the poll (the token was free);
     *          `false` if another holder already owns it (the caller must defer
     *          and not start a second `getUpdates` loop — the 409 source).
     */
    tryClaim(token: string): boolean {
        if (this.claimed.has(token)) { return false; }
        this.claimed.add(token);
        return true;
    }

    /** Release a previously claimed token so another caller can take it over. */
    release(token: string): void {
        this.claimed.delete(token);
    }

    /** Whether `token` is currently claimed by some holder in this host. */
    isClaimed(token: string): boolean {
        return this.claimed.has(token);
    }
}
