/**
 * The MD Browser tools (src/tools/md-browser-tools.ts).
 *
 *   MB-1 tomAi_listMdBrowserPanels answers every registered panel with its file (workspace-relative and
 *        absolute), live mode, title, view column, active / visible and unsaved edits; read-only
 *   MB-2 tomAi_getOpenEditors reports an MD Browser tab as `kind: "mdBrowser"` with its file and panel id;
 *        other webview tabs stay `webview` without a file; a tab no panel matches keeps `file: null`
 *   MB-3 the tool is registered: in the executors' list, the Editor Context category and the tool list;
 *        tomAi_getOpenEditors' description names the new kind
 *   MB-4 tomAi_openInMdBrowser opens a `.md` file inside the workspace and answers its panel id; with
 *        `reuse` (default) a panel already showing the file is revealed and re-rendered instead of a
 *        second one (a live request prefers a live panel); `reuse: false` opens a new one
 *   MB-5 open refusals: no filePath, not `.md`, outside the workspace, missing file
 *   MB-6 tomAi_closeMdBrowser closes by panelId, by filePath (every panel on the file), or by `under`
 *        (every panel whose file lies under the folder) except `exceptFilePath`
 *   MB-7 a panel with unsaved in-place edits is kept and reported unless `force: true`
 *   MB-8 close refusals: no selector or two selectors, `exceptFilePath` without `under`, an unknown panelId
 *   MB-9 both tools ask for approval and are wired to the handler's controller and registered
 */

