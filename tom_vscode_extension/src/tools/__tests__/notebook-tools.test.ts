/**
 * Tool-impl tests for `notebook-tools.ts` — coverage entry #26.
 *
 *   - tomAi_notebookEdit  — insert / replace / delete cells
 *   - tomAi_notebookRun   — dispatch execution
 *
 * Strategy: an in-memory `NotebookHost` fake that registers a tiny
 * cell-count fixture per filePath, applies operations to its
 * internal state, and records every notebook command issued. No real
 * .ipynb file, no kernel, no async streaming — the impl's contract
 * with the host is just "send these operations / commands" and the
 * fake assertions verify the structure on the way through.
 *
 * Coverage entry #26 four-row checklist:
 *
 *   a) Description clarity — verified in the impl: 0-based indices,
 *      exclusive endIndex, insert-at-cellCount appends, code/markdown
 *      language defaults, "dispatch only" semantics for run.
 *   b) Ambiguities closed:
 *        - runAll vs cellIndices: BOTH set → hard error (was silent
 *          runAll precedence)
 *        - out-of-range cellIndices surfaced as `skipped: [...]`
 *          (was silent `continue`)
 *        - operations[i] validation reports `opIndex` so the model
 *          knows which entry failed
 *        - path traversal rejected
 *        - kernel selection: documented as out-of-scope
 *        - execution timeout: documented as absent (dispatch only)
 *   c) Stubbed `vscode.notebooks.*` via `NotebookHost`.  Per the
 *      coverage doc's c-row note: tests skip the live VS Code API
 *      path — only the impl's contract is exercised.
 *   d) Timing — sub-ms (no fs, no editor, no kernel).
 */

import test, { describe } from 'node:test';
import assert from 'node:assert/strict';

import { withTiming } from './_timing.js';

// `notebook-tools.ts` imports `vscode` at module top to build the live
// bridge — install the shared stub first.
import { installVscodeStub } from './_vscode-stub.js';
installVscodeStub({});

import {
    notebookEditImpl,
    notebookRunImpl,
    type NotebookHost,
    type NotebookEditOp,
} from '../notebook-tools.js';

// ===========================================================================
// In-memory NotebookHost
// ===========================================================================

interface OpenSnap { cellCount: number }
interface ExecuteCall { command: string; payload?: object }

interface FakeHost extends NotebookHost {
    files: Record<string, { cellCount: number }>;
    applyEditsCalls: Array<{ path: string; ops: NotebookEditOp[] }>;
    showCalls: string[];
    executeCalls: ExecuteCall[];
    applyEditsResult: boolean;
    /** When set, applyEdits throws. */
    throwOnApply?: Error;
    setWorkspaceRoot(root: string | undefined): void;
}

function makeHost(initial: Record<string, number> = {}): FakeHost {
    const files: Record<string, { cellCount: number }> = {};
    for (const [k, v] of Object.entries(initial)) {
        files[k] = { cellCount: v };
    }
    let root: string | undefined = '/ws';
    const fake: FakeHost = {
        files,
        applyEditsCalls: [],
        showCalls: [],
        executeCalls: [],
        applyEditsResult: true,
        workspaceRoot: () => root,
        setWorkspaceRoot: (r) => { root = r; },
        fileExists: (p) => p in files,
        async openNotebook(p): Promise<OpenSnap> {
            const f = files[p];
            if (!f) { throw new Error(`Fake host has no file: ${p}`); }
            return { cellCount: f.cellCount };
        },
        async applyEdits(p, ops): Promise<boolean> {
            fake.applyEditsCalls.push({ path: p, ops: ops.map((o) => ({ ...o })) });
            if (fake.throwOnApply) { throw fake.throwOnApply; }
            // Mutate the cell count so the post-edit re-read reflects the
            // operations. Simulating, not modelling — enough to verify the
            // impl's accounting.
            for (const op of ops) {
                if (op.op === 'insert') { files[p].cellCount += op.cells.length; }
                else if (op.op === 'replace') {
                    const end = op.endIndex ?? op.index + 1;
                    files[p].cellCount += (op.cells?.length ?? 0) - (end - op.index);
                }
                else if (op.op === 'delete') {
                    const end = op.endIndex ?? op.index + 1;
                    files[p].cellCount -= (end - op.index);
                }
            }
            return fake.applyEditsResult;
        },
        async showNotebook(p) { fake.showCalls.push(p); },
        async executeNotebookCommand(command, payload) { fake.executeCalls.push({ command, payload }); },
    };
    return fake;
}

// ===========================================================================
// `tomAi_notebookEdit`
// ===========================================================================

