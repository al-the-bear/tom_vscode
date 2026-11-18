/**
 * tom_specs_clitool's calls through its one binary, `tomspecs`:
 *
 *   TS-1 the call table: every call becomes its tomspecs command, the options unchanged after it,
 *        the spec checks' `--spec-root` an option of the command
 *   TS-2 every call runs tomspecs, none a retired clitool binary
 *   TS-3 the extension calls tomspecs only: no source names a retired clitool binary
 *   TS-4 the window reports tom_bs and tomspecs
 */

import test, { describe } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'fs';
import * as path from 'path';
import { CLITOOL_BINARY, clitoolCommandLine, clitoolInvocation, IR_COMMANDS, SPEC_COMMANDS, type ClitoolCall } from '../tomspecsCalls';
import { DART_BINARIES, reportedDartBinaries } from '../dartBinariesStatus';

const SRC = path.resolve(__dirname, '..', '..', '..', 'src');

/** The clitool's retired binaries: no call may run one, no source may name one. */
const RETIRED = ['validate_codespecs', 'spec_checks', 'irspecs'];

const CHECKS: Array<[string, string]> = [
    ['validate', ':spec-render'], ['import-answers', ':spec-import-answers'], ['accept-marks', ':spec-accept-marks'],
    ['required-fields', ':spec-required-fields'], ['question-register', ':spec-question-register'],
    ['feature-register', ':spec-feature-register'], ['project-idea-coverage', ':spec-idea-coverage'],
    ['authorization', ':spec-authorization'], ['coverage', ':spec-coverage'],
];
const SUBS: Array<[string, string]> = [['from-codespecs', ':ir-from-codespecs'], ['map', ':ir-map'], ['emit', ':ir-emit'], ['export', ':ir-export']];

describe('the tomspecs calls', () => {
    test('TS-1: the call table', () => {
        assert.equal(clitoolCommandLine({ tool: 'codespecs', args: ['--json', '--ir', 'x'] }), 'tomspecs :codespecs-validate --json --ir x');
        assert.deepEqual(Object.entries(SPEC_COMMANDS), CHECKS);
        for (const [check, command] of CHECKS) {
            assert.equal(clitoolCommandLine({ tool: 'spec', args: [check, 'a.yaml'] }), `tomspecs ${command} a.yaml`);
        }
        assert.equal(clitoolCommandLine({ tool: 'spec', args: ['coverage', '--sample', 's.yaml', 'a.yaml'], specRoot: '/r' }),
            'tomspecs :spec-coverage --spec-root /r --sample s.yaml a.yaml', '--spec-root is an option of the command');
        assert.deepEqual(Object.entries(IR_COMMANDS), SUBS);
        for (const [sub, command] of SUBS) {
            assert.equal(clitoolCommandLine({ tool: 'ir', args: [sub, '--ir', 'i'] }), `tomspecs ${command} --ir i`);
        }
        assert.throws(() => clitoolInvocation({ tool: 'ir', args: ['nothing'] }), /no tomspecs command/);
        assert.throws(() => clitoolInvocation({ tool: 'spec', args: ['nothing'] }), /no tomspecs command/);
    });

    test('TS-2: every call runs tomspecs', () => {
        const calls: ClitoolCall[] = [
            { tool: 'codespecs', args: ['--json'] },
            ...CHECKS.map(([check]): ClitoolCall => ({ tool: 'spec', args: [check, 'a.yaml'], specRoot: '/r' })),
            ...SUBS.map(([sub]): ClitoolCall => ({ tool: 'ir', args: [sub, '--ir', 'i'] })),
        ];
        for (const call of calls) {
            const { binary, args } = clitoolInvocation(call);
            assert.equal(binary, CLITOOL_BINARY);
            assert.equal(binary, 'tomspecs');
            assert.ok(!RETIRED.includes(binary), `${call.tool} runs ${binary}`);
            assert.match(args[0], /^:(codespecs|spec|ir)-/, 'the first argument is a tomspecs command');
        }
    });

    test('TS-3: the extension calls tomspecs only', () => {
        const retired = new RegExp(`\\b(${RETIRED.join('|')})\\b`);
        const offenders: string[] = [];
        const walk = (dir: string) => {
            for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
                const abs = path.join(dir, e.name);
                if (e.isDirectory()) { if (e.name !== '__tests__') { walk(abs); } continue; }
                if (!e.name.endsWith('.ts')) { continue; }
                const rel = path.relative(SRC, abs).split(path.sep).join('/');
                // The IR folder `<spec-root>/irspecs/` and the document `irspecs_ir.md` are data, not the binary.
                const text = fs.readFileSync(abs, 'utf8')
                    .replace(/\/irspecs\b|\birspecs\/|IR_DIR = 'irspecs'/g, '');
                if (retired.test(text)) { offenders.push(rel); }
            }
        };
        walk(SRC);
        assert.deepEqual(offenders, [], 'no source names a retired clitool binary');
        for (const b of RETIRED) { assert.ok(!(DART_BINARIES as readonly string[]).includes(b), `${b} is no Dart binary of the extension`); }
    });

    test('TS-4: what the window reports', () => {
        assert.deepEqual(reportedDartBinaries(), ['tom_bs', 'tomspecs']);
    });
});
