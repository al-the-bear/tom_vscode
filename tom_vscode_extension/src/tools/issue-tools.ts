/**
 * Issue / test-kit tools.
 *
 * Wraps the `IssueProvider` abstraction (see `src/handlers/issueProvider.ts`)
 * so an LLM can read issues and test-run items from the bottom-panel WS tab.
 *
 * Both the Issues panel and the Tests panel use the same provider (default:
 * GitHub) — they only differ in which repos they surface in the UI dropdown.
 */

import { SharedToolDefinition } from './shared-tool-registry';
import { getDefaultProvider, IssueItem, IssueComment } from '../handlers/issueProvider';

function slimIssue(i: IssueItem): Record<string, unknown> {
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

function slimComment(c: IssueComment): Record<string, unknown> {
    return {
        id: c.id,
        author: c.author?.name,
        createdAt: c.createdAt,
        updatedAt: c.updatedAt,
        body: c.body,
        url: c.url,
    };
}

// ---------------------------------------------------------------------------
// tomAi_listIssueRepos
// ---------------------------------------------------------------------------

interface ListIssueReposInput {
    // no params
}

async function executeListIssueRepos(_input: ListIssueReposInput): Promise<string> {
    const provider = getDefaultProvider();
    if (!provider) {
        return JSON.stringify({ error: 'No issue provider registered. Open the Issues panel once to initialise.' });
    }
    try {
        const repos = provider.discoverRepos();
        return JSON.stringify({
            providerId: provider.providerId,
            providerName: provider.displayName,
            count: repos.length,
            repos,
        }, null, 2);
    } catch (err: any) {
        return JSON.stringify({ error: `discoverRepos failed: ${err?.message ?? err}` });
    }
}

export const LIST_ISSUE_REPOS_TOOL: SharedToolDefinition<ListIssueReposInput> = {
    name: 'tomAi_listIssueRepos',
    displayName: 'List Issue Repos',
    description:
        'List the repositories / projects the Issues panel has discovered in the current workspace.',
    tags: ['issues', 'workspace', 'tom-ai-chat'],
    readOnly: true,
    inputSchema: { type: 'object', properties: {} },
    execute: executeListIssueRepos,
};

// ---------------------------------------------------------------------------
// tomAi_listIssues
// ---------------------------------------------------------------------------

interface ListIssuesInput {
    repoId: string;
    state?: string;
    query?: string;
    labels?: string[];
    maxResults?: number;
}

async function executeListIssues(input: ListIssuesInput): Promise<string> {
    const provider = getDefaultProvider();
    if (!provider) { return JSON.stringify({ error: 'No issue provider registered.' }); }
    if (!input.repoId) { return JSON.stringify({ error: 'repoId is required. Call tomAi_listIssueRepos first.' }); }
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
            issues: slice.map(slimIssue),
        }, null, 2);
    } catch (err: any) {
        return JSON.stringify({ error: `listIssues failed: ${err?.message ?? err}` });
    }
}

export const LIST_ISSUES_TOOL: SharedToolDefinition<ListIssuesInput> = {
    name: 'tomAi_listIssues',
    displayName: 'List Issues',
    description:
        'List issues / test-kit items for a repo. Optional substring query, label filter, and state (default "open"). ' +
        'Call tomAi_listIssueRepos first to get a repoId.',
    tags: ['issues', 'tests', 'tom-ai-chat'],
    readOnly: true,
    inputSchema: {
        type: 'object',
        required: ['repoId'],
        properties: {
            repoId: { type: 'string', description: 'Repo id (e.g. "owner/repo" on GitHub).' },
            state: { type: 'string', description: 'Issue state filter (provider-specific, e.g. "open", "closed", "all"). Default "open".' },
            query: { type: 'string', description: 'Substring filter against title+body (case-insensitive).' },
            labels: { type: 'array', items: { type: 'string' }, description: 'Only include issues having any of these labels.' },
            maxResults: { type: 'number', description: 'Max issues returned. Default 100.' },
        },
    },
    execute: executeListIssues,
};

// ---------------------------------------------------------------------------
// tomAi_getIssue
// ---------------------------------------------------------------------------

interface GetIssueInput {
    repoId: string;
    issueNumber: number;
    includeComments?: boolean;
}

async function executeGetIssue(input: GetIssueInput): Promise<string> {
    const provider = getDefaultProvider();
    if (!provider) { return JSON.stringify({ error: 'No issue provider registered.' }); }
    if (!input.repoId) { return JSON.stringify({ error: 'repoId is required' }); }
    if (typeof input.issueNumber !== 'number') { return JSON.stringify({ error: 'issueNumber is required' }); }
    try {
        const issue = await provider.getIssue(input.repoId, input.issueNumber);
        const result: Record<string, unknown> = {
            ...slimIssue(issue),
            body: issue.body,
        };
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

export const GET_ISSUE_TOOL: SharedToolDefinition<GetIssueInput> = {
    name: 'tomAi_getIssue',
    displayName: 'Get Issue',
    description:
        'Fetch a single issue / test-kit item (with body). Set includeComments=true to also fetch comments.',
    tags: ['issues', 'tests', 'tom-ai-chat'],
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
    execute: executeGetIssue,
};

// ---------------------------------------------------------------------------
// tomAi_listIssueComments
// ---------------------------------------------------------------------------

interface ListIssueCommentsInput { repoId: string; issueNumber: number }

async function executeListIssueComments(input: ListIssueCommentsInput): Promise<string> {
    const provider = getDefaultProvider();
    if (!provider) { return JSON.stringify({ error: 'No issue provider registered.' }); }
    if (!input.repoId || typeof input.issueNumber !== 'number') {
        return JSON.stringify({ error: 'repoId and issueNumber are required' });
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

export const LIST_ISSUE_COMMENTS_TOOL: SharedToolDefinition<ListIssueCommentsInput> = {
    name: 'tomAi_listIssueComments',
    displayName: 'List Issue Comments',
    description: 'List comments on an issue / test-kit item.',
    tags: ['issues', 'tests', 'tom-ai-chat'],
    readOnly: true,
    inputSchema: {
        type: 'object',
        required: ['repoId', 'issueNumber'],
        properties: {
            repoId: { type: 'string' },
            issueNumber: { type: 'number' },
        },
    },
    execute: executeListIssueComments,
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
];
