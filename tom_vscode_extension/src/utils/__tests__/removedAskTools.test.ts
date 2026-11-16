/**
 * The removed tools tomAi_askCopilot / tomAi_askBigBrother (vscimpb108): format version 8 cleans what still names
 * them (src/utils/removedAskTools.ts, the `removed-ask-tools` step of aiFormatMigration.ts).
 *
 *   RAT-1 a parsed config: `localLlm.tools` goes, and every list entry naming them (current and old `tom_ask…`
 *         names, at any depth: profiles', configurations', the MCP server's `enabledTools`); other entries stay;
 *         a second pass does nothing
 *   RAT-2 a YAML document: the entries go, comments and the other entries stay
 *   RAT-3 the migration: the workspace config and the user overlay, a quest's extension_config and a role type
 *         are listed, then written; the stamp becomes the build's version (8 or later); a second run lists nothing for the step
 *   RAT-4 nothing registers or lists the tools any more: the registry, the tool categories, the default tool
 *         list, package.json, the Status Page; the Status Page keeps the Copilot answer folder
 */

import test, { describe } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { parseDocument } from 'yaml';

import { dropAskToolNamesFromYaml, dropAskToolSettings, REMOVED_ASK_TOOLS_FORMAT_VERSION } from '../removedAskTools.js';
import { migrateAiFormats } from '../aiFormatMigration.js';
import { AI_FORMAT_VERSION, readAiFormatStamp } from '../aiFormatVersion.js';

const EXT = path.resolve(__dirname, '..', '..', '..');
const read = (rel: string): string => fs.readFileSync(path.join(EXT, rel), 'utf8');

