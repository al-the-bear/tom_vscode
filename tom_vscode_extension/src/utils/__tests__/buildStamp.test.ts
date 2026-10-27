/**
 * Which build a window runs and which is installed (src/utils/buildStamp.ts).
 *
 *   BS-1 a stamp is read from `out/build-info.json`; without one, from the time `out/extension.js` was written;
 *        a folder with neither has none
 *   BS-2 the comparison: a newer installed build needs a reload, the same or an older one does not; two stamps
 *        with the same commit and time are the same build; an unknown side never asks for a reload
 *   BS-3 the installed copy is the newest non-obsolete `<id>-<version>` folder of the extensions folder; the
 *        running folder when there is none
 *   BS-4 the label: commit and time, `(dirty)` for a build of uncommitted sources
 *   BS-5 the status travels: the heartbeat writes it into the window state file, tomAi_getQuestWindowStatus
 *        answers it per window, tomAi_getWorkspaceInfo answers this window's (and nothing outside a window)
 *   BS-6 the compile writes the stamp: `npm run compile` ends with scripts/write-build-info.cjs, which writes
 *        commit, dirty and builtAt into out/build-info.json
 */

/* eslint-disable @typescript-eslint/naming-convention -- extension folder names are keys of VS Code's .obsolete file */
import test, { describe, after } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import { execFileSync } from 'child_process';
import { buildLabel, compareBuilds, findInstalledExtensionRoot, readBuildStamp, type BuildStamp } from '../buildStamp.js';
import { withHeartbeat } from '../windowHeartbeat.js';
import { buildQuestWindowStatus } from '../questWindowStatus.js';
import { getWorkspaceInfoImpl } from '../../tools/editor-context-tools.js';

const tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'build-stamp-')));
after(() => fs.rmSync(tmp, { recursive: true, force: true }));

function ext(name: string, info?: Record<string, unknown>, mtime?: Date): string {
    const root = path.join(tmp, name);
    fs.mkdirSync(path.join(root, 'out'), { recursive: true });
    const js = path.join(root, 'out', 'extension.js');
    fs.writeFileSync(js, '// x');
    if (mtime) { fs.utimesSync(js, mtime, mtime); }
    if (info) { fs.writeFileSync(path.join(root, 'out', 'build-info.json'), JSON.stringify(info)); }
    return root;
}

const stamp = (builtAt: string, commit?: string): BuildStamp => ({ builtAt, ...(commit ? { commit } : {}), source: 'build-info' });

