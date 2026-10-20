/**
 * The tool-coverage audit (scripts/audit-tool-coverage.cjs, vscimpa6): its
 * inventory is the registry, ALL_SHARED_TOOLS, not a grep of the source.
 *
 *   AU-1 a tool defined through a factory (no `name: 'tomAi_…'` literal) is counted: covered by its timing row,
 *        missing — a failure — without one; never an orphan
 *   AU-2 a row over the ceiling fails; a row for a name that is not registered is an orphan (information only)
 *   AU-3 a tool defined in src/tools/ but not registered fails, unless KNOWN_UNREGISTERED excuses it; an
 *        excuse that no longer applies (registered now, or no longer defined) fails
 *   AU-4 an empty registry cannot be audited (exit 2)
 *   AU-5 loadRegisteredTools reads the compiled registry: exactly ALL_SHARED_TOOLS' names, each once, holding
 *        every name the grep finds except the excused ones; without a compiled extension it says to compile
 */

/* eslint-disable @typescript-eslint/naming-convention -- tool names (tomAi_…) and the script's exports are data here */
import test, { describe } from 'node:test';
import assert from 'node:assert/strict';
import * as path from 'path';

import { installVscodeStub } from './_vscode-stub.js';
installVscodeStub({});

import { ALL_SHARED_TOOLS } from '../tool-executors.js';

const EXT_ROOT = path.resolve(__dirname, '..', '..', '..');
// eslint-disable-next-line @typescript-eslint/no-require-imports
const audit = require(path.join(EXT_ROOT, 'scripts', 'audit-tool-coverage.cjs')) as {
    auditToolCoverage(input: {
        registered: string[]; defined: string[]; entries: Array<{ name: string; ms: number; ceilingMs: number; category?: string; note?: string }>;
        ceilingMs?: number; knownUnregistered?: Record<string, string>;
    }): { tools: string[]; missing: string[]; overCeiling: unknown[]; unregistered: string[]; staleExceptions: string[]; orphans: Array<{ name: string }>; exitCode: number; lines: string[] };
    loadRegisteredTools(outDir?: string): string[];
    extractToolNames(srcDir: string): string[];
    KNOWN_UNREGISTERED: Record<string, string>;
};

const row = (name: string, ms = 1): { name: string; ms: number; ceilingMs: number } => ({ name, ms, ceilingMs: 5000 });

describe('the tool-coverage audit', () => {
    test('AU-1: a factory-defined tool is counted', () => {
        // tomAi_madeByFactory has no name literal, so the grep (`defined`) does not see it.
        const covered = audit.auditToolCoverage({
            registered: ['tomAi_literal', 'tomAi_madeByFactory'], defined: ['tomAi_literal'],
            entries: [row('tomAi_literal:typical'), row('tomAi_madeByFactory:typical')], knownUnregistered: {},
        });
        assert.deepEqual([covered.exitCode, covered.missing, covered.orphans], [0, [], []]);
        assert.match(covered.lines[0], /2\/2/);
        const uncovered = audit.auditToolCoverage({
            registered: ['tomAi_literal', 'tomAi_madeByFactory'], defined: ['tomAi_literal'],
            entries: [row('tomAi_literal:typical')], knownUnregistered: {},
        });
        assert.deepEqual([uncovered.exitCode, uncovered.missing], [1, ['tomAi_madeByFactory']], 'a registered tool without a row fails');
    });

    test('AU-2: the ceiling and orphans', () => {
        const slow = audit.auditToolCoverage({ registered: ['tomAi_a'], defined: ['tomAi_a'], entries: [row('tomAi_a:typical', 6000)], knownUnregistered: {} });
        assert.deepEqual([slow.exitCode, slow.overCeiling.length], [1, 1]);
        const orphan = audit.auditToolCoverage({ registered: ['tomAi_a'], defined: ['tomAi_a'], entries: [row('tomAi_a:typical'), row('tomAi_gone:typical')], knownUnregistered: {} });
        assert.deepEqual([orphan.exitCode, orphan.orphans.map((o) => o.name)], [0, ['tomAi_gone:typical']], 'information only');
    });

    test('AU-3: defined but not registered', () => {
        const r = audit.auditToolCoverage({ registered: ['tomAi_a'], defined: ['tomAi_a', 'tomAi_orphanDef'], entries: [row('tomAi_a:x')], knownUnregistered: {} });
        assert.deepEqual([r.exitCode, r.unregistered], [1, ['tomAi_orphanDef']]);
        const excused = audit.auditToolCoverage({ registered: ['tomAi_a'], defined: ['tomAi_a', 'tomAi_orphanDef'], entries: [row('tomAi_a:x')], knownUnregistered: { tomAi_orphanDef: 'why' } });
        assert.deepEqual([excused.exitCode, excused.unregistered], [0, []]);
        assert.ok(excused.lines.some((l) => /tomAi_orphanDef: why/.test(l)), 'the reason is printed');
        const nowRegistered = audit.auditToolCoverage({ registered: ['tomAi_a', 'tomAi_b'], defined: ['tomAi_a', 'tomAi_b'], entries: [row('tomAi_a:x'), row('tomAi_b:x')], knownUnregistered: { tomAi_b: 'why' } });
        assert.deepEqual([nowRegistered.exitCode, nowRegistered.staleExceptions], [1, ['tomAi_b']]);
        const gone = audit.auditToolCoverage({ registered: ['tomAi_a'], defined: ['tomAi_a'], entries: [row('tomAi_a:x')], knownUnregistered: { tomAi_c: 'why' } });
        assert.deepEqual([gone.exitCode, gone.staleExceptions], [1, ['tomAi_c']]);
    });

    test('AU-4: an empty registry', () => {
        assert.equal(audit.auditToolCoverage({ registered: [], defined: [], entries: [], knownUnregistered: {} }).exitCode, 2);
    });

    test('AU-5: the registry is read from the compiled extension', () => {
        const registered = audit.loadRegisteredTools(path.join(EXT_ROOT, 'out'));
        assert.deepEqual([...registered].sort(), ALL_SHARED_TOOLS.map((t) => t.name).sort());
        const grepped = audit.extractToolNames(path.join(EXT_ROOT, 'src', 'tools'));
        const registeredSet = new Set(registered);
        assert.deepEqual(grepped.filter((n) => !registeredSet.has(n)).sort(), Object.keys(audit.KNOWN_UNREGISTERED).sort(),
            'every grepped name is registered, except the excused');
        assert.equal(registered.length, new Set(registered).size, 'no tool is registered twice');
        assert.throws(() => audit.loadRegisteredTools(path.join(EXT_ROOT, 'no-such-out')), /npm run compile/);
    });
});
