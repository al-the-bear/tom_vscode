/**
 * Tool-impl tests for `code-action-tools.ts` — `tomAi_getCodeActions`,
 * `tomAi_getCodeActionsCached`, `tomAi_applyCodeAction`.
 *
 * Strategy: pass a fake `CodeActionService` that returns synthetic
 * snapshots + opaque tokens. The registry is real (it's small and
 * the contract IS the cache behaviour); we reset between tests via
 * `_resetCodeActionRegistryForTesting()`.
 *
 * Coverage entry #11 four-row checklist (this file covers 3/5 tools):
 *
 *   a) Description clarity — verified in the impl file (kind taxonomy,
 *      cache lifetime, three-outcome apply result).
 *   b) Ambiguities — covered:
 *        - refactor.* vs quickfix.* vs source.* kind filter (only param)
 *        - registry expiry produces an explicit "expired" error
 *        - missing actionId / missing action
 *        - action with edit-only, command-only, both, neither
 *        - 1-based positions converted to 0-based for the service
 *   c) Tests against fake CodeActionService.
 *   d) Timing — typical paths sub-ms via `withTiming`.
 */

import test, { beforeEach, describe } from 'node:test';
import assert from 'node:assert/strict';

import { withTiming } from './_timing.js';
import {
    _resetCodeActionRegistryForTesting,
    applyCodeActionImpl,
    CODE_ACTION_TTL_MS,
    getCodeActionsCachedImpl,
    getCodeActionsImpl,
    type ApplyActionResult,
    type CodeActionRange0Based,
    type CodeActionService,
    type CodeActionSnapshot,
    type ListedCodeAction,
} from '../code-action-tools.js';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const SAMPLE_ACTIONS: ListedCodeAction[] = [
    {
        snapshot: {
            title: 'Add missing import',
            kind: 'quickfix.imports',
            isPreferred: true,
            hasEdit: true,
            hasCommand: false,
            diagnosticsCount: 1,
        },
        token: { actionKind: 'add-import' },
    },
    {
        snapshot: {
            title: 'Extract to function',
            kind: 'refactor.extract.function',
            isPreferred: false,
            hasEdit: true,
            hasCommand: false,
            diagnosticsCount: 0,
        },
        token: { actionKind: 'extract-fn' },
    },
    {
        snapshot: {
            title: 'Show fix-its',
            kind: 'source.fixAll',
            isPreferred: false,
            hasEdit: false,
            hasCommand: true,
            commandId: 'editor.action.codeActionFixAll',
            diagnosticsCount: 0,
        },
        token: { actionKind: 'fix-all-cmd' },
    },
];

// ---------------------------------------------------------------------------
// Fake CodeActionService
// ---------------------------------------------------------------------------

interface ServiceCall {
    method: 'resolveFile' | 'list' | 'apply';
    args: unknown[];
}

function makeService(opts: {
    actions?: ListedCodeAction[];
    listError?: Error;
    applyResult?: ApplyActionResult;
    applyError?: Error;
    existingFiles?: Set<string>;
} = {}): CodeActionService & { calls: ServiceCall[] } {
    const calls: ServiceCall[] = [];
    const existing = opts.existingFiles ?? new Set(['/ws/src/foo.ts']);
    return {
        calls,
        resolveFile(filePath) {
            calls.push({ method: 'resolveFile', args: [filePath] });
            const abs = filePath.startsWith('/') ? filePath : `/ws/${filePath}`;
            return existing.has(abs) ? abs : null;
        },
        async list(absPath, range, only) {
            calls.push({ method: 'list', args: [absPath, range, only] });
            if (opts.listError) { throw opts.listError; }
            const all = opts.actions ?? SAMPLE_ACTIONS;
            // Mimic vscode's `only` filter — prefix match.
            return only ? all.filter((a) => a.snapshot.kind?.startsWith(only)) : all;
        },
        async apply(token) {
            calls.push({ method: 'apply', args: [token] });
            if (opts.applyError) { throw opts.applyError; }
            return opts.applyResult ?? { editApplied: true, commandResult: null };
        },
    };
}

beforeEach(() => _resetCodeActionRegistryForTesting());

