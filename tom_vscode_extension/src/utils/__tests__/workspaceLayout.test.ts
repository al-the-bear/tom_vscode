/**
 * The workspace layout resolver (`computeLayout`): root marker, defaults,
 * `_ai` lookup, layers, overrides and Windows paths — on temporary folders
 * (and a fake file system for the Windows cases).
 */

import { test, describe } from 'node:test';
import * as assert from 'node:assert/strict';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { computeLayout, describeAiMissing, layoutPathKey, type LayoutFs } from '../workspaceLayout.js';

function tmp(): string {
    return fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'tomlayout-')));
}
function mk(...parts: string[]): string {
    const p = path.join(...parts);
    fs.mkdirSync(p, { recursive: true });
    return p;
}
function write(file: string, text: string): void {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, text);
}
function marker(dir: string, text = 'version: 1\n'): void {
    write(path.join(dir, '.tom', 'tom_root.yaml'), text);
}

describe('computeLayout — root', () => {
    test('no folder: undefined', () => {
        assert.equal(computeLayout({ workspaceFolders: [] }), undefined);
    });

    test('marker found above the workspace folder: that is the root', () => {
        const top = tmp();
        marker(top);
        const ws = mk(top, 'a', 'ws');
        const l = computeLayout({ workspaceFolders: [ws] })!;
        assert.equal(l.root, top);
        assert.equal(l.workspaceFolder, ws);
        assert.equal(l.standalone, false);
    });

    test('marker missing: standalone, root = workspace folder', () => {
        const ws = mk(tmp(), 'ws');
        const l = computeLayout({ workspaceFolders: [ws] })!;
        assert.equal(l.root, ws);
        assert.equal(l.standalone, true);
        assert.deepEqual(l.configLayers, [path.join(ws, '.tom')]);
    });

    test('nested markers: the nearest wins', () => {
        const top = tmp();
        marker(top);
        const mid = mk(top, 'mid');
        marker(mid);
        const ws = mk(mid, 'ws');
        assert.equal(computeLayout({ workspaceFolders: [ws] })!.root, mid);
    });

    test('root == workspace folder: one layer each', () => {
        const ws = tmp();
        marker(ws);
        const l = computeLayout({ workspaceFolders: [ws] })!;
        assert.equal(l.root, ws);
        assert.equal(l.standalone, false);
        assert.deepEqual(l.configLayers, [path.join(ws, '.tom')]);
        assert.deepEqual(l.guidelineDirs, [path.join(ws, '_agent_guidelines')]);
    });

    test('two levels: layers root first, then the workspace folder', () => {
        const top = tmp();
        marker(top);
        mk(top, '.tom');
        const ws = mk(top, 'ws');
        const l = computeLayout({ workspaceFolders: [ws] })!;
        assert.deepEqual(l.configLayers, [path.join(top, '.tom'), path.join(ws, '.tom')]);
        assert.deepEqual(l.existingConfigLayers, [path.join(top, '.tom')]);
        assert.deepEqual(l.guidelineDirs, [path.join(top, '_agent_guidelines'), path.join(ws, '_agent_guidelines')]);
    });
});

describe('computeLayout — defaults', () => {
    test('tom_root.yaml defaults apply to both levels', () => {
        const top = tmp();
        marker(top, 'version: 1\ndefaults:\n  ai: ai_state\n  guidelines: _copilot_guidelines\n  config: .cfg\n');
        const ws = mk(top, 'ws');
        mk(top, 'ai_state');
        const l = computeLayout({ workspaceFolders: [ws] })!;
        assert.equal(l.aiRoot, path.join(top, 'ai_state'));
        assert.deepEqual(l.configLayers, [path.join(top, '.cfg'), path.join(ws, '.cfg')]);
        assert.deepEqual(l.guidelineDirs, [path.join(top, '_copilot_guidelines'), path.join(ws, '_copilot_guidelines')]);
    });

    test('a missing key takes the default', () => {
        const top = tmp();
        marker(top, 'version: 1\ndefaults:\n  config: .cfg\n');
        const l = computeLayout({ workspaceFolders: [mk(top, 'ws')] })!;
        assert.equal(l.rootDefaults.ai, '_ai');
        assert.equal(l.rootDefaults.guidelines, '_agent_guidelines');
        assert.equal(l.rootDefaults.config, '.cfg');
    });

    test('tom_workspace.yaml changes the workspace folder level only', () => {
        const top = tmp();
        marker(top);
        const ws = mk(top, 'ws');
        write(path.join(ws, '.tom', 'tom_workspace.yaml'), 'version: 1\ndefaults:\n  guidelines: _copilot_guidelines\n  ai: my_ai\n');
        mk(ws, 'my_ai');
        const l = computeLayout({ workspaceFolders: [ws] })!;
        assert.deepEqual(l.guidelineDirs, [path.join(top, '_agent_guidelines'), path.join(ws, '_copilot_guidelines')]);
        assert.equal(l.aiRoot, path.join(ws, 'my_ai'));
        assert.equal(l.aiName, 'my_ai');
    });

    test('an unreadable marker keeps the built-in defaults', () => {
        const top = tmp();
        marker(top, ': : not yaml [');
        const l = computeLayout({ workspaceFolders: [mk(top, 'ws')] })!;
        assert.equal(l.root, top);
        assert.equal(l.rootDefaults.ai, '_ai');
    });
});

