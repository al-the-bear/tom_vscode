/**
 * The queue item header in the Prompt Queue editor (media/shared/queueEntryRenderFunctions.js,
 * queueEntryStyles.css): the profile, the template hint, the font.
 *
 *   QH-1 an item with its own profile shows the profile's name as a chip; a click posts `pickItemProfile`
 *        with the item id (and does not toggle the item); the tooltip names model and kind
 *   QH-2 an item without one shows an icon button instead of a name; its tooltip says what it runs with;
 *        a click posts `pickItemProfile`; once the host says it has a profile, the button is gone and the
 *        chip stands in its place
 *   QH-3 a finished item: its own profile is a chip without a click; without one nothing is shown; a
 *        process-move marker (no `profileView`) shows neither; an entry without the host's view (a chat send
 *        shown by another page) names its own profile by id, without a click
 *   QH-4 the header names the prompt template and no `[AW]`, in the item and in a follow-up
 *   QH-5 every text of the header is 11px, normal weight, not uppercased: the header's rule, and the rule
 *        that makes chips, badges and buttons in it follow, icons apart
 *   QH-6 the host: `pickItemProfile` opens the picker and sets the profile through the manager; the state
 *        carries `profileView` per item
 */

import test, { describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { JSDOM } from 'jsdom';

const EXT = join(__dirname, '..', '..', '..');
const readMedia = (...parts: string[]): string => readFileSync(join(EXT, 'media', ...parts), 'utf-8');

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Win = any;

function setup(t: { after(fn: () => void): void }, items: unknown[]): { w: Win; posted: Win[]; doc: Win } {
    const html = readMedia('queueEditor', 'index.html').replace(/<script[\s\S]*?<\/script>/g, '');
    const dom = new JSDOM(html, { runScripts: 'outside-only' });
    const w = dom.window as Win;
    t.after(() => w.close());
    const posted: Win[] = [];
    w.acquireVsCodeApi = () => ({ postMessage: (m: Win) => posted.push(JSON.parse(JSON.stringify(m))), setState: () => undefined, getState: () => ({}) });
    w.__INIT__ = {
        state: { items, autoSend: false, processRuns: ['default'], currentRun: 'default' },
        queueDefaultPickerHtml: '<select id="queueDefault-transport-profile"></select>',
        addFormPickerHtml: '<select id="addForm-transport-profile"></select>',
    };
    w.eval([
        readMedia('shared', 'queueEntryUtils.js'),
        readMedia('shared', 'queueEntryRenderFunctions.js'),
        readMedia('shared', 'queueEntryMessageHandlers.js'),
        readMedia('queueEditor', 'main.js'),
    ].join('\n;\n'));
    return { w, posted, doc: w.document };
}

const base = { type: 'normal', template: '(None)', createdAt: '2026-11-19T10:00:00.000Z' };
const item = (id: string, status: string, extra: Record<string, unknown> = {}): Record<string, unknown> => ({ ...base, id, status, originalText: id, expandedText: id, ...extra });
const OWN = { own: true, transport: 'anthropic', id: 'opus-sdk', name: 'Opus SDK', detail: 'claude-opus · Agent SDK', canPick: true };
const DEFAULT = { own: false, transport: 'anthropic', id: 'sonnet-api', name: 'Sonnet API', detail: 'claude-sonnet · direct API', canPick: true };
const header = (doc: Win, id: string): Win => doc.querySelector(`.queue-item[data-id="${id}"] .item-header`) ?? [...doc.querySelectorAll('.queue-item')].find((e: Win) => e.innerHTML.includes(`'${id}'`))?.querySelector('.item-header');

describe('Prompt Queue editor — the item header', () => {
    test('QH-1: its own profile is a clickable name', (t) => {
        const { w, posted, doc } = setup(t, [item('a', 'pending', { transport: 'anthropic', anthropicProfileId: 'opus-sdk', profileView: OWN })]);
        const chip = header(doc, 'a').querySelector('.queue-profile-chip');
        assert.equal(chip.textContent, 'Opus SDK');
        assert.ok(chip.classList.contains('pickable'));
        assert.match(chip.getAttribute('title'), /Profile of this item: Opus SDK \(claude-opus · Agent SDK\)\. Click to choose another profile\./);
        assert.match(chip.getAttribute('onclick'), /event\.stopPropagation\(\);pickItemProfile\('a'\)/);
        assert.equal(header(doc, 'a').querySelector('.queue-profile-btn'), null);
        assert.ok(!header(doc, 'a').textContent.includes('[anthropic'), 'the name stands for the old transport badge');
        w.pickItemProfile('a');
        assert.deepEqual(posted.filter((m) => m.type === 'pickItemProfile'), [{ type: 'pickItemProfile', id: 'a' }]);
    });

    test('QH-2: without one, an icon button — replaced by the name once a profile is chosen', (t) => {
        const { w, doc } = setup(t, [item('a', 'staged', { profileView: DEFAULT }), item('c', 'pending', { profileView: { own: false, transport: 'copilot', canPick: true } })]);
        const btn = header(doc, 'a').querySelector('.queue-profile-btn');
        assert.ok(btn.classList.contains('codicon'), 'an icon');
        assert.equal(btn.textContent, '');
        assert.match(btn.getAttribute('title'), /^No profile of its own: it runs with Sonnet API \(claude-sonnet · direct API\) .*Click to choose a profile for this item\.$/);
        assert.match(btn.getAttribute('onclick'), /pickItemProfile\('a'\)/);
        assert.equal(header(doc, 'a').querySelector('.queue-profile-chip'), null);
        assert.match(header(doc, 'c').querySelector('.queue-profile-btn').getAttribute('title'), /it runs with Copilot /);
        w.dispatchEvent(new w.MessageEvent('message', { data: { type: 'state', items: [item('a', 'staged', { transport: 'anthropic', anthropicProfileId: 'opus-sdk', profileView: OWN })], autoSend: false, processRuns: ['default'], currentRun: 'default' } }));
        assert.equal(header(doc, 'a').querySelector('.queue-profile-btn'), null, 'the button is gone');
        assert.equal(header(doc, 'a').querySelector('.queue-profile-chip').textContent, 'Opus SDK');
    });

    test('QH-3: a finished item, a chat send, a marker', (t) => {
        const { doc } = setup(t, [
            item('s', 'sent', { profileView: { ...OWN, canPick: false } }),
            item('n', 'sent', { profileView: { ...DEFAULT, canPick: false } }),
            item('m', 'pending', { processMove: { to: 'p/s' }, processPosition: 'p/r' }),
        ]);
        const chip = header(doc, 's').querySelector('.queue-profile-chip');
        assert.equal(chip.textContent, 'Opus SDK');
        assert.equal(chip.getAttribute('onclick'), null);
        assert.ok(!chip.classList.contains('pickable'));
        const bare = setup(t, [item('c', 'chat', { transport: 'anthropic', anthropicProfileId: 'opus-direct', chatSource: 'panel' })]).doc;
        const bareChip = header(bare, 'c').querySelector('.queue-profile-chip');
        assert.equal(bareChip.textContent, 'opus-direct');
        assert.equal(bareChip.getAttribute('onclick'), null);
        for (const id of ['n', 'm']) {
            assert.equal(header(doc, id).querySelector('.queue-profile-chip'), null, id);
            assert.equal(header(doc, id).querySelector('.queue-profile-btn'), null, id);
        }
    });

    test('QH-4: the template is named, [AW] is not', (t) => {
        const { doc } = setup(t, [item('a', 'staged', { template: 'review', profileView: DEFAULT, followUps: [{ id: 'f1', originalText: 'then', template: 'review' }] })]);
        assert.ok(header(doc, 'a').textContent.includes('[review]'));
        assert.ok(!doc.body.textContent.includes('[AW]'), 'no answer-wrapper hint anywhere in the item');
        assert.ok(!readMedia('shared', 'queueEntryRenderFunctions.js').includes('[AW]'));
    });

    test('QH-5: the header font', () => {
        const css = readMedia('shared', 'queueEntryStyles.css');
        const rule = /\n\s*\.status-bar \{([^}]*)\}/.exec(css)![1];
        assert.match(rule, /font-size: 11px;/);
        assert.match(rule, /font-weight: normal;/);
        assert.doesNotMatch(rule, /text-transform/);
        assert.match(css, /\.status-bar span:not\(\.codicon\), \.status-bar button:not\(\.codicon\) \{ font-size: 11px !important; font-weight: normal; \}/);
    });

    test('QH-6: the host', () => {
        const src = readFileSync(join(EXT, 'src', 'handlers', 'queueEditor-handler.ts'), 'utf-8');
        assert.match(src, /case 'pickItemProfile': \{[\s\S]{0,300}await pickItemProfile\(id\); sendState\(\);/);
        assert.match(src, /profilePickEntries\(catalogue\.profiles, catalogue\.configurations, view\)/);
        assert.match(src, /pqm\.setItemProfile\(id, profileId\)/);
        assert.match(src, /pqm\.setItemProfile\(id, profileId, \{ defaultSession: true \}\)/);
        assert.match(src, /\.\.\.\(profileView \? \{ profileView \} : \{\}\)/);
    });
});
