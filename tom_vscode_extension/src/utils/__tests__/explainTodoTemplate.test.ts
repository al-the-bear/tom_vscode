/**
 * The Explain-then-ask template renamed Explain TODO (src/utils/explainTodoTemplate.ts)
 * and the `_ai` format migration's rename (format version 4).
 *
 *   ET-1 renameExplainTemplate: the old entry becomes Explain TODO (keeping isDefault), every setting naming the
 *        old id names the new one, other templates are untouched; an Explain TODO already there is kept and the
 *        old entry dropped
 *   ET-2 the migration renames it in the workspace config (JSON) and the user overlay (YAML), stamps format
 *        version 4, and lists nothing on a second run
 */

import test, { describe } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { parse } from 'yaml';

import { EXPLAIN_TODO_USER_MESSAGE_TEMPLATE_BODY, renameExplainTemplate } from '../explainTodoTemplate.js';
import { migrateAiFormats } from '../aiFormatMigration.js';
import { AI_FORMAT_VERSION, readAiFormatStamp } from '../aiFormatVersion.js';

const OLD = { id: 'explain-and-ask', name: 'Explain-then-ask scaffold', template: 'Before you begin ...\n\n${userMessage}', isDefault: true };

describe('Explain TODO', () => {
    test('ET-1: the rename', () => {
        const { config, changed } = renameExplainTemplate({
            anthropic: { userMessageTemplates: [{ id: 'execute-todo' }, OLD], defaultTemplateId: 'explain-and-ask' },
            timed: [{ template: 'explain-and-ask' }, { template: 'execute-todo' }],
        }) as { config: { anthropic: { userMessageTemplates: Array<Record<string, unknown>>; defaultTemplateId: string }; timed: Array<{ template: string }> }; changed: number };
        assert.equal(changed, 3);
        assert.deepEqual(config.anthropic.userMessageTemplates.map((t) => t.id), ['execute-todo', 'explain-todo']);
        const entry = config.anthropic.userMessageTemplates[1];
        assert.equal(entry.name, 'Explain TODO');
        assert.equal(entry.template, EXPLAIN_TODO_USER_MESSAGE_TEMPLATE_BODY);
        assert.equal(entry.isDefault, true, 'a default stays the default');
        assert.equal(config.anthropic.defaultTemplateId, 'explain-todo');
        assert.deepEqual(config.timed.map((x) => x.template), ['explain-todo', 'execute-todo']);
        const both = renameExplainTemplate({ anthropic: { userMessageTemplates: [{ id: 'explain-todo', name: 'mine' }, OLD] } }).config as { anthropic: { userMessageTemplates: Array<Record<string, unknown>> } };
        assert.deepEqual(both.anthropic.userMessageTemplates, [{ id: 'explain-todo', name: 'mine' }], 'an Explain TODO already seeded is kept');
        assert.equal(renameExplainTemplate({ a: 'b' }).changed, 0);
    });

    test('ET-2: the migration renames it in the workspace config and the overlay', () => {
        const root = fs.mkdtempSync(path.join(os.tmpdir(), 'explain-todo-'));
        const ai = path.join(root, '_ai');
        fs.mkdirSync(path.join(ai, 'quests', 'qa'), { recursive: true });
        const cfg = path.join(root, 'cfg.json');
        const overlay = path.join(root, 'user.yaml');
        fs.writeFileSync(cfg, JSON.stringify({ anthropic: { userMessageTemplates: [OLD] } }, null, 4) + '\n');
        fs.writeFileSync(overlay, 'promptQueue:\n  defaultMessageTemplateId: explain-and-ask\n');
        const run = (apply: boolean) => migrateAiFormats({ aiRoot: ai, hostSlug: 'mbp', apply, merge: () => undefined, workspaceConfigPath: cfg, userConfigPath: overlay, today: '2026-11-05' });
        assert.equal(run(false).changes.filter((c) => c.step === 'templates').length, 2);
        run(true);
        assert.equal(JSON.parse(fs.readFileSync(cfg, 'utf8')).anthropic.userMessageTemplates[0].id, 'explain-todo');
        assert.equal(parse(fs.readFileSync(overlay, 'utf8')).promptQueue.defaultMessageTemplateId, 'explain-todo');
        assert.equal(readAiFormatStamp(ai)?.version, AI_FORMAT_VERSION);
        assert.ok(AI_FORMAT_VERSION >= 4);
        assert.deepEqual(run(false).changes, []);
    });
});
