/**
 * Tool-impl tests for `issue-tools.ts` — the 8 Issues-subpanel tools
 * (coverage entry #29):
 *
 *   - tomAi_listIssueRepos
 *   - tomAi_listIssues
 *   - tomAi_getIssue
 *   - tomAi_listIssueComments
 *   - tomAi_createIssue
 *   - tomAi_addIssueComment
 *   - tomAi_setIssueStatus
 *   - tomAi_toggleIssueLabel
 *
 * Strategy: an in-memory `IssueAccess` fake combining
 *
 *   - a scriptable provider (records every call, programmable
 *     returns per repo) standing in for the GitHub layer
 *   - a programmable panel-config (statuses, labels, scanWorkspace,
 *     additionalRepos, excludeRepos)
 *
 * The b-row's "fixture repo on disk. Mock the github layer." → the
 * provider IS the mock; the panel config IS the on-disk-config
 * substitute.  No real network calls.
 *
 * Coverage entry #29 four-row checklist:
 *
 *   a) Description clarity — verified in the impl: repo-discovery
 *      surface (scan + additional − exclude), id format per provider,
 *      status enum source (panel config), label semantics (bare vs
 *      key=value).
 *   b) Ambiguities closed:
 *        - **local-only vs github-backed**: `providerId` surfaced in
 *          list-repos; tests verify both branches.
 *        - **Label semantics**: key=value vs bare label both tested.
 *        - **scanWorkspace off** (typical for tests panel) tested.
 *        - **Status not in panel config** rejected with `allowed` hint
 *          (was silently sent to provider, which may or may not
 *          accept depending on backend).
 *        - **getIssue comments-fetch failure** is non-fatal with
 *          `commentsFetched: false` + `commentsError` (was
 *          `commentsError` field on success payload — same data,
 *          clearer envelope).
 *   c) Tests + fake provider per the c-row's ask.
 *   d) Timing — sub-ms per call.
 */

import test, { beforeEach, describe } from 'node:test';
import assert from 'node:assert/strict';

import { withTiming } from './_timing.js';

// _timing.js transitively requires only fs/path; no vscode stub needed
// for the issue-tools-impl path itself.

// Import from the vscode-free impl module so we don't trigger the
// `issuesPanel-handler → handler_shared → vscode-bridge → handlers/index →
//  chatPanel-handler → tool-executors` cycle (which would spread
// `ISSUE_TOOLS` before `issue-tools.ts` had finished evaluating).
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
// Fake provider — scriptable, records every call
// ===========================================================================

interface ProviderCall { method: string; args: unknown[] }

interface FakeProvider extends IssueProvider {
    calls: ProviderCall[];
    /** Per-repo issue list returned by listIssues + getIssue. */
    issues: Map<string, IssueItem[]>;
    /** Per-issue comments. Key: `${repoId}#${num}`. */
    comments: Map<string, IssueComment[]>;
    /** Per-repo discovered list (only used when scanWorkspace=true). */
    discovered: IssueProviderRepo[];
    /** When set, the next call THROWING simulates a backend failure. */
    throwOnNext?: { method: string; error: Error };
}

