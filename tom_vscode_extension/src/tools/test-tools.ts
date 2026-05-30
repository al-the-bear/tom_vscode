/**
 * Testkit tools — parallel to the issue tools but scoped to the
 * **Tests subpanel** in the bottom-panel WS tab.
 *
 * Same underlying `IssueProvider` transport, but a different panel
 * config (registered under `issuePanels.testkit` vs `issuePanels.
 * issueKit`) and different semantics: items here are **test reports /
 * flaky-test tickets**, not product bugs.  Two separate tool families
 * exist so the model doesn't conflate "open a bug" with "report a
 * failing test".
 *
 * ## Coverage entry #30 refactor (audit notes)
 *
 *   - Old impl re-used `executeListItems` / `executeGetItem` / … from
 *     `issue-tools.ts` (the live wrappers).  This entry switches to
 *     direct `*Impl(access, input)` calls into `issue-tools-impl.ts`
 *     so the tools share the same vscode-free orchestration that
 *     entry #29 tested.
 *   - **Descriptions tightened**:
 *       - Every description opens with "test reports / flaky-test
 *         tickets, NOT product bugs" to keep the model from
 *         conflating the two surfaces.
 *       - `tomAi_listTestRepos` documents the **`scanWorkspace`
 *         default OFF** for the tests panel (vs ON for issues) —
 *         repos are typically driven entirely by `additionalRepos`.
 *       - `tomAi_setTestStatus` documents the status enum source
 *         is the **`testkit` panel config** (distinct from the
 *         `issueKit` panel — they can have different status lists).
 *   - **Envelopes** automatically inherit the `{ok, ...}` shape from
 *     the impl layer (was a mix of `{success, ...}` and `{error}`).
 *
 * The live `IssueAccess` bridge is shared with `issue-tools.ts`
 * (re-exported as `liveIssueAccess` so this file doesn't need its
 * own copy).
 */

