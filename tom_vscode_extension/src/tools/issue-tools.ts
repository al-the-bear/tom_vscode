/**
 * Issue tools — read + write for the Issues subpanel in the WS bottom panel.
 *
 * Wraps the `IssueProvider` abstraction used by [issuesPanel-handler]. The
 * parallel set of test tools (`test-tools.ts`) re-uses the shared helpers
 * exported from here to avoid duplicating the executor logic.
 */

import { SharedToolDefinition } from './shared-tool-registry';
import { getDefaultProvider, IssueItem, IssueComment } from '../handlers/issueProvider';
import { loadPanelConfig, PanelMode } from '../handlers/issuesPanel-handler';

// ---------------------------------------------------------------------------
// Shared slims + helpers (re-used by test-tools.ts)
// ---------------------------------------------------------------------------

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

/**
 * List repositories configured for the given panel mode ('issues' | 'tests').
 * Combines:
 *  - workspace-discovered repos (if the panel config has scanWorkspace=true)
 *  - `additionalRepos` from the panel config
 *  - minus `excludeRepos`
 */
export async function listReposForMode(mode: PanelMode): Promise<string> {
    const provider = getDefaultProvider();
    if (!provider) {
        return JSON.stringify({ error: 'No issue provider registered. Open the WS panel once to initialise.' });
    }
    let panelConfig;
    try { panelConfig = loadPanelConfig(mode); }
    catch (err: any) { return JSON.stringify({ error: `Failed to load panel config: ${err?.message ?? err}` }); }

    let repos;
    try {
        repos = panelConfig.scanWorkspace ? provider.discoverRepos() : [];
    } catch (err: any) {
        return JSON.stringify({ error: `discoverRepos failed: ${err?.message ?? err}` });
    }

    const excluded = new Set(panelConfig.excludeRepos ?? []);
    const additional = (panelConfig.additionalRepos ?? []).map((id) => ({ id, displayName: id }));

    const combined = [...repos, ...additional].filter((r) => !excluded.has(r.id));
    const unique = new Map<string, { id: string; displayName: string }>();
    for (const r of combined) { unique.set(r.id, r); }

    return JSON.stringify({
        mode,
        providerId: provider.providerId,
        providerName: provider.displayName,
        count: unique.size,
        repos: Array.from(unique.values()),
    }, null, 2);
}

// ---------------------------------------------------------------------------
// Read executors (shared by issue + test tools)
// ---------------------------------------------------------------------------

export interface ListItemsInput {
    repoId: string;
    state?: string;
    query?: string;
    labels?: string[];
    maxResults?: number;
}

export async function executeListItems(input: ListItemsInput): Promise<string> {
    const provider = getDefaultProvider();
    if (!provider) { return JSON.stringify({ error: 'No issue provider registered.' }); }
    if (!input.repoId) { return JSON.stringify({ error: 'repoId is required.' }); }
    const state = input.state ?? 'open';
    const max = Math.max(1, input.maxResults ?? 100);
    try {
        const all = await provider.listIssues(input.repoId, state);
        const q = (input.query ?? '').toLowerCase();
        const labelSet = input.labels ? new Set(input.labels) : undefined;
        const filtered = all.filter((i) => {
            if (q && !(`${i.title} ${i.body ?? ''}`.toLowerCase().includes(q))) { return false; }
            if (labelSet && !i.labels.some((l) => labelSet.has(l))) { return false; }
            return true;
        });
        const slice = filtered.slice(0, max);
        return JSON.stringify({
            repoId: input.repoId,
            state,
            totalMatches: filtered.length,
            returned: slice.length,
            truncated: filtered.length > slice.length,
            items: slice.map(slimIssue),
        }, null, 2);
    } catch (err: any) {
        return JSON.stringify({ error: `listIssues failed: ${err?.message ?? err}` });
    }
}

export interface GetItemInput { repoId: string; issueNumber: number; includeComments?: boolean }

export async function executeGetItem(input: GetItemInput): Promise<string> {
    const provider = getDefaultProvider();
    if (!provider) { return JSON.stringify({ error: 'No issue provider registered.' }); }
    if (!input.repoId || typeof input.issueNumber !== 'number') {
        return JSON.stringify({ error: 'repoId and issueNumber are required.' });
    }
    try {
        const issue = await provider.getIssue(input.repoId, input.issueNumber);
        const result: Record<string, unknown> = { ...slimIssue(issue), body: issue.body };
        if (input.includeComments) {
            try {
                const comments = await provider.listComments(input.repoId, input.issueNumber);
                result.comments = comments.map(slimComment);
            } catch (err: any) {
                result.commentsError = err?.message ?? String(err);
            }
        }
        return JSON.stringify(result, null, 2);
    } catch (err: any) {
        return JSON.stringify({ error: `getIssue failed: ${err?.message ?? err}` });
    }
}

export interface ListCommentsInput { repoId: string; issueNumber: number }