import test, { describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { MdBrowserRegistry } from '../../utils/mdBrowserRegistry';
import {
    CLOSE_MD_BROWSER_TOOL, LIST_MD_BROWSER_PANELS_TOOL, OPEN_IN_MD_BROWSER_TOOL, closeMdBrowserImpl, listMdBrowserPanelsImpl,
    markMdBrowserTabs, MD_BROWSER_VIEW_TYPE, openInMdBrowserImpl, type MdBrowserController,
} from '../md-browser-tools';
import type { TabSnapshot } from '../editor-context-tools';
import { GET_OPEN_EDITORS_DESCRIPTION } from '../editor-context-tools';
import { withTiming } from './_timing.js';

function tab(group: number, label: string, kind: TabSnapshot['kind'] = 'webview'): TabSnapshot {
    return { group, label, file: null, absolutePath: null, kind, active: false, dirty: false, pinned: false, preview: false };
}

describe('MD Browser tools', () => {
    test('MB-1: the panel list', async () => {
        const r = new MdBrowserRegistry();
        r.register({ filePath: '/w/spec/a.md', liveMode: false, viewColumn: 2, active: true, visible: true, unsavedEdits: false });
        const answer = JSON.parse(await withTiming('tomAi_listMdBrowserPanels:typical', () =>
            listMdBrowserPanelsImpl({ registry: r, workspaceRoot: '/w' }, {})));
        assert.equal(answer.count, 1);
        assert.deepEqual(answer.panels[0], {
            panelId: 'mdb-1', file: 'spec/a.md', absolutePath: '/w/spec/a.md', liveMode: false,
            title: 'MD: a.md', viewColumn: 2, active: true, visible: true, unsavedEdits: false,
        });
        assert.equal(LIST_MD_BROWSER_PANELS_TOOL.readOnly, true);
    });

    test('MB-2: open editors name the MD Browser tab\'s file', () => {
        const r = new MdBrowserRegistry();
        const id = r.register({ filePath: '/w/spec/a.md', liveMode: false, viewColumn: 1 });
        const tabs = [tab(1, 'MD: a.md'), tab(1, 'Settings'), tab(1, 'MD: gone.md'), tab(1, 'a.md', 'text')];
        const viewTypes = [`mainThreadWebview-${MD_BROWSER_VIEW_TYPE}`, 'mainThreadWebview-other', `mainThreadWebview-${MD_BROWSER_VIEW_TYPE}`, undefined];
        const out = markMdBrowserTabs(tabs, viewTypes, r, '/w');
        assert.deepEqual({ kind: out[0].kind, file: out[0].file, absolutePath: out[0].absolutePath, panelId: out[0].panelId },
            { kind: 'mdBrowser', file: 'spec/a.md', absolutePath: '/w/spec/a.md', panelId: id });
        assert.equal(out[1].kind, 'webview');
        assert.equal(out[1].file, null);
        assert.equal(out[2].kind, 'mdBrowser');
        assert.equal(out[2].file, null, 'an unmatched MD Browser tab says nothing about a file');
        assert.equal(out[3].kind, 'text');
    });

    test('MB-3: registered', () => {
        const src = (rel: string) => readFileSync(join(__dirname, '..', '..', '..', 'src', rel), 'utf-8');
        assert.match(src('tools/tool-executors.ts'), /MD_BROWSER_TOOLS/);
        assert.match(src('tools/tool-executors.ts'), /markMdBrowserTabs\(/);
        assert.match(src('utils/toolCategories.ts'), /'tomAi_listMdBrowserPanels'/);
        assert.match(src('utils/constants.ts'), /'tomAi_listMdBrowserPanels'/);
        assert.match(GET_OPEN_EDITORS_DESCRIPTION, /mdBrowser/);
    });

    /** A controller over a registry, as the handler provides it, with the calls it received. */
    function controller(files: string[] = []) {
        const registry = new MdBrowserRegistry();
        const calls: string[] = [];
        const c: MdBrowserController = {
            registry,
            workspaceRoot: '/w',
            exists: (p) => files.includes(p),
            open(absPath, opts) {
                calls.push(`open ${absPath}${opts.live ? ' live' : ''}`);
                return registry.register({ filePath: absPath, liveMode: opts.live, viewColumn: opts.viewColumn ?? 1 });
            },
            reveal(panelId) { calls.push(`reveal ${panelId}`); return true; },
            close(panelIds) { for (const id of panelIds) { calls.push(`close ${id}`); registry.unregister(id); } },
        };
        return { c, calls, registry };
    }

    test('MB-4: open, reuse, reuse false', async () => {
        const { c, calls } = controller(['/w/spec/a.md']);
        const first = JSON.parse(await withTiming('tomAi_openInMdBrowser:typical', () => openInMdBrowserImpl(c, { filePath: 'spec/a.md' })));
        assert.deepEqual(first, { ok: true, panelId: 'mdb-1', reused: false, file: 'spec/a.md' });
        const again = JSON.parse(await openInMdBrowserImpl(c, { filePath: '/w/spec/a.md' }));
        assert.deepEqual(again, { ok: true, panelId: 'mdb-1', reused: true, file: 'spec/a.md' });
        const fresh = JSON.parse(await openInMdBrowserImpl(c, { filePath: 'spec/a.md', reuse: false }));
        assert.equal(fresh.panelId, 'mdb-2');
        assert.equal(fresh.reused, false);
        const live = JSON.parse(await openInMdBrowserImpl(c, { filePath: 'spec/a.md', live: true }));
        assert.equal(live.reused, false, 'a live request does not reuse a static panel');
        assert.deepEqual(calls, ['open /w/spec/a.md', 'reveal mdb-1', 'open /w/spec/a.md', 'open /w/spec/a.md live']);
    });

    test('MB-5: open refusals', async () => {
        const { c } = controller(['/w/a.txt']);
        assert.match(JSON.parse(await openInMdBrowserImpl(c, { filePath: '' })).error, /filePath/);
        assert.match(JSON.parse(await openInMdBrowserImpl(c, { filePath: 'a.txt' })).error, /\.md/);
        assert.match(JSON.parse(await openInMdBrowserImpl(c, { filePath: '../x.md' })).error, /outside the workspace/);
        assert.match(JSON.parse(await openInMdBrowserImpl(c, { filePath: 'gone.md' })).error, /not found/);
    });

    test('MB-6: close by panelId, by file, by folder except one file', async () => {
        const { c, registry } = controller();
        const a1 = registry.register({ filePath: '/w/spec/02_Deepening/b.md', liveMode: false });
        const a2 = registry.register({ filePath: '/w/spec/03_Review/b.md', liveMode: false });
        const cur = registry.register({ filePath: '/w/spec/b.md', liveMode: false });
        const other = registry.register({ filePath: '/w/doc/x.md', liveMode: false });
        let out = JSON.parse(await withTiming('tomAi_closeMdBrowser:typical', () =>
            closeMdBrowserImpl(c, { under: 'spec', exceptFilePath: 'spec/b.md' })));
        assert.deepEqual(out.closed.map((p: { panelId: string }) => p.panelId), [a1, a2]);
        assert.deepEqual(registry.entries().map((e) => e.panelId), [cur, other]);
        out = JSON.parse(await closeMdBrowserImpl(c, { filePath: 'doc/x.md' }));
        assert.deepEqual(out.closed.map((p: { panelId: string }) => p.panelId), [other]);
        out = JSON.parse(await closeMdBrowserImpl(c, { panelId: cur }));
        assert.deepEqual(out, { ok: true, closed: [{ panelId: cur, file: 'spec/b.md' }], kept: [] });
    });

    test('MB-7: unsaved in-place edits are kept unless forced', async () => {
        const { c, registry } = controller();
        const dirty = registry.register({ filePath: '/w/spec/b.md', liveMode: false, unsavedEdits: true });
        let out = JSON.parse(await closeMdBrowserImpl(c, { filePath: 'spec/b.md' }));
        assert.deepEqual(out.closed, []);
        assert.deepEqual(out.kept, [{ panelId: dirty, file: 'spec/b.md', reason: 'unsaved in-place edits' }]);
        out = JSON.parse(await closeMdBrowserImpl(c, { filePath: 'spec/b.md', force: true }));
        assert.equal(out.closed.length, 1);
    });

    test('MB-8: close refusals', async () => {
        const { c } = controller();
        assert.match(JSON.parse(await closeMdBrowserImpl(c, {})).error, /exactly one/);
        assert.match(JSON.parse(await closeMdBrowserImpl(c, { panelId: 'mdb-1', filePath: 'a.md' })).error, /exactly one/);
        assert.match(JSON.parse(await closeMdBrowserImpl(c, { filePath: 'a.md', exceptFilePath: 'b.md' })).error, /exceptFilePath/);
        assert.match(JSON.parse(await closeMdBrowserImpl(c, { panelId: 'mdb-99' })).error, /no MD Browser panel/i);
    });

    test('MB-9: approval and wiring', () => {
        for (const t of [OPEN_IN_MD_BROWSER_TOOL, CLOSE_MD_BROWSER_TOOL]) {
            assert.equal(t.readOnly, false);
            assert.equal(t.requiresApproval, true);
        }
        const src = (rel: string) => readFileSync(join(__dirname, '..', '..', '..', 'src', rel), 'utf-8');
        assert.match(src('tools/tool-executors.ts'), /openInMdBrowserImpl\(mdBrowserController/);
        assert.match(src('tools/tool-executors.ts'), /closeMdBrowserImpl\(mdBrowserController/);
        assert.match(src('handlers/markdownBrowser-handler.ts'), /export const mdBrowserController/);
        for (const name of ['tomAi_openInMdBrowser', 'tomAi_closeMdBrowser']) {
            assert.match(src('utils/toolCategories.ts'), new RegExp(`'${name}'`));
            assert.match(src('utils/constants.ts'), new RegExp(`'${name}'`));
        }
    });
});
