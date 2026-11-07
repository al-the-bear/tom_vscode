/**
 * Who wrote a review annotation, as far as agents are concerned — pure.
 *
 * An agent signs what it writes into a reviewed document (comment blocks,
 * change comments, attribution tokens) as `agent_<role>`, the role it works in
 * (`agent` without one). The underscore form, not `agent:<role>`: the TomSpecs
 * runtime takes review member ids as `[a-z0-9_]+` only (attribution tokens,
 * answer authors), and one form everywhere keeps the MD Browser's filter by
 * author simple. A hand-written `agent:<role>` is still recognised as an
 * agent's.
 *
 * The marker `___check here___` flags a section or comment that especially
 * needs the reviewer's eye; an agent that sets it says why in the comment.
 */

/** The marker of an especially important section or comment. */
export const CHECK_HERE_MARKER = '___check here___';

/** The author id an agent working in `role` signs with: `agent_<role>`, the role lower-cased to `[a-z0-9_]`. */
export function agentAuthorId(role: string | undefined): string {
    const slug = String(role ?? '')
        .trim()
        .toLowerCase()
        .replace(/[^a-z0-9_]+/g, '_')
        .replace(/^_+|_+$/g, '');
    return slug ? `agent_${slug}` : 'agent';
}

/** Whether `author` is an agent's (`agent`, `agent_<role>` or `agent:<role>`). */
export function isAgentAuthor(author: string | undefined | null): boolean {
    return /^agent(?:[_:].+)?$/i.test(String(author ?? '').trim());
}
