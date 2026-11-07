/* eslint-disable @typescript-eslint/naming-convention -- Messages API wire fields */
/**
 * Server-side clearing of old tool results on the direct transport (dapieff5,
 * DA-1 (b), DA-15 (a)): src/utils/serverToolClearing.ts, the beta path of
 * src/services/anthropicMessageCall.ts and the direct loop.
 *
 *   SC-1 the conversions: characters to tokens (÷ 4, up), a response's whole prompt (input + cache read + write)
 *   SC-2 the setting mapping: trigger = the first prompt + toolTrailCollapseChars in tokens; keep = the tool uses of
 *        the newest toolTrailKeepRounds rounds; clear_at_least = collapseChars − keepRounds × maxResultChars in
 *        tokens; tomAi_readPastToolResult excluded; a configuration's overrides change the numbers
 *   SC-3 when: only once the conversation holds a thinking block and the first prompt is known; the request
 *        carries the beta header and context_management with the API's types
 *   SC-4 the call: a request with betas goes through client.beta.messages.stream with its fields; one without
 *        through client.messages.stream without them; betas on a client without a beta surface are refused
 *   SC-5 what the server cleared becomes a live-trail notice; nothing cleared, no notice
 *   SC-6 the direct loop: clearing computed per request from the retention caps, the first prompt taken from
 *        the first response, the notice written; the client-side collapse is left to conversations without thinking
 */

