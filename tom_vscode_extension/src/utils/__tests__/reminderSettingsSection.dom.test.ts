/**
 * The Status Page's reminder settings (src/utils/reminderSettingsSection.ts, statusPage-handler.ts), the home of the
 * retired Context & Settings editor's reminder fields (vscimpb75, decision (a)).
 *
 *   RS-1 the rendering: the alive check On / Off (the current one primary), its timeout in minutes, the window's
 *        run's default reminder template (none = the reminder default, named) with every template, Edit templates
 *        and Save; marked `data-section="reminders"` (the overview's Go to and `tomAi.statusPage reminders`)
 *   RS-2 the timeout as the reminder system keeps it: a whole number of minutes, at least 1; anything else refused
 *   RS-3 in the page (listeners.js): On / Off post their actions; Save posts the timeout and the chosen template;
 *        Edit templates posts the chosen template's id
 *   RS-4 the host: the actions set ReminderSystem's `enabled` / `defaultTimeoutMinutes` and the window's run's
 *        `defaultReminderTemplateId`, refuse a bad timeout, open the Prompt Template Editor on category Reminder;
 *        the page renders the section inside Queue & Timer from the reminder system and the queue
 *   RS-5 the retired editor's links: the Prompt Queue and Timed Requests editors' bell posts `openReminderSettings`,
 *        which opens the Status Page at the reminders; the command, its handler and media are gone, and nothing
 *        names them
 */

import test, { describe } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { JSDOM } from 'jsdom';

import { parseReminderTimeout, reminderSettingsHtml, type ReminderSettingsModel } from '../reminderSettingsSection.js';

const ROOT = join(__dirname, '..', '..', '..');
const read = (...parts: string[]): string => readFileSync(join(ROOT, ...parts), 'utf-8');

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Win = any;

const model = (over: Partial<ReminderSettingsModel> = {}): ReminderSettingsModel => ({
    enabled: true, timeoutMinutes: 5, run: 'default', runDefaultTemplateId: 'retry', fallbackTemplateId: 'default',
    templates: [{ id: 'default', name: 'Are you alive?' }, { id: 'retry', name: 'Retry <once>' }],
    ...over,
});

