/**
 * The MD Browser's panel settings across a reload and Save as default (reading_view 02c_rdv1;
 * src/handlers/markdownBrowser-handler.ts, src/utils/mdBrowserRestore.ts), the real panel code under the
 * vscode stub, whose webview panels record what the host posts and take messages from the webview.
 *
 *   PS-1 a panel's settings (indent on/off and size, search category, reading modes) reported with
 *        `panelSettings` are kept in its record in the workspace state; after a reload the serializer
 *        revives the tab and its `mdContent` carries them again
 *   PS-2 Save as default writes them to the global state; a new panel's `mdContent` carries the defaults, a
 *        revived tab without a record of its own too; without defaults a new panel gets none (null: the
 *        notation's)
 *   PS-3 what the webview sends is checked: a wrong field takes the notation's default
 */

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import test, { after, describe } from 'node:test';
import assert from 'node:assert/strict';

import { installVscodeStub } from '../../tools/__tests__/_vscode-stub.js';

const ws = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'md-browser-settings-')));
const stubbed = installVscodeStub({ workspaceFolders: [ws] });
const win = stubbed.stub.window as Record<string, unknown>;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let serializer: any;
win.registerWebviewPanelSerializer = (_type: string, s: unknown) => { serializer = s; return { dispose: () => undefined }; };

// Safe to import after the stub is wired into the resolver.
import { disposeMarkdownBrowser, registerMarkdownBrowser, openMarkdownBrowser } from '../markdownBrowser-handler.js';
import { setExtensionPath } from '../handler_shared.js';
import { MD_BROWSER_DEFAULTS_KEY, MD_BROWSER_RECORDS_KEY, normalizePanelSettings, type MdPanelRecord } from '../../utils/mdBrowserRestore.js';

const EXT = path.join(__dirname, '..', '..', '..');
setExtensionPath(EXT);
const memento = () => { const m = new Map<string, unknown>(); return { get: (k: string, d?: unknown) => (m.has(k) ? m.get(k) : d), update: async (k: string, v: unknown) => { m.set(k, v); }, keys: () => [...m.keys()] }; };
const workspaceState = memento();
const globalState = memento();
const context = {
    subscriptions: [] as unknown[],
    extensionUri: (stubbed.stub.Uri as { file(p: string): unknown }).file(EXT),
    extensionPath: EXT,
    workspaceState,
    globalState,
} as never;
registerMarkdownBrowser(context);

// eslint-disable-next-line @typescript-eslint/naming-convention -- the stub's test hooks
interface StubWebview { __posted: Array<Record<string, unknown>>; __receive(m: unknown): void }
interface StubPanel { title: string; viewColumn?: number; webview: StubWebview; visible: boolean; dispose(): void }
const panels = () => win.__webviewPanels as StubPanel[];
const lastPanel = () => panels()[panels().length - 1];
const tick = (ms = 5) => new Promise((r) => setTimeout(r, ms));
const file = (name: string) => { const p = path.join(ws, name); fs.writeFileSync(p, `# ${name}\n\nText.\n`); return p; };
const lastContent = (p: StubPanel) => [...p.webview.__posted].reverse().find((m) => m.type === 'mdContent');

const CHOSEN = { indentOn: true, indentSize: 4, searchScope: 'errors', readingModes: { aside: { block: 'shown' }, trace: { span: 'dimmed' } } };

/** A tab VS Code brings back after a reload, as the serializer gets it. */
function revivedTab(title: string, viewColumn: number | undefined): StubPanel {
    const panel = (win.createWebviewPanel as (t: string, title: string) => StubPanel)('tomAi.markdownBrowser', title);
    panel.title = title;
    panel.viewColumn = viewColumn;
    return panel;
}

describe('MD Browser panel settings', () => {
    after(async () => {
        for (const p of panels()) { if (p.visible) { p.dispose(); } }
        await disposeMarkdownBrowser();
    });

    test('PS-2a: without defaults a new panel gets none', async () => {
        openMarkdownBrowser(context, file('plain.md'));
        const panel = lastPanel();
        panel.webview.__receive({ type: 'webviewReady' });
        await tick();
        const content = lastContent(panel);
        assert.ok(content, 'the content was sent');
        assert.equal(content.settings, null, 'the notation\'s defaults');
        panel.dispose();
    });

    test('PS-1: kept in the record, back after a reload', async () => {
        const abs = file('kept.md');
        openMarkdownBrowser(context, abs);
        const panel = lastPanel();
        panel.webview.__receive({ type: 'webviewReady' });
        await tick();
        panel.webview.__receive({ type: 'panelSettings', settings: CHOSEN });
        await tick(400); // the records are written debounced
        const records = workspaceState.get(MD_BROWSER_RECORDS_KEY, []) as MdPanelRecord[];
        const record = records.find((r) => r.filePath === abs);
        assert.ok(record, 'the panel has its record');
        assert.deepEqual(record.settings, CHOSEN, 'its settings beside it');
        assert.equal(globalState.get(MD_BROWSER_DEFAULTS_KEY), undefined, 'not the defaults');
        // The reload: the panel goes, its tab comes back and is revived with the webview's own state.
        const label = record.label;
        const column = record.viewColumn;
        panel.dispose();
        await tick(400);
        workspaceState.update(MD_BROWSER_RECORDS_KEY, records);
        const tab = revivedTab(label, column);
        await serializer.deserializeWebviewPanel(tab, { filePath: abs, liveMode: false });
        tab.webview.__receive({ type: 'webviewReady' });
        await tick();
        assert.deepEqual(lastContent(tab)?.settings, CHOSEN, 'the revived panel shows its previous settings');
        tab.dispose();
    });

    test('PS-2: Save as default, then a new panel', async () => {
        openMarkdownBrowser(context, file('first.md'));
        const first = lastPanel();
        first.webview.__receive({ type: 'webviewReady' });
        await tick();
        const saved = { indentOn: true, indentSize: 6, searchScope: 'all', readingModes: { provenance: { block: 'shown' } } };
        first.webview.__receive({ type: 'panelSettings', settings: saved, saveAsDefault: true });
        await tick();
        assert.deepEqual(globalState.get(MD_BROWSER_DEFAULTS_KEY), saved, 'the defaults in the global state');
        openMarkdownBrowser(context, file('second.md'));
        const second = lastPanel();
        assert.notEqual(second, first);
        second.webview.__receive({ type: 'webviewReady' });
        await tick();
        assert.deepEqual(lastContent(second)?.settings, saved, 'a new panel opens with the saved defaults');
        // A revived tab with no record of its own: the defaults too.
        const tab = revivedTab('MD: unknown.md', 9);
        await serializer.deserializeWebviewPanel(tab, { filePath: file('unknown.md'), liveMode: false });
        tab.webview.__receive({ type: 'webviewReady' });
        await tick();
        assert.deepEqual(lastContent(tab)?.settings, saved);
        for (const p of [first, second, tab]) { p.dispose(); }
    });

    test('PS-3: the settings are checked', () => {
        assert.equal(normalizePanelSettings(null), null);
        assert.equal(normalizePanelSettings('x'), null);
        assert.deepEqual(normalizePanelSettings({}), { indentOn: false, indentSize: 2, searchScope: 'all', readingModes: {} });
        assert.deepEqual(normalizePanelSettings({ indentOn: 'yes', indentSize: 5, searchScope: 'other', readingModes: { 'Bad Kind': { block: 'shown' }, aside: { block: 'x y', span: 'marker' }, trace: 3 } }),
            { indentOn: false, indentSize: 2, searchScope: 'all', readingModes: { aside: { span: 'marker' } } });
    });
});
