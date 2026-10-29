/**
 * tomAi_closeEditor (src/tools/vscode-command-tools.ts): close a file's text
 * editors without focusing anything, never losing unsaved text.
 *
 * Agents could open a file but not close one: they had to focus it and run
 * workbench.action.closeActiveEditor, which closes whatever is active if the
 * focus moved. The tom_specs process closes the editors of a document's earlier
 * version so the user reviews the current one.
 *
 *   CE-1 every text / text-diff tab of the file is closed, in every group by default; other files'
 *        tabs are not touched
 *   CE-2 a tab with unsaved changes is kept and reported, not saved and not closed
 *   CE-3 `save: true` saves the file first and then closes its tabs; a save that fails keeps them
 *   CE-4 a file that is not open is ok with `closed: 0, notOpen: true`
 *   CE-5 `allGroups: false` closes only the active group's tabs
 *   CE-6 a path outside the workspace is refused; a missing `filePath` is refused
 *   CE-7 the tool asks for approval, is registered (executors, category, tool list) and its description
 *        says it never discards changes
 */

import test, { describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { CLOSE_EDITOR_TOOL, closeEditorImpl, type EditorCloser, type EditorTabHandle } from '../vscode-command-tools';
import { withTiming } from './_timing.js';

interface FakeTab extends EditorTabHandle { file: string }

/** An editor area: tabs in groups, one active group, and the files whose save fails. */
function fakeCloser(tabs: FakeTab[], opts: { activeGroup?: number; failSave?: string[] } = {}) {
    const open = [...tabs];
    const saved: string[] = [];
    const closer: EditorCloser = {
        wsRoot: '/w',
        tabsOf(absPath, allGroups) {
            return open.filter((t) => t.file === absPath && (allGroups || t.group === (opts.activeGroup ?? 1)));
        },
        async save(absPath) {
            if (opts.failSave?.includes(absPath)) { return false; }
            saved.push(absPath);
            for (const t of open) { if (t.file === absPath) { t.dirty = false; } }
            return true;
        },
        async close(handles) {
            for (const h of handles) { open.splice(open.indexOf(h as FakeTab), 1); }
            return true;
        },
    };
    return { closer, open, saved };
}

const tab = (file: string, group: number, dirty = false): FakeTab => ({ file, group, dirty });

describe('tomAi_closeEditor', () => {
    test('CE-1: closes the file\'s tabs in every group, nothing else', async () => {
        const f = fakeCloser([tab('/w/a.md', 1), tab('/w/a.md', 2), tab('/w/b.md', 1)]);
        const out = JSON.parse(await withTiming('tomAi_closeEditor:typical', () => closeEditorImpl(f.closer, { filePath: 'a.md' })));
        assert.deepEqual(out, { ok: true, closed: 2, keptDirty: [], notOpen: false });
        assert.deepEqual(f.open.map((t) => t.file), ['/w/b.md']);
    });

    test('CE-2: a dirty tab is kept and reported', async () => {
        const f = fakeCloser([tab('/w/a.md', 1, true), tab('/w/a.md', 2)]);
        const out = JSON.parse(await closeEditorImpl(f.closer, { filePath: '/w/a.md' }));
        assert.equal(out.closed, 1);
        assert.deepEqual(out.keptDirty, [{ group: 1 }]);
        assert.deepEqual(f.saved, [], 'nothing saved without save: true');
        assert.equal(f.open.length, 1);
    });

    test('CE-3: save: true saves, then closes; a failed save keeps the tab', async () => {
        const f = fakeCloser([tab('/w/a.md', 1, true)]);
        const out = JSON.parse(await closeEditorImpl(f.closer, { filePath: 'a.md', save: true }));
        assert.deepEqual(f.saved, ['/w/a.md']);
        assert.equal(out.closed, 1);
        assert.equal(f.open.length, 0);
        const g = fakeCloser([tab('/w/a.md', 1, true)], { failSave: ['/w/a.md'] });
        const kept = JSON.parse(await closeEditorImpl(g.closer, { filePath: 'a.md', save: true }));
        assert.equal(kept.closed, 0);
        assert.deepEqual(kept.keptDirty, [{ group: 1 }]);
        assert.equal(g.open.length, 1);
    });

    test('CE-4: a file not open', async () => {
        const f = fakeCloser([tab('/w/b.md', 1)]);
        assert.deepEqual(JSON.parse(await closeEditorImpl(f.closer, { filePath: 'a.md' })),
            { ok: true, closed: 0, keptDirty: [], notOpen: true });
    });

    test('CE-5: allGroups false closes the active group only', async () => {
        const f = fakeCloser([tab('/w/a.md', 1), tab('/w/a.md', 2)], { activeGroup: 2 });
        const out = JSON.parse(await closeEditorImpl(f.closer, { filePath: 'a.md', allGroups: false }));
        assert.equal(out.closed, 1);
        assert.deepEqual(f.open.map((t) => t.group), [1]);
    });

    test('CE-6: refusals', async () => {
        const f = fakeCloser([]);
        assert.match(JSON.parse(await closeEditorImpl(f.closer, { filePath: '../../etc/passwd' })).error, /outside the workspace/);
        assert.match(JSON.parse(await closeEditorImpl(f.closer, { filePath: '' })).error, /filePath/);
    });

    test('CE-7: approval, registration, description', () => {
        assert.equal(CLOSE_EDITOR_TOOL.readOnly, false);
        assert.equal(CLOSE_EDITOR_TOOL.requiresApproval, true);
        assert.match(CLOSE_EDITOR_TOOL.description, /never discards/i);
        const src = (rel: string) => readFileSync(join(__dirname, '..', '..', '..', 'src', rel), 'utf-8');
        assert.match(src('tools/tool-executors.ts'), /closeEditorImpl\(liveEditorCloser/);
        assert.match(src('utils/toolCategories.ts'), /'tomAi_closeEditor'/);
        assert.match(src('utils/constants.ts'), /'tomAi_closeEditor'/);
    });
});
