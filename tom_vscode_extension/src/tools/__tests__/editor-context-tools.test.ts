/**
 * Tool-impl tests for `editor-context-tools.ts` — `tomAi_getWorkspaceInfo`,
 * `tomAi_getActiveEditor`, `tomAi_getOpenEditors`.
 *
 * Strategy: pass synthetic snapshots through the narrow source
 * interfaces (`WorkspaceInfoSource` / `ActiveEditorSource` /
 * `OpenEditorsSource`). The bridges in `tool-executors.ts` are where
 * the vscode-side conversion happens; those are integration concerns
 * tested separately by the extension's reload smoke runs.
 *
 * Coverage entry #9 four-row checklist:
 *
 *   a) Description clarity — verified in the impl file; "open editor"
 *      includes every tab across all view-column groups; the
 *      response field list is spelled out.
 *   b) Ambiguities — covered:
 *        - untitled documents (untitled: true + scheme: 'untitled')
 *        - output-channel pseudo-documents (scheme: 'output')
 *        - non-text tab kinds (webview, terminal, custom → file:null + kind)
 *        - no git repo / no tom_master.yaml (null in response, not missing)
 *        - includeGit: false short-circuit (no git surface)
 *   c) Tests with snapshot-style fakes that mirror what the real
 *      vscode bridge would produce.
 *   d) Timing — all three typical cases sub-ms via `withTiming`.
 */

import test, { describe } from 'node:test';
import assert from 'node:assert/strict';

import { withTiming } from './_timing.js';
import {
    getActiveEditorImpl,
    getOpenEditorsImpl,
    getWorkspaceInfoImpl,
    type ActiveEditorSource,
    type EditorSnapshot,
    type OpenEditorsSource,
    type TabSnapshot,
    type WorkspaceInfoSnapshot,
    type WorkspaceInfoSource,
} from '../editor-context-tools.js';

// ===========================================================================
// Snapshot fixtures
// ===========================================================================

const TYPICAL_WORKSPACE: WorkspaceInfoSnapshot = {
    workspaceName: 'tom_agent_container',
    workspaceFile: '/ws/.tom.code-workspace',
    workspaceFolders: [
        { name: 'tom_agent_container', fsPath: '/ws' },
        { name: 'extras', fsPath: '/ws-extras' },
    ],
    questId: 'vscode_extension',
    projects: [
        { id: 'tom_vscode_extension', name: 'Tom VS Code Extension', path: 'tom_ai/vscode/tom_vscode_extension', type: 'dart' },
        { id: 'tom_basics', name: 'Tom Basics', path: 'tom_ai/basics/tom_basics', type: 'dart' },
    ],
    projectsSource: '/ws/.tom_metadata/tom_master.yaml',
    git: { branch: 'main', commit: 'abc1234', dirty: false, remote: 'git@github.com:al-the-bear/tom_vscode.git' },
};

const TYPICAL_EDITOR: EditorSnapshot = {
    file: 'src/extension.ts',
    absolutePath: '/ws/src/extension.ts',
    scheme: 'file',
    language: 'typescript',
    lineCount: 250,
    dirty: false,
    untitled: false,
    cursor: { line: 42, character: 18 },
    selection: {
        startLine: 40,
        startCharacter: 0,
        endLine: 42,
        endCharacter: 18,
        isEmpty: false,
        text: 'export const foo = () =>\n    bar(\n        \'hello\'',
    },
    visibleRange: { startLine: 20, endLine: 60 },
};

const TYPICAL_TABS: TabSnapshot[] = [
    {
        group: 1, label: 'extension.ts', file: 'src/extension.ts', absolutePath: '/ws/src/extension.ts',
        kind: 'text', active: true, dirty: false, pinned: true, preview: false,
    },
    {
        group: 1, label: 'config.json', file: 'config.json', absolutePath: '/ws/config.json',
        kind: 'text', active: false, dirty: true, pinned: false, preview: false,
    },
    {
        group: 2, label: 'Welcome', file: null, absolutePath: null,
        kind: 'webview', active: true, dirty: false, pinned: false, preview: false,
    },
    {
        group: 2, label: 'bash', file: null, absolutePath: null,
        kind: 'terminal', active: false, dirty: false, pinned: false, preview: false,
    },
];

// ===========================================================================
// getWorkspaceInfo
// ===========================================================================

function makeWsSource(snapshot: WorkspaceInfoSnapshot): WorkspaceInfoSource & { calls: Array<{ includeGit: boolean }> } {
    const calls: Array<{ includeGit: boolean }> = [];
    return {
        calls,
        async snapshot(opts) {
            calls.push(opts);
            return snapshot;
        },
    };
}

