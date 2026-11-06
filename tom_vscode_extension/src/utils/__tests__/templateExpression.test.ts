/**
 * The expression language of `${{ … }}` placeholders (src/utils/templateExpression.ts).
 *
 *   TE-1 the syntax table: names, strings and escapes, numbers, true / false, +, the comparisons
 *        (numeric when both sides are numbers), && / || returning an operand, !, ?:, parentheses, precedence
 *   TE-2 the helpers empty / notEmpty / lower / upper / default
 *   TE-3 errors: syntax errors name their position; an unknown helper, a wrong argument count and a
 *        JavaScript object (vars, editor, Number, …) are refused with what to write instead
 *   TE-4 convertJsExpression: every JavaScript form the saved templates use converts, and the conversion
 *        gives the same text as the JavaScript did, over several sets of variables
 *   TE-5 what cannot be converted is refused (other objects, method calls, arithmetic, ??, template strings)
 *   TE-6 convertTemplateText: converts every placeholder of a text, leaves an expression-language one and an
 *        escaped `$${{…}}` alone, and returns a text with an unconvertible placeholder unchanged
 */

/* eslint-disable @typescript-eslint/naming-convention -- template variable names as they are written */
import test, { describe } from 'node:test';
import assert from 'node:assert/strict';

import {
    convertJsExpression,
    convertTemplateText,
    evaluateExpression,
    ExpressionError,
    parseExpression,
} from '../templateExpression.js';

const VARS: Record<string, string> = {
    'process-context': 'P',
    'git.dirty': 'true',
    'file.name': 'a.ts',
    count: '10',
    small: '9',
    zero: '0',
    empty: '',
    Name: 'Ann',
};
const lookup = (vars: Record<string, string>) => (n: string): string | undefined => vars[n];
const ev = (src: string, vars: Record<string, string> = VARS) => evaluateExpression(src, lookup(vars));