describe('the Status Page\'s reminder settings', () => {
    test('RS-1: the rendering', () => {
        const dom = new JSDOM(`<body>${reminderSettingsHtml(model())}</body>`);
        const d = dom.window.document;
        const root = d.querySelector('[data-section="reminders"]')!;
        assert.ok(root);
        assert.ok(root.querySelector('[data-status-action="setReminderOn"]')!.classList.contains('primary'));
        assert.ok(!root.querySelector('[data-status-action="setReminderOff"]')!.classList.contains('primary'));
        assert.equal((d.getElementById('sp-reminder-timeout') as HTMLInputElement).value, '5');
        const select = d.getElementById('sp-reminder-template') as HTMLSelectElement;
        assert.deepEqual([...select.options].map((o) => [o.value, o.textContent]),
            [['', '(none: the reminder default, Are you alive?)'], ['default', 'Are you alive?'], ['retry', 'Retry <once>']]);
        assert.equal(select.value, 'retry');
        assert.match(root.textContent!, /Default reminder template \(run default\)/);
        assert.ok(root.querySelector('[data-status-action="editReminderTemplates"]'));
        assert.ok(root.querySelector('[data-status-action="saveReminderSettings"]'));
        const off = new JSDOM(`<body>${reminderSettingsHtml(model({ enabled: false, runDefaultTemplateId: undefined, run: 'chg1' }))}</body>`).window.document;
        assert.ok(off.querySelector('[data-status-action="setReminderOff"]')!.classList.contains('primary'));
        assert.equal((off.getElementById('sp-reminder-template') as HTMLSelectElement).value, '', 'none chosen');
        assert.match(off.body.textContent!, /\(run chg1\)/);
    });

    test('RS-2: the timeout', () => {
        assert.equal(parseReminderTimeout('7'), 7);
        assert.equal(parseReminderTimeout(12), 12);
        assert.equal(parseReminderTimeout('2.6'), 3);
        for (const v of ['', '0', '-3', 'x', undefined, null, 0.5]) { assert.equal(parseReminderTimeout(v), undefined, String(v)); }
    });

    test('RS-3: in the page', () => {
        const dom = new JSDOM(`<!DOCTYPE html><body><div class="sp-panel">${reminderSettingsHtml(model())}</div></body>`, { runScripts: 'outside-only' });
        const w = dom.window as Win;
        const posted: Array<Record<string, unknown>> = [];
        w.vscode = { postMessage: (m: Record<string, unknown>) => { posted.push(JSON.parse(JSON.stringify(m))); } };
        w.eval(read('media', 'statusPage', 'listeners.js'));
        w.eval('attachStatusPanelListeners(true)');
        const click = (action: string) => w.document.querySelector(`[data-status-action="${action}"]`).click();
        click('setReminderOff');
        assert.deepEqual(posted.at(-1), { type: 'statusAction', action: 'setReminderOff' });
        click('setReminderOn');
        assert.deepEqual(posted.at(-1), { type: 'statusAction', action: 'setReminderOn' });
        w.document.getElementById('sp-reminder-timeout').value = '12';
        w.document.getElementById('sp-reminder-template').value = 'default';
        click('saveReminderSettings');
        assert.deepEqual(posted.at(-1), { type: 'statusAction', action: 'saveReminderSettings', timeoutMinutes: '12', templateId: 'default' });
        click('editReminderTemplates');
        assert.deepEqual(posted.at(-1), { type: 'statusAction', action: 'editReminderTemplates', itemId: 'default' });
        w.close();
    });

    test('RS-4: the host', () => {
        const h = read('src', 'handlers', 'statusPage-handler.ts');
        assert.match(h, /case 'setReminderOn':\s+case 'setReminderOff': \{[\s\S]{0,200}ReminderSystem\.instance\?\.updateConfig\(\{ enabled: action === 'setReminderOn' \}\);/);
        assert.match(h, /case 'saveReminderSettings': \{\s+const minutes = parseReminderTimeout\(message\?\.timeoutMinutes\);\s+if \(minutes === undefined\) \{\s+vscode\.window\.showWarningMessage/);
        assert.match(h, /ReminderSystem\.instance\?\.updateConfig\(\{ defaultTimeoutMinutes: minutes \}\);/);
        assert.match(h, /PromptQueueManager\.instance\.setRunQueueSettings\(undefined, \{ defaultReminderTemplateId: templateId \|\| undefined \}\);/);
        assert.match(h, /case 'editReminderTemplates': \{\s+await vscode\.commands\.executeCommand\('tomAi\.editor\.promptTemplates', \{\s+category: 'reminder',/);
        assert.match(h, /data-status-action="setTimerOff">Off<\/button>\s+<\/div>\s+<\/div>\s+\$\{reminderSettingsHtml\(status\.reminders\)\}/, 'inside Queue & Timer, after the timer');
        assert.match(h, /reminders\.runDefaultTemplateId = PromptQueueManager\.instance\.defaultReminderTemplateId;/);
        assert.match(h, /reminders\.timeoutMinutes = rs\.config\.defaultTimeoutMinutes;/);
    });

    test('RS-5: the retired editor\'s links', () => {
        for (const editor of ['queueEditor', 'timedRequestsEditor']) {
            assert.match(read('media', editor, 'index.html'), /onclick="openReminderSettings\(\)"[^>]*><span class="codicon codicon-bell">/);
            assert.match(read('media', editor, 'main.js'), /function openReminderSettings\(\) \{\s+vscode\.postMessage\(\{ type: 'openReminderSettings' \}\);/);
        }
        for (const host of ['queueEditor-handler.ts', 'timedRequestsEditor-handler.ts']) {
            assert.match(read('src', 'handlers', host), /case 'openReminderSettings':\s+await vscode\.commands\.executeCommand\('tomAi\.statusPage', 'reminders'\);/);
        }
        assert.ok(!existsSync(join(ROOT, 'media', 'contextSettingsEditor')));
        assert.ok(!existsSync(join(ROOT, 'src', 'handlers', 'contextSettingsEditor-handler.ts')));
        const pkg = read('package.json');
        assert.doesNotMatch(pkg, /tomAi\.editor\.contextSettings|contextSettingsEditor/);
        for (const f of [['src', 'extension.ts'], ['src', 'handlers', 'index.ts'], ['src', 'handlers', 'chatPanel-handler.ts'], ['src', 'handlers', 'statusPage-handler.ts'],
            ['media', 'chatPanel', 'main.js'], ['src', 'utils', 'extensionToolsCatalog.ts']]) {
            assert.doesNotMatch(read(...f), /contextSettings|ContextSettings/, f.join('/'));
        }
    });
});
