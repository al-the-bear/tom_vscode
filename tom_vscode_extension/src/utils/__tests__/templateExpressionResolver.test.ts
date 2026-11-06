/**
 * `${{ … }}` placeholders in the two resolvers (variableResolver.ts resolveVariables, promptTemplate.ts
 * resolveTemplate), which evaluate them with the expression language (templateExpression.ts).
 *
 *   TR-1 both resolvers evaluate an expression with the variables `${name}` reads — the values, any case,
 *        and the dynamic namespaces (env.*) — and give the same text; `enableExpressions: false` leaves it
 *   TR-2 the default Proceed template renders with and without its optional parts
 *   TR-3 a template still in JavaScript gives '' and logs why (no JavaScript is run)
 */

/* eslint-disable @typescript-eslint/naming-convention -- template variable names as they are written */
import test, { describe } from 'node:test';
import assert from 'node:assert/strict';

import { installVscodeStub } from '../../tools/__tests__/_vscode-stub.js';
installVscodeStub({});

import { resolveVariables } from '../variableResolver.js';
import { resolveTemplate } from '../../handlers/promptTemplate.js';
import { DEFAULT_PROCESS_ACTION_TEMPLATES } from '../processActionPrompt.js';

const resolve = (text: string, values: Record<string, string> = {}): string =>
    resolveVariables(text, { values, includeEditor: false, unresolvedBehavior: 'empty' });

describe('${{ … }} in the resolvers', () => {
    test('TR-1: both resolvers, the same variables as ${name}', () => {
        process.env.TOM_TR1_VAR = 'from-env';
        const values = { 'role-description': 'R', Count: '3' };
        const cases: Array<[string, string]> = [
            ['${{ role-description ? "## Role\\n" + role-description : "" }}', '## Role\nR'],
            ['${{ count > 2 ? "many" : "few" }}', 'many'],          // any case, numeric
            ['${{ env.TOM_TR1_VAR + "!" }}', 'from-env!'],          // dynamic namespace
            ['${{ default(missing, "none") }} / ${role-description}', 'none / R'],
            ['a $${{ x }} b', 'a $${{ x }} b'],                     // escaped: as written
        ];
        for (const [text, want] of cases) {
            assert.equal(resolve(text, values), want, `resolveVariables: ${text}`);
            assert.equal(resolveTemplate(text, values), want, `resolveTemplate: ${text}`);
        }
        assert.equal(
            resolveVariables('x ${{ role-description }} y', { values, includeEditor: false, enableExpressions: false }),
            'x ${{ role-description }} y',
        );
    });

    test('TR-2: the default Proceed template', () => {
        const proceed = DEFAULT_PROCESS_ACTION_TEMPLATES.proceed;
        const base = {
            'action-position': 'P1', process: 'proc', phase: 'one', 'phase-iteration': '1', step: 'a', 'step-iteration': '2',
            'action-after': 'AFTER',
        };
        assert.equal(
            resolve(proceed, base),
            '# Run: P1\n\nProcess `proc`, phase `one` (iteration 1), step `a` (iteration 2).\n\nAFTER',
        );
        assert.equal(
            resolve(proceed, {
                ...base, substep: 's', 'substep-iteration': '3', 'action-note': 'NOTE', 'action-prompt': 'DO', 'custom-instructions': 'MINE',
            }),
            '# Run: P1\n\nProcess `proc`, phase `one` (iteration 1), step `a` (iteration 2), sub-step `s` (iteration 3).'
            + '\n\nNOTE\n\n## What to do\n\nDO\n\n## Instructions\n\nMINE\n\nAFTER',
        );
    });

    test('TR-3: JavaScript is not run', (t) => {
        const errors: string[] = [];
        t.mock.method(console, 'error', (m: unknown) => { errors.push(String(m)); });
        let ran = false;
        (globalThis as Record<string, unknown>).__trRan = () => { ran = true; return 'RAN'; };
        assert.equal(resolve('[${{ vars["x"] ? "a" : "b" }}]', { x: '1' }), '[]');
        assert.equal(resolve('[${{ globalThis.__trRan() }}]'), '[]');
        assert.equal(ran, false);
        assert.match(errors[0], /JavaScript.*migrate:ai-formats/);
        delete (globalThis as Record<string, unknown>).__trRan;
    });
});