describe('getWorkspaceInfoImpl', () => {

    test('typical call returns the full envelope with projects + git', async () => {
        const src = makeWsSource(TYPICAL_WORKSPACE);
        const raw = await withTiming('tomAi_getWorkspaceInfo:typical', () =>
            getWorkspaceInfoImpl({ source: src }, {}));
        const r = JSON.parse(raw);
        assert.equal(r.workspaceName, 'tom_agent_container');
        assert.equal(r.workspaceFile, '/ws/.tom.code-workspace');
        assert.equal(r.quest, 'vscode_extension');
        assert.equal(r.workspaceFolders.length, 2);
        assert.equal(r.workspaceFolders[0].index, 0);
        assert.equal(r.workspaceFolders[1].name, 'extras');
        assert.equal(r.projects.length, 2);
        assert.equal(r.projects[0].id, 'tom_vscode_extension');
        assert.equal(r.projectsSource, '/ws/.tom_metadata/tom_master.yaml');
        assert.equal(r.git.branch, 'main');
    });

    test('quest "default" is rendered as empty string', async () => {
        const src = makeWsSource({ ...TYPICAL_WORKSPACE, questId: 'default' });
        const r = JSON.parse(await getWorkspaceInfoImpl({ source: src }, {}));
        assert.equal(r.quest, '');
    });

    test('no tom_master.yaml → projects: null, projectsSource: null (not missing)', async () => {
        const src = makeWsSource({ ...TYPICAL_WORKSPACE, projects: null, projectsSource: null });
        const r = JSON.parse(await getWorkspaceInfoImpl({ source: src }, {}));
        assert.equal(r.projects, null);
        assert.equal(r.projectsSource, null);
    });

    test('no git repo → git: null (so the model can tell)', async () => {
        const src = makeWsSource({ ...TYPICAL_WORKSPACE, git: null });
        const r = JSON.parse(await getWorkspaceInfoImpl({ source: src }, {}));
        assert.equal(r.git, null);
    });

    test('includeGit: false is forwarded to the source', async () => {
        const src = makeWsSource(TYPICAL_WORKSPACE);
        await getWorkspaceInfoImpl({ source: src }, { includeGit: false });
        assert.equal(src.calls[0].includeGit, false);
    });

    test('includeGit defaults to true when omitted', async () => {
        const src = makeWsSource(TYPICAL_WORKSPACE);
        await getWorkspaceInfoImpl({ source: src }, {});
        assert.equal(src.calls[0].includeGit, true);
    });
});

// ===========================================================================
// getActiveEditor
// ===========================================================================

function makeEditorSource(snap: EditorSnapshot | null): ActiveEditorSource & { calls: Array<{ includeSelectionText: boolean; maxSelectionChars: number }> } {
    const calls: Array<{ includeSelectionText: boolean; maxSelectionChars: number }> = [];
    return {
        calls,
        snapshot(opts) { calls.push(opts); return snap; },
    };
}

describe('getActiveEditorImpl', () => {

    test('typical call returns the full editor snapshot', async () => {
        const src = makeEditorSource(TYPICAL_EDITOR);
        const raw = await withTiming('tomAi_getActiveEditor:typical', () =>
            getActiveEditorImpl({ source: src }, {}));
        const r = JSON.parse(raw);
        assert.equal(r.active, true);
        assert.equal(r.file, 'src/extension.ts');
        assert.equal(r.absolutePath, '/ws/src/extension.ts');
        assert.equal(r.scheme, 'file');
        assert.equal(r.language, 'typescript');
        assert.equal(r.dirty, false);
        assert.equal(r.untitled, false);
        // 1-based positions
        assert.equal(r.cursor.line, 42);
        assert.equal(r.selection.startLine, 40);
        assert.equal(r.selection.charLength, TYPICAL_EDITOR.selection.text!.length);
    });

    test('no active editor → { active: false } with no other fields', async () => {
        const src = makeEditorSource(null);
        const r = JSON.parse(await getActiveEditorImpl({ source: src }, {}));
        assert.deepEqual(r, { active: false });
    });

    test('untitled doc surfaces untitled: true + scheme: "untitled"', async () => {
        const src = makeEditorSource({
            ...TYPICAL_EDITOR,
            file: 'Untitled-1',
            absolutePath: '/Untitled-1',
            scheme: 'untitled',
            untitled: true,
            language: 'plaintext',
        });
        const r = JSON.parse(await getActiveEditorImpl({ source: src }, {}));
        assert.equal(r.untitled, true);
        assert.equal(r.scheme, 'untitled');
    });

    test('output-channel pseudo-document distinguished by scheme: "output"', async () => {
        const src = makeEditorSource({
            ...TYPICAL_EDITOR,
            file: 'extension-output-#1-Tom AI Local Log',
            absolutePath: 'output:extension-output-#1-Tom AI Local Log',
            scheme: 'output',
            language: 'log',
        });
        const r = JSON.parse(await getActiveEditorImpl({ source: src }, {}));
        assert.equal(r.scheme, 'output');
    });

    test('includeSelectionText: false → no text field', async () => {
        const src = makeEditorSource({
            ...TYPICAL_EDITOR,
            selection: { ...TYPICAL_EDITOR.selection, text: undefined },
        });
        const r = JSON.parse(await getActiveEditorImpl({ source: src }, { includeSelectionText: false }));
        assert.equal(r.selection.text, undefined);
        assert.equal(r.selection.charLength, 0);
        assert.equal(src.calls[0].includeSelectionText, false);
    });

    test('maxSelectionChars is forwarded to the source', async () => {
        const src = makeEditorSource(TYPICAL_EDITOR);
        await getActiveEditorImpl({ source: src }, { maxSelectionChars: 200 });
        assert.equal(src.calls[0].maxSelectionChars, 200);
    });

    test('default maxSelectionChars is 4000', async () => {
        const src = makeEditorSource(TYPICAL_EDITOR);
        await getActiveEditorImpl({ source: src }, {});
        assert.equal(src.calls[0].maxSelectionChars, 4000);
    });

    test('negative maxSelectionChars is clamped to 0', async () => {
        const src = makeEditorSource(TYPICAL_EDITOR);
        await getActiveEditorImpl({ source: src }, { maxSelectionChars: -50 });
        assert.equal(src.calls[0].maxSelectionChars, 0);
    });

    test('visibleRange: null is preserved (not stripped to undefined)', async () => {
        const src = makeEditorSource({ ...TYPICAL_EDITOR, visibleRange: null });
        const r = JSON.parse(await getActiveEditorImpl({ source: src }, {}));
        assert.equal(r.visibleRange, null);
    });
});

