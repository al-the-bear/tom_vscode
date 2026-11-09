/**
 * The todo detail's Send and Queue buttons and their two template settings
 * (src/utils/todoButtonTemplates.ts, media/questTodoPanel/main.js,
 * src/handlers/questTodoPanel-handler.ts, the Status Page's Todo buttons section).
 *
 *   TB-1 the template a todo gets: user action → the userAction setting (default guide-user-action),
 *        any other → the other setting (default execute-todo); an id not among the templates is missing
 *   TB-2 every saved todo's detail has Send and Queue; they post qtTodoButton with target chat / queue,
 *        the todo's quest, id and file; the new-todo form has neither
 *   TB-3 the host: Send / Queue (and Guide me) run _runTodoButton — always transport anthropic (never the
 *        queue's transport), the queue item staged with the template id and the todo id pattern, the chat
 *        send with the template body; a missing template warns instead of sending
 *   TB-4 the Status Page section: one dropdown per use with "(default: …)" and every Anthropic template,
 *        ✏️ Edit beside it; Edit posts the row's template, Save every use's choice
 *   TB-5 the host writes anthropic.todoButtonTemplates (an empty choice removes it) and Edit opens the
 *        Anthropic template editor on the row's template — the setting's / default when none is chosen
 *   TB-6 schema and config type say the same thing
 */

/* eslint-disable @typescript-eslint/naming-convention -- `user_action`, `_sourceFile` are the todo's keys */
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import test, { after, describe } from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';

import { installVscodeStub } from '../../tools/__tests__/_vscode-stub.js';

const ws = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'todo-buttons-')));
const CONFIG = path.join(ws, '.tom', 'tom_vscode_extension.json');
fs.mkdirSync(path.dirname(CONFIG), { recursive: true });
const stubbed = installVscodeStub({ workspaceFolders: [ws] });

import { TomAiConfiguration } from '../../utils/tomAiConfiguration.js';
import { TrailService } from '../../services/trailService.js';
import { setExtensionPath } from '../handler_shared.js';
import { gatherStatusData, getEmbeddedStatusHtml, getStatusPanelListenersScript, handleStatusAction } from '../statusPage-handler.js';
import { resolveTodoButtonTemplate, todoButtonTemplateId, todoButtonTemplateUse, TODO_BUTTON_TEMPLATE_USES } from '../../utils/todoButtonTemplates.js';

const EXT = path.join(__dirname, '..', '..', '..');
setExtensionPath(EXT);
TomAiConfiguration.init({} as never);
TrailService.init({} as never);

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Json = any;
const media = (...p: string[]): string => fs.readFileSync(path.join(EXT, 'media', ...p), 'utf-8');
const TEMPLATES = [
    { id: 'execute-todo', name: 'Execute TODO', template: 'EXEC ${userMessage}' },
    { id: 'guide-user-action', name: 'Guide me through a user action', template: 'GUIDE ${userMessage}' },
    { id: 'mine', name: 'Mine', template: 'MINE ${userMessage}' },
];
const writeConfig = (todoButtonTemplates?: Json): void => fs.writeFileSync(CONFIG, JSON.stringify({ anthropic: { userMessageTemplates: TEMPLATES, ...(todoButtonTemplates ? { todoButtonTemplates } : {}) } }, null, 2));
const readSection = (): Json => JSON.parse(fs.readFileSync(CONFIG, 'utf8')).anthropic.todoButtonTemplates;
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
    return { posted, doc: w.document };
}