export async function executeListComments(input: ListCommentsInput): Promise<string> {
    const provider = getDefaultProvider();
    if (!provider) { return JSON.stringify({ error: 'No issue provider registered.' }); }
    if (!input.repoId || typeof input.issueNumber !== 'number') {
        return JSON.stringify({ error: 'repoId and issueNumber are required.' });
    }
    try {
        const comments = await provider.listComments(input.repoId, input.issueNumber);
        return JSON.stringify({
            repoId: input.repoId,
            issueNumber: input.issueNumber,
            count: comments.length,
            comments: comments.map(slimComment),
        }, null, 2);
    } catch (err: any) {
        return JSON.stringify({ error: `listComments failed: ${err?.message ?? err}` });
    }
}

// ---------------------------------------------------------------------------
// Write executors (shared by issue + test tools)
// ---------------------------------------------------------------------------

export interface CreateItemInput { repoId: string; title: string; body?: string }

export async function executeCreateItem(input: CreateItemInput): Promise<string> {
    const provider = getDefaultProvider();
    if (!provider) { return JSON.stringify({ error: 'No issue provider registered.' }); }
    if (!input.repoId || !input.title) {
        return JSON.stringify({ error: 'repoId and title are required.' });
    }
    try {
        const issue = await provider.createIssue(input.repoId, input.title, input.body ?? '');
        return JSON.stringify({ success: true, ...slimIssue(issue) }, null, 2);
    } catch (err: any) {
        return JSON.stringify({ error: `createIssue failed: ${err?.message ?? err}` });
    }
}

export interface AddCommentInput { repoId: string; issueNumber: number; body: string }

export async function executeAddComment(input: AddCommentInput): Promise<string> {
    const provider = getDefaultProvider();
    if (!provider) { return JSON.stringify({ error: 'No issue provider registered.' }); }
    if (!input.repoId || typeof input.issueNumber !== 'number' || !input.body) {
        return JSON.stringify({ error: 'repoId, issueNumber and body are required.' });
    }
    try {
        const comment = await provider.addComment(input.repoId, input.issueNumber, input.body);
        return JSON.stringify({ success: true, ...slimComment(comment) }, null, 2);
    } catch (err: any) {
        return JSON.stringify({ error: `addComment failed: ${err?.message ?? err}` });
    }
}

export interface SetStatusInput { repoId: string; issueNumber: number; status: string; mode: PanelMode }

export async function executeSetStatus(input: SetStatusInput): Promise<string> {
    const provider = getDefaultProvider();
    if (!provider) { return JSON.stringify({ error: 'No issue provider registered.' }); }
    if (!input.repoId || typeof input.issueNumber !== 'number' || !input.status) {
        return JSON.stringify({ error: 'repoId, issueNumber and status are required.' });
    }
    try {
        const panelConfig = loadPanelConfig(input.mode);
        const issue = await provider.changeStatus(
            input.repoId, input.issueNumber, input.status, panelConfig.statuses,
        );
        return JSON.stringify({ success: true, ...slimIssue(issue) }, null, 2);
    } catch (err: any) {
        return JSON.stringify({ error: `changeStatus failed: ${err?.message ?? err}` });
    }
}

export interface ToggleLabelInput { repoId: string; issueNumber: number; label: string }

export async function executeToggleLabel(input: ToggleLabelInput): Promise<string> {
    const provider = getDefaultProvider();
    if (!provider) { return JSON.stringify({ error: 'No issue provider registered.' }); }
    if (!input.repoId || typeof input.issueNumber !== 'number' || !input.label) {
        return JSON.stringify({ error: 'repoId, issueNumber and label are required.' });
    }
    try {
        const issue = await provider.toggleLabel(input.repoId, input.issueNumber, input.label);
        return JSON.stringify({ success: true, ...slimIssue(issue) }, null, 2);
    } catch (err: any) {
        return JSON.stringify({ error: `toggleLabel failed: ${err?.message ?? err}` });
    }
}

// ---------------------------------------------------------------------------
// Issue tools
// ---------------------------------------------------------------------------

export const LIST_ISSUE_REPOS_TOOL: SharedToolDefinition<Record<string, never>> = {
    name: 'tomAi_listIssueRepos',
    displayName: 'List Issue Repos',
    description:
        'List the repositories the Issues subpanel scopes to (bottom-panel WS tab → Issues). ' +
        'Use for bug / feature / work-item tracking. For test-report repos call tomAi_listTestRepos instead.',
    tags: ['issues', 'workspace', 'tom-ai-chat'],
    readOnly: true,
    inputSchema: { type: 'object', properties: {} },
    execute: async () => listReposForMode('issues'),
};

export const LIST_ISSUES_TOOL: SharedToolDefinition<ListItemsInput> = {
    name: 'tomAi_listIssues',
    displayName: 'List Issues',
    description:
        'List issues (bugs / feature requests / tickets) in a repo. Filters: state (default "open"), substring query against title+body, label intersection, maxResults cap. ' +
        'Call tomAi_listIssueRepos first to get a repoId.',
    tags: ['issues', 'tom-ai-chat'],
    readOnly: true,
    inputSchema: {
        type: 'object',
        required: ['repoId'],
        properties: {
            repoId: { type: 'string', description: 'Repo id (e.g. "owner/repo" on GitHub).' },
            state: { type: 'string', description: 'Provider state filter (e.g. "open", "closed", "all"). Default "open".' },
            query: { type: 'string', description: 'Substring match against title + body (case-insensitive).' },
            labels: { type: 'array', items: { type: 'string' } },
            maxResults: { type: 'number', description: 'Max results. Default 100.' },
        },
    },
    execute: executeListItems,
};

