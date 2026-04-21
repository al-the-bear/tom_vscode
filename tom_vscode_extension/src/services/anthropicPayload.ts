/**
 * Pure Anthropic payload / parameter helpers.
 *
 * Wave 3.2 continuation — `anthropic-handler.ts` is 2,276 lines; the
 * parts that are *truly* pure (no handler state, no side effects)
 * can live in a service module so the handler stays focused on the
 * stateful turn-loop + background-work orchestration that actually
 * belongs to it.
 *
 * The three exports below meet that bar:
 *   • `buildPayloadDump` — render a markdown dump of the outgoing
 *      request for the raw trail. 100+ lines of pure string
 *      assembly.
 *   • `temperatureField`  — map `undefined | 1 | number` to the
 *      object the SDK expects.
 *   • `isConversationMessage` — type guard used by deserialisation.
 *
 * Keeping them in-module would force anyone reading the handler to
 * scroll past formatter code before getting to the loop; moving them
 * here lets `anthropic-handler.ts` be a smaller file about what
 * actually orchestrates a turn.
 */

import type {
    AnthropicConfiguration,
    AnthropicProfile,
    AnthropicTransport,
} from '../handlers/anthropic-handler';
import type { ConversationMessage } from './history-compaction';
import type { SharedToolDefinition } from '../tools/shared-tool-registry';

/** Inputs to {@link buildPayloadDump}. Extracted verbatim from the
 *  handler so call sites don't change shape. */
export interface PayloadDumpInputs {
    requestId: string;
    transport: AnthropicTransport;
    configuration: AnthropicConfiguration;
    profile: AnthropicProfile;
    systemPrompt: string;
    tools: SharedToolDefinition[];
    history: ConversationMessage[];
    userContent: string;
    effectiveCaching: boolean;
    thinkingBudgetTokens?: number;
    useBuiltInTools?: boolean;
    compactedSummary?: string;
}

/**
 * Render a markdown dump of the outgoing Anthropic request. Written
 * alongside the `.userprompt.md` raw trail file so a reader can see
 * the full wire payload (system prompt + tools + compacted summary +
 * raw history + current user message) without decoding JSON by hand.
 *
 * Pure — takes params, returns a string, no handler state.
 */
