/**
 * Which Dart-built binaries a window has on its platform
 * (services/dartBinariesStatus.ts, vsc_nodart-2), over fake extension roots.
 *
 *   DB-1 bundled: bin/<this platform>/<name> counts; nothing there is missing
 *   DB-2 a bin folder of another platform counts as missing (a VSIX built on macOS, run on Windows)
 *   DB-3 configured: bridge.executables.<name> for this platform, an existing file, wins over the bundled one;
 *        a configured path that names no file is reported and the bundled one is used; a bare name means bundled
 *   DB-4 tom_bs is looked up under the executable the bridge profile names; ${binaryPath} is expanded
 *   DB-5 validateCodespecsBinary() takes the configured binary first, then the bundled one, else throws
 *   DB-6 the page opens once per (build, platform): not when nothing is missing, not twice for one key
 *   DB-7 the page: its placeholders filled for the platform, the missing binaries and the status table
 *   DB-8 the page says what is lost and what keeps working, how to install Dart, build and configure the binaries;
 *        it ships in the VSIX (check-vsix-contents REQUIRED, not excluded by .vscodeignore)
 *   DB-9 the summary windows report (heartbeat, tomAi_getWorkspaceInfo)
 */

import test, { describe } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import {
    dartBinariesHelp,
    dartBinariesStatus,
    fillHelpPage,
    HELP_HINT,
    HELP_PAGE_TEMPLATE,
    helpPageKey,
    rememberHelpPage,
    resolveDartBinary,
    setDartBinariesConfigSource,
    shouldOpenHelpPage,
    summarizeDartBinaries,
} from '../dartBinariesStatus';
import { CodeSpecsBinaryMissing, validateCodespecsBinary } from '../codespecs-validator';
import { getCurrentPlatform } from '../../utils/executableResolver';

const EXT_ROOT = path.resolve(__dirname, '..', '..', '..');
const HOST = getCurrentPlatform();
const EXE = process.platform === 'win32' ? '.exe' : '';
const OTHER = HOST.startsWith('win32') ? 'darwin-arm64' : 'win32-x64';

function fakeRoot(binaries: Record<string, string[]> = {}): string {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dart-binaries-'));
    for (const [platform, names] of Object.entries(binaries)) {
        fs.mkdirSync(path.join(root, 'bin', platform), { recursive: true });
        for (const n of names) { fs.writeFileSync(path.join(root, 'bin', platform, n), ''); }
    }
    return root;
}
function fakeFile(name: string): string {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dart-binary-'));
    const file = path.join(dir, name);
    fs.writeFileSync(file, '');
    return file;
}