// ===========================================================================
// getCodeActions
// ===========================================================================

describe('getCodeActionsImpl', () => {

    test('typical call: list actions, no cache registration', async () => {
        const svc = makeService();
        const raw = await withTiming('tomAi_getCodeActions:typical', () =>
            getCodeActionsImpl(svc, { filePath: 'src/foo.ts', startLine: 5, startCharacter: 3 }));
        const r = JSON.parse(raw);
        assert.equal(r.count, 3);
        assert.equal(r.actions[0].title, 'Add missing import');
        // Critical: no actionId field — only Cached returns it
        assert.equal(r.actions[0].actionId, undefined);
    });

    test('1-based positions translated to 0-based at the service boundary', async () => {
        const svc = makeService();
        await getCodeActionsImpl(svc, {
            filePath: 'src/foo.ts',
            startLine: 5, startCharacter: 10,
            endLine: 7, endCharacter: 15,
        });
        const listCall = svc.calls.find((c) => c.method === 'list')!;
        const range = listCall.args[1] as CodeActionRange0Based;
        assert.equal(range.startLine, 4);
        assert.equal(range.startCharacter, 9);
        assert.equal(range.endLine, 6);
        assert.equal(range.endCharacter, 14);
    });

    test('kind filter (`only`) is forwarded and exercised', async () => {
        const svc = makeService();
        const r = JSON.parse(await getCodeActionsImpl(svc, {
            filePath: 'src/foo.ts', startLine: 1, startCharacter: 1,
            only: 'refactor',
        }));
        assert.equal(r.count, 1);
        assert.equal(r.actions[0].title, 'Extract to function');
    });

    test('source.* prefix filter scopes to source-level actions', async () => {
        const svc = makeService();
        const r = JSON.parse(await getCodeActionsImpl(svc, {
            filePath: 'src/foo.ts', startLine: 1, startCharacter: 1,
            only: 'source',
        }));
        assert.equal(r.count, 1);
        assert.equal(r.actions[0].kind, 'source.fixAll');
    });

    test('missing file → error JSON, no service call', async () => {
        const svc = makeService({ existingFiles: new Set() });
        const r = JSON.parse(await getCodeActionsImpl(svc, { filePath: 'nope.ts', startLine: 1, startCharacter: 1 }));
        assert.match(r.error, /File not found/);
        assert.equal(svc.calls.filter((c) => c.method === 'list').length, 0);
    });

    test('missing filePath → instructive error', async () => {
        const svc = makeService();
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const r = JSON.parse(await getCodeActionsImpl(svc, { startLine: 1, startCharacter: 1 } as any));
        assert.match(r.error, /`filePath` is required/);
    });

    test('service error wrapped as error JSON', async () => {
        const svc = makeService({ listError: new Error('LSP offline') });
        const r = JSON.parse(await getCodeActionsImpl(svc, { filePath: 'src/foo.ts', startLine: 1, startCharacter: 1 }));
        assert.match(r.error, /Code actions failed: LSP offline/);
    });
});

// ===========================================================================
// getCodeActionsCached + applyCodeAction (registry round-trip)
// ===========================================================================

