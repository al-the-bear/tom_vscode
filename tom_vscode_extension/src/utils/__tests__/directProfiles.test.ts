/**
 * The workspace's direct and Local LLM profiles (dapieff14, DA-9, DA-12, DA-21):
 * the direct-API hints file in their system prompt, Effort high on the direct
 * todo profiles — checked in the payload dump a direct request writes, built
 * here with the handler's own steps (no API call: placeholders resolved as
 * buildSystemSegments does, thinking/effort as the direct leaf sends them,
 * buildPayloadDump).
 *
 *   DP-1 every direct and Local LLM profile with a system prompt names `${file-CLAUDE-direct.md}`, after
 *        `${claudeMd}` (CLAUDE.md as Claude Code loads it, CC-14) where it has them, and none the older
 *        `${instructions}`; the four `<model>-direct` todo profiles set effort `high`
 *   DP-2 the payload dump of opus-5-5-direct: the system prompt holds CLAUDE.md and then CLAUDE-direct.md,
 *        and the dump's effort line reads `high`
 */

import test, { describe } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'fs';
import * as path from 'path';

import { installVscodeStub } from '../../tools/__tests__/_vscode-stub.js';

const WORKSPACE = path.resolve(__dirname, '..', '..', '..', '..', '..', '..');
installVscodeStub({ workspaceFolders: [WORKSPACE] });

import { resolveVariables, unescapePlaceholders } from '../variableResolver.js';
import { directThinkingFields, profileThinkingSettings } from '../thinkingAndEffort.js';
import { buildPayloadDump } from '../../services/anthropicPayload.js';

interface Profile { id: string; configurationId?: string; systemPrompt?: string; effort?: string }
const CONFIG = JSON.parse(fs.readFileSync(path.join(WORKSPACE, '.tom', 'tom_vscode_extension.json'), 'utf8'));
const CONFIGS = new Map<string, { transport?: string; model?: string }>((CONFIG.anthropic.configurations as Array<{ id: string; transport?: string; model?: string }>).map((c) => [c.id, c] as const));
const LOCAL = new Set<string>(((CONFIG.localLlm?.configurations ?? []) as Array<{ id: string }>).map((c) => c.id));
const PROFILES = CONFIG.anthropic.profiles as Profile[];
const transportOf = (p: Profile): string | undefined => {
    const id = p.configurationId ?? '';
    if (CONFIGS.has(id)) { return CONFIGS.get(id)!.transport ?? 'direct'; }
    return LOCAL.has(id) ? 'localLlm' : undefined;
};
const HINTS = '${file-CLAUDE-direct.md}';
const TODO_PROFILES = ['sonnet-5-5-direct', 'opus-5-5-direct', 'fable-5-1-direct', 'haiku-5-5-direct'];

describe('the direct and Local LLM profiles', () => {
    test('DP-1: the hints file and the effort', () => {
        const withPrompt = PROFILES.filter((p) => ['direct', 'localLlm'].includes(transportOf(p) ?? '') && (p.systemPrompt ?? '').trim());
        assert.ok(withPrompt.length >= 8);
        for (const p of withPrompt) {
            const sp = p.systemPrompt!;
            assert.ok(sp.includes(HINTS), `${p.id}: no ${HINTS}`);
            assert.ok(!sp.includes('${instructions}'), `${p.id}: \${claudeMd} loads CLAUDE.md as Claude Code does`);
            if (sp.includes('${claudeMd}')) { assert.ok(sp.indexOf(HINTS) > sp.indexOf('${claudeMd}'), `${p.id}: the hints come after the instructions`); }
        }
        for (const p of PROFILES.filter((x) => transportOf(x) === 'agentSdk')) {
            assert.ok(!(p.systemPrompt ?? '').includes(HINTS), `${p.id}: the Agent SDK has its own tools`);
        }
        for (const id of TODO_PROFILES) {
            assert.equal(PROFILES.find((p) => p.id === id)?.effort, 'high', id);
        }
    });

    test('DP-2: the payload dump of a direct request', () => {
        const profile = PROFILES.find((p) => p.id === 'opus-5-5-direct')!;
        const configuration = { id: profile.configurationId, name: 'c', maxTokens: 64000, maxRounds: 10, ...CONFIGS.get(profile.configurationId!) };
        const systemPrompt = unescapePlaceholders(resolveVariables(profile.systemPrompt!, { values: { toolHistory: '' } }));
        const claude = fs.readFileSync(path.join(WORKSPACE, 'CLAUDE.md'), 'utf8').trim().split('\n')[0];
        const direct = fs.readFileSync(path.join(WORKSPACE, 'CLAUDE-direct.md'), 'utf8').trim().split('\n')[0];
        assert.equal(direct, '# Working on the direct API');
        assert.ok(systemPrompt.includes(claude), 'the instructions');
        assert.ok(systemPrompt.includes(`Contents of ${path.join(WORKSPACE, 'CLAUDE.md')} (project instructions):`), 'as Claude Code loads it');
        assert.ok(systemPrompt.indexOf(direct) > systemPrompt.indexOf(claude), 'then the hints file');
        assert.ok(!systemPrompt.includes(HINTS), 'resolved');
        const thinking = directThinkingFields(configuration.model ?? '', profileThinkingSettings(profile as unknown as Record<string, unknown>));
        assert.equal(thinking.output_config?.effort, 'high');
        const dump = buildPayloadDump({
            requestId: 'r', transport: 'direct', configuration: configuration as never, profile: profile as never, systemPrompt,
            tools: [], history: [], userContent: 'u', effectiveCaching: true, thinking,
        });
        assert.match(dump, /^- effort: high$/m);
        assert.ok(dump.includes('# Working on the direct API'), 'the dump shows the hints in the system prompt');
    });
});
