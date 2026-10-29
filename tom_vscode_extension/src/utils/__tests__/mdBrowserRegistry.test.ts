/**
 * The MD Browser's registry of open panels (src/utils/mdBrowserRegistry.ts).
 *
 * Agents could not see which file an MD Browser tab shows: tomAi_getOpenEditors
 * reported it as `kind: webview, file: null`, and only live panels were kept
 * anywhere. The tom_specs process needs to find the tabs showing an earlier
 * version of a document (a step folder's copy, same file name) and close them.
 *
 *   MR-1 every panel is registered with an id, its file, live mode, view column, active/visible and
 *        whether it holds unsaved in-place edits (unknown until the webview reports); unregister removes it
 *   MR-2 titles: `MD: <name>` (`MD (live): ` for live panels); two panels on different files with the
 *        same name get the parent folder appended, so every label names its file
 *   MR-3 a tab is matched to its panel by view column and label; panels on the same file in one column are
 *        matched in registration order; an unknown label matches nothing
 *   MR-4 the list answers workspace-relative and absolute paths
 *   MR-5 the handler registers static, live and restored panels alike, reports navigation, view state and
 *        the webview's open editors; the webview reports its open-editor count
 */

import test, { describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { MdBrowserRegistry } from '../mdBrowserRegistry';

describe('MD Browser registry', () => {
    test('MR-1: register, update, unregister', () => {
        const r = new MdBrowserRegistry();
        const id = r.register({ filePath: '/w/doc/a.md', liveMode: false, viewColumn: 1, active: true, visible: true });
        assert.match(id, /^mdb-\d+$/);
        let [e] = r.entries();
        assert.equal(e.filePath, '/w/doc/a.md');
        assert.equal(e.unsavedEdits, null, 'unknown until the webview reports');
        r.update(id, { unsavedEdits: true, viewColumn: 2, active: false });
        [e] = r.entries();
        assert.equal(e.unsavedEdits, true);
        assert.equal(e.viewColumn, 2);
        assert.equal(e.active, false);
        r.unregister(id);
        assert.equal(r.entries().length, 0);
    });

    test('MR-2: titles name their file', () => {
        const r = new MdBrowserRegistry();
        const a = r.register({ filePath: '/w/spec/02_Deepening/blueprint.md', liveMode: false });
        assert.equal(r.titleOf(a), 'MD: blueprint.md');
        const b = r.register({ filePath: '/w/spec/blueprint.md', liveMode: false });
        assert.equal(r.titleOf(a), 'MD: blueprint.md (02_Deepening)');
        assert.equal(r.titleOf(b), 'MD: blueprint.md (spec)');
        const c = r.register({ filePath: '/w/trail/live-trail.md', liveMode: true });
        assert.equal(r.titleOf(c), 'MD (live): live-trail.md');
        r.unregister(b);
        assert.equal(r.titleOf(a), 'MD: blueprint.md', 'back to the plain title once the name is unique');
        const d = r.register({ filePath: '/w/spec/02_Deepening/blueprint.md', liveMode: false });
        assert.equal(r.titleOf(d), 'MD: blueprint.md', 'the same file twice needs no folder');
    });

    test('MR-3: tabs match by column and label', () => {
        const r = new MdBrowserRegistry();
        const a = r.register({ filePath: '/w/x/a.md', liveMode: false, viewColumn: 1 });
        const b = r.register({ filePath: '/w/y/a.md', liveMode: false, viewColumn: 2 });
        const a2 = r.register({ filePath: '/w/x/a.md', liveMode: false, viewColumn: 1 });
        const matched = r.matchTabs([
            { group: 2, label: r.titleOf(b) },
            { group: 1, label: r.titleOf(a) },
            { group: 1, label: r.titleOf(a2) },
            { group: 1, label: 'Settings' },
        ]);
        assert.deepEqual(matched.map((m) => m?.panelId), [b, a, a2, undefined]);
    });

    test('MR-4: workspace-relative and absolute paths', () => {
        const r = new MdBrowserRegistry();
        r.register({ filePath: '/w/doc/a.md', liveMode: true, viewColumn: 1 });
        const [p] = r.list('/w');
        assert.equal(p.file, 'doc/a.md');
        assert.equal(p.absolutePath, '/w/doc/a.md');
        assert.equal(p.liveMode, true);
        assert.equal(r.list('/elsewhere')[0].file, '/w/doc/a.md', 'outside the workspace: the absolute path');
    });

    test('MR-5: the handler and the webview are wired', () => {
        const src = (...p: string[]) => readFileSync(join(__dirname, '..', '..', '..', ...p), 'utf-8');
        const handler = src('src', 'handlers', 'markdownBrowser-handler.ts');
        assert.match(handler, /mdBrowserRegistry\.register\(/);
        assert.match(handler, /mdBrowserRegistry\.unregister\(/);
        assert.match(handler, /onDidChangeViewState/);
        assert.match(handler, /case 'editState'/);
        assert.match(handler, /mdBrowserRegistry\.titleOf\(/);
        const webview = src('media', 'markdownBrowser', 'main.js');
        assert.match(webview, /type: 'editState'/);
    });
});