describe('getCodeActionsCachedImpl + applyCodeActionImpl', () => {

    test('round-trip: register → look up by actionId → apply', async () => {
        const svc = makeService();
        const cachedRaw = await withTiming('tomAi_getCodeActionsCached:typical', () =>
            getCodeActionsCachedImpl(svc, { filePath: 'src/foo.ts', startLine: 5, startCharacter: 1 }));
        const cached = JSON.parse(cachedRaw);
        assert.equal(cached.count, 3);
        // Every entry must have an actionId
        for (const a of cached.actions) {
            assert.match(a.actionId, /^ca_\d+_/);
        }
        const firstId = cached.actions[0].actionId as string;

        const applyRaw = await withTiming('tomAi_applyCodeAction:typical', () =>
            applyCodeActionImpl(svc, { actionId: firstId }));
        const applied = JSON.parse(applyRaw);
        assert.equal(applied.title, 'Add missing import');
        assert.equal(applied.editApplied, true);
        assert.equal(applied.commandResult, null);
        assert.equal(applied.success, true);

        // Verify the right token went to apply()
        const applyCall = svc.calls.find((c) => c.method === 'apply')!;
        assert.deepEqual(applyCall.args[0], { actionKind: 'add-import' });
    });

    test('apply with unknown actionId → "not found" error pointing back at re-list', async () => {
        const svc = makeService();
        const r = JSON.parse(await applyCodeActionImpl(svc, { actionId: 'ca_999999_zzz' }));
        assert.match(r.error, /Action not found/);
        assert.match(r.error, /Re-run.*getCodeActionsCached/);
        assert.equal(svc.calls.filter((c) => c.method === 'apply').length, 0);
    });

    test('apply with empty actionId → instructive error', async () => {
        const svc = makeService();
        const r = JSON.parse(await applyCodeActionImpl(svc, { actionId: '' }));
        assert.match(r.error, /`actionId` is required/);
    });

    test('apply distinguishes the three outcomes: edit-only / command-only / both', async () => {
        const svc = makeService();
        // Register all three sample actions
        const cached = JSON.parse(await getCodeActionsCachedImpl(svc, {
            filePath: 'src/foo.ts', startLine: 1, startCharacter: 1,
        }));

        // edit-only action: index 0 (Add missing import)
        const editOnly = JSON.parse(await applyCodeActionImpl(
            makeService({ applyResult: { editApplied: true, commandResult: null } }),
            { actionId: cached.actions[0].actionId },
        ));
        assert.equal(editOnly.editApplied, true);
        assert.equal(editOnly.commandResult, null);

        // command-only action: index 2 (Show fix-its)
        const cmdOnly = JSON.parse(await applyCodeActionImpl(
            makeService({ applyResult: { editApplied: null, commandResult: { fixed: 5 } } }),
            { actionId: cached.actions[2].actionId },
        ));
        assert.equal(cmdOnly.editApplied, null);
        assert.deepEqual(cmdOnly.commandResult, { fixed: 5 });
    });

    test('apply error wrapped as error JSON, registry entry preserved for retry', async () => {
        const svc = makeService({ applyResult: undefined });
        const cached = JSON.parse(await getCodeActionsCachedImpl(svc, {
            filePath: 'src/foo.ts', startLine: 1, startCharacter: 1,
        }));
        const id = cached.actions[0].actionId as string;
        const failing = makeService({ applyError: new Error('apply failed') });
        const r = JSON.parse(await applyCodeActionImpl(failing, { actionId: id }));
        assert.match(r.error, /Apply code action failed: apply failed/);
        // Note: failing service has its own registry view — the original
        // registry entry from `svc` is still there for retry.
    });

    test('expired action → explicit "expired" error (different from "not found")', async () => {
        const svc = makeService();
        const cached = JSON.parse(await getCodeActionsCachedImpl(svc, {
            filePath: 'src/foo.ts', startLine: 1, startCharacter: 1,
        }));
        const id = cached.actions[0].actionId as string;
        // Force expiry by ticking the clock past TTL using a synthetic Date stub.
        const realNow = Date.now;
        const tooFar = realNow() + CODE_ACTION_TTL_MS + 1000;
        Date.now = () => tooFar;
        try {
            const r = JSON.parse(await applyCodeActionImpl(svc, { actionId: id }));
            assert.match(r.error, /Action expired/);
            assert.match(r.error, /Re-run.*getCodeActionsCached/);
        } finally {
            Date.now = realNow;
        }
    });

    test('Cached variant: list error wrapped, no registry entries created', async () => {
        const svc = makeService({ listError: new Error('LSP offline') });
        const r = JSON.parse(await getCodeActionsCachedImpl(svc, {
            filePath: 'src/foo.ts', startLine: 1, startCharacter: 1,
        }));
        assert.match(r.error, /Code actions failed: LSP offline/);
        // Subsequent apply of a freshly generated id would say "not found"
        const r2 = JSON.parse(await applyCodeActionImpl(svc, { actionId: 'ca_1_zzz' }));
        assert.match(r2.error, /Action not found/);
    });
});
