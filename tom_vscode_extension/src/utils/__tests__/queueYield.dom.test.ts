/**
 * "Let the next item go first" in the queue editor (vscimpb60e; media/shared/queueEntryRenderFunctions.js,
 * media/queueEditor/main.js) and in Continue's choices (utils/pendingQuestion.ts).
 *
 *   LG-1 a pending or sending iteration item the host offers it on shows the step-over button; a click posts
 *        `letNextGoFirst` with the item's id
 *   LG-2 without a following item it is shown disabled, the reason in its tooltip, and a click posts nothing
 *   LG-3 armed: the button is inverted and says a click keeps iterating; the item shows *yields after this iteration*
 *   LG-4 an item the host does not offer it on (not an iteration item, or sent) has no button
 *   LG-5 Continue on an iteration item offers *Let the next item go first*; armed, *Keep iterating*
 */

import test, { describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { JSDOM } from 'jsdom';

import { continueOptions } from '../pendingQuestion.js';

const ROOT = join(__dirname, '..', '..', '..');
const media = (...p: string[]): string => readFileSync(join(ROOT, 'media', ...p), 'utf-8');

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Win = any;

function queueEditor(items: unknown[]): { w: Win; posted: Win[] } {
    const html = media('queueEditor', 'index.html').replace(/<script[\s\S]*?<\/script>/g, '');
    const w = new JSDOM(html, { runScripts: 'outside-only' }).window as Win;
    const posted: Win[] = [];
    w.acquireVsCodeApi = () => ({ postMessage: (m: Win) => posted.push(JSON.parse(JSON.stringify(m))), setState: () => undefined, getState: () => undefined });
    w.__INIT__ = { state: { items, autoSend: true, anthropicProfiles: [], queueDefaultTransport: 'anthropic', reminderTemplates: [] }, queueDefaultPickerHtml: '', addFormPickerHtml: '' };
    w.eval([media('shared', 'mdOverlay.js'), media('shared', 'queueEntryUtils.js'), media('shared', 'queueEntryRenderFunctions.js'), media('shared', 'queueEntryMessageHandlers.js'), media('queueEditor', 'main.js')].join('\n;\n'));
    return { w, posted };
}
const base = { type: 'normal', template: '(None)', createdAt: new Date().toISOString(), expandedText: '', transport: 'anthropic' };
const entry = (w: Win, text: string): Win => [...w.document.querySelectorAll('.queue-item')].find((e: Win) => e.textContent.includes(text));
const click = (w: Win, el: Win): void => { const fn = el.getAttribute('onclick'); if (fn) { w.eval(fn); } };

describe('Let the next item go first: the button', () => {
    test('LG-1: offered', () => {
        const { w, posted } = queueEditor([
            { ...base, id: 's1', status: 'sending', originalText: 'walk-sending', repeatCount: 'ya*', canLetNextGoFirst: true },
            { ...base, id: 'p1', status: 'pending', originalText: 'walk-pending', repeatCount: 3, canLetNextGoFirst: true },
            { ...base, id: 'p2', status: 'pending', originalText: 'plain-after' },
        ]);
        try {
            for (const [text, id] of [['walk-sending', 's1'], ['walk-pending', 'p1']]) {
                const btn = entry(w, text).querySelector('.yield-btn');
                assert.ok(btn, `${text}: the step-over button`);
                assert.ok(btn.classList.contains('codicon-debug-step-over'));
                assert.match(btn.title, /^Let the next item go first/);
                click(w, btn);
                assert.deepEqual(posted.at(-1), { type: 'letNextGoFirst', id });
            }
            assert.match(entry(w, 'walk-sending').querySelector('.yield-btn').title, /this iteration finishes/);
            assert.match(entry(w, 'walk-pending').querySelector('.yield-btn').title, /moves behind the next item/);
        } finally { w.close(); }
    });

    test('LG-2: disabled without a following item', () => {
        const { w, posted } = queueEditor([
            { ...base, id: 's1', status: 'sending', originalText: 'walk-alone', repeatCount: 'ya*', canLetNextGoFirst: false, letNextGoFirstUnavailable: 'no pending item follows it in its lane: nothing to let go first' },
        ]);
        try {
            const btn = entry(w, 'walk-alone').querySelector('.yield-btn');
            assert.ok(btn.classList.contains('disabled'));
            assert.equal(btn.getAttribute('aria-disabled'), 'true');
            assert.match(btn.title, /not now: no pending item follows it in its lane/);
            const before = posted.length;
            click(w, btn);
            assert.equal(posted.length, before, 'a click posts nothing');
        } finally { w.close(); }
    });

    test('LG-3: armed', () => {
        const { w } = queueEditor([
            { ...base, id: 's1', status: 'sending', originalText: 'walk-armed', repeatCount: 'ya*', canLetNextGoFirst: true, yieldAfterIteration: true },
            { ...base, id: 'p2', status: 'pending', originalText: 'plain-after' },
        ]);
        try {
            const item = entry(w, 'walk-armed');
            assert.match(item.querySelector('.yield-badge').textContent, /yields after this iteration/);
            const btn = item.querySelector('.yield-btn');
            assert.ok(btn.classList.contains('armed'));
            assert.match(btn.title, /click to keep iterating/);
        } finally { w.close(); }
    });

    test('LG-4: not offered', () => {
        const { w } = queueEditor([
            { ...base, id: 'p1', status: 'pending', originalText: 'plain-one' },
            { ...base, id: 'x1', status: 'sent', originalText: 'walk-done', repeatCount: 'ya*' },
        ]);
        try {
            assert.equal(entry(w, 'plain-one').querySelector('.yield-btn'), null);
            assert.equal(entry(w, 'walk-done').querySelector('.yield-btn'), null);
        } finally { w.close(); }
    });

    test('LG-5: in Continue\'s choices', () => {
        const offered = continueOptions({ waitingForAnswer: false, canResend: true, walk: true, canLetNextGoFirst: true }).map((o) => [o.action, o.label]);
        assert.deepEqual(offered, [['letNextGoFirst', 'Let the next item go first'], ['resend', 'Resend this stage'], ['skip', 'Skip to the next todo']]);
        const armed = continueOptions({ waitingForAnswer: false, canResend: true, walk: true, canLetNextGoFirst: true, yieldArmed: true }).map((o) => o.label);
        assert.ok(armed.includes('Keep iterating (do not let the next item go first)'));
        const none = continueOptions({ waitingForAnswer: false, canResend: true, walk: false }).map((o) => o.action);
        assert.ok(!none.includes('letNextGoFirst'), 'not offered when it cannot');
    });
});
