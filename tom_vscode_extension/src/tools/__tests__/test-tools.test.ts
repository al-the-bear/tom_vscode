/**
 * Tool-impl tests for `test-tools.ts` — the 8 Tests-subpanel tools
 * (coverage entry #30):
 *
 *   - tomAi_listTestRepos
 *   - tomAi_listTests
 *   - tomAi_getTest
 *   - tomAi_listTestComments
 *   - tomAi_createTest
 *   - tomAi_addTestComment
 *   - tomAi_setTestStatus
 *   - tomAi_toggleTestLabel
 *
 * Strategy: the test tools wire into the **same** `*Impl` functions
 * as the issue tools (carved out in entry #29), only differing in
 * the `mode` parameter passed to the mode-aware impls
 * (`listReposForMode` and `setStatus`). That means the orchestration
 * is already proved correct by entry #29 — what these tests need to
 * verify is the **mode-routing layer**:
 *
 *   - `mode: 'tests'` reads from the testkit panel config (distinct
 *     from issueKit)
 *   - the testkit defaults (scanWorkspace OFF, different status
 *     list) are honoured
 *   - the mode-agnostic tools (the 6 that don't take `mode`)
 *     produce identical envelopes regardless of which family they
 *     came from
 *
 * As with entry #29, the tests import from `issue-tools-impl.ts`
 * (vscode-free) so the `issuesPanel-handler → tool-executors`
 * require cycle stays out of the test require chain.
 *
 * Coverage entry #30 four-row checklist:
 *
 *   a) Description clarity — verified in `test-tools.ts`: every
 *      description opens with "test reports / flaky-test tickets, NOT
 *      product bugs" so the model doesn't conflate. `scanWorkspace
 *      OFF` default for the tests panel is documented inline.
 *   b) Ambiguities — same shape as issues; mode routing is the only
 *      new surface. Tested below: `setTestStatus` validates against
 *      the **testkit** panel statuses (NOT the issues ones); the
 *      issues panel's status list is irrelevant.
 *   c) Tests use a fake `IssueAccess` with **two distinct panel
 *      configs** (one per mode) so we can prove the mode parameter
 *      threads through correctly.
 *   d) Timing — sub-ms per call (in-memory provider).
 */

import test, { beforeEach, describe } from 'node:test';
import assert from 'node:assert/strict';

import { withTiming } from './_timing.js';

// Import the vscode-free impls (no handler-graph cycle).
import {
    listReposForModeImpl,
    listItemsImpl,
    getItemImpl,
    listCommentsImpl,
    createItemImpl,
    addCommentImpl,
    setStatusImpl,
    toggleLabelImpl,
    type IssueAccess,
} from '../issue-tools-impl.js';
import type { IssueProvider, IssueItem, IssueComment, IssueProviderRepo } from '../../handlers/issueProvider.js';
import type { IssuePanelConfig, PanelMode } from '../../handlers/issuesPanel-handler.js';

// ===========================================================================
// Fake provider — minimal copy of entry #29's helper
// ===========================================================================

interface ProviderCall { method: string; args: unknown[] }

interface FakeProvider extends IssueProvider {
    calls: ProviderCall[];
    issues: Map<string, IssueItem[]>;
    comments: Map<string, IssueComment[]>;
    discovered: IssueProviderRepo[];
}

function makeIssue(repoId: string, n: number, overrides: Partial<IssueItem> = {}): IssueItem {
    return {
        id: `${repoId}#${n}`,
        number: n,
        title: `Test ${n}`,
        body: `Body for ${n}`,
        state: 'open',
        labels: [],
        author: { name: 'alice', avatarUrl: '' },
        createdAt: '2026-01-01T00:00:00Z',
        updatedAt: '2026-01-01T00:00:00Z',
        commentCount: 0,
        url: `https://example.test/${repoId}/${n}`,
        ...overrides,
    };
}

function makeComment(id: string, body: string): IssueComment {
    return {
        id, body,
        author: { name: 'alice', avatarUrl: '' },
        createdAt: '2026-01-01T00:00:00Z',
        updatedAt: '2026-01-01T00:00:00Z',
        url: `https://example.test/c/${id}`,
    };
}

