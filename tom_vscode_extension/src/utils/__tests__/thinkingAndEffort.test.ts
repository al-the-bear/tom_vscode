/* eslint-disable @typescript-eslint/naming-convention -- Messages API wire fields (budget_tokens, output_config) */
/**
 * Thinking and effort per profile (src/utils/thinkingAndEffort.ts), as each
 * model family takes them, and the conversion of older profiles by the `_ai`
 * format migration (format version 3).
 *
 *   TE-1 Opus 5.5 / Fable 5.1: adaptive is `{type: 'adaptive'}`; off sends no thinking (it cannot be off) and says
 *        so; every effort level is `output_config.effort`; no budget_tokens ever
 *   TE-2 Opus 5: off is `{type: 'disabled'}` up to effort high, nothing (with a note) at xhigh / max
 *   TE-3 Opus 4.8 / Sonnet 5 / Opus 4.6: adaptive / disabled; xhigh is left out on 4.6 (with a note), max is sent
 *   TE-4 Haiku 4.5: adaptive is `{type: 'enabled', budget_tokens}` with the legacy budget (default 8192); no effort
 *   TE-5 nothing set: nothing sent, whatever the model
 *   TE-6 the Agent SDK options: the same decisions in its shape (`budgetTokens`, `effort`)
 *   TE-7 profiles: the current keys; an older profile's thinkingEnabled true reads as adaptive, false as absent
 *   TE-8 migrateProfileThinkingKeys: older keys replaced in place, the default budget dropped, a current profile untouched
 *   TE-9 the migration converts the workspace config's profiles, stamps format version 3, lists nothing on a second run
 *   TE-10 wiring: the direct request and its dump carry thinking and output_config, the Agent SDK query its
 *        thinking and effort options, the payload dump both, the profile editor the three fields
 */

import test, { describe } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import {
    agentSdkThinkingOptions,
    directThinkingFields,
    migrateProfileThinkingKeys,
    profileThinkingSettings,
    thinkingFamily,
} from '../thinkingAndEffort.js';
import { migrateAiFormats } from '../aiFormatMigration.js';
import { AI_FORMAT_VERSION, readAiFormatStamp } from '../aiFormatVersion.js';

