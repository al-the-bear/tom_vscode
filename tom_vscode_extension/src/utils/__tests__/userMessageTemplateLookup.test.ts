/**
 * The user-message templates (src/utils/userMessageTemplateLookup.ts), and the `_ai` format
 * migration's step that removes `copilot.templates` (format version 6).
 *
 *   CT-2 userMessageTemplateBody: by id or name from the one store; none for (None), __none__, the wrapper
 *        id and an unknown id; userMessageTemplateOptions lists id and label (name, else id)
 *   CT-3 fillTemplate fills ${userMessage} and ${originalPrompt}; a `$&` in the text stays literal
 *   CT-4 dropCopilotTemplates: templates and defaultTemplate removed, nothing copied (an own Answer
 *        Wrapper neither); the section's other keys stay; a config without them is untouched
 *   CT-5 the migration removes them from the workspace config (JSON) and the user overlay (YAML), stamps
 *        the format version, and lists nothing on a second run
 */

import test, { describe } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { parse } from 'yaml';

import {
    ANSWER_WRAPPER_ID,
    dropCopilotTemplates,
    fillTemplate,
    userMessageTemplateBody,
    userMessageTemplateOptions,
} from '../userMessageTemplateLookup.js';
import { migrateAiFormats } from '../aiFormatMigration.js';
import { AI_FORMAT_VERSION, readAiFormatStamp } from '../aiFormatVersion.js';

const STORE = {
    anthropic: {
        userMessageTemplates: [
            { id: 'execute-todo', name: 'Execute TODO', template: 'Do: ${userMessage}' },
            { id: 'plain', template: 'Plain ${originalPrompt}' },
        ],
    },
};

describe('User-message templates', () => {
    test('CT-2: the one store', () => {
        assert.equal(userMessageTemplateBody(STORE, 'execute-todo'), 'Do: ${userMessage}');
        assert.equal(userMessageTemplateBody(STORE, 'Execute TODO'), 'Do: ${userMessage}', 'by name');
        for (const none of [undefined, '', '(None)', '__none__', ANSWER_WRAPPER_ID, 'unknown']) {
            assert.equal(userMessageTemplateBody(STORE, none), undefined, String(none));
        }
        assert.deepEqual(userMessageTemplateOptions(STORE), [
            { id: 'execute-todo', label: 'Execute TODO' },
            { id: 'plain', label: 'plain' },
        ]);
        assert.deepEqual(userMessageTemplateOptions(null), []);
    });

    test('CT-3: filling', () => {
        assert.equal(fillTemplate('a ${userMessage} b ${originalPrompt}', 'X'), 'a X b X');
        assert.equal(fillTemplate('${userMessage}', 'cost $& more'), 'cost $& more');
    });

    test('CT-4: dropCopilotTemplates', () => {
        const own = { copilot: { templates: { [ANSWER_WRAPPER_ID]: { template: 'MINE ${originalPrompt}' }, Review: { template: 'r' } }, defaultTemplate: 'Review', answerFolder: 'f' } };
        const done = dropCopilotTemplates(own);
        assert.deepEqual(own, { copilot: { answerFolder: 'f' } }, 'the own Answer Wrapper is not copied');
        assert.equal(done.length, 2);
        assert.match(done.join('\n'), /1 template\(s\), not copied/);
        assert.match(done.join('\n'), /remove copilot\.defaultTemplate/);

        const set = { copilot: { queueWrapper: 'SET', templates: { [ANSWER_WRAPPER_ID]: { template: 'OTHER' } } } };
        assert.equal(dropCopilotTemplates(set).length, 1);
        assert.deepEqual(set, { copilot: { queueWrapper: 'SET' } }, 'another key of the section is kept');

        const clean = { copilot: { queueWrapper: 'SET' } };
        assert.deepEqual(dropCopilotTemplates(clean), []);
        assert.deepEqual(dropCopilotTemplates({}), []);
    });

    test('CT-5: the migration', () => {
        const root = fs.mkdtempSync(path.join(os.tmpdir(), 'copilot-templates-'));
        const ai = path.join(root, '_ai');
        fs.mkdirSync(path.join(ai, 'quests', 'qa'), { recursive: true });
        const cfg = path.join(root, 'cfg.json');
        const overlay = path.join(root, 'user.yaml');
        fs.writeFileSync(cfg, JSON.stringify({ userName: 'me', copilot: { templates: { [ANSWER_WRAPPER_ID]: { template: 'MINE ${originalPrompt}' }, Review: { template: 'r' } }, defaultTemplate: 'Review' } }, null, 2) + '\n');
        fs.writeFileSync(overlay, 'userName: me\ncopilot:\n  templates:\n    Explain:\n      template: e\n');
        const run = (apply: boolean) => migrateAiFormats({ aiRoot: ai, hostSlug: 'mbp', apply, merge: () => undefined, workspaceConfigPath: cfg, userConfigPath: overlay, today: '2026-11-05' });
        assert.ok(run(false).changes.filter((c) => c.step === 'copilot-templates').length >= 3);
        assert.match(fs.readFileSync(cfg, 'utf8'), /"templates"/, 'a dry run writes nothing');
        run(true);
        // Format version 11 (copilot-leftovers) removes what is left of the section.
        assert.deepEqual(JSON.parse(fs.readFileSync(cfg, 'utf8')), { userName: 'me' });
        assert.match(fs.readFileSync(cfg, 'utf8'), /^\{\n {2}"userName"/, 'indentation kept');
        assert.deepEqual(parse(fs.readFileSync(overlay, 'utf8')), { userName: 'me' });
        assert.equal(readAiFormatStamp(ai)?.version, AI_FORMAT_VERSION);
        assert.ok(AI_FORMAT_VERSION >= 6);
        assert.deepEqual(run(false).changes, []);
    });
});
