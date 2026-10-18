/**
 * The live unblock port over real todo files in a temp workspace.
 *
 *   UP-1  blocked_by and blocked_until are read from the YAML; archived todos are not live
 *   UP-2  end to end: a todo blocked by an earlier one is released once that one is completed, and picked
 */

import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import { installVscodeStub } from '../../tools/__tests__/_vscode-stub.js';

const ws = fs.mkdtempSync(path.join(os.tmpdir(), 'todo-unblock-port-'));
installVscodeStub({ workspaceFolders: [ws] });

import * as questTodo from '../../managers/questTodoManager.js';
import { questTodoUnblockPort } from '../questTodoUnblockPort.js';
import { pickNextTodoForIteration, releaseUnblockedTodos } from '../queueStep3Utils.js';

const write = (quest: string, file: string, yamlText: string): string => {
    const fp = path.join(ws, '_ai', 'quests', quest, file);
    fs.mkdirSync(path.dirname(fp), { recursive: true });
    fs.writeFileSync(fp, yamlText);
    return fp;
};
const port = questTodoUnblockPort((q, id, status) => questTodo.updateTodo(q, id, { status } as never) !== undefined);

describe('questTodoUnblockPort', () => {
    test('UP-1: block conditions and live scope', () => {
        write('q1', 'todos.q1.todo.yaml', [
            'todos:',
            '  - id: dsa2',
            '    description: second',
            '    status: blocked',
            '    blocked_by:',
            '      - dsa1',
            '    blocked_until:',
            '      - "tom_d4rt >= 1.0.0"',
            '',
        ].join('\n'));
        write('q1', 'todos-archived.q1.todo.yaml', 'todos:\n  - id: dsa1\n    description: first\n    status: completed\n');
        const todos = port.readTodos('q1');
        assert.deepEqual(todos, [{ id: 'dsa2', status: 'blocked', blockedBy: ['dsa1'], blockedUntil: ['tom_d4rt >= 1.0.0'] }]);
        assert.deepEqual(releaseUnblockedTodos('dsa*', 'q1', port).released, [], 'blocked_until keeps it blocked');
    });

    test('UP-2: released once the earlier todo is completed, then picked', () => {
        write('q2', 'todos.q2.todo.yaml', [
            'todos:',
            '  - id: dsa1',
            '    description: first',
            '    status: in-progress',
            '  - id: dsa2',
            '    description: second',
            '    status: blocked',
            '    blocked_by:',
            '      - dsa1',
            '  - id: dsa3',
            '    description: third',
            '    status: blocked',
            '',
        ].join('\n'));
        assert.deepEqual(releaseUnblockedTodos('dsa*', 'q2', port).released, [], 'dsa1 still running');
        questTodo.updateTodo('q2', 'dsa1', { status: 'completed' } as never);
        const r = releaseUnblockedTodos('dsa*', 'q2', port);
        assert.deepEqual(r.released.map((u) => u.id), ['dsa2']);
        assert.equal(questTodo.findTodoById('q2', 'dsa2')?.status, 'not-started');
        assert.equal(questTodo.findTodoById('q2', 'dsa3')?.status, 'blocked', 'a prose-only block stays');
        assert.equal(pickNextTodoForIteration('dsa*', questTodo.readAllTodos('q2'))?.id, 'dsa2');
    });
});