describe('removed tools tomAi_askCopilot / tomAi_askBigBrother', () => {
    test('RAT-1: a parsed config', () => {
        const cfg = {
            localLlm: { configurations: [{ id: 'mac', enabledTools: ['tomAi_readFile', 'tomAi_askCopilot'] }], tools: { askCopilot: { enabled: true }, askBigBrother: {} } },
            anthropic: { profiles: [{ id: 'p', enabledTools: ['tomAi_askBigBrother', 'tomAi_readFile', 'tom_askCopilot'] }] },
            other: ['tom_askBigBrother', 'tomAi_askUser'],
        };
        const done = dropAskToolSettings(cfg);
        assert.deepEqual(done, ['remove localLlm.tools (the askCopilot / askBigBrother settings)', 'remove tomAi_askCopilot / tomAi_askBigBrother from the tool lists, 4 entries']);
        assert.deepEqual(cfg, {
            localLlm: { configurations: [{ id: 'mac', enabledTools: ['tomAi_readFile'] }] },
            anthropic: { profiles: [{ id: 'p', enabledTools: ['tomAi_readFile'] }] },
            other: ['tomAi_askUser'],
        });
        assert.deepEqual(dropAskToolSettings(cfg), [], 'nothing left');
    });

    test('RAT-2: a YAML document keeps its comments', () => {
        const text = 'mcpServer:\n  # the tools it serves\n  enabledTools:\n    - tomAi_readFile\n    - tomAi_askBigBrother\n    - tomAi_askCopilot # gone\n';
        const doc = parseDocument(text);
        assert.equal(dropAskToolNamesFromYaml(doc), 2);
        assert.equal(doc.toString({ indentSeq: true }), 'mcpServer:\n  # the tools it serves\n  enabledTools:\n    - tomAi_readFile\n');
    });

    test('RAT-3: the migration', () => {
        assert.ok(AI_FORMAT_VERSION >= REMOVED_ASK_TOOLS_FORMAT_VERSION, 'a build at or after the step');
        const root = fs.mkdtempSync(path.join(os.tmpdir(), 'removed-ask-tools-'));
        const ai = path.join(root, '_ai');
        const put = (rel: string, text: string): void => { const p = path.join(ai, rel); fs.mkdirSync(path.dirname(p), { recursive: true }); fs.writeFileSync(p, text); };
        put('quests/qa/extension_config.qa.yaml', 'mcpServer:\n  enabledTools:\n    - tomAi_readFile\n    - tomAi_askCopilot\n');
        put('role-types/coder/role-type.yaml', 'tools:\n  mode: select\n  selected:\n    - tomAi_applyEdit\n    - tomAi_askBigBrother\n');
        const cfg = path.join(root, 'cfg.json');
        fs.writeFileSync(cfg, JSON.stringify({ localLlm: { configurations: [{ id: 'mac' }], tools: { askCopilot: { enabled: true } } } }, null, 4) + '\n');
        const overlay = path.join(root, 'overlay.json');
        fs.writeFileSync(overlay, JSON.stringify({ anthropic: { profiles: [{ id: 'x', enabledTools: ['tom_askCopilot', 'tomAi_readFile'] }] } }, null, 4) + '\n');
        try {
            const run = (apply: boolean) => migrateAiFormats({ aiRoot: ai, hostSlug: 'mbp', apply, merge: () => undefined, workspaceConfigPath: cfg, userConfigPath: overlay, today: '2026-11-15' });
            const listed = run(false).changes.filter((c) => c.step === 'removed-ask-tools').map((c) => c.detail);
            assert.equal(listed.length, 4, listed.join('\n'));
            assert.ok(listed.some((d) => /cfg\.json: remove localLlm\.tools/.test(d)));
            assert.ok(listed.some((d) => /overlay\.json: remove tomAi_askCopilot \/ tomAi_askBigBrother from the tool lists, 1 entry/.test(d)));
            assert.ok(listed.includes('quests/qa/extension_config.qa.yaml: remove tomAi_askCopilot / tomAi_askBigBrother, 1 entry'));
            assert.ok(listed.includes('role-types/coder/role-type.yaml: remove tomAi_askCopilot / tomAi_askBigBrother, 1 entry'));
            assert.match(fs.readFileSync(cfg, 'utf8'), /"tools"/, 'a listing writes nothing');
            const applied = run(true);
            assert.deepEqual(applied.problems, []);
            assert.deepEqual(JSON.parse(fs.readFileSync(cfg, 'utf8')), { localLlm: { configurations: [{ id: 'mac' }] } });
            assert.deepEqual(JSON.parse(fs.readFileSync(overlay, 'utf8')), { anthropic: { profiles: [{ id: 'x', enabledTools: ['tomAi_readFile'] }] } });
            assert.equal(fs.readFileSync(path.join(ai, 'quests/qa/extension_config.qa.yaml'), 'utf8'), 'mcpServer:\n  enabledTools:\n    - tomAi_readFile\n');
            assert.equal(fs.readFileSync(path.join(ai, 'role-types/coder/role-type.yaml'), 'utf8'), 'tools:\n  mode: select\n  selected:\n    - tomAi_applyEdit\n');
            assert.equal(readAiFormatStamp(ai)?.version, AI_FORMAT_VERSION);
            assert.deepEqual(run(false).changes.filter((c) => c.step === 'removed-ask-tools'), [], 'idempotent');
        } finally {
            fs.rmSync(root, { recursive: true, force: true });
        }
    });

    test('RAT-4: nothing registers or lists them', () => {
        const pattern = /tomAi_askCopilot|tomAi_askBigBrother|tom_askCopilot|tom_askBigBrother/;
        for (const rel of ['src/tools/tool-executors.ts', 'src/utils/toolCategories.ts', 'src/utils/constants.ts', 'package.json', 'src/handlers/statusPage-handler.ts', 'media/statusPage/listeners.js', 'src/handlers/sendToChatRouter.ts', 'src/config/tom_vscode_extension.schema.json']) {
            assert.doesNotMatch(read(rel), pattern, rel);
        }
        assert.equal(fs.existsSync(path.join(EXT, 'src/tools/ask-copilot-tool.ts')), false);
        assert.equal(fs.existsSync(path.join(EXT, 'src/tools/ask-big-brother-tool.ts')), false);
        assert.equal(fs.existsSync(path.join(EXT, 'src/tools/local-llm-tools-config.ts')), false);
        const page = read('src/handlers/statusPage-handler.ts');
        assert.doesNotMatch(page, /askCopilot|askBigBrother|AskCopilot|AskBigBrother/);
        assert.match(page, /data-collapse="copilotAnswers"[\s\S]*id="sp-copilot-answerFolder"[\s\S]*data-status-action="updateCopilotAnswerFolder"/);
        assert.match(page, /case 'updateCopilotAnswerFolder':\n\s+await updateCopilotAnswerFolder\(message\.settings \|\| \{\}\);/);
        assert.match(read('media/statusPage/listeners.js'), /action === 'updateCopilotAnswerFolder'[\s\S]*getElementById\('sp-copilot-answerFolder'\)/);
        assert.doesNotMatch(read('src/utils/sendToChatConfig.ts'), /askCopilot|askBigBrother/);
    });
});
