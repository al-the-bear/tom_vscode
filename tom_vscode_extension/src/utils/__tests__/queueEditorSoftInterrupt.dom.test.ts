/**
 * The Prompt Queue editor's view of an interrupt for continuation and of what holds a running turn (vscimpb112;
 * media/queueEditor/main.js, media/shared/queueEntryRenderFunctions.js).
 *
 *   SE-1 runTabState for every state: held, question, wait, sending, paused (auto-send off, or a hard-interrupted
 *        item), waiting, idle — each with its icon (codicon-debug-disconnect, red ❓, ⏳, sync, debug-pause, clock,
 *        circle) and the tooltip text (held since … at the result of <tool>; the question's first line and since;
 *        reason, until, time left and since)
 *   SE-2 the precedence held > ❓ > ⏳ > sending > paused > waiting > idle
 *   SE-3 the row: INTERRUPTING with a spinning icon and the seconds left; HELD with the disconnect icon; ❓ ANSWER
 *        NEEDED; ⏳ WAITING UNTIL …; a hard-interrupted item keeps INTERRUPTED
 *   SE-4 the button: after the first click codicon-debug-stop and "Soft interrupt requested — click again for a hard
 *        interrupt now" (toolbar and row); before it the soft-first tooltip; a Copilot item's says it has no hold point
 *   SE-5 the host builds the views: softInterruptViewOf (requested / held, on a sending item only)
 */

