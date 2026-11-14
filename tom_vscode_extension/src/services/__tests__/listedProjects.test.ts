/**
 * The extension's one project discovery (vscimpb84): every former caller of the
 * retired project detector reads buildkit's listing (services/workspaceProjects.ts,
 * the JavaScript port where no buildkit is found) through these helpers.
 *
 *   LP-1 listedProjects: the listing's projects sorted by name; no listing at all gives none
 *   LP-2 nearestListedProject: the innermost listed project holding a folder (the folder itself or one above it),
 *        never a sibling sharing a name prefix
 *   LP-3 the kinds derived from a listed project: the todo panel's coarse kind (dart / node / other) and the
 *        scripting API's type (flutter by the nature, python, other)
 *   LP-4 scriptingProjectInfo: the scripting API's ProjectInfo fields (absolute path, relative path, tags = natures,
 *        description and version when listed); isSubWorkspace marks a project folder holding buildkit_master.yaml,
 *        never the workspace root itself
 *   LP-5 no caller reads the retired detector: projectDetector.ts, project_types.json and the
 *        tomAi.projectDetection.excludeGlobs setting are gone; the todo panel, prompt scopes, @WS panel, scripting
 *        bridge, Telegram and command-line handlers read the listing
 */

import test, { describe } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'fs';
import * as path from 'path';

import {
    coarseProjectType,
    listedProjects,
    nearestListedProject,
    scriptingProjectInfo,
    scriptingProjectType,
    type WorkspaceProject,
} from '../workspaceProjects.js';

const EXT = path.resolve(__dirname, '..', '..', '..');
const read = (...p: string[]) => fs.readFileSync(path.join(EXT, ...p), 'utf8');

function project(rel: string, extra: Partial<WorkspaceProject> = {}): WorkspaceProject {
    const name = path.basename(rel);
    return { id: name, name, path: rel, absolutePath: `/ws/${rel}`, language: 'dart', type: 'dart_package', natures: ['dart'], ...extra };
}

/** Listing options that find no buildkit (no config, empty PATH) and list with [projects]. */
function jsOnly(projects: WorkspaceProject[] | Error) {
    return {
        fresh: true,
        config: {},
        env: { PATH: '' },
        extensionRoot: null,
        jsLister: () => { if (projects instanceof Error) { throw projects; } return { projects }; },
    };
}

describe('the listing for the extension\'s callers', () => {
    test('LP-1: sorted by name; no listing gives none', async () => {
        const got = await listedProjects('/ws-lp1', jsOnly([project('b/zeta'), project('a/alpha'), project('c/mid')]));
        assert.deepEqual(got.map((p) => p.name), ['alpha', 'mid', 'zeta']);
        assert.deepEqual(await listedProjects('/ws-lp1b', jsOnly(new Error('unreadable'))), []);
    });

    test('LP-2: the innermost project holding a folder', () => {
        const projects = [project('pkg'), project('pkg/example'), project('pkg2')];
        assert.equal(nearestListedProject(projects, '/ws/pkg/lib/src')?.path, 'pkg');
        assert.equal(nearestListedProject(projects, '/ws/pkg/example/lib')?.path, 'pkg/example');
        assert.equal(nearestListedProject(projects, '/ws/pkg2/')?.path, 'pkg2', 'the folder itself; not pkg by its prefix');
        assert.equal(nearestListedProject(projects, '/ws/other'), undefined);
    });

    test('LP-3: the coarse kind and the scripting type', () => {
        const flutter = project('app', { type: 'flutter_app', natures: ['dart', 'flutter'] });
        const ts = project('ext', { language: 'typescript', type: 'typescript', natures: ['typescript'] });
        const py = project('tool', { language: 'python', type: 'python', natures: ['python'] });
        const go = project('svc', { language: 'go', type: 'go', natures: ['go'] });
        assert.deepEqual([project('lib'), flutter, ts, py, go].map(coarseProjectType), ['dart', 'dart', 'node', 'other', 'other']);
        assert.deepEqual([project('lib'), flutter, ts, py, go].map(scriptingProjectType), ['dart', 'flutter', 'node', 'python', 'other']);
    });

    test('LP-4: the scripting API\'s ProjectInfo', () => {
        const p = project('sub/ws', { id: 'SUB', description: 'A sub-workspace', version: '1.2.0', natures: ['dart', 'buildkit'] });
        const exists = (file: string) => file === '/ws/sub/ws/buildkit_master.yaml' || file === '/ws/buildkit_master.yaml';
        assert.deepEqual(scriptingProjectInfo(p, '/ws', exists), {
            id: 'SUB', name: 'ws', path: '/ws/sub/ws', relativePath: 'sub/ws', type: 'dart',
            description: 'A sub-workspace', version: '1.2.0', tags: ['dart', 'buildkit'],
            language: 'dart', natures: ['dart', 'buildkit'], isSubWorkspace: true,
        });
        const root = { ...project('.'), absolutePath: '/ws' };
        assert.equal(scriptingProjectInfo(root, '/ws/', exists).isSubWorkspace, false, 'the root is no sub-workspace');
        const plain = scriptingProjectInfo(project('lib'), '/ws', exists);
        assert.equal(plain.isSubWorkspace, false);
        assert.ok(!('description' in plain) && !('version' in plain));
    });

    test('LP-5: no caller reads the retired detector', () => {
        assert.ok(!fs.existsSync(path.join(EXT, 'src', 'utils', 'projectDetector.ts')));
        assert.ok(!fs.existsSync(path.join(EXT, 'src', 'config', 'project_types.json')));
        assert.doesNotMatch(read('package.json'), /tomAi\.projectDetection/);
        const callers: Array<[string[], RegExp]> = [
            [['src', 'managers', 'questTodoManager.ts'], /export async function scanWorkspaceProjects\(\): Promise<ScannedProject\[\]> \{\s*const projects = await listedProjects\(getWorkspaceRoot\(\)\);/],
            [['src', 'handlers', 'questTodoPanel-handler.ts'], /const projs = await scanWorkspaceProjects\(\);/],
            [['src', 'handlers', 'chatVariablesEditor-handler.ts'], /const projects = \(await scanWorkspaceProjects\(\)\)\.map/],
            [['src', 'utils', 'promptScopes.ts'], /const defaultProjectLister: ProjectLister = \(wsRoot, fresh\) => listedProjects\(wsRoot, \{ fresh \}\);/],
            [['src', 'handlers', 'wsPanel-handler.ts'], /await listedProjects\(wsRootForProjects\)/],
            [['src', 'handlers', 'tomScriptingBridge-handler.ts'], /\(await listedProjects\(root\)\)\.map\(\(p\) => scriptingProjectInfo\(p, root\)\)/],
            [['src', 'handlers', 'telegram-cmd-handlers.ts'], /nearestListedProject\(await listedProjects\(root\), fromDir\)/],
            [['src', 'handlers', 'commandline-handler.ts'], /nearestListedProject\(await listedProjects\(wsRoot\), startDir\)/],
        ];
        for (const [file, pattern] of callers) {
            const text = read(...file);
            assert.match(text, pattern, file.join('/'));
            assert.doesNotMatch(text, /projectDetector/, `${file.join('/')} does not import the detector`);
        }
    });
});
