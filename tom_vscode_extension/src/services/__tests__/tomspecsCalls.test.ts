/**
 * tom_specs_clitool's calls through the one `tomspecs` binary (tom_specs tsbin7):
 *
 *   TS-1 the call table: every old call becomes its tomspecs command, the old options unchanged after it,
 *        spec_checks' `--spec-root` an option of the command
 *   TS-2 legacy mode (TOM_SPECS_LEGACY_BINARIES=1) gives the old binary and the old argument list
 *   TS-3 the extension calls tomspecs only: no source runs or resolves an old clitool binary by name
 *        outside the call layer and the binary status
 *   TS-4 the window reports tom_bs and tomspecs; the old three only in legacy mode
 */

import test, { describe } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'fs';
import * as path from 'path';
import { clitoolBinary, clitoolCommandLine, clitoolInvocation, IRSPECS_COMMANDS, SPEC_CHECKS_COMMANDS } from '../tomspecsCalls';
import { reportedDartBinaries } from '../dartBinariesStatus';

const SRC = path.resolve(__dirname, '..', '..', '..', 'src');

describe('the tomspecs calls', () => {
    test('TS-1: the call table', () => {
        const t = (call: Parameters<typeof clitoolInvocation>[0]) => clitoolCommandLine(call, false);
        assert.equal(t({ tool: 'validate_codespecs', args: ['--json', '--ir', 'x'] }), 'tomspecs :codespecs-validate --json --ir x');
        const checks: Array<[string, string]> = [
            ['validate', ':spec-render'], ['import-answers', ':spec-import-answers'], ['accept-marks', ':spec-accept-marks'],
            ['required-fields', ':spec-required-fields'], ['question-register', ':spec-question-register'],
            ['feature-register', ':spec-feature-register'], ['project-idea-coverage', ':spec-idea-coverage'],
            ['authorization', ':spec-authorization'], ['coverage', ':spec-coverage'],
        ];
        assert.deepEqual(Object.entries(SPEC_CHECKS_COMMANDS), checks);
        for (const [check, command] of checks) {
            assert.equal(t({ tool: 'spec_checks', args: [check, 'a.yaml'] }), `tomspecs ${command} a.yaml`);
        }
        assert.equal(t({ tool: 'spec_checks', args: ['coverage', '--sample', 's.yaml', 'a.yaml'], specRoot: '/r' }),
            'tomspecs :spec-coverage --spec-root /r --sample s.yaml a.yaml', '--spec-root is an option of the command');
        const subs: Array<[string, string]> = [['from-codespecs', ':ir-from-codespecs'], ['map', ':ir-map'], ['emit', ':ir-emit'], ['export', ':ir-export']];
        assert.deepEqual(Object.entries(IRSPECS_COMMANDS), subs);
        for (const [sub, command] of subs) {
            assert.equal(t({ tool: 'irspecs', args: [sub, '--ir', 'i'] }), `tomspecs ${command} --ir i`);
        }
        assert.throws(() => clitoolInvocation({ tool: 'irspecs', args: ['nothing'] }, false), /no tomspecs command/);
    });

    test('TS-2: legacy mode', () => {
        assert.deepEqual(clitoolInvocation({ tool: 'validate_codespecs', args: ['--json'] }, true), { binary: 'validate_codespecs', args: ['--json'] });
        assert.deepEqual(clitoolInvocation({ tool: 'spec_checks', args: ['coverage', 'a.yaml'], specRoot: '/r' }, true),
            { binary: 'spec_checks', args: ['--spec-root', '/r', 'coverage', 'a.yaml'] });
        assert.deepEqual(clitoolInvocation({ tool: 'irspecs', args: ['map', '--ir', 'i'] }, true), { binary: 'irspecs', args: ['map', '--ir', 'i'] });
        assert.equal(clitoolBinary('irspecs', true), 'irspecs');
        assert.equal(clitoolBinary('irspecs', false), 'tomspecs');
    });

    test('TS-3: the extension calls tomspecs only', () => {
        const allowed = new Set(['services/tomspecsCalls.ts', 'services/dartBinariesStatus.ts']);
        const offenders: string[] = [];
        const walk = (dir: string) => {
            for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
                const abs = path.join(dir, e.name);
                if (e.isDirectory()) { if (e.name !== '__tests__') { walk(abs); } continue; }
                if (!e.name.endsWith('.ts')) { continue; }
                const rel = path.relative(SRC, abs).split(path.sep).join('/');
                if (allowed.has(rel)) { continue; }
                const text = fs.readFileSync(abs, 'utf8');
                if (/(runDartBinary|currentDartBinary|resolveDartBinary)\(\s*'(validate_codespecs|spec_checks|irspecs)'/.test(text)) { offenders.push(rel); }
            }
        };
        walk(SRC);
        assert.deepEqual(offenders, [], 'only the call layer names the old binaries');
    });

    test('TS-4: what the window reports', () => {
        assert.deepEqual(reportedDartBinaries({}), ['tom_bs', 'tomspecs']);
        assert.deepEqual(reportedDartBinaries({ TOM_SPECS_LEGACY_BINARIES: '1' }), ['tom_bs', 'validate_codespecs', 'spec_checks', 'irspecs']); // eslint-disable-line @typescript-eslint/naming-convention
    });
});
