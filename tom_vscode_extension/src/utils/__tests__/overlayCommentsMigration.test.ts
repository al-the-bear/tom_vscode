/**
 * The `_ai` format migration keeps a YAML config's own text (aiFormatMigration.ts editConfigFiles).
 *
 * The user overlay (`~/.tom/vscode/tom_vscode_extension.user.yaml`) may be YAML with comments. Every step that
 * edits it — templates, local-llm-keys, expressions, copilot-templates — writes only what it changed.
 *
 *   OC-1 a commented overlay keeps its comments, key order and untouched values as written, while the steps'
 *        changes are applied (the file decodes to the migrated config)
 *   OC-2 a block sequence written at its key's own indent stays so
 *   OC-3 a second run lists nothing and leaves the file as it is
 */

import test, { describe } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { parse } from 'yaml';
import { migrateAiFormats } from '../aiFormatMigration.js';

const OVERLAY = [
    '# My Tom AI overlay — kept by hand',
    '# second header line',
    '',
    'userName: me # who I am',
    '',
    '# the queue',
    'promptQueue:',
    '  defaultMessageTemplateId: explain-and-ask',
    '  # keep it short',
    '  responseTimeoutMinutes: 30',
    'localLlm:',
    '  # my old panel settings',
    '  ollamaUrl: http://localhost:11434',
    '  model: qwen3:8b',
    '  tools:',
    '    askCopilot:',
    '      enabled: true # on',
    'anthropic:',
    '  userMessageTemplates:',
    '  - id: mine',
    '    template: \'${{ vars["file.name"] || "(none)" }}\'',
    '  - id: other # untouched',
    '    template: plain',
    'favourites:',
    '- a',
    '- b',
    '',
].join('\n');

function sandbox() {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'overlay-comments-'));
    const ai = path.join(root, '_ai');
    fs.mkdirSync(path.join(ai, 'quests', 'qa'), { recursive: true });
    const cfg = path.join(root, 'cfg.json');
    fs.writeFileSync(cfg, '{}\n');
    const overlay = path.join(root, 'user.yaml');
    fs.writeFileSync(overlay, OVERLAY);
    const run = (apply: boolean) => migrateAiFormats({ aiRoot: ai, hostSlug: 'mbp', apply, merge: () => undefined, workspaceConfigPath: cfg, userConfigPath: overlay, today: '2026-11-10' });
    return { overlay, run };
}

describe('the migration keeps the overlay\'s own text', () => {
    test('OC-1 and OC-2: comments, order and untouched values kept; changes applied', () => {
        const s = sandbox();
        const listed = s.run(true).changes.filter((c) => c.detail.includes('user.yaml'));
        assert.deepEqual(listed.map((c) => c.step).sort(), ['expressions', 'local-llm-keys', 'templates'], 'three steps changed the overlay');
        const text = fs.readFileSync(s.overlay, 'utf8');
        assert.deepEqual(parse(text), {
            userName: 'me',
            promptQueue: { defaultMessageTemplateId: 'explain-todo', responseTimeoutMinutes: 30 },
            localLlm: { tools: { askCopilot: { enabled: true } } },
            anthropic: { userMessageTemplates: [{ id: 'mine', template: '${{ file.name || "(none)" }}' }, { id: 'other', template: 'plain' }] },
            favourites: ['a', 'b'],
        });
        for (const kept of [
            '# My Tom AI overlay — kept by hand\n# second header line\n',
            'userName: me # who I am\n',
            '# the queue\npromptQueue:\n',
            '  # keep it short\n  responseTimeoutMinutes: 30\n',
            '      enabled: true # on\n',
        ]) {
            assert.ok(text.includes(kept), `kept: ${JSON.stringify(kept)}\n--- file ---\n${text}`);
        }
        assert.ok(text.indexOf('userName') < text.indexOf('promptQueue') && text.indexOf('promptQueue') < text.indexOf('localLlm')
            && text.indexOf('localLlm') < text.indexOf('anthropic') && text.indexOf('anthropic') < text.indexOf('favourites'), 'key order kept');
        assert.ok(text.includes('favourites:\n- a\n- b\n'), `OC-2: the sequence at its key's indent\n${text}`);
        assert.doesNotMatch(text, /ollamaUrl|qwen3/, 'the removed keys are gone');
    });

    test('OC-3: a second run lists nothing and writes nothing', () => {
        const s = sandbox();
        s.run(true);
        const once = fs.readFileSync(s.overlay, 'utf8');
        const again = s.run(true).changes.filter((c) => c.detail.includes('user.yaml'));
        assert.deepEqual(again, []);
        assert.equal(fs.readFileSync(s.overlay, 'utf8'), once);
    });
});
