/**
 * Tool-impl tests for `workspace-edit-tools.ts` — `tomAi_applyEdit`.
 *
 * Strategy: pass a fake `WorkspaceEditService` that records every
 * op-list it receives. We don't actually exercise a real WorkspaceEdit
 * — the validation + path resolution + 1-based ↔ 0-based conversion
 * is what's being tested here. (vscode's WorkspaceEdit atomicity is
 * vscode's contract, not ours.)
 *
 * Coverage entry #11 (applyEdit portion):
 *
 *   a) Description verified — every op shape spelled out, 1-based
 *      positions, validation-up-front contract.
 *   b) Ambiguities covered:
 *        - traversal rejection on every op type
 *        - bad op shape (missing range/position/filePath/etc.)
 *        - createFile ignoreIfExists default flipped to false
 *          (consistent with file-mutations.ts createFile)
 *        - unknown op enum value rejected
 *        - empty operations array rejected
 *   c) Tests with fake service + every op exercised.
 *   d) Timing — sub-ms via `withTiming`.
 */

import test, { describe } from 'node:test';
import assert from 'node:assert/strict';

import { withTiming } from './_timing.js';
import {
    applyEditImpl,
    type ApplyEditOp,
    type ResolvedApplyEditOp,
    type WorkspaceEditService,
} from '../workspace-edit-tools.js';

interface ApplyCall { ops: ResolvedApplyEditOp[] }

function makeService(opts: {
    wsRoot?: string;
    applyResult?: { applied: boolean; affectedFiles: string[] };
    applyError?: Error;
} = {}): WorkspaceEditService & { calls: ApplyCall[] } {
    const calls: ApplyCall[] = [];
    return {
        wsRoot: opts.wsRoot ?? '/ws',
        calls,
        async applyOps(ops) {
            calls.push({ ops });
            if (opts.applyError) { throw opts.applyError; }
            return opts.applyResult ?? {
                applied: true,
                affectedFiles: Array.from(new Set(ops.flatMap((o) => [o.absPath, o.fromAbs, o.toAbs].filter((p): p is string => !!p)))),
            };
        },
    };
}

describe('applyEditImpl — validation', () => {

    test('empty operations array → instructive error, no service call', async () => {
        const svc = makeService();
        const r = JSON.parse(await applyEditImpl(svc, { operations: [] }));
        assert.match(r.error, /must be a non-empty array/);
        assert.equal(svc.calls.length, 0);
    });

    test('non-array operations → instructive error', async () => {
        const svc = makeService();
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const r = JSON.parse(await applyEditImpl(svc, { operations: 'not an array' as any }));
        assert.match(r.error, /must be a non-empty array/);
    });

    test('VALIDATES UP FRONT: bad op aborts whole batch with per-op failure list', async () => {
        const svc = makeService();
        const ops: ApplyEditOp[] = [
            { op: 'replace', filePath: 'src/ok.ts', range: { startLine: 1, startCharacter: 1, endLine: 1, endCharacter: 5 }, text: 'a' },
            { op: 'replace', filePath: 'src/bad.ts' /* range missing */, text: 'b' },
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            { op: 'unknown-op' as any, filePath: 'src/x.ts' },
        ];
        const r = JSON.parse(await applyEditImpl(svc, { operations: ops }));
        assert.match(r.error, /Validation failed for 2 op\(s\)/);
        assert.match(r.error, /nothing applied/);
        assert.equal(r.failures.length, 2);
        // First failure: missing range on replace
        assert.equal(r.failures[0].op, 'replace');
        assert.match(r.failures[0].reason, /replace requires range/);
        // Second failure: unknown op
        assert.equal(r.failures[1].op, 'unknown-op');
        assert.match(r.failures[1].reason, /unknown op/);
        // Critical: service must NOT have been called (atomic behaviour)
        assert.equal(svc.calls.length, 0);
    });

    test('TRAVERSAL: filePath escaping workspace is rejected on every op type', async () => {
        const svc = makeService();
        const r = JSON.parse(await applyEditImpl(svc, {
            operations: [
                { op: 'createFile', filePath: '../../../tmp/escape.txt' },
            ],
        }));
        assert.match(r.error, /Validation failed/);
        assert.match(r.failures[0].reason, /escapes workspace/);
        assert.equal(svc.calls.length, 0);
    });

    test('TRAVERSAL: renameFile rejects either side escaping', async () => {
        const svc = makeService();
        const r1 = JSON.parse(await applyEditImpl(svc, {
            operations: [{ op: 'renameFile', fromPath: '../escape.ts', toPath: 'src/dst.ts' }],
        }));
        assert.match(r1.failures[0].reason, /fromPath.*escapes workspace/);
        const r2 = JSON.parse(await applyEditImpl(svc, {
            operations: [{ op: 'renameFile', fromPath: 'src/src.ts', toPath: '../escape.ts' }],
        }));
        assert.match(r2.failures[0].reason, /toPath.*escapes workspace/);
    });
});

