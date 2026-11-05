/**
 * The Prompt Queue editor and a running process step (media/queueEditor,
 * media/shared/queueEntryRenderFunctions.js): each item shows the process
 * position it belongs to, and a process-move marker shows as such.
 *
 *   QP-1 an item with a position shows `[⚙ <position>]`; the marker shows `⏭ move the process to …` and
 *        `[⏭ process move]`, naming where it moves from and to; an item without a position shows neither
 *   QP-2 the host puts `processPosition` into the state
 */

import test, { describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { JSDOM } from 'jsdom';

function readMedia(...parts: string[]): string {
    return readFileSync(join(__dirname, '..', '..', '..', 'media', ...parts), 'utf-8');
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Win = any;

function setup(t: { after(fn: () => void): void }, items: unknown[]): Win {
    const html = readMedia('queueEditor', 'index.html').replace(/<script[\s\S]*?<\/script>/g, '');
    const dom = new JSDOM(html, { runScripts: 'outside-only' });
    const window = dom.window as Win;
    t.after(() => window.close());
    window.acquireVsCodeApi = () => ({ postMessage: () => undefined, setState: () => undefined, getState: () => undefined });
    window.__INIT__ = {
        state: { items, autoSend: false },
        queueDefaultPickerHtml: '<select id="queueDefault-transport-profile"></select>',
        addFormPickerHtml: '<select id="addForm-transport-profile"></select>',
    };
    window.eval([
        readMedia('shared', 'queueEntryUtils.js'),
        readMedia('shared', 'queueEntryRenderFunctions.js'),
        readMedia('shared', 'queueEntryMessageHandlers.js'),
        readMedia('queueEditor', 'main.js'),
    ].join('\n;\n'));
    return window;
}

const RUN = { quest: 'q', proceedId: 'proceed-1', state: { process: 'flow', phase: 'build', phaseIteration: 1, step: 'code', stepIteration: 1, substep: '', substepIteration: 1, completed: false } };
const base = { type: 'normal', template: '(None)', createdAt: '2026-11-05T10:00:00.000Z' };

describe('Prompt Queue editor — process positions', () => {
    test('QP-1: positions and the marker', (t) => {
        const window = setup(t, [
            { ...base, id: 'p', status: 'sending', originalText: 'step prompt', expandedText: 'step prompt', processRun: RUN, processPosition: 'q: Build #1 › Code #1' },
            { ...base, id: 'm', status: 'pending', originalText: '⏭ move the process to Build #1 › Gate #1', expandedText: '', processRun: RUN,
                processPosition: 'q: Build #1 › Code #1', processMove: { kind: 'proceed', label: 'Proceed', to: 'Build #1 › Gate #1' } },
            { ...base, id: 'x', status: 'pending', originalText: 'other', expandedText: 'other' },
        ]);
        const headers = [...window.document.querySelectorAll('.queue-item .item-header')].map((h: Win) => h.textContent);
        assert.equal(headers.length, 3);
        assert.match(headers[0], /\[⚙ q: Build #1 › Code #1\]/);
        assert.match(headers[1], /\[⏭ process move\]/);
        assert.doesNotMatch(headers[1], /\[⚙/, 'the marker shows as a marker, not as a prompt');
        const badge = window.document.querySelector('.process-move');
        assert.match(badge.title, /never sent to a model/);
        assert.match(badge.title, /q: Build #1 › Code #1 → Build #1 › Gate #1/);
        assert.match(window.document.body.textContent, /⏭ move the process to Build #1 › Gate #1/);
        assert.doesNotMatch(headers[2], /\[⚙|process move/, 'an item without a position');
    });

    test('QP-2: the host puts processPosition into the state', () => {
        const src = readFileSync(join(__dirname, '..', '..', '..', 'src', 'handlers', 'queueEditor-handler.ts'), 'utf-8');
        assert.match(src, /processPosition/);
    });
});