// ===========================================================================
// getOpenEditors
// ===========================================================================

function makeTabsSource(tabs: TabSnapshot[]): OpenEditorsSource {
    return { snapshot() { return tabs; } };
}

describe('getOpenEditorsImpl', () => {

    test('typical call lists every tab with count', async () => {
        const src = makeTabsSource(TYPICAL_TABS);
        const raw = await withTiming('tomAi_getOpenEditors:typical', () =>
            getOpenEditorsImpl({ source: src }, {}));
        const r = JSON.parse(raw);
        assert.equal(r.count, 4);
        assert.equal(r.tabs.length, 4);
    });

    test('non-file tabs (webview, terminal) get file: null + kind reports the type', async () => {
        const src = makeTabsSource(TYPICAL_TABS);
        const r = JSON.parse(await getOpenEditorsImpl({ source: src }, {}));
        const webview = r.tabs.find((t: TabSnapshot) => t.kind === 'webview');
        const terminal = r.tabs.find((t: TabSnapshot) => t.kind === 'terminal');
        assert.ok(webview);
        assert.ok(terminal);
        assert.equal(webview.file, null);
        assert.equal(terminal.file, null);
        assert.equal(webview.absolutePath, null);
        assert.equal(terminal.absolutePath, null);
    });

    test('tab kind is reported for text + text-diff + notebook + custom', async () => {
        const tabs: TabSnapshot[] = [
            { group: 1, label: 'a.ts', file: 'a.ts', absolutePath: '/ws/a.ts', kind: 'text', active: false, dirty: false, pinned: false, preview: false },
            { group: 1, label: 'a.ts ↔ b.ts', file: 'b.ts', absolutePath: '/ws/b.ts', kind: 'text-diff', active: false, dirty: false, pinned: false, preview: false },
            { group: 1, label: 'demo.ipynb', file: 'demo.ipynb', absolutePath: '/ws/demo.ipynb', kind: 'notebook', active: false, dirty: false, pinned: false, preview: false },
            { group: 1, label: 'preview.svg', file: 'preview.svg', absolutePath: '/ws/preview.svg', kind: 'custom', active: false, dirty: false, pinned: false, preview: false },
        ];
        const r = JSON.parse(await getOpenEditorsImpl({ source: makeTabsSource(tabs) }, {}));
        const kinds = r.tabs.map((t: TabSnapshot) => t.kind);
        assert.deepEqual(kinds, ['text', 'text-diff', 'notebook', 'custom']);
    });

    test('view-column group + active/dirty/pinned/preview flags flow through', async () => {
        const r = JSON.parse(await getOpenEditorsImpl({ source: makeTabsSource(TYPICAL_TABS) }, {}));
        const pinned = r.tabs.find((t: TabSnapshot) => t.pinned);
        assert.ok(pinned);
        assert.equal(pinned.label, 'extension.ts');
        assert.equal(pinned.group, 1);
        const dirty = r.tabs.find((t: TabSnapshot) => t.dirty);
        assert.equal(dirty.label, 'config.json');
        // Only one active per group; webview is the active one in group 2.
        const activeInGroup2 = r.tabs.filter((t: TabSnapshot) => t.group === 2 && t.active);
        assert.equal(activeInGroup2.length, 1);
        assert.equal(activeInGroup2[0].kind, 'webview');
    });

    test('empty tab list → count: 0, tabs: []', async () => {
        const r = JSON.parse(await getOpenEditorsImpl({ source: makeTabsSource([]) }, {}));
        assert.equal(r.count, 0);
        assert.deepEqual(r.tabs, []);
    });
});
