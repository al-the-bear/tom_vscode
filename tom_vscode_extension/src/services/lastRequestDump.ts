/**
 * Last-Request Dump — one overwriteable JSON file per (subsystem, quest)
 * holding the literal request payload from the most recent LLM call.
 *
 * Why this exists: the per-call raw trail files under
 * `_ai/trail/<subsystem>/<quest>/` capture pieces (prompt, payload,
 * tool_request, tool_answer) per round and accumulate over time. For
 * "what was actually just sent" inspection, the user wants a single
 * always-current file they can re-open and re-load without hunting
 * for the newest timestamp.
 *
 * Layout:
 *
 *   _ai/trail/<subsystem>/<quest>/last_request.json
 *
 * Subsystem buckets match the trail subsystem strings (`localllm`,
 * `anthropic`, …). Each handler calls `writeLastRequest()` right before
 * dispatching the HTTP / SDK call, passing the literal body that goes
 * on the wire plus a small envelope.
 */

import * as path from 'path';
import { WsPaths } from '../utils/workspacePaths';
import { resolveTrailPath } from './trailPathResolver';
import { FsUtils } from '../utils/fsUtils';
import { TomAiConfiguration } from '../utils/tomAiConfiguration';

export type LastRequestSubsystem =
    | 'localllm'
    | 'anthropic'
    | 'anthropic-vscodelm'
    | 'anthropic-agentsdk';

export interface LastRequestEnvelope {
    /** ISO timestamp of when the request was about to be dispatched. */
    timestamp: string;
    /** Logical subsystem — picks the trail bucket. */
    subsystem: LastRequestSubsystem;
    /** Wire endpoint (e.g. `POST http://localhost:8000/v1/chat/completions`)
     *  or SDK call identifier (e.g. `client.messages.create`). */
    endpoint: string;
    /** Configuration id from `tom_vscode_extension.json` driving this call. */
    configId?: string;
    /** Model name as known by the backend. */
    model?: string;
    /** Optional profile id (Anthropic profiles, Local LLM profiles). */
    profile?: string;
    /** Convenience counters so the file header reveals problems at a glance. */
    stats?: {
        messageCount?: number;
        totalCharCount?: number;
        toolCount?: number;
        systemPromptChars?: number;
    };
    /** The literal request payload — exactly what is about to be sent on
     *  the wire or to the SDK call. Field shape is provider-specific
     *  (Anthropic messages-create options vs OpenAI chat/completions vs
     *  Ollama /api/chat). */
    body: unknown;
}

function getRawBase(subsystem: LastRequestSubsystem): string {
    const trail = TomAiConfiguration.instance.getTrail() as Record<string, unknown>;
    const raw = ((trail.raw ?? trail) as Record<string, unknown>);
    const paths = ((raw.paths ?? {}) as Record<string, string>);
    if (subsystem === 'localllm') {
        return paths.localLlm ?? '${ai}/trail/localllm/${quest}';
    }
    // All anthropic variants share the anthropic trail bucket but get
    // different file basenames so they don't clobber each other.
    return paths.anthropic ?? '${ai}/trail/anthropic/${quest}';
}

function resolveDir(subsystem: LastRequestSubsystem, questId?: string): string {
    const base = getRawBase(subsystem);
    const quest = questId || WsPaths.getWorkspaceQuestId();
    return resolveTrailPath(base, { subsystem, quest });
}

function fileNameFor(subsystem: LastRequestSubsystem): string {
    switch (subsystem) {
        case 'anthropic-vscodelm': return 'last_request_vscodelm.json';
        case 'anthropic-agentsdk': return 'last_request_agentsdk.json';
        case 'anthropic':           return 'last_request.json';
        case 'localllm':            return 'last_request.json';
    }
}

export function writeLastRequest(envelope: LastRequestEnvelope, questId?: string): void {
    try {
        const dir = resolveDir(envelope.subsystem, questId);
        FsUtils.ensureDir(dir);
        const filePath = path.join(dir, fileNameFor(envelope.subsystem));
        FsUtils.safeWriteJson(filePath, envelope);
    } catch {
        // Best-effort — diagnostics must never break the chat path.
    }
}

/**
 * Convenience helper for the common case: compute stats from a
 * `messages[]` array (works for both OpenAI-shape and Anthropic-shape
 * arrays because we only need the total character count).
 */
export function quickStats(args: {
    messages?: Array<{ role?: string; content?: unknown }>;
    tools?: unknown[];
    systemPrompt?: string;
}): NonNullable<LastRequestEnvelope['stats']> {
    const messages = args.messages ?? [];
    let totalChars = 0;
    for (const m of messages) {
        const c = m.content;
        if (typeof c === 'string') {
            totalChars += c.length;
        } else if (Array.isArray(c)) {
            for (const part of c) {
                if (typeof part === 'string') {
                    totalChars += part.length;
                } else if (part && typeof (part as { text?: unknown }).text === 'string') {
                    totalChars += (part as { text: string }).text.length;
                } else if (part && typeof (part as { content?: unknown }).content === 'string') {
                    totalChars += (part as { content: string }).content.length;
                }
            }
        }
    }
    if (args.systemPrompt) { totalChars += args.systemPrompt.length; }
    return {
        messageCount: messages.length,
        totalCharCount: totalChars,
        toolCount: args.tools?.length ?? 0,
        systemPromptChars: args.systemPrompt?.length,
    };
}
