/**
 * The Prompt Queue editor's context bar (media/queueEditor): Quest, Role and
 * the queue's default Agent SDK session in one line, Role and Session
 * clickable — each opens a VS Code picker on the host.
 *
 *   QC-1 the bar reads `Quest: … | Role: … | Session: …` (then Projects); Role and Session are links;
 *        without a role the Role link offers to set one; there is no separate session row
 *   QC-2 clicking Role posts `pickRole`, clicking Session `pickQueueDefaultSession`; a state update
 *        refreshes the session shown
 *   QC-3 the Session link names the default session's base and its lifetime when not `continue`
 *        (`Session: walk based on prep (per iteration)`), all of it the link
 *   QC-4 an Anthropic item's session chip: a `*` after the name when its effective session has a base,
 *        the tooltip naming base and lifetime; the same for a session the item's spec will create;
 *        clicking it posts `editItemSession`
 *   QC-5 the host: `editItemSession` opens the item's session picker — it no longer falls through into
 *        `pickRole`, which opened the ROLE picker — and the state carries every session's base and lifetime
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

function setup(t: { after(fn: () => void): void }, state: Record<string, unknown>): { window: Win; posted: Array<Record<string, unknown>> } {
    const html = readMedia('queueEditor', 'index.html').replace(/<script[\s\S]*?<\/script>/g, '');
    const dom = new JSDOM(html, { runScripts: 'outside-only' });
    const window = dom.window as Win;
    t.after(() => window.close());
    const posted: Array<Record<string, unknown>> = [];
    window.acquireVsCodeApi = () => ({ postMessage: (m: Record<string, unknown>) => posted.push({ ...m }), setState: () => undefined, getState: () => undefined });
    window.__INIT__ = { state: { items: [], autoSend: false, ...state } };
    window.eval([
        readMedia('shared', 'queueEntryUtils.js'),
        readMedia('shared', 'queueEntryRenderFunctions.js'),
        readMedia('shared', 'queueEntryMessageHandlers.js'),
        readMedia('queueEditor', 'main.js'),
    ].join('\n;\n'));
    return { window, posted };
}

describe('Prompt Queue editor — the context bar', () => {
    test('QC-1: Quest, Role and Session in one line', (t) => {
        const { window } = setup(t, { context: { quest: 'tom_uam', role: 'spec_author', activeProjects: ['tom_uam'] }, queueDefaultSession: 'p2s3r1ss1' });
        const bar = window.document.getElementById('contextSummary');
        assert.equal(bar.textContent, 'Quest: tom_uam  |  Role: spec_author  |  Session: p2s3r1ss1  |  Projects: tom_uam');
        const links = [...bar.querySelectorAll('.ctx-link')];
        assert.deepEqual(links.map((l: Win) => [l.dataset.pick, l.textContent]), [['role', 'spec_author'], ['session', 'p2s3r1ss1']]);
        assert.equal(window.document.getElementById('queueDefaultSessionRow'), null, 'the session moved into the bar');
        const none = setup(t, { context: { quest: 'q', role: '', activeProjects: [] } }).window.document.getElementById('contextSummary');
        assert.equal(none.textContent, 'Quest: q  |  Role: (none)  |  Session: default');
    });

    test('QC-2: the links open the pickers', (t) => {
        const { window, posted } = setup(t, { context: { quest: 'q', role: 'spec_author', activeProjects: [] }, queueDefaultSession: '' });
        const link = (pick: string): Win => window.document.querySelector(`#contextSummary .ctx-link[data-pick="${pick}"]`);
        link('role').click();
        assert.deepEqual(posted.pop(), { type: 'pickRole' });
        link('session').click();
        assert.deepEqual(posted.pop(), { type: 'pickQueueDefaultSession' });
        window.dispatchEvent(new window.MessageEvent('message', { data: { type: 'state', items: [], context: { quest: 'q', role: 'spec_author', activeProjects: [] }, queueDefaultSession: 'per-todo' } }));
        assert.equal(link('session').textContent, 'per-todo');
    });

    test('QC-3: the default session with its base and lifetime', (t) => {
        const label = (session: string, sessionInfo: Record<string, unknown>): string => {
            const { window } = setup(t, { context: { quest: 'q', role: '', activeProjects: [] }, queueDefaultSession: session, sessionInfo });
            return window.document.querySelector('#contextSummary .ctx-link[data-pick="session"]').textContent;
        };
        assert.equal(label('walk', { walk: { mode: 'continue' } }), 'walk', 'no base, continue: the name alone');
        assert.equal(label('walk', { walk: { mode: 'continue', basedOn: 'prep' } }), 'walk based on prep');
        assert.equal(label('walk', { walk: { mode: 'per-prompt', basedOn: 'prep' } }), 'walk based on prep (per prompt)');
        assert.equal(label('walk', { walk: { mode: 'per-iteration', basedOn: 'prep' } }), 'walk based on prep (per iteration)');
        assert.equal(label('walk', { walk: { mode: 'per-iteration' } }), 'walk (per iteration)');
        assert.equal(label('walk', { walk: { mode: 'fork-from-base', basedOn: 'prep' } }), 'walk based on prep (per prompt)', 'the old name');
        assert.equal(label('', {}), 'default', 'a session with no file: the name alone');
        const { window } = setup(t, { context: { quest: 'q', role: '', activeProjects: [] }, queueDefaultSession: 'walk', sessionInfo: { walk: { mode: 'per-prompt', basedOn: 'prep' } } });
        assert.match(window.document.querySelector('#contextSummary .ctx-link[data-pick="session"]').title, /Session walk, based on prep, started again for every prompt/);
    });

    test('QC-4: an item\'s session chip', (t) => {
        const item = (id: string, extra: Record<string, unknown>): Record<string, unknown> => ({
            id, status: 'staged', type: 'normal', originalText: 'x', createdAt: '2026-10-26T10:00:00Z', transport: 'anthropic', followUps: [], ...extra,
        });
        const { window, posted } = setup(t, {
            items: [
                item('own', { session: 'walk' }),
                item('plain', { session: 'solo' }),
                item('spec', { session: 'fresh', sessionCreate: { basedOn: 'prep', mode: 'per-iteration' } }),
                item('inherit', {}),
            ],
            queueDefaultSession: 'qdef',
            sessionInfo: { walk: { mode: 'per-prompt', basedOn: 'prep' }, solo: { mode: 'continue' }, qdef: { mode: 'continue', basedOn: 'base' } },
        });
        const chip = (id: string): Win => window.document.querySelector(`[data-id="${id}"] .queue-session-chip`)
            ?? [...window.document.querySelectorAll('.queue-session-chip')].find((c: Win) => (c.getAttribute('onclick') ?? '').includes(`'${id}'`));
        assert.equal(chip('own').textContent, 'walk*', 'a based session is marked');
        assert.match(chip('own').title, /Session walk, based on prep, started again for every prompt — click to change/);
        assert.equal(chip('plain').textContent, 'solo', 'no base: no mark');
        assert.equal(chip('spec').textContent, 'fresh*', 'a spec not created yet: from the spec');
        assert.match(chip('spec').title, /based on prep, started again for every queue iteration — created when the item is sent/);
        assert.equal(chip('inherit').textContent, 'qdef*', 'the queue default\'s base');
        assert.match(chip('inherit').title, /\(queue default\)/);
        posted.length = 0;
        // jsdom runs no inline handlers here: run the chip's onclick as the browser would.
        assert.equal(chip('own').getAttribute('onclick'), "editItemSession('own')");
        window.eval(chip('own').getAttribute('onclick'));
        assert.deepEqual(posted.filter((m) => m.type === 'editItemSession'), [{ type: 'editItemSession', id: 'own' }]);
    });

    test('QC-5: the host opens the session picker for an item', () => {
        const handler = readFileSync(join(__dirname, '..', '..', '..', 'src', 'handlers', 'queueEditor-handler.ts'), 'utf-8');
        const caseBlock = (label: string): string => {
            const start = handler.indexOf(`case '${label}':`);
            assert.ok(start > 0, label);
            return handler.slice(start, handler.indexOf('return;\n        }', start));
        };
        assert.doesNotMatch(caseBlock('editItemSession'), /showQuickPick|listRoleNames|chat\.role/, 'not the role picker');
        assert.match(caseBlock('editItemSession'), /pickAgentSdkSession\([\s\S]*pqm\.updateItemSession\(id, picked\)/, 'the session picker, then the item');
        assert.doesNotMatch(caseBlock('pickRole'), /editItemSession/);
        assert.match(handler, /sessionInfo = sessionInfoOf\(listSessions\(sessionsFolder\(/);
    });
});
