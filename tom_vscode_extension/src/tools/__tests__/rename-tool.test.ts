/**
 * Tool-impl tests for `rename-tool.ts` — `tomAi_rename`.
 *
 * Coverage entry #11 (rename portion):
 *
 *   a) Description verified — three outcomes documented, atomicity
 *      claim spelled out, currentName short-circuit explained.
 *   b) Ambiguities covered:
 *        - rename in non-rename-provider languages (`{kind:'no-provider'}`)
 *        - position isn't renameable (`{kind:'no-edits'}`)
 *        - no-op rename (newName === currentName)
 *        - multi-file atomicity proof
 *   c) Tests with fake `RenameService` returning each provider result.
 *   d) Timing — sub-ms via `withTiming`.
 */

import test, { describe } from 'node:test';
import assert from 'node:assert/strict';

import { withTiming } from './_timing.js';
import { renameImpl, type RenameProviderResult, type RenameService } from '../rename-tool.js';

interface RenameCall {
    method: 'resolveFile' | 'rename';
    args: unknown[];
}

function makeRenameService(opts: {
    result?: RenameProviderResult;
    error?: Error;
    existingFiles?: Set<string>;
} = {}): RenameService & { calls: RenameCall[] } {
    const calls: RenameCall[] = [];
    const existing = opts.existingFiles ?? new Set(['/ws/src/foo.ts']);
    return {
        calls,
        resolveFile(filePath) {
            calls.push({ method: 'resolveFile', args: [filePath] });
            const abs = filePath.startsWith('/') ? filePath : `/ws/${filePath}`;
            return existing.has(abs) ? abs : null;
        },
        async rename(absPath, line, character, newName) {
            calls.push({ method: 'rename', args: [absPath, line, character, newName] });
            if (opts.error) { throw opts.error; }
            return opts.result ?? { kind: 'ok' as const, affectedFiles: ['src/foo.ts'] };
        },
    };
}

describe('renameImpl', () => {

    test('typical call: provider applies single-file edit, response reports affectedFiles + single-undo note', async () => {
        const svc = makeRenameService();
        const raw = await withTiming('tomAi_rename:typical', () =>
            renameImpl(svc, { filePath: 'src/foo.ts', line: 10, character: 5, newName: 'bar' }));
        const r = JSON.parse(raw);
        assert.equal(r.applied, true);
        assert.equal(r.newName, 'bar');
        assert.deepEqual(r.affectedFiles, ['src/foo.ts']);
        assert.equal(r.affectedFileCount, 1);
        assert.match(r.note, /Single-file rename/);
        // 1-based input → 0-based at the service boundary
        const renameCall = svc.calls.find((c) => c.method === 'rename')!;
        assert.deepEqual(renameCall.args, ['/ws/src/foo.ts', 9, 4, 'bar']);
    });

    test('multi-file rename surfaces atomicity note + lists every affected file', async () => {
        const svc = makeRenameService({
            result: { kind: 'ok' as const, affectedFiles: ['src/foo.ts', 'src/bar.ts', 'test/foo.test.ts'] },
        });
        const r = JSON.parse(await renameImpl(svc, {
            filePath: 'src/foo.ts', line: 10, character: 5, newName: 'qux',
        }));
        assert.equal(r.affectedFileCount, 3);
        assert.match(r.note, /Atomic multi-file rename across 3 files/);
        assert.match(r.note, /single undo/);
    });

    test('NO-PROVIDER (language lacks rename support) returns explicit error, distinguishable from "no edits"', async () => {
        const svc = makeRenameService({ result: { kind: 'no-provider' as const } });
        const r = JSON.parse(await renameImpl(svc, {
            filePath: 'src/foo.ts', line: 10, character: 5, newName: 'bar',
        }));
        assert.match(r.error, /No rename provider available/);
        assert.doesNotMatch(r.error, /no edits/i);   // explicit different message
    });

    test('NO-EDITS (provider ran but rejected) returns its own message', async () => {
        const svc = makeRenameService({ result: { kind: 'no-edits' as const } });
        const r = JSON.parse(await renameImpl(svc, {
            filePath: 'src/foo.ts', line: 10, character: 5, newName: 'bar',
        }));
        assert.match(r.error, /Rename provider returned no edits/);
        assert.match(r.error, /not a renameable symbol|conflicts with the language/);
    });

    test('NO-OP rename (currentName === newName) rejected before hitting the provider', async () => {
        const svc = makeRenameService();
        const r = JSON.parse(await renameImpl(svc, {
            filePath: 'src/foo.ts', line: 10, character: 5, newName: 'foo', currentName: 'foo',
        }));
        assert.match(r.error, /equals.*currentName.*nothing to do/);
        // Service must NOT have been called
        assert.equal(svc.calls.filter((c) => c.method === 'rename').length, 0);
    });

    test('different newName + currentName proceeds normally', async () => {
        const svc = makeRenameService();
        const r = JSON.parse(await renameImpl(svc, {
            filePath: 'src/foo.ts', line: 10, character: 5, newName: 'bar', currentName: 'foo',
        }));
        assert.equal(r.applied, true);
    });

    test('missing filePath → instructive error', async () => {
        const svc = makeRenameService();
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const r = JSON.parse(await renameImpl(svc, { line: 1, character: 1, newName: 'x' } as any));
        assert.match(r.error, /`filePath` is required/);
    });

    test('missing newName → instructive error', async () => {
        const svc = makeRenameService();
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const r = JSON.parse(await renameImpl(svc, { filePath: 'src/foo.ts', line: 1, character: 1 } as any));
        assert.match(r.error, /`newName` is required/);
    });

    test('missing line/character → error', async () => {
        const svc = makeRenameService();
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const r = JSON.parse(await renameImpl(svc, { filePath: 'src/foo.ts', newName: 'x' } as any));
        assert.match(r.error, /`line` and `character` are required/);
    });

    test('missing file → not-found error, no service call', async () => {
        const svc = makeRenameService({ existingFiles: new Set() });
        const r = JSON.parse(await renameImpl(svc, {
            filePath: 'nope.ts', line: 1, character: 1, newName: 'x',
        }));
        assert.match(r.error, /File not found/);
        assert.equal(svc.calls.filter((c) => c.method === 'rename').length, 0);
    });

    test('service throw wrapped as error JSON', async () => {
        const svc = makeRenameService({ error: new Error('provider crashed') });
        const r = JSON.parse(await renameImpl(svc, {
            filePath: 'src/foo.ts', line: 1, character: 1, newName: 'x',
        }));
        assert.match(r.error, /Rename failed: provider crashed/);
    });
});
