/**
 * The role dropdown of the @CHAT ANTHROPIC/LLM subpanel (gsel6; design
 * `role_and_guideline_selector.vscode_extension.md`, R-3).
 *
 * - **The panel's role is its sends' item role.** A send from the subpanel
 *   runs as it (the role's tools, guidelines and `${role}`), ahead of the
 *   process step's role and the chat variable (utils/promptRole.ts). The
 *   chat variable `role` of the run is not touched.
 * - **Kept per window and quest** (workspaceState), sticky until changed.
 *   `''` is *Default role*: the send runs as the role it would without the
 *   panel (step, run default, chat variable). A role deleted meanwhile falls
 *   back to `''`.
 * - **Queued sends carry it:** a send queued with the panel's target (or
 *   because its session is busy) is a queue item with the panel's role and
 *   sticky guideline choices as its own.
 *
 * Pure (no vscode, no fs); tested in `__tests__/chatPanelRole.test.ts`.
 */

import type { QueueRoleSource } from './promptRole';

/** The workspaceState key of the subpanel's role in a quest. */
export function chatRoleKey(quest: string): string {
    return `tomAi.chatPanel.role.${quest || '(none)'}`;
}

/** The role the subpanel is on: the one it picked while the role exists, else `''` (*Default role*). */
export function effectiveChatRole(stored: unknown, roles: readonly string[]): string {
    if (typeof stored !== 'string') { return ''; }
    const name = stored.trim();
    return name !== '' && name !== 'default' && roles.includes(name) ? name : '';
}

/** The role a chat send runs as (`runWithQueueRole`); undefined with *Default role*. */
export function chatRoleSource(role: string, guidelines?: Record<string, string>): QueueRoleSource | undefined {
    if (!role) { return undefined; }
    return { itemRole: role, ...(guidelines && Object.keys(guidelines).length ? { itemGuidelines: { ...guidelines } } : {}) };
}

/** What a queued chat send carries as its own: the panel's role and sticky choices. */
export function chatQueueItemFields(role: string, guidelines: Record<string, string> | undefined): { role?: string; guidelines?: Record<string, string> } {
    return {
        ...(role ? { role } : {}),
        ...(guidelines && Object.keys(guidelines).length ? { guidelines: { ...guidelines } } : {}),
    };
}
