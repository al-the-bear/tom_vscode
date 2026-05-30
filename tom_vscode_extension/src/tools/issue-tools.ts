/**
 * Issue tools — read + write for the Issues subpanel in the WS bottom panel.
 *
 * The pure orchestration lives in `issue-tools-impl.ts` (vscode-free,
 * no handler-graph imports — tests load it standalone).  This file
 * wires the live `IssueAccess` bridge and exports the
 * `SharedToolDefinition`s for both the tool-executors registry and
 * `test-tools.ts` (which re-uses the same `execute*` wrappers).
 *
 * ## Coverage entry #29 refactor (audit notes)
 *
 *   - **Carve-out** introduced `IssueAccess` (narrow dep wrapping the
 *     provider + the panel-config loader); tests pass a fake.
 *   - **Mixed envelopes unified** to `{ok, ...}` / `{ok: false, error,
 *     ...}` across all 8 tools.
 *   - **Repo discovery surface** documented inline: `scanWorkspace`
 *     (provider auto-discovers via git remotes / equivalent) +
 *     `additionalRepos` − `excludeRepos`, all from the panel config.
 *   - **Status enum source** documented: from `panelConfig.statuses`;
 *     the tool now validates against the configured list BEFORE
 *     dispatch (was silently sent to the provider).
 *   - **Label semantics**: bare labels are on/off toggles; `key=value`
 *     labels are mutually exclusive within the same key.  Documented.
 *   - **Local-only vs github-backed**: the list-repos response
 *     includes `providerId` so the model can branch on backend
 *     capabilities.
 *   - **`getIssue` comments-fetch failure** is non-fatal — surfaced via
 *     `commentsFetched: false` + `commentsError`, was buried in the
 *     payload.
 *
 * See `issue-tools-impl.ts` for the orchestration logic.
 */

import { SharedToolDefinition } from './shared-tool-registry';
import { getDefaultProvider } from '../handlers/issueProvider';
import { loadPanelConfig, PanelMode } from '../handlers/issuesPanel-handler';

import {
    type IssueAccess,
    type ListItemsInput,
    type GetItemInput,
    type ListCommentsInput,
    type CreateItemInput,
    type AddCommentInput,
    type SetStatusInput,
    type ToggleLabelInput,
    listReposForModeImpl,
    listItemsImpl,
    getItemImpl,
    listCommentsImpl,
    createItemImpl,
    addCommentImpl,
    setStatusImpl,
    toggleLabelImpl,
} from './issue-tools-impl';

// Re-export types so callers (test-tools.ts, etc.) can keep importing
// from `./issue-tools` without changing every call site.
export type {
    IssueAccess,
    ListItemsInput,
    GetItemInput,
    ListCommentsInput,
    CreateItemInput,
    AddCommentInput,
    SetStatusInput,
    ToggleLabelInput,
} from './issue-tools-impl';

export { slimIssue, slimComment } from './issue-tools-impl';

// ===========================================================================
// Live access bridge
// ===========================================================================

/**
 * Live `IssueAccess` bridge — shared with `test-tools.ts` (re-exported
 * as `liveIssueAccess`) so both tool families talk to the same
 * provider + panel-config loader without each maintaining a copy.
 */
const liveAccess: IssueAccess = {
    getProvider: () => getDefaultProvider(),
    getPanelConfig: (mode) => loadPanelConfig(mode),
};

export const liveIssueAccess = liveAccess;

// Backward-compat live wrappers (test-tools.ts consumes these).
export function listReposForMode(mode: PanelMode): Promise<string> { return listReposForModeImpl(liveAccess, mode); }
export function executeListItems(input: ListItemsInput): Promise<string> { return listItemsImpl(liveAccess, input); }
export function executeGetItem(input: GetItemInput): Promise<string> { return getItemImpl(liveAccess, input); }
export function executeListComments(input: ListCommentsInput): Promise<string> { return listCommentsImpl(liveAccess, input); }
export function executeCreateItem(input: CreateItemInput): Promise<string> { return createItemImpl(liveAccess, input); }
export function executeAddComment(input: AddCommentInput): Promise<string> { return addCommentImpl(liveAccess, input); }
export function executeSetStatus(input: SetStatusInput): Promise<string> { return setStatusImpl(liveAccess, input); }
export function executeToggleLabel(input: ToggleLabelInput): Promise<string> { return toggleLabelImpl(liveAccess, input); }