import test, { describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type Anthropic from '@anthropic-ai/sdk';

import {
    CHARS_PER_TOKEN, CLEAR_TOOL_USES_EDIT, CONTEXT_MANAGEMENT_BETA, appliedClearingNotice, charsToTokens, clearToolUsesEdit,
    promptTokensOf, serverToolClearing, toolUsesOfNewestRounds,
} from '../serverToolClearing.js';
import { RETENTION_DEFAULTS, resolveRetentionCaps } from '../../services/toolTrailRetention.js';
import { createMessageStreamed, type MessageStreamingClient } from '../../services/anthropicMessageCall.js';

const use = (n: number) => ({ role: 'assistant', content: [{ type: 'thinking' }, ...Array.from({ length: n }, () => ({ type: 'tool_use' }))] });
const results = { role: 'user', content: [{ type: 'tool_result' }] };
/** Rounds with 3, 1 and 2 calls, then the results of the last. */
const MESSAGES = [{ role: 'user', content: 'go' }, use(3), results, use(1), results, use(2), results];

describe('server-side tool-result clearing', () => {
    test('SC-1: conversions', () => {
        assert.equal(CHARS_PER_TOKEN, 4);
        assert.equal(charsToTokens(300_000), 75_000);
        assert.equal(charsToTokens(5), 2);
        assert.equal(promptTokensOf({ input_tokens: 10, cache_read_input_tokens: 40_000, cache_creation_input_tokens: 2_000 }), 42_010);
        assert.equal(promptTokensOf(undefined), 0);
    });

    test('SC-2: the four settings mapped', () => {
        assert.equal(toolUsesOfNewestRounds(MESSAGES, 2), 3, 'the newest two rounds: 2 + 1');
        assert.equal(toolUsesOfNewestRounds(MESSAGES, 0), 0);
        assert.equal(toolUsesOfNewestRounds(MESSAGES, 10), 6);
        const edit = clearToolUsesEdit({ ...RETENTION_DEFAULTS }, 42_000, MESSAGES);
        assert.deepEqual(edit, {
            type: CLEAR_TOOL_USES_EDIT,
            trigger: { type: 'input_tokens', value: 42_000 + 75_000 },
            keep: { type: 'tool_uses', value: 3 },
            clear_at_least: { type: 'input_tokens', value: (300_000 - 2 * 30_000) / 4 },
            exclude_tools: ['tomAi_readPastToolResult'],
        });
        // A configuration's own values (and the compaction section's) win over the defaults.
        const caps = resolveRetentionCaps({ toolTrailCollapseChars: 100_000, toolTrailKeepRounds: 1 }, { toolTrailMaxResultChars: 10_000 });
        const own = clearToolUsesEdit(caps, 1_000, MESSAGES);
        assert.deepEqual([own.trigger?.value, own.keep?.value, own.clear_at_least?.value], [1_000 + 25_000, 2, (100_000 - 10_000) / 4]);
        const tight = clearToolUsesEdit({ ...RETENTION_DEFAULTS, toolTrailCollapseChars: 10_000 }, 1_000, MESSAGES);
        assert.equal(tight.clear_at_least?.value, 1, 'never zero or negative');
    });

    test('SC-3: when, and the request shape', () => {
        assert.equal(serverToolClearing(MESSAGES, { ...RETENTION_DEFAULTS }, 42_000, false), undefined, 'no thinking: the client-side collapse');
        assert.equal(serverToolClearing(MESSAGES, { ...RETENTION_DEFAULTS }, undefined, true), undefined, 'round one: nothing to clear yet');
        const fields = serverToolClearing(MESSAGES, { ...RETENTION_DEFAULTS }, 42_000, true);
        assert.deepEqual(fields?.betas, [CONTEXT_MANAGEMENT_BETA]);
        assert.equal(CONTEXT_MANAGEMENT_BETA, 'context-management-2025-06-27');
        assert.equal(fields?.context_management.edits[0].type, 'clear_tool_uses_20250919');
        // The SDK's own request type takes it as it is.
        const typed: Pick<Anthropic.Beta.Messages.MessageCreateParamsNonStreaming, 'betas' | 'context_management'> = fields!;
        assert.ok(typed);
    });

    test('SC-4: the beta path of the streamed call', async () => {
        const seen: Array<[string, Record<string, unknown>]> = [];
        const message = { id: 'm', content: [], stop_reason: 'end_turn', context_management: { applied_edits: [] } };
        const client: MessageStreamingClient = {
            messages: { stream: (p) => { seen.push(['messages', p as unknown as Record<string, unknown>]); return { finalMessage: async () => message as never }; } },
            beta: { messages: { stream: (p) => { seen.push(['beta', p as unknown as Record<string, unknown>]); return { finalMessage: async () => message as never }; } } },
        };
        const base = { model: 'claude-opus-5-5', max_tokens: 1000, messages: [{ role: 'user' as const, content: 'hi' }] };
        const fields = serverToolClearing(MESSAGES, { ...RETENTION_DEFAULTS }, 42_000, true)!;
        const r = await createMessageStreamed(client, { ...base, ...fields });
        assert.deepEqual(r.context_management, { applied_edits: [] });
        assert.equal(seen[0][0], 'beta');
        assert.deepEqual(seen[0][1].betas, [CONTEXT_MANAGEMENT_BETA]);
        assert.deepEqual(seen[0][1].context_management, fields.context_management);
        await createMessageStreamed(client, { ...base, betas: [] });
        assert.equal(seen[1][0], 'messages');
        assert.equal('betas' in seen[1][1] || 'context_management' in seen[1][1], false, 'a plain request carries no beta fields');
        const plain: MessageStreamingClient = { messages: client.messages };
        await assert.rejects(createMessageStreamed(plain, { ...base, ...fields }), /no beta surface/);
    });

    test('SC-5: the notice', () => {
        assert.equal(
            appliedClearingNotice({ applied_edits: [{ type: CLEAR_TOOL_USES_EDIT, cleared_tool_uses: 7, cleared_input_tokens: 61234 }] }),
            'The API cleared 7 tool uses (61,234 tokens) of old tool results before this round (server-side context editing).',
        );
        assert.equal(appliedClearingNotice({ applied_edits: [{ type: CLEAR_TOOL_USES_EDIT, cleared_tool_uses: 0, cleared_input_tokens: 0 }] }), undefined);
        assert.equal(appliedClearingNotice(undefined), undefined);
        assert.equal(appliedClearingNotice(null), undefined);
    });

    test('SC-6: the direct loop', () => {
        const src = readFileSync(join(__dirname, '..', '..', '..', 'src', 'handlers', 'anthropic-handler.ts'), 'utf8');
        const loop = src.slice(src.indexOf('const sendUsage = new DirectSendUsage('), src.indexOf('private async sendViaVsCodeLm'));
        assert.match(loop, /serverToolClearing\(\s*messages,\s*this\.resolveEffectiveCaps\(configuration\),\s*firstPromptTokens,\s*conversationHasThinking\(messages as unknown as RetentionMessage\[\]\),\s*\)/);
        assert.match(loop, /\.\.\.\(serverClearing \?\? \{\}\),/);
        assert.match(loop, /if \(firstPromptTokens === undefined\) \{ firstPromptTokens = promptTokensOf\(response\.usage\); \}/);
        assert.match(loop, /appliedClearingNotice\(response\.context_management\)/);
        // The client-side collapse still freezes a conversation with thinking (toolTrailRetention.ts).
        assert.match(readFileSync(join(__dirname, '..', '..', '..', 'src', 'services', 'toolTrailRetention.ts'), 'utf8'), /if \(freezeEarlierRounds\) \{ return; \}/);
    });
});
