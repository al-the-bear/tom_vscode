/**
 * `tomAi_askInMdBrowser` end to end in the MD Browser (ccparity_i_assist-1):
 * the registered tool's execute against the real panel code
 * (markdownBrowser-handler.ts) under the vscode stub, whose webview panels
 * record what the host posts and take messages from the webview.
 *
 *   MA-1 the ask opens a panel on the file; once the webview is ready it gets the bar (requestId, buttons,
 *        keepFile); the webview's `askAnswer` answers the tool; the bar is taken off with the answer as note;
 *        the file stays
 *   MA-2 `askKeepFile` unchecked, then a click: the file is deleted and the panel closed
 *   MA-3 a panel already showing the file is reused and gets the bar at once; closing it answers `closed`
 *   MA-4 a second ask of the same process run while one is open is refused (vscimpb81)
 *   MA-5 deactivation cancels an open ask (disposeMarkdownBrowser, which also stops the comments worker)
 */

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import test, { after, describe } from 'node:test';
import assert from 'node:assert/strict';

import { installVscodeStub } from '../../tools/__tests__/_vscode-stub.js';

const ws = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'md-browser-ask-')));
const stubbed = installVscodeStub({ workspaceFolders: [ws] });
const win = stubbed.stub.window as Record<string, unknown>;
win.registerWebviewPanelSerializer = () => ({ dispose: () => undefined });

// Safe to import after the stub is wired into the resolver.
import { disposeMarkdownBrowser, registerMarkdownBrowser, openMarkdownBrowser } from '../markdownBrowser-handler.js';
import { setExtensionPath } from '../handler_shared.js';
import { ASK_IN_MD_BROWSER_TOOL } from '../../tools/ask-in-md-browser-tool.js';
import '../../tools/tool-executors.js';

const EXT = path.join(__dirname, '..', '..', '..');
setExtensionPath(EXT);
const memento = () => { const m = new Map<string, unknown>(); return { get: (k: string, d?: unknown) => (m.has(k) ? m.get(k) : d), update: async (k: string, v: unknown) => { m.set(k, v); }, keys: () => [...m.keys()] }; };
const context = {
    subscriptions: [] as unknown[],
    extensionUri: (stubbed.stub.Uri as { file(p: string): unknown }).file(EXT),
    extensionPath: EXT,
    workspaceState: memento(),
    globalState: memento(),
} as never;
registerMarkdownBrowser(context);

// eslint-disable-next-line @typescript-eslint/naming-convention -- the stub's test hooks
interface StubWebview { __posted: Array<Record<string, unknown>>; __receive(m: unknown): void }
interface StubPanel { webview: StubWebview; visible: boolean; dispose(): void }
const panels = () => win.__webviewPanels as StubPanel[];
const lastPanel = () => panels()[panels().length - 1];
const tick = () => new Promise((r) => setTimeout(r, 5));
const file = (name: string) => { const p = path.join(ws, name); fs.writeFileSync(p, `# ${name}\n\nPlease review.\n`); return p; };
const BUTTONS = [{ id: 'continue', label: 'Continue' }, { id: 'cancel', label: 'Cancel' }];
const bars = (p: StubPanel) => p.webview.__posted.filter((m) => m.type === 'askBar');