describe('computeLayout — _ai', () => {
    test('the workspace folder\'s _ai wins over the root\'s', () => {
        const top = tmp();
        marker(top);
        mk(top, '_ai');
        const ws = mk(top, 'ws');
        mk(ws, '_ai');
        assert.equal(computeLayout({ workspaceFolders: [ws] })!.aiRoot, path.join(ws, '_ai'));
    });

    test('_ai only at the root', () => {
        const top = tmp();
        marker(top);
        mk(top, '_ai');
        const l = computeLayout({ workspaceFolders: [mk(top, 'ws')] })!;
        assert.equal(l.aiRoot, path.join(top, '_ai'));
        assert.equal(l.aiMissing, undefined);
    });

    test('a symlinked _ai keeps the path it was opened by', () => {
        const top = tmp();
        marker(top);
        const target = mk(top, 'state_clone');
        const ws = mk(top, 'ws');
        fs.symlinkSync(target, path.join(ws, '_ai'), 'dir');
        const l = computeLayout({ workspaceFolders: [ws] })!;
        assert.equal(l.aiRoot, path.join(ws, '_ai'));
        assert.equal(l.aiMissing, undefined);
    });

    test('_ai missing: reported, nothing created', () => {
        const top = tmp();
        marker(top);
        const ws = mk(top, 'ws');
        const l = computeLayout({ workspaceFolders: [ws] })!;
        assert.equal(l.aiMissing, 'missing');
        assert.deepEqual(l.aiCandidates, [path.join(ws, '_ai'), path.join(top, '_ai')]);
        assert.equal(fs.existsSync(path.join(ws, '_ai')), false);
        assert.match(describeAiMissing(l)!, /No _ai folder found/);
    });

    test('_ai a broken symlink: reported as brokenLink', () => {
        const top = tmp();
        marker(top);
        const ws = mk(top, 'ws');
        fs.symlinkSync(path.join(top, 'gone'), path.join(ws, '_ai'), 'dir');
        const l = computeLayout({ workspaceFolders: [ws] })!;
        assert.equal(l.aiMissing, 'brokenLink');
        assert.equal(l.aiRoot, path.join(ws, '_ai'));
        assert.match(describeAiMissing(l)!, /broken link/);
    });
});

describe('computeLayout — window and overrides', () => {
    test('a multi-folder window: the first folder is the workspace folder', () => {
        const top = tmp();
        marker(top);
        const ws = mk(top, 'ws');
        const other = mk(tmp(), 'other');
        mk(other, '_ai');
        const l = computeLayout({ workspaceFolders: [ws, other], workspaceFile: path.join(top, 'quest_a.code-workspace') })!;
        assert.equal(l.workspaceFolder, ws);
        assert.equal(l.root, top);
        assert.equal(l.questId, 'quest_a');
    });

    test('questId without a .code-workspace file: default', () => {
        assert.equal(computeLayout({ workspaceFolders: [tmp()] })!.questId, 'default');
    });

    test('tomAi.layout.root replaces the walk up (relative to the workspace folder)', () => {
        const top = tmp();
        marker(top);
        const elsewhere = mk(top, 'elsewhere');
        const ws = mk(top, 'ws');
        const l = computeLayout({ workspaceFolders: [ws], overrides: { root: '../elsewhere' } })!;
        assert.equal(l.root, elsewhere);
        assert.equal(l.standalone, false);
        assert.deepEqual(l.overridesApplied, ['root']);
    });

    test('tomAi.layout.aiFolder: absolute, no fallback to the root', () => {
        const top = tmp();
        marker(top);
        mk(top, '_ai');
        const own = mk(tmp(), 'state');
        const l = computeLayout({ workspaceFolders: [mk(top, 'ws')], overrides: { aiFolder: own } })!;
        assert.equal(l.aiRoot, own);
        assert.deepEqual(l.aiCandidates, [own]);
    });

    test('tomAi.aiFolder alias: a name under the workspace folder; tomAi.layout.aiFolder wins', () => {
        const top = tmp();
        marker(top);
        const ws = mk(top, 'ws');
        mk(ws, 'legacy_ai');
        mk(ws, 'new_ai');
        const alias = computeLayout({ workspaceFolders: [ws], overrides: { legacyAiFolder: 'legacy_ai' } })!;
        assert.equal(alias.aiRoot, path.join(ws, 'legacy_ai'));
        assert.equal(alias.aiName, 'legacy_ai');
        const both = computeLayout({ workspaceFolders: [ws], overrides: { legacyAiFolder: 'legacy_ai', aiFolder: 'new_ai' } })!;
        assert.equal(both.aiRoot, path.join(ws, 'new_ai'));
        assert.deepEqual(both.overridesApplied, ['aiFolder']);
    });

    test('tomAi.layout.configFolder and guidelinesFolder change the workspace folder level', () => {
        const top = tmp();
        marker(top);
        const ws = mk(top, 'ws');
        const l = computeLayout({ workspaceFolders: [ws], overrides: { configFolder: 'cfg', guidelinesFolder: '~/g' }, homeDir: '/home/u' })!;
        assert.deepEqual(l.configLayers, [path.join(top, '.tom'), path.join(ws, 'cfg')]);
        assert.deepEqual(l.guidelineDirs, [path.join(top, '_agent_guidelines'), path.join('/home/u', 'g')]);
    });
});