describe('build stamps', () => {
    test('BS-1: reading a stamp', () => {
        const withInfo = ext('a', { commit: 'abc1234', dirty: true, builtAt: '2026-10-27T10:00:00.000Z' });
        assert.deepEqual(readBuildStamp(withInfo), { commit: 'abc1234', dirty: true, builtAt: '2026-10-27T10:00:00.000Z', source: 'build-info' });
        const old = ext('b', undefined, new Date('2026-10-23T11:11:00Z'));
        assert.deepEqual(readBuildStamp(old), { builtAt: '2026-10-23T11:11:00.000Z', source: 'mtime' });
        assert.equal(readBuildStamp(path.join(tmp, 'nothing')), undefined);
    });

    test('BS-2: comparing', () => {
        const oct23 = stamp('2026-10-23T11:11:00.000Z', 'aaa');
        const oct27 = stamp('2026-10-27T10:00:00.000Z', 'bbb');
        assert.equal(compareBuilds(oct23, oct27).reloadNeeded, true, 'the running window is older');
        assert.equal(compareBuilds(oct27, oct27).reloadNeeded, false);
        assert.equal(compareBuilds(oct27, oct23).reloadNeeded, false, 'an older install never asks for a reload');
        assert.equal(compareBuilds(undefined, oct27).reloadNeeded, false, 'unknown: no claim');
        assert.equal(compareBuilds(oct27, undefined).reloadNeeded, false);
        assert.deepEqual(compareBuilds(oct23, oct27), { running: oct23, installed: oct27, reloadNeeded: true });
    });

    test('BS-3: the installed copy', () => {
        const extensions = path.join(tmp, 'extensions');
        const mk = (dir: string, builtAt: string) => {
            fs.mkdirSync(path.join(extensions, dir, 'out'), { recursive: true });
            fs.writeFileSync(path.join(extensions, dir, 'out', 'build-info.json'), JSON.stringify({ builtAt }));
            return path.join(extensions, dir);
        };
        const running = mk('pub.tom-ai-extension-0.1.0', '2026-10-23T00:00:00.000Z');
        assert.equal(findInstalledExtensionRoot(extensions, 'Pub.tom-ai-extension', running), running);
        const newer = mk('pub.tom-ai-extension-0.1.1', '2026-10-27T00:00:00.000Z');
        mk('pub.other-0.9.0', '2026-12-01T00:00:00.000Z');
        assert.equal(findInstalledExtensionRoot(extensions, 'Pub.tom-ai-extension', running), newer, 'ids compare in any case');
        fs.writeFileSync(path.join(extensions, '.obsolete'), JSON.stringify({ 'pub.tom-ai-extension-0.1.1': true }));
        assert.equal(findInstalledExtensionRoot(extensions, 'pub.tom-ai-extension', running), running, 'an obsolete folder is about to be removed');
        assert.equal(findInstalledExtensionRoot(path.join(tmp, 'none'), 'pub.x', running), running);
    });

    test('BS-4: the label', () => {
        assert.equal(buildLabel({ commit: 'abc1234', builtAt: '2026-10-27T10:05:00.000Z', source: 'build-info' }), 'abc1234 (2026-10-27 10:05 UTC)');
        assert.equal(buildLabel({ commit: 'abc1234', dirty: true, builtAt: '2026-10-27T10:05:00.000Z', source: 'build-info' }), 'abc1234 (dirty) (2026-10-27 10:05 UTC)');
        assert.equal(buildLabel({ builtAt: '2026-10-23T11:11:00.000Z', source: 'mtime' }), 'built 2026-10-23 11:11 UTC');
        assert.equal(buildLabel(undefined), 'unknown');
    });

    test('BS-5: the status travels', async () => {
        const status = compareBuilds(stamp('2026-10-23T11:11:00.000Z', 'aaa'), stamp('2026-10-27T10:00:00.000Z', 'bbb'));
        const now = new Date('2026-10-27T12:00:00Z');
        const state = withHeartbeat({ windowId: 'w1_machine1', activeQuest: 'q', workspace: 'q' }, { pid: 1, build: status }, now);
        assert.deepEqual(state.build, status);
        assert.equal('build' in withHeartbeat({ windowId: 'w2' }, { pid: 1 }, now), false, 'no build: no field');

        const answer = buildQuestWindowStatus({
            states: [{ ...state, status: [] } as never], sessionsOf: () => [], config: undefined, noApiKey: new Set(),
            thisHost: 'h', thisMachine: 'machine1', thisWindowId: 'w1_machine1', nowMs: now.getTime(),
        });
        assert.equal(answer.windows[0].build?.reloadNeeded, true);

        const snapshot = { workspaceName: 'w', workspaceFile: '', workspaceFolders: [], questId: 'q', projects: null, projectsSource: null, git: null };
        const info = JSON.parse(await getWorkspaceInfoImpl({ source: { snapshot: async () => ({ ...snapshot, build: status }) } }, {}));
        assert.equal(info.build.reloadNeeded, true);
        assert.equal(info.build.installed.commit, 'bbb');
        const outside = JSON.parse(await getWorkspaceInfoImpl({ source: { snapshot: async () => snapshot } }, {}));
        assert.equal('build' in outside, false);
    });

    test('BS-6: the compile writes the stamp', () => {
        const root = path.join(__dirname, '..', '..', '..');
        const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf-8'));
        assert.match(pkg.scripts.compile, /node scripts\/write-build-info\.cjs$/);
        const out = path.join(tmp, 'pkg');
        fs.mkdirSync(path.join(out, 'scripts'), { recursive: true });
        fs.copyFileSync(path.join(root, 'scripts', 'write-build-info.cjs'), path.join(out, 'scripts', 'write-build-info.cjs'));
        execFileSync(process.execPath, [path.join(out, 'scripts', 'write-build-info.cjs')], { stdio: 'ignore' });
        const info = readBuildStamp(out);
        assert.equal(info?.source, 'build-info');
        assert.ok(Math.abs(Date.parse(info!.builtAt) - Date.now()) < 60_000, 'built now');
    });
});