describe('template expressions', () => {
    test('TE-1: the syntax table', () => {
        const cases: Array<[string, string]> = [
            ['process-context', 'P'],
            ['missing', ''],
            ['"a\\nb" + \'c\\\'d\'', 'a\nbc\'d'],
            ['42', '42'],
            ['true', 'true'],
            ['process-context + "-" + file.name', 'P-a.ts'],
            ['git.dirty == "true"', 'true'],
            ['git.dirty != "true"', 'false'],
            ['count > small', 'true'],         // numeric: 10 > 9
            ['"10" > "9"', 'true'],            // both numbers → numeric
            ['"b" > "a"', 'true'],             // text order
            ['count >= 10', 'true'],
            ['zero < 1', 'true'],
            ['empty || "fallback"', 'fallback'],
            ['process-context || "fallback"', 'P'],
            ['process-context && "yes"', 'yes'],
            ['empty && "yes"', ''],
            ['!empty', 'true'],
            ['!process-context', 'false'],
            ['zero ? "set" : "unset"', 'set'],  // "0" is a non-empty string
            ['empty ? "set" : "unset"', 'unset'],
            ['process-context ? "## C\\n" + process-context + "\\n" : ""', '## C\nP\n'],
            ['empty ? "a" : missing ? "b" : "c"', 'c'],
            ['(empty || missing) ? "x" : "y"', 'y'],
            ['"a" + "b" == "ab"', 'true'],      // + binds tighter than ==
            ['empty == "" && count > 1', 'true'], // == tighter than &&
        ];
        for (const [src, want] of cases) { assert.equal(ev(src), want, src); }
    });

    test('TE-2: the helpers', () => {
        assert.equal(ev('empty(empty)'), 'true');
        assert.equal(ev('empty(Name)'), 'false');
        assert.equal(ev('notEmpty(Name)'), 'true');
        assert.equal(ev('lower(Name)'), 'ann');
        assert.equal(ev('upper(Name) + "!"'), 'ANN!');
        assert.equal(ev('default(missing, "none")'), 'none');
        assert.equal(ev('default(Name, "none")'), 'Ann');
        assert.equal(ev('notEmpty(file.name) ? "File: " + file.name : ""'), 'File: a.ts');
    });

    test('TE-3: errors', () => {
        const err = (src: string): ExpressionError => {
            try { parseExpression(src); } catch (e) { assert.ok(e instanceof ExpressionError, src); return e; }
            assert.fail(`${src} parsed`);
        };
        assert.match(err('"open').message, /unterminated string/);
        assert.equal(err('a +').position, 3);
        assert.match(err('a ? b').message, /expected ":"/);
        assert.match(err('shout(a)').message, /unknown helper shout\(\)/);
        assert.match(err('default(a)').message, /takes 2 argument/);
        assert.match(err('vars["x"]').message, /JavaScript.*vars\["process-context"\].*migrate:ai-formats/);
        assert.match(err('editor ? "a" : ""').message, /JavaScript/);
        assert.match(err('Number(count) > 0').message, /JavaScript/);
        assert.match(err('a * 2').message, /unexpected "\*"/);
    });

    test('TE-4: the JavaScript in use converts to the same text', () => {
        // Every form found in the workspace config, the user overlay, the process definitions and the code.
        const forms = [
            'vars["process-context"] ? "## Current process\\n" + vars["process-context"] + "\\n" : ""',
            'vars["role-description"] ? "## Your role\\n" + vars["role-description"] + "\\n" : "## Your role\\nNo role is set.\\n"',
            'vars["git.dirty"] === "true" ? " · ⚠️ uncommitted changes" : ""',
            'vars["rawTurns"] && Number(vars["rawTurnCount"]) > 0 ? "## Raw turns (" + vars["rawTurnCount"] + " recent messages)\\n\\n" + vars["rawTurns"] + "\\n\\n" : ""',
            'vars["file.name"] || "(none)"',
            'vars["file.extension"] ? " (" + vars["file.extension"] + ")" : ""',
            'editor?.document.getText(editor.selection) ? "- Selection:\\n  ```\\n" + editor.document.getText(editor.selection) + "\\n  ```\\n" : ""',
            'vars.substep ? ", sub-step `" + vars.substep + "` (iteration " + vars["substep-iteration"] + ")" : ""',
            'vars["action-note"] ? "\\n\\n" + vars["action-note"] : ""',
            'vars["git.branch"] !== "main" ? "DEV" : "PROD"',
        ];
        const varSets: Array<Record<string, string>> = [
            {},
            { 'process-context': 'P', 'role-description': 'R', 'git.dirty': 'true', rawTurns: 'T', rawTurnCount: '3', 'file.name': 'f.ts', 'file.extension': '.ts', selection: 'sel', substep: 's1', 'substep-iteration': '2', 'action-note': 'N', 'git.branch': 'main' },
            { 'git.dirty': 'false', rawTurns: 'T', rawTurnCount: '0', 'file.name': '', selection: '', substep: '', 'git.branch': 'dev' },
        ];
        for (const js of forms) {
            const c = convertJsExpression(js);
            assert.ok(c.ok, `${js}: ${c.ok ? '' : c.reason}`);
            if (!c.ok) { continue; }
            for (const vars of varSets) {
                // Why `new Function` here: the test runs the JavaScript the template used to run, to hold the
                // conversion to the same result. The resolver itself runs none.
                // eslint-disable-next-line no-new-func, @typescript-eslint/no-implied-eval
                const fn = new Function('vars', 'editor', `"use strict"; return (${js});`);
                const editor = vars.selection === undefined ? undefined : { selection: 'S', document: { getText: () => vars.selection } };
                const jsResult = fn(vars, editor);
                const want = jsResult === undefined || jsResult === null ? '' : String(jsResult);
                assert.equal(ev(c.expression, vars), want, `${js} → ${c.expression} with ${JSON.stringify(vars)}`);
            }
        }
        const c = convertJsExpression('vars["process-context"] ? "## P\\n" : ""');
        assert.deepEqual(c, { ok: true, expression: 'process-context ? "## P\\n" : ""' });
    });

    test('TE-5: what cannot be converted is refused', () => {
        for (const js of [
            'path.basename(vars.workspaceFolder)',
            'os.homedir()',
            'Number(vars.repeatNumber) + 1',
            'vars.a ?? "x"',
            'Number(vars.a) * 10',
            'new Date().toDateString()',
            '`Pass ${vars.n}`',
            'vars.list.length',
            'env.HOME',
        ]) {
            const c = convertJsExpression(js);
            assert.equal(c.ok, false, js);
        }
    });

    test('TE-6: convertTemplateText', () => {
        const text = 'A ${{ vars["x"] ? "X:" + vars["x"] : "" }} B ${{ y ? "Y" : "" }} C $${{ vars["z"] }} D ${plain}';
        const r = convertTemplateText(text);
        assert.deepEqual(r.problems, []);
        assert.equal(r.converted, 1);
        assert.equal(r.text, 'A ${{ x ? "X:" + x : "" }} B ${{ y ? "Y" : "" }} C $${{ vars["z"] }} D ${plain}');
        assert.deepEqual(convertTemplateText(r.text), { text: r.text, converted: 0, problems: [] }, 'idempotent');

        const mixed = '${{ vars["a"] ? "A" : "" }} and ${{ path.basename(vars.f) }}';
        const m = convertTemplateText(mixed);
        assert.equal(m.text, mixed, 'never half-converted');
        assert.equal(m.converted, 0);
        assert.equal(m.problems.length, 1);
        assert.match(m.problems[0], /path\.basename.*"path"/);
    });
});
