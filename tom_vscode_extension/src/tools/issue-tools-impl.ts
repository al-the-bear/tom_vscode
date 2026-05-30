/**
 * Pure impl half of `issue-tools.ts` — no vscode, no handler-graph
 * imports.  This separation exists for two reasons:
 *
 *   1. Tests can import this file without triggering the
 *      `issuesPanel-handler → handler_shared → vscode-bridge →
 *      handlers/index → chatPanel-handler → tool-executors` cycle,
 *      which spreads `ISSUE_TOOLS` before `issue-tools.ts` has
 *      finished evaluating.  Keeping the impls in their own module
 *      means the test's require chain never touches that graph.
 *   2. The `test-tools.ts` file in entry #30 will be able to share
 *      the same impl signatures with no live wiring.
 *
 * Types from `issueProvider.ts` and `issuesPanel-handler.ts` are
 * imported via `import type` so they are erased at runtime — no
 * actual module load happens.
 */

import type { IssueItem, IssueComment, IssueProvider } from '../handlers/issueProvider';
import type { IssuePanelConfig, PanelMode } from '../handlers/issuesPanel-handler';

// ===========================================================================
// Slims
// ===========================================================================

export function slimIssue(i: IssueItem): Record<string, unknown> {
    return {
        id: i.id,
        number: i.number,
        title: i.title,
        state: i.state,
        labels: i.labels,
        author: i.author?.name,
        createdAt: i.createdAt,
        updatedAt: i.updatedAt,
        commentCount: i.commentCount,
        url: i.url,
    };
}

export function slimComment(c: IssueComment): Record<string, unknown> {
    return {
        id: c.id,
        author: c.author?.name,
        createdAt: c.createdAt,
        updatedAt: c.updatedAt,
        body: c.body,
        url: c.url,
    };
}

// ===========================================================================
// Narrow dep
// ===========================================================================

export interface IssueAccess {
    getProvider(): IssueProvider | undefined;
    getPanelConfig(mode: PanelMode): IssuePanelConfig;
}

// ===========================================================================
// JSON envelopes
// ===========================================================================

function ok<T extends object>(extra: T): string { return JSON.stringify({ ok: true, ...extra }, null, 2); }
function err(message: string, extra: Record<string, unknown> = {}): string {
    return JSON.stringify({ ok: false, error: message, ...extra }, null, 2);
}

// ===========================================================================
// listReposForModeImpl
// ===========================================================================

export async function listReposForModeImpl(access: IssueAccess, mode: PanelMode): Promise<string> {
    try {
        const provider = access.getProvider();
        if (!provider) {
            return err('No issue provider registered.', { hint: 'Open the WS panel once to initialise.' });
        }
        let panelConfig: IssuePanelConfig;
        try { panelConfig = access.getPanelConfig(mode); }
        catch (e) { return err(`Failed to load panel config: ${(e as Error).message}`); }

        let discovered: Array<{ id: string; displayName: string }>;
        try {
            discovered = panelConfig.scanWorkspace ? provider.discoverRepos() : [];
        } catch (e) {
            return err(`discoverRepos failed: ${(e as Error).message}`);
        }

        const excluded = new Set(panelConfig.excludeRepos ?? []);
        const additional = (panelConfig.additionalRepos ?? []).map((id) => ({ id, displayName: id }));
        const combined = [...discovered, ...additional].filter((r) => !excluded.has(r.id));
        const unique = new Map<string, { id: string; displayName: string }>();
        for (const r of combined) { unique.set(r.id, r); }

        return ok({
            mode,
            providerId: provider.providerId,
            providerName: provider.displayName,
            scanWorkspace: panelConfig.scanWorkspace,
            count: unique.size,
            repos: Array.from(unique.values()),
            note: `Repos are the union of workspace-scanned (${panelConfig.scanWorkspace ? 'on' : 'off'}) + additionalRepos minus excludeRepos.`,
        });
    } catch (e) {
        return err(`listRepos failed: ${(e as Error).message}`);
    }
}

