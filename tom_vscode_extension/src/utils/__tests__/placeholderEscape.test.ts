/**
 * Writing a literal placeholder (vscimpa10): `$${name}` (and `$${{expr}}`)
 * passes through every resolution untouched and becomes `${name}` only where
 * text leaves for the model — so a process description or a step prompt can
 * show `${repeatTodoId}` to the agent, who writes it into the item it queues.
 *
 *   PE-1 both resolvers (variableResolver, promptTemplate) leave an escaped placeholder as written and resolve the
 *        plain one beside it; unescapePlaceholders turns `$${…}` into `${…}`, `$${{…}}` into `${{…}}`
 *   PE-2 the escape survives every recursive pass, also inside a value another placeholder inserts, and even
 *        when its name has a value
 *   PE-3 the Proceed → queue → send chain: the action template, the queue's repeat pass, the template pass, then
 *        the unescape at the transport — a literal `${repeatTodoId}` arrives; the item the agent then queues
 *        with that text resolves it
 *   PE-4 the unescape is applied at every output: the Anthropic system prompt and user message, the Copilot
 *        dispatch, and tomAi_getProcessState's context
 */

import test, { describe } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'fs';
import * as path from 'path';

import { installVscodeStub } from '../../tools/__tests__/_vscode-stub.js';
installVscodeStub({});

import { resolveVariables, unescapePlaceholders } from '../variableResolver.js';
import { resolveTemplate } from '../../handlers/promptTemplate.js';
import { getProcessStateImpl } from '../../tools/quest-process-tools.js';

const SRC = path.resolve(__dirname, '..', '..', '..', 'src');
const resolve = (text: string, values: Record<string, string> = {}): string =>
    resolveVariables(text, { values, includeEditor: false, unresolvedBehavior: 'empty' });

describe('a literal placeholder', () => {
    test('PE-1: left as written, unescaped at the end', () => {
        const text = 'Do quest todo `$${repeatTodoId}` for ${who}; compute $${{1 + 1}}.';
        const resolved = resolve(text, { who: 'Ann', repeatTodoId: 'T-1' });
        assert.equal(resolved, 'Do quest todo `$${repeatTodoId}` for Ann; compute $${{1 + 1}}.');
        assert.equal(resolveTemplate(text, { who: 'Ann', repeatTodoId: 'T-1' }), resolved, 'the other resolver alike');
        assert.equal(unescapePlaceholders(resolved), 'Do quest todo `${repeatTodoId}` for Ann; compute ${{1 + 1}}.');
        assert.equal(resolve('${a}$${b}', { a: 'x' }), 'x$${b}', 'right after a resolved placeholder');
        assert.equal(unescapePlaceholders('no escape ${x} $$ $'), 'no escape ${x} $$ $', 'nothing else changes');
    });

    test('PE-2: through every pass', () => {
        const values = { outer: 'step: ${inner}', inner: 'queue `$${repeatTodoId}` per todo', repeatTodoId: 'T-9' };
        assert.equal(resolve('${outer}', values), 'step: queue `$${repeatTodoId}` per todo');
        // resolveTemplate makes one pass by design; a value it inserts keeps its escape.
        assert.equal(resolveTemplate('${inner}', values), 'queue `$${repeatTodoId}` per todo');
    });

    test('PE-3: Proceed → queue → send', () => {
        const stepPrompt = 'Queue `Please do the quest todo $${repeatTodoId}` with repeat count `p2s3-*`.';
        // 1. Proceed fills its template (processActionService).
        const proceed = resolve('## What to do\n\n${action-prompt}', Object.fromEntries([['action-prompt', stepPrompt]]));
        // 2. The queue's repeat pass (a normal item: no todo).
        const repeatPass = resolve(proceed, { repeatTodoId: '', repeatNumber: '1' });
        // 3. The template pass (expandTemplate's resolver).
        const templatePass = resolveTemplate(repeatPass, {});
        // 4. The transport sends it.
        const sent = unescapePlaceholders(templatePass);
        assert.match(sent, /Queue `Please do the quest todo \$\{repeatTodoId\}` with repeat count `p2s3-\*`\./);
        // The agent queues that text; its own dispatch resolves the todo.
        const queued = 'Please do the quest todo ${repeatTodoId}';
        assert.equal(resolve(queued, { repeatTodoId: 'p2s3-1_ajtf-x' }), 'Please do the quest todo p2s3-1_ajtf-x');
    });

    test('PE-4: unescaped at every output', async () => {
        const handler = fs.readFileSync(path.join(SRC, 'handlers', 'anthropic-handler.ts'), 'utf8');
        const body = (name: string): string => {
            const start = handler.indexOf(`private ${name}(`);
            assert.ok(start > 0, `${name} not found`);
            return handler.slice(start, handler.indexOf('\n    }\n', start));
        };
        assert.match(body('buildSystemSegments'), /unescapePlaceholders\(/, 'the system prompt');
        const user = body('buildUserMessage');
        assert.equal((user.match(/return /g) ?? []).length, (user.match(/return unescapePlaceholders\(/g) ?? []).length,
            'every way the user message is returned');
        const queue = fs.readFileSync(path.join(SRC, 'managers', 'promptQueueManager.ts'), 'utf8');
        assert.match(queue, /'workbench\.action\.chat\.open', \{ query: unescapePlaceholders\(expandedText\) \}/, 'the Copilot dispatch');

        const answer = JSON.parse(await getProcessStateImpl({
            activeQuest: () => 'q', state: () => ({}) as never, currentRole: () => '',
            contextBlock: () => 'Queue `$${repeatTodoId}`',
        } as never));
        assert.equal(answer.context, 'Queue `${repeatTodoId}`', 'tomAi_getProcessState shows what the system prompt shows');
    });
});
