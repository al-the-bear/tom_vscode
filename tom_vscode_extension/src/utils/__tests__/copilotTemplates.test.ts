/**
 * The templates of a Copilot send and the Copilot Queue Wrapper
 * (src/utils/copilotTemplates.ts), and the `_ai` format migration's step that
 * removes `copilot.templates` (format version 6).
 *
 *   CT-1 copilotQueueWrapper: the configured wrapper, else (missing or blank) the default
 *   CT-2 userMessageTemplateBody: by id or name from the one store; none for (None), __none__, the wrapper
 *        id and an unknown id; userMessageTemplateOptions lists id and label (name, else id)
 *   CT-3 fillTemplate fills ${userMessage} and ${originalPrompt}; fillWrapper only ${originalPrompt};
 *        a `$&` in the text stays literal
 *   CT-4 dropCopilotTemplates: templates and defaultTemplate removed, nothing copied; an own Answer
 *        Wrapper becomes queueWrapper (the default one does not; a set queueWrapper is kept); a config
 *        without them is untouched
 *   CT-5 the migration removes them from the workspace config (JSON) and the user overlay (YAML), stamps
 *        format version 6, and lists nothing on a second run
 */

import test, { describe } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { parse } from 'yaml';

import {
    ANSWER_WRAPPER_ID,
    DEFAULT_ANSWER_FILE_TEMPLATE,
    copilotQueueWrapper,
    dropCopilotTemplates,
    fillTemplate,
    fillWrapper,
    userMessageTemplateBody,
    userMessageTemplateOptions,
} from '../copilotTemplates.js';
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

describe('Copilot templates', () => {
    test('CT-1: the queue wrapper', () => {
        assert.equal(copilotQueueWrapper(undefined), DEFAULT_ANSWER_FILE_TEMPLATE);
        assert.equal(copilotQueueWrapper({ copilot: { queueWrapper: '   ' } }), DEFAULT_ANSWER_FILE_TEMPLATE);
        assert.equal(copilotQueueWrapper({ copilot: { queueWrapper: 'W ${originalPrompt}' } }), 'W ${originalPrompt}');
    });

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
        assert.equal(fillWrapper('${userMessage} / ${originalPrompt}', 'X'), '${userMessage} / X');
        assert.equal(fillTemplate('${userMessage}', 'cost $& more'), 'cost $& more');
    });

    test('CT-4: dropCopilotTemplates', () => {
        const own = { copilot: { templates: { [ANSWER_WRAPPER_ID]: { template: 'MINE ${originalPrompt}' }, Review: { template: 'r' } }, defaultTemplate: 'Review', answerFolder: 'f' } };
        const done = dropCopilotTemplates(own);
        assert.deepEqual(own, { copilot: { answerFolder: 'f', queueWrapper: 'MINE ${originalPrompt}' } });
        assert.equal(done.length, 3);
        assert.match(done.join('\n'), /1 template\(s\), not copied/);

        const stock = { copilot: { templates: { [ANSWER_WRAPPER_ID]: { template: DEFAULT_ANSWER_FILE_TEMPLATE } } } };
        dropCopilotTemplates(stock);
        assert.deepEqual(stock, { copilot: {} }, 'the default wrapper is not copied');

        const set = { copilot: { queueWrapper: 'SET', templates: { [ANSWER_WRAPPER_ID]: { template: 'OTHER' } } } };
        dropCopilotTemplates(set);
        assert.deepEqual(set, { copilot: { queueWrapper: 'SET' } }, 'a set queueWrapper is kept');

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
        fs.writeFileSync(cfg, JSON.stringify({ copilot: { templates: { [ANSWER_WRAPPER_ID]: { template: 'MINE ${originalPrompt}' }, Review: { template: 'r' } }, defaultTemplate: 'Review' } }, null, 2) + '\n');
        fs.writeFileSync(overlay, 'copilot:\n  templates:\n    Explain:\n      template: e\n');
        const run = (apply: boolean) => migrateAiFormats({ aiRoot: ai, hostSlug: 'mbp', apply, merge: () => undefined, workspaceConfigPath: cfg, userConfigPath: overlay, today: '2026-11-05' });
        assert.ok(run(false).changes.filter((c) => c.step === 'copilot-templates').length >= 3);
        assert.match(fs.readFileSync(cfg, 'utf8'), /"templates"/, 'a dry run writes nothing');
        run(true);
        assert.deepEqual(JSON.parse(fs.readFileSync(cfg, 'utf8')), { copilot: { queueWrapper: 'MINE ${originalPrompt}' } });
        assert.match(fs.readFileSync(cfg, 'utf8'), /^\{\n {2}"copilot"/, 'indentation kept');
        assert.deepEqual(parse(fs.readFileSync(overlay, 'utf8')), { copilot: {} });
        assert.equal(readAiFormatStamp(ai)?.version, AI_FORMAT_VERSION);
        assert.ok(AI_FORMAT_VERSION >= 6);
        assert.deepEqual(run(false).changes, []);
    });
});
