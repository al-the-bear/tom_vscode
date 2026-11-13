/**
 * Choices through the live question panel (askUser-handler.ts) under the
 * vscode stub, whose webview panels record what the host posts and take the
 * webview's messages (ccparity_i_assist-4).
 *
 *   AL-1 tomAi_askUser with answer choices: the question in the user-input panel carries the choices and their layout; the
 *        webview's `answers` message (Send answers) answers the ask with every question's selection and words,
 *        numbered (vscimpb35); the question leaves the panel
 *   AL-2 a move with no process set is refused before anything is shown
 *   AL-3 askUserWithChoices (the Agent SDK route) asks through the same panel
 */

import test, { describe } from 'node:test';
import assert from 'node:assert/strict';
import * as path from 'node:path';

import { installVscodeStub } from '../../tools/__tests__/_vscode-stub.js';

const stubbed = installVscodeStub({});

// Safe to import after the stub is wired into the resolver. The tool registry
// first: the handler is one of its members, and loading it alone hits the cycle.
import '../../tools/tool-executors.js';
import { ASK_USER_LIVE_TOOL, askUserWithChoices } from '../askUser-handler.js';
import { showUserInteractions } from '../userInteractionPanel.js';
import { userInteractions } from '../../services/userInteractions.js';
import { setExtensionPath } from '../handler_shared.js';

setExtensionPath(path.join(__dirname, '..', '..', '..'));

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Json = any;
const panels = (): Json[] => (stubbed.stub.window as Json).__webviewPanels;
/** The open question in the user-input panel (vscimpb81), and the panel to answer it in. */
const openQuestion = (): Json => userInteractions.list().find((i) => i.kind === 'question');
function uiPanel(): Json {
    showUserInteractions();
    return panels()[panels().length - 1];
}
const tick = () => new Promise((r) => setTimeout(r, 5));

describe('choices in the live question panel', () => {
    test('AL-1: an answer choice', async () => {
        const call = ASK_USER_LIVE_TOOL.execute({ questions: ['Which way? {{choice:left}}'], choices: [{ id: 'left', label: 'Left', kind: 'answer' }, { id: 'right', label: 'Right', kind: 'answer', target: 'go right' }] });
        await tick();
        const q = openQuestion();
        assert.deepEqual(q.data.choices.map((c: Json) => c.id), ['left', 'right']);
        assert.deepEqual(q.data.layout, [{ segments: [{ text: 'Which way? ' }, { choiceId: 'left' }], below: ['right'] }]);
        const panel = uiPanel();
        panel.webview.__receive({ type: 'answers', requestId: 'stale', answers: [{ choiceId: 'right' }], text: '' });
        panel.webview.__receive({ type: 'answers', requestId: q.id, answers: [{ choiceId: 'right', text: 'the short way' }], text: 'ok' });
        assert.equal(await call, 'The answers, numbered like the questions:\n1. chose "Right" (id right, answer: go right) and wrote: the short way\n\nok');
        assert.equal(openQuestion(), undefined, 'the question leaves the panel');
    });

    test('AL-2: a move without a process is refused', async () => {
        const answer = await ASK_USER_LIVE_TOOL.execute({ questions: ['Move?'], choices: [{ id: 'm', label: 'M', kind: 'move', target: 'review' }] });
        assert.match(answer, /^askUser error: choice "m": a move needs a process, and the quest has none set\. Nothing was asked\.$/);
        assert.equal(openQuestion(), undefined, 'nothing shown');
    });

    test('AL-3: the Agent SDK route', async () => {
        const call = askUserWithChoices({ questions: ['[Flow] Next?'], choices: [{ id: 'ok', label: 'OK', kind: 'answer' }] });
        await tick();
        const q = openQuestion();
        assert.deepEqual(q.data.questions, ['[Flow] Next?']);
        uiPanel().webview.__receive({ type: 'answers', requestId: q.id, answers: [{ choiceId: 'ok' }], text: '' });
        assert.match(await call, /^The answers, numbered like the questions:\n1\. chose "OK" \(id ok\)$/);
    });
});
