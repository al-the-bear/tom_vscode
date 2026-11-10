/**
 * The page about missing Dart binaries in a window
 * (handlers/dartBinariesHelp-handler.ts, vsc_nodart-2), with the vscode stub.
 *
 *   DH-1 activation with a binary missing opens the filled page (markdown.showPreview of the copy in global
 *        storage) and remembers (build, platform); the next activation of the same build does not open it again
 *   DH-2 nothing missing: the page is not opened, but written (tools can point at it)
 *   DH-3 the help button: an error with "What does this mean?" opens the page when clicked, not otherwise
 *   DH-4 the command is contributed with its title; the Status Page section shows platform, each binary and
 *        the button to the page, and warns when one is missing
 *   DH-5 `dartBinaries` reaches the heartbeat, the WINDOW STATUS answer and tomAi_getWorkspaceInfo
 */

import test, { describe } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import { installVscodeStub } from '../../tools/__tests__/_vscode-stub';

const EXT = path.resolve(__dirname, '..', '..', '..');
let clicked: string | undefined;
const messages: unknown[][] = [];
const stubbed = installVscodeStub({
    methodOverrides: {
        showErrorMessage: async (...args: unknown[]) => { messages.push(['error', ...args]); return clicked; },
        showWarningMessage: async (...args: unknown[]) => { messages.push(['warning', ...args]); return clicked; },
    },
});

// eslint-disable-next-line @typescript-eslint/no-require-imports
const handler = require('../dartBinariesHelp-handler') as typeof import('../dartBinariesHelp-handler');
// eslint-disable-next-line @typescript-eslint/no-require-imports
const status = require('../../services/dartBinariesStatus') as typeof import('../../services/dartBinariesStatus');
// eslint-disable-next-line @typescript-eslint/no-require-imports
const statusPage = require('../statusPage-handler') as typeof import('../statusPage-handler');

const HOST = status.dartBinariesStatus(EXT).platform;
const EXE = process.platform === 'win32' ? '.exe' : '';

function fakeExtension(binaries: string[]): string {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dart-help-ext-'));
    fs.mkdirSync(path.join(root, 'resources', 'dart_binaries'), { recursive: true });
    fs.copyFileSync(path.join(EXT, status.HELP_PAGE_TEMPLATE), path.join(root, status.HELP_PAGE_TEMPLATE));
    fs.mkdirSync(path.join(root, 'out'), { recursive: true });
    fs.writeFileSync(path.join(root, 'out', 'build-info.json'), JSON.stringify({ commit: 'abc1234', dirty: false, builtAt: '2026-11-08T08:00:00.000Z' }));
    fs.mkdirSync(path.join(root, 'bin', HOST), { recursive: true });
    for (const b of binaries) { fs.writeFileSync(path.join(root, 'bin', HOST, `${b}${EXE}`), ''); }
    return root;
}
function fakeContext(root: string, state: Map<string, unknown>): Record<string, unknown> {
    return {
        extensionPath: root,
        globalStorageUri: { fsPath: path.join(root, 'storage') },
        globalState: { get: (k: string) => state.get(k), update: async (k: string, v: unknown) => { state.set(k, v); } },
        subscriptions: [],
    };
}
const previews = (): unknown[][] => stubbed.spies.byMethod('commands.executeCommand').map((c) => c.args).filter((a) => a[0] === 'markdown.showPreview');
const filled = (root: string): string => path.join(root, 'storage', 'dart_binaries', 'missing_dart_binaries.md');

