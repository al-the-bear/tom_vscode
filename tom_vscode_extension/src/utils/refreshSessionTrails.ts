/**
 * The list of session live trails a quest refresh reads.
 *
 * Every Anthropic session keeps its own live trail
 * (`history/sessions/<session>/live-trail.md`), so "read the live trail" no
 * longer names one file. The refresh reads the trails of every session written
 * since the last refresh, newest first; the service lists them
 * (`sessionLiveTrailsSince`) and this module puts that list into the refresh
 * prompt: in place of {@link REFRESH_SESSIONS_PLACEHOLDER} when the configured
 * prompt holds it, else appended, so a prompt written before the placeholder
 * still says where to read.
 *
 * vscode-free.
 */

/** Where the configured refresh prompt wants the list. */
export const REFRESH_SESSIONS_PLACEHOLDER = '${refreshSessions}';

export interface RefreshSessionTrail {
    session: string;
    /** Workspace-relative path of its live trail. */
    file: string;
    modified: Date;
}

/** The list as Markdown: one line per session, newest first, with the time it was last written. */
export function formatRefreshSessionTrails(trails: readonly RefreshSessionTrail[], since: Date | undefined): string {
    const scope = since
        ? `Session live trails written since the last refresh (${since.toISOString()}), newest first:`
        : 'Session live trails (no earlier refresh recorded on this host), newest first:';
    if (trails.length === 0) {
        return `${scope}\n\n- none: no session's live trail changed since then.`;
    }
    const lines = trails.map((t) => `- \`${t.session}\`: \`${t.file}\` (last written ${t.modified.toISOString()})`);
    return `${scope}\n\n${lines.join('\n')}`;
}

/** The refresh prompt with the list in place of the placeholder, or appended. */
export function applyRefreshSessionTrails(prompt: string, list: string): string {
    if (prompt.includes(REFRESH_SESSIONS_PLACEHOLDER)) {
        return prompt.split(REFRESH_SESSIONS_PLACEHOLDER).join(list);
    }
    return `${prompt}\n\n${list}`;
}