describe('notebookEditImpl', () => {

    test('typical: insert a markdown cell at the end appends + reports counts', async () => {
        const h = makeHost({ '/ws/nb/sample.ipynb': 3 });
        const raw = await withTiming('tomAi_notebookEdit:typical', () =>
            notebookEditImpl(h, {
                filePath: 'nb/sample.ipynb',
                operations: [
                    { op: 'insert', index: 3, cells: [{ kind: 'markdown', text: '# Hello' }] },
                ],
            }));
        const r = JSON.parse(raw);
        assert.equal(r.ok, true);
        assert.equal(r.applied, true);
        assert.equal(r.operationCount, 1);
        assert.equal(r.cellCountBefore, 3);
        assert.equal(r.cellCountAfter, 4);
        // Op forwarded verbatim
        assert.equal(h.applyEditsCalls.length, 1);
        assert.equal(h.applyEditsCalls[0].ops[0].op, 'insert');
    });

    test('absolute path inside workspace accepted', async () => {
        const h = makeHost({ '/ws/nb/a.ipynb': 1 });
        const r = JSON.parse(await notebookEditImpl(h, {
            filePath: '/ws/nb/a.ipynb',
            operations: [{ op: 'delete', index: 0 }],
        }));
        assert.equal(r.ok, true);
    });

    test('path traversal rejected (filePath escapes workspace)', async () => {
        const h = makeHost({ '/ws/nb/a.ipynb': 1 });
        const r = JSON.parse(await notebookEditImpl(h, {
            filePath: '../../etc/secret.ipynb',
            operations: [{ op: 'delete', index: 0 }],
        }));
        assert.equal(r.ok, false);
        assert.match(r.error, /escapes the workspace root/);
        assert.equal(h.applyEditsCalls.length, 0);
    });

    test('missing file → ok:false', async () => {
        const h = makeHost({});
        const r = JSON.parse(await notebookEditImpl(h, {
            filePath: 'nb/missing.ipynb',
            operations: [{ op: 'delete', index: 0 }],
        }));
        assert.equal(r.ok, false);
        assert.match(r.error, /Notebook not found/);
    });

    test('empty filePath rejected', async () => {
        const h = makeHost({});
        const r = JSON.parse(await notebookEditImpl(h, {
            filePath: '   ',
            operations: [{ op: 'delete', index: 0 }],
        }));
        assert.equal(r.ok, false);
        assert.match(r.error, /`filePath` is required/);
    });

    test('empty operations array rejected', async () => {
        const h = makeHost({ '/ws/nb/a.ipynb': 1 });
        const r = JSON.parse(await notebookEditImpl(h, { filePath: 'nb/a.ipynb', operations: [] }));
        assert.equal(r.ok, false);
        assert.match(r.error, /`operations` must be a non-empty array/);
    });

    test('atomic: single invalid op rejects the whole batch (no applyEdits dispatched)', async () => {
        const h = makeHost({ '/ws/nb/a.ipynb': 2 });
        const r = JSON.parse(await notebookEditImpl(h, {
            filePath: 'nb/a.ipynb',
            operations: [
                { op: 'insert', index: 0, cells: [{ kind: 'code', text: 'x = 1' }] },
                { op: 'delete', index: 99 },  // out of range
            ],
        }));
        assert.equal(r.ok, false);
        assert.match(r.error, /exceeds cellCount/);
        assert.equal(r.opIndex, 1, 'opIndex points to the failed op');
        assert.equal(h.applyEditsCalls.length, 0, 'no edits dispatched');
        assert.equal(h.files['/ws/nb/a.ipynb'].cellCount, 2, 'file untouched');
    });

    test('insert: index === cellCount appends (allowed)', async () => {
        const h = makeHost({ '/ws/nb/a.ipynb': 2 });
        const r = JSON.parse(await notebookEditImpl(h, {
            filePath: 'nb/a.ipynb',
            operations: [{ op: 'insert', index: 2, cells: [{ kind: 'code', text: 'y = 2' }] }],
        }));
        assert.equal(r.ok, true);
        assert.equal(r.cellCountAfter, 3);
    });

    test('insert: index > cellCount rejected', async () => {
        const h = makeHost({ '/ws/nb/a.ipynb': 2 });
        const r = JSON.parse(await notebookEditImpl(h, {
            filePath: 'nb/a.ipynb',
            operations: [{ op: 'insert', index: 3, cells: [{ kind: 'code', text: 'z = 3' }] }],
        }));
        assert.equal(r.ok, false);
        assert.match(r.error, /exceeds cellCount/);
    });

    test('insert: empty cells array rejected', async () => {
        const h = makeHost({ '/ws/nb/a.ipynb': 1 });
        const r = JSON.parse(await notebookEditImpl(h, {
            filePath: 'nb/a.ipynb',
            operations: [{ op: 'insert', index: 0, cells: [] }],
        }));
        assert.equal(r.ok, false);
        assert.match(r.error, /requires a non-empty cells array/);
    });

    test('replace: endIndex defaults to index + 1 (single cell)', async () => {
        const h = makeHost({ '/ws/nb/a.ipynb': 3 });
        const r = JSON.parse(await notebookEditImpl(h, {
            filePath: 'nb/a.ipynb',
            operations: [{ op: 'replace', index: 1, cells: [{ kind: 'code', text: 'a = 1' }] }],
        }));
        assert.equal(r.ok, true);
        assert.equal(r.cellCountAfter, 3, 'single-for-single → count unchanged');
    });

    test('replace: empty cells array allowed (effectively delete)', async () => {
        const h = makeHost({ '/ws/nb/a.ipynb': 3 });
        const r = JSON.parse(await notebookEditImpl(h, {
            filePath: 'nb/a.ipynb',
            operations: [{ op: 'replace', index: 0, endIndex: 2, cells: [] }],
        }));
        assert.equal(r.ok, true);
        assert.equal(r.cellCountAfter, 1);
    });

    test('delete: endIndex defaults to index + 1', async () => {
        const h = makeHost({ '/ws/nb/a.ipynb': 4 });
        const r = JSON.parse(await notebookEditImpl(h, {
            filePath: 'nb/a.ipynb',
            operations: [{ op: 'delete', index: 1 }],
        }));
        assert.equal(r.ok, true);
        assert.equal(r.cellCountAfter, 3);
    });

    test('negative index rejected (non-negative integer requirement)', async () => {
        const h = makeHost({ '/ws/nb/a.ipynb': 2 });
        const r = JSON.parse(await notebookEditImpl(h, {
            filePath: 'nb/a.ipynb',
            operations: [{ op: 'delete', index: -1 }],
        }));
        assert.equal(r.ok, false);
        assert.match(r.error, /non-negative integer/);
    });

    test('non-integer index rejected', async () => {
        const h = makeHost({ '/ws/nb/a.ipynb': 2 });
        const r = JSON.parse(await notebookEditImpl(h, {
            filePath: 'nb/a.ipynb',
            operations: [{ op: 'delete', index: 1.5 }],
        }));
        assert.equal(r.ok, false);
        assert.match(r.error, /non-negative integer/);
    });

    test('endIndex < index rejected', async () => {
        const h = makeHost({ '/ws/nb/a.ipynb': 3 });
        const r = JSON.parse(await notebookEditImpl(h, {
            filePath: 'nb/a.ipynb',
            operations: [{ op: 'replace', index: 2, endIndex: 1, cells: [] }],
        }));
        assert.equal(r.ok, false);
        assert.match(r.error, /endIndex must be an integer >= index/);
    });

    test('host applyEdits returns false → applied: false propagated honestly', async () => {
        const h = makeHost({ '/ws/nb/a.ipynb': 1 });
        h.applyEditsResult = false;
        const r = JSON.parse(await notebookEditImpl(h, {
            filePath: 'nb/a.ipynb',
            operations: [{ op: 'delete', index: 0 }],
        }));
        assert.equal(r.ok, true);
        assert.equal(r.applied, false);
    });

    test('host throws → ok:false with reason', async () => {
        const h = makeHost({ '/ws/nb/a.ipynb': 1 });
        h.throwOnApply = new Error('disk full');
        const r = JSON.parse(await notebookEditImpl(h, {
            filePath: 'nb/a.ipynb',
            operations: [{ op: 'delete', index: 0 }],
        }));
        assert.equal(r.ok, false);
        assert.match(r.error, /Notebook edit failed: disk full/);
    });
});