// ===========================================================================
// Tool defs (descriptions tightened per a/b rows)
// ===========================================================================

export const LIST_ISSUE_REPOS_DESCRIPTION =
    'List the repositories the **Issues** subpanel scopes to. Repo set = ' +
    '`scanWorkspace` (provider auto-discovers via git remotes / equivalent; ' +
    'default ON for issues) + `additionalRepos` (manual config entries) − ' +
    '`excludeRepos`. Response includes `providerId` (e.g. `"github"`, ' +
    '`"local"`) so callers can branch on backend capabilities. **Repo id ' +
    'format is provider-specific** — GitHub: `owner/repo`; Jira: project ' +
    'key; local: freeform. For test-report repos call ' +
    '`tomAi_listTestRepos` instead.';

export const LIST_ISSUE_REPOS_TOOL: SharedToolDefinition<Record<string, never>> = {
    name: 'tomAi_listIssueRepos',
    displayName: 'List Issue Repos',
    description: LIST_ISSUE_REPOS_DESCRIPTION,
    tags: ['issues', 'workspace', 'tom-ai-chat'],
    readOnly: true,
    inputSchema: { type: 'object', properties: {} },
    execute: async () => listReposForModeImpl(liveAccess, 'issues'),
};

export const LIST_ISSUES_DESCRIPTION =
    'List issues (bugs / feature requests / tickets) in a repo. Filters: ' +
    '`state` (provider state filter; default `"open"`), `query` (case-' +
    'insensitive substring against `title + body`), `labels` (issue must ' +
    'have AT LEAST ONE of the supplied labels), `maxResults` (default 100). ' +
    'Response: `{ok, repoId, state, totalMatches, returned, truncated, ' +
    'items}` — `truncated: true` when more results were filtered than ' +
    'returned. Call `tomAi_listIssueRepos` first to get a `repoId`.';

export const LIST_ISSUES_TOOL: SharedToolDefinition<ListItemsInput> = {
    name: 'tomAi_listIssues',
    displayName: 'List Issues',
    description: LIST_ISSUES_DESCRIPTION,
    tags: ['issues', 'tom-ai-chat'],
    readOnly: true,
    inputSchema: {
        type: 'object',
        required: ['repoId'],
        properties: {
            repoId: { type: 'string', description: 'Repo id from `tomAi_listIssueRepos` (e.g. `"owner/repo"` on GitHub).' },
            state: { type: 'string', description: 'Provider state filter (e.g. `"open"`, `"closed"`, `"all"`). Default `"open"`.' },
            query: { type: 'string', description: 'Case-insensitive substring match against title + body.' },
            labels: { type: 'array', items: { type: 'string' }, description: 'Issue must have AT LEAST ONE of these labels.' },
            maxResults: { type: 'number', description: 'Max items returned. Default 100.' },
        },
    },
    execute: (input) => listItemsImpl(liveAccess, input),
};

export const GET_ISSUE_DESCRIPTION =
    'Fetch a single issue by `issueNumber` with its body. With ' +
    '`includeComments: true`, the response also carries `comments` and a ' +
    '`commentsFetched: boolean` flag — comment-fetch failure is non-fatal ' +
    'and surfaced via `commentsError` so the model can decide whether to ' +
    'retry the comment fetch separately via `tomAi_listIssueComments`.';

export const GET_ISSUE_TOOL: SharedToolDefinition<GetItemInput> = {
    name: 'tomAi_getIssue',
    displayName: 'Get Issue',
    description: GET_ISSUE_DESCRIPTION,
    tags: ['issues', 'tom-ai-chat'],
    readOnly: true,
    inputSchema: {
        type: 'object',
        required: ['repoId', 'issueNumber'],
        properties: {
            repoId: { type: 'string' },
            issueNumber: { type: 'number' },
            includeComments: { type: 'boolean', description: 'Include comments inline. Default false. Comment-fetch failure is non-fatal.' },
        },
    },
    execute: (input) => getItemImpl(liveAccess, input),
};

