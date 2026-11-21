/**
 * The MD Browser following a link whose file is not where the link says (followMdLink in
 * src/handlers/markdownBrowser-handler.ts with src/utils/linkFileSearch.ts), in a nested workspace
 * (a root with `.tom/tom_root.yaml`, the workspace folder below it) through the vscode stub.
 *
 *   MLS-1 the scopes of a window: document folder, quest folder, workspace guidelines, root
 *         guidelines, workspace folder
 *   MLS-2 a link with no folder to a Markdown file elsewhere opens it (at the link's anchor)
 *   MLS-3 a link to a wrong path finds the file in the root's guidelines
 *   MLS-4 several files of the name: a picker lists them; the picked one opens; dismissed opens nothing
 *   MLS-5 a non-Markdown file found opens in an editor at the `#L<n>` line
 *   MLS-6 nothing found anywhere: the warning names the path, as before
 *   MLS-7 a link to an existing file is followed without a search
 */

import test, { describe, after } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

const ROOT = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'md-link-search-')));
const WS = path.join(ROOT, 'ws');
const put = (rel: string, text = '# x\n'): string => {
    const p = path.join(ROOT, rel);
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, text);
    return p;
};
put('.tom/tom_root.yaml', 'version: 1\n');
put('_agent_guidelines/index_root.md');
put('ws/_agent_guidelines/index_workspace.md');
put('ws/_ai/quests/q1/overview.q1.md');
const DOC = put('ws/docs/area/doc.md');

import { installVscodeStub } from '../../tools/__tests__/_vscode-stub.js';

const vscodeStub = installVscodeStub({ workspaceFolders: [WS] });
(vscodeStub.stub.workspace as Record<string, unknown>).workspaceFile = { fsPath: path.join(WS, 'q1.code-workspace'), scheme: 'file' };
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Json = any;
const win = vscodeStub.stub.window as Json;
const warnings: string[] = [];
const editors: Array<{ file: string; line?: number }> = [];
let pickers: Json[][] = [];
let pickAnswer: (items: Json[]) => Json = () => undefined;
win.showWarningMessage = async (m: string) => { warnings.push(m); return undefined; };
win.showTextDocument = async (doc: Json, opts?: Json) => {
    editors.push({ file: doc.fsPath ?? doc.uri?.fsPath, line: opts?.selection?.start?.line });
    return undefined;
};
win.showQuickPick = async (items: Json[]) => { pickers.push(items); return pickAnswer(items); };

import * as layoutMod from '../../utils/workspaceLayout.js';
import { followMdLink, mdLinkSearchScopes } from '../markdownBrowser-handler.js';

layoutMod.resetLayoutForTests();
after(() => { try { fs.rmSync(ROOT, { recursive: true, force: true }); } catch { /* best effort */ } });

const opened: Array<{ file: string; anchor?: string }> = [];
const target = {
    scrollToAnchor: () => undefined,
    openMarkdown: (file: string, anchor?: string) => { opened.push({ file, anchor }); },
};
const reset = (): void => { opened.length = 0; warnings.length = 0; editors.length = 0; pickers = []; pickAnswer = () => undefined; };

describe('MD Browser: links to files elsewhere', () => {
    test('MLS-1: the scopes of the window', () => {
        assert.deepEqual(mdLinkSearchScopes(DOC).map((s) => [s.kind, s.dir]), [
            ['document', path.dirname(DOC)],
            ['quest', path.join(WS, '_ai', 'quests', 'q1')],
            ['workspaceGuidelines', path.join(WS, '_agent_guidelines')],
            ['rootGuidelines', path.join(ROOT, '_agent_guidelines')],
            ['workspace', WS],
        ]);
    });

    test('MLS-2: a link with no folder opens the file found, at the anchor', async () => {
        reset();
        await followMdLink('overview.q1.md#purpose', DOC, target);
        assert.deepEqual(opened, [{ file: path.join(WS, '_ai', 'quests', 'q1', 'overview.q1.md'), anchor: 'purpose' }]);
        assert.deepEqual(pickers, []);
        assert.deepEqual(warnings, []);
    });

    test('MLS-3: a wrong path finds the file in the root guidelines', async () => {
        reset();
        await followMdLink('../../nowhere/index_root.md', DOC, target);
        assert.deepEqual(opened, [{ file: path.join(ROOT, '_agent_guidelines', 'index_root.md'), anchor: undefined }]);
    });

    test('MLS-4: several files: a picker; picked opens, dismissed opens nothing', async () => {
        reset();
        const a = put('ws/pkg_a/doc/guide.md');
        const b = put('ws/pkg_b/doc/guide.md');
        pickAnswer = (items) => items.find((i: Json) => i.file === b);
        await followMdLink('guide.md', DOC, target);
        assert.equal(pickers.length, 1);
        assert.deepEqual(pickers[0].map((i: Json) => [i.label, i.description]), [['guide.md', path.join('pkg_a', 'doc')], ['guide.md', path.join('pkg_b', 'doc')]]);
        assert.deepEqual(opened.map((o) => o.file), [b]);
        assert.ok(fs.existsSync(a));
        reset();
        await followMdLink('guide.md', DOC, target);
        assert.equal(pickers.length, 1);
        assert.deepEqual(opened, []);
        assert.deepEqual(warnings, [], 'a dismissed picker is no error');
    });

    test('MLS-5: a non-Markdown file opens in an editor at its line', async () => {
        reset();
        const code = put('ws/tools/run.sh', 'echo\n');
        await followMdLink('run.sh#L3', DOC, target);
        assert.deepEqual(editors, [{ file: code, line: 2 }]);
    });

    test('MLS-6: nothing found: the warning names the path', async () => {
        reset();
        await followMdLink('missing/none_such.md', DOC, target);
        assert.deepEqual(opened, []);
        assert.equal(warnings.length, 1);
        assert.match(warnings[0], /File not found: missing\/none_such\.md/);
    });

    test('MLS-7: an existing file is followed without a search', async () => {
        reset();
        put('ws/docs/area/next.md');
        await followMdLink('next.md', DOC, target);
        assert.deepEqual(opened.map((o) => o.file), [path.join(WS, 'docs', 'area', 'next.md')]);
        assert.deepEqual(pickers, []);
    });
});
