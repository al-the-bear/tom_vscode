/**
 * The Chat Variables view (media/chatVariablesEditor/) in a JSDOM running its
 * real script.
 *
 *   CV-1  the process variables of the active quest are listed, read-only, under their own heading;
 *         a long description is shortened, its full text in the tooltip; without a process they read "—"
 */

import test, { describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { JSDOM } from 'jsdom';

const ROOT = join(__dirname, '..', '..', '..');
const asset = (file: string): string => readFileSync(join(ROOT, 'media', 'chatVariablesEditor', file), 'utf-8');

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Win = any;

function setup(): Win {
    const body = asset('index.html').split('<body>')[1].split('<script')[0].replace(/\{\{[a-zA-Z]+\}\}/g, '');
    const dom = new JSDOM(`<!DOCTYPE html><body>${body}</body>`, { runScripts: 'outside-only', pretendToBeVisual: true });
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
        assert.equal(desc.getAttribute('title'), long.trim());
        assert.equal(row('substep').querySelector('.var-readonly').textContent, '—');
    });
});