export function buildPayloadDump(params: PayloadDumpInputs): string {
    const { requestId, transport, configuration, profile, systemPrompt, tools, history, userContent, compactedSummary } = params;
    const lines: string[] = [];

    lines.push('# Anthropic API payload');
    lines.push('');
    lines.push(`- requestId: \`${requestId}\``);
    lines.push(`- transport: \`${transport}\``);
    lines.push(`- profile: \`${profile.id}\` (${profile.name})`);
    lines.push(`- configuration: \`${configuration.id}\` → model \`${configuration.model}\``);
    lines.push(`- maxTokens: ${configuration.maxTokens}, maxRounds: ${configuration.maxRounds}`);
    if (typeof configuration.temperature === 'number') {
        lines.push(`- temperature: ${configuration.temperature}`);
    }
    lines.push(`- promptCachingEnabled (effective): ${params.effectiveCaching}`);
    if (params.thinkingBudgetTokens !== undefined) {
        lines.push(`- thinking.budget_tokens: ${params.thinkingBudgetTokens}`);
    }
    if (transport === 'agentSdk') {
        lines.push(`- useBuiltInTools: ${params.useBuiltInTools === true}`);
        lines.push(`- agentSdk.permissionMode: ${configuration.agentSdk?.permissionMode ?? 'default'}`);
        lines.push(`- agentSdk.settingSources: ${(configuration.agentSdk?.settingSources ?? []).join(', ') || '(isolation mode)'}`);
    } else if (transport === 'vscodeLm') {
        lines.push(`- vscodeLm.vendor: \`${configuration.vscodeLm?.vendor ?? '(unset)'}\``);
        lines.push(`- vscodeLm.family: \`${configuration.vscodeLm?.family ?? '(unset)'}\``);
        lines.push(`- vscodeLm.modelId: \`${configuration.vscodeLm?.modelId ?? '(unset)'}\``);
    } else if (transport === 'localLlm') {
        lines.push(`- localLlm.baseUrl: \`${configuration.localLlm?.baseUrl ?? '(unset)'}\``);
        lines.push(`- localLlm.model: \`${configuration.localLlm?.model ?? '(unset)'}\``);
        if (configuration.localLlm?.keepAlive) {
            lines.push(`- localLlm.keepAlive: \`${configuration.localLlm.keepAlive}\``);
        }
    }
    lines.push(`- toolApprovalMode: ${profile.toolApprovalMode ?? 'always'}`);
    lines.push('');

    lines.push(`## System prompt (${systemPrompt.length} chars)`);
    lines.push('');
    lines.push('```text');
    lines.push(systemPrompt);
    lines.push('```');
    lines.push('');

    lines.push(`## Tools (${tools.length})`);
    lines.push('');
    if (tools.length === 0) {
        lines.push('_(none)_');
    } else {
        for (const t of tools) {
            lines.push(`- \`${t.name}\``);
        }
    }
    lines.push('');

    lines.push(`## Raw turns (${history.length} messages — sent verbatim)`);
    lines.push('');
    if (history.length === 0) {
        lines.push('_(empty — first turn of the session or just after a clear)_');
    } else {
        for (let i = 0; i < history.length; i++) {
            const m = history[i];
            const content = typeof m.content === 'string' ? m.content : String(m.content ?? '');
            const head = content.slice(0, 200).replace(/\s+/g, ' ').trim();
            const tail = content.length > 200 ? ' …' : '';
            lines.push(`- **[${i}] ${m.role}** — ${content.length} chars`);
            lines.push(`  > ${head}${tail}`);
        }
    }
    lines.push('');

    // The compacted summary is injected into the wire payload *after* the
    // raw turns and *before* the current user message. Show the actual
    // content here (it tends to be a few KB — small enough not to
    // dominate the file, and this is the only place the reconstructed
    // summary is visible).
    lines.push(`## Compacted summary (${(compactedSummary ?? '').length} chars — injected after raw turns)`);
    lines.push('');
    if (!compactedSummary) {
        lines.push('_(empty — no turns have been compacted yet, or session was just cleared)_');
    } else {
        lines.push('```text');
        lines.push(compactedSummary);
        lines.push('```');
    }
    lines.push('');

    lines.push(`## Current user message (${userContent.length} chars)`);
    lines.push('');
    lines.push('```text');
    lines.push(userContent);
    lines.push('```');
    lines.push('');

    return lines.join('\n');
}

/**
 * Decide whether to send a `temperature` parameter to the API. Omit it
 * when it is undefined OR equal to the server default (1.0). Some newer
 * models (e.g. claude-opus-4-7) return 400 "Temperature is deprecated
 * for this model" if it is sent at all — and the server default already
 * matches what callers get when omitting, so this is safe across every
 * model. Any explicit non-1 value (e.g. 0.3, 0.5) is forwarded unchanged.
 */
export function temperatureField(temperature: number | undefined): { temperature?: number } {
    if (typeof temperature !== 'number' || temperature === 1) { return {}; }
    return { temperature };
}

/**
 * Type guard for a persisted `ConversationMessage`. Used by the
 * session-history deserialiser to reject malformed entries without
 * throwing during JSON parse.
 */
export function isConversationMessage(m: unknown): m is ConversationMessage {
    return !!m && typeof m === 'object' &&
        ((m as ConversationMessage).role === 'user' ||
         (m as ConversationMessage).role === 'assistant' ||
         (m as ConversationMessage).role === 'system') &&
        typeof (m as ConversationMessage).content === 'string';
}