describe('Dart-built binaries on this platform', () => {
    test('DB-1: bundled', () => {
        const root = fakeRoot({ [HOST]: [`tom_bs${EXE}`] });
        const s = dartBinariesStatus(root);
        assert.equal(s.platform, HOST);
        assert.deepEqual(s.binaries.map((b) => [b.name, b.source]), [['tom_bs', 'bundled'], ['validate_codespecs', 'missing'], ['spec_checks', 'missing']]);
        assert.equal(s.binaries[0].path, path.join(root, 'bin', HOST, `tom_bs${EXE}`));
        assert.deepEqual(s.missing, ['validate_codespecs', 'spec_checks']);
    });

    test('DB-2: another platform\'s folder is missing here', () => {
        const root = fakeRoot({ [OTHER]: ['tom_bs', 'validate_codespecs', 'spec_checks', 'tom_bs.exe', 'validate_codespecs.exe', 'spec_checks.exe'] });
        assert.deepEqual(dartBinariesStatus(root).missing, ['tom_bs', 'validate_codespecs', 'spec_checks']);
    });

    test('DB-3: configured first', () => {
        const root = fakeRoot({ [HOST]: [`validate_codespecs${EXE}`] });
        const own = fakeFile(`validate_codespecs${EXE}`);
        const configured = resolveDartBinary('validate_codespecs', root, { executables: { validate_codespecs: { [HOST]: own } } }); // eslint-disable-line @typescript-eslint/naming-convention
        assert.deepEqual(configured, { name: 'validate_codespecs', source: 'configured', path: own });
        const gone = path.join(path.dirname(own), `nothing${EXE}`);
        const fallback = resolveDartBinary('validate_codespecs', root, { executables: { validate_codespecs: { '*': gone } } }); // eslint-disable-line @typescript-eslint/naming-convention
        assert.equal(fallback.source, 'bundled');
        assert.equal(fallback.configuredPath, gone);
        const missing = resolveDartBinary('validate_codespecs', fakeRoot(), { executables: { validate_codespecs: { '*': gone } } }); // eslint-disable-line @typescript-eslint/naming-convention
        assert.deepEqual(missing, { name: 'validate_codespecs', source: 'missing', configuredPath: gone });
        const bare = resolveDartBinary('validate_codespecs', root, { executables: { validate_codespecs: { '*': 'validate_codespecs' } } }); // eslint-disable-line @typescript-eslint/naming-convention
        assert.equal(bare.source, 'bundled');
        assert.equal(bare.configuredPath, undefined);
    });

    test('DB-4: tom_bs under the profile\'s executable, ${binaryPath} expanded', () => {
        const own = fakeFile(`tom_bs${EXE}`);
        const r = resolveDartBinary('tom_bs', fakeRoot(), {
            bridgeExecutable: 'bridge_bin',
            binaryPath: { '*': path.dirname(own) + path.sep }, // eslint-disable-line @typescript-eslint/naming-convention
            executables: { bridge_bin: { '*': `\${binaryPath}tom_bs${EXE}` } }, // eslint-disable-line @typescript-eslint/naming-convention
        });
        assert.deepEqual(r, { name: 'tom_bs', source: 'configured', path: own });
        assert.equal(resolveDartBinary('tom_bs', fakeRoot(), { executables: { tom_bs: { '*': own } } }).source, 'configured', // eslint-disable-line @typescript-eslint/naming-convention
            'without a profile executable: tom_bs');
        assert.equal(resolveDartBinary('tom_bs', fakeRoot(), { bridgeExecutable: 'bridge_bin', executables: { tom_bs: { '*': own } } }).source, 'missing', // eslint-disable-line @typescript-eslint/naming-convention
            'another name than the profile\'s is not the bridge');
    });

    test('DB-5: validateCodespecsBinary()', () => {
        const root = fakeRoot({ [HOST]: [`validate_codespecs${EXE}`] });
        const own = fakeFile(`validate_codespecs${EXE}`);
        try {
            setDartBinariesConfigSource(() => ({ executables: { validate_codespecs: { [HOST]: own } } })); // eslint-disable-line @typescript-eslint/naming-convention
            assert.equal(validateCodespecsBinary(root), own, 'configured first');
            assert.equal(validateCodespecsBinary(fakeRoot()), own, 'configured without a bundled one');
            setDartBinariesConfigSource(() => ({}));
            assert.equal(validateCodespecsBinary(root), path.join(root, 'bin', HOST, `validate_codespecs${EXE}`), 'then bundled');
            assert.throws(() => validateCodespecsBinary(fakeRoot()), (e: unknown) => e instanceof CodeSpecsBinaryMissing);
            setDartBinariesConfigSource(() => { throw new Error('unreadable config'); });
            assert.equal(validateCodespecsBinary(root), path.join(root, 'bin', HOST, `validate_codespecs${EXE}`), 'an unreadable config configures nothing');
        } finally {
            setDartBinariesConfigSource(() => ({}));
        }
    });

    test('DB-6: once per build and platform', () => {
        const missing = dartBinariesStatus(fakeRoot());
        const complete = dartBinariesStatus(fakeRoot({ [HOST]: [`tom_bs${EXE}`, `validate_codespecs${EXE}`, `spec_checks${EXE}`] }));
        const build = { commit: 'abc1234', builtAt: '2026-11-08T08:00:00.000Z' };
        const key = helpPageKey(build, 'win32-x64');
        assert.equal(key, 'abc1234@2026-11-08T08:00:00.000Z|win32-x64');
        assert.notEqual(helpPageKey(build, 'darwin-arm64'), key, 'another platform');
        assert.notEqual(helpPageKey({ ...build, builtAt: '2026-11-09T08:00:00.000Z' }, 'win32-x64'), key, 'another build');
        assert.equal(shouldOpenHelpPage(missing, undefined, key), true);
        assert.equal(shouldOpenHelpPage(complete, undefined, key), false, 'nothing missing');
        const shown = rememberHelpPage(undefined, key);
        assert.equal(shouldOpenHelpPage(missing, shown, key), false, 'shown for this build and platform');
        assert.equal(shouldOpenHelpPage(missing, shown, helpPageKey(build, 'linux-x64')), true);
        const many = Array.from({ length: 30 }, (_, i) => `k${i}`).reduce<string[]>((acc, k) => rememberHelpPage(acc, k), []);
        assert.equal(many.length, 20);
        assert.equal(many[19], 'k29');
    });

    test('DB-7: the page filled', () => {
        const template = fs.readFileSync(path.join(EXT_ROOT, HELP_PAGE_TEMPLATE), 'utf8');
        for (const p of ['{{platform}}', '{{missing}}', '{{statusTable}}', '{{binDir}}']) { assert.ok(template.includes(p), p); }
        const root = fakeRoot({ [HOST]: [`tom_bs${EXE}`] });
        const page = fillHelpPage(template, dartBinariesStatus(root), root);
        assert.ok(!page.includes('{{'), 'every placeholder filled');
        assert.match(page, new RegExp(`Platform: \\*\\*${HOST}\\*\\*\\. Missing: \`validate_codespecs${EXE.replace('.', '\\.')}\` \\(CodeSpecs validation\\) and \`spec_checks${EXE.replace('.', '\\.')}\` \\(TomSpecs process checks\\)\\.`));
        assert.match(page, /\| Binary \| Gives \| Status \| File \|/);
        assert.match(page, new RegExp(`\\| \`tom_bs${EXE.replace('.', '\\.')}\` \\| DartScript \\| bundled \\|`));
        assert.match(page, /\| CodeSpecs validation \| \*\*missing\*\* \| — \|/);
        assert.ok(page.includes(path.join(root, 'bin', HOST)), 'the platform folder of the installed extension');
        const none = fillHelpPage(template, dartBinariesStatus(fakeRoot({ [HOST]: [`tom_bs${EXE}`, `validate_codespecs${EXE}`, `spec_checks${EXE}`] })), root);
        assert.match(none, /Missing: none — every binary is available on this platform\./);
    });

    test('DB-8: what the page covers, and that it ships', () => {
        const page = fs.readFileSync(path.join(EXT_ROOT, HELP_PAGE_TEMPLATE), 'utf8');
        for (const covered of [
            // lost: DartScript
            '@T: Restart Bridge', '@T: Execute File', '@T: Execute as\n  Script', '@T: Start Tom CLI Integration Server', 'bridge-side Agent SDK',
            '@T: Toggle Bridge Debug Logging', '@T: Start Tom Process Monitor', '@T: Print Configuration', '@T: Run Tests', 'scripting tools',
            // lost: CodeSpecs validation
            'tomAi_specCodeSpecsValidate', 'tomAi_specCodeSpecsTrace', 'tomAi_specCodeSpecsStatus',
            // lost: TomSpecs process checks
            'tomAi_specImportAnswers', 'tomAi_specCoverage', 'bin/spec_checks.dart', '"spec_checks"',
            // keeps working
            'prompt queue', 'TomSpecs editing', 'extraction, the gate, the verdicts',
            // installing Dart
            'https://dart.dev/get-dart', 'brew install dart', 'winget', 'choco install dart-sdk', 'apt-get install dart',
            // building and configuring
            './compile_and_install.sh', '.\\compile_and_install.ps1', 'npm run codespecs:build', 'dart compile exe',
            '"executables"', '"validate_codespecs"', '"darwin-arm64"', '"linux-x64"', '"win32-x64"', '{{binDir}}',
        ]) {
            assert.ok(page.includes(covered), `the page covers ${JSON.stringify(covered)}`);
        }
        // eslint-disable-next-line @typescript-eslint/no-require-imports
        const { REQUIRED } = require(path.join(EXT_ROOT, 'scripts', 'check-vsix-contents.cjs')) as { REQUIRED: string[] }; // eslint-disable-line @typescript-eslint/naming-convention
        assert.ok(REQUIRED.includes('extension/resources/dart_binaries/missing_dart_binaries.md'));
        const ignore = fs.readFileSync(path.join(EXT_ROOT, '.vscodeignore'), 'utf8').split('\n').map((l) => l.trim());
        assert.ok(!ignore.some((l) => l === 'resources/**' || l.startsWith('resources/dart_binaries')), 'not excluded from the VSIX');
    });

    test('DB-9: the summary', () => {
        const s = summarizeDartBinaries(dartBinariesStatus(fakeRoot({ [HOST]: [`validate_codespecs${EXE}`, `buildkit${EXE}`] }), {}, { PATH: '' }));
        assert.deepEqual(s, {
            platform: HOST,
            binaries: { tom_bs: 'missing', validate_codespecs: 'bundled', spec_checks: 'missing' }, // eslint-disable-line @typescript-eslint/naming-convention
            missing: ['tom_bs', 'spec_checks'],
            buildTools: { buildkit: 'bundled', d4rtgen: 'missing', reflectiongenerator: 'missing', testkit: 'missing' },
        }, 'a missing build tool is not in `missing` (it does not open the page)');
        assert.equal(dartBinariesHelp(EXT_ROOT).help, HELP_HINT);
        assert.equal(HELP_HINT, 'Run command tomAi.showDartBinariesHelp');
    });
});
