/**
 * The activity-bar containers (package.json contributes.viewsContainers / views).
 *
 *   SB-1 two containers: @TOM (the quest: PROCESS, QUEST NOTES, QUEST TODOS, SESSIONS, SESSION TODOS) and @TOM WS
 *        (the workspace: VS CODE NOTES, WORKSPACE NOTES, WORKSPACE TODOS, TODO LOG, WINDOW STATUS), in
 *        that order, each with its icon on disk
 *   SB-2 the moved views keep their ids, and nothing opens a moved view through the @TOM container
 *   SB-3 each container has a focus command (`tomAi.tomSidebar.focus`, `tomAi.tomWsSidebar.focus`)
 */

import test, { describe } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';

const ROOT = join(__dirname, '..', '..', '..');
const pkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf-8'));
const WS_VIEWS = ['tomAi.vscodeNotes', 'tomAi.workspaceNotes', 'tomAi.workspaceTodos', 'tomAi.todoLogTom', 'tomAi.windowStatusTom'];

function sources(dir: string): string[] {
    return readdirSync(dir).flatMap((f) => {
        const p = join(dir, f);
        if (statSync(p).isDirectory()) { return f === '__tests__' ? [] : sources(p); }
        return f.endsWith('.ts') ? [p] : [];
    });
}

describe('activity-bar containers', () => {
    test('SB-1: @TOM and @TOM WS with their views', () => {
        const containers = pkg.contributes.viewsContainers.activitybar as Array<{ id: string; title: string; icon: string }>;
        assert.deepEqual(containers.map((c) => [c.id, c.title]), [['tomAi-sidebar', '@TOM'], ['tomAi-ws-sidebar', '@TOM WS']]);
        for (const c of containers) { assert.ok(existsSync(join(ROOT, c.icon)), `${c.icon} exists`); }
        const views = (id: string): string[][] => (pkg.contributes.views[id] as Array<{ id: string; name: string }>).map((v) => [v.id, v.name]);
        assert.deepEqual(views('tomAi-sidebar'), [
            ['tomAi.process', 'PROCESS'], ['tomAi.questNotes', 'QUEST NOTES'], ['tomAi.questTodos', 'QUEST TODOS'], ['tomAi.sessions', 'SESSIONS'],
            ['tomAi.sessionTodos', 'SESSION TODOS'],
        ]);
        assert.deepEqual(views('tomAi-ws-sidebar'), [
            ['tomAi.vscodeNotes', 'VS CODE NOTES'], ['tomAi.workspaceNotes', 'WORKSPACE NOTES'], ['tomAi.workspaceTodos', 'WORKSPACE TODOS'],
            ['tomAi.todoLogTom', 'TODO LOG'], ['tomAi.windowStatusTom', 'WINDOW STATUS'],
        ]);
    });

    test('SB-2: the moved views are reached by their own ids', () => {
        const all = sources(join(ROOT, 'src')).map((f) => readFileSync(f, 'utf-8')).join('\n');
        for (const id of WS_VIEWS) {
            assert.ok(all.includes(`'${id}'`) || all.includes(`"${id}"`), `${id} is still registered by its id`);
        }
        // Opening @TOM is a quest action; nothing focuses @TOM to reach a workspace view.
        assert.equal((all.match(/workbench\.view\.extension\.tomAi-sidebar/g) ?? []).length, 1, 'only tomAi.tomSidebar.focus opens @TOM');
        const keybindings = JSON.stringify(pkg.contributes.keybindings ?? []);
        assert.doesNotMatch(keybindings, /workbench\.view\.extension\.tomAi-sidebar/);
    });

    test('SB-3: a focus command per container', () => {
        const declared = (pkg.contributes.commands as Array<{ command: string }>).map((c) => c.command);
        const ext = readFileSync(join(ROOT, 'src', 'extension.ts'), 'utf-8');
        for (const [cmd, container] of [['tomAi.tomSidebar.focus', 'tomAi-sidebar'], ['tomAi.tomWsSidebar.focus', 'tomAi-ws-sidebar']]) {
            assert.ok(declared.includes(cmd), `${cmd} declared`);
            assert.match(ext, new RegExp(`'${cmd.replace(/\./g, '\\.')}',\\s*async \\(\\) => \\{\\s*await vscode\\.commands\\.executeCommand\\('workbench\\.view\\.extension\\.${container}'\\)`));
        }
    });
});