describe('the missing Dart binaries page in a window', () => {
    test('DH-1: opened once per build and platform', () => {
        const root = fakeExtension(['tom_bs']);
        const state = new Map<string, unknown>();
        const before = previews().length;
        handler.initDartBinariesHelp(fakeContext(root, state) as never);
        const opened = previews().slice(before);
        assert.equal(opened.length, 1);
        assert.equal((opened[0][1] as { fsPath: string }).fsPath, filled(root));
        const page = fs.readFileSync(filled(root), 'utf8');
        assert.match(page, new RegExp(`Platform: \\*\\*${HOST}\\*\\*`));
        assert.match(page, /Missing: `validate_codespecs(\.exe)?` \(CodeSpecs validation\)/);
        assert.deepEqual(state.get(handler.HELP_SHOWN_STATE_KEY), [`abc1234@2026-11-08T08:00:00.000Z|${HOST}`]);
        assert.equal(status.dartBinariesHelp().page, filled(root), 'tools point at the filled page');
        handler.initDartBinariesHelp(fakeContext(root, state) as never);
        assert.equal(previews().length, before + 1, 'not again for the same build and platform');
    });

    test('DH-2: nothing missing', () => {
        const root = fakeExtension(['tom_bs', 'validate_codespecs', 'spec_checks']);
        const state = new Map<string, unknown>();
        const before = previews().length;
        handler.initDartBinariesHelp(fakeContext(root, state) as never);
        assert.equal(previews().length, before);
        assert.equal(state.get(handler.HELP_SHOWN_STATE_KEY), undefined);
        assert.match(fs.readFileSync(filled(root), 'utf8'), /Missing: none/);
    });

    test('DH-3: the help button', async () => {
        assert.equal(handler.dartBinariesHelpAction().label, 'What does this mean?');
        const before = previews().length;
        clicked = undefined;
        await handler.showWithDartBinariesHelp('error', 'DartScript is not available');
        assert.equal(previews().length, before, 'dismissed: nothing opens');
        clicked = 'What does this mean?';
        await handler.showWithDartBinariesHelp('warning', 'CodeSpecs validation skipped');
        assert.equal(previews().length, before + 1, 'clicked: the page opens');
        assert.deepEqual(messages.slice(-2), [
            ['error', 'DartScript is not available', 'What does this mean?'],
            ['warning', 'CodeSpecs validation skipped', 'What does this mean?'],
        ]);
        clicked = undefined;
    });

    test('DH-4: command and Status Page section', () => {
        const pkg = JSON.parse(fs.readFileSync(path.join(EXT, 'package.json'), 'utf8'));
        const cmd = pkg.contributes.commands.find((c: { command: string }) => c.command === 'tomAi.showDartBinariesHelp');
        assert.equal(cmd?.title, '@T: Missing Dart Binaries (DartScript / CodeSpecs validation)');
        const missing = status.dartBinariesStatus(fakeExtension(['tom_bs']));
        const html = statusPage.dartBinariesSectionHtml(missing);
        assert.match(html, /data-section="dartBinaries" style="border-color: var\(--vscode-inputValidation-warningBorder\)/);
        assert.match(html, new RegExp(`<label>Platform:</label><span>${HOST}</span>`));
        assert.match(html, /tom_bs(\.exe)? \(DartScript\):<\/label><span title="[^"]+">bundled<\/span>/);
        assert.match(html, /validate_codespecs(\.exe)? \(CodeSpecs validation\):<\/label><span title="">⚠️ missing<\/span>/);
        assert.match(html, /data-status-action="showDartBinariesHelp"/);
        const complete = statusPage.dartBinariesSectionHtml(status.dartBinariesStatus(fakeExtension(['tom_bs', 'validate_codespecs', 'spec_checks'])));
        assert.doesNotMatch(complete, /warningBorder/);
        assert.equal(statusPage.dartBinariesSectionHtml(undefined), '');
    });

    test('DH-5: reported by the window', async () => {
        const summary = status.summarizeDartBinaries(status.dartBinariesStatus(fakeExtension(['tom_bs'])));
        // eslint-disable-next-line @typescript-eslint/no-require-imports
        const { withHeartbeat } = require('../../utils/windowHeartbeat') as typeof import('../../utils/windowHeartbeat');
        const beat = withHeartbeat({ windowId: 'w1_m1' }, { pid: 1, dartBinaries: summary }, new Date());
        assert.deepEqual(beat.dartBinaries, summary);
        // eslint-disable-next-line @typescript-eslint/no-require-imports
        const { buildQuestWindowStatus } = require('../../utils/questWindowStatus') as typeof import('../../utils/questWindowStatus');
        const answer = buildQuestWindowStatus({
            states: [{ ...beat, workspace: 'q', activeQuest: 'q', status: [] } as never],
            sessionsOf: () => [], config: undefined, noApiKey: new Set(), thisHost: 'h', thisMachine: 'm1', thisWindowId: 'w1_m1', nowMs: Date.now(),
        });
        assert.deepEqual(answer.windows[0].dartBinaries, summary);
        // eslint-disable-next-line @typescript-eslint/no-require-imports
        const { getWorkspaceInfoImpl } = require('../../tools/editor-context-tools') as typeof import('../../tools/editor-context-tools');
        const info = JSON.parse(await getWorkspaceInfoImpl({ source: { snapshot: async () => ({
            workspaceName: 'w', workspaceFile: '', workspaceFolders: [], questId: 'q', projects: null, projectsSource: null, git: null, dartBinaries: summary,
        }) } } as never, {}));
        assert.deepEqual(info.dartBinaries, summary);
    });
});