describe('thinking and effort', () => {
    test('TE-1: Opus 5.5 and Fable 5.1 always think', () => {
        for (const model of ['claude-opus-5-5', 'claude-fable-5-1', 'claude-fable-5']) {
            assert.equal(thinkingFamily(model), 'alwaysOn', model);
            assert.deepEqual(directThinkingFields(model, { thinking: 'adaptive', effort: 'max' }), { thinking: { type: 'adaptive' }, output_config: { effort: 'max' }, notes: [] });
            const off = directThinkingFields(model, { thinking: 'off', legacyThinkingBudgetTokens: 4096 });
            assert.equal(off.thinking, undefined);
            assert.match(off.notes[0], /cannot be turned off/);
            assert.doesNotMatch(JSON.stringify(directThinkingFields(model, { thinking: 'adaptive', legacyThinkingBudgetTokens: 4096 })), /budget_tokens/);
        }
    });

    test('TE-2: Opus 5 can be turned off up to effort high', () => {
        assert.equal(thinkingFamily('claude-opus-5'), 'opus5');
        assert.deepEqual(directThinkingFields('claude-opus-5', { thinking: 'off', effort: 'high' }).thinking, { type: 'disabled' });
        const xhigh = directThinkingFields('claude-opus-5', { thinking: 'off', effort: 'xhigh' });
        assert.equal(xhigh.thinking, undefined);
        assert.deepEqual(xhigh.output_config, { effort: 'xhigh' });
        assert.match(xhigh.notes[0], /effort xhigh/);
    });

    test('TE-3: the 4.6 – 4.8 and Sonnet 5 models', () => {
        for (const model of ['claude-opus-4-8', 'claude-opus-4-7', 'claude-sonnet-5', 'claude-opus-4-6', 'claude-sonnet-4-6']) {
            assert.equal(thinkingFamily(model), 'adaptive', model);
            assert.deepEqual(directThinkingFields(model, { thinking: 'adaptive' }).thinking, { type: 'adaptive' });
            assert.deepEqual(directThinkingFields(model, { thinking: 'off' }).thinking, { type: 'disabled' });
        }
        assert.deepEqual(directThinkingFields('claude-opus-4-8', { effort: 'xhigh' }).output_config, { effort: 'xhigh' });
        const x = directThinkingFields('claude-opus-4-6', { effort: 'xhigh' });
        assert.equal(x.output_config, undefined);
        assert.match(x.notes[0], /effort xhigh is not taken/);
        assert.deepEqual(directThinkingFields('claude-opus-4-6', { effort: 'max' }).output_config, { effort: 'max' });
    });

    test('TE-4: Haiku 4.5 keeps the budget', () => {
        assert.equal(thinkingFamily('claude-haiku-4-5'), 'budget');
        assert.deepEqual(directThinkingFields('claude-haiku-4-5', { thinking: 'adaptive' }).thinking, { type: 'enabled', budget_tokens: 8192 });
        assert.deepEqual(directThinkingFields('claude-haiku-4-5', { thinking: 'adaptive', legacyThinkingBudgetTokens: 2048 }).thinking, { type: 'enabled', budget_tokens: 2048 });
        assert.equal(directThinkingFields('claude-haiku-4-5', { thinking: 'off' }).thinking, undefined);
        const e = directThinkingFields('claude-haiku-4-5', { effort: 'low' });
        assert.equal(e.output_config, undefined);
        assert.equal(e.notes.length, 1);
    });

    test('TE-5: nothing set, nothing sent', () => {
        for (const model of ['claude-opus-5-5', 'claude-opus-5', 'claude-opus-4-8', 'claude-haiku-4-5']) {
            assert.deepEqual(directThinkingFields(model, {}), { notes: [] });
            assert.deepEqual(agentSdkThinkingOptions(model, {}), { notes: [] });
        }
    });

    test('TE-6: the Agent SDK shape', () => {
        assert.deepEqual(agentSdkThinkingOptions('claude-opus-5-5', { thinking: 'adaptive', effort: 'high' }), { thinking: { type: 'adaptive' }, effort: 'high', notes: [] });
        assert.deepEqual(agentSdkThinkingOptions('claude-haiku-4-5', { thinking: 'adaptive' }).thinking, { type: 'enabled', budgetTokens: 8192 });
        assert.deepEqual(agentSdkThinkingOptions('claude-opus-4-8', { thinking: 'off' }).thinking, { type: 'disabled' });
    });

    test('TE-7: profile settings, current and older keys', () => {
        assert.deepEqual(profileThinkingSettings({ thinking: 'off', effort: 'low', legacyThinkingBudgetTokens: 2048 }), { thinking: 'off', effort: 'low', legacyThinkingBudgetTokens: 2048 });
        assert.deepEqual(profileThinkingSettings({ thinkingEnabled: true, thinkingBudgetTokens: 4096 }), { thinking: 'adaptive', legacyThinkingBudgetTokens: 4096 });
        assert.deepEqual(profileThinkingSettings({ thinkingEnabled: false }), {}, 'false sent no thinking parameter: the model default');
        assert.deepEqual(profileThinkingSettings({ effort: 'extreme' }), {});
    });

    test('TE-8: older profile keys replaced in place', () => {
        const next = migrateProfileThinkingKeys({ id: 'a', thinkingEnabled: true, thinkingBudgetTokens: 4096, maxRounds: 3 })!;
        assert.deepEqual(Object.keys(next), ['id', 'thinking', 'legacyThinkingBudgetTokens', 'maxRounds']);
        assert.deepEqual(migrateProfileThinkingKeys({ id: 'b', thinkingEnabled: false, thinkingBudgetTokens: 8192 }), { id: 'b' });
        assert.equal(migrateProfileThinkingKeys({ id: 'c', thinking: 'adaptive', effort: 'high' }), undefined);
    });

    test('TE-9: the migration converts the profiles', () => {
        const root = fs.mkdtempSync(path.join(os.tmpdir(), 'thinking-migration-'));
        const ai = path.join(root, '_ai');
        fs.mkdirSync(path.join(ai, 'quests', 'qa'), { recursive: true });
        const cfgPath = path.join(root, 'cfg.json');
        fs.writeFileSync(cfgPath, JSON.stringify({ anthropic: { profiles: [{ id: 'p1', thinkingEnabled: true }, { id: 'p2', thinkingEnabled: false }, { id: 'p3', effort: 'low' }] } }, null, 4) + '\n');
        const run = (apply: boolean) => migrateAiFormats({ aiRoot: ai, hostSlug: 'mbp', apply, merge: () => undefined, workspaceConfigPath: cfgPath, today: '2026-11-05' });
        const dry = run(false);
        assert.equal(dry.changes.filter((c) => c.step === 'profiles').length, 2);
        run(true);
        const cfg = JSON.parse(fs.readFileSync(cfgPath, 'utf8'));
        assert.deepEqual(cfg.anthropic.profiles, [{ id: 'p1', thinking: 'adaptive' }, { id: 'p2' }, { id: 'p3', effort: 'low' }]);
        assert.equal(readAiFormatStamp(ai)?.version, AI_FORMAT_VERSION);
        assert.ok(AI_FORMAT_VERSION >= 3);
        assert.deepEqual(run(false).changes, []);
    });

    test('TE-10: wiring', () => {
        const src = (rel: string) => fs.readFileSync(path.join(__dirname, '..', '..', '..', 'src', rel), 'utf8');
        const handler = src('handlers/anthropic-handler.ts');
        assert.equal(handler.match(/\.\.\.\(outputConfig \? \{ output_config: outputConfig \} : \{\}\),/g)?.length, 2, 'the request and its dump');
        assert.match(handler, /const thinkingFields = directThinkingFields\(configuration\.model, profileThinkingSettings\(/);
        assert.match(handler, /thinkingOptions: agentSdkThinkingOptions\(configuration\.model, /);
        assert.doesNotMatch(handler, /budget_tokens: profile\./);
        const transport = src('handlers/agent-sdk-transport.ts');
        assert.match(transport, /\{ thinking: params\.thinkingOptions\.thinking \}/);
        assert.match(transport, /\{ effort: params\.thinkingOptions\.effort \}/);
        assert.match(src('services/anthropicPayload.ts'), /- effort: \$\{effort \?\?/);
        const editor = src('handlers/globalTemplateEditor-handler.ts');
        for (const name of ['thinking', 'effort', 'legacyThinkingBudgetTokens']) { assert.match(editor, new RegExp(`name: '${name}', label:`)); }
        assert.doesNotMatch(editor, /name: 'thinkingEnabled'/);
    });
});