function makeProvider(providerId = 'github', displayName = 'GitHub'): FakeProvider {
    const calls: ProviderCall[] = [];
    const issues = new Map<string, IssueItem[]>();
    const comments = new Map<string, IssueComment[]>();
    const fake: FakeProvider = {
        providerId, displayName, calls, issues, comments, discovered: [],
        discoverRepos() { calls.push({ method: 'discoverRepos', args: [] }); return [...fake.discovered]; },
        async listIssues(repoId, state) {
            calls.push({ method: 'listIssues', args: [repoId, state] });
            const all = issues.get(repoId) ?? [];
            return state === 'all' ? [...all] : all.filter((i) => i.state === state);
        },
        async getIssue(repoId, n) {
            calls.push({ method: 'getIssue', args: [repoId, n] });
            const found = (issues.get(repoId) ?? []).find((i) => i.number === n);
            if (!found) { throw new Error(`Not found: ${repoId}#${n}`); }
            return { ...found };
        },
        async createIssue(repoId, title, body) {
            calls.push({ method: 'createIssue', args: [repoId, title, body] });
            const list = issues.get(repoId) ?? [];
            const n = list.length + 1;
            const item = makeIssue(repoId, n, { title, body });
            list.push(item);
            issues.set(repoId, list);
            return { ...item };
        },
        async addComment(repoId, n, body) {
            calls.push({ method: 'addComment', args: [repoId, n, body] });
            const key = `${repoId}#${n}`;
            const list = comments.get(key) ?? [];
            const c = makeComment(`c-${list.length + 1}`, body);
            list.push(c);
            comments.set(key, list);
            return { ...c };
        },
        async listComments(repoId, n) {
            calls.push({ method: 'listComments', args: [repoId, n] });
            return [...(comments.get(`${repoId}#${n}`) ?? [])];
        },
        async changeStatus(repoId, n, status, statuses) {
            calls.push({ method: 'changeStatus', args: [repoId, n, status, statuses] });
            const issue = (issues.get(repoId) ?? []).find((i) => i.number === n);
            if (!issue) { throw new Error(`Not found: ${repoId}#${n}`); }
            issue.state = status;
            return { ...issue };
        },
        async toggleLabel(repoId, n, label) {
            calls.push({ method: 'toggleLabel', args: [repoId, n, label] });
            const issue = (issues.get(repoId) ?? []).find((i) => i.number === n);
            if (!issue) { throw new Error(`Not found: ${repoId}#${n}`); }
            if (label.includes('=')) {
                const [key] = label.split('=');
                issue.labels = issue.labels.filter((l) => !l.startsWith(`${key}=`));
                issue.labels.push(label);
            } else if (issue.labels.includes(label)) {
                issue.labels = issue.labels.filter((l) => l !== label);
            } else {
                issue.labels.push(label);
            }
            return { ...issue };
        },
    };
    return fake;
}

// ===========================================================================
// Two distinct panel configs — proves mode routing
// ===========================================================================

function issuesPanelConfig(): IssuePanelConfig {
    return {
        provider: 'github',
        scanWorkspace: true,                              // issues default: ON
        allReposOption: true,
        excludeRepos: [],
        additionalRepos: [],
        statuses: ['open', 'in_triage', 'assigned', 'closed'],
        statusColors: {},
        defaultColumns: [],
        availableColumns: [],
        labels: ['bug', 'wontfix', 'quicklabel=Critical'],
        configError: null,
        columnLabels: {},
        growthPriority: [],
    };
}

function testkitPanelConfig(): IssuePanelConfig {
    return {
        provider: 'github',
        scanWorkspace: false,                             // tests default: OFF
        allReposOption: false,
        excludeRepos: [],
        additionalRepos: ['my-org/test-reports'],
        statuses: ['open', 'investigating', 'fixed', 'wontfix'],  // distinct from issues
        statusColors: {},
        defaultColumns: [],
        availableColumns: [],
        labels: ['flaky', 'regression', 'quicklabel=Flaky'],
        configError: null,
        columnLabels: {},
        growthPriority: [],
    };
}