describe('computeLayout — the container shape', () => {
    test('a container window: root = al_the_bear, workspaceFolder = tom_agent_container', () => {
        const atb = path.join(tmp(), 'al_the_bear');
        marker(atb, 'version: 1\ndefaults:\n  ai: _ai\n  guidelines: _agent_guidelines\n  config: .tom\n');
        write(path.join(atb, '.tom', 'tom_vscode_extension.json'), '{}');
        mk(atb, '_ai', 'quests');
        mk(atb, '_agent_guidelines');
        const container = mk(atb, 'inhouse', 'second_wind', 'enterprise_flutter', 'tom_agent_container');
        write(path.join(container, '.tom', 'tom_vscode_extension.json'), '{}');
        fs.symlinkSync('../../../../_ai', path.join(container, '_ai'), 'dir');
        const vscodeFolder = mk(container, 'tom_ai', 'vscode');
        const l = computeLayout({
            workspaceFolders: [container, vscodeFolder],
            workspaceFile: path.join(container, 'vscode_extension.code-workspace'),
        })!;
        assert.equal(l.root, atb);
        assert.equal(l.workspaceFolder, container);
        assert.equal(l.standalone, false);
        assert.equal(l.aiRoot, path.join(container, '_ai'));
        assert.equal(l.aiMissing, undefined);
        assert.equal(l.questId, 'vscode_extension');
        assert.deepEqual(l.configLayers, [path.join(atb, '.tom'), path.join(container, '.tom')]);
        assert.equal(l.existingConfigLayers.length, 2);
    });
});

describe('computeLayout — Windows paths', () => {
    /** A fake file system over a set of existing paths (case-insensitive, as on Windows). */
    function fakeFs(existing: string[], files: Record<string, string> = {}, broken: string[] = []): LayoutFs {
        const key = (p: string) => layoutPathKey(p, 'win32');
        const set = new Set(existing.map(key));
        const brokenSet = new Set(broken.map(key));
        const fileMap = new Map(Object.entries(files).map(([k, v]) => [key(k), v]));
        return {
            exists: (p) => set.has(key(p)) || fileMap.has(key(p)),
            entryExists: (p) => set.has(key(p)) || fileMap.has(key(p)) || brokenSet.has(key(p)),
            readText: (p) => fileMap.get(key(p)),
        };
    }

    test('marker and _ai found with backslash paths and other casing', () => {
        const lfs = fakeFs(['C:\\Code\\al_the_bear\\_ai', 'C:\\Code\\al_the_bear\\.tom'], {
            'C:\\Code\\AL_THE_BEAR\\.tom\\tom_root.yaml': 'version: 1\n',
        });
        const l = computeLayout({ workspaceFolders: ['c:\\code\\al_the_bear\\inhouse\\ws'], platform: 'win32', fs: lfs })!;
        assert.equal(layoutPathKey(l.root, 'win32'), 'c:\\code\\al_the_bear');
        assert.equal(layoutPathKey(l.aiRoot, 'win32'), 'c:\\code\\al_the_bear\\_ai');
        assert.equal(l.existingConfigLayers.length, 1);
    });

    test('root == workspace folder differing only in case: one layer', () => {
        const lfs = fakeFs([], { 'C:\\Code\\ws\\.tom\\tom_root.yaml': 'version: 1\n' });
        const l = computeLayout({ workspaceFolders: ['C:\\Code\\WS\\'], platform: 'win32', fs: lfs, overrides: { root: 'c:\\code\\ws' } })!;
        assert.equal(l.configLayers.length, 1);
    });

    test('a junction whose target is gone reads as a broken link', () => {
        const lfs = fakeFs([], { 'C:\\ws\\.tom\\tom_root.yaml': 'version: 1\n' }, ['C:\\ws\\_ai']);
        const l = computeLayout({ workspaceFolders: ['C:\\ws'], platform: 'win32', fs: lfs })!;
        assert.equal(l.aiMissing, 'brokenLink');
    });
});
