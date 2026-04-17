/**
 * AI Conversation — result-file tools.
 *
 * Two LLMs talking in the AI Conversation panel need a way to **produce an
 * outcome document** that survives the conversation. Both participants share
 * one markdown file per conversation; either can read its current contents or
 * write/append to it.
 *
 * Default location: `_ai/ai_conversation/{conversationId}.result.md` where
 * `conversationId` is passed explicitly or defaults to `"current"`. The file
 * is created on first write.
 *
 * These tools are **the only write capability** exposed to AI Conversation
 * today — every other mutating tool is off by default. Rationale: AI
 * Conversation is experimental (bot-to-bot) and we don't want either
 * participant editing the workspace until the mode is proven reliable.
 */

import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import { SharedToolDefinition } from './shared-tool-registry';
import { WsPaths } from '../utils/workspacePaths';

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

function resolveResultFile(conversationId: string): string | undefined {
    const wsRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
    if (!wsRoot) { return undefined; }
    const safeId = (conversationId || 'current').replace(/[^a-zA-Z0-9._-]/g, '_');
    const dir = path.join(wsRoot, WsPaths.aiFolder, 'ai_conversation');
    return path.join(dir, `${safeId}.result.md`);
}

function ensureDir(filePath: string): void {
    const dir = path.dirname(filePath);
    if (!fs.existsSync(dir)) { fs.mkdirSync(dir, { recursive: true }); }
}

// ---------------------------------------------------------------------------
// tomAi_readConversationResult
// ---------------------------------------------------------------------------

interface ReadConversationResultInput {
    conversationId?: string;
}

async function executeReadConversationResult(input: ReadConversationResultInput): Promise<string> {
    const filePath = resolveResultFile(input.conversationId ?? 'current');
    if (!filePath) {
        return JSON.stringify({ error: 'No workspace open.' });
    }
    if (!fs.existsSync(filePath)) {
        return JSON.stringify({
            conversationId: input.conversationId ?? 'current',
            exists: false,
            content: '',
            note: 'Result file does not exist yet. Call tomAi_writeConversationResult to create it.',
        });
    }
    try {
        const content = fs.readFileSync(filePath, 'utf8');
        const stat = fs.statSync(filePath);
        return JSON.stringify({
            conversationId: input.conversationId ?? 'current',
            exists: true,
            size: stat.size,
            modified: stat.mtime.toISOString(),
            content,
        }, null, 2);
    } catch (err: any) {
        return JSON.stringify({ error: `Read failed: ${err?.message ?? err}` });
    }
}

export const READ_CONVERSATION_RESULT_TOOL: SharedToolDefinition<ReadConversationResultInput> = {
    name: 'tomAi_readConversationResult',
    displayName: 'Read Conversation Result',
    description:
        'Read the current content of the AI Conversation result document. Returns `exists=false` with empty content if no result has been written yet. ' +
        'Use to see what the other participant has contributed or to pick up where you left off.',
    tags: ['aiConversation', 'result', 'tom-ai-chat'],
    readOnly: true,
    inputSchema: {
        type: 'object',
        properties: {
            conversationId: {
                type: 'string',
                description: 'Conversation identifier. Defaults to "current" (the active conversation).',
            },
        },
    },
    execute: executeReadConversationResult,
};

// ---------------------------------------------------------------------------
// tomAi_writeConversationResult
// ---------------------------------------------------------------------------

interface WriteConversationResultInput {
    content: string;
    mode?: 'replace' | 'append';
    conversationId?: string;
}

async function executeWriteConversationResult(input: WriteConversationResultInput): Promise<string> {
    if (typeof input.content !== 'string') {
        return JSON.stringify({ error: 'content is required and must be a string.' });
    }
    const filePath = resolveResultFile(input.conversationId ?? 'current');
    if (!filePath) { return JSON.stringify({ error: 'No workspace open.' }); }
    const mode = input.mode === 'append' ? 'append' : 'replace';
    try {
        ensureDir(filePath);
        if (mode === 'append' && fs.existsSync(filePath)) {
            const existing = fs.readFileSync(filePath, 'utf8');
            const separator = existing.endsWith('\n') ? '' : '\n';
            fs.writeFileSync(filePath, existing + separator + input.content, 'utf8');
        } else {
            fs.writeFileSync(filePath, input.content, 'utf8');
        }
        const stat = fs.statSync(filePath);
        return JSON.stringify({
            success: true,
            conversationId: input.conversationId ?? 'current',
            mode,
            size: stat.size,
            path: path.relative(
                vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? '',
                filePath,
            ),
        });
    } catch (err: any) {
        return JSON.stringify({ error: `Write failed: ${err?.message ?? err}` });
    }
}

export const WRITE_CONVERSATION_RESULT_TOOL: SharedToolDefinition<WriteConversationResultInput> = {
    name: 'tomAi_writeConversationResult',
    displayName: 'Write Conversation Result',
    description:
        'Write or append to the AI Conversation result document. Use `mode: "replace"` (default) to overwrite; `mode: "append"` to add to existing content. ' +
        'This is the only mutation tool available to AI Conversation participants.',
    tags: ['aiConversation', 'result', 'tom-ai-chat'],
    readOnly: false,
    requiresApproval: false,
    inputSchema: {
        type: 'object',
        required: ['content'],
        properties: {
            content: { type: 'string', description: 'Markdown content to write.' },
            mode: {
                type: 'string',
                enum: ['replace', 'append'],
                description: 'replace (default) or append.',
            },
            conversationId: {
                type: 'string',
                description: 'Conversation identifier. Defaults to "current".',
            },
        },
    },
    execute: executeWriteConversationResult,
};

// ---------------------------------------------------------------------------
// Master list
// ---------------------------------------------------------------------------

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export const CONVERSATION_RESULT_TOOLS: SharedToolDefinition<any>[] = [
    READ_CONVERSATION_RESULT_TOOL,
    WRITE_CONVERSATION_RESULT_TOOL,
];
