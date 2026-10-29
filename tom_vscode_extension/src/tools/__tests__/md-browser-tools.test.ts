/**
 * The MD Browser tools (src/tools/md-browser-tools.ts).
 *
 *   MB-1 tomAi_listMdBrowserPanels answers every registered panel with its file (workspace-relative and
 *        absolute), live mode, title, view column, active / visible and unsaved edits; read-only
 *   MB-2 tomAi_getOpenEditors reports an MD Browser tab as `kind: "mdBrowser"` with its file and panel id;
 *        other webview tabs stay `webview` without a file; a tab no panel matches keeps `file: null`
 *   MB-3 the tool is registered: in the executors' list, the Editor Context category and the tool list;
 *        tomAi_getOpenEditors' description names the new kind
 */

import test, { describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { MdBrowserRegistry } from '../../utils/mdBrowserRegistry';
import { LIST_MD_BROWSER_PANELS_TOOL, listMdBrowserPanelsImpl, markMdBrowserTabs, MD_BROWSER_VIEW_TYPE } from '../md-browser-tools';
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
});
