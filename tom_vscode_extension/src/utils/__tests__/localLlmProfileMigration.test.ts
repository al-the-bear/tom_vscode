/**
 * The removed panels' part of the `_ai` format migration
 * (src/utils/localLlmProfileMigration.ts, aiFormatMigration.ts; format version 5).
 *
 *   LP-1 a Local LLM profile becomes an Anthropic profile `local-<key>` on the configuration it names, else the
 *        Local LLM's default: system prompt, tools (all, a subset, none), maxRounds, historyMode and memory carried;
 *        temperature, result template and suffixes named as dropped
 *   LP-2 the migration adds the profiles, removes `localLlm.profiles`, keeps an Anthropic profile already there,
 *        and a second run lists nothing
 *   LP-3 below format version 5 the removed panels' files are deleted — Local LLM histories, live-trail-localLLM,
 *        the localllm-* trail pairs, `_ai/trail/localllm`, `_ai/trail/local_llm`, the AI Conversation results and
 *        logs — and the Anthropic history, sessions and trails stay; a dry run deletes nothing
 *   LP-4 from format version 5 on nothing is deleted (the Anthropic profiles on Local LLM configurations write
 *        `_ai/trail/localllm` again)
 *   LP-5 the removed panels' config goes: `tomAiChat`, `aiConversation` but its `telegram` block,
 *        `localLlm.expansionProfile`; the Local LLM configurations stay
 */

/* eslint-disable @typescript-eslint/naming-convention -- config keys as they are written */
import test, { describe } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { dropRemovedPanelSections, localLlmProfileToAnthropic, localProfileId } from '../localLlmProfileMigration.js';
import { migrateAiFormats } from '../aiFormatMigration.js';
import { AI_FORMAT_VERSION, readAiFormatStamp, writeAiFormatStamp } from '../aiFormatVersion.js';

function sandbox() {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'local-llm-migration-'));
    const ai = path.join(root, '_ai');
    const write = (rel: string, text: string) => {
        const p = path.join(ai, rel);
        fs.mkdirSync(path.dirname(p), { recursive: true });
        fs.writeFileSync(p, text);
    };
    const exists = (rel: string) => fs.existsSync(path.join(ai, rel));
    fs.mkdirSync(path.join(ai, 'quests', 'qa'), { recursive: true });
    const cfg = path.join(root, 'cfg.json');
    const run = (apply: boolean) => migrateAiFormats({ aiRoot: ai, hostSlug: 'mbp', apply, merge: () => undefined, workspaceConfigPath: cfg, today: '2026-11-05' });
    return { ai, cfg, write, exists, run };
}

const CONFIG = {
    anthropic: { profiles: [{ id: 'opus-5-5-direct', name: 'Opus', configurationId: 'opus-5-5-direct' }, { id: 'local-rewrite', name: 'mine' }] },
    localLlm: {
        configurations: [{ id: 'mac' }, { id: 'other', isDefault: true }],
        profiles: {
            direct: { label: 'Send to LLM', systemPrompt: 'S', resultTemplate: '${response}', temperature: 0.4, modelConfig: null, isDefault: true, toolsEnabled: true, maxRounds: 400 },
            'My Testtemplate': { label: 'Test Template', systemPrompt: null, toolsEnabled: false, modelConfig: 'mac' },
            rewrite: { label: 'Rewrite', systemPrompt: 'R' },
        },
    },
};