// ===========================================================================
// listItemsImpl
// ===========================================================================

export interface ListItemsInput {
    repoId: string;
    state?: string;
    query?: string;
    labels?: string[];
    maxResults?: number;
}

export async function listItemsImpl(access: IssueAccess, input: ListItemsInput): Promise<string> {
    try {
        const provider = access.getProvider();
        if (!provider) { return err('No issue provider registered.'); }
        if (!input.repoId || !input.repoId.trim()) { return err('`repoId` is required.'); }
        const state = input.state ?? 'open';
        const max = Math.max(1, input.maxResults ?? 100);
        const all = await provider.listIssues(input.repoId, state);
        const q = (input.query ?? '').toLowerCase();
        const labelSet = input.labels && input.labels.length > 0 ? new Set(input.labels) : undefined;
        const filtered = all.filter((i) => {
            if (q && !`${i.title} ${i.body ?? ''}`.toLowerCase().includes(q)) { return false; }
            if (labelSet && !i.labels.some((l) => labelSet.has(l))) { return false; }
            return true;
        });
        const slice = filtered.slice(0, max);
        return ok({
            repoId: input.repoId,
            state,
            totalMatches: filtered.length,
            returned: slice.length,
            truncated: filtered.length > slice.length,
            items: slice.map(slimIssue),
        });
    } catch (e) {
        return err(`listIssues failed: ${(e as Error).message}`);
    }
}

// ===========================================================================
// getItemImpl
// ===========================================================================

export interface GetItemInput {
    repoId: string;
    issueNumber: number;
    includeComments?: boolean;
}

export async function getItemImpl(access: IssueAccess, input: GetItemInput): Promise<string> {
    try {
        const provider = access.getProvider();
        if (!provider) { return err('No issue provider registered.'); }
        if (!input.repoId || !input.repoId.trim()) { return err('`repoId` is required.'); }
        if (typeof input.issueNumber !== 'number' || !Number.isInteger(input.issueNumber)) {
            return err('`issueNumber` must be an integer.');
        }
        const issue = await provider.getIssue(input.repoId, input.issueNumber);
        const slim = { ...slimIssue(issue), body: issue.body };
        const wantComments = input.includeComments === true;
        let comments: Array<Record<string, unknown>> | undefined;
        let commentsError: string | undefined;
        if (wantComments) {
            try {
                const list = await provider.listComments(input.repoId, input.issueNumber);
                comments = list.map(slimComment);
            } catch (e) {
                commentsError = (e as Error).message;
            }
        }
        return ok({
            ...slim,
            includeComments: wantComments,
            commentsFetched: wantComments && commentsError === undefined,
            comments: comments ?? null,
            commentsError: commentsError ?? null,
        });
    } catch (e) {
        return err(`getIssue failed: ${(e as Error).message}`);
    }
}

// ===========================================================================
// listCommentsImpl
// ===========================================================================

export interface ListCommentsInput {
    repoId: string;
    issueNumber: number;
}

export async function listCommentsImpl(access: IssueAccess, input: ListCommentsInput): Promise<string> {
    try {
        const provider = access.getProvider();
        if (!provider) { return err('No issue provider registered.'); }
        if (!input.repoId || !input.repoId.trim()) { return err('`repoId` is required.'); }
        if (typeof input.issueNumber !== 'number' || !Number.isInteger(input.issueNumber)) {
            return err('`issueNumber` must be an integer.');
        }
        const comments = await provider.listComments(input.repoId, input.issueNumber);
        return ok({
            repoId: input.repoId,
            issueNumber: input.issueNumber,
            count: comments.length,
            comments: comments.map(slimComment),
        });
    } catch (e) {
        return err(`listComments failed: ${(e as Error).message}`);
    }
}

// ===========================================================================
// createItemImpl
// ===========================================================================

