/**
 * The Prompt Queue editor's two context bars (media/queueEditor): one field per setting of the tab's run, its
 * label above its value; a value that can be changed is a link — each opens a VS Code picker on the host.
 *
 *   QC-1 the first bar (with the icon buttons): Position, Role, Default role, Guidelines, Variables; the second the
 *        run's defaults: Transport, Model (the Anthropic profile; Anthropic only), Session, Template — the tab's
 *        run's (vscimpb60c); the context fields each a `.ctx-label` over a `.ctx-value`, the defaults label-less
 *        (gsel22: the value, its name in the hover help); no Quest, Run or Projects field; every value
 *        but another run's role is a link; there is no separate session row and no transport-picker row
 *   QC-2 clicking Role posts `pickRole`, clicking Session `pickQueueDefaultSession`, Transport / Profile / Template
 *        `pickQueueDefaultTransport` / `…Profile` / `…Template` with the settings run; a state update refreshes the
 *        session shown; the host opens a picker for each and writes the run's defaults
 *   QC-3 the Session link names the default session's base and its lifetime when not `continue`; it shows the
 *        session the run's items run in: `default@default` in the `default` run, `default@<run>` in another
 *        (`Session: walk based on prep (per iteration)`), all of it the link
 *   QC-4 an Anthropic item's session chip: a `*` after the name when its effective session has a base,
 *        the tooltip naming base and lifetime; the same for a session the item's spec will create;
 *        clicking it starts the move flow (`relocateItem`: run, session, place)
 *   QC-5 the host: `editItemSession` opens the item's session picker — it no longer falls through into
 *        `pickRole`, which opened the ROLE picker — and the state carries every session's base and lifetime
 *   QC-7 the toolbar is icon buttons only: Send all staged, Retry all errors, Delete errors, Clear sent and Clear all
 *        as double icons, Collapse all / Expand all as the todo bar's collapse-all / expand-all icons, each with a
 *        title and its action
 *   QC-6 the item headline's type icon is a button: it posts `openItemLiveTrail` with the item's id, its title names
 *        the session the item runs in; the host opens that session's live trail (the chat panel's liveTrail action),
 *        a Copilot item gets a note instead
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
    test('QC-1: the run\'s context and its defaults in two bars', (t) => {
        const { window } = setup(t, { context: { quest: 'tom_uam', role: 'spec_author', activeProjects: ['tom_uam'] }, queueDefaultSession: 'p2s3r1ss1' });
        const bar = window.document.getElementById('contextSummary');
        const defaults = window.document.getElementById('runDefaultsSummary');
        const fields = (b: Win): string[] => [...b.querySelectorAll('.ctx-field')].map((f: Win) => `${f.querySelector('.ctx-label').textContent}: ${f.querySelector('.ctx-value').textContent}`);
        const picks = (b: Win): string[] => [...b.querySelectorAll('.ctx-link')].map((l: Win) => l.dataset.pick);
        // The run's defaults are label-less (gsel22): the value alone, the field's name opening its hover help.
        const bare = (b: Win): string[] => [...b.querySelectorAll('.ctx-field')].map((f: Win) => {
            assert.equal(f.querySelector('.ctx-label'), null, 'no label');
            const a = f.querySelector('.ctx-link');
            return `${a.title.split(':')[0]}: ${a.textContent}`;
        });
        assert.deepEqual(fields(bar), ['Position: (no process)', 'Role: spec_author', 'Default role: (none)', 'Variables: 0'], 'no Quest, Run or Projects');
        assert.deepEqual(picks(bar), ['position', 'role', 'defaultRole', 'variables']);
        assert.ok(bar.parentElement.querySelector('.ctx-btn-icon'), 'the icon buttons stay with the first bar');
        assert.deepEqual(bare(defaults), ['Transport: Copilot', 'Session: p2s3r1ss1', 'Template: (none)'], 'no Model on Copilot');
        assert.deepEqual(picks(defaults), ['transport', 'session', 'template']);
        assert.equal(bar.parentElement.compareDocumentPosition(defaults) & window.Node.DOCUMENT_POSITION_FOLLOWING, window.Node.DOCUMENT_POSITION_FOLLOWING, 'the defaults bar below');
        assert.equal(window.document.getElementById('queueDefaultSessionRow'), null, 'the session moved into the bar');
        assert.equal(window.document.getElementById('queueDefaultPickerSlot'), null, 'no transport-picker row');
        const none = setup(t, { context: { quest: 'q', role: '', activeProjects: [] } }).window.document;
        assert.deepEqual(fields(none.getElementById('contextSummary')), ['Position: (no process)', 'Role: (none)', 'Default role: (none)', 'Variables: 0']);
        assert.deepEqual(bare(none.getElementById('runDefaultsSummary')), ['Transport: Copilot', 'Session: default@default', 'Template: (none)']);
        // An Anthropic run shows its model (the profile, by name) and its template (by name).
        const anth = setup(t, {
            context: { quest: 'q', role: '', activeProjects: [] }, currentRun: 'default',
            runQueueSettings: { default: { defaultTransport: 'anthropic', defaultAnthropicProfileId: 'opus', defaultMessageTemplateId: 'execute-todo' } },
            anthropicProfiles: [{ id: 'opus', name: 'Opus' }], anthropicUserMessageTemplates: [{ id: 'execute-todo', name: 'Execute TODO' }],
        }).window.document.getElementById('runDefaultsSummary');
        assert.deepEqual(bare(anth), ['Transport: Anthropic', 'Model: Opus', 'Session: default@default', 'Template: Execute TODO']);
        assert.deepEqual(picks(anth), ['transport', 'profile', 'session', 'template']);
    });

    test('QC-2: the links open the pickers', (t) => {
        const { window, posted } = setup(t, { context: { quest: 'q', role: 'spec_author', activeProjects: [] }, queueDefaultSession: '' });
        const link = (pick: string): Win => window.document.querySelector(`.context-summary .ctx-link[data-pick="${pick}"]`);
        link('role').click();
        assert.deepEqual(posted.pop(), { type: 'pickRole' });
        link('session').click();
        assert.deepEqual(posted.pop(), { type: 'pickQueueDefaultSession', run: 'default' });
        link('transport').click();
        assert.deepEqual(posted.pop(), { type: 'pickQueueDefaultTransport', run: 'default' });
        link('template').click();
        assert.deepEqual(posted.pop(), { type: 'pickQueueDefaultTemplate', run: 'default' });
        const host = readFileSync(join(__dirname, '..', '..', '..', 'src', 'handlers', 'queueEditor-handler.ts'), 'utf-8');
        assert.match(host, /case 'pickQueueDefaultTransport':\s*case 'pickQueueDefaultProfile':\s*case 'pickQueueDefaultTemplate':[\s\S]{0,4000}setDefaultTransport\(picked\.value[\s\S]{0,2000}setDefaultMessageTemplate\(picked\.value, run\)/);
        window.dispatchEvent(new window.MessageEvent('message', { data: { type: 'state', items: [], context: { quest: 'q', role: 'spec_author', activeProjects: [] }, queueDefaultSession: 'per-todo' } }));
        assert.equal(link('session').textContent, 'per-todo');
    });

    test('QC-3: the default session with its base and lifetime', (t) => {
        const label = (session: string, sessionInfo: Record<string, unknown>): string => {
            const { window } = setup(t, { context: { quest: 'q', role: '', activeProjects: [] }, queueDefaultSession: session, sessionInfo });
            return window.document.querySelector('#runDefaultsSummary .ctx-link[data-pick="session"]').textContent;
        };
        assert.equal(label('walk', { walk: { mode: 'continue' } }), 'walk', 'no base, continue: the name alone');
        assert.equal(label('walk', { walk: { mode: 'continue', basedOn: 'prep' } }), 'walk based on prep');
        assert.equal(label('walk', { walk: { mode: 'per-prompt', basedOn: 'prep' } }), 'walk based on prep (per prompt)');
        assert.equal(label('walk', { walk: { mode: 'per-iteration', basedOn: 'prep' } }), 'walk based on prep (per iteration)');
        assert.equal(label('walk', { walk: { mode: 'per-iteration' } }), 'walk (per iteration)');
        assert.equal(label('walk', { walk: { mode: 'fork-from-base', basedOn: 'prep' } }), 'walk based on prep (per prompt)', 'the old name');
        assert.equal(label('', {}), 'default@default', 'a session with no file: the name alone, the default run\'s as default@default');
        const inRun = setup(t, { context: { quest: 'q', role: '', activeProjects: [] }, queueDefaultSession: '', sessionInfo: {}, currentRun: 'collab', processRuns: ['collab'] } as never);
        assert.equal(inRun.window.document.querySelector('#runDefaultsSummary .ctx-link[data-pick="session"]').textContent, 'default@collab', 'a run: its own queue session');
        const { window } = setup(t, { context: { quest: 'q', role: '', activeProjects: [] }, queueDefaultSession: 'walk', sessionInfo: { walk: { mode: 'per-prompt', basedOn: 'prep' } } });
        assert.match(window.document.querySelector('#runDefaultsSummary .ctx-link[data-pick="session"]').title, /Session walk, based on prep, started again for every prompt/);
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
        assert.match(chip('own').title, /Session walk, based on prep, started again for every prompt — click to change its run, session and place/);
        assert.equal(chip('plain').textContent, 'solo', 'no base: no mark');
        assert.equal(chip('spec').textContent, 'fresh*', 'a spec not created yet: from the spec');
        assert.match(chip('spec').title, /based on prep, started again for every queue iteration — created when the item is sent/);
        assert.equal(chip('inherit').textContent, 'qdef*', 'the queue default\'s base');
        assert.match(chip('inherit').title, /\(queue default\)/);
        posted.length = 0;
        // jsdom runs no inline handlers here: run the chip's onclick as the browser would.
        assert.equal(chip('own').getAttribute('onclick'), "event.stopPropagation();relocateItem('own')");
        window.relocateItem('own');
        assert.deepEqual(posted.filter((m) => m.type === 'relocateItem'), [{ type: 'relocateItem', id: 'own' }]);
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

    test('QC-6: the type icon opens the item\'s live trail', (t) => {
        const { window, posted } = setup(t, {
            items: [{ id: 'it1', status: 'sending', type: 'normal', originalText: 'x', createdAt: '2026-10-26T10:00:00Z', transport: 'anthropic', followUps: [], session: 'walk' }],
            sessionInfo: { walk: { mode: 'continue' } },
        });
        const btn = window.document.querySelector('.queue-live-trail-btn');
        assert.ok(btn, 'a button in the headline');
        assert.ok(btn.querySelector('.codicon-comment'), 'the same icon');
        assert.match(btn.title, /live trail of session walk/);
        posted.length = 0;
        window.eval(btn.getAttribute('onclick').replace('event.stopPropagation(); ', ''));
        assert.deepEqual(posted, [{ type: 'openItemLiveTrail', id: 'it1' }]);
        const handler = readFileSync(join(__dirname, '..', '..', '..', 'src', 'handlers', 'queueEditor-handler.ts'), 'utf-8');
        assert.match(handler, /case 'openItemLiveTrail': \{[\s\S]{0,400}stageSessionOf\(msg\.id\)[\s\S]{0,300}runChatSessionAction\('liveTrail', session\)/);
    });

    test('QC-7: the toolbar\'s icon buttons', (t) => {
        const { window } = setup(t, { context: { quest: 'q', role: '', activeProjects: [] } });
        const bar = window.document.querySelector('.toolbar');
        const texts = [...bar.querySelectorAll('button')].filter((b: Win) => b.textContent.trim() !== '');
        assert.deepEqual(texts.map((b: Win) => b.textContent.trim()), [], 'no text buttons left');
        const icons = (id: string): string[] => [...window.document.getElementById(id).querySelectorAll('.codicon')].map((c: Win) => c.className.replace('codicon ', ''));
        assert.deepEqual(icons('sendAllStagedBtn'), ['codicon-send', 'codicon-layers']);
        assert.deepEqual(icons('retryAllErrorsBtn'), ['codicon-refresh', 'codicon-error']);
        assert.deepEqual(icons('clearErrorsBtn'), ['codicon-trash', 'codicon-error']);
        assert.deepEqual(icons('clearSentBtn'), ['codicon-trash', 'codicon-check-all']);
        assert.deepEqual(icons('clearAllBtn'), ['codicon-trash', 'codicon-layers']);
        assert.deepEqual(icons('collapseAllBtn'), ['codicon-collapse-all']);
        assert.deepEqual(icons('expandAllBtn'), ['codicon-expand-all']);
        for (const [id, fn] of [['sendAllStagedBtn', 'sendAllStaged()'], ['retryAllErrorsBtn', 'retryAllErrors()'], ['clearErrorsBtn', 'clearErrors()'],
            ['clearSentBtn', 'clearSent()'], ['clearAllBtn', 'clearAll()'], ['collapseAllBtn', 'collapseAll()'], ['expandAllBtn', 'expandAll()']]) {
            const b = window.document.getElementById(id);
            assert.equal(b.getAttribute('onclick'), fn);
            assert.ok(b.title.length > 10, `${id} has a title`);
        }
    });
});