import { SharedToolDefinition } from './shared-tool-registry';
import { liveIssueAccess } from './issue-tools';
import {
    type ListItemsInput,
    type GetItemInput,
    type ListCommentsInput,
    type CreateItemInput,
    type AddCommentInput,
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

export const LIST_TEST_REPOS_DESCRIPTION =
    'List the repositories the **Tests (testkit) subpanel** scopes to. ' +
    '**Test reports / flaky-test tickets, NOT product bugs** — for product ' +
    'bugs / tickets call `tomAi_listIssueRepos`. Repo set = `scanWorkspace` ' +
    '(provider auto-discovers via git remotes; **default OFF** for the ' +
    'tests panel, unlike the issues panel) + `additionalRepos` − ' +
    '`excludeRepos`, all from the testkit panel config. Response includes ' +
    '`providerId` so callers can branch on backend capabilities.';

export const LIST_TEST_REPOS_TOOL: SharedToolDefinition<Record<string, never>> = {
    name: 'tomAi_listTestRepos',
    displayName: 'List Test Repos',
    description: LIST_TEST_REPOS_DESCRIPTION,
    tags: ['tests', 'workspace', 'tom-ai-chat'],
    readOnly: true,
    inputSchema: { type: 'object', properties: {} },
    execute: async () => listReposForModeImpl(liveIssueAccess, 'tests'),
};

export const LIST_TESTS_DESCRIPTION =
    'List test-kit items (test reports, flaky tests) in a repo. ' +
    '**Test reports, NOT product bugs** — use `tomAi_listIssues` for those. ' +
    'Filters: `state` (default `"open"`), `query` (case-insensitive ' +
    'substring against title + body), `labels` (item must have AT LEAST ' +
    'ONE), `maxResults` (default 100). Call `tomAi_listTestRepos` first ' +
    'to get a `repoId`.';

export const LIST_TESTS_TOOL: SharedToolDefinition<ListItemsInput> = {
    name: 'tomAi_listTests',
    displayName: 'List Tests',
    description: LIST_TESTS_DESCRIPTION,
    tags: ['tests', 'tom-ai-chat'],
    readOnly: true,
    inputSchema: {
        type: 'object',
        required: ['repoId'],
        properties: {
            repoId: { type: 'string', description: 'Repo id from `tomAi_listTestRepos`.' },
            state: { type: 'string', description: 'Provider state filter (e.g. `"open"`, `"closed"`, `"all"`). Default `"open"`.' },
            query: { type: 'string', description: 'Case-insensitive substring match against title + body.' },
            labels: { type: 'array', items: { type: 'string' }, description: 'Item must have AT LEAST ONE of these labels.' },
            maxResults: { type: 'number', description: 'Max items returned. Default 100.' },
        },
    },
    execute: (input) => listItemsImpl(liveIssueAccess, input),
};

export const GET_TEST_TOOL: SharedToolDefinition<GetItemInput> = {
    name: 'tomAi_getTest',
    displayName: 'Get Test',
    description:
        'Fetch a single test-kit item (test report) by `issueNumber` with its body. **NOT a product bug** — for those use `tomAi_getIssue`. With `includeComments: true`, comments are fetched inline; comment-fetch failure is non-fatal and surfaced via `commentsError`.',
    tags: ['tests', 'tom-ai-chat'],
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
    execute: (input) => getItemImpl(liveIssueAccess, input),
};

export const LIST_TEST_COMMENTS_TOOL: SharedToolDefinition<ListCommentsInput> = {
    name: 'tomAi_listTestComments',
    displayName: 'List Test Comments',
    description: 'List all comments on a test-kit item. Some providers may not support comments.',
    tags: ['tests', 'tom-ai-chat'],
    readOnly: true,
    inputSchema: {
        type: 'object',
        required: ['repoId', 'issueNumber'],
        properties: {
            repoId: { type: 'string' },
            issueNumber: { type: 'number' },
        },
    },
    execute: (input) => listCommentsImpl(liveIssueAccess, input),
};

export const CREATE_TEST_TOOL: SharedToolDefinition<CreateItemInput> = {
    name: 'tomAi_createTest',
    displayName: 'Create Test Report',
    description:
        'Create a new test-kit item (test report / flaky-test ticket) in a testkit-configured repo. **For a product bug** use `tomAi_createIssue` instead.',
    tags: ['tests', 'write', 'tom-ai-chat'],
    readOnly: false,
    requiresApproval: true,
    inputSchema: {
        type: 'object',
        required: ['repoId', 'title'],
        properties: {
            repoId: { type: 'string' },
            title: { type: 'string', description: 'Test-report title (e.g. "Flaky: parser test/123").' },
            body: { type: 'string', description: 'Body (markdown). Optional.' },
        },
    },
    execute: (input) => createItemImpl(liveIssueAccess, input),
};

export const ADD_TEST_COMMENT_TOOL: SharedToolDefinition<AddCommentInput> = {
    name: 'tomAi_addTestComment',
    displayName: 'Add Test Comment',
    description: 'Add a comment to a test-kit item. Blank bodies (whitespace-only) are rejected.',
    tags: ['tests', 'write', 'tom-ai-chat'],
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
    execute: (input) => addCommentImpl(liveIssueAccess, input),
};

export const SET_TEST_STATUS_DESCRIPTION =
    'Change a test-kit item\'s status. Valid statuses come from the ' +
    '**testkit panel config** — DISTINCT from the issueKit panel config; ' +
    'a status that\'s valid for issues may not be valid for tests (and ' +
    'vice versa). Out-of-list status returns `{ok: false, allowed: [...]}`.';

export const SET_TEST_STATUS_TOOL: SharedToolDefinition<Omit<{ repoId: string; issueNumber: number; status: string }, never>> = {
    name: 'tomAi_setTestStatus',
    displayName: 'Set Test Status',
    description: SET_TEST_STATUS_DESCRIPTION,
    tags: ['tests', 'write', 'tom-ai-chat'],
    readOnly: false,
    requiresApproval: true,
    inputSchema: {
        type: 'object',
        required: ['repoId', 'issueNumber', 'status'],
        properties: {
            repoId: { type: 'string' },
            issueNumber: { type: 'number' },
            status: { type: 'string', description: 'Status name from the testkit panel config. Validated against the configured list.' },
        },
    },
    execute: (input) => setStatusImpl(liveIssueAccess, { ...input, mode: 'tests' }),
};

export const TOGGLE_TEST_LABEL_TOOL: SharedToolDefinition<ToggleLabelInput> = {
    name: 'tomAi_toggleTestLabel',
    displayName: 'Toggle Test Label',
    description:
        'Toggle a label on a test-kit item. **Label semantics**: bare labels (e.g. `flaky`) are simple on/off toggles. `key=value` labels (e.g. `quicklabel=Flaky`) are mutually exclusive within the same key — toggling a new value REPLACES any existing value with the same key. Configured labels live in the testkit panel config\'s `labels` list.',
    tags: ['tests', 'write', 'tom-ai-chat'],
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
    execute: (input) => toggleLabelImpl(liveIssueAccess, input),
};

// ===========================================================================
// Master list
// ===========================================================================

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export const TEST_TOOLS: SharedToolDefinition<any>[] = [
    LIST_TEST_REPOS_TOOL,
    LIST_TESTS_TOOL,
    GET_TEST_TOOL,
    LIST_TEST_COMMENTS_TOOL,
    CREATE_TEST_TOOL,
    ADD_TEST_COMMENT_TOOL,
    SET_TEST_STATUS_TOOL,
    TOGGLE_TEST_LABEL_TOOL,
];