export const GET_ISSUE_TOOL: SharedToolDefinition<GetItemInput> = {
    name: 'tomAi_getIssue',
    displayName: 'Get Issue',
    description: 'Fetch a single issue (bug / ticket) with body. Optionally include comments.',
    tags: ['issues', 'tom-ai-chat'],
    readOnly: true,
    inputSchema: {
        type: 'object',
        required: ['repoId', 'issueNumber'],
        properties: {
            repoId: { type: 'string' },
            issueNumber: { type: 'number' },
            includeComments: { type: 'boolean', description: 'Include comments. Default false.' },
        },
    },
    execute: executeGetItem,
};

export const LIST_ISSUE_COMMENTS_TOOL: SharedToolDefinition<ListCommentsInput> = {
    name: 'tomAi_listIssueComments',
    displayName: 'List Issue Comments',
    description: 'List comments on an issue.',
    tags: ['issues', 'tom-ai-chat'],
    readOnly: true,
    inputSchema: {
        type: 'object',
        required: ['repoId', 'issueNumber'],
        properties: {
            repoId: { type: 'string' },
            issueNumber: { type: 'number' },
        },
    },
    execute: executeListComments,
};

export const CREATE_ISSUE_TOOL: SharedToolDefinition<CreateItemInput> = {
    name: 'tomAi_createIssue',
    displayName: 'Create Issue',
    description: 'Create a new issue (bug / feature request / ticket) in a repo.',
    tags: ['issues', 'write', 'tom-ai-chat'],
    readOnly: false,
    requiresApproval: true,
    inputSchema: {
        type: 'object',
        required: ['repoId', 'title'],
        properties: {
            repoId: { type: 'string' },
            title: { type: 'string', description: 'Issue title.' },
            body: { type: 'string', description: 'Issue body (markdown). Optional.' },
        },
    },
    execute: executeCreateItem,
};

export const ADD_ISSUE_COMMENT_TOOL: SharedToolDefinition<AddCommentInput> = {
    name: 'tomAi_addIssueComment',
    displayName: 'Add Issue Comment',
    description: 'Add a comment to an issue.',
    tags: ['issues', 'write', 'tom-ai-chat'],
    readOnly: false,
    requiresApproval: true,
    inputSchema: {
        type: 'object',
        required: ['repoId', 'issueNumber', 'body'],
        properties: {
            repoId: { type: 'string' },
            issueNumber: { type: 'number' },
            body: { type: 'string' },
        },
    },
    execute: executeAddComment,
};

export const SET_ISSUE_STATUS_TOOL: SharedToolDefinition<Omit<SetStatusInput, 'mode'>> = {
    name: 'tomAi_setIssueStatus',
    displayName: 'Set Issue Status',
    description:
        'Change an issue\'s status. Valid statuses come from the Issues panel configuration ' +
        '(commonly "open", "in_triage", "assigned", "closed").',
    tags: ['issues', 'write', 'tom-ai-chat'],
    readOnly: false,
    requiresApproval: true,
    inputSchema: {
        type: 'object',
        required: ['repoId', 'issueNumber', 'status'],
        properties: {
            repoId: { type: 'string' },
            issueNumber: { type: 'number' },
            status: { type: 'string' },
        },
    },
    execute: (input) => executeSetStatus({ ...input, mode: 'issues' }),
};

export const TOGGLE_ISSUE_LABEL_TOOL: SharedToolDefinition<ToggleLabelInput> = {
    name: 'tomAi_toggleIssueLabel',
    displayName: 'Toggle Issue Label',
    description:
        'Toggle a label on an issue. For key=value labels (e.g. "quicklabel=Flaky"), toggling a new value replaces any existing value with the same key.',
    tags: ['issues', 'write', 'tom-ai-chat'],
    readOnly: false,
    requiresApproval: true,
    inputSchema: {
        type: 'object',
        required: ['repoId', 'issueNumber', 'label'],
        properties: {
            repoId: { type: 'string' },
            issueNumber: { type: 'number' },
            label: { type: 'string' },
        },
    },
    execute: executeToggleLabel,
};

// ---------------------------------------------------------------------------
// Master list
// ---------------------------------------------------------------------------

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export const ISSUE_TOOLS: SharedToolDefinition<any>[] = [
    LIST_ISSUE_REPOS_TOOL,
    LIST_ISSUES_TOOL,
    GET_ISSUE_TOOL,
    LIST_ISSUE_COMMENTS_TOOL,
    CREATE_ISSUE_TOOL,
    ADD_ISSUE_COMMENT_TOOL,
    SET_ISSUE_STATUS_TOOL,
    TOGGLE_ISSUE_LABEL_TOOL,
];