export interface CreateItemInput {
    repoId: string;
    title: string;
    body?: string;
}

export async function createItemImpl(access: IssueAccess, input: CreateItemInput): Promise<string> {
    try {
        const provider = access.getProvider();
        if (!provider) { return err('No issue provider registered.'); }
        if (!input.repoId || !input.repoId.trim()) { return err('`repoId` is required.'); }
        if (!input.title || !input.title.trim()) { return err('`title` is required.'); }
        const issue = await provider.createIssue(input.repoId, input.title, input.body ?? '');
        return ok({ created: true, ...slimIssue(issue) });
    } catch (e) {
        return err(`createIssue failed: ${(e as Error).message}`);
    }
}

// ===========================================================================
// addCommentImpl
// ===========================================================================

export interface AddCommentInput {
    repoId: string;
    issueNumber: number;
    body: string;
}

export async function addCommentImpl(access: IssueAccess, input: AddCommentInput): Promise<string> {
    try {
        const provider = access.getProvider();
        if (!provider) { return err('No issue provider registered.'); }
        if (!input.repoId || !input.repoId.trim()) { return err('`repoId` is required.'); }
        if (typeof input.issueNumber !== 'number' || !Number.isInteger(input.issueNumber)) {
            return err('`issueNumber` must be an integer.');
        }
        if (!input.body || !input.body.trim()) { return err('`body` is required.'); }
        const comment = await provider.addComment(input.repoId, input.issueNumber, input.body);
        return ok({ added: true, ...slimComment(comment) });
    } catch (e) {
        return err(`addComment failed: ${(e as Error).message}`);
    }
}

// ===========================================================================
// setStatusImpl
// ===========================================================================

export interface SetStatusInput {
    repoId: string;
    issueNumber: number;
    status: string;
    mode: PanelMode;
}

export async function setStatusImpl(access: IssueAccess, input: SetStatusInput): Promise<string> {
    try {
        const provider = access.getProvider();
        if (!provider) { return err('No issue provider registered.'); }
        if (!input.repoId || !input.repoId.trim()) { return err('`repoId` is required.'); }
        if (typeof input.issueNumber !== 'number' || !Number.isInteger(input.issueNumber)) {
            return err('`issueNumber` must be an integer.');
        }
        if (!input.status || !input.status.trim()) { return err('`status` is required.'); }
        const panelConfig = access.getPanelConfig(input.mode);
        if (panelConfig.statuses.length > 0 && !panelConfig.statuses.includes(input.status)) {
            return err(`Status "${input.status}" is not in the configured statuses for the ${input.mode} panel.`, {
                allowed: panelConfig.statuses,
            });
        }
        const issue = await provider.changeStatus(input.repoId, input.issueNumber, input.status, panelConfig.statuses);
        return ok({ changed: true, ...slimIssue(issue) });
    } catch (e) {
        return err(`changeStatus failed: ${(e as Error).message}`);
    }
}

// ===========================================================================
// toggleLabelImpl
// ===========================================================================

export interface ToggleLabelInput {
    repoId: string;
    issueNumber: number;
    label: string;
}

export async function toggleLabelImpl(access: IssueAccess, input: ToggleLabelInput): Promise<string> {
    try {
        const provider = access.getProvider();
        if (!provider) { return err('No issue provider registered.'); }
        if (!input.repoId || !input.repoId.trim()) { return err('`repoId` is required.'); }
        if (typeof input.issueNumber !== 'number' || !Number.isInteger(input.issueNumber)) {
            return err('`issueNumber` must be an integer.');
        }
        if (!input.label || !input.label.trim()) { return err('`label` is required.'); }
        const issue = await provider.toggleLabel(input.repoId, input.issueNumber, input.label);
        return ok({ toggled: true, ...slimIssue(issue) });
    } catch (e) {
        return err(`toggleLabel failed: ${(e as Error).message}`);
    }
}