function makeIssue(repoId: string, n: number, overrides: Partial<IssueItem> = {}): IssueItem {
    return {
        id: `${repoId}#${n}`,
        number: n,
        title: `Issue ${n}`,
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

function makeComment(id: string, body: string, author = 'alice'): IssueComment {
    return {
        id,
        body,
        author: { name: author, avatarUrl: '' },
        createdAt: '2026-01-01T00:00:00Z',
        updatedAt: '2026-01-01T00:00:00Z',
        url: `https://example.test/c/${id}`,
    };
}

function makeProvider(providerId = 'github', displayName = 'GitHub'): FakeProvider {
    const calls: ProviderCall[] = [];
    const issues = new Map<string, IssueItem[]>();
    const comments = new Map<string, IssueComment[]>();
    const checkThrow = (method: string) => {
        if (fake.throwOnNext?.method === method) {
            const err = fake.throwOnNext.error;
            fake.throwOnNext = undefined;
            throw err;
        }
    };
    const fake: FakeProvider = {
        providerId,
        displayName,
        calls,
        issues,
        comments,
        // `discovered` is read from `fake` (not closed over) so the test
        // can reassign it after construction.
        discovered: [],
        discoverRepos() { calls.push({ method: 'discoverRepos', args: [] }); checkThrow('discoverRepos'); return [...fake.discovered]; },
        async listIssues(repoId, state) {
            calls.push({ method: 'listIssues', args: [repoId, state] });
            checkThrow('listIssues');
            const all = issues.get(repoId) ?? [];
            if (state === 'all') { return [...all]; }
            return all.filter((i) => i.state === state);
        },
        async getIssue(repoId, n) {
            calls.push({ method: 'getIssue', args: [repoId, n] });
            checkThrow('getIssue');
            const found = (issues.get(repoId) ?? []).find((i) => i.number === n);
            if (!found) { throw new Error(`Not found: ${repoId}#${n}`); }
            return { ...found };
        },
        async createIssue(repoId, title, body) {
            calls.push({ method: 'createIssue', args: [repoId, title, body] });
            checkThrow('createIssue');
            const list = issues.get(repoId) ?? [];
            const n = list.length + 1;
            const item = makeIssue(repoId, n, { title, body });
            list.push(item);
            issues.set(repoId, list);
            return { ...item };
        },
        async addComment(repoId, n, body) {
            calls.push({ method: 'addComment', args: [repoId, n, body] });
            checkThrow('addComment');
            const key = `${repoId}#${n}`;
            const list = comments.get(key) ?? [];
            const c = makeComment(`c-${list.length + 1}`, body);
            list.push(c);
            comments.set(key, list);
            // bump commentCount on issue
            const issue = (issues.get(repoId) ?? []).find((i) => i.number === n);
            if (issue) { issue.commentCount = list.length; }
            return { ...c };
        },
        async listComments(repoId, n) {
            calls.push({ method: 'listComments', args: [repoId, n] });
            checkThrow('listComments');
            return [...(comments.get(`${repoId}#${n}`) ?? [])];
        },
        async changeStatus(repoId, n, status, statuses) {
            calls.push({ method: 'changeStatus', args: [repoId, n, status, statuses] });
            checkThrow('changeStatus');
            const issue = (issues.get(repoId) ?? []).find((i) => i.number === n);
            if (!issue) { throw new Error(`Not found: ${repoId}#${n}`); }
            issue.state = status;
            return { ...issue };
        },
        async toggleLabel(repoId, n, label) {
            calls.push({ method: 'toggleLabel', args: [repoId, n, label] });
            checkThrow('toggleLabel');
            const issue = (issues.get(repoId) ?? []).find((i) => i.number === n);
            if (!issue) { throw new Error(`Not found: ${repoId}#${n}`); }
            // key=value: replace existing with same key
            if (label.includes('=')) {
                const [key] = label.split('=');
                issue.labels = issue.labels.filter((l) => !l.startsWith(`${key}=`));
                issue.labels.push(label);
            } else {
                // bare: toggle on/off
                if (issue.labels.includes(label)) {
                    issue.labels = issue.labels.filter((l) => l !== label);
                } else {
                    issue.labels.push(label);
                }
            }
            return { ...issue };
        },
    };
    return fake;
}

// ===========================================================================
// Fake panel config
// ===========================================================================

function makePanelConfig(overrides: Partial<IssuePanelConfig> = {}): IssuePanelConfig {
    return {
        provider: 'github',
        scanWorkspace: true,
        allReposOption: true,
        excludeRepos: [],
        additionalRepos: [],
        statuses: ['open', 'in_triage', 'assigned', 'closed'],
        statusColors: { open: 'green', in_triage: 'yellow', assigned: 'red', closed: 'grey' },
        defaultColumns: [],
        availableColumns: [],
        labels: ['quicklabel=Flaky', 'quicklabel=Regression', 'bug', 'wontfix'],
        configError: null,
        columnLabels: {},
        growthPriority: [],
        ...overrides,
    };
}

// ===========================================================================
// Composite access (provider + panel config)
// ===========================================================================

interface FakeAccess extends IssueAccess {
    provider: FakeProvider | undefined;
    config: IssuePanelConfig;
}

function makeAccess(provider: FakeProvider | undefined = makeProvider(), config = makePanelConfig()): FakeAccess {
    const fake: FakeAccess = {
        provider,
        config,
        getProvider: () => fake.provider,
        getPanelConfig: () => fake.config,
    };
    return fake;
}

let access: FakeAccess;
beforeEach(() => { access = makeAccess(); });

// ===========================================================================
// listReposForModeImpl
// ===========================================================================

describe('listReposForModeImpl', () => {

    test('typical: github provider + scanWorkspace returns discovered repos', async () => {
        access.provider!.discovered = [
            { id: 'al/repo-a', displayName: 'repo-a' },
            { id: 'al/repo-b', displayName: 'repo-b' },
        ];
        const raw = await withTiming('tomAi_listIssueRepos:typical', () =>
            listReposForModeImpl(access, 'issues'));
        const r = JSON.parse(raw);
        assert.equal(r.ok, true);
        assert.equal(r.providerId, 'github');
        assert.equal(r.scanWorkspace, true);
        assert.equal(r.count, 2);
        assert.deepEqual(r.repos.map((x: { id: string }) => x.id).sort(), ['al/repo-a', 'al/repo-b']);
    });

    test('local-only provider surfaces via providerId', async () => {
        access.provider = makeProvider('local', 'Local Files');
        access.provider.discovered = [{ id: 'docs/bugs.md', displayName: 'docs/bugs.md' }];
        const r = JSON.parse(await listReposForModeImpl(access, 'issues'));
        assert.equal(r.providerId, 'local');
        assert.equal(r.providerName, 'Local Files');
    });

    test('additionalRepos appended; excludeRepos filtered', async () => {
        access.provider!.discovered = [
            { id: 'al/keep', displayName: 'keep' },
            { id: 'al/drop', displayName: 'drop' },
        ];
        access.config = makePanelConfig({
            additionalRepos: ['extra/manual'],
            excludeRepos: ['al/drop'],
        });
        const r = JSON.parse(await listReposForModeImpl(access, 'issues'));
        const ids = r.repos.map((x: { id: string }) => x.id).sort();
        assert.deepEqual(ids, ['al/keep', 'extra/manual']);
    });

    test('scanWorkspace: false (typical for tests panel) skips discoverRepos', async () => {
        access.config = makePanelConfig({ scanWorkspace: false, additionalRepos: ['only/this'] });
        const r = JSON.parse(await listReposForModeImpl(access, 'tests'));
        assert.equal(r.scanWorkspace, false);
        assert.deepEqual(r.repos.map((x: { id: string }) => x.id), ['only/this']);
        // discoverRepos NOT called
        assert.equal(access.provider!.calls.some((c) => c.method === 'discoverRepos'), false);
    });

    test('deduplicates when additionalRepos overlaps with discovered', async () => {
        access.provider!.discovered = [{ id: 'al/dup', displayName: 'discovered' }];
        access.config = makePanelConfig({ additionalRepos: ['al/dup'] });
        const r = JSON.parse(await listReposForModeImpl(access, 'issues'));
        assert.equal(r.count, 1);
    });

    test('no provider → ok:false with hint', async () => {
        access.provider = undefined;
        const r = JSON.parse(await listReposForModeImpl(access, 'issues'));
        assert.equal(r.ok, false);
        assert.match(r.error, /No issue provider registered/);
        assert.match(r.hint, /Open the WS panel/);
    });

    test('discoverRepos throws → ok:false with reason', async () => {
        access.provider!.throwOnNext = { method: 'discoverRepos', error: new Error('git remote failure') };
        const r = JSON.parse(await listReposForModeImpl(access, 'issues'));
        assert.equal(r.ok, false);
        assert.match(r.error, /discoverRepos failed: git remote failure/);
    });
});

// ===========================================================================
// listItemsImpl
// ===========================================================================

describe('listItemsImpl', () => {

    function seedIssues(): void {
        access.provider!.issues.set('al/r', [
            makeIssue('al/r', 1, { title: 'Login bug', body: 'foo', labels: ['bug'] }),
            makeIssue('al/r', 2, { title: 'Logout bug', body: 'bar', labels: ['bug', 'urgent'] }),
            makeIssue('al/r', 3, { title: 'Sparkle feature', body: 'baz', labels: ['feature'], state: 'closed' }),
        ]);
    }

    test('typical: default state="open" returns open issues only', async () => {
        seedIssues();
        const raw = await withTiming('tomAi_listIssues:typical', () =>
            listItemsImpl(access, { repoId: 'al/r' }));
        const r = JSON.parse(raw);
        assert.equal(r.ok, true);
        assert.equal(r.state, 'open');
        assert.equal(r.totalMatches, 2);
        assert.equal(r.returned, 2);
        assert.equal(r.truncated, false);
    });

    test('state: "all" returns every state', async () => {
        seedIssues();
        const r = JSON.parse(await listItemsImpl(access, { repoId: 'al/r', state: 'all' }));
        assert.equal(r.totalMatches, 3);
    });

    test('query: case-insensitive substring against title + body', async () => {
        seedIssues();
        const r = JSON.parse(await listItemsImpl(access, { repoId: 'al/r', query: 'LOGOUT' }));
        assert.equal(r.totalMatches, 1);
        assert.equal(r.items[0].title, 'Logout bug');
    });

    test('labels: AT LEAST ONE match required (intersection)', async () => {
        seedIssues();
        const r = JSON.parse(await listItemsImpl(access, { repoId: 'al/r', labels: ['urgent'] }));
        assert.equal(r.totalMatches, 1);
        assert.equal(r.items[0].number, 2);
    });

    test('maxResults caps; truncated flag set', async () => {
        seedIssues();
        const r = JSON.parse(await listItemsImpl(access, { repoId: 'al/r', maxResults: 1, state: 'all' }));
        assert.equal(r.returned, 1);
        assert.equal(r.totalMatches, 3);
        assert.equal(r.truncated, true);
    });

    test('missing repoId rejected', async () => {
        const r = JSON.parse(await listItemsImpl(access, { repoId: '' }));
        assert.equal(r.ok, false);
        assert.match(r.error, /repoId.*required/);
    });
});

// ===========================================================================
// getItemImpl
// ===========================================================================

describe('getItemImpl', () => {

    beforeEach(() => {
        access.provider!.issues.set('al/r', [makeIssue('al/r', 7, { title: 'T', body: 'B' })]);
    });

    test('typical: fetches issue, no comments unless requested', async () => {
        const raw = await withTiming('tomAi_getIssue:typical', () =>
            getItemImpl(access, { repoId: 'al/r', issueNumber: 7 }));
        const r = JSON.parse(raw);
        assert.equal(r.ok, true);
        assert.equal(r.number, 7);
        assert.equal(r.body, 'B');
        assert.equal(r.includeComments, false);
        assert.equal(r.commentsFetched, false);
        assert.equal(r.comments, null);
    });

    test('includeComments: true → comments fetched and reported', async () => {
        access.provider!.comments.set('al/r#7', [makeComment('c1', 'first'), makeComment('c2', 'second')]);
        const r = JSON.parse(await getItemImpl(access, { repoId: 'al/r', issueNumber: 7, includeComments: true }));
        assert.equal(r.includeComments, true);
        assert.equal(r.commentsFetched, true);
        assert.equal(r.comments.length, 2);
    });

    test('includeComments: true + provider throws on listComments → main payload OK with commentsError', async () => {
        access.provider!.throwOnNext = { method: 'listComments', error: new Error('rate limited') };
        const r = JSON.parse(await getItemImpl(access, { repoId: 'al/r', issueNumber: 7, includeComments: true }));
        assert.equal(r.ok, true, 'main payload still ok — comments failure is non-fatal');
        assert.equal(r.commentsFetched, false);
        assert.match(r.commentsError, /rate limited/);
    });

    test('non-integer issueNumber rejected', async () => {
        const r = JSON.parse(await getItemImpl(access, { repoId: 'al/r', issueNumber: 1.5 }));
        assert.equal(r.ok, false);
        assert.match(r.error, /issueNumber.*integer/);
    });

    test('provider getIssue throws → ok:false', async () => {
        const r = JSON.parse(await getItemImpl(access, { repoId: 'al/r', issueNumber: 9999 }));
        assert.equal(r.ok, false);
        assert.match(r.error, /getIssue failed: Not found/);
    });
});

// ===========================================================================
// listCommentsImpl
// ===========================================================================

describe('listCommentsImpl', () => {

    test('typical: returns the comment list with count', async () => {
        access.provider!.comments.set('al/r#5', [makeComment('a', 'one'), makeComment('b', 'two')]);
        const raw = await withTiming('tomAi_listIssueComments:typical', () =>
            listCommentsImpl(access, { repoId: 'al/r', issueNumber: 5 }));
        const r = JSON.parse(raw);
        assert.equal(r.ok, true);
        assert.equal(r.count, 2);
        assert.equal(r.comments.length, 2);
    });

    test('empty comments returned cleanly', async () => {
        const r = JSON.parse(await listCommentsImpl(access, { repoId: 'al/r', issueNumber: 1 }));
        assert.equal(r.ok, true);
        assert.equal(r.count, 0);
    });
});

// ===========================================================================
// createItemImpl
// ===========================================================================

describe('createItemImpl', () => {

    test('typical: creates the issue and returns slim shape with created:true', async () => {
        const raw = await withTiming('tomAi_createIssue:typical', () =>
            createItemImpl(access, { repoId: 'al/r', title: 'New bug', body: 'details' }));
        const r = JSON.parse(raw);
        assert.equal(r.ok, true);
        assert.equal(r.created, true);
        assert.equal(r.title, 'New bug');
        assert.equal(access.provider!.calls.some((c) => c.method === 'createIssue'), true);
    });

    test('missing title rejected; provider NOT called', async () => {
        const r = JSON.parse(await createItemImpl(access, { repoId: 'al/r', title: '   ' }));
        assert.equal(r.ok, false);
        assert.match(r.error, /title.*required/);
        assert.equal(access.provider!.calls.length, 0);
    });

    test('body defaults to empty string when omitted', async () => {
        await createItemImpl(access, { repoId: 'al/r', title: 't' });
        const createCall = access.provider!.calls.find((c) => c.method === 'createIssue');
        assert.equal(createCall!.args[2], '');
    });
});

// ===========================================================================
// addCommentImpl
// ===========================================================================

describe('addCommentImpl', () => {

    beforeEach(() => {
        access.provider!.issues.set('al/r', [makeIssue('al/r', 3)]);
    });

    test('typical: comment added; issue commentCount bumps', async () => {
        const raw = await withTiming('tomAi_addIssueComment:typical', () =>
            addCommentImpl(access, { repoId: 'al/r', issueNumber: 3, body: 'thanks!' }));
        const r = JSON.parse(raw);
        assert.equal(r.ok, true);
        assert.equal(r.added, true);
        assert.equal(r.body, 'thanks!');
        assert.equal(access.provider!.issues.get('al/r')![0].commentCount, 1);
    });

    test('whitespace-only body rejected', async () => {
        const r = JSON.parse(await addCommentImpl(access, { repoId: 'al/r', issueNumber: 3, body: '   ' }));
        assert.equal(r.ok, false);
        assert.match(r.error, /body.*required/);
    });
});

// ===========================================================================
// setStatusImpl
// ===========================================================================

describe('setStatusImpl', () => {

    beforeEach(() => {
        access.provider!.issues.set('al/r', [makeIssue('al/r', 1, { state: 'open' })]);
    });

    test('typical: status from panel config accepted; provider invoked with status list', async () => {
        const raw = await withTiming('tomAi_setIssueStatus:typical', () =>
            setStatusImpl(access, { repoId: 'al/r', issueNumber: 1, status: 'in_triage', mode: 'issues' as PanelMode }));
        const r = JSON.parse(raw);
        assert.equal(r.ok, true);
        assert.equal(r.changed, true);
        assert.equal(r.state, 'in_triage');
        const call = access.provider!.calls.find((c) => c.method === 'changeStatus');
        assert.deepEqual(call!.args[3], ['open', 'in_triage', 'assigned', 'closed']);
    });

    test('status NOT in panel config rejected (was silently sent to provider)', async () => {
        const r = JSON.parse(await setStatusImpl(access, {
            repoId: 'al/r', issueNumber: 1, status: 'archived', mode: 'issues' as PanelMode,
        }));
        assert.equal(r.ok, false);
        assert.match(r.error, /not in the configured statuses/);
        assert.deepEqual(r.allowed, ['open', 'in_triage', 'assigned', 'closed']);
        assert.equal(access.provider!.calls.some((c) => c.method === 'changeStatus'), false);
    });

    test('empty panel statuses → no validation (provider decides)', async () => {
        access.config = makePanelConfig({ statuses: [] });
        const r = JSON.parse(await setStatusImpl(access, {
            repoId: 'al/r', issueNumber: 1, status: 'anything', mode: 'issues' as PanelMode,
        }));
        assert.equal(r.ok, true);
    });
});

// ===========================================================================
// toggleLabelImpl
// ===========================================================================

describe('toggleLabelImpl', () => {

    beforeEach(() => {
        access.provider!.issues.set('al/r', [makeIssue('al/r', 1, { labels: [] })]);
    });

    test('bare label: on/off toggle', async () => {
        const raw = await withTiming('tomAi_toggleIssueLabel:typical', () =>
            toggleLabelImpl(access, { repoId: 'al/r', issueNumber: 1, label: 'bug' }));
        const r1 = JSON.parse(raw);
        assert.equal(r1.ok, true);
        assert.deepEqual(r1.labels, ['bug']);
        // Toggle off
        const r2 = JSON.parse(await toggleLabelImpl(access, { repoId: 'al/r', issueNumber: 1, label: 'bug' }));
        assert.deepEqual(r2.labels, []);
    });

    test('key=value labels: mutually exclusive within same key (set Flaky then Regression → Regression wins)', async () => {
        await toggleLabelImpl(access, { repoId: 'al/r', issueNumber: 1, label: 'quicklabel=Flaky' });
        const r2 = JSON.parse(await toggleLabelImpl(access, { repoId: 'al/r', issueNumber: 1, label: 'quicklabel=Regression' }));
        assert.deepEqual(r2.labels, ['quicklabel=Regression']);
    });

    test('missing label rejected', async () => {
        const r = JSON.parse(await toggleLabelImpl(access, { repoId: 'al/r', issueNumber: 1, label: '' }));
        assert.equal(r.ok, false);
        assert.match(r.error, /label.*required/);
    });
});
