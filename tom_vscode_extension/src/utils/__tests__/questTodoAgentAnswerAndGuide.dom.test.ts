/**
 * The todo detail's "Agent answer" row and its "Guide me" buttons
 * (media/questTodoPanel/main.js, src/utils/todoAgentAnswer.ts,
 * src/handlers/questTodoPanel-handler.ts).
 *
 *   AG-1 every saved todo, whatever its status, has an "Agent answer" row with the two markdown
 *        preview buttons; the new-todo form has none
 *   AG-2 they post qtShowAgentAnswer with the mode, the todo's quest, id and source file and the
 *        stored last_answer as fallback
 *   AG-3 latestTodoAnswer takes the newest trail answer whose TODO response value names the todo
 *        (id, quest folder, file), never another todo's or another quest's
 *   AG-4 beside the "Your to do" checkbox of a saved todo: "Guide me" in the chat and via the queue;
 *        they post qtGuideUserAction with target chat / queue; the new-todo form has neither
 *   AG-5 the host looks the answer up in the trails (falling back to last_answer) and renders it safely,
 *        and sends / queues on Anthropic with the Todo buttons template for user-action todos
 */

/* eslint-disable @typescript-eslint/naming-convention -- `last_answer`, `_sourceFile` are the todo's keys */
import test, { describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { JSDOM } from 'jsdom';

import { latestTodoAnswer, refNamesTodo } from '../todoAgentAnswer.js';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Win = any;

const ROOT = join(__dirname, '..', '..', '..');
const media = (...parts: string[]): string => readFileSync(join(ROOT, 'media', ...parts), 'utf-8');

function panel(t: { after(fn: () => void): void }): { w: Win; posted: Array<Record<string, unknown>> } {
    const dom = new JSDOM(`<body>${media('questTodoPanel', 'fragment.html')}</body>`, { runScripts: 'outside-only' });
    const w = dom.window as Win;
    t.after(() => w.close());
    const posted: Array<Record<string, unknown>> = [];
    w.vscode = { postMessage: (m: Record<string, unknown>) => posted.push(JSON.parse(JSON.stringify(m))), getState: () => undefined, setState: () => undefined };
    w.eval('var qtViewConfig = {};\n' + media('shared', 'mdOverlay.js') + media('questTodoPanel', 'grouping.js') + media('questTodoPanel', 'main.js'));
    w.eval("qtCurrentQuestId = 'vscode_extension';");
    return { w, posted };
}

const OPEN = { id: 'vbs3', title: 'Open one', status: 'in-progress', description: 'x', _sourceFile: 'todos.vscode_extension.todo.yaml' };

describe('todo detail: agent answer and guide me', () => {
    test('AG-1: the row on every saved todo', (t) => {
        const { w } = panel(t);
        for (const status of ['not-started', 'in-progress', 'blocked', 'completed']) {
            w.eval(`qtDetailTodo = ${JSON.stringify({ ...OPEN, status })};`);
            w.qtRenderDetail({ ...OPEN, status });
            const pane = w.document.getElementById('qt-detail-pane');
            assert.match(pane.textContent, /Agent answer/, status);
            assert.ok(pane.querySelector('.qt-md-btn[data-qt-md-field="answer"][data-qt-md-mode="overlay"]'), status);
            assert.ok(pane.querySelector('.qt-md-btn[data-qt-md-field="answer"][data-qt-md-mode="editor"]'), status);
        }
        w.qtShowNewTodoForm('vbs9');
        assert.equal(w.document.querySelectorAll('#qt-detail-pane .qt-md-btn[data-qt-md-field="answer"]').length, 0);
    });

    test('AG-2: the buttons ask the host', (t) => {
        const { w, posted } = panel(t);
        const todo = { ...OPEN, last_answer: 'stored' };
        w.eval(`qtDetailTodo = ${JSON.stringify(todo)};`);
        w.qtRenderDetail(todo);
        const pane = w.document.getElementById('qt-detail-pane');
        pane.querySelector('.qt-md-btn[data-qt-md-field="answer"][data-qt-md-mode="overlay"]').click();
        assert.deepEqual(posted.pop(), { type: 'qtShowAgentAnswer', mode: 'overlay', questId: 'vscode_extension', todoId: 'vbs3', sourceFile: 'todos.vscode_extension.todo.yaml', fallback: 'stored' });
        pane.querySelector('.qt-md-btn[data-qt-md-field="answer"][data-qt-md-mode="editor"]').click();
        assert.equal(posted.pop()?.mode, 'editor');
    });

    test('AG-3: the newest trail answer that names the todo', () => {
        const ref = (q: string, f: string, id: string): string => `- TODO = _ai/quests/${q}/${f}/${id}`;
        const entries = [
            { type: 'ANSWER', timestamp: '2026-11-07T10:00:00', content: 'first', variables: ref('vscode_extension', 'todos.vscode_extension.todo.yaml', 'vbs3') },
            { type: 'ANSWER', timestamp: '2026-11-07T11:00:00', content: 'newest', variables: ref('vscode_extension', 'todos.vscode_extension.todo.yaml', 'vbs3') },
            { type: 'ANSWER', timestamp: '2026-11-07T12:00:00', content: 'other todo', variables: ref('vscode_extension', 'todos.vscode_extension.todo.yaml', 'vbs30') },
            { type: 'ANSWER', timestamp: '2026-11-07T13:00:00', content: 'other quest', variables: ref('webwork', 'todos.webwork.todo.yaml', 'vbs3') },
            { type: 'PROMPT', timestamp: '2026-11-07T14:00:00', content: 'a prompt', variables: ref('vscode_extension', 'todos.vscode_extension.todo.yaml', 'vbs3') },
        ];
        const addr = { questId: 'vscode_extension', todoId: 'vbs3', sourceFile: 'todos.vscode_extension.todo.yaml' };
        assert.equal(latestTodoAnswer(entries, addr)?.content, 'newest');
        assert.equal(latestTodoAnswer(entries, { ...addr, todoId: 'nothing' }), undefined);
        assert.equal(refNamesTodo('_ai/quests/vscode_extension/session-todo.h.vscode_extension.todo.yaml/vbs3', addr), false, 'another file of the quest');
        assert.equal(refNamesTodo('_ai/quests/vscode_extension/session-todo.h.vscode_extension.todo.yaml/vbs3', { questId: 'vscode_extension', todoId: 'vbs3' }), true, 'any file when it is not known');
    });

    test('AG-4: guide me beside the user-action checkbox', (t) => {
        const { w, posted } = panel(t);
        w.eval(`qtDetailTodo = ${JSON.stringify(OPEN)};`);
        w.qtRenderDetail(OPEN);
        const box = w.document.getElementById('qt-d-user-action');
        const row = box.closest('.qt-form-row');
        const chat = row.querySelector('.qt-guide-btn[data-qt-guide="chat"]');
        const queue = row.querySelector('.qt-guide-btn[data-qt-guide="queue"]');
        assert.ok(chat && queue, 'both buttons in the checkbox row');
        chat.click();
        assert.deepEqual(posted.pop(), { type: 'qtGuideUserAction', target: 'chat', questId: 'vscode_extension', todoId: 'vbs3', sourceFile: 'todos.vscode_extension.todo.yaml' });
        queue.click();
        assert.equal(posted.pop()?.target, 'queue');
        w.qtShowNewTodoForm('vbs9');
        assert.equal(w.document.querySelectorAll('#qt-detail-pane .qt-guide-btn').length, 0, 'not on the new-todo form');
    });

    test('AG-5: the host', () => {
        const host = readFileSync(join(ROOT, 'src', 'handlers', 'questTodoPanel-handler.ts'), 'utf-8');
        assert.match(host, /case 'qtShowAgentAnswer':[\s\S]{0,1500}_latestAgentAnswer\([\s\S]{0,1500}renderQuestLogMarkdown/);
        assert.match(host, /function _latestAgentAnswer[\s\S]{0,800}latestTodoAnswer\(loadTrailSet/);
        assert.match(host, /case 'qtShowAgentAnswer':[\s\S]{0,2500}showMarkdownHtmlPreview/);
        const guide = host.slice(host.indexOf("case 'qtGuideUserAction':"), host.indexOf("case 'qtOpenMarkdownPreview':"));
        assert.match(guide, /const use = msg\.type === 'qtGuideUserAction' \? 'userAction' : todoButtonTemplateUse\(todo\)/, 'Guide me: the user-action template setting');
        const run = host.slice(host.indexOf('async function _runTodoButton('));
        assert.match(run, /template: tpl\.id,\s*transport: 'anthropic',\s*deferSend: true/, 'queued staged on Anthropic');
        assert.match(run, /runAnthropicSend\(ctx, todoPrompt, \{ userMessageTemplate: tpl\.body, source: `todo panel: \$\{use === 'userAction' \? 'guide me' : 'send'\}` \}\)/, 'sent in the chat with the template');
    });
});
