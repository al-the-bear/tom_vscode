/**
 * "Send to Anthropic/LLM" (`tomAi.sendToLlm*`): the text it takes, the templates it picks
 * from (src/utils/sendToLlm.ts), and how it is reached (package.json, the
 * chord menu, the handler).
 *
 *   SL-1 the plain variant needs a selection; the others send the whole file without one; whitespace is no text
 *   SL-2 the templates of the store, in order, labelled by name, the default flagged; broken entries left out
 *   SL-3 package.json declares the three commands, the editor context menu shows them (the plain one with a
 *        selection) and Ctrl+Shift+L opens the LLM chord menu; nothing names a Local LLM send any more
 *   SL-4 the chord menu offers the three commands and the handler registers what package.json declares
 */

import test, { describe } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'fs';
import * as path from 'path';

import { llmSendText, llmTemplateChoices } from '../sendToLlm.js';

const ROOT = path.resolve(__dirname, '..', '..', '..');
const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
const read = (rel: string): string => fs.readFileSync(path.join(ROOT, rel), 'utf8');
const COMMANDS = ['tomAi.sendToLlm', 'tomAi.sendToLlm.standard', 'tomAi.sendToLlm.template'];

describe('Send to Anthropic/LLM', () => {
    test('SL-1: the text a variant takes', () => {
        assert.deepEqual(llmSendText('sel', 'doc', 'selection'), { text: 'sel' });
        assert.deepEqual(llmSendText('', 'doc', 'selection'), { error: 'No text selected.' });
        assert.deepEqual(llmSendText('  \n', 'doc', 'selection'), { error: 'No text selected.' });
        assert.deepEqual(llmSendText('sel', 'doc', 'selectionOrDocument'), { text: 'sel' });
        assert.deepEqual(llmSendText('', 'doc', 'selectionOrDocument'), { text: 'doc' });
        assert.deepEqual(llmSendText('', ' \n', 'selectionOrDocument'), { error: 'The file is empty.' });
    });

    test('SL-2: the templates to pick from', () => {
        assert.deepEqual(llmTemplateChoices(undefined), []);
        assert.deepEqual(llmTemplateChoices([
            { id: 'a', name: 'Review', template: 'Review: ${userMessage}' },
            { id: 'b', template: 'B ${userMessage}', isDefault: true },
            { id: '', template: 'no id' },
            { id: 'c' },
            null,
        ]), [
            { id: 'a', label: 'Review', template: 'Review: ${userMessage}', isDefault: false },
            { id: 'b', label: 'b', template: 'B ${userMessage}', isDefault: true },
        ]);
    });

    test('SL-3: package.json', () => {
        const declared = new Map<string, { title: string }>(pkg.contributes.commands.map((c: { command: string; title: string }) => [c.command, c]));
        assert.equal(declared.get('tomAi.sendToLlm')?.title, '@T: Send to Anthropic/LLM');
        assert.equal(declared.get('tomAi.sendToLlm.standard')?.title, '@T: Send to Anthropic/LLM (Default Template)');
        assert.equal(declared.get('tomAi.sendToLlm.template')?.title, '@T: Send to Anthropic/LLM (Pick Template)');
        const menu = pkg.contributes.menus['editor/context'] as Array<{ command: string; when?: string; group?: string }>;
        const llm = menu.filter((m) => COMMANDS.includes(m.command));
        assert.deepEqual(llm.map((m) => [m.command, m.group, m.when]), [
            ['tomAi.sendToLlm.standard', 'llm@1', undefined],
            ['tomAi.sendToLlm.template', 'llm@2', undefined],
            ['tomAi.sendToLlm', 'llm@3', 'editorHasSelection'],
        ]);
        const chord = (pkg.contributes.keybindings as Array<{ command: string; key: string }>).filter((k) => k.key === 'ctrl+shift+l');
        assert.deepEqual(chord.map((k) => k.command), ['tomAi.chordMenu.llm']);
        assert.doesNotMatch(JSON.stringify(pkg.contributes), /sendToLocalLlm|Send to Local LLM|chordMenu\.localLlm/);
    });

    test('SL-4: the chord menu and the handler', () => {
        const chord = read('src/handlers/chordMenu-handler.ts');
        assert.match(chord, /registerCommand\('tomAi\.chordMenu\.llm', chordMenuLlmHandler\)/);
        const group = chord.slice(chord.indexOf('    llm: {'), chord.indexOf('    execute: {'));
        for (const c of COMMANDS) { assert.ok(group.includes(`commandId: '${c}'`), `chord menu lacks ${c}`); }
        assert.match(group, /prefix: 'Ctrl\+Shift\+L'/);
        const handler = read('src/handlers/sendToLlm-handler.ts');
        for (const [key, c] of [['plain', 'tomAi.sendToLlm'], ['standard', 'tomAi.sendToLlm.standard'], ['template', 'tomAi.sendToLlm.template']]) {
            assert.ok(handler.includes(`${key}: '${c}'`), `handler lacks ${c}`);
            assert.ok(handler.includes(`registerCommand(SEND_TO_LLM_COMMANDS.${key}`), `handler does not register ${c}`);
        }
        assert.match(read('src/extension.ts'), /registerSendToLlmCommands\(context\)/);
    });
});
