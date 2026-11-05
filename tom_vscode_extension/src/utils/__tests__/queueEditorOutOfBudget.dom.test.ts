/**
 * The Prompt Queue editor and a stage stopped for a too-low credit balance
 * (media/shared/queueEntryRenderFunctions.js, finishvsf6).
 *
 *   OB-6 the item shows, first in its body, why it stopped (profile, session), a profile picker
 *        preset to the profile's suggestion, "Continue on profile" and "Resend"; the buttons post
 *        continueOnProfile with the picked profile and resendLastPrompt
 *   OB-7 without a suggestion the picker starts on the first other profile; the profile that ran
 *        out is not offered
 */

import test, { describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { JSDOM } from 'jsdom';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Win = any;

const readMedia = (...parts: string[]): string => readFileSync(join(__dirname, '..', '..', '..', 'media', ...parts), 'utf-8');

const PROFILES = [
    { id: 'opus-5-5-direct', name: 'Opus 5.5 — Direct', noApiKey: false },
    { id: 'sonnet-5-5-agent-sdk-mm', name: 'Sonnet 5.5 — Agent SDK SDK-MM', noApiKey: false },
    { id: 'opus-5-5-agent-sdk-mm', name: 'Opus 5.5 — Agent SDK SDK-MM', noApiKey: false },
];

function setup(t: { after(fn: () => void): void }, outOfBudget: Record<string, unknown>): { window: Win; posted: Array<Record<string, unknown>> } {
    const html = readMedia('queueEditor', 'index.html').replace(/<script[\s\S]*?<\/script>/g, '');
    const dom = new JSDOM(html, { runScripts: 'outside-only' });
    const window = dom.window as Win;
    t.after(() => window.close());
    const posted: Array<Record<string, unknown>> = [];
    window.acquireVsCodeApi = () => ({ postMessage: (m: Record<string, unknown>) => posted.push(m), setState: () => undefined, getState: () => undefined });
    const item = {
        id: 'q1', status: 'error', type: 'normal', transport: 'anthropic', anthropicProfileId: 'opus-5-5-direct',
        originalText: 'Do quest todo finishvsf6', expandedText: 'x', template: '(none)', createdAt: new Date().toISOString(),
        error: 'Your credit balance is too low', outOfBudget,
    };
    window.__INIT__ = { state: { items: [item], autoSend: false, anthropicProfiles: PROFILES }, queueDefaultPickerHtml: '', addFormPickerHtml: '' };
    window.eval([
        readMedia('shared', 'queueEntryUtils.js'),
        readMedia('shared', 'queueEntryRenderFunctions.js'),
        readMedia('shared', 'queueEntryMessageHandlers.js'),
        readMedia('queueEditor', 'main.js'),
    ].join('\n;\n'));
    return { window, posted };
}

const MARK = { profileId: 'opus-5-5-direct', profileName: 'Opus 5.5 — Direct', session: 'default', message: 'Your credit balance is too low', at: '2026-11-05T09:24:50.000Z' };

describe('Prompt Queue editor — out of budget', () => {
    test('OB-6: the panel, its picker and its two buttons', (t) => {
        const { window, posted } = setup(t, { ...MARK, suggestedProfileId: 'opus-5-5-agent-sdk-mm' });
        const body = window.document.querySelector('.queue-item .item-header').nextElementSibling;
        const panel = body.firstElementChild;
        assert.equal(panel.className, 'warning-chip out-of-budget');
        assert.match(panel.textContent, /Out of budget: .*Opus 5\.5 — Direct.*session "default"/);
        const select = panel.querySelector('select');
        assert.equal(select.value, 'opus-5-5-agent-sdk-mm');
        const buttons = [...panel.querySelectorAll('button')].map((b: Win) => b.textContent);
        assert.deepEqual(buttons, ['Continue on profile', 'Resend']);
        select.value = 'sonnet-5-5-agent-sdk-mm';
        panel.querySelectorAll('button')[0].click();
        panel.querySelectorAll('button')[1].click();
        // The messages come from the page's realm: compare their JSON.
        assert.deepEqual(JSON.parse(JSON.stringify(posted.filter((m) => m.type === 'continueOnProfile' || m.type === 'resendLastPrompt'))), [
            { type: 'continueOnProfile', id: 'q1', profileId: 'sonnet-5-5-agent-sdk-mm' },
            { type: 'resendLastPrompt', id: 'q1' },
        ]);
    });

    test('OB-7: no suggestion; the profile that ran out is not offered', (t) => {
        const { window } = setup(t, MARK);
        const select = window.document.querySelector('.out-of-budget select');
        const values = [...select.options].map((o: Win) => o.value);
        assert.deepEqual(JSON.parse(JSON.stringify(values)), ['sonnet-5-5-agent-sdk-mm', 'opus-5-5-agent-sdk-mm']);
        assert.equal(select.value, 'sonnet-5-5-agent-sdk-mm');
    });
});
