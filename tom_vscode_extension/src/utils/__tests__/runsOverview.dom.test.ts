/**
 * @TOM INFO › RUNS in the webview (media/runsOverview/main.js): the window tiles fold.
 *
 *   RO-1 a tile is expanded while one of its runs waits for the user, collapsed otherwise; collapsed, its headline
 *        shows its runs' state badges in the runs' alphabetical order (the run named in each badge's tooltip) and no
 *        run rows; expanded, the rows and no badges in the headline
 *   RO-2 a click (or Enter) on the headline folds or unfolds it, kept across refreshes and in the view's state; once
 *        the tile's need for the user changes, it follows the need again; a click on a run still selects it
 */

import test, { describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { JSDOM } from 'jsdom';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Win = any;
const media = (f: string): string => readFileSync(join(__dirname, '..', '..', '..', 'media', 'runsOverview', f), 'utf-8');

function setup(state: Record<string, unknown> = {}): { w: Win; posted: Win[]; state: () => Record<string, unknown> } {
    const body = media('index.html').split('<body>')[1]?.split('<script')[0] ?? '<div id="root"></div>';
    const dom = new JSDOM(`<!DOCTYPE html><body>${body.includes('id="root"') ? body : '<div id="root"></div>'}</body>`, { runScripts: 'outside-only' });
    const w = dom.window as Win;
    const posted: Win[] = [];
    let saved: Record<string, unknown> = { ...state };
    w.acquireVsCodeApi = () => ({ postMessage: (m: Win) => posted.push(JSON.parse(JSON.stringify(m))), getState: () => saved, setState: (s: Record<string, unknown>) => { saved = JSON.parse(JSON.stringify(s)); } });
    w.__INIT__ = {};
    w.eval(media('main.js'));
    return { w, posted, state: () => saved };
}
const send = (w: Win, windows: unknown[]): void => { w.dispatchEvent(new w.MessageEvent('message', { data: { type: 'runs', windows } })); };
const run = (name: string, state: string): Record<string, unknown> => ({ run: name, state, process: 'p', position: 'a', pending: 0 });
const WINDOWS = (needs: boolean): unknown[] => [
    { windowId: 'me', quest: 'quest-a', isThisWindow: true, alive: true, runs: [run('zeta', 'running'), run('alpha', needs ? 'waiting for user' : 'idle'), run('mid', 'paused')] },
    { windowId: 'other', quest: 'quest-b', isThisWindow: false, alive: true, runs: [run('b2', 'idle'), run('b1', 'running')] },
];
const tile = (w: Win, id: string): Win => w.document.querySelector(`.window[data-window-id="${id}"]`);

describe('@TOM INFO › RUNS: the window tiles fold', () => {
    test('RO-1: expanded when a run needs the user, collapsed with the badges otherwise', () => {
        const { w } = setup();
        send(w, WINDOWS(true));
        assert.ok(tile(w, 'me').classList.contains('expanded'), 'a run waits for the user');
        assert.equal(tile(w, 'me').querySelectorAll('.run').length, 3);
        assert.equal(tile(w, 'me').querySelector('.head-badges'), null, 'expanded: no badges in the headline');
        const other = tile(w, 'other');
        assert.ok(other.classList.contains('collapsed'), 'nothing needs the user');
        assert.equal(other.querySelectorAll('.run').length, 0, 'no run rows');
        const badges = [...other.querySelectorAll('.window-head .head-badges .badge')];
        assert.deepEqual(badges.map((b: Win) => b.title), ['Run b1: running', 'Run b2: idle'], 'in the runs\' alphabetical order');
        assert.deepEqual(badges.map((b: Win) => b.textContent), ['running', 'idle']);
        assert.ok(badges[0].classList.contains('state-running'));
        send(w, WINDOWS(false));
        assert.ok(tile(w, 'me').classList.contains('collapsed'), 'no longer needed: collapsed');
        assert.deepEqual([...tile(w, 'me').querySelectorAll('.head-badges .badge')].map((b: Win) => b.title), ['Run alpha: idle', 'Run mid: paused', 'Run zeta: running']);
    });

    test('RO-2: folded by hand, kept until the need changes', () => {
        const { w, posted, state } = setup();
        send(w, WINDOWS(false));
        tile(w, 'other').querySelector('.window-head').click();
        assert.ok(tile(w, 'other').classList.contains('expanded'), 'unfolded by hand');
        assert.equal(tile(w, 'other').querySelector('.head-badges'), null);
        send(w, WINDOWS(false));
        assert.ok(tile(w, 'other').classList.contains('expanded'), 'kept across a refresh');
        assert.deepEqual((state().folded as Record<string, unknown>).other, { expanded: true, needsUser: false }, 'in the view\'s state');
        // Restored from the view's state.
        const again = setup(state());
        send(again.w, WINDOWS(false));
        assert.ok(tile(again.w, 'other').classList.contains('expanded'));
        // Folded by hand while it needs the user; once the need goes, it follows it.
        send(w, WINDOWS(true));
        const head = tile(w, 'me').querySelector('.window-head');
        head.dispatchEvent(new w.KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
        assert.ok(tile(w, 'me').classList.contains('collapsed'), 'Enter folds it');
        send(w, WINDOWS(true));
        assert.ok(tile(w, 'me').classList.contains('collapsed'), 'kept while the need is the same');
        send(w, WINDOWS(false));
        send(w, WINDOWS(true));
        assert.ok(tile(w, 'me').classList.contains('expanded'), 'the need changed: it follows it again');
        // A run row still selects its run.
        tile(w, 'me').querySelector('.run[data-run="mid"]').click();
        assert.deepEqual(posted.filter((m) => m.type === 'selectRun').at(-1), { type: 'selectRun', windowId: 'me', run: 'mid' });
    });
});