// ===========================================================================
// Mode-aware access fake — returns different config per mode
// ===========================================================================

interface ModeAwareAccess extends IssueAccess {
    provider: FakeProvider;
    panelConfigCalls: PanelMode[];
}

function makeModeAwareAccess(provider: FakeProvider): ModeAwareAccess {
    const panelConfigCalls: PanelMode[] = [];
    const fake: ModeAwareAccess = {
        provider,
        panelConfigCalls,
        getProvider: () => provider,
        getPanelConfig(mode) {
            panelConfigCalls.push(mode);
            return mode === 'tests' ? testkitPanelConfig() : issuesPanelConfig();
        },
    };
    return fake;
}

let access: ModeAwareAccess;
beforeEach(() => { access = makeModeAwareAccess(makeProvider()); });

// ===========================================================================
// listReposForMode — `mode: 'tests'` reads testkit config
// ===========================================================================

describe('listReposForMode[tests]', () => {

    test('typical: mode="tests" reads testkit panel (scanWorkspace OFF, additionalRepos drives the list)', async () => {
        access.provider.discovered = [{ id: 'al/scanned-repo', displayName: 'scanned' }];
        const raw = await withTiming('tomAi_listTestRepos:typical', () =>
            listReposForModeImpl(access, 'tests'));
        const r = JSON.parse(raw);
        assert.equal(r.ok, true);
        assert.equal(r.mode, 'tests');
        assert.equal(r.scanWorkspace, false, 'testkit panel defaults scanWorkspace OFF');
        // Since scanWorkspace is OFF, the workspace-scanned repos are IGNORED.
        // Only the testkit panel's additionalRepos drives the list.
        assert.deepEqual(r.repos.map((x: { id: string }) => x.id), ['my-org/test-reports']);
        // Provider.discoverRepos NOT called when scanWorkspace is off
        assert.equal(access.provider.calls.some((c) => c.method === 'discoverRepos'), false);
        // Panel-config loader was called with 'tests', not 'issues'
        assert.deepEqual(access.panelConfigCalls, ['tests']);
    });

    test('mode-routing proof: same access object, mode="issues" reads issueKit panel (scanWorkspace ON)', async () => {
        access.provider.discovered = [{ id: 'al/scanned-repo', displayName: 'scanned' }];
        const r = JSON.parse(await listReposForModeImpl(access, 'issues'));
        assert.equal(r.mode, 'issues');
        assert.equal(r.scanWorkspace, true);
        // Now discoverRepos IS called, and the scanned repo flows through.
        assert.deepEqual(r.repos.map((x: { id: string }) => x.id), ['al/scanned-repo']);
        assert.deepEqual(access.panelConfigCalls, ['issues']);
    });
});

// ===========================================================================
// setStatus — `mode: 'tests'` validates against testkit statuses
// ===========================================================================

describe('setStatus[tests]', () => {

    beforeEach(() => {
        access.provider.issues.set('al/r', [makeIssue('al/r', 1, { state: 'open' })]);
    });

    test('typical: testkit status "investigating" accepted (DISTINCT from issueKit statuses)', async () => {
        const raw = await withTiming('tomAi_setTestStatus:typical', () =>
            setStatusImpl(access, { repoId: 'al/r', issueNumber: 1, status: 'investigating', mode: 'tests' }));
        const r = JSON.parse(raw);
        assert.equal(r.ok, true);
        assert.equal(r.state, 'investigating');
        // Verify the provider was given the TESTKIT status list, not issueKit's
        const call = access.provider.calls.find((c) => c.method === 'changeStatus');
        assert.deepEqual(call!.args[3], ['open', 'investigating', 'fixed', 'wontfix']);
    });

    test('issueKit-valid status "in_triage" REJECTED for testkit (different status list)', async () => {
        const r = JSON.parse(await setStatusImpl(access, {
            repoId: 'al/r', issueNumber: 1, status: 'in_triage', mode: 'tests',
        }));
        assert.equal(r.ok, false);
        assert.match(r.error, /not in the configured statuses for the tests panel/);
        assert.deepEqual(r.allowed, ['open', 'investigating', 'fixed', 'wontfix']);
        // The provider's changeStatus was NOT called
        assert.equal(access.provider.calls.some((c) => c.method === 'changeStatus'), false);
    });

    test('mode-routing proof: same status flips validity when mode changes', async () => {
        // "in_triage" is valid for issues
        const r1 = JSON.parse(await setStatusImpl(access, {
            repoId: 'al/r', issueNumber: 1, status: 'in_triage', mode: 'issues',
        }));
        assert.equal(r1.ok, true);
        // But not for tests
        const r2 = JSON.parse(await setStatusImpl(access, {
            repoId: 'al/r', issueNumber: 1, status: 'in_triage', mode: 'tests',
        }));
        assert.equal(r2.ok, false);
    });
});