describe('todo detail: Send and Queue buttons', () => {
    after(() => { fs.rmSync(ws, { recursive: true, force: true }); });

    test('TB-1: the template a todo gets', () => {
        assert.equal(todoButtonTemplateUse({ user_action: true }), 'userAction');
        assert.equal(todoButtonTemplateUse({}), 'other');
        assert.equal(todoButtonTemplateId(undefined, 'userAction'), 'guide-user-action');
        assert.equal(todoButtonTemplateId(undefined, 'other'), 'execute-todo');
        assert.equal(todoButtonTemplateId({ other: ' mine ', userAction: '' }, 'other'), 'mine');
        assert.equal(todoButtonTemplateId({ userAction: '' }, 'userAction'), 'guide-user-action', 'empty: the default');
        assert.deepEqual(resolveTodoButtonTemplate({ other: 'mine' }, TEMPLATES, 'other'), { id: 'mine', name: 'Mine', body: 'MINE ${userMessage}' });
        assert.deepEqual(resolveTodoButtonTemplate({ userAction: 'gone' }, TEMPLATES, 'userAction'), { id: 'gone', name: 'gone', missing: true });
        assert.deepEqual([...TODO_BUTTON_TEMPLATE_USES], ['userAction', 'other']);
    });

    test('TB-2: the buttons in the detail', (t) => {
        const dom = new JSDOM(`<body>${media('questTodoPanel', 'fragment.html')}</body>`, { runScripts: 'outside-only' });
        const w = dom.window as Json;
        t.after(() => w.close());
        const posted: Json[] = [];
        w.vscode = { postMessage: (m: Json) => posted.push(JSON.parse(JSON.stringify(m))), getState: () => undefined, setState: () => undefined };
        w.eval('var qtViewConfig = {};\n' + media('shared', 'mdOverlay.js') + media('questTodoPanel', 'grouping.js') + media('questTodoPanel', 'main.js'));
        w.eval("qtCurrentQuestId = 'vscode_extension';");
        for (const [todo, which] of [[{ id: 'a1', title: 'A', status: 'not-started', _sourceFile: 'todos.vscode_extension.todo.yaml' }, 'other'], [{ id: 'u1', title: 'U', status: 'completed', user_action: true }, 'user-action']] as const) {
            w.qtRenderDetail(todo);
            const send = w.document.querySelector('.qt-todo-btn[data-qt-todo-btn="chat"]');
            const queue = w.document.querySelector('.qt-todo-btn[data-qt-todo-btn="queue"]');
            assert.ok(send && queue, `${todo.id}: both buttons, whatever the status`);
            assert.match(send.textContent, /Send/);
            assert.match(queue.textContent, /Queue/);
            assert.match(send.title, new RegExp(`template for ${which} todos`));
            send.click();
            assert.deepEqual(posted.pop(), { type: 'qtTodoButton', target: 'chat', questId: 'vscode_extension', todoId: todo.id, ...('_sourceFile' in todo ? { sourceFile: todo._sourceFile } : {}) });
            queue.click();
            assert.equal(posted.pop()?.target, 'queue');
        }
        w.qtShowNewTodoForm('a9');
        assert.equal(w.document.querySelectorAll('#qt-detail-pane .qt-todo-btn').length, 0, 'not on the new-todo form');
    });

    test('TB-3: the host', () => {
        const host = fs.readFileSync(path.join(EXT, 'src', 'handlers', 'questTodoPanel-handler.ts'), 'utf-8');
        const cases = host.slice(host.indexOf("case 'qtGuideUserAction':"), host.indexOf("case 'qtOpenMarkdownPreview':"));
        assert.match(cases, /case 'qtGuideUserAction':\s*case 'qtTodoButton':/);
        assert.match(cases, /_runTodoButton\(todo, questId, msg\.sourceFile, use, msg\.target === 'queue' \? 'queue' : 'chat'\)/);
        const run = host.slice(host.indexOf('async function _runTodoButton('), host.indexOf('async function _runTodoButton(') + 2600);
        assert.match(run, /resolveTodoButtonTemplate\(anthropic\?\.todoButtonTemplates, anthropic\?\.userMessageTemplates, use\)/);
        assert.match(run, /if \(tpl\.missing \|\| !tpl\.body\) \{\s*vscode\.window\.showWarningMessage[\s\S]{0,300}return;/, 'a missing template warns');
        assert.match(run, /todoIdPattern: todo\.id,\s*template: tpl\.id,\s*transport: 'anthropic',\s*deferSend: true/);
        assert.match(run, /runAnthropicSend\(ctx, todoPrompt, \{ userMessageTemplate: tpl\.body/);
        assert.doesNotMatch(run, /_queueSendTarget/, 'never the queue\'s transport');
    });

    test('TB-4: the Status Page section', async (t) => {
        writeConfig({ other: 'mine' });
        const { doc, posted } = await statusPage(t);
        assert.ok(doc.getElementById('sp-todoButtons-content'), 'a collapsible section of its own');
        for (const use of TODO_BUTTON_TEMPLATE_USES) {
            const select = doc.getElementById(`sp-todobtn-${use}`);
            assert.ok(select, use);
            assert.deepEqual([...select.options].map((o: Json) => o.value), ['', 'execute-todo', 'guide-user-action', 'mine'], `${use}: the Anthropic templates`);
            assert.match(select.options[0].textContent, use === 'userAction' ? /default: Guide me through a user action/ : /default: Execute TODO/);
            assert.equal(select.value, use === 'other' ? 'mine' : '');
            const actions = [...select.closest('.sp-settings-row').querySelectorAll('[data-status-action]')].map((b: Json) => b.getAttribute('data-status-action'));
            assert.deepEqual(actions, ['editTodoButtonTemplate']);
        }
        doc.querySelector('[data-status-action="editTodoButtonTemplate"][data-todobtn-use="other"]').click();
        doc.getElementById('sp-todobtn-userAction').value = 'mine';
        doc.querySelector('[data-status-action="updateTodoButtonTemplates"]').click();
        assert.deepEqual(posted.map((m) => [m.action, m.use, m.itemId]), [['editTodoButtonTemplate', 'other', 'mine'], ['updateTodoButtonTemplates', undefined, undefined]]);
        assert.deepEqual(posted[1].selected, { userAction: 'mine', other: 'mine' });
    });

    test('TB-5: the host writes and opens the editor', async () => {
        writeConfig({ userAction: 'mine' });
        await handleStatusAction('updateTodoButtonTemplates', { selected: { userAction: '', other: 'mine', bogus: 'x' } });
        assert.deepEqual(readSection(), { other: 'mine' }, 'an empty choice removed, an unknown use ignored');
        await handleStatusAction('updateTodoButtonTemplates', { selected: { userAction: '', other: '' } });
        assert.equal(readSection(), undefined, 'nothing chosen: no section');
        stubbed.spies.clear();
        await handleStatusAction('editTodoButtonTemplate', { use: 'userAction', itemId: '' });
        await handleStatusAction('editTodoButtonTemplate', { use: 'other', itemId: 'mine' });
        assert.deepEqual(commands(), [
            ['tomAi.editor.promptTemplates', { category: 'anthropicUserMessage', itemId: 'guide-user-action' }],
            ['tomAi.editor.promptTemplates', { category: 'anthropicUserMessage', itemId: 'mine' }],
        ]);
    });

    test('TB-6: schema and config type', () => {
        const schema = JSON.parse(fs.readFileSync(path.join(EXT, 'src', 'config', 'tom_vscode_extension.schema.json'), 'utf8'));
        const props = schema.properties.anthropic.properties.todoButtonTemplates;
        assert.deepEqual(Object.keys(props.properties), ['userAction', 'other']);
        assert.equal(props.additionalProperties, false);
        const type = fs.readFileSync(path.join(EXT, 'src', 'utils', 'sendToChatConfig.ts'), 'utf8');
        assert.match(type, /todoButtonTemplates\?: \{ userAction\?: string; other\?: string \};/);
    });
});