// ===========================================================================
// `tomAi_notebookRun`
// ===========================================================================

describe('notebookRunImpl', () => {

    test('typical: runAll dispatches `notebook.execute` (no payload)', async () => {
        const h = makeHost({ '/ws/nb/a.ipynb': 4 });
        const raw = await withTiming('tomAi_notebookRun:typical', () =>
            notebookRunImpl(h, { filePath: 'nb/a.ipynb', runAll: true }));
        const r = JSON.parse(raw);
        assert.equal(r.ok, true);
        assert.equal(r.ran, 'all');
        assert.equal(r.cellCount, 4);
        assert.equal(h.executeCalls.length, 1);
        assert.equal(h.executeCalls[0].command, 'notebook.execute');
        assert.equal(h.executeCalls[0].payload, undefined);
        assert.deepEqual(h.showCalls, ['/ws/nb/a.ipynb']);
    });

    test('cellIndices: each in-range index becomes one notebook.cell.execute', async () => {
        const h = makeHost({ '/ws/nb/a.ipynb': 5 });
        const r = JSON.parse(await notebookRunImpl(h, { filePath: 'nb/a.ipynb', cellIndices: [0, 2, 4] }));
        assert.equal(r.ok, true);
        assert.equal(r.ran, 'cells');
        assert.deepEqual(r.dispatched, [0, 2, 4]);
        assert.deepEqual(r.skipped, []);
        assert.equal(h.executeCalls.length, 3);
        assert.deepEqual(h.executeCalls[0].payload, { start: 0, end: 1 });
        assert.deepEqual(h.executeCalls[1].payload, { start: 2, end: 3 });
    });

    test('out-of-range cellIndices surface in `skipped` (was silent `continue`)', async () => {
        const h = makeHost({ '/ws/nb/a.ipynb': 3 });
        const r = JSON.parse(await notebookRunImpl(h, { filePath: 'nb/a.ipynb', cellIndices: [0, 5, -1, 2] }));
        assert.equal(r.ok, true);
        assert.deepEqual(r.dispatched, [0, 2]);
        assert.deepEqual(r.skipped, [5, -1]);
        assert.equal(h.executeCalls.length, 2);
    });

    test('runAll + cellIndices BOTH set → hard error (was silent runAll precedence)', async () => {
        const h = makeHost({ '/ws/nb/a.ipynb': 3 });
        const r = JSON.parse(await notebookRunImpl(h, {
            filePath: 'nb/a.ipynb', runAll: true, cellIndices: [0],
        }));
        assert.equal(r.ok, false);
        assert.match(r.error, /Specify either `runAll: true` OR a non-empty `cellIndices`.*not both/);
        assert.equal(h.executeCalls.length, 0);
    });

    test('neither runAll nor cellIndices → ok:false', async () => {
        const h = makeHost({ '/ws/nb/a.ipynb': 3 });
        const r = JSON.parse(await notebookRunImpl(h, { filePath: 'nb/a.ipynb' }));
        assert.equal(r.ok, false);
        assert.match(r.error, /Specify `runAll: true` OR a non-empty `cellIndices`/);
    });

    test('empty cellIndices treated as "no specific cells" → reuses "neither" error', async () => {
        const h = makeHost({ '/ws/nb/a.ipynb': 3 });
        const r = JSON.parse(await notebookRunImpl(h, { filePath: 'nb/a.ipynb', cellIndices: [] }));
        assert.equal(r.ok, false);
        assert.match(r.error, /Specify `runAll: true` OR a non-empty `cellIndices`/);
    });

    test('non-integer indices filtered out before dispatch', async () => {
        const h = makeHost({ '/ws/nb/a.ipynb': 3 });
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const r = JSON.parse(await notebookRunImpl(h, { filePath: 'nb/a.ipynb', cellIndices: [0, 1.5, 2] as any }));
        assert.equal(r.ok, true);
        // 1.5 is silently dropped at filter-time (not "skipped" — it isn't a valid cell index at all)
        assert.deepEqual(r.dispatched, [0, 2]);
        assert.deepEqual(r.skipped, []);
    });

    test('missing file → ok:false', async () => {
        const h = makeHost({});
        const r = JSON.parse(await notebookRunImpl(h, { filePath: 'nb/missing.ipynb', runAll: true }));
        assert.equal(r.ok, false);
        assert.match(r.error, /Notebook not found/);
    });

    test('path traversal rejected', async () => {
        const h = makeHost({ '/ws/nb/a.ipynb': 1 });
        const r = JSON.parse(await notebookRunImpl(h, { filePath: '../../etc/x.ipynb', runAll: true }));
        assert.equal(r.ok, false);
        assert.match(r.error, /escapes the workspace root/);
    });

    test('host execute throws → ok:false with reason', async () => {
        const h = makeHost({ '/ws/nb/a.ipynb': 2 });
        h.executeNotebookCommand = async () => { throw new Error('no kernel'); };
        const r = JSON.parse(await notebookRunImpl(h, { filePath: 'nb/a.ipynb', runAll: true }));
        assert.equal(r.ok, false);
        assert.match(r.error, /Notebook run failed: no kernel/);
    });
});
