/**
 * The Assist prompts on the Status Page and in the Global Template Editor
 * (ccparity_i_assist-3), against a workspace config under the vscode stub.
 *
 *   SA-1 the Status Page's Assist prompts section: one row per use, a dropdown with "(default: …)" and every
 *        Assist template (the chosen one selected), ✏️ / ➕ / 🗑️ beside it
 *   SA-2 its buttons post the use and the dropdown's template; Save posts every use's choice
 *   SA-3 the host: Save writes `assistPrompts.selected` (an empty choice removes it) and each use then resolves
 *        the template chosen; ✏️ opens the template editor on the row's template — the default when none is
 *        chosen; 🗑️ deletes the chosen template and the uses that chose it run their default again
 *   SA-4 the Global Template Editor: the category Assist Prompts lists the templates; an item's fields name the
 *        uses that run it and every use's placeholders; Save writes the template
 *   SA-5 schema and config type say the same thing
 */

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import test, { after, describe } from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';

import { installVscodeStub } from '../../tools/__tests__/_vscode-stub.js';

const ws = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'assist-prompts-')));
const CONFIG = path.join(ws, '.tom', 'tom_vscode_extension.json');
fs.mkdirSync(path.dirname(CONFIG), { recursive: true });
const stubbed = installVscodeStub({ workspaceFolders: [ws] });

// Safe to import after the stub is wired into the resolver.
import { TomAiConfiguration } from '../../utils/tomAiConfiguration.js';
import { TrailService } from '../../services/trailService.js';
import { setExtensionPath } from '../handler_shared.js';
import { gatherStatusData, getEmbeddedStatusHtml, getStatusPanelListenersScript, handleStatusAction } from '../statusPage-handler.js';
import { CATEGORY_LABELS, openGlobalTemplateEditor } from '../globalTemplateEditor-handler.js';
import { ASSIST_PROMPT_USES, ensureDefaultAssistPrompts, resolveAssistPrompt, type AssistPromptsSection } from '../../utils/assistPrompts.js';

const EXT = path.join(__dirname, '..', '..', '..');
setExtensionPath(EXT);
TomAiConfiguration.init({} as never);
TrailService.init({} as never);

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Json = any;
const writeConfig = (assistPrompts: AssistPromptsSection): void => fs.writeFileSync(CONFIG, JSON.stringify({ assistPrompts }, null, 2));
const readSection = (): AssistPromptsSection => JSON.parse(fs.readFileSync(CONFIG, 'utf8')).assistPrompts;
const seeded = (extra: AssistPromptsSection = {}): AssistPromptsSection => {
    const c: { assistPrompts?: AssistPromptsSection } = { assistPrompts: JSON.parse(JSON.stringify(extra)) };
    ensureDefaultAssistPrompts(c);
    return c.assistPrompts!;
};
const commands = () => stubbed.spies.byMethod('commands.executeCommand').map((c) => c.args);

async function statusPage(t: { after(fn: () => void): void }) {
    const html = getEmbeddedStatusHtml(await gatherStatusData());
    const dom = new JSDOM(`<body>${html}</body>`, { runScripts: 'outside-only' });
    const w = dom.window as Json;
    t.after(() => w.close());
    const posted: Json[] = [];
    w.vscode = { postMessage: (m: Json) => posted.push(JSON.parse(JSON.stringify(m))) };
    w.eval(getStatusPanelListenersScript());
    w.eval('attachStatusPanelListeners(true)');
    return { w, posted, doc: w.document };
}

