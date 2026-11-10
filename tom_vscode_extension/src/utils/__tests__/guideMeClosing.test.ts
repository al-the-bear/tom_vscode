/**
 * The closing step of a todo's Guide me (src/utils/guideMeClosing.ts, wired in questTodoPanel-handler.ts).
 *
 *   GM-1 the panel: the todo, then Mark it completed, Mark it in progress (not for a todo in progress already),
 *        Queue it (naming the template it queues with), Leave it as it is; a typed reply is a note
 *   GM-2 the reply read back: each choice, a typed note, nothing for Leave it as it is, a timeout or a refusal;
 *        the note appended to the todo's notes with the date
 *   GM-3 wiring: after a successful Guide me send (the user-action template, in the chat) the host asks — not after
 *        Send of another todo or a failed send; Queue it queues with the other todos' template
 */

import * as fs from 'fs';
import * as path from 'path';
import test, { describe } from 'node:test';
import assert from 'node:assert/strict';

import { appendTodoNote, guideMeClosingAsk, interpretGuideMeReply } from '../guideMeClosing.js';
import { choiceAnswer } from '../askChoices.js';

describe('Guide me: what now with the todo', () => {
    test('GM-1: the panel', () => {
        const ask = guideMeClosingAsk({ id: 'vsc3_x', title: 'Rotate the key', status: 'not-started' }, 'Execute TODO');
        assert.equal(ask.title, 'Guide me: vsc3_x');
        assert.match(ask.questions[0], /^What now with todo vsc3_x — Rotate the key\?/);
        assert.match(ask.questions[0], /type a note to add to the todo/);
        assert.deepEqual(ask.choices.map((c) => c.label), ['Mark it completed', 'Mark it in progress', 'Queue it (Execute TODO)', 'Leave it as it is']);
        assert.ok(ask.choices.every((c) => c.kind === 'answer'));
        const going = guideMeClosingAsk({ id: 'vsc3_x', status: 'in-progress' }, 'Execute TODO');
        assert.deepEqual(going.choices.map((c) => c.id), ['complete', 'queue', 'leave'], 'in progress already');
    });

    test('GM-2: the reply', () => {
        const ask = guideMeClosingAsk({ id: 't1', status: 'not-started' }, 'T');
        const click = (id: string) => choiceAnswer(ask.choices.find((c) => c.id === id)!);
        assert.deepEqual(interpretGuideMeReply(click('complete')), { kind: 'complete' });
        assert.deepEqual(interpretGuideMeReply(click('in-progress')), { kind: 'inProgress' });
        assert.deepEqual(interpretGuideMeReply(click('queue')), { kind: 'queue' });
        assert.equal(interpretGuideMeReply(click('leave')), undefined);
        assert.deepEqual(interpretGuideMeReply(' the key is rotated on bigbeast, mbp next '), { kind: 'note', text: 'the key is rotated on bigbeast, mbp next' });
        assert.equal(interpretGuideMeReply('No answer.', 'No answer.'), undefined, 'a timeout');
        assert.equal(interpretGuideMeReply('askUser error: an ask is pending'), undefined);
        assert.equal(appendTodoNote(undefined, ' done half ', '2026-11-10'), '2026-11-10 (Guide me): done half');
        assert.equal(appendTodoNote('Earlier.\n', 'more', '2026-11-10'), 'Earlier.\n2026-11-10 (Guide me): more');
    });

    test('GM-3: wiring', () => {
        const src = fs.readFileSync(path.join(__dirname, '..', '..', '..', 'src', 'handlers', 'questTodoPanel-handler.ts'), 'utf8');
        assert.match(src, /\} else if \(outcome\.ok && use === 'userAction' && questId\) \{\s*await _guideMeClosing\(todo\.id, questId, sourceFile\);/);
        assert.match(src, /const queueTpl = resolveTodoButtonTemplate\(anthropic\?\.todoButtonTemplates, anthropic\?\.userMessageTemplates, 'other'\);/);
        assert.match(src, /await _queueTodo\(todo, questId, sourceFile, queueTpl\);/);
        assert.match(src, /\{ status: 'completed', completed_date: todayLocalDate\(\) \}/);
    });
});