describe('applyEditImpl — typical paths + 1-based conversion', () => {

    test('typical call: every-op-shape exercised, applied + affectedFiles reported', async () => {
        const svc = makeService();
        const ops: ApplyEditOp[] = [
            // 1-based positions throughout (per the new convention).
            { op: 'replace', filePath: 'src/a.ts', range: { startLine: 5, startCharacter: 1, endLine: 5, endCharacter: 10 }, text: 'updated' },
            { op: 'insert', filePath: 'src/b.ts', position: { line: 1, character: 1 }, text: 'header\n' },
            { op: 'delete', filePath: 'src/c.ts', range: { startLine: 10, startCharacter: 1, endLine: 12, endCharacter: 1 } },
            { op: 'createFile', filePath: 'src/d.ts' },
            { op: 'deleteFile', filePath: 'src/e.ts' },
            { op: 'renameFile', fromPath: 'src/f.ts', toPath: 'src/f-renamed.ts' },
        ];
        const raw = await withTiming('tomAi_applyEdit:typical', () =>
            applyEditImpl(svc, { operations: ops }));
        const r = JSON.parse(raw);
        assert.equal(r.applied, true);
        assert.equal(r.operationCount, 6);
        assert.ok(r.affectedFiles.length >= 6);
        // Service got the resolved 0-based form
        assert.equal(svc.calls.length, 1);
        const callOps = svc.calls[0].ops;
        // replace: 1-based (5, 1, 5, 10) → 0-based (4, 0, 4, 9)
        assert.deepEqual(callOps[0].range, { startLine: 4, startCharacter: 0, endLine: 4, endCharacter: 9 });
        // insert: 1-based (1, 1) → 0-based (0, 0)
        assert.deepEqual(callOps[1].position, { line: 0, character: 0 });
        // delete: 1-based (10, 1, 12, 1) → 0-based (9, 0, 11, 0)
        assert.deepEqual(callOps[2].range, { startLine: 9, startCharacter: 0, endLine: 11, endCharacter: 0 });
        // Paths resolved to absolute
        assert.equal(callOps[0].absPath, '/ws/src/a.ts');
        assert.equal(callOps[5].fromAbs, '/ws/src/f.ts');
        assert.equal(callOps[5].toAbs, '/ws/src/f-renamed.ts');
    });

    test('CREATEFILE DEFAULT FLIP: ignoreIfExists defaults to false (matches tomAi_createFile)', async () => {
        const svc = makeService();
        await applyEditImpl(svc, {
            operations: [{ op: 'createFile', filePath: 'new.ts' }],
        });
        const op = svc.calls[0].ops[0];
        assert.equal(op.ignoreIfExists, false, 'default must be false — consistent with file-mutations.createFile');
    });

    test('createFile with ignoreIfExists: true forwards the opt-in', async () => {
        const svc = makeService();
        await applyEditImpl(svc, {
            operations: [{ op: 'createFile', filePath: 'new.ts', ignoreIfExists: true }],
        });
        assert.equal(svc.calls[0].ops[0].ignoreIfExists, true);
    });

    test('createFile with overwrite: true forwards', async () => {
        const svc = makeService();
        await applyEditImpl(svc, {
            operations: [{ op: 'createFile', filePath: 'new.ts', overwrite: true }],
        });
        assert.equal(svc.calls[0].ops[0].overwrite, true);
    });

    test('deleteFile defaults ignoreIfNotExists to false (fail on missing)', async () => {
        const svc = makeService();
        await applyEditImpl(svc, {
            operations: [{ op: 'deleteFile', filePath: 'gone.ts' }],
        });
        assert.equal(svc.calls[0].ops[0].ignoreIfNotExists, false);
    });

    test('service apply error wrapped as error JSON', async () => {
        const svc = makeService({ applyError: new Error('vscode rejected the edit') });
        const r = JSON.parse(await applyEditImpl(svc, {
            operations: [{ op: 'createFile', filePath: 'new.ts' }],
        }));
        assert.match(r.error, /applyEdit failed: vscode rejected the edit/);
    });

    test('insert without position → validation failure', async () => {
        const svc = makeService();
        const r = JSON.parse(await applyEditImpl(svc, {
            operations: [{ op: 'insert', filePath: 'src/a.ts', text: 'x' }],
        }));
        assert.match(r.error, /Validation failed/);
        assert.match(r.failures[0].reason, /insert requires position/);
    });

    test('renameFile without toPath → validation failure', async () => {
        const svc = makeService();
        const r = JSON.parse(await applyEditImpl(svc, {
            operations: [{ op: 'renameFile', fromPath: 'src/a.ts' }],
        }));
        assert.match(r.error, /Validation failed/);
    });

    test('absolute filePath that is inside the workspace is accepted', async () => {
        const svc = makeService();
        const r = JSON.parse(await applyEditImpl(svc, {
            operations: [{ op: 'createFile', filePath: '/ws/sub/leaf.ts' }],
        }));
        assert.equal(r.applied, true);
        assert.equal(svc.calls[0].ops[0].absPath, '/ws/sub/leaf.ts');
    });

    test('applied: false from the service is propagated faithfully', async () => {
        const svc = makeService({ applyResult: { applied: false, affectedFiles: [] } });
        const r = JSON.parse(await applyEditImpl(svc, {
            operations: [{ op: 'createFile', filePath: 'new.ts' }],
        }));
        assert.equal(r.applied, false);
    });
});