describe('Assist prompts: Status Page and template editor', () => {
    after(() => { fs.rmSync(ws, { recursive: true, force: true }); });

    test('SA-1: the Status Page section', async (t) => {
        writeConfig(seeded({ selected: { explainDecision: 'mine' }, templates: [{ id: 'mine', name: 'My decision prompt', template: 'x' }] }));
        const { doc } = await statusPage(t);
        for (const use of ASSIST_PROMPT_USES) {
            const select = doc.getElementById(`sp-assist-${use}`);
            assert.ok(select, use);
            const row = select.closest('.sp-settings-row');
            const options = [...select.options].map((o: Json) => o.value);
            assert.deepEqual(options, ['', 'mine', 'grill-me', 'explain-in-detail', 'explain-decision', 'grill-me-decision', 'finish-review-round', 'gate-decision', 'out-of-budget'], use);
            assert.match(select.options[0].textContent, /^\(default: /);
            assert.equal(select.value, use === 'explainDecision' ? 'mine' : '', `${use}: the choice is selected`);
            const actions = [...row.querySelectorAll('[data-status-action]')].map((b: Json) => [b.getAttribute('data-status-action'), b.getAttribute('data-assist-use')]);
            assert.deepEqual(actions, [['editAssistPrompt', use], ['addAssistPrompt', use], ['deleteAssistPrompt', use]], use);
            assert.match(row.querySelector('button').textContent, /Edit/);
        }
        assert.ok(doc.getElementById('sp-assistPrompts-content'), 'a collapsible section of its own');
    });

    test('SA-2: the buttons post', async (t) => {
        writeConfig(seeded({ selected: { grillMe: 'mine' }, templates: [{ id: 'mine', name: 'Mine', template: 'x' }] }));
        const { doc, posted } = await statusPage(t);
        doc.querySelector('[data-status-action="editAssistPrompt"][data-assist-use="grillMe"]').click();
        doc.querySelector('[data-status-action="deleteAssistPrompt"][data-assist-use="outOfBudget"]').click();
        doc.getElementById('sp-assist-finishReviewRound').value = 'mine';
        doc.querySelector('[data-status-action="updateAssistPrompts"]').click();
        assert.deepEqual(posted.map((m) => [m.action, m.use, m.itemId]), [
            ['editAssistPrompt', 'grillMe', 'mine'],
            ['deleteAssistPrompt', 'outOfBudget', ''],
            ['updateAssistPrompts', undefined, undefined],
        ]);
        assert.deepEqual(posted[2].selected, { grillMe: 'mine', explainInDetail: '', explainDecision: '', grillMeDecision: '', finishReviewRound: 'mine', gateDecision: '', outOfBudget: '' });
    });

    test('SA-3: the host writes and each use resolves its choice', async () => {
        writeConfig(seeded({ selected: { grillMe: 'old' }, templates: [{ id: 'a', name: 'A', template: 'A body' }, { id: 'b', name: 'B', template: 'B body' }] }));
        await handleStatusAction('updateAssistPrompts', { selected: { grillMe: '', explainInDetail: 'a', explainDecision: 'b', finishReviewRound: 'a', outOfBudget: 'b', bogus: 'a' } });
        const section = readSection();
        assert.deepEqual(section.selected, { explainInDetail: 'a', explainDecision: 'b', finishReviewRound: 'a', outOfBudget: 'b' }, 'an empty choice removed, an unknown use ignored');
        assert.deepEqual(ASSIST_PROMPT_USES.map((u) => resolveAssistPrompt(section, u).template.slice(0, 6)),
            [resolveAssistPrompt(section, 'grillMe').template.slice(0, 6), 'A body', 'B body', resolveAssistPrompt(section, 'grillMeDecision').template.slice(0, 6), 'A body', resolveAssistPrompt(section, 'gateDecision').template.slice(0, 6), 'B body']);
        assert.equal(resolveAssistPrompt(section, 'grillMe').source, 'default');

        stubbed.spies.clear();
        await handleStatusAction('editAssistPrompt', { use: 'grillMe', itemId: '' });
        await handleStatusAction('editAssistPrompt', { use: 'outOfBudget', itemId: 'b' });
        assert.deepEqual(commands(), [
            ['tomAi.editor.promptTemplates', { category: 'assistPrompts', itemId: 'grill-me' }],
            ['tomAi.editor.promptTemplates', { category: 'assistPrompts', itemId: 'b' }],
        ], 'the row\'s template — the default when none is chosen');

        await handleStatusAction('deleteAssistPrompt', { use: 'outOfBudget', itemId: 'b' });
        const after = readSection();
        assert.ok(!after.templates!.some((t) => t.id === 'b'));
        assert.deepEqual(after.selected, { explainInDetail: 'a', finishReviewRound: 'a' }, 'the uses that chose it run their default again');
        assert.equal(resolveAssistPrompt(after, 'outOfBudget').id, 'out-of-budget');
        await handleStatusAction('deleteAssistPrompt', { use: 'grillMe', itemId: '' });
        assert.equal(readSection().templates!.length, after.templates!.length, 'nothing chosen: nothing deleted');
    });

    test('SA-4: the Global Template Editor category', async () => {
        assert.equal(CATEGORY_LABELS.assistPrompts, 'Assist Prompts');
        writeConfig(seeded({ selected: { explainDecision: 'grill-me' } }));
        openGlobalTemplateEditor({ extensionUri: (stubbed.stub.Uri as Json).file(EXT), subscriptions: [] } as never, { category: 'assistPrompts', itemId: 'grill-me' });
        const panels = (stubbed.stub.window as Json).__webviewPanels as Json[];
        const panel = panels[panels.length - 1];
        const ask = async (msg: Json) => { panel.webview.__receive(msg); await new Promise((r) => setTimeout(r, 20)); };
        await ask({ type: 'requestData', category: 'assistPrompts' });
        const all = panel.webview.__posted.filter((m: Json) => m.type === 'allData').pop();
        assert.deepEqual(all.categories.find((c: Json) => c.id === 'assistPrompts').items.map((i: Json) => i.id),
            ['grill-me', 'explain-in-detail', 'explain-decision', 'grill-me-decision', 'finish-review-round', 'gate-decision', 'out-of-budget']);
        await ask({ type: 'selectItem', category: 'assistPrompts', itemId: 'grill-me' });
        const fields = panel.webview.__posted.filter((m: Json) => m.type === 'itemFields').pop().fields;
        assert.deepEqual(fields.map((f: Json) => f.name), ['id', 'name', 'description', 'template']);
        const help = fields[3].help as string;
        assert.match(help, /Runs for:<\/strong> Grill me, Explain a decision/);
        for (const p of ['questionBlock', 'explanationFile', 'decision', 'resultsFile', 'stoppedProfile', 'liveTrail', 'originalPrompt']) {
            assert.ok(help.includes(`\${${p}}`), p);
        }
        await ask({ type: 'save', category: 'assistPrompts', itemId: 'grill-me', values: { name: 'Grill me hard', description: '', template: 'Grill ${questionId}' } });
        const saved = readSection().templates!.find((t) => t.id === 'grill-me')!;
        assert.deepEqual([saved.name, saved.template], ['Grill me hard', 'Grill ${questionId}']);
        // The editor asks before it deletes: answer Delete.
        const win = stubbed.stub.window as Json;
        const warn = win.showWarningMessage;
        win.showWarningMessage = async () => 'Delete';
        try { await ask({ type: 'delete', category: 'assistPrompts', itemId: 'grill-me' }); } finally { win.showWarningMessage = warn; }
        const section = readSection();
        assert.ok(!section.templates!.some((t) => t.id === 'grill-me'));
        assert.equal(section.selected?.explainDecision, undefined, 'the choice of a deleted template goes');
        panel.dispose();
    });

    test('SA-5: schema and config type', () => {
        const schema = JSON.parse(fs.readFileSync(path.join(EXT, 'src', 'config', 'tom_vscode_extension.schema.json'), 'utf8'));
        const assist = schema.properties.assistPrompts;
        assert.deepEqual(Object.keys(assist.properties.selected.properties), [...ASSIST_PROMPT_USES]);
        assert.deepEqual(assist.properties.templates.items.required, ['id', 'name', 'template']);
        assert.match(fs.readFileSync(path.join(EXT, 'src', 'utils', 'sendToChatConfig.ts'), 'utf8'), /\n {4}assistPrompts\?: AssistPromptsSection;/);
    });
});