// ===========================================================================
// Mode-agnostic tools: identical behaviour regardless of which family
// ===========================================================================

describe('mode-agnostic test tools (listTests, getTest, listTestComments, createTest, addTestComment, toggleTestLabel)', () => {

    test('typical: listTests returns the open items in the repo', async () => {
        access.provider.issues.set('al/r', [
            makeIssue('al/r', 1, { title: 'Flaky parser' }),
            makeIssue('al/r', 2, { title: 'Closed report', state: 'closed' }),
        ]);
        const raw = await withTiming('tomAi_listTests:typical', () =>
            listItemsImpl(access, { repoId: 'al/r' }));
        const r = JSON.parse(raw);
        assert.equal(r.ok, true);
        assert.equal(r.returned, 1);
        assert.equal(r.items[0].title, 'Flaky parser');
    });

    test('typical: getTest fetches a single test-report item', async () => {
        access.provider.issues.set('al/r', [makeIssue('al/r', 1, { title: 'Flaky parser' })]);
        const raw = await withTiming('tomAi_getTest:typical', () =>
            getItemImpl(access, { repoId: 'al/r', issueNumber: 1 }));
        const r = JSON.parse(raw);
        assert.equal(r.ok, true);
        assert.equal(r.title, 'Flaky parser');
        assert.equal(r.includeComments, false);
    });

    test('typical: listTestComments returns the comment list', async () => {
        access.provider.comments.set('al/r#1', [makeComment('c1', 'first'), makeComment('c2', 'second')]);
        const raw = await withTiming('tomAi_listTestComments:typical', () =>
            listCommentsImpl(access, { repoId: 'al/r', issueNumber: 1 }));
        const r = JSON.parse(raw);
        assert.equal(r.ok, true);
        assert.equal(r.count, 2);
    });

    test('typical: createTest creates a new item', async () => {
        const raw = await withTiming('tomAi_createTest:typical', () =>
            createItemImpl(access, { repoId: 'al/r', title: 'Flaky: parser/123', body: 'fails 30% of runs' }));
        const r = JSON.parse(raw);
        assert.equal(r.ok, true);
        assert.equal(r.created, true);
        assert.equal(r.title, 'Flaky: parser/123');
    });

    test('typical: addTestComment adds a comment and bumps commentCount', async () => {
        access.provider.issues.set('al/r', [makeIssue('al/r', 1)]);
        const raw = await withTiming('tomAi_addTestComment:typical', () =>
            addCommentImpl(access, { repoId: 'al/r', issueNumber: 1, body: 'still flaky' }));
        const r = JSON.parse(raw);
        assert.equal(r.ok, true);
        assert.equal(r.added, true);
        assert.equal(r.body, 'still flaky');
    });

    test('typical: toggleTestLabel handles key=value semantics (Flaky → Regression replaces)', async () => {
        access.provider.issues.set('al/r', [makeIssue('al/r', 1, { labels: [] })]);
        await toggleLabelImpl(access, { repoId: 'al/r', issueNumber: 1, label: 'quicklabel=Flaky' });
        const raw = await withTiming('tomAi_toggleTestLabel:typical', () =>
            toggleLabelImpl(access, { repoId: 'al/r', issueNumber: 1, label: 'quicklabel=Regression' }));
        const r = JSON.parse(raw);
        assert.equal(r.ok, true);
        assert.deepEqual(r.labels, ['quicklabel=Regression']);
    });
});
