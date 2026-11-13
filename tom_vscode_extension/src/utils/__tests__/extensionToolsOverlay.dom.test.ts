/**
 * The chat panels' Extension Tools overlay (media/chatPanel/main.js, chatPanel-handler.ts, the catalogue
 * src/utils/extensionToolsCatalog.ts), in a JSDOM running the real script with the catalogue the host passes.
 *
 *   EO-1 both subpanels: the tools button (codicon-tools) reads "Extension Tools" and opens the one overlay, headed
 *        "Extension Tools"; no context field (Quest, Role, Projects, Todo File, Todo), no auto-hide, no Apply / Cancel
 *   EO-2 the groups in the catalogue's order, each with its entries' buttons (icon, label, the purpose as title); the
 *        overlay is ~90% of the panel's width and lays the groups out in a grid of at most four columns
 *   EO-3 a button posts `openExtensionTool` with its entry's id and closes the overlay; Close, Escape and a click
 *        beside the popup close it too
 *   EO-4 the host: the entry by id runs its command, or opens the Status Page at its section; an unknown id runs
 *        nothing; the webview gets the catalogue without commands; the messages only the context form sent are gone
 *   EO-5 no Context & Settings names are left for it; the plan and approval overlays keep working on their own
 *        `modal-*` classes
 */

