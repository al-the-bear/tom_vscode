/**
 * Tool-call arguments, read tolerantly (vscimpb69).
 *
 *   TA-1 an object is left alone; plain JSON; blank → {}
 *   TA-2 a code fence with and without a language tag, with surrounding whitespace and text
 *   TA-3 double-encoded JSON (a JSON string holding the object), also inside a fence
 *   TA-4 text around the object: its outermost braces
 *   TA-5 what still does not read becomes { _raw } with one log line naming the tool; an array is not an object
 */

import test, { describe } from 'node:test';
import assert from 'node:assert/strict';

import { parseToolArguments } from '../toolCallArguments.js';

const OBJ = { path: 'a.md', lines: [1, 2], nested: { ok: true } };
const JSON_TEXT = JSON.stringify(OBJ);

describe('tool-call arguments', () => {
    test('TA-1: object, plain JSON, blank', () => {
        const same = { x: 1 };
        const r = parseToolArguments(same, 't');
        assert.equal(r.args, same, 'the same object, not a copy');
        assert.equal(r.read, 'object');
        assert.deepEqual(parseToolArguments(JSON_TEXT, 't'), { args: OBJ, read: 'json' });
        assert.deepEqual(parseToolArguments(`  \n${JSON_TEXT}\n `, 't'), { args: OBJ, read: 'json' });
        assert.deepEqual(parseToolArguments('', 't'), { args: {}, read: 'empty' });
        assert.deepEqual(parseToolArguments('   ', 't'), { args: {}, read: 'empty' });
        assert.deepEqual(parseToolArguments(undefined, 't'), { args: {}, read: 'empty' });
    });

    test('TA-2: fenced', () => {
        for (const text of [
            '```json\n' + JSON_TEXT + '\n```',
            '```\n' + JSON_TEXT + '\n```',
            '  ```json\n  ' + JSON.stringify(OBJ, null, 2) + '\n  ```  \n',
            '```JSON ' + JSON_TEXT + '```',
            'Here are the arguments:\n```json\n' + JSON_TEXT + '\n```\nDone.',
            '```json\r\n' + JSON_TEXT + '\r\n```',
        ]) {
            assert.deepEqual(parseToolArguments(text, 't'), { args: OBJ, read: 'fenced' }, JSON.stringify(text));
        }
    });

    test('TA-3: double-encoded', () => {
        assert.deepEqual(parseToolArguments(JSON.stringify(JSON_TEXT), 't'), { args: OBJ, read: 'doubleEncoded' });
        assert.deepEqual(parseToolArguments('```json\n' + JSON.stringify(JSON_TEXT) + '\n```', 't'), { args: OBJ, read: 'doubleEncoded' });
    });

    test('TA-4: text around the object', () => {
        assert.deepEqual(parseToolArguments(`Calling with ${JSON_TEXT} now`, 't'), { args: OBJ, read: 'extracted' });
    });

    test('TA-5: unreadable → _raw and a log line', () => {
        const lines: string[] = [];
        const r = parseToolArguments('{"path": "a.md", ', 'tomAi_readFile', (l) => lines.push(l));
        assert.deepEqual(r, { args: { _raw: '{"path": "a.md", ' }, read: 'raw' });
        assert.equal(lines.length, 1);
        assert.match(lines[0], /tomAi_readFile: arguments are not a JSON object; the tool receives \{ _raw \}/);
        assert.equal(parseToolArguments('[1,2]', 't').read, 'raw', 'an array is not an argument object');
        assert.equal(parseToolArguments('"just text"', 't').read, 'raw');
        const quiet: string[] = [];
        parseToolArguments(JSON_TEXT, 't', (l) => quiet.push(l));
        parseToolArguments('```json\n' + JSON_TEXT + '\n```', 't', (l) => quiet.push(l));
        assert.deepEqual(quiet, [], 'only the _raw case is logged by the parser');
        const longLines: string[] = [];
        const long = parseToolArguments('x'.repeat(500), 't', (l) => longLines.push(l));
        assert.equal((long.args._raw as string).length, 500, 'the tool gets the whole text');
        assert.ok(longLines[0].endsWith('…') && longLines[0].length < 320, 'the log line is cut');
    });
});
