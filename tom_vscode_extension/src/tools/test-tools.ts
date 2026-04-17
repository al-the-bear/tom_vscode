/**
 * Testkit tools — parallel to the issue tools but scoped to the Tests subpanel
 * in the bottom-panel WS tab.
 *
 * The underlying transport is identical (same `IssueProvider`), but the repos
 * are different (configured under `issuePanels.testkit` rather than
 * `issuePanels.issueKit`) and the semantics are different: items here are
 * **test reports / flaky-test tickets**, not product bugs.
 *
 * Two separate tool families exist so the model doesn't conflate "open a bug"
 * with "report a failing test". Executors are re-used from `issue-tools.ts`.
 */

import { SharedToolDefinition } from './shared-tool-registry';
import {
    listReposForMode,
    executeListItems,
    executeGetItem,
    executeListComments,
    executeCreateItem,
    executeAddComment,
    executeSetStatus,
    executeToggleLabel,
    ListItemsInput,
    GetItemInput,
    ListCommentsInput,
    CreateItemInput,
    AddCommentInput,
    SetStatusInput,
    ToggleLabelInput,
} from './issue-tools';

export const LIST_TEST_REPOS_TOOL: SharedToolDefinition<Record<string, never>> = {
    name: 'tomAi_listTestRepos',
    displayName: 'List Test Repos',
    description:
        'List the repositories the Tests (testkit) subpanel scopes to. ' +
        'For product bugs / tickets use tomAi_listIssueRepos instead.',
    tags: ['tests', 'workspace', 'tom-ai-chat'],
    readOnly: true,
    inputSchema: { type: 'object', properties: {} },
    execute: async () => listReposForMode('tests'),
};

export const LIST_TESTS_TOOL: SharedToolDefinition<ListItemsInput> = {
    name: 'tomAi_listTests',
    displayName: 'List Tests',
    description:
        'List test-kit items (test reports, flaky tests) in a repo. Filters: state, substring query, label intersection, maxResults. ' +
        'Call tomAi_listTestRepos first to get a repoId.',
    tags: ['tests', 'tom-ai-chat'],
    readOnly: true,
    inputSchema: {
        type: 'object',
        required: ['repoId'],
        properties: {
            repoId: { type: 'string' },
            state: { type: 'string', description: 'Provider state filter. Default "open".' },
            query: { type: 'string' },
            labels: { type: 'array', items: { type: 'string' } },
            maxResults: { type: 'number', description: 'Default 100.' },
        },
    },
    execute: executeListItems,
};

export const GET_TEST_TOOL: SharedToolDefinition<GetItemInput> = {
    name: 'tomAi_getTest',
    displayName: 'Get Test',
    description: 'Fetch a single test-kit item (test report) with body. Optionally include comments.',
    tags: ['tests', 'tom-ai-chat'],
    readOnly: true,
    inputSchema: {
        type: 'object',
        required: ['repoId', 'issueNumber'],
        properties: {
            repoId: { type: 'string' },
            issueNumber: { type: 'number' },
            includeComments: { type: 'boolean' },
        },
    },
    execute: executeGetItem,
};

export const LIST_TEST_COMMENTS_TOOL: SharedToolDefinition<ListCommentsInput> = {
    name: 'tomAi_listTestComments',
    displayName: 'List Test Comments',
    description: 'List comments on a test-kit item.',
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
    execute: executeListComments,
};

export const CREATE_TEST_TOOL: SharedToolDefinition<CreateItemInput> = {
    name: 'tomAi_createTest',
    displayName: 'Create Test Report',
    description: 'Create a new test-kit item (test report / flaky-test ticket) in a testkit-configured repo.',
    tags: ['tests', 'write', 'tom-ai-chat'],
    readOnly: false,
    requiresApproval: true,
    inputSchema: {
        type: 'object',
        required: ['repoId', 'title'],
        properties: {
            repoId: { type: 'string' },
            title: { type: 'string' },
            body: { type: 'string' },
        },
    },
    execute: executeCreateItem,
};

export const ADD_TEST_COMMENT_TOOL: SharedToolDefinition<AddCommentInput> = {
    name: 'tomAi_addTestComment',
    displayName: 'Add Test Comment',
    description: 'Add a comment to a test-kit item.',
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
    execute: executeAddComment,
};

export const SET_TEST_STATUS_TOOL: SharedToolDefinition<Omit<SetStatusInput, 'mode'>> = {
    name: 'tomAi_setTestStatus',
    displayName: 'Set Test Status',
    description:
        'Change a test-kit item\'s status. Valid statuses come from the Tests panel configuration.',
    tags: ['tests', 'write', 'tom-ai-chat'],
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
    execute: (input) => executeSetStatus({ ...input, mode: 'tests' }),
};

export const TOGGLE_TEST_LABEL_TOOL: SharedToolDefinition<ToggleLabelInput> = {
    name: 'tomAi_toggleTestLabel',
    displayName: 'Toggle Test Label',
    description:
        'Toggle a label on a test-kit item. For key=value labels (e.g. "quicklabel=Flaky"), toggling replaces any existing value with the same key.',
    tags: ['tests', 'write', 'tom-ai-chat'],
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