import test, { describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { JSDOM } from 'jsdom';

import { EXTENSION_TOOLS, TOOL_GROUPS, extensionToolsForWebview, openExtensionTool } from '../extensionToolsCatalog.js';

const ROOT = join(__dirname, '..', '..', '..');
const read = (...parts: string[]): string => readFileSync(join(ROOT, ...parts), 'utf-8');

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Win = any;

function setup(t: { after(fn: () => void): void }) {
    const html = read('media', 'chatPanel', 'index.html').replace(/<script[\s\S]*?<\/script>/g, '');
    const dom = new JSDOM(html, { runScripts: 'outside-only' });
    const w = dom.window as Win;
    t.after(() => w.close());
    const posted: Array<Record<string, unknown>> = [];
    w.acquireVsCodeApi = () => ({
        postMessage: (m: Record<string, unknown>) => posted.push(JSON.parse(JSON.stringify(m))),
        setState: () => undefined,
        getState: () => ({ expanded: ['copilot', 'anthropic'], pinned: [] }),
    });
    w.__INIT__ = { extensionTools: extensionToolsForWebview() };
    w.eval(read('media', 'chatPanel', 'main.js'));
    const $ = (id: string) => w.document.getElementById(id);
    const overlay = () => $('extension-tools-overlay');
    return { w, posted, $, overlay };
}

describe('the chat panels\' Extension Tools overlay', () => {
    test('EO-1: both subpanels open it', (t) => {
        const s = setup(t);
        for (const section of ['copilot', 'anthropic']) {
            const btn = s.w.document.querySelector(`[data-action="openExtensionTools"][data-id="${section}"]`);
            assert.ok(btn, section);
            assert.equal(btn.title, 'Extension Tools');
            assert.ok(btn.querySelector('.codicon-tools'));
            assert.equal(s.overlay().style.display, 'none');
            btn.click();
            assert.equal(s.overlay().style.display, 'flex', `${section} opens it`);
            s.w.document.querySelector('[data-action="closeExtensionTools"]').click();
            assert.equal(s.overlay().style.display, 'none');
        }
        assert.equal(s.w.document.querySelectorAll('#extension-tools-overlay').length, 1, 'one shared overlay');
        assert.equal(s.overlay().querySelector('.modal-popup-header span').textContent, 'Extension Tools');
        for (const id of ['ctx-quest', 'ctx-role', 'ctx-projects', 'ctx-todoFile', 'ctx-todo', 'copilot-context-overlay']) { assert.equal(s.$(id), null, id); }
        assert.equal(s.overlay().querySelector('select, input'), null, 'no fields');
        assert.doesNotMatch(s.overlay().textContent, /Apply|Cancel|Auto-hide/);
    });

    test('EO-2: the groups and the layout', (t) => {
        const s = setup(t);
        const groups = [...s.overlay().querySelectorAll('.extension-tools-group')];
        assert.deepEqual(groups.map((g: Win) => g.dataset.group), TOOL_GROUPS.map((g) => g.id));
        for (const g of groups as Win[]) {
            const ids = [...g.querySelectorAll('.extension-tool-btn')].map((b: Win) => b.dataset.id);
            assert.deepEqual(ids, EXTENSION_TOOLS.filter((x) => x.group === g.dataset.group).map((x) => x.id));
            assert.match(g.querySelector('.extension-tools-group-title').textContent, new RegExp(TOOL_GROUPS.find((x) => x.id === g.dataset.group)!.label.replace(/[&]/g, '\\&')));
        }
        const queue = s.overlay().querySelector('[data-id="promptQueue"]');
        assert.equal(queue.querySelector('.extension-tool-label').textContent, 'Prompt Queue Editor');
        assert.ok(queue.querySelector('.codicon-list-flat'));
        assert.match(queue.title, /queue of every process run/);
        assert.match(s.overlay().querySelector('[data-id="telegram"]').title, /opens the Status Page at this section/);
        assert.match(s.overlay().querySelector('[data-id="processBranching"]').title, /\(when the running step lists subprocesses or branches\)/);
        const css = read('media', 'chatPanel', 'style.css');
        assert.match(css, /\.modal-popup\.extension-tools-popup \{ width: 90%; max-width: none; \}/);
        // auto-fill with a minimum column width of a quarter of the row (less the three gaps): at most four columns.
        assert.match(css, /\.extension-tools-grid \{ display: grid; gap: 12px; grid-template-columns: repeat\(auto-fill, minmax\(max\(200px, calc\(\(100% - 36px\) \/ 4\)\), 1fr\)\);/);
        assert.ok(s.overlay().querySelector('.modal-popup-body').classList.contains('extension-tools-grid'));
    });

    test('EO-3: the buttons', (t) => {
        const s = setup(t);
        const open = () => s.w.document.querySelector('[data-action="openExtensionTools"][data-id="anthropic"]').click();
        for (const tool of EXTENSION_TOOLS) {
            open();
            s.overlay().querySelector(`[data-id="${tool.id}"]`).click();
            assert.deepEqual(s.posted.at(-1), { type: 'openExtensionTool', toolId: tool.id }, tool.id);
            assert.equal(s.overlay().style.display, 'none', `${tool.id} closes it`);
        }
        open();
        s.w.document.dispatchEvent(new s.w.KeyboardEvent('keydown', { key: 'Escape' }));
        assert.equal(s.overlay().style.display, 'none', 'Escape');
        open();
        s.overlay().querySelector('.modal-popup-header span').click();
        assert.equal(s.overlay().style.display, 'flex', 'a click inside stays');
        s.overlay().click();
        assert.equal(s.overlay().style.display, 'none', 'a click beside the popup');
    });

    test('EO-4: the host', async () => {
        const runs: unknown[][] = [];
        const run = async (...a: unknown[]) => { runs.push(a); };
        for (const tool of EXTENSION_TOOLS) {
            runs.length = 0;
            assert.equal(await openExtensionTool(tool.id, run), true);
            assert.deepEqual(runs, [tool.command ? [tool.command] : ['tomAi.statusPage', tool.statusSection]], tool.id);
        }
        runs.length = 0;
        assert.equal(await openExtensionTool('nope', run), false);
        assert.deepEqual(runs, []);
        const forWebview = extensionToolsForWebview();
        assert.equal(forWebview.tools.length, EXTENSION_TOOLS.length);
        assert.ok(forWebview.tools.every((x) => !('command' in x) && !('statusSection' in x)), 'no commands');
        assert.ok(forWebview.tools.filter((x) => x.statusPageSection).every((x) => EXTENSION_TOOLS.find((e) => e.id === x.id)!.statusSection));
        const h = read('src', 'handlers', 'chatPanel-handler.ts');
        assert.match(h, /case 'openExtensionTool':\s+if \(!await openExtensionTool\(String\(message\.toolId \?\? ''\), \(command, \.\.\.args\) => vscode\.commands\.executeCommand\(command, \.\.\.args\)\)\)/);
        assert.match(h, /extensionTools: extensionToolsForWebview\(\),/);
        for (const gone of ['getContextData', 'applyContext', 'getTodosForFile', 'getContextDataForQuest', 'openGlobalTemplateEditor', 'openReusablePromptEditor']) {
            assert.ok(!h.includes(`case '${gone}'`), `the message ${gone}`);
        }
        for (const gone of ['_sendContextData', '_applyContext', '_sendTodosForFile', '_sendTodoFilesForQuest', "'contextData'", 'contextTodoFiles', 'contextTodosUpdate']) {
            assert.ok(!h.includes(gone), gone);
        }
        assert.match(h, /this\._summaryListener = ChatVariablesStore\.instance\.onDidChange\(/, 'the status line\'s summary follows the variables');
    });

    test('EO-5: no Context & Settings names; the plan and approval overlays', (t) => {
        const js = read('media', 'chatPanel', 'main.js');
        const css = read('media', 'chatPanel', 'style.css');
        for (const src of [js, css]) {
            assert.doesNotMatch(src, /Context & Settings|context-overlay|context-popup|ContextPopup|applyContext|contextData|ctx-quest|link-btn|context-group|context-row/);
        }
        const s = setup(t);
        for (const id of ['anthropic-plan-overlay', 'anthropic-approval-overlay']) {
            const o = s.$(id);
            assert.ok(o.classList.contains('modal-overlay'), id);
            assert.ok(o.querySelector('.modal-popup .modal-popup-header') && o.querySelector('.modal-popup-footer'), id);
        }
        assert.match(css, /^\.modal-overlay \{ position: fixed;/m);
    });
});