describe('removed panels: Local LLM profiles and files', () => {
    test('LP-1: one profile', () => {
        assert.equal(localProfileId('My Testtemplate'), 'local-my-testtemplate');
        const { profile, dropped } = localLlmProfileToAnthropic('direct', { label: 'Send to LLM', systemPrompt: 'S', temperature: 0.4, resultTemplate: 'x${response}', isDefault: true, maxRounds: 400, historyMode: 'trim_and_summary', historySuffix: 'h', autoInjectMemory: true }, 'mac');
        assert.deepEqual(profile, {
            id: 'local-direct', name: 'Send to LLM (Local LLM)', description: 'Migrated from the Local LLM profile "direct".',
            systemPrompt: 'S', configurationId: 'mac', toolsEnabled: true, maxRounds: 400, historyMode: 'trim_and_summary', autoInjectMemory: true,
        });
        assert.deepEqual(dropped, ['temperature 0.4', 'resultTemplate', 'historySuffix h', 'isDefault']);
        assert.deepEqual(localLlmProfileToAnthropic('k', { enabledTools: ['tomAi_readFile'] }, 'mac').profile.enabledTools, ['tomAi_readFile']);
        const none = localLlmProfileToAnthropic('k', { toolsEnabled: false }, 'mac').profile;
        assert.equal(none.toolsEnabled, false);
        assert.deepEqual(none.enabledTools, []);
    });

    test('LP-2: the profiles in the config', () => {
        const s = sandbox();
        fs.writeFileSync(s.cfg, JSON.stringify(CONFIG, null, 2) + '\n');
        const dry = s.run(false);
        assert.equal(dry.changes.filter((c) => c.step === 'local-llm-profiles').length, 4);
        assert.deepEqual(JSON.parse(fs.readFileSync(s.cfg, 'utf8')), CONFIG, 'a dry run writes nothing');
        s.run(true);
        const cfg = JSON.parse(fs.readFileSync(s.cfg, 'utf8'));
        assert.equal(cfg.localLlm.profiles, undefined);
        assert.deepEqual(cfg.localLlm.configurations, CONFIG.localLlm.configurations);
        const byId = Object.fromEntries(cfg.anthropic.profiles.map((p: { id: string }) => [p.id, p]));
        assert.equal(byId['local-direct'].configurationId, 'other', 'no modelConfig: the default configuration');
        assert.equal(byId['local-my-testtemplate'].configurationId, 'mac');
        assert.equal(byId['local-my-testtemplate'].systemPrompt, '');
        assert.equal(byId['local-rewrite'].name, 'mine', 'an Anthropic profile already there is kept');
        assert.equal(cfg.anthropic.profiles.length, 4);
        assert.equal(readAiFormatStamp(s.ai)?.version, AI_FORMAT_VERSION);
        assert.ok(AI_FORMAT_VERSION >= 5);
        assert.deepEqual(s.run(false).changes, []);
    });

    test('LP-3: the removed panels\' files go below version 5', () => {
        const s = sandbox();
        const gone = ['quests/qa/live-trail-localLLM.md', 'quests/qa/history/history-gemma4.json', 'quests/qa/history/history-gemma4.md',
            'quests/qa/history/qa.localllm-mac.prompts.md', 'quests/qa/history/qa.localllm-mac.answers.md',
            'trail/localllm/qa/last_request.json', 'trail/local_llm/qa.trail.md', 'ai_conversation/current.result.md', 'trail/ai_conversation/log.md'];
        // (The per-quest history.json of the older layout is moved into the default session by the storage step.)
        const kept = ['quests/qa/history/sessions/default/history.json', 'quests/qa/history/sessions/default/live-trail.md',
            'trail/anthropic/qa/last_request.json', 'quests/qa/history/qa.copilot.prompts.md'];
        for (const rel of [...gone, ...kept]) { s.write(rel, 'x'); }
        writeAiFormatStamp(s.ai, { version: 4, date: '2026-11-05' });
        const dry = s.run(false);
        assert.equal(dry.changes.filter((c) => c.step === 'removed-panels').length, 9);
        assert.ok(gone.every((rel) => s.exists(rel)), 'a dry run deletes nothing');
        s.run(true);
        for (const rel of gone) { assert.equal(s.exists(rel), false, rel); }
        for (const rel of kept) { assert.ok(s.exists(rel), rel); }
        assert.deepEqual(s.run(false).changes, []);
    });

    test('LP-4: nothing deleted from version 5 on', () => {
        const s = sandbox();
        s.write('trail/localllm/qa/last_request.json', 'x');
        s.write('quests/qa/history/history-gemma4.json', 'x');
        writeAiFormatStamp(s.ai, { version: 5, date: '2026-11-05' });
        assert.deepEqual(s.run(true).changes.filter((c) => c.step === 'removed-panels'), []);
        assert.ok(s.exists('trail/localllm/qa/last_request.json'));
        assert.ok(s.exists('quests/qa/history/history-gemma4.json'));
    });

    test('LP-5: the removed panels\' config sections', () => {
        const cfg: Record<string, unknown> = {
            tomAiChat: { templates: {} },
            aiConversation: { maxTurns: 10, setups: [], profiles: {}, telegram: { autostart: true } },
            localLlm: { expansionProfile: 'expand', configurations: [{ id: 'mac' }] },
            copilot: {},
        };
        assert.deepEqual(dropRemovedPanelSections(cfg), ['tomAiChat', 'aiConversation.maxTurns', 'aiConversation.setups', 'aiConversation.profiles', 'localLlm.expansionProfile']);
        assert.deepEqual(cfg, { aiConversation: { telegram: { autostart: true } }, localLlm: { configurations: [{ id: 'mac' }] }, copilot: {} });
        assert.deepEqual(dropRemovedPanelSections(cfg), [], 'nothing left to remove');
        const noTelegram: Record<string, unknown> = { aiConversation: { setups: [] } };
        dropRemovedPanelSections(noTelegram);
        assert.deepEqual(noTelegram, {});
        const s = sandbox();
        fs.writeFileSync(s.cfg, JSON.stringify({ tomAiChat: {}, localLlm: { configurations: [{ id: 'mac' }] } }, null, 2) + '\n');
        assert.ok(s.run(false).changes.some((c) => c.step === 'removed-panels' && /tomAiChat/.test(c.detail)));
        s.run(true);
        assert.deepEqual(JSON.parse(fs.readFileSync(s.cfg, 'utf8')), { localLlm: { configurations: [{ id: 'mac' }] } });
    });
});