import test, { describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { JSDOM } from 'jsdom';

import { installVscodeStub } from '../../tools/__tests__/_vscode-stub.js';

function readMedia(...parts: string[]): string {
    return readFileSync(join(__dirname, '..', '..', '..', 'media', ...parts), 'utf-8');
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Win = any;

function setup(t: { after(fn: () => void): void }, items: unknown[], runQueueSettings: Record<string, unknown> = {}): Win {
    const html = readMedia('queueEditor', 'index.html').replace(/<script[\s\S]*?<\/script>/g, '');
    const dom = new JSDOM(html, { runScripts: 'outside-only' });
    const w = dom.window as Win;
    t.after(() => w.close());
    w.acquireVsCodeApi = () => ({ postMessage: () => undefined, setState: () => undefined, getState: () => ({}) });
    w.__INIT__ = {
        state: { items, autoSend: true, processRuns: ['default'], currentRun: 'default', runQueueSettings },
        queueDefaultPickerHtml: '<select id="queueDefault-transport-profile"></select>',
        addFormPickerHtml: '<select id="addForm-transport-profile"></select>',
    };
    w.eval([
        readMedia('shared', 'queueEntryUtils.js'),
        readMedia('shared', 'queueEntryRenderFunctions.js'),
        readMedia('shared', 'queueEntryMessageHandlers.js'),
        readMedia('queueEditor', 'main.js'),
    ].join('\n;\n'));
    return w;
}

const base = { type: 'normal', template: '(None)', createdAt: '2026-11-15T10:00:00.000Z', originalText: 'x', expandedText: 'x', transport: 'anthropic', lastDispatched: { kind: 'main', expandedText: 'x', transport: 'anthropic' } };
const at = (h: number, m: number): number => new Date(2026, 10, 15, h, m).getTime();
const HELD = { phase: 'held', requestedAt: at(14, 4), heldAt: at(14, 5), kind: 'tool', tool: 'Bash', timeoutMs: 15000 };
const REQUESTED = { phase: 'requested', requestedAt: Date.now(), timeoutMs: 15000 };
const WAIT = { reason: 'pub.dev limit', until: new Date(Date.now() + 3_600_000).toISOString(), untilLabel: '14:20', left: 'until 14:20 (1 h left)', since: new Date(at(13, 10)).toISOString() };
const sending = (extra: Record<string, unknown>) => ({ ...base, id: `s${Math.random()}`, status: 'sending', ...extra });
const tab = (w: Win): Win => w.document.querySelector('#runTabs .run-tab[data-run="default"]');

describe('Prompt Queue editor — interrupt for continuation', () => {
    test('SE-1: every tab state, its icon and tooltip', (t) => {
        const cases: Array<[unknown[], Record<string, unknown>, string, string, RegExp]> = [
            [[sending({ softInterruptView: HELD })], {}, 'held', 'codicon-debug-disconnect', /held for continuation.*; held since 14:05 at the result of Bash/],
            [[sending({ waitingForUser: ['question'], questionView: { firstLine: 'Which order?', since: '14:02' } })], {}, 'question', '\u2753', /answer needed.*; Answer needed: Which order\? \(since 14:02\)/],
            [[sending({ waitForView: WAIT })], {}, 'wait', '\u23f3', /waiting \(tomAi_waitFor\).*; waiting: pub\.dev limit, until 14:20 \(1 h left\), since 13:10/],
            [[sending({})], {}, 'sending', 'codicon-sync', /sending/],
            [[{ ...base, id: 'p', status: 'pending' }], { default: { autoSend: false } }, 'paused', 'codicon-debug-pause', /paused/],
            [[{ ...base, id: 'i', status: 'interrupted' }], { default: { autoSend: true } }, 'paused', 'codicon-debug-pause', /paused/],
            [[{ ...base, id: 'p', status: 'pending' }], { default: { autoSend: true } }, 'waiting', 'codicon-clock', /waiting/],
            [[], {}, 'idle', 'codicon-circle-outline', /idle/],
        ];
        for (const [items, settings, state, icon, title] of cases) {
            const w = setup(t, items, settings);
            assert.equal(w.runTabState('default'), state, state);
            assert.equal(tab(w).dataset.state, state);
            if (icon.startsWith('codicon')) {
                assert.ok(tab(w).querySelector(`.codicon.${icon}`), `${state}: ${icon}`);
            } else {
                assert.equal(tab(w).querySelector('.run-tab-emoji')?.textContent, icon, `${state}: ${icon}`);
            }
            assert.match(tab(w).title, title, state);
        }
        const red = setup(t, [sending({ waitingForUser: ['question'] })]);
        assert.match(tab(red).querySelector('.run-tab-emoji').getAttribute('style'), /color:#e51400/, 'the ❓ is red');
    });

    test('SE-2: the precedence', (t) => {
        const order: Array<[string, Record<string, unknown>]> = [
            ['held', { softInterruptView: HELD }],
            ['question', { waitingForUser: ['question'] }],
            ['wait', { waitForView: WAIT }],
            ['sending', {}],
        ];
        for (let i = 0; i < order.length; i++) {
            // This state's item and every lower one: the tab shows this state.
            const items = order.slice(i).map(([, extra]) => sending(extra));
            items.push({ ...base, id: 'pend', status: 'pending' } as never);
            const w = setup(t, items, { default: { autoSend: false } });
            assert.equal(w.runTabState('default'), order[i][0]);
        }
        assert.equal(setup(t, [{ ...base, id: 'p', status: 'pending' }], { default: { autoSend: false } }).runTabState('default'), 'paused', 'paused > waiting');
    });

    test('SE-3: the row', (t) => {
        const w = setup(t, [
            sending({ id: 'r', softInterruptView: REQUESTED }),
            sending({ id: 'h', softInterruptView: HELD }),
            sending({ id: 'q', waitingForUser: ['question'], questionView: { firstLine: 'Which order?', since: '14:02' } }),
            sending({ id: 'w', waitForView: WAIT }),
            { ...base, id: 'i', status: 'interrupted' },
        ]);
        const row = (id: string): Win => w.document.querySelector(`[data-id="${id}"], #item-${id}`) ?? [...w.document.querySelectorAll('.queue-item, .item')].find((e: Win) => e.innerHTML.includes(`'${id}'`));
        const label = (id: string): Win => row(id).querySelector('.status-left');
        assert.match(label('r').textContent, /INTERRUPTING/);
        assert.ok(label('r').querySelector('.codicon-loading.codicon-modifier-spin'), 'spinning');
        assert.match(label('r').querySelector('.soft-interrupt-label').title, /hard interrupt in 1?\d s \(at \d\d:\d\d:\d\d\)/);
        assert.match(label('h').textContent, /HELD/);
        assert.ok(label('h').querySelector('.codicon-debug-disconnect'));
        assert.match(label('h').querySelector('.soft-interrupt-label').title, /held since 14:05 at the result of Bash/);
        assert.match(label('q').textContent, /\u2753 ANSWER NEEDED/);
        assert.match(label('q').querySelector('.answer-needed-label').title, /Which order\? \(since 14:02\)/);
        assert.match(label('w').textContent, /\u23f3 WAITING UNTIL 14:20/);
        assert.match(label('w').querySelector('.wait-for-label').title, /pub\.dev limit, until 14:20 \(1 h left\), since 13:10/);
        assert.match(label('i').textContent, /INTERRUPTED/);
    });

    test('SE-4: the button', (t) => {
        const requested = setup(t, [sending({ id: 'a', softInterruptView: REQUESTED })]);
        const btn = requested.document.getElementById('interruptForContinuationBtn');
        assert.equal(btn.title, 'Soft interrupt requested — click again for a hard interrupt now');
        assert.ok(btn.querySelector('.codicon-debug-stop'));
        const rowIcon = requested.document.querySelector('.status-icons .codicon-debug-stop');
        assert.equal(rowIcon?.getAttribute('title'), 'Soft interrupt requested — click again for a hard interrupt now');
        const fresh = setup(t, [sending({ id: 'b' })]);
        const freshBtn = fresh.document.getElementById('interruptForContinuationBtn');
        assert.ok(freshBtn.querySelector('.codicon-debug-disconnect'));
        assert.match(freshBtn.title, /soft first — the next tool result is held.*hard interrupt after 15 s without a hold point, or on a second click/);
        const copilot = setup(t, [sending({ id: 'c', transport: 'copilot', interruptTransport: 'copilot', lastDispatched: { kind: 'main', expandedText: 'x', transport: 'copilot' } })]);
        assert.match(copilot.document.getElementById('interruptForContinuationBtn').title, /Copilot prompt has no hold point — it is interrupted at once \(hard\)/);
    });

    test('SE-5: the host builds the views', async (t) => {
        const stub = installVscodeStub();
        t.after(() => stub.restore());
        const { softInterruptViewOf } = await import('../../handlers/queueEditor-handler.js');
        const item = { id: 'z', status: 'sending', softInterrupt: { requestedAt: 5, heldAt: 9, kind: 'tool', tool: 'Bash', heldResult: 'r' } } as never;
        assert.deepEqual(softInterruptViewOf(item), { phase: 'held', requestedAt: 5, timeoutMs: 15000, heldAt: 9, kind: 'tool', tool: 'Bash' });
        assert.deepEqual(softInterruptViewOf({ id: 'y', status: 'sending', softInterrupt: { requestedAt: 5 } } as never), { phase: 'requested', requestedAt: 5, timeoutMs: 15000 });
        assert.equal(softInterruptViewOf({ id: 'x', status: 'interrupted', softInterrupt: { requestedAt: 5 } } as never), undefined, 'a sending item only');
    });
});
