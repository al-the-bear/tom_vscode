/**
 * The Chat Variables view (media/chatVariablesEditor/) in a JSDOM running its
 * real script.
 *
 *   CV-1  the process variables of the active quest are listed, read-only, under their own heading;
 *         a long description is shortened; without a process they read "—"
 *   CV-2  hovering a shortened value opens a scrollable popup with the whole text; it stays open while
 *         the pointer is on the value or the popup, and closes shortly after it left both
 */

import test, { describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { JSDOM } from 'jsdom';

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

const ROOT = join(__dirname, '..', '..', '..');
const asset = (file: string): string => readFileSync(join(ROOT, 'media', 'chatVariablesEditor', file), 'utf-8');

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Win = any;

function setup(): Win {
    const body = asset('index.html').split('<body>')[1].split('<script')[0].replace(/\{\{[a-zA-Z]+\}\}/g, '');
    const dom = new JSDOM(`<!DOCTYPE html><head><style>${asset("style.css")}</style></head><body>${body}</body>`, { runScripts: 'outside-only', pretendToBeVisual: true });
    const w = dom.window as Win;
    w.acquireVsCodeApi = () => ({ postMessage: () => undefined });
    w.eval(asset('main.js'));
    return w;
}
const send = (w: Win, process: Record<string, string>): void => {
    w.dispatchEvent(new w.MessageEvent('message', {
        data: { type: 'state', quest: 'tom_uam', role: 'spec_author', roles: [], activeProjects: [], todo: '', todoFile: 'all', custom: {}, changeLog: [], process },
    }));
};

describe('Chat Variables view', () => {
    test('CV-1: process variables, read-only', () => {
        const w = setup();
        const long = 'Deepen the Blueprint along its structure. '.repeat(10);
        send(w, { process: 'tom_specs', phase: 'phase2', step: '02-deepening', substep: '', 'phase-iteration': '1', 'step-iteration': '1', 'substep-iteration': '', 'process-description': '# TomSpecs', 'phase-description': 'Write the SBP.', 'step-description': long, 'substep-description': '' });
        const heading = [...w.document.querySelectorAll('.var-section')].map((e: Win) => e.textContent);
        assert.ok(heading.some((h: string) => /Process/.test(h)), 'a heading of its own');
        const row = (name: string): Win => [...w.document.querySelectorAll('tr')].find((tr: Win) => tr.querySelector('.var-name')?.textContent === name);
        assert.equal(row('process').querySelector('.var-readonly').textContent, 'tom_specs');
        assert.equal(row('step').querySelector('.var-readonly').textContent, '02-deepening');
        assert.equal(row('process').querySelector('input'), null, 'not editable here');
        const desc = row('step-description').querySelector('.var-readonly');
        assert.ok(desc.textContent.length < long.length && desc.textContent.endsWith('…'), 'shortened');
        assert.equal(desc.getAttribute('title'), null, 'no native tooltip: it could not be scrolled');
        assert.equal(row('substep').querySelector('.var-readonly').textContent, '—');
    });

    test('CV-2: the popup of a long value', async () => {
        const w = setup();
        const long = 'A long step description, line after line.\n'.repeat(40);
        send(w, { process: 'tom_specs', 'step-description': long });
        const value = [...w.document.querySelectorAll('.var-readonly')].find((e: Win) => e.textContent.endsWith('…'));
        const popup = (): Win => w.document.querySelector('.var-popup');
        const over = (el: Win, related?: Win): void => { el.dispatchEvent(new w.MouseEvent('mouseover', { bubbles: true, relatedTarget: related })); };
        const out = (el: Win, related?: Win): void => { el.dispatchEvent(new w.MouseEvent('mouseout', { bubbles: true, relatedTarget: related })); };
        over(value);
        await sleep(250);
        assert.ok(popup().classList.contains('visible'));
        assert.equal(popup().textContent, long.trim(), 'the whole text');
        assert.equal(w.getComputedStyle(popup()).overflowY, 'auto', 'scrollable');
        out(value, popup());
        over(popup(), value);
        await sleep(400);
        assert.ok(popup().classList.contains('visible'), 'stays open while the pointer is on the popup');
        out(popup(), w.document.body);
        await sleep(400);
        assert.ok(!popup().classList.contains('visible'), 'closes after leaving both');
        const short = [...w.document.querySelectorAll('.var-readonly')].find((e: Win) => e.textContent === 'tom_specs');
        over(short);
        await sleep(250);
        assert.ok(!popup().classList.contains('visible'), 'a value shown whole needs no popup');
    });
});
