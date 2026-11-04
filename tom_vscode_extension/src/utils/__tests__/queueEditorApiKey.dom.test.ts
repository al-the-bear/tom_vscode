/**
 * The Prompt Queue editor and a missing direct-API key (media/queueEditor).
 *
 * finishvsf3, the user's look: the @CHAT panel's profile list marked the
 * key-less direct profiles '(no API key)', the queue editor's pickers did not.
 * The host renders both pickers with the marks (transportPicker.ts), but the
 * editor's script refilled the profile lists from its state on every update,
 * and that state carried only id and name.
 *
 *   QK-1 the state carries `noApiKey` per profile and for the default profile; after a state update the
 *        queue-default and add-form pickers still mark the key-less profiles '(no API key)', and only them
 *   QK-2 an item whose stages would fail for a missing key shows its 'No API key' chip in the editor
 *   QK-3 the chips come first in the item's body, right under its header and before the prompt text:
 *        the 'No API key' chip, and the interruption chip (why a send did not complete) beside it; the
 *        user found the key chip at the bottom, after the answer, where it is missed (finishvsf3)
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

/** The two host-rendered pickers, reduced to the profile selects main.js refills. */
const PICKERS = {
    queueDefaultPickerHtml: '<select id="queueDefault-transport-profile"></select>',
    addFormPickerHtml: '<select id="addForm-transport-profile"></select>',
};

const PROFILES = [
    { id: 'sonnet-5-5-direct', name: 'Sonnet 5.5 — Direct', noApiKey: true },
    { id: 'opus-5-5-agent-sdk-mm', name: 'Opus 5.5 — Agent SDK SDK-MM', noApiKey: false },
];

function setup(t: { after(fn: () => void): void }, state: Record<string, unknown>): Win {
    const html = readMedia('queueEditor', 'index.html').replace(/<script[\s\S]*?<\/script>/g, '');
    const dom = new JSDOM(html, { runScripts: 'outside-only' });
    const window = dom.window as Win;
    t.after(() => window.close());
    window.acquireVsCodeApi = () => ({ postMessage: () => undefined, setState: () => undefined, getState: () => undefined });
    window.__INIT__ = { state: { items: [], autoSend: false, ...state }, ...PICKERS };
    window.eval([
        readMedia('shared', 'queueEntryUtils.js'),
        readMedia('shared', 'queueEntryRenderFunctions.js'),
        readMedia('shared', 'queueEntryMessageHandlers.js'),
        readMedia('queueEditor', 'main.js'),
    ].join('\n;\n'));
    return window;
}

const optionLabels = (window: Win, id: string): string[] =>
    [...window.document.getElementById(id).options].map((o: Win) => o.textContent);

describe('Prompt Queue editor — a missing API key', () => {
    test('QK-1: the pickers keep the (no API key) marks after a state update', (t) => {
        const window = setup(t, { anthropicProfiles: PROFILES, defaultProfileNoApiKey: false });
        window.dispatchEvent(new window.MessageEvent('message', {
            data: { type: 'state', items: [], anthropicProfiles: PROFILES, defaultProfileNoApiKey: true },
        }));
        for (const id of ['queueDefault-transport-profile', 'addForm-transport-profile']) {
            assert.deepEqual(optionLabels(window, id), [
                '(default profile) (no API key)',
                'Sonnet 5.5 — Direct (sonnet-5-5-direct) (no API key)',
                'Opus 5.5 — Agent SDK SDK-MM (opus-5-5-agent-sdk-mm)',
            ], id);
        }
    });

    test('QK-1: the host puts noApiKey into the state', () => {
        const src = readFileSync(join(__dirname, '..', '..', '..', 'src', 'handlers', 'queueEditor-handler.ts'), 'utf-8');
        assert.match(src, /profileKeyStates\(/);
        assert.match(src, /defaultProfileNoApiKey/);
    });

    test('QK-2: a staged item on a key-less profile shows its No API key chip', (t) => {
        const item = {
            id: 'probe1', status: 'staged', type: 'normal', transport: 'anthropic', anthropicProfileId: 'sonnet-5-5-direct',
            originalText: 'probe', expandedText: 'probe', template: '(none)', createdAt: new Date().toISOString(),
            apiKeyWarnings: ['the main prompt: Anthropic profile "sonnet-5-5-direct" uses the direct API, and its key variable K2 is not set'],
        };
        const window = setup(t, { items: [item], anthropicProfiles: PROFILES });
        const chips = [...window.document.querySelectorAll('.api-key-warning')].map((c: Win) => c.textContent);
        assert.equal(chips.length, 1, 'the chip is rendered');
        assert.match(chips[0], /^No API key: the main prompt: .*K2 is not set$/);
    });

    test('QK-3: the chips are the first thing in the item body', (t) => {
        const item = {
            id: 'probe1', status: 'staged', type: 'normal', transport: 'anthropic', anthropicProfileId: 'sonnet-5-5-direct',
            originalText: 'probe text', expandedText: 'probe text', template: '(none)', createdAt: new Date().toISOString(),
            apiKeyWarnings: ['the main prompt: K2 is not set'],
            warning: { kind: 'overloaded', message: 'the API was overloaded', at: '2026-11-04T10:00:00.000Z' },
        };
        const window = setup(t, { items: [item], anthropicProfiles: PROFILES });
        const header = window.document.querySelector('.queue-item .item-header');
        const body = header.nextElementSibling;
        const firstTwo = [...body.children].slice(0, 2).map((c: Win) => c.className);
        assert.deepEqual(firstTwo, ['warning-chip api-key-warning', 'warning-chip'], 'the key chip first, then the interruption chip');
        const prompt = body.querySelector('textarea, .mainprompt-content');
        const chip = body.querySelector('.api-key-warning');
        assert.ok(chip.compareDocumentPosition(prompt) & window.Node.DOCUMENT_POSITION_FOLLOWING, 'the prompt text comes after the chip');
        assert.equal(window.document.querySelectorAll('.api-key-warning').length, 1, 'rendered once, not twice');
    });
});