export const LIST_ISSUE_COMMENTS_TOOL: SharedToolDefinition<ListCommentsInput> = {
    name: 'tomAi_listIssueComments',
    displayName: 'List Issue Comments',
    description:
        'List all comments on an issue. Some providers (e.g. local) may not support comments and will return `ok: false` from the provider.',
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
    execute: (input) => listCommentsImpl(liveAccess, input),
};

export const CREATE_ISSUE_TOOL: SharedToolDefinition<CreateItemInput> = {
    name: 'tomAi_createIssue',
    displayName: 'Create Issue',
    description:
        'Create a new issue in a repo. Both `repoId` and `title` are required; `body` is optional markdown. Returns the created issue\'s slim shape + `{created: true}`.',
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
    execute: (input) => createItemImpl(liveAccess, input),
};

export const ADD_ISSUE_COMMENT_TOOL: SharedToolDefinition<AddCommentInput> = {
    name: 'tomAi_addIssueComment',
    displayName: 'Add Issue Comment',
    description: 'Add a comment to an issue. Blank bodies (whitespace-only) are rejected.',
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
    execute: (input) => addCommentImpl(liveAccess, input),
};

export const SET_ISSUE_STATUS_DESCRIPTION =
    'Change an issue\'s status. Valid statuses come from the Issues panel ' +
    'config (defaults: `open / in_triage / assigned / closed`). The tool ' +
    'validates the requested status against the configured list BEFORE ' +
    'dispatch — an out-of-list status returns `{ok: false, allowed: ' +
    '[...]}`. Providers may use provider-specific mappings (e.g. GitHub ' +
    'translates custom states to labels); the full configured list is ' +
    'forwarded to the provider so the mapping is consistent.';

export const SET_ISSUE_STATUS_TOOL: SharedToolDefinition<Omit<SetStatusInput, 'mode'>> = {
    name: 'tomAi_setIssueStatus',
    displayName: 'Set Issue Status',
    description: SET_ISSUE_STATUS_DESCRIPTION,
    tags: ['issues', 'write', 'tom-ai-chat'],
    readOnly: false,
    requiresApproval: true,
    inputSchema: {
        type: 'object',
        required: ['repoId', 'issueNumber', 'status'],
        properties: {
            repoId: { type: 'string' },
            issueNumber: { type: 'number' },
            status: { type: 'string', description: 'Status name from panel config. Validated against the configured list.' },
        },
    },
    execute: (input) => setStatusImpl(liveAccess, { ...input, mode: 'issues' }),
};

export const TOGGLE_ISSUE_LABEL_DESCRIPTION =
    'Toggle a label on an issue. **Label semantics**: bare labels (e.g. ' +
    '`bug`, `wontfix`) are simple on/off toggles. **`key=value` labels** ' +
    '(e.g. `quicklabel=Flaky`) are mutually exclusive within the same key — ' +
    'toggling a new value (`quicklabel=Regression`) REPLACES the existing ' +
    'value with the same key, not just adds/removes. The configured labels ' +
    'live in the Issues panel config\'s `labels` list.';

export const TOGGLE_ISSUE_LABEL_TOOL: SharedToolDefinition<ToggleLabelInput> = {
    name: 'tomAi_toggleIssueLabel',
    displayName: 'Toggle Issue Label',
    description: TOGGLE_ISSUE_LABEL_DESCRIPTION,
    tags: ['issues', 'write', 'tom-ai-chat'],
    readOnly: false,
    requiresApproval: true,
    inputSchema: {
        type: 'object',
        required: ['repoId', 'issueNumber', 'label'],
        properties: {
            repoId: { type: 'string' },
            issueNumber: { type: 'number' },
            label: { type: 'string', description: 'Label name. For `key=value` labels, toggling a new value replaces any existing value with the same key.' },
        },
    },
    execute: (input) => toggleLabelImpl(liveAccess, input),
};

// ===========================================================================
// Master list
// ===========================================================================

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
