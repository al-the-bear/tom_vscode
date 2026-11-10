/**
 * The @TOM VSC › RESOURCES view (media/vscResources/, vscimpb30) in a JSDOM running its real script against a
 * stand-in host.
 *
 *   VR-1 the processes: the total, one row per extension (memory, CPU, count, a paused badge when all are paused),
 *        Pause / Kill per extension post the extension id; opening a group shows its processes, whose Resume /
 *        Kill post their pid; a group without an extension id posts its pids
 *   VR-2 Windows (canPause false): no Pause / Resume, the note says so; a failed process list says why
 *   VR-3 profiles: a button per command, disabled when this VS Code lacks it; a click posts the command
 *   VR-4 settings: a checkbox, a select and a number field per kind; a change posts the setting's id and value;
 *        a setting whose extension is not installed is disabled; a host note is shown
 */

import test, { describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { JSDOM } from 'jsdom';

const ROOT = join(__dirname, '..', '..', '..');
const asset = (file: string): string => readFileSync(join(ROOT, 'media', 'vscResources', file), 'utf-8');

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Win = any;

function setup(): { w: Win; posted: Array<Record<string, unknown>> } {
    const body = asset('index.html').split('<body>')[1].split('<script')[0].replace(/\{\{[a-zA-Z]+\}\}/g, '');
    const dom = new JSDOM(`<!DOCTYPE html><head><style>${asset('style.css')}</style></head><body>${body}</body>`, { runScripts: 'outside-only', pretendToBeVisual: true });
    const w = dom.window as Win;
    const posted: Array<Record<string, unknown>> = [];
    w.acquireVsCodeApi = () => ({ postMessage: (m: Record<string, unknown>) => posted.push(JSON.parse(JSON.stringify(m))) });
    w.eval(asset('main.js'));
    return { w, posted };
}
const send = (w: Win, data: Record<string, unknown>): void => { w.dispatchEvent(new w.MessageEvent('message', { data })); };
const $ = (w: Win, sel: string): Win[] => [...w.document.querySelectorAll(sel)];

const proc = (pid: number, depth: number, paused: boolean, kind: string) => ({
    pid, ppid: 1, depth, state: paused ? 'T' : 'S', rssKb: 1024 * 100, cpu: 1.5, elapsed: '01:00', command: `/bin/${kind}`, paused,
    owner: { extensionId: '', label: kind, kind },
});
const SNAP = {
    platform: 'darwin', canPause: true, host: { pid: 1, rssKb: 600 * 1024 }, totalKb: 3 * 1024 * 1024, totalText: '3.0 GB', processes: [{}, {}, {}],
    groups: [
        { extensionId: 'dart-code.dart-code', label: 'dart-code.dart-code', rssKb: 2 * 1024 * 1024, cpu: 40, paused: true, processes: [proc(10, 1, true, 'Dart analysis server'), proc(11, 2, true, 'Dart analysis server')] },
        { extensionId: '', label: 'mystery', rssKb: 1024 * 1024, cpu: 0, paused: false, processes: [proc(20, 1, false, 'mystery')] },
    ],
};
const STATE = {
    type: 'state', snapshot: SNAP,
    profiles: [
        { id: 'workbench.profiles.actions.switchProfile', label: 'Switch profile…', hint: 'h', available: true },
        { id: 'workbench.profiles.actions.manageProfiles', label: 'Manage profiles…', hint: 'h', available: false },
    ],
    settings: [
        { id: 'dart.onlyAnalyzeProjectsWithOpenFiles', key: 'dart.onlyAnalyzeProjectsWithOpenFiles', kind: 'bool', label: 'Dart: analyse only open', hint: 'h', value: false, inWorkspace: false, lean: true, available: false },
        { id: 'git.autoRepositoryDetection', key: 'git.autoRepositoryDetection', kind: 'enum', options: [true, false, 'subFolders', 'openEditors'], label: 'Git: find repositories', hint: 'h', value: true, inWorkspace: true, lean: 'openEditors', available: true },
        { id: 'git.repositoryScanMaxDepth', key: 'git.repositoryScanMaxDepth', kind: 'number', label: 'Git: depth', hint: 'h', value: 1, inWorkspace: false, lean: 1, available: true },
        { id: 'search.exclude:**/ztmp/**', key: 'search.exclude', kind: 'glob', label: 'Do not search ztmp/', hint: 'h', value: true, inWorkspace: true, lean: true, available: true },
    ],
};

describe('@TOM VSC › RESOURCES', () => {
    test('VR-1: the processes', () => {
        const { w, posted } = setup();
        assert.deepEqual(posted[0], { type: 'ready' });
        send(w, STATE);
        assert.match(w.document.querySelector('.total').textContent, /3\.0 GB in 3 processes/);
        assert.match(w.document.querySelector('.total').textContent, /extension host itself: 600 MB/);
        const heads = $(w, '.group-head');
        assert.equal(heads.length, 2);
        assert.match(heads[0].textContent, /dart-code\.dart-code/);
        assert.match(heads[0].textContent, /paused/);
        assert.match(heads[0].textContent, /2\.0 GB · 40\.0% · 2/);
        heads[0].querySelector('[data-act="resume"]').click();
        assert.deepEqual(posted.pop(), { type: 'act', action: 'resume', label: 'dart-code.dart-code', extensionId: 'dart-code.dart-code' });
        assert.equal(heads[0].querySelector('[data-act="pause"]'), null, 'paused: Resume instead of Pause');
        heads[1].querySelector('[data-act="pause"]').click();
        assert.deepEqual(posted.pop(), { type: 'act', action: 'pause', label: 'mystery', pids: [20] }, 'no extension id: its pids');
        assert.equal($(w, '.proc').length, 0, 'closed');
        heads[0].querySelector('.name').click();
        const procs = $(w, '.proc');
        assert.equal(procs.length, 2, 'opened, without asking the host');
        assert.match(procs[1].textContent, /Dart analysis server 11/);
        procs[1].querySelector('[data-act="kill"]').click();
        assert.deepEqual(posted.pop(), { type: 'act', action: 'kill', label: 'Dart analysis server', pids: [11] });
        send(w, STATE);
        assert.equal($(w, '.proc').length, 2, 'stays open across a refresh');
        w.document.querySelector('[data-refresh]').click();
        assert.deepEqual(posted.pop(), { type: 'refresh' });
    });

    test('VR-2: Windows and a failed list', () => {
        const { w } = setup();
        send(w, { ...STATE, snapshot: { ...SNAP, canPause: false } });
        assert.equal($(w, '[data-act="pause"], [data-act="resume"]').length, 0);
        assert.equal($(w, '[data-act="kill"]').length, 2);
        assert.match(w.document.body.textContent, /only Kill is offered/);
        send(w, { ...STATE, snapshot: { ...SNAP, error: 'ps failed', groups: [], processes: [] } });
        assert.match(w.document.querySelector('.note.error').textContent, /could not be read: ps failed/);
    });

    test('VR-3: profiles', () => {
        const { w, posted } = setup();
        send(w, STATE);
        const buttons = $(w, '[data-profile]');
        assert.deepEqual(buttons.map((b) => b.disabled), [false, true]);
        buttons[0].click();
        assert.deepEqual(posted.pop(), { type: 'profile', command: 'workbench.profiles.actions.switchProfile' });
    });

    test('VR-4: settings', () => {
        const { w, posted } = setup();
        send(w, { ...STATE, note: { text: 'Paused 2 processes.' } });
        assert.match(w.document.querySelector('.note').textContent, /Paused 2 processes/);
        const control = (id: string): Win => w.document.querySelector(`[data-setting="${id}"]`);
        assert.equal(control('dart.onlyAnalyzeProjectsWithOpenFiles').disabled, true, 'not installed');
        const select = control('git.autoRepositoryDetection');
        assert.equal(select.value, 'true');
        select.value = 'openEditors';
        select.dispatchEvent(new w.Event('change', { bubbles: true }));
        assert.deepEqual(posted.pop(), { type: 'setting', id: 'git.autoRepositoryDetection', value: 'openEditors' });
        const depth = control('git.repositoryScanMaxDepth');
        depth.value = '2';
        depth.dispatchEvent(new w.Event('change', { bubbles: true }));
        assert.deepEqual(posted.pop(), { type: 'setting', id: 'git.repositoryScanMaxDepth', value: 2 });
        const glob = control('search.exclude:**/ztmp/**');
        assert.equal(glob.checked, true);
        glob.checked = false;
        glob.dispatchEvent(new w.Event('change', { bubbles: true }));
        assert.deepEqual(posted.pop(), { type: 'setting', id: 'search.exclude:**/ztmp/**', value: false });
        assert.match(glob.parentNode.textContent, /workspace/);
    });
});