describe('tomAi_askInMdBrowser in the MD Browser', () => {
    // Open panels poll their file and the comments worker runs: stop both, so the process can end.
    after(async () => {
        for (const p of panels()) { if (p.visible) { p.dispose(); } }
        await disposeMarkdownBrowser();
    });

    test('MA-5: deactivation ends an open ask', async () => {
        file('ask5.md');
        const call = ASK_IN_MD_BROWSER_TOOL.execute({ filePath: 'ask5.md', buttons: BUTTONS });
        await tick();
        await disposeMarkdownBrowser();
        assert.equal(JSON.parse(await call).cancelled, true);
        lastPanel().dispose();
        assert.match(fs.readFileSync(path.join(EXT, 'src', 'extension.ts'), 'utf8'), /m\.disposeMarkdownBrowser\(\)/, 'called at deactivation');
    });

    test('MA-1: open, bar, answer', async () => {
        const abs = file('ask1.md');
        const before = panels().length;
        let answered: string | undefined;
        const call = ASK_IN_MD_BROWSER_TOOL.execute({ filePath: 'ask1.md', buttons: BUTTONS, title: 'Go on?' }).then((s) => { answered = s; return s; });
        await tick();
        assert.equal(panels().length, before + 1, 'a panel opened');
        const panel = lastPanel();
        assert.equal(bars(panel).length, 0, 'not before the webview is ready');
        panel.webview.__receive({ type: 'webviewReady' });
        await tick();
        const bar = bars(panel)[0]?.bar as Record<string, unknown>;
        assert.ok(bar, 'the bar is sent once the webview is ready');
        assert.deepEqual(bar.buttons, BUTTONS);
        assert.equal(bar.keepFile, true);
        assert.equal(bar.title, 'Go on?');
        assert.equal(answered, undefined, 'still waiting');
        panel.webview.__receive({ type: 'askAnswer', requestId: bar.requestId, button: 'continue', keepFile: true });
        const out = JSON.parse(await call);
        assert.equal(out.button, 'continue');
        assert.equal(out.keepFile, true);
        assert.equal(out.file, 'ask1.md');
        assert.ok(fs.existsSync(abs), 'kept');
        assert.deepEqual(panel.webview.__posted.find((m) => m.type === 'askBarClear'), { type: 'askBarClear', requestId: bar.requestId, note: 'Answered: Continue' });
        assert.equal(panel.visible, true, 'the panel stays');
    });

    test('MA-2: unchecked, then a click: the file is deleted', async () => {
        const abs = file('ask2.md');
        const call = ASK_IN_MD_BROWSER_TOOL.execute({ filePath: abs, buttons: BUTTONS });
        await tick();
        const panel = lastPanel();
        panel.webview.__receive({ type: 'webviewReady' });
        await tick();
        const requestId = (bars(panel)[0].bar as { requestId: string }).requestId;
        panel.webview.__receive({ type: 'askKeepFile', requestId, keepFile: false });
        panel.webview.__receive({ type: 'askAnswer', requestId, button: 'cancel', keepFile: false });
        const out = JSON.parse(await call);
        assert.equal(out.button, 'cancel');
        assert.equal(out.fileDeleted, true);
        assert.ok(!fs.existsSync(abs), 'deleted');
        assert.equal(panel.visible, false, 'its panel closed');
    });

    test('MA-3: a panel on the file is reused; closing it answers', async () => {
        const abs = file('ask3.md');
        openMarkdownBrowser(context, abs);
        const panel = lastPanel();
        panel.webview.__receive({ type: 'webviewReady' });
        await tick();
        const count = panels().length;
        const call = ASK_IN_MD_BROWSER_TOOL.execute({ filePath: 'ask3.md', buttons: BUTTONS });
        await tick();
        assert.equal(panels().length, count, 'no new panel');
        assert.equal(bars(panel).length, 1, 'the bar at once: the webview is ready');
        panel.dispose();
        const out = JSON.parse(await call);
        assert.equal(out.button, null);
        assert.equal(out.closed, true);
        assert.ok(fs.existsSync(abs));
    });

    test('MA-4: one per process run', async () => {
        file('ask4.md');
        const first = ASK_IN_MD_BROWSER_TOOL.execute({ filePath: 'ask4.md', buttons: BUTTONS });
        await tick();
        const second = JSON.parse(await ASK_IN_MD_BROWSER_TOOL.execute({ filePath: 'ask4.md', buttons: BUTTONS }));
        assert.match(second.error, /of run "default" is already open — one per process run/);
        lastPanel().dispose();
        assert.equal(JSON.parse(await first).closed, true);
    });
});
