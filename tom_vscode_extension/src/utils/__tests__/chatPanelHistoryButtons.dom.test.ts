/**
 * The @CHAT ANTHROPIC/LLM status bar's history and memory buttons (media/chatPanel/main.js, chatPanel-handler.ts), in
 * a JSDOM running the real script.
 *
 *   HB-1 one Rebuild history and memory button; no Recreate history / Recreate memory buttons; a click posts
 *        `rebuildHistoryAndMemory`, and its progress shows on the status line until the host says it is done
 *   HB-4 its secondary action Rebuild from scratch: Shift+click and right-click post `rebuildHistoryFromScratch`
 *        (named in the tooltip); the host asks first (modal), answers `historyRebuildDone` when declined, else
 *        rebuilds with `fromScratch`
 *   HB-2 Promote memory shows only with the setting (`__INIT__.promoteMemoryButton`, then `promoteMemoryButton`
 *        messages); a click posts `promoteMemory` with the panel's profile and the subpanel's queue mode
 *   HB-3 the host: the setting `tomAi.memory.promoteMemoryButton` (boolean, default false) in package.json, read into
 *        `__INIT__` and followed on change; the two messages are handled, the recreate ones are gone
 */

import test, { describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { JSDOM } from 'jsdom';

import { promoteMemoryButtonSetting } from '../vscodeSettings.js';

const ROOT = join(__dirname, '..', '..', '..');
const read = (...parts: string[]): string => readFileSync(join(ROOT, ...parts), 'utf-8');

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Win = any;

function setup(t: { after(fn: () => void): void }, init: Record<string, unknown> = {}) {
    const html = read('media', 'chatPanel', 'index.html').replace(/<script[\s\S]*?<\/script>/g, '');
    const dom = new JSDOM(html, { runScripts: 'outside-only' });
    const w = dom.window as Win;
    t.after(() => w.close());
    const posted: Array<Record<string, unknown>> = [];
    w.acquireVsCodeApi = () => ({
        postMessage: (m: Record<string, unknown>) => posted.push(JSON.parse(JSON.stringify(m))),
        setState: () => undefined,
        getState: () => ({ expanded: ['anthropic'], pinned: [] }),
    });
    w.__INIT__ = { ...init };
    w.eval(read('media', 'chatPanel', 'main.js'));
    const send = (data: Record<string, unknown>): void => { w.dispatchEvent(new w.MessageEvent('message', { data })); };
    const $ = (sel: string) => w.document.querySelector(sel);
    return { w, posted, send, $ };
}

describe('the chat panel\'s history and memory buttons', () => {
    test('HB-1: one Rebuild history and memory button', (t) => {
        const s = setup(t);
        const buttons = s.w.document.querySelectorAll('[data-action="rebuildHistoryAndMemory"]');
        assert.equal(buttons.length, 1);
        assert.match(buttons[0].title, /^Rebuild history and memory: /);
        assert.match(buttons[0].title, /memory candidates/);
        assert.equal(s.$('[data-action="recreateHistoryFromTrail"]'), null);
        assert.equal(s.$('[data-action="recreateMemoryFromTrail"]'), null);

        const status = () => s.$('#anthropic-status').textContent;
        s.send({ type: 'anthropicStatus', text: 'not shown while idle' });
        assert.equal(status(), '');
        buttons[0].click();
        assert.deepEqual(s.posted.at(-1), { type: 'rebuildHistoryAndMemory' });
        s.send({ type: 'anthropicStatus', text: 'Rebuild history: folding chunk 1/2 (3 turns, 0 archived todos)…' });
        assert.match(status(), /folding chunk 1\/2/);
        s.send({ type: 'anthropicStatus', text: 'History and memory rebuilt — 3 turns and 0 archived todos folded, 1 memory extraction' });
        assert.match(status(), /History and memory rebuilt/);
        s.send({ type: 'historyRebuildDone' });
        s.send({ type: 'anthropicStatus', text: 'later status' });
        assert.match(status(), /History and memory rebuilt/, 'after it is done the status stays');
    });

    test('HB-4: Rebuild from scratch, the secondary action', (t) => {
        const s = setup(t);
        const btn = s.$('[data-action="rebuildHistoryAndMemory"]');
        assert.match(btn.title, /Shift\+click or right-click: Rebuild from scratch — asks first/);
        btn.dispatchEvent(new s.w.MouseEvent('click', { bubbles: true, shiftKey: true }));
        assert.deepEqual(s.posted.at(-1), { type: 'rebuildHistoryFromScratch' });
        s.posted.length = 0;
        btn.dispatchEvent(new s.w.MouseEvent('contextmenu', { bubbles: true, cancelable: true }));
        assert.deepEqual(s.posted, [{ type: 'rebuildHistoryFromScratch' }]);
        const panel = read('src', 'handlers', 'chatPanel-handler.ts');
        assert.match(panel, /case 'rebuildHistoryFromScratch':[\s\S]{0,400}showWarningMessage\([\s\S]{0,600}modal: true[\s\S]{0,800}REBUILD_FROM_SCRATCH_CHOICE,\s*\);\s*if \(choice !== REBUILD_FROM_SCRATCH_CHOICE\) \{\s*void this\._view\?\.webview\.postMessage\(\{ type: 'historyRebuildDone' \}\);/);
        assert.match(panel, /rebuildQuestHistoryAndMemory\(undefined, \{ fromScratch: true \}\)/);
    });

    test('HB-2: Promote memory only with the setting', (t) => {
        const off = setup(t);
        const btnOff = off.$('#anthropic-promote-memory-btn');
        assert.ok(btnOff);
        assert.equal(btnOff.style.display, 'none', 'hidden by default');
        off.send({ type: 'promoteMemoryButton', visible: true });
        assert.equal(btnOff.style.display, '', 'shown when the setting is switched on');
        off.send({ type: 'promoteMemoryButton', visible: false });
        assert.equal(btnOff.style.display, 'none');

        const on = setup(t, { promoteMemoryButton: true });
        const btn = on.$('#anthropic-promote-memory-btn');
        assert.equal(btn.style.display, '');
        assert.equal(btn.dataset.action, 'promoteMemory');
        assert.match(btn.title, /^Promote memory: queue a prompt/);
        btn.click();
        const msg = on.posted.at(-1)!;
        assert.equal(msg.type, 'promoteMemory');
        assert.ok(['staged', 'pending'].includes(String(msg.initialStatus)), 'the subpanel\'s queue mode');
        assert.ok('anthropicProfileId' in msg, 'the panel\'s profile');
    });

    test('HB-3: the setting and the host', () => {
        const pkg = JSON.parse(read('package.json')) as { contributes: { configuration: { properties: Record<string, { type: string; default: unknown }> } } };
        const setting = pkg.contributes.configuration.properties['tomAi.memory.promoteMemoryButton'];
        assert.deepEqual([setting.type, setting.default], ['boolean', false]);
        // The reader: on only when set to true.
        assert.equal(promoteMemoryButtonSetting(() => undefined), false);
        assert.equal(promoteMemoryButtonSetting((k) => (k === 'memory.promoteMemoryButton' ? true : undefined)), true);
        assert.equal(promoteMemoryButtonSetting(() => 'yes'), false);
        const panel = read('src', 'handlers', 'chatPanel-handler.ts');
        assert.match(panel, /promoteMemoryButtonSetting\(\(key\) => vscode\.workspace\.getConfiguration\('tomAi'\)\.get\(key\)\)/);
        assert.match(panel, /export const PROMOTE_MEMORY_BUTTON_SETTING = 'tomAi\.memory\.promoteMemoryButton';/);
        assert.match(panel, /promoteMemoryButton: promoteMemoryButtonEnabled\(\),/, 'read into __INIT__');
        assert.match(panel, /e\.affectsConfiguration\(PROMOTE_MEMORY_BUTTON_SETTING\)[\s\S]{0,200}type: 'promoteMemoryButton', visible: promoteMemoryButtonEnabled\(\)/, 'followed on change');
        assert.match(panel, /case 'rebuildHistoryAndMemory':[\s\S]{0,600}rebuildQuestHistoryAndMemory\(\)[\s\S]{0,200}type: 'historyRebuildDone'/);
        assert.match(panel, /case 'promoteMemory':/);
        assert.doesNotMatch(panel, /recreateHistoryFromTrail|recreateMemoryFromTrail/);
        assert.doesNotMatch(read('media', 'chatPanel', 'main.js'), /recreateHistoryFromTrail|recreateMemoryFromTrail/);
    });
});
